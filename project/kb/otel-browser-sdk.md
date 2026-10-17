# otel browser sdk

Status: filled in Phase 2 by sdk-browser (2026-10-06), project-credentials section added in Phase 8a (2026-10-10, revised the same day when ADR-0007 made the collector the edge). Code: `sdk/browser`.

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

## Project credentials on the collector (Phase 8a, SDK 0.2.0, ADR-0007)

14. **Headers on the OTLP exporters**: `OTLPTraceExporter` / `OTLPLogExporter` (0.222)
    take `headers?: Record<string, string> | (() => Promise<Record<string,string>>)` in
    their config (`OTLPExporterConfigBase`, `otlp-exporter-base/configuration/legacy-base-configuration.d.ts`).
    A plain object is merged with the defaults (`Content-Type: application/json`,
    `User-Agent: OTel-OTLP-Exporter-JavaScript/...`) and the fetch transport calls
    `await this._parameters.headers()` on every request, so
    `headers: { Authorization: "Basic <base64>" }` is all that is needed; no transport
    subclassing. The factory form exists for rotating tokens and must not throw. We pass the
    same object to both exporters (`src/ingest.ts` `ingestHeaders`). This is exactly what a
    stock SDK does with `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64>`, so the
    collector's `basicauth` extension sees no difference between ouo and a plain OTel app.
15. **The Basic credential**: `basicAuthorization(projectId, projectToken)` returns
    `Basic base64(id + ":" + token)`. `btoa` throws on code points above U+00FF and encodes
    U+0080..U+00FF as single Latin-1 bytes, while `basicauth` (and RFC 7617 with
    `charset="UTF-8"`) decodes UTF-8, so the SDK base64-encodes the UTF-8 bytes
    (`TextEncoder` + `btoa` of a binary string, `Buffer` fallback where `btoa` is absent).
    Ids and tokens are ASCII in practice; the test covers `ö` and `€` anyway. A `:` in the
    id is rejected because the server splits at the first colon. Both parts are trimmed.
16. **URL derivation lives in one pure function**: `deriveIngestUrls({ endpoint,
    replayEndpoint, projectId, projectToken })` returns `{ endpoint, replayEndpoint, traces,
    logs, replay }` and throws on an empty endpoint, id or token. The replay default is
    `deriveReplayEndpoint(endpoint)`: `new URL(endpoint)`, and when `port === "4318"` set
    `port = "4319"` (scheme, host and path preserved, so `https://h:4318/base` gives
    `https://h:4319/base/v1/replay/chunks`); any other port, including none (a proxy that
    routes `/v1/replay/*` itself, ADR section 7), returns `endpoint`. `initRUM` calls it
    first, before creating any provider, so a misconfigured app throws synchronously with
    nothing installed (test: `addEventListener` never called, `ouo.session` never written).
    The exporters get `url: urls.traces` (a full URL, which the base config takes verbatim;
    the `signalResourcePath` default only applies when `url` is absent).
17. **CORS with `Authorization`**: `Content-Type: application/json` already made every OTLP
    export a preflighted request, and the replay upload already carried `x-ouo-session-id` /
    `x-ouo-seq`, so `Authorization` adds no new preflight, only a name the collector must
    list in `Access-Control-Allow-Headers` (`confighttp` `cors.allowed_headers`; the
    defaults only cover `Content-Type` and friends). A manually set `Authorization` request
    header is **not** a CORS credential: the SDK never sets `credentials: "include"`, so
    `Access-Control-Allow-Origin: *` still works and no `Access-Control-Allow-Credentials`
    is needed. A preflight carries no credential, so `basicauth` must not run on `OPTIONS`
    (confighttp handles CORS before the authenticator). Failure signatures in the network
    tab: wrong id/token = `OPTIONS 204` then `POST 401`; origin not allowed or header not
    listed = `OPTIONS` without the matching `Access-Control-Allow-*` and no `POST` at all,
    plus a console CORS error. `Access-Control-Max-Age` on the collector matters for the
    `pagehide` upload: `fetch(..., { keepalive: true })` with custom headers still needs a
    preflight, and the cached one is what lets the unload request go out without waiting on
    a round trip. Both receivers (OTLP on 4318, replay on 4319) are separate origins to the
    browser, so each one is preflighted and each one needs the same CORS settings; behind a
    proxy that serves both on one host there is one origin and one preflight per path.
18. **Keepalive with a custom header**: the uploader uses one function for both paths; on
    `pagehide` it skips gzip (async) but keeps the same `headers` object, so the credential
    is on the keepalive request too (`test/uploader.test.ts` asserts it). The OTel fetch
    transport sets `keepalive` itself under the 60 KB / 9 in-flight budget and sends the
    configured headers either way.
19. **Ignore lists after the change**: the built-in `ignoreUrls` match `^${endpoint}/v1/`
    and `^${replayEndpoint}/v1/replay/`. The exporters and the uploader still go through
    `fetch.__original`, so the ignore list is a second line of defence for XHR or other
    fetch wrappers.
20. **Testing the transport without the collector**: in the Vitest jsdom environment
    `globalThis.fetch` is Node's undici fetch (jsdom 30 has none), and it accepts
    `mode: "cors"` and `keepalive: true` without complaint, so two `node:http` servers on
    `127.0.0.1:18081` (OTLP) and `:18082` (replay, via an explicit `replayEndpoint` because
    4318/4319 are taken by the running stack) stand in for `ouo-collector`
    (`test/ingest-stub-server.test.ts`): the exporters, the fetch instrumentation
    (`traceparent` on the app request, no `Authorization` there) and the gzip replay upload
    all arrive on real sockets with the Basic header, answering `401` otherwise, in about
    1 s. No `Origin` header is sent by undici, so browser CORS still needs the live check.
    The playground stub (`playground/server.mjs`, `:8090`) serves OTLP and replay on one
    port, which exercises the "replay shares the endpoint" default.
21. **Bundle impact**: 39.0 KB (0.1.0) -> 40.1 KB gzip for `dist/index.js`; rrweb chunk
    unchanged.

## What works (summary)

- `initRUM()` (`sdk/browser/src/index.ts`): LoggerProvider + BatchLogRecordProcessor
  (1 s, 64 per batch) and WebTracerProvider + BatchSpanProcessor (2 s, 64 per batch), both
  auto-flush on `visibilitychange: hidden` / `pagehide`; `rum.flush()` forces both plus the
  replay chunker. Since 0.2.0 both exporters post to the collector `/v1/{traces,logs}` with
  `Authorization: Basic base64(projectId:projectToken)`; replay to the collector's replay
  receiver `/v1/replay/chunks` (port 4319 by default) with the same header.
- Session manager (`src/session/manager.ts`): pure, injectable clock and storage, covers
  spec cases 1 to 4 and 7, cross-tab sync through the `storage` event, replay seq and
  sampling persisted with the session.
- Verified end to end (see `agents/sdk-browser/summaries/2026-10-06-phase-2.md`): Tempo
  search `{ span.session.id = "<id>" }` returns the browser traces with demo-backend child
  spans; Loki `{service_name="web-store"} | session_id="<id>"` returns `session.start`,
  `navigation`, `exception` (fatal true and false), `http.request.failed`, `web_vital`,
  custom events, all with `session_id` structured metadata.
- Bundle (0.2.0): `dist/index.js` 133 KB raw / 40.1 KB gzip; rrweb in a lazily imported
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
