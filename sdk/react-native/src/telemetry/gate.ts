import type { Context, Span } from "@opentelemetry/api";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { MAX_STRING_BYTES, truncateAttributes } from "../attributes";
import { isDropEvent, type DropCounter } from "../drops";
import { guard } from "../guard";
import type { DebugLogger } from "../logger";
import { sanitizeUrlsInText, type UrlSanitizer } from "../privacy";
import { cutUtf8 } from "../text";
import type { AttrValue, BeforeSend, BeforeSendRecord } from "../types";

/**
 * The gate every record passes before it is kept anywhere (the last-events buffer, the persisted
 * error context, the batch queue, the offline store) and exported (spec CFG-4, PRV-14, REC-8):
 *
 * 0. URLs inside `exception.stacktrace` and `exception.message` are sanitised (PRV-10).
 * 1. `beforeSend` sees a copy of the record and may change it or drop it (null or false). A hook
 *    that throws means the unmodified record goes on. A record the hook itself emits (it logs
 *    what it dropped) skips the hook, so the hook cannot re-enter. Replay chunks never pass here: they are
 *    not log records, the native recorder sends them.
 * 2. Attribute values are truncated at source.
 *
 * Then the record goes to the processors behind the gate. The SDK's own drop reports skip the
 * hook, so a hook that drops everything cannot hide (or multiply) them.
 */

type Decision = BeforeSendRecord | "drop" | undefined;

/** True while the app's hook runs: what it records itself (an event, a log line) does not go through the hook again (ERR-5). */
let inHook = false;

function decide(hook: BeforeSend | undefined, snapshot: () => BeforeSendRecord, drops: DropCounter, signal: "log" | "span"): Decision {
  if (!hook || inHook) return undefined;
  let copy: BeforeSendRecord | undefined;
  inHook = true;
  const out = guard.host("beforeSend", () => {
    copy = snapshot();
    const result = hook(copy);
    return result === null || result === false ? ("drop" as const) : result && typeof result === "object" ? result : copy;
  });
  inHook = false;
  if (out === "drop") drops.count(signal, "before_send");
  return out;
}

const isAttrValue = (v: unknown): v is AttrValue => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

/** Makes `target` equal to the hook's attributes: its keys set, the others removed. */
function applyAttributes(target: Record<string, unknown>, next: unknown): void {
  if (!next || typeof next !== "object") return;
  const wanted = next as Record<string, unknown>;
  for (const key of Object.keys(target)) if (!(key in wanted)) delete target[key];
  for (const key of Object.keys(wanted)) if (isAttrValue(wanted[key])) target[key] = wanted[key];
}

/** URLs inside an exception's text (PRV-10). Request URLs are sanitised where they are captured. */
function sanitizeUrls(attributes: Record<string, unknown>, sanitize: UrlSanitizer | undefined): void {
  if (!sanitize) return;
  for (const key of ["exception.stacktrace", "exception.message"]) {
    const text = attributes[key];
    if (typeof text === "string") attributes[key] = sanitizeUrlsInText(text, sanitize);
  }
}

function finish(attributes: Record<string, unknown>, logger: DebugLogger): void {
  const removed = truncateAttributes(attributes);
  if (removed.length > 0) logger.warn("record over the attribute limit, attributes removed:", removed.join(", "));
}

export class LogGate implements LogRecordProcessor {
  constructor(
    /** Runs first (the session attributes): the hook sees the record as it would be sent. */
    private readonly first: LogRecordProcessor,
    private readonly hook: BeforeSend | undefined,
    private readonly drops: DropCounter,
    private readonly logger: DebugLogger,
    private readonly next: LogRecordProcessor[],
    private readonly sanitize?: UrlSanitizer,
  ) {}

  onEmit(record: SdkLogRecord, context?: Context): void {
    this.first.onEmit(record, context);
    const attributes = record.attributes as Record<string, unknown>;
    const name = String(attributes["event.name"] ?? record.eventName ?? "log");
    // SES-10: no valid session and not a bypass-set record.
    if (attributes["session.id"] === undefined) {
      if (!isDropEvent(name)) this.drops.count("log", "no_session");
      return;
    }
    sanitizeUrls(attributes, this.sanitize);
    if (!isDropEvent(name)) {
      const out = decide(this.hook, () => ({ type: "log", name, ...(typeof record.body === "string" ? { body: record.body } : {}), attributes: { ...attributes } as Record<string, AttrValue> }), this.drops, "log");
      if (out === "drop") return;
      if (out) {
        applyAttributes(attributes, out.attributes);
        if (typeof out.body === "string" && out.body !== record.body) record.setBody(out.body);
      }
    }
    if (typeof record.body === "string" && record.body.length * 3 > MAX_STRING_BYTES) record.setBody(cutUtf8(record.body, MAX_STRING_BYTES));
    finish(attributes, this.logger);
    for (const p of this.next) p.onEmit(record, context);
  }

  forceFlush(): Promise<void> {
    return Promise.all(this.next.map((p) => p.forceFlush())).then(() => undefined);
  }

  shutdown(): Promise<void> {
    return Promise.all(this.next.map((p) => p.shutdown())).then(() => undefined);
  }
}

export class SpanGate implements SpanProcessor {
  constructor(
    private readonly hook: BeforeSend | undefined,
    private readonly drops: DropCounter,
    private readonly logger: DebugLogger,
    private readonly next: SpanProcessor,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    this.next.onStart(span as never, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    // An ended span is read-only through its API; its attribute map is still the one exported.
    const attributes = span.attributes as Record<string, unknown>;
    // SES-10: the span started while no session was valid.
    if (attributes["session.id"] === undefined) {
      this.drops.count("span", "no_session");
      return;
    }
    const out = decide(this.hook, () => ({ type: "span", name: span.name, attributes: { ...attributes } as Record<string, AttrValue> }), this.drops, "span");
    if (out === "drop") return;
    if (out) {
      applyAttributes(attributes, out.attributes);
      if (typeof out.name === "string" && out.name && out.name !== span.name) (span as { name: string }).name = out.name;
    }
    finish(attributes, this.logger);
    this.next.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

/**
 * A processor whose every method runs inside the guard (ERR-1): a throw is counted and the
 * record is lost, the app is not. Once the SDK disabled itself records stop here and are counted.
 */
export function guarded<P extends LogRecordProcessor | SpanProcessor>(seam: string, inner: P, onDisabled: () => void, allowed: () => boolean = () => true): P {
  const p = inner as Partial<LogRecordProcessor & SpanProcessor>;
  const record = (method: "onEmit" | "onEnd") =>
    function (a: unknown, b: unknown): void {
      if (guard.disabled) {
        onDisabled();
        return;
      }
      // Telemetry consent denied (spec PRV-4): nothing is recorded, and it is not a drop.
      if (!allowed()) return;
      guard.run(`${seam}.${method}`, () => (p[method] as (a: unknown, b: unknown) => void).call(p, a, b));
    };
  const out = {
    forceFlush: () => guard.run(`${seam}.forceFlush`, () => inner.forceFlush(), Promise.resolve()),
    shutdown: () => guard.run(`${seam}.shutdown`, () => inner.shutdown(), Promise.resolve()),
    ...(p.onEmit ? { onEmit: record("onEmit") } : {}),
    ...(p.onEnd ? { onEnd: record("onEnd") } : {}),
    ...(p.onStart ? { onStart: (span: unknown, ctx: unknown) => guard.run(`${seam}.onStart`, () => (p.onStart as (a: unknown, b: unknown) => void).call(p, span, ctx)) } : {}),
  };
  return out as unknown as P;
}
