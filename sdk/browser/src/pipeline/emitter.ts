/**
 * Where every RUM event is made (SDK spec section 6.1). An event is a log record with an
 * `EventName`, emitted through the OpenTelemetry Logs API on scope `ouo.rum` (REL-7, REC-1,
 * REC-5). Before it reaches the logger it is:
 *
 * 1. stamped with the session, view, document URL and user of the moment it was created (SES-2,
 *    REC-2, REC-3), and with the app's global attributes;
 * 2. dropped when there is no valid session or the session is not sampled, unless it is in the
 *    bypass set, which goes out marked and capped (SES-10, SMP-3, SMP-5 to SMP-7);
 * 3. rate limited per event name, so a loop cannot flood the collector;
 * 4. truncated (REC-8) and shown to `beforeSend` (CFG-4);
 * 5. held while a session start is being confirmed, so `session.start` goes first (SES-4).
 */
import { context as otelContext, type Context } from "@opentelemetry/api";
import { SeverityNumber, type AnyValue, type Logger } from "@opentelemetry/api-logs";
import type { Clock } from "../core/clock";
import type { DropCounter } from "../core/drops";
import { truncateAttributes, type Attrs } from "../core/limits";
import { attempt, point } from "../guard";
import type { Stamp } from "../session/manager";
import type { BeforeSend } from "../types";

export type Severity = "INFO" | "WARN" | "ERROR" | "FATAL";

const SEVERITY: Record<Severity, SeverityNumber> = {
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
  FATAL: SeverityNumber.FATAL,
};

export interface EmitOptions {
  severity?: Severity;
  /** When it happened, epoch ms. Default now. */
  time?: number;
  body?: unknown;
  /** In the bypass set: sent, marked, from a session that is not sampled or has expired. */
  bypass?: boolean;
  /** The view the record belongs to, when not the current one (web vitals, SIG-32). */
  viewId?: string | undefined;
  /** The session the record belongs to, when not the current one (`session.start`, `session.end`). */
  stamp?: Stamp;
  /** Skip the hold: session events go ahead of the records waiting for them. */
  first?: boolean;
  /** An SDK diagnostic (`ouo.sdk.dropped`): never rate limited, never counted as a drop. */
  internal?: boolean;
}

export interface EmitterDeps {
  logger: Logger;
  clock: Clock;
  drops: DropCounter;
  stamp(): Stamp;
  viewId(): string | undefined;
  /** The sanitised URL of the document. */
  documentUrl(): string;
  globalAttributes(): Attrs;
  beforeSend: BeforeSend | undefined;
  bypassCap: number;
  /** False once the SDK is off, shut down, or telemetry consent is denied. */
  active(): boolean;
}

interface Pending {
  name: string;
  attrs: Record<string, unknown>;
  severity: Severity;
  time: number;
  observed: number;
  body: unknown;
  ctx: Context;
}

export type Listener = (name: string, attrs: Readonly<Record<string, unknown>>, bypass: boolean) => void;

/** Events per name per window before the rest are dropped and counted. */
const RATE_WINDOW_MS = 10_000;
const RATE_LIMITS: Record<string, number> = { exception: 30 };
const RATE_DEFAULT = 300;
const HELD_MAX = 512;

