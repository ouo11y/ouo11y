/** What to do with an HTTP answer: done, try again later, or give up (the request is wrong). */
export type StatusClass = "ok" | "retry" | "drop";

/**
 * 2xx is delivered; OTLP/HTTP's retryable answers, 429, 502, 503 and 504, are retried; any other
 * status is final and dropped as `rejected` (408 and 500 included: the collector answers 500 only
 * for what will not get better, so a retry would cost the backoff and the store for nothing). The
 * mobile SDKs follow the same rule (checklist N55, N88).
 */
export function classifyStatus(status: number): StatusClass {
  if (status >= 200 && status < 300) return "ok";
  if (status === 429 || status === 502 || status === 503 || status === 504) return "retry";
  return "drop";
}

/**
 * `Retry-After` in milliseconds: delta-seconds or an HTTP date (RFC 9110 §10.2.3). Undefined when
 * absent or unreadable; a date in the past is 0.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export interface BackoffPolicy {
  /** Delay before the first retry. */
  baseDelayMs: number;
  /** No single delay is longer. */
  maxDelayMs: number;
}

/**
 * Exponential backoff with equal jitter: attempt n (1-based, the attempt that failed) waits
 * between half and all of `min(max, base * 2^(n-1))`, so clients that failed together do not
 * retry together and no retry is immediate.
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
