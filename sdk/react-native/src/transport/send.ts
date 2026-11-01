import type { SendResult, Send } from "./outbox";

/** Native gzip + POST of the Expo module (`postOtlp`), off the JS thread; `status` 0 when there was no answer. */
export interface NativeOtlpPost {
  postOtlp(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; retryAfter?: string | null }>;
}

/** Abort a request after this long; the outbox retries it. */
export const SEND_TIMEOUT_MS = 15_000;

/**
 * How an OTLP body leaves the device: through the native module, which gzips it (checklist
 * N48; Hermes has no `CompressionStream`), or, without it (Expo Go, web), through
 * `fetch` uncompressed. `headers` are added at send time, so stored requests carry the
 * credential of the run that sends them.
 */
export function createSend(headers: Record<string, string>, native: Partial<NativeOtlpPost> | undefined): Send {
  const all = { "content-type": "application/json", ...headers };
  if (native && typeof native.postOtlp === "function") {
    const post = native.postOtlp.bind(native);
    return async (url, body) => {
      const res = await post(url, all, body);
      return withRetryAfter(res.status, res.retryAfter ?? null);
    };
  }
  return async (url, body) => {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), SEND_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, { method: "POST", headers: all, body, ...(abort ? { signal: abort.signal } : {}) });
      return withRetryAfter(res.status, res.headers?.get?.("retry-after") ?? null);
    } catch {
      return { status: 0 };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };
}

function withRetryAfter(status: number, header: string | null): SendResult {
  const retryAfterMs = parseRetryAfter(header);
  return retryAfterMs === undefined ? { status } : { status, retryAfterMs };
}

/** `Retry-After` in seconds or as an HTTP date, in milliseconds from now. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
