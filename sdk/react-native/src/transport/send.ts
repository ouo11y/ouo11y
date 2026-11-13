import type { SendResult, Send } from "./outbox";

/** Native gzip + POST of the Expo module (`postOtlp`), off the JS thread; `status` 0 when there was no answer. */
export interface NativeOtlpPost {
  /** `body`: the response body, when the native module returns it (for `partial_success`). */
  postOtlp(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; retryAfter?: string | null; body?: string | null }>;
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
      return answer(res.status, res.retryAfter ?? null, res.body);
    };
  }
  return async (url, body) => {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), SEND_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, { method: "POST", headers: all, body, ...(abort ? { signal: abort.signal } : {}) });
      const ok = res.status >= 200 && res.status < 300;
      // Only an accepted answer can carry `partial_success`; a body that cannot be read is none.
      const text = ok && typeof res.text === "function" ? await res.text().catch(() => "") : "";
      return answer(res.status, res.headers?.get?.("retry-after") ?? null, text);
    } catch {
      return { status: 0 };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };
}

function answer(status: number, header: string | null, body?: string | null): SendResult {
  const retryAfterMs = parseRetryAfter(header);
  const rejected = status >= 200 && status < 300 ? partialRejected(body) : 0;
  return { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), ...(rejected > 0 ? { rejected } : {}) };
}

/**
 * Rejected records of an OTLP/HTTP JSON answer: `{"partialSuccess":{"rejectedLogRecords":"3"}}`
 * (or `rejectedSpans`; int64 as a string or a number). 0 for an empty body or anything else.
 */
export function partialRejected(body: string | null | undefined): number {
  if (!body || body.length > 65_536 || !body.includes("artial")) return 0;
  try {
    const parsed = JSON.parse(body) as { partialSuccess?: Record<string, unknown>; partial_success?: Record<string, unknown> } | null;
    const p = parsed?.partialSuccess ?? parsed?.partial_success;
    if (!p || typeof p !== "object") return 0;
    const n = Number(p["rejectedLogRecords"] ?? p["rejectedSpans"] ?? p["rejected_log_records"] ?? p["rejected_spans"] ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** `Retry-After` in seconds or as an HTTP date, in milliseconds from now. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
