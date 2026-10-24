import type { Span } from "@opentelemetry/api";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { XMLHttpRequestInstrumentation } from "@opentelemetry/instrumentation-xml-http-request";
import { attempt } from "./guard";
import type { EventEmitter } from "./telemetry/events";
import type { DebugLogger } from "./logger";

export interface NetworkOptions {
  events: EventEmitter;
  logger: DebugLogger;
  propagateTo: Array<RegExp | string>;
  ignoreUrls: Array<RegExp | string>;
  /** Called on every outbound request (activity rule). */
  onActivity: () => void;
}

/** Pure rule (ADR-0004): 5xx or a network failure (status 0) is a failed request, 4xx is not. */
export function isFailedRequest(status: number | undefined): boolean {
  return status === undefined || status === 0 || (status >= 500 && status <= 599);
}

type SpanWithAttributes = Span & { attributes?: Record<string, unknown> };

function spanAttr(span: Span, key: string): string | undefined {
  const v = (span as SpanWithAttributes).attributes?.[key];
  return typeof v === "string" ? v : undefined;
}

export function createNetworkInstrumentations(opts: NetworkOptions) {
  const { events, onActivity } = opts;

  const emitFailed = (span: Span, status: number, url: string | undefined, method: string | undefined): void => {
    events.emit(
      "http.request.failed",
      {
        "http.request.method": method ?? "GET",
        "url.full": url ?? "",
        "http.response.status_code": status,
      },
      "error",
    );
    span.setAttribute("ouo.http.failed", true);
  };

  const fetchInstrumentation = new FetchInstrumentation({
    propagateTraceHeaderCorsUrls: opts.propagateTo,
    ignoreUrls: opts.ignoreUrls,
    ignoreNetworkEvents: true,
    requestHook: () => attempt(onActivity),
    // The hooks run inside the patched fetch / XHR: guarded so the page's request never sees an SDK error.
    applyCustomAttributesOnSpan: (span, request, result) =>
      attempt(() => {
        const status = (result as { status?: number }).status;
        if (!isFailedRequest(status)) return;
        // The span attribute is the requested URL; response.url is empty on synthetic responses.
        const url = spanAttr(span, "url.full") || (request instanceof Request ? request.url : "") || (result as { url?: string }).url;
        const method =
          (request instanceof Request ? request.method : (request as RequestInit).method) ?? spanAttr(span, "http.request.method");
        emitFailed(span, status ?? 0, url, method?.toUpperCase());
      }),
  });

  const xhrInstrumentation = new XMLHttpRequestInstrumentation({
    propagateTraceHeaderCorsUrls: opts.propagateTo,
    ignoreUrls: opts.ignoreUrls,
    ignoreNetworkEvents: true,
    applyCustomAttributesOnSpan: (span, xhr) =>
      attempt(() => {
        onActivity();
        if (!isFailedRequest(xhr.status)) return;
        emitFailed(span, xhr.status, xhr.responseURL || spanAttr(span, "url.full"), spanAttr(span, "http.request.method"));
      }),
  });

  return [fetchInstrumentation, xhrInstrumentation];
}
