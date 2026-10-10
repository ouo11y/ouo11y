# otel browser sdk

Status: filled in Phase 2 by sdk-browser (2026-10-06), ingest-gateway section added in Phase 8a (2026-10-10). Code: `sdk/browser`.

## Question

How is the OpenTelemetry JS web SDK wired so every span and log record carries
`session.id`, outbound fetch/XHR requests carry `traceparent` and `baggage`, session and
error events reach Loki as `event.name` log records, and all of it builds to a lean ESM
bundle?

## Versions that work together

`@opentelemetry/api` 1.9.1, `api-logs` / `sdk-logs` / `exporter-*-otlp-http` /
`instrumentation` / `instrumentation-fetch` / `instrumentation-xml-http-request` /
`opentelemetry-browser-detector` 0.222.0, `sdk-trace-web` / `sdk-trace-base` / `core` /
`resources` 2.11.0, `instrumentation-document-load` 0.67.0, `semantic-conventions` 1.43.0,
`web-vitals` 6.2.3, `rrweb` 2.1.7. Build: tsup 8.5 (esbuild), TypeScript 5.9 (7.x is the
Go port and is not what tsup's dts build expects), Vitest 5 + jsdom 30.

## What was tried

1. **Exporter format**: `@opentelemetry/exporter-trace-otlp-http` and
   `exporter-logs-otlp-http` (OTLP/HTTP **JSON**, `Content-Type: application/json`). The
   collector's OTLP receiver accepted both and Tempo / Loki show the data; no reason to
   pull in the protobuf exporters (`-otlp-proto`) which add ~30 KB.
2. **Browser transport**: in 0.222 the browser exporters are plain `fetch` with
   `keepalive: true` and a built-in guard for Chrome's cumulative 64 KiB / 9 concurrent
   keepalive budget (`otlp-exporter-base/transport/fetch-transport.js`). `sendBeacon` is
   gone (the export delegate name still says SendBeacon but it is fetch). The transport
   calls `fetch.__original` when the fetch instrumentation has wrapped `fetch`, so export
   requests never become spans. Reuse that trick for your own uploads (the replay uploader
   does) or they get traced.
3. **Baggage injection**: the fetch instrumentation injects headers with
   `propagation.inject(context.active(), ...)`. Without zone.js the web SDK has a
   `StackContextManager`, so baggage set with `context.with()` at init is not active when
   the app calls `fetch()` later. Setting baggage via a context is therefore unreliable;
   what works is a custom `TextMapPropagator` (`src/telemetry/propagator.ts`) that wraps the
   `CompositePropagator([W3CTraceContextPropagator, W3CBaggagePropagator])` and merges
   `session.id`, `user.id`, `ouo.platform` into the context's baggage **at inject time**.
   Verified in a real browser: the demo backend's spans carry `session.id` / `user.id` /
   `ouo.platform` copied from baggage and sit under the browser span in one trace.
4. **Header propagation scope**: `propagateTraceHeaderCorsUrls` (our `tracing.propagateTo`)
   gates `traceparent` and `baggage` for cross-origin requests; same-origin always gets
   them. The collector's CORS config must list `Traceparent` and `Baggage`; the demo backend
   answers preflights with `content-type, traceparent, tracestate, baggage`.
5. **Session attributes on spans and logs**: a `SpanProcessor.onStart` that calls
   `span.setAttributes(...)` and a `LogRecordProcessor.onEmit` that calls
   `record.setAttribute(...)` only for keys that are absent (a `session.end` record names
   the ended session and must not get the new session's `session.previous_id`).
   `WebTracerProvider({ spanProcessors: [...] })` and
   `LoggerProvider({ processors: [...] })` are the 2.x constructor forms; `addSpanProcessor`
   is gone.
6. **Events**: `logger.emit({ eventName, attributes: { "event.name": name, ... } })`. The
   JSON serializer writes the top-level `eventName`; the collector's transform copies it to
   the `event.name` attribute if missing, but setting both is cheapest. Loki shows
   `event_name` as a label and `session_id`, `user_id`, `service_version`,
   `ouo_exception_fatal`, `ouo_web_vital_name`, `url_path` as structured metadata.
7. **Failed-request events**: `applyCustomAttributesOnSpan(span, request, result)` is the
   hook with the response status. `result.url` is empty for synthetic responses and
   `request` is a bare `RequestInit` when `fetch(url, init)` was used, so read the URL from
   the span's own `url.full` attribute (the SDK `Span` exposes `.attributes`). Network
   failures arrive as `{ status: 0 }`. The instrumentation already sets
   `http.response.status_code` and `error.type` on the span.
8. **Fetch span timing**: a fetch span ends 300 ms after the response
   (`OBSERVER_WAIT_TIME_MS`, waits for the resource timing entry). Tests must wait that
   long before `forceFlush()`.
9. **console.error capture and OTel diag**: `DiagConsoleLogger` logs errors through
   `console.error`, which the SDK instruments; with `debug: true` that would turn exporter
   diagnostics into `exception` events. Use a custom `DiagLogger` that writes with
   `console.warn` / `console.log`.
10. **Vitest resolution**: the OTel packages select their browser build through the legacy
    package.json `browser` field, not `exports` conditions. Node therefore loads the
    **node** build, whose OTLP exporters use `node:http` and happily post to a live
    collector while your `fetch` stub sees nothing. Fix in `vitest.config.ts`:
    `resolve.mainFields: ["browser", "module", "main"]` plus
    `test.server.deps.inline: [/@opentelemetry\//, /rrweb/, /web-vitals/]`.
11. **jsdom quirks**: `Blob.prototype.stream` is missing (gzip via
    `new Response(bytes).body.pipeThrough(new CompressionStream("gzip"))` instead);
    `Uint8Array` from the serializer is from another realm, so use `ArrayBuffer.isView`
    rather than `instanceof`.
12. **Resource**: `defaultResource().merge(detectResources({ detectors: [browserDetector] }))
    .merge(resourceFromAttributes({...}))`. The browser detector gives
    `user_agent.original`, `browser.language`, and `browser.platform` / `browser.brands` /
    `browser.mobile` only where `navigator.userAgentData` exists. `os.name` / `os.version`
    are a 10-line UA regex (`src/telemetry/resource.ts`).
13. **web-vitals in automation**: both the Claude Browser pane and the Chrome extension
    load tabs with `document.visibilityState === "hidden"` from t=0 (`visibility-state`
    performance entries show `hidden` at 0, first paint only when the pane is shown), so
    web-vitals correctly discards FCP/LCP/CLS/INP and only TTFB is reported. Not an SDK
    bug: the `web_vital` pipeline is proven with TTFB end to end and the other metrics by a
    unit test with a mocked `web-vitals`. Check them in a normal foreground Chrome window.

## Ingest gateway and project tokens (Phase 8a, SDK 0.2.0, ADR-0007)

14. **Headers on the OTLP exporters**: `OTLPTraceExporter` / `OTLPLogExporter` (0.222)
    take `headers?: Record<string, string> | (() => Promise<Record<string,string>>)` in
    their config (`OTLPExporterConfigBase`, `otlp-exporter-base/configuration/legacy-base-configuration.d.ts`).
    A plain object is merged with the defaults (`Content-Type: application/json`,
    `User-Agent: OTel-OTLP-Exporter-JavaScript/...`) and the fetch transport calls
    `await this._parameters.headers()` on every request, so `headers: { "X-Ouo-Project-Token": token }`
    is all that is needed; no transport subclassing. The factory form exists for rotating
    tokens and must not throw. We pass the same object to both exporters
    (`src/ingest.ts` `projectTokenHeaders`).
15. **URL derivation lives in one pure function**: `deriveIngestUrls({ endpoint, projectToken,
    otlpEndpoint })` returns `{ endpoint, otlpBase, traces, logs, replay, otlpBypass }` and
    throws on an empty token or endpoint. `initRUM` calls it first, before creating any
    provider, so a misconfigured app throws synchronously with nothing installed (test:
    `addEventListener` never called, `ouo.session` never written). The exporters get
    `url: urls.traces` (a full URL, which the base config takes verbatim; the
    `signalResourcePath` default only applies when `url` is absent).
16. **CORS consequences**: `Content-Type: application/json` already made every OTLP export
    a preflighted request, and the replay upload already carried `x-ouo-session-id` /
    `x-ouo-seq`, so adding `X-Ouo-Project-Token` adds no new preflight, only a new name in
    `Access-Control-Allow-Headers`. rum-api must list it (and `Content-Encoding`,
    `traceparent`, `baggage`, the replay headers); a preflight carries no token, so rum-api
    answers it for any origin some project allows (ADR-0007 section 5). A wrong token is a
    plain `401` on the POST, visible in the network tab; a missing header name in the
    preflight answer shows up as a CORS error with no POST at all. `Access-Control-Max-Age`
    on rum-api matters for the `pagehide` upload: `fetch(..., { keepalive: true })` with
    custom headers still needs a preflight, and the cached one is what lets the unload
    request go out without waiting on a round trip.
17. **Keepalive with a custom header**: the uploader uses one function for both paths; on
    `pagehide` it skips gzip (async) but keeps the same `headers` object, so the token is on
    the keepalive request too (`test/uploader.test.ts` asserts it). The OTel fetch transport
    sets `keepalive` itself under the 60 KB / 9 in-flight budget and sends the configured
    headers either way.
18. **Ignore lists after the change**: `endpoint` is now the rum-api origin, which an app
    could legitimately call (for example a support page reading its own session). The
    built-in `ignoreUrls` therefore match `^${otlpBase}/` and `^${endpoint}/v1/replay/`
    rather than the whole origin. The exporters and the uploader still go through
    `fetch.__original`, so the ignore list is a second line of defence for XHR or other
    fetch wrappers.
19. **Testing the transport without rum-api**: in the Vitest jsdom environment
    `globalThis.fetch` is Node's undici fetch (jsdom 30 has none), and it accepts
    `mode: "cors"` and `keepalive: true` without complaint, so a `node:http` server on
    `127.0.0.1:18081` can stand in for rum-api (`test/ingest-stub-server.test.ts`): the
    exporters, the fetch instrumentation (`traceparent` on the app request) and the gzip
    replay upload all arrive on a real socket with the token header, in about 1 s. No
    `Origin` header is sent by undici, which matches the ADR's "requests without Origin
    pass the origin check" path, not the browser path; browser CORS still needs the live
    check. The playground stub (`playground/server.mjs`) also accepts
    `/ingest/otlp/v1/*` and returns `401` without the token, for a manual browser run.
20. **Bundle impact**: 39.0 KB -> 39.7 KB gzip for `dist/index.js`; rrweb chunk unchanged.

## What works (summary)

- `initRUM()` (`sdk/browser/src/index.ts`): LoggerProvider + BatchLogRecordProcessor
  (1 s, 64 per batch) and WebTracerProvider + BatchSpanProcessor (2 s, 64 per batch), both
  auto-flush on `visibilitychange: hidden` / `pagehide`; `rum.flush()` forces both plus the
  replay chunker. Since 0.2.0 both exporters post to rum-api `/ingest/otlp/v1/*` with
  `X-Ouo-Project-Token`; replay to `/v1/replay/chunks` on the same host.
- Session manager (`src/session/manager.ts`): pure, injectable clock and storage, covers
  spec cases 1 to 4 and 7, cross-tab sync through the `storage` event, replay seq and
  sampling persisted with the session.
- Verified end to end (see `agents/sdk-browser/summaries/2026-10-06-phase-2.md`): Tempo
  search `{ span.session.id = "<id>" }` returns the browser traces with demo-backend child
  spans; Loki `{service_name="web-store"} | session_id="<id>"` returns `session.start`,
  `navigation`, `exception` (fatal true and false), `http.request.failed`, `web_vital`,
  custom events, all with `session_id` structured metadata.
- Bundle (0.2.0): `dist/index.js` 132 KB raw / 39.7 KB gzip; rrweb in a lazily imported
  chunk 257 KB raw / 80 KB gzip.

## Gotchas

- Always pass `start`/`end` to Tempo search; traces are searchable ~10 s after export.
- `instrumentation-document-load` emits `documentLoad` plus resource fetch spans at `load`;
  with `ignoreNetworkEvents`/`ignorePerformancePaintEvents` it stays small.
- `history.pushState` is patched for navigation events; React Router's navigations go
  through it so nothing router-specific is needed.
- Resource load errors (`<img>`, `<script>`) only reach a capture-phase `error` listener on
  `window`; they are reported non-fatal with `ouo.exception.kind=resource`.
- Never ask the session manager for the *active* id from inside the log pipeline for a
  record that already names its session. `session.id()` is lazy (`ensure()` creates a
  session when none is active), and `session.end` is emitted at exactly the moment there is
  no active session, so a processor that calls `session.id()` for every record starts a
  session as a side effect of exporting `session.end`; the caller then creates another one
  and you get two `session.start` records per rotation (QA phase 6 bug 1). Rules now in
  place: `SessionLogProcessor` fills only user/platform/version fields for records carrying
  `session.id` (reads `peek()`, never `ensure()`), and `SessionManager.rotate()` installs
  the replacement record before emitting either event so a re-entrant `ensure()` returns
  it. Regression tests: `sdk/browser/test/rotation.test.ts` (and the mobile counterpart).
- To reproduce an expiry rotation in the demo by hand, write the aged `ouo.session` record
  from a `pagehide` listener registered after the SDK's: the SDK re-persists the in-memory
  record on `pagehide`, which overwrites a plain devtools edit before the reload.
