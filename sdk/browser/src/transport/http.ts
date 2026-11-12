/**
 * One OTLP/HTTP POST (TRN-1). No retry here: the queues own that. gzip when the page is not
 * closing, `keepalive` within the shared 60 KiB budget (TRN-16), a timeout on every request, and
 * the answer classified by the spec's table, `partial_success` included.
 */
import { systemClock, type Clock } from "../core/clock";
import { point } from "../guard";
import { canGzip, GZIP_MIN_BYTES, gzipBytes } from "./gzip";
import { releaseKeepalive, reserveKeepalive } from "./keepalive";
import { classifyStatus, parseRetryAfter } from "./retry";

export type PostResult =
  | { kind: "ok" }
  /** 2xx with rejected records: not retried. */
  | { kind: "partial"; rejected: number }
  | { kind: "retry"; retryAfterMs?: number | undefined; why: string }
  | { kind: "reject"; status: number };

export interface PostOptions {
  contentType: string;
  /** Compress the body (never at page hide: nothing may be awaited before the request leaves). */
  gzip?: boolean;
  /** Require `keepalive`: the request is not sent at all when the budget cannot take it. */
  mustKeepalive?: boolean;
  /** Reads the number of rejected records from a 2xx response body. */
  rejected?: (body: Uint8Array) => number;
}

export interface HttpOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

/** fetch below the OpenTelemetry instrumentation wrapper, so exports never become spans (SIG-40). */
export function rawFetch(): typeof fetch {
  const f = globalThis.fetch as typeof fetch & { __original?: typeof fetch };
  return typeof f.__original === "function" ? f.__original : f;
}

export class Http {
  private readonly clock: Clock;
  /** Requests and bytes since init, for the debug stats. */
  readonly stats = { requests: 0, bytes: 0 };

  constructor(private readonly opts: HttpOptions) {
    this.clock = opts.clock ?? systemClock;
  }

  /** Never rejects. `null`: not sent, because `mustKeepalive` did not fit the budget. */
  async post(url: string, payload: Uint8Array, o: PostOptions): Promise<PostResult | null> {
    let body = payload;
    const headers: Record<string, string> = { ...this.opts.headers, "content-type": o.contentType };
    if (o.gzip && body.byteLength >= GZIP_MIN_BYTES && canGzip()) {
      try {
        const gz = await gzipBytes(body);
        if (gz.byteLength < body.byteLength) {
          body = gz;
          headers["content-encoding"] = "gzip";
        }
      } catch {
        // Sent uncompressed.
      }
    }
    const keepalive = reserveKeepalive(body.byteLength);
    if (o.mustKeepalive && !keepalive) return null;
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const timer = abort ? this.clock.setTimeout(() => abort.abort(), this.opts.timeoutMs) : null;
    try {
      point("http.post");
      this.stats.requests++;
      this.stats.bytes += body.byteLength;
      const res = await (this.opts.fetchImpl ?? rawFetch())(url, {
        method: "POST",
        headers,
        body: body as BodyInit,
        keepalive,
        // No cookies, also to a first-party proxy route.
        credentials: "omit",
        ...(abort ? { signal: abort.signal } : {}),
      });
      const verdict = classifyStatus(res.status);
      if (verdict === "retry") return { kind: "retry", why: `HTTP ${res.status}`, retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), Date.now()) };
      if (verdict === "reject") return { kind: "reject", status: res.status };
      if (o.rejected && res.status !== 204) {
        try {
          const bytes = new Uint8Array(await res.arrayBuffer());
          const rejected = bytes.byteLength > 0 ? o.rejected(bytes) : 0;
          if (rejected > 0) return { kind: "partial", rejected };
        } catch {
          // An unreadable 2xx body is an accepted request.
        }
      }
      return { kind: "ok" };
    } catch (err) {
      return { kind: "retry", why: (err as { name?: string } | null)?.name === "AbortError" ? "timeout" : "network" };
    } finally {
      if (keepalive) releaseKeepalive(body.byteLength);
      if (timer !== null) this.clock.clearTimeout(timer);
    }
  }
}
