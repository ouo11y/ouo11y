# OpenTelemetry JS 3.0 in a Node backend, and `propagateTo` (tiny-shop, 2026-10-23)

Question: what does a plain Node / Express backend need to send traces to ouo and join the
browser's trace, with the OpenTelemetry JS release current in October 2026?

Reference code: `examples/quickstarts/tiny-shop/result/backend` (`instrumentation.js`, `server.js`).

## Versions that work together

`@opentelemetry/sdk-node` 0.300.0, `sdk-trace` 3.0.0, `resources` 3.0.0, `api` 1.10.0,
`exporter-trace-otlp-http` 0.300.0, `instrumentation-http` 0.300.0, `instrumentation-express`
0.72.0, `baggage-span-processor` 0.6.0, `semantic-conventions` 1.43.0, on Node 24, express 5.3.

## 3.0 breaking changes that bite copy-pasted 2.x snippets

- `@opentelemetry/sdk-trace-base` is replaced by `@opentelemetry/sdk-trace` (3.0.0). Installing
  `sdk-trace-base` 2.x next to `api` 1.10 fails with `ERESOLVE` (peer `api <1.10.0`).
- `sdk-node` no longer re-exports `tracing` (`require("@opentelemetry/sdk-node").tracing` is
  `undefined`; its exports are `NodeSDK` and `startNodeSDK`).
- `new BatchSpanProcessor(exporter)` constructs fine and crashes at the first export
  (`Cannot read properties of undefined (reading 'export')`): 3.0 takes an options object,
  `new BatchSpanProcessor({ exporter })`.
- `resourceFromAttributes` (not `new Resource`) builds the resource.

## Wiring for ouo

- Load the SDK before the app: `node --require ./instrumentation.js server.js` with a CommonJS
  package. The http / express instrumentations patch modules at `require` time; ESM would need the
  loader hook instead.
- The exporter needs the project credential like every OTLP client:
  `headers: { Authorization: "Basic " + base64("<project id>:<project token>") }`, else 401.
- `NodeSDK` already uses W3C trace context + baggage propagators, so the browser's `traceparent`
  continues the trace. `BaggageSpanProcessor(ALLOW_ALL_BAGGAGE_KEYS)` (contrib) copies the baggage
  `session.id`, `user.id`, `ouo.platform` onto every span: backend spans become searchable by RUM
  session (same idea as the Go backend, [otel-go-baggage.md](otel-go-baggage.md)). Put it before the
  batch processor in `spanProcessors`; with `spanProcessors` set, `traceExporter` is ignored.
- Cross-origin API: the browser adds `traceparent` and `baggage`, so the API must answer the
  preflight (`cors()` reflects the requested headers).

## `propagateTo`: strings must equal the whole URL

`@ouo11y/browser` passes `tracing.propagateTo` to the fetch / XHR instrumentations as
`propagateTraceHeaderCorsUrls`. `@opentelemetry/core` `urlMatches` compares a string with `===`
against the full request URL, so `"http://localhost:5001"` matches none of
`http://localhost:5001/api/...`: no `traceparent`, no preflight, and the backend starts its own
root trace. Seen in tiny-shop: the backend trace's root was `POST /api/checkout`. Use a RegExp
(`new RegExp(\`^${API}/\`)`); the tell that it works is an `OPTIONS` preflight before each API
call. `sdk/browser/README.md` said "Origins (RegExp or exact string)" and was corrected.

## Timing

Tempo search found the new trace 10 to 15 s after the click (trace by id is faster); Loki events
and the rum-api session showed up within a few seconds.
