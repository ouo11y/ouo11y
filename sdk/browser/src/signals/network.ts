/**
 * Fetch and XHR (SIG-21): the OpenTelemetry instrumentations, emitting client spans named by
 * method with the stable HTTP attributes, one trace per request. What the SDK adds around them:
 * its own tracer (scope `ouo.rum`), no span events, the SDK's export URLs ignored (SIG-40) and
 * `traceparent` only to the same origin and the configured URLs (PRP-2). Requests are not session
 * activity (SES-5).
 */
import type { TracerProvider } from "@opentelemetry/api";
import { registerInstrumentations, type Instrumentation } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { XMLHttpRequestInstrumentation } from "@opentelemetry/instrumentation-xml-http-request";
import type { UrlPattern } from "../types";

export interface NetworkDeps {
  tracerProvider: TracerProvider;
  fetch: boolean;
  xhr: boolean;
  propagateTo: UrlPattern[];
  ignoreUrls: UrlPattern[];
  /** The collector endpoint: its requests are never traced. */
  endpoint: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The instrumentations match strings exactly; a trailing `*` in ours means a prefix. */
function toOtel(patterns: UrlPattern[]): Array<string | RegExp> {
  return patterns.map((p) => (typeof p === "string" && p.endsWith("*") ? new RegExp(`^${escapeRegExp(p.slice(0, -1))}`) : p));
}

/** Every member of `RequestInit` the platform reads (and a few it may read tomorrow). */
const INIT_KEYS = ["method", "headers", "body", "mode", "credentials", "cache", "redirect", "referrer", "referrerPolicy", "integrity", "keepalive", "signal", "priority", "window", "duplex"];

/**
 * A copy of the app's `fetch` init for the instrumentation to write its headers on, so the
 * app's object is never changed. It must lose nothing in either direction: the platform reads
 * init members through the prototype chain (an init made with `Object.create(defaults)`, a class
 * instance with getters), and an interceptor installed below the SDK may copy the init with a
 * spread, which keeps own properties only. So every member, inherited or not, becomes an own
 * property of the copy.
 */
export function copyInit(init: RequestInit): RequestInit {
  const copy: Record<string, unknown> = {};
  const src = init as Record<string, unknown>;
  for (const key in src) copy[key] = src[key];
  for (const key of INIT_KEYS) {
    if (!(key in copy) && src[key] !== undefined) copy[key] = src[key];
  }
  return copy as RequestInit;
}

export function installNetwork(d: NetworkDeps): () => void {
  const ignoreUrls = [new RegExp(`^${escapeRegExp(d.endpoint)}/v1/`), ...toOtel(d.ignoreUrls)];
  const common = {
    propagateTraceHeaderCorsUrls: toOtel(d.propagateTo),
    ignoreUrls,
    // Network timings would be span events (REL-7).
    ignoreNetworkEvents: true,
  };
  // Taken before the instrumentations exist: they patch in their constructors.
  const g = globalThis as { fetch?: typeof fetch };
  const xhr = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest?.prototype;
  const before = { fetch: g.fetch, open: xhr?.open, send: xhr?.send };
  const instrumentations: Instrumentation[] = [];
  if (d.fetch && typeof fetch === "function") instrumentations.push(new FetchInstrumentation(common));
  if (d.xhr && typeof XMLHttpRequest === "function") instrumentations.push(new XMLHttpRequestInstrumentation(common));
  if (instrumentations.length === 0) return () => undefined;
  // The instrumentations leave their wrappers in place when disabled (inert, but they would pile
  // up over init and shutdown cycles). What is still the SDK's own wrapper at shutdown is put
  // back; a wrapper another tool added on top is left alone (GR-HDR-4).
  const disable = registerInstrumentations({ instrumentations, tracerProvider: d.tracerProvider });
  // The fetch instrumentation writes the trace headers onto the init or Request it was given.
  // An app that reuses that object would send the next request with this one's `traceparent`,
  // also to origins that must not get one. So the instrumentation is given a stand-in.
  const traced = g.fetch;
  if (traced && traced !== before.fetch) {
    const wrapper = function ouoFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let i = input;
      let o = init;
      try {
        if (init && typeof init === "object") o = copyInit(init);
        if (typeof Request === "function" && input instanceof Request) i = new Request(input);
      } catch {
        // A Request that cannot be copied (its body was used) goes through as it is.
        i = input;
      }
      return traced.call(this, i, o);
    } as typeof fetch & { __original?: unknown };
    // Exports look for the function below the instrumentation here (transport/http.ts).
    wrapper.__original = (traced as { __original?: unknown }).__original ?? before.fetch;
    try {
      g.fetch = wrapper;
    } catch {
      // A locked global keeps the instrumentation's wrapper.
    }
  }
  const patched = { fetch: g.fetch, open: xhr?.open, send: xhr?.send };
  return () => {
    disable();
    try {
      if (before.fetch && g.fetch === patched.fetch) g.fetch = before.fetch;
      if (xhr && before.open && xhr.open === patched.open) xhr.open = before.open;
      if (xhr && before.send && xhr.send === patched.send) xhr.send = before.send;
    } catch {
      // A locked global stays as it is.
    }
  };
}
