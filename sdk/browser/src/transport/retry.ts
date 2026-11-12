/** Responses and retries (SDK spec section 8.2, TRN-6 to TRN-8). Pure. */

export type Verdict = "ok" | "retry" | "reject";

/**
 * Any 2xx is accepted; 429 and 503 are retried honouring `Retry-After`; 502 and 504 are retried
 * with backoff; every other status (400, 413, 408, 500, ...) will not get better and is dropped.
 */
export function classifyStatus(status: number): Verdict {
  if (status >= 200 && status < 300) return "ok";
  if (status === 429 || status === 503 || status === 502 || status === 504) return "retry";
  return "reject";
}

/** `Retry-After` in ms: delta-seconds or an HTTP date. Undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Exponential backoff with full jitter (TRN-7): after the n-th failure (1-based) wait a random
 * time in [0, min(max, initial * 2^(n-1))], never less than 1 ms so a retry is never immediate.
 */
export function backoffDelay(failures: number, initialMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, initialMs * 2 ** Math.min(30, Math.max(0, failures - 1)));
  return Math.max(1, Math.round(random() * ceiling));
}

/** The wait before the next try: `Retry-After` capped at the maximum (TRN-8), else backoff. */
export function retryDelay(failures: number, retryAfterMs: number | undefined, initialMs: number, maxMs: number, random?: () => number): number {
  return retryAfterMs !== undefined ? Math.min(maxMs, Math.max(1, retryAfterMs)) : backoffDelay(failures, initialMs, maxMs, random);
}
