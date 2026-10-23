import { context, propagation, SpanKind, SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";
import type { DebugLogger } from "./logger";
import type { EventEmitter } from "./telemetry/events";
import type { TraceLinker } from "./tracing";
import { matchesAny, parseUrl } from "./url";

export interface NetworkOptions {
  tracer: Tracer;
  events: EventEmitter;
  logger: DebugLogger;
  propagateTo: Array<RegExp | string>;
  ignoreUrls: Array<RegExp | string>;
  /** Called on every outbound request (activity rule). */
  onActivity: () => void;
  /** Emit `http.request` for answered requests below 500 (timeline, checklist G4). Default false. */
  requestEvents?: boolean;
  /** Remembers failed requests and rejected errors, so errors carry the request's trace (G5). */
  linker?: TraceLinker;
}

/**
 * Depth of ouo's fetch wrapper calling the original fetch. React Native's fetch (whatwg-fetch)
 * creates, opens and sends its XMLHttpRequest synchronously inside that call; the XHR
 * instrumentation skips those requests because the fetch wrapper already traces them.
 */
let insideFetch = 0;

type FetchFn = typeof fetch;
type WrappedFetch = FetchFn & { __original?: FetchFn; __ouo?: true };

/** Pure rule (ADR-0004): 5xx or a network failure (status 0) is a failed request, 4xx is not. */
export function isFailedRequest(status: number | undefined): boolean {
  return status === undefined || status === 0 || (status >= 500 && status <= 599);
}

interface HeaderBag {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  toInit(): Record<string, string>;
}

/** Normalises every HeadersInit shape (Headers, array, object) into a plain case-insensitive bag. */
function headerBag(...sources: Array<unknown>): HeaderBag {
  const map = new Map<string, [string, string]>();
  const add = (name: string, value: string): void => {
    map.set(name.toLowerCase(), [name, value]);
  };
  for (const src of sources) {
    if (!src) continue;
    const h = src as { forEach?: (cb: (value: string, key: string) => void) => void };
    if (typeof h.forEach === "function" && !Array.isArray(src)) {
      h.forEach((value, key) => add(key, value));
    } else if (Array.isArray(src)) {
      for (const pair of src as Array<[string, string]>) if (pair.length >= 2) add(String(pair[0]), String(pair[1]));
    } else if (typeof src === "object") {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) if (v !== undefined) add(k, String(v));
    }
  }
  return {
    get: (name) => map.get(name.toLowerCase())?.[1],
    set: add,
    toInit: () => Object.fromEntries(Array.from(map.values())),
  };
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const o = input as { url?: unknown; href?: unknown };
    if (typeof o.url === "string") return o.url;
    if (typeof o.href === "string") return o.href;
  }
  return String(input);
}

function requestMethod(input: unknown, init: RequestInit | undefined): string {
  const fromInit = init?.method;
  if (typeof fromInit === "string" && fromInit) return fromInit.toUpperCase();
  const fromRequest = (input as { method?: unknown } | null)?.method;
  if (typeof fromRequest === "string" && fromRequest) return fromRequest.toUpperCase();
  return "GET";
}

/** `http.request.failed` with the request span's trace id and span id, as the bridge derives it from `http.client` spans. */
function failedRequestEmitter(events: EventEmitter, linker?: TraceLinker) {
  return (span: Span, status: number, url: string, method: string, errorType?: string): void => {
    events.emit(
      "http.request.failed",
      {
        "http.request.method": method,
        "url.full": url,
        "http.response.status_code": status,
        ...(errorType ? { "error.type": errorType } : {}),
      },
      "error",
      Date.now(),
      { body: `${method} ${url}`, context: trace.setSpan(context.active(), span) },
    );
    span.setAttribute("ouo.http.failed", true);
    linker?.noteFailedRequest(span);
  };
}

/** `http.request` for an answered request (1 to 499), named and shaped like the bridge's (spec section 9a). */
function requestEmitter(opts: NetworkOptions) {
  return (span: Span, status: number, url: string, method: string): void => {
    if (!opts.requestEvents || status < 1 || status >= 500) return;
    opts.events.emit("http.request", { "http.request.method": method, "url.full": url, "http.response.status_code": status }, "info", Date.now(), {
      body: `${method} ${url}`,
      context: trace.setSpan(context.active(), span),
    });
  };
}

