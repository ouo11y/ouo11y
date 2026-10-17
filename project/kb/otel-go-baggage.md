# OTel Go: baggage to span attributes, otelslog bridge, otelhttp routing

Question: how does the Go demo backend copy `session.id` from W3C Baggage onto
its spans and logs, and what quirks did the OTel Go SDK (otel v1.47, contrib
otelhttp v0.72, otelslog v0.21, sdk/log v1.47, otlploghttp v0.23) show?
Code: `examples/backend/internal/telemetry`, `examples/backend/internal/api`.

## Baggage -> span attributes

- `otelhttp.NewHandler` extracts the propagators (`TraceContext` + `Baggage`
  composite) into the request context *before* starting the server span, so a
  `SpanProcessor.OnStart(ctx, span)` sees `baggage.FromContext(ctx)` populated.
  The processor copies `session.id`, `user.id`, `ouo.platform` with
  `span.SetAttributes`. Child spans started from the same context get the same
  attributes because baggage stays in the context.
- The processor must be registered on the `TracerProvider` via
  `sdktrace.WithSpanProcessor`; order relative to the batcher does not matter
  for OnStart.
- Verified in Tempo: TraceQL `{ span.session.id = "test-session" }` matches the
  server span and every child span of the backend.
- Baggage members are opaque strings; a malformed `baggage` header makes the
  propagator drop the whole header silently (no error, no attributes).

## otelhttp and Go 1.22+ `ServeMux` patterns

- otelhttp v0.72 reads `http.Request.Pattern` after the wrapped handler returns
  and renames the server span to `{METHOD} {route}` (for example
  `GET /api/products/{id}`) on its own. Do not install a custom
  `WithSpanNameFormatter` that uses `r.URL.Path`: it overrides this and you get
  high-cardinality span names.
- It does *not* set the `http.route` span attribute (span attributes are
  computed before routing, when `Pattern` is still empty; only the metrics get
  the route). Set `semconv.HTTPRoute(route)` yourself in a per-route middleware.
- `otelhttp.WithFilter` is the cheap way to keep `/healthz` out of Tempo; the
  distroless image's HEALTHCHECK polls it every 10 s.
- Semconv: otelhttp v0.72 emits the stable HTTP conventions
  (`http.request.method`, `http.response.status_code`, `url.path`,
  `server.address`); no `OTEL_SEMCONV_STABILITY_OPT_IN` needed.

## Logs: slog -> OTLP via otelslog

- `sdklog.NewLoggerProvider(WithProcessor(NewBatchProcessor(otlploghttp.New(ctx))))`
  then `otelslog.NewHandler(name, otelslog.WithLoggerProvider(lp))`. Wrap it in
  `slog.NewMultiHandler` (Go 1.26) with a text handler so stdout still shows
  logs.
- Trace and span ids are attached only when the record carries the request
  context: use `slog.InfoContext(ctx, ...)`, never `slog.Info(...)`. Loki
  then exposes `trace_id` / `span_id` as structured metadata.
- slog attributes become log record attributes; with the collector's Loki
  exporter they land as structured metadata (`session_id`, `user_id`, dots
  replaced by underscores), so `{service_name="demo-backend"} | session_id="x"`
  works without any label cardinality.
- When the collector is down the OTLP exporters retry with backoff and then
  drop the batch, logging `traces export: ...` errors to stderr via the global
  error handler. The API keeps serving; startup never blocks on the collector.

## Metrics naming in Mimir

- The collector's `otlphttp` exporter into Mimir's OTLP endpoint keeps OTLP
  names: counters arrive as `ouo_demo_requests` (no `_total`), histograms as
  `http_server_request_duration_{bucket,count,sum}` with no unit suffix.
  Resource attributes are not labels; `job` is `service.name`. Query with
  `X-Scope-OrgID: anonymous` on `localhost:9009/prometheus/api/v1/query`.

## Resource

- `resource.New(ctx, WithFromEnv(), WithTelemetrySDK(), WithAttributes(...))`
  returns `resource.ErrSchemaURLConflict` when the semconv package version
  differs from the SDK's default resource schema. The resource is still valid;
  ignore that specific error (`errors.Is`) instead of failing startup.

## Tempo search gotcha

- `GET /api/search?tags=...` or `?q=...` without `start`/`end` only searches a
  very short recent window and returned 0 traces for data that was 30 s old.
  Always pass `start`/`end` (unix seconds). Traces become searchable roughly
  10 to 60 s after ingestion (trace idle period plus block cut); fetching by id
  (`/api/traces/<id>`) works almost immediately.

## Local port conflicts on the dev machine

- The machine already runs unrelated stacks on 4317/4318 (`otel-downstream`),
  3200 (`otel-browser-tempo-1`) and 3100 (`otel-browser-loki-1`). The ouo stack
  therefore maps to 4328 (OTLP/HTTP), 3201 (Tempo), 3101 (Loki), 3001
  (Grafana) via `deploy/compose/.env`. Pointing the backend at 4318 silently
  sends telemetry to the wrong collector.
