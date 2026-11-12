import type { Context, Span } from "@opentelemetry/api";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { isDropEvent, type DropCounter } from "./drops";

/**
 * Deterministic session sampling, shared with rum-api's server-side cap
 * (services/rum-api/internal/sampling, docs/operations/data-lifecycle.md): a session is in
 * the sample of `rate` for a decision `salt` when
 *
 *   fmix32(fnv1a32(salt + ":" + sessionId)) / 2^32 < rate
 *
 * FNV-1a runs over UTF-16 code units (charCodeAt); fmix32 is MurmurHash3's finalizer. The same
 * id always gets the same answer on the device and on the server, so a per-project cap below
 * the SDK's rate keeps a subset of the SDK's sample.
 */
export const SAMPLING_SALT = { session: "session", replay: "replay", replayOnError: "replay_on_error" } as const;

export function samplingHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** True when `sessionId` is in the sample of `rate` (1: everything, 0: nothing) for `salt`. */
export function sampled(sessionId: string, rate: number, salt: string): boolean {
  if (rate >= 1) return true;
  if (!(rate > 0)) return false;
  return samplingHash(`${salt}:${sessionId}`) / 4294967296 < rate;
}

/** Clamps an option to [0, 1]; undefined or NaN means `fallback`. */
export function sampleRate(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/**
 * The bypass set (spec SMP-5): the records an unsampled session still sends, and the last ones
 * the offline store evicts. Today's names: an `exception` with `ouo.exception.handled = false`,
 * which covers unhandled errors and rejections, native crashes, terminations and hangs.
 */
export function isBypassRecord(attributes: Record<string, unknown>): boolean {
  return attributes["event.name"] === "exception" && attributes["ouo.exception.handled"] === false;
}

const sessionOf = (attrs: Record<string, unknown>): string | undefined => {
  const id = attrs["session.id"];
  return typeof id === "string" ? id : undefined;
};

/**
 * True when a batch processor's queue is full, so the record handed to it next is dropped
 * (spec ERR-7). The OTel batch processors drop silently and expose no counter; this reads their
 * queue defensively and answers false when the fields are not there.
 */
function queueFull(batch: unknown): boolean {
  const b = batch as { _maxQueueSize?: unknown; _finishedLogRecords?: unknown; _finishedSpans?: unknown };
  const queue = Array.isArray(b._finishedLogRecords) ? b._finishedLogRecords : Array.isArray(b._finishedSpans) ? b._finishedSpans : undefined;
  return queue !== undefined && typeof b._maxQueueSize === "number" && queue.length >= b._maxQueueSize;
}

/** The decision of a session: the one persisted with it (spec SMP-1), else the hash of its id. */
export type SessionDecision = (sessionId: string) => boolean | undefined;

export const DEFAULT_BYPASS_PER_SESSION_CAP = 10;

/**
 * Forwards a log record to `inner` only when its session is in the session sample. Runs after
 * `SessionLogProcessor`, which stamps `session.id` on every record.
 *
 * An unsampled session still sends its bypass set (spec SMP-3, SMP-5): each such record is
 * marked `ouo.sampling.bypass = true` (SMP-6), and at most `bypassCap` of them go out per
 * session; fatal ones (a crash: at most one per session) are not capped (SMP-7).
 */
export class SampledLogProcessor implements LogRecordProcessor {
  private bypassed: { session: string; count: number } | undefined;

  constructor(
    private readonly inner: LogRecordProcessor,
    private readonly rate: number,
    private readonly drops?: DropCounter,
    private readonly decision?: SessionDecision,
    private readonly bypassCap: number = DEFAULT_BYPASS_PER_SESSION_CAP,
  ) {}

  onEmit(record: SdkLogRecord, context?: Context): void {
    const id = sessionOf(record.attributes);
    // The SDK's own drop report is never counted as a drop (it would report itself).
    const counted = this.drops && !isDropEvent(record.attributes["event.name"]) ? this.drops : undefined;
    if (id !== undefined && !(this.decision?.(id) ?? sampled(id, this.rate, SAMPLING_SALT.session))) {
      if (!this.bypass(id, record.attributes)) {
        counted?.count("log", "sampling");
        return;
      }
      record.setAttribute("ouo.sampling.bypass", true);
    }
    if (counted && queueFull(this.inner)) counted.count("log", "queue_full");
    this.inner.onEmit(record, context);
  }

  private bypass(id: string, attributes: Record<string, unknown>): boolean {
    if (!isBypassRecord(attributes)) return false;
    if (attributes["ouo.exception.fatal"] === true) return true;
    if (this.bypassed?.session !== id) this.bypassed = { session: id, count: 0 };
    if (this.bypassed.count >= this.bypassCap) return false;
    this.bypassed.count++;
    return true;
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** The span counterpart: ended spans of unsampled sessions are not exported. */
export class SampledSpanProcessor implements SpanProcessor {
  constructor(
    private readonly inner: SpanProcessor,
    private readonly rate: number,
    private readonly drops?: DropCounter,
    private readonly decision?: SessionDecision,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span as never, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const id = sessionOf(span.attributes);
    if (id !== undefined && !(this.decision?.(id) ?? sampled(id, this.rate, SAMPLING_SALT.session))) {
      this.drops?.count("span", "sampling");
      return;
    }
    if (this.drops && queueFull(this.inner)) this.drops.count("span", "queue_full");
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