function startClientSpan(tracer: Tracer, method: string, url: string): Span {
  const parsed = parseUrl(url);
  return tracer.startSpan(`HTTP ${method}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "http.request.method": method,
      "url.full": url,
      ...(parsed ? { "server.address": parsed.host, "url.scheme": parsed.scheme, "url.path": parsed.path } : {}),
      ...(parsed?.port !== undefined ? { "server.port": parsed.port } : {}),
    },
  });
}

/**
 * Wraps `globalThis.fetch`: one CLIENT span per request, `traceparent` + `baggage` on
 * matching URLs, `http.request.failed` on 5xx / network failure, session activity.
 * The original is kept on `fetch.__original` so the OTLP exporter bypasses the wrapper.
 */
export function installFetchInstrumentation(opts: NetworkOptions): () => void {
  const g = globalThis as { fetch?: WrappedFetch };
  const original = g.fetch;
  if (typeof original !== "function") {
    opts.logger.warn("fetch not available: network instrumentation skipped");
    return () => {};
  }
  if (original.__ouo) return () => {};
  const { tracer, events, onActivity } = opts;

  const emitFailed = failedRequestEmitter(events, opts.linker);
  const emitRequest = requestEmitter(opts);

  const wrapped: WrappedFetch = function ouoFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = requestUrl(input);
    if (matchesAny(url, opts.ignoreUrls)) return original.call(this ?? globalThis, input, init);
    onActivity();
    const method = requestMethod(input, init);
    const span = startClientSpan(tracer, method, url);

    let nextInit = init;
    if (matchesAny(url, opts.propagateTo)) {
      const requestHeaders = input && typeof input === "object" && "headers" in (input as object) ? (input as Request).headers : undefined;
      const bag = headerBag(requestHeaders, init?.headers);
      propagation.inject(trace.setSpan(context.active(), span), bag, {
        set: (carrier, key, value) => (carrier as HeaderBag).set(key, value),
      });
      nextInit = { ...(init ?? {}), headers: bag.toInit() };
    }

    let result: Promise<Response>;
    insideFetch++;
    try {
      result = original.call(this ?? globalThis, input, nextInit);
    } catch (err) {
      finishError(err);
      return Promise.reject(err);
    } finally {
      insideFetch--;
    }
    return result.then(
      (res) => {
        const status = res.status;
        span.setAttribute("http.response.status_code", status);
        if (isFailedRequest(status)) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
          emitFailed(span, status, url, method);
        } else {
          emitRequest(span, status, url, method);
        }
        span.end();
        return res;
      },
      (err: unknown) => {
        finishError(err);
        throw err;
      },
    );

    function finishError(err: unknown): void {
      const type = err instanceof Error ? err.name || "Error" : typeof err;
      span.setAttribute("error.type", type);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      // AbortError is the caller cancelling, not a failed backend; everything else is a network failure.
      if (!(err instanceof Error && err.name === "AbortError")) emitFailed(span, 0, url, method, type);
      opts.linker?.rememberError(err, span);
      span.end();
    }
  } as WrappedFetch;
  wrapped.__original = original;
  wrapped.__ouo = true;
  g.fetch = wrapped;
  return () => {
    if (g.fetch === wrapped) g.fetch = original;
  };
}

// ---- XMLHttpRequest ------------------------------------------------------------------------

interface XhrState {
  method: string;
  url: string;
  /** Lower-cased names of the headers set so far (by the app or another SDK). */
  headers: Set<string>;
  skip: boolean;
}

interface XhrLike {
  status: number;
  setRequestHeader(name: string, value: string): void;
  addEventListener?(type: string, listener: () => void): void;
  __ouoXhr?: XhrState;
}

interface XhrProto {
  open(this: XhrLike, method: string, url: string | URL, ...rest: unknown[]): void;
  setRequestHeader(this: XhrLike, name: string, value: string): void;
  send(this: XhrLike, body?: unknown): void;
}

/**
 * Wraps `XMLHttpRequest.prototype` (open, setRequestHeader, send): one CLIENT span per request
 * with the same attributes, propagation and failed-request rule as the fetch wrapper. Clients
 * built on XHR (axios, superagent) are traced this way; fetch's own XHR is skipped.
 *
 * `traceparent` is only added when the request has none yet: XHR joins repeated headers into
 * one value, and two trace parents (another SDK, e.g. Sentry with `propagateTraceparent`, ran
 * first) would be an invalid header. `baggage` is merged the same way, which is valid.
 */
export function installXhrInstrumentation(opts: NetworkOptions): () => void {
  const Xhr = (globalThis as { XMLHttpRequest?: { prototype: XhrProto & { __ouo?: true } } }).XMLHttpRequest;
  const proto = Xhr?.prototype;
  if (!proto || typeof proto.open !== "function" || typeof proto.send !== "function") {
    opts.logger.log("XMLHttpRequest not available: XHR instrumentation skipped");
    return () => {};
  }
  if (proto.__ouo) return () => {};
  const { tracer, events, onActivity } = opts;
  const emitFailed = failedRequestEmitter(events, opts.linker);
  const emitRequest = requestEmitter(opts);
  const original = { open: proto.open, setRequestHeader: proto.setRequestHeader, send: proto.send };

  proto.open = function ouoOpen(this: XhrLike, method: string, url: string | URL, ...rest: unknown[]): void {
    const u = typeof url === "string" ? url : String(url);
    this.__ouoXhr = {
      method: String(method || "GET").toUpperCase(),
      url: u,
      headers: new Set(),
      skip: insideFetch > 0 || matchesAny(u, opts.ignoreUrls),
    };
    return original.open.call(this, method, url, ...rest);
  };

  proto.setRequestHeader = function ouoSetRequestHeader(this: XhrLike, name: string, value: string): void {
    this.__ouoXhr?.headers.add(String(name).toLowerCase());
    return original.setRequestHeader.call(this, name, value);
  };

  proto.send = function ouoSend(this: XhrLike, body?: unknown): void {
    const state = this.__ouoXhr;
    if (!state || state.skip) return original.send.call(this, body);
    onActivity();
    const { method, url } = state;
    const span = startClientSpan(tracer, method, url);

    if (matchesAny(url, opts.propagateTo)) {
      const carrier: Record<string, string> = {};
      propagation.inject(trace.setSpan(context.active(), span), carrier);
      for (const [name, value] of Object.entries(carrier)) {
        const lower = name.toLowerCase();
        if ((lower === "traceparent" || lower === "tracestate") && state.headers.has("traceparent")) continue;
        try {
          this.setRequestHeader(name, value);
        } catch (e) {
          opts.logger.warn("could not set", name, e);
        }
      }
    }

    let done = false;
    let aborted = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      const status = typeof this.status === "number" ? this.status : 0;
      if (aborted) {
        span.setAttribute("error.type", "AbortError");
        span.setStatus({ code: SpanStatusCode.ERROR, message: "aborted" });
      } else {
        span.setAttribute("http.response.status_code", status);
        if (isFailedRequest(status)) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: status ? `HTTP ${status}` : "network error" });
          emitFailed(span, status, url, method, status ? undefined : "NetworkError");
        } else {
          emitRequest(span, status, url, method);
        }
      }
      span.end();
    };
    if (typeof this.addEventListener === "function") {
      this.addEventListener("abort", () => {
        aborted = true;
      });
      this.addEventListener("loadend", finish);
    }
    try {
      return original.send.call(this, body);
    } catch (err) {
      const type = err instanceof Error ? err.name || "Error" : typeof err;
      span.setAttribute("error.type", type);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      emitFailed(span, 0, url, method, type);
      done = true;
      span.end();
      throw err;
    }
  };
  proto.__ouo = true;

  return () => {
    proto.open = original.open;
    proto.setRequestHeader = original.setRequestHeader;
    proto.send = original.send;
    delete proto.__ouo;
  };
}
