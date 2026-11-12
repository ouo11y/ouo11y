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

export function installNetwork(d: NetworkDeps): () => void {
  const ignoreUrls = [new RegExp(`^${escapeRegExp(d.endpoint)}/v1/`), ...toOtel(d.ignoreUrls)];
  const common = {
    propagateTraceHeaderCorsUrls: toOtel(d.propagateTo),
    ignoreUrls,
    // Network timings would be span events (REL-7).
    ignoreNetworkEvents: true,
  };
  const instrumentations: Instrumentation[] = [];
  if (d.fetch && typeof fetch === "function") instrumentations.push(new FetchInstrumentation(common));
  if (d.xhr && typeof XMLHttpRequest === "function") instrumentations.push(new XMLHttpRequestInstrumentation(common));
  if (instrumentations.length === 0) return () => undefined;
  return registerInstrumentations({ instrumentations, tracerProvider: d.tracerProvider });
}
