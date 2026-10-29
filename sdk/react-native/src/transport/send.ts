import type { SendResult, Send } from "./outbox";

/** Native gzip + POST of the Expo module (`postOtlp`), off the JS thread. */
export interface NativeOtlpPost {
  postOtlp(url: string, headers: Record<string, string>, body: string): Promise<SendResult>;
}

/** Abort a request after this long; the outbox retries it. */
export const SEND_TIMEOUT_MS = 15_000;

/**
 * How an OTLP body leaves the device: through the native module, which gzips it (checklist
 * N48; Hermes has no `CompressionStream`), or, without it (Expo Go, the Android stub), through
 * `fetch` uncompressed. `headers` are added at send time, so stored requests carry the
 * credential of the run that sends them.
 */
export function createSend(headers: Record<string, string>, native: Partial<NativeOtlpPost> | undefined): Send {
  const all = { "content-type": "application/json", ...headers };
  if (native && typeof native.postOtlp === "function") {
    const post = native.postOtlp.bind(native);
    return (url, body) => post(url, all, body);
  }
  return async (url, body) => {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), SEND_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, { method: "POST", headers: all, body, ...(abort ? { signal: abort.signal } : {}) });
      const retryAfterMs = parseRetryAfter(res.headers?.get?.("retry-after") ?? null);
      return retryAfterMs === undefined ? { status: res.status } : { status: res.status, retryAfterMs };
    } catch {
      return { status: 0 };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };
}

/** `Retry-After` in seconds or as an HTTP date, in milliseconds from now. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