export class Emitter {
  private holds = 0;
  private held: Pending[] = [];
  private readonly rates = new Map<string, { since: number; count: number }>();
  private bypassFor = "";
  private bypassCount = 0;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly d: EmitterDeps) {}

  /** Sees every event that is about to be sent (replay triggers, error clicks). */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(name: string, attributes: Attrs = {}, o: EmitOptions = {}): void {
    if (!this.d.active()) return;
    point("emit");
    const now = this.d.clock.now();
    const stamp = o.stamp ?? this.d.stamp();
    const attrs: Record<string, unknown> = { ...this.d.globalAttributes(), ...attributes };

    let bypassed = false;
    if (stamp.expired || !stamp.sampled) {
      if (!o.bypass) {
        // An unsampled session sends nothing by design; a missing session is a drop (SES-10).
        if (stamp.expired && !o.internal) this.d.drops.add(name, "no_session");
        return;
      }
      if (stamp.id !== this.bypassFor) {
        this.bypassFor = stamp.id;
        this.bypassCount = 0;
      }
      if (this.bypassCount >= this.d.bypassCap) {
        this.d.drops.add(name, "bypass_cap");
        return;
      }
      this.bypassCount++;
      bypassed = true;
      if (stamp.expired) attrs["ouo.session.expired"] = true;
      else attrs["ouo.sampling.bypass"] = true;
    }

    if (!o.internal && !o.first && this.limited(name, now)) {
      this.d.drops.add(name, "rate_limited");
      return;
    }

    attrs["session.id"] = stamp.id;
    const view = o.viewId ?? this.d.viewId();
    if (view) attrs["ouo.view.id"] = view;
    attrs["browser.document.url.full"] = this.d.documentUrl();
    if (stamp.user !== undefined) attrs["enduser.id"] = stamp.user;
    truncateAttributes(attrs);

    let body = o.body;
    if (this.d.beforeSend && !o.internal) {
      const out = applyBeforeSend(this.d.beforeSend, { type: "event", name, attributes: attrs, body });
      if (!out) {
        this.d.drops.add(name, "before_send");
        return;
      }
      body = out.body;
      // The hook may remove what it likes, but the join key stays.
      const next = { ...out.attributes, "session.id": stamp.id };
      truncateAttributes(next);
      for (const k of Object.keys(attrs)) delete attrs[k];
      Object.assign(attrs, next);
    }

    const pending: Pending = { name, attrs, severity: o.severity ?? "INFO", time: o.time ?? now, observed: now, body, ctx: otelContext.active() };
    for (const fn of this.listeners) attempt(() => fn(name, attrs, bypassed || o.bypass === true));
    if (this.holds > 0 && !o.first) {
      if (this.held.length >= HELD_MAX) {
        this.d.drops.add(name, "queue_full");
        return;
      }
      this.held.push(pending);
      return;
    }
    this.deliver(pending);
  }

  /** Records created from now on wait until `release` (a session start is being confirmed). */
  hold(): void {
    this.holds++;
  }

  release(): void {
    if (this.holds > 0) this.holds--;
    if (this.holds > 0) return;
    const held = this.held;
    this.held = [];
    for (const p of held) this.deliver(p);
  }

  /** The held records stamped with session `from` belong to `to` (this tab lost a start race). */
  restamp(from: string, to: string): void {
    for (const p of this.held) if (p.attrs["session.id"] === from) p.attrs["session.id"] = to;
  }

  private limited(name: string, now: number): boolean {
    let r = this.rates.get(name);
    if (!r || now - r.since >= RATE_WINDOW_MS) {
      if (!r && this.rates.size >= 128) this.rates.delete(this.rates.keys().next().value!);
      r = { since: now, count: 0 };
      this.rates.set(name, r);
    }
    r.count++;
    return r.count > (RATE_LIMITS[name] ?? RATE_DEFAULT);
  }

  private deliver(p: Pending): void {
    attempt(() =>
      this.d.logger.emit({
        eventName: p.name,
        timestamp: p.time,
        observedTimestamp: p.observed,
        severityNumber: SEVERITY[p.severity],
        severityText: p.severity,
        attributes: p.attrs as Record<string, AnyValue>,
        ...(p.body !== undefined ? { body: p.body as AnyValue } : {}),
        context: p.ctx,
      }),
    );
  }
}

/**
 * Runs the app's `beforeSend` (CFG-4). A hook that throws, or returns anything but a record,
 * `null` or `false`, leaves the record as it was. Returns null when the hook dropped it.
 */
export function applyBeforeSend(
  hook: BeforeSend,
  record: { type: "event" | "log" | "span"; name: string; attributes: Record<string, unknown>; body?: unknown },
): { attributes: Record<string, unknown>; body: unknown } | null {
  const view = { type: record.type, name: record.name, attributes: { ...record.attributes }, body: record.body };
  let out: unknown;
  try {
    out = hook(view);
  } catch {
    return { attributes: record.attributes, body: record.body };
  }
  if (out === null || out === false) return null;
  const result = out && typeof out === "object" ? (out as typeof view) : view;
  const attributes: Record<string, unknown> = {};
  const src = result.attributes && typeof result.attributes === "object" ? result.attributes : view.attributes;
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || Array.isArray(v)) attributes[k] = v;
  }
  return { attributes, body: result.body };
}
