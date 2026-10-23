import type { Context, Span } from "@opentelemetry/api";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

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

const sessionOf = (attrs: Record<string, unknown>): string | undefined => {
  const id = attrs["session.id"];
  return typeof id === "string" ? id : undefined;
};

/**
 * Forwards a log record to `inner` only when its session is in the session sample. Runs after
 * `SessionLogProcessor`, which stamps `session.id` on every record.
 */
export class SampledLogProcessor implements LogRecordProcessor {
  constructor(
    private readonly inner: LogRecordProcessor,
    private readonly rate: number,
  ) {}

  onEmit(record: SdkLogRecord, context?: Context): void {
    const id = sessionOf(record.attributes);
    if (id !== undefined && !sampled(id, this.rate, SAMPLING_SALT.session)) return;
    this.inner.onEmit(record, context);
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
  ) {}

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span as never, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const id = sessionOf(span.attributes);
    if (id !== undefined && !sampled(id, this.rate, SAMPLING_SALT.session)) return;
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
