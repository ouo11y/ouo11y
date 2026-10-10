# 10. Instrument your Go backend

Goal: your Go HTTP service exports traces, logs and metrics to the collector from
`00-stack.md`, joins the trace the browser or mobile SDK started, and carries the
user's `session.id` on every server span and log record so that one TraceQL query
(`{ span.session.id = "..." }`) returns the whole backend side of a session.

The reference implementation is `examples/backend` in this repo (about 700 lines of
Go, `net/http` only). This page tells you which lines to copy and which of your own
lines to swap. Sections marked

> **Important: we do this ourselves.**

are code you hand-write or copy into your project. Nothing is auto-instrumented.

Requirements: Go 1.26 (the reference uses `slog.NewMultiHandler`, Go 1.26, and
`strings.SplitSeq`, Go 1.24; on an older Go you replace those two calls).

## (a) Packages to install

Run each line in your module. Versions are the ones pinned in
`examples/backend/go.mod` and known to work together; drop the `@version` to take
the latest if you prefer.

```bash
go get go.opentelemetry.io/otel@v1.47.0
```
API root: `otel.SetTracerProvider`, `otel.GetTextMapPropagator`, `attribute`,
`codes`, `propagation`, `baggage` and the `semconv/v1.37.0` constants all live here.

```bash
go get go.opentelemetry.io/otel/trace@v1.47.0
```
Trace API: `trace.Tracer`, `trace.SpanFromContext`, `trace.WithSpanKind`.

```bash
go get go.opentelemetry.io/otel/metric@v1.47.0
```
Metric API: `metric.Int64Counter`, `metric.Float64Histogram`, `metric.WithAttributes`.

```bash
go get go.opentelemetry.io/otel/log@v1.47.0
```
Log API plus `log/global.SetLoggerProvider`, which the slog bridge reads.

```bash
go get go.opentelemetry.io/otel/sdk@v1.47.0
```
Trace SDK (`sdk/trace`: `NewTracerProvider`, `SpanProcessor`, `WithBatcher`) and
`sdk/resource` (`service.name` and friends).

```bash
go get go.opentelemetry.io/otel/sdk/metric@v1.47.0
```
Metric SDK: `NewMeterProvider`, `NewPeriodicReader`.

```bash
go get go.opentelemetry.io/otel/sdk/log@v1.47.0
```
Log SDK: `NewLoggerProvider`, `NewBatchProcessor`.

```bash
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp@v1.47.0
```
OTLP/HTTP trace exporter. Reads `OTEL_EXPORTER_OTLP_ENDPOINT` on its own.

```bash
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp@v1.47.0
```
OTLP/HTTP metric exporter.

```bash
go get go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp@v0.23.0
```
OTLP/HTTP log exporter (still a 0.x module, hence the different version).

```bash
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.72.0
```
`otelhttp.NewHandler` (server span per request, extracts `traceparent` and
`baggage`) and `otelhttp.NewTransport` (client span per outgoing request, injects
them). Also emits `http.server.request.duration`.

```bash
go get go.opentelemetry.io/contrib/bridges/otelslog@v0.21.0
```
`otelslog.NewHandler`: turns `log/slog` records into OTLP log records with trace and
span ids attached.

Then:

```bash
go mod tidy
```

No gRPC exporter is needed; everything goes over OTLP/HTTP (`http/protobuf`) to
port 4318. Since ADR-0007 that port is published on `127.0.0.1` of the stack host only:
your backend on the same machine (or inside the compose network as
`otel-collector:4318`) reaches it, browsers and phones do not. They post to rum-api on
port 8080 with a project token, and so can a backend that runs somewhere else (below).

```
your backend (same host) --OTLP--> 127.0.0.1:4318 ──> otel-collector ──> tempo / loki / mimir
your backend (elsewhere) --OTLP + X-Ouo-Project-Token--> rum-api :8080 ──^
browser / mobile SDK     --OTLP + X-Ouo-Project-Token--> rum-api :8080 ──^
```

## (b) Environment variables the SDK reads

The exporters and `resource.WithFromEnv()` read these; your code never parses them.

| Variable | Local value, binary on the host | Value inside compose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` (or your `OUO_OTLP_HTTP_PORT`) | `http://otel-collector:4318` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | `http/protobuf` |
| `OTEL_SERVICE_NAME` | your service name, for example `orders-api` | same |
| `OTEL_RESOURCE_ATTRIBUTES` | `deployment.environment.name=local` | `deployment.environment.name=local` |

The exporters append `/v1/traces`, `/v1/logs` and `/v1/metrics` to the endpoint
themselves. `OTEL_EXPORTER_OTLP_PROTOCOL` is informational here: only the HTTP
exporters are compiled in, so there is no gRPC fallback to pick. Without a
reachable collector the exporters retry, log `traces export: ...` errors and drop
the batch; the API keeps serving and startup never blocks.

Backend on a different machine than the stack (or against a `deploy/vm` install): the
collector is not reachable, so go through the gateway with two standard variables and
no code change. rum-api checks the token, stamps `ouo.project.id` and forwards:

| Variable | Value |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `https://rum.example.com/ingest/otlp` (local stack: `http://localhost:8080/ingest/otlp`) |
| `OTEL_EXPORTER_OTLP_HEADERS` | `X-Ouo-Project-Token=pt_dev_demo_0000000000000000` (the token from `deploy/docker/.env`) |

The exporters append `/v1/traces` and friends to that base, which is exactly what
rum-api serves. Server-side requests carry no `Origin`, so the origin allowlist does not
apply to them; the project rate and size limits do.

`service.name` is what you filter on everywhere (`{service_name="orders-api"}` in
Loki, `resource.service.name` in Tempo, `job` in Mimir). Pick it once.

## (c) SDK init: `internal/telemetry/telemetry.go`

> **Important: we do this ourselves.**

Copy `examples/backend/internal/telemetry/telemetry.go` as is into
`internal/telemetry/telemetry.go` of your module. Change the three constants
(`DefaultServiceName`, `ServiceVersion`, `Environment`) and nothing else.

```go
// Package telemetry wires the OpenTelemetry Go SDK for the demo backend:
// traces, logs and metrics over OTLP/HTTP, W3C TraceContext + Baggage
// propagation, and a span processor that copies session.id from baggage
// onto every span.
package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"time"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
)

const (
	DefaultServiceName = "demo-backend"
	ServiceVersion     = "0.1.0"
	Environment        = "local"
)

// Setup installs global tracer, meter and logger providers plus the
// composite TraceContext+Baggage propagator, and makes slog's default logger
// fan out to stdout and to the OTel log bridge. The returned function flushes
// and shuts everything down.
func Setup(ctx context.Context) (shutdown func(context.Context) error, err error) {
	var shutdowns []func(context.Context) error
	shutdown = func(ctx context.Context) error {
		var errs error
		for i := len(shutdowns) - 1; i >= 0; i-- {
			errs = errors.Join(errs, shutdowns[i](ctx))
		}
		return errs
	}
	fail := func(e error) (func(context.Context) error, error) {
		_ = shutdown(ctx)
		return nil, e
	}

	res, err := newResource(ctx)
	if err != nil {
		return fail(err)
	}

	otel.SetTextMapPropagator(NewPropagator())

	// Traces.
	traceExp, err := otlptracehttp.New(ctx)
	if err != nil {
		return fail(err)
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithSpanProcessor(NewBaggageSpanProcessor()),
		sdktrace.WithBatcher(traceExp),
	)
	shutdowns = append(shutdowns, tp.Shutdown)
	otel.SetTracerProvider(tp)

	// Metrics.
	metricExp, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return fail(err)
	}
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp, sdkmetric.WithInterval(15*time.Second))),
	)
	shutdowns = append(shutdowns, mp.Shutdown)
	otel.SetMeterProvider(mp)

	// Logs.
	logExp, err := otlploghttp.New(ctx)
	if err != nil {
		return fail(err)
	}
	lp := sdklog.NewLoggerProvider(
		sdklog.WithResource(res),
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExp)),
	)
	shutdowns = append(shutdowns, lp.Shutdown)
	global.SetLoggerProvider(lp)

	slog.SetDefault(slog.New(slog.NewMultiHandler(
		slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}),
		otelslog.NewHandler(DefaultServiceName, otelslog.WithLoggerProvider(lp)),
	)))

	return shutdown, nil
}

// NewPropagator returns the composite W3C TraceContext + Baggage propagator
// used by both the server and the tests.
func NewPropagator() propagation.TextMapPropagator {
	return propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	)
}

// ServiceName is OTEL_SERVICE_NAME or DefaultServiceName.
func ServiceName() string {
	if v := os.Getenv("OTEL_SERVICE_NAME"); v != "" {
		return v
	}
	return DefaultServiceName
}

func newResource(ctx context.Context) (*resource.Resource, error) {
	res, err := resource.New(ctx,
		resource.WithFromEnv(), // OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME
		resource.WithTelemetrySDK(),
		resource.WithAttributes(
			semconv.ServiceName(ServiceName()),
			semconv.ServiceVersion(ServiceVersion),
			semconv.DeploymentEnvironmentName(Environment),
		),
	)
	// A schema-URL conflict is not fatal: the merged resource is still usable.
	if err != nil && !errors.Is(err, resource.ErrSchemaURLConflict) {
		return nil, err
	}
	return res, nil
}
```

What each block does and why it is there:

- `newResource`: `resource.WithFromEnv()` merges `OTEL_RESOURCE_ATTRIBUTES` and
  `OTEL_SERVICE_NAME`, `WithTelemetrySDK()` adds `telemetry.sdk.*`, and
  `WithAttributes` pins `service.name`, `service.version`,
  `deployment.environment.name`. The `resource.ErrSchemaURLConflict` check is not
  cosmetic: when the semconv package version differs from the SDK's default schema,
  `resource.New` returns that error together with a perfectly usable resource. Fail on
  any other error, ignore that one.
- `otel.SetTextMapPropagator(NewPropagator())`: the composite W3C `TraceContext` +
  `Baggage` propagator. TraceContext joins the browser's trace (`traceparent`),
  Baggage carries `session.id`. Register it globally before building the HTTP
  handler because `otelhttp.NewHandler` captures `otel.GetTextMapPropagator()` at
  construction time.
- Traces: `otlptracehttp.New(ctx)` builds the exporter from the env vars.
  `sdktrace.NewTracerProvider` gets the resource, the `BaggageSpanProcessor` from
  section (d) and a `WithBatcher` for the exporter. Processor order does not matter
  for `OnStart`.
- Metrics: a `PeriodicReader` pushes every 15 s to the collector.
- Logs: `sdklog.NewLoggerProvider` with a `BatchProcessor` around `otlploghttp`,
  registered with `global.SetLoggerProvider` so any bridge finds it.
- `slog.SetDefault(... NewMultiHandler(text to stdout, otelslog.NewHandler(...)))`:
  every `slog` call now goes to stdout **and** to the collector as an OTLP log record.
  Everything you already log with `slog` becomes a Loki line with `service_name`,
  and, when you pass a context, `trace_id` and `span_id`.
- `shutdown`: runs the provider shutdowns in reverse order and joins the errors.
  Call it with a 5 s timeout on exit so the last batch is flushed (see `main.go` in
  the walkthrough). Without it you lose the spans of the final requests.

## (d) The baggage span processor: `internal/telemetry/baggage.go`

> **Important: we do this ourselves. This is THE correlation mechanism.**

Copy `examples/backend/internal/telemetry/baggage.go` as is, next to `telemetry.go`.
Nothing to change.

```go
package telemetry

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// BaggageKeys lists the W3C Baggage members that the ouo SDKs propagate and
// that must be copied onto every backend span so that Tempo can find backend
// spans by session (ADR-0001, "Correlation").
var BaggageKeys = []string{"session.id", "user.id", "ouo.platform"}

// BaggageSpanProcessor copies selected baggage members from the span's start
// context onto the span as attributes. It is a no-op for every other
// SpanProcessor hook.
type BaggageSpanProcessor struct {
	keys []string
}

var _ sdktrace.SpanProcessor = (*BaggageSpanProcessor)(nil)

// NewBaggageSpanProcessor returns a processor that copies the given baggage
// keys (defaults to BaggageKeys) onto spans.
func NewBaggageSpanProcessor(keys ...string) *BaggageSpanProcessor {
	if len(keys) == 0 {
		keys = BaggageKeys
	}
	return &BaggageSpanProcessor{keys: keys}
}

// OnStart implements sdktrace.SpanProcessor.
func (p *BaggageSpanProcessor) OnStart(ctx context.Context, span sdktrace.ReadWriteSpan) {
	span.SetAttributes(AttributesFromBaggage(ctx, p.keys...)...)
}

// OnEnd implements sdktrace.SpanProcessor.
func (p *BaggageSpanProcessor) OnEnd(sdktrace.ReadOnlySpan) {}

// Shutdown implements sdktrace.SpanProcessor.
func (p *BaggageSpanProcessor) Shutdown(context.Context) error { return nil }

// ForceFlush implements sdktrace.SpanProcessor.
func (p *BaggageSpanProcessor) ForceFlush(context.Context) error { return nil }

// AttributesFromBaggage returns one attribute per requested key that is
// present (and non-empty) in the baggage carried by ctx. Handlers use the
// same helper to put session.id on log records.
func AttributesFromBaggage(ctx context.Context, keys ...string) []attribute.KeyValue {
	if len(keys) == 0 {
		keys = BaggageKeys
	}
	bag := baggage.FromContext(ctx)
	if bag.Len() == 0 {
		return nil
	}
	attrs := make([]attribute.KeyValue, 0, len(keys))
	for _, k := range keys {
		if v := bag.Member(k).Value(); v != "" {
			attrs = append(attrs, attribute.String(k, v))
		}
	}
	return attrs
}

// BaggageValue returns the value of a single baggage member, or "" if absent.
func BaggageValue(ctx context.Context, key string) string {
	return baggage.FromContext(ctx).Member(key).Value()
}
```

How the ids get from the client to your spans:

1. The ouo browser SDK (`sdk/browser/src/telemetry/propagator.ts`) and the React
   Native SDK inject two headers on every outbound `fetch` / XHR to an origin listed
   in their `propagateTo` option: `traceparent` (W3C TraceContext) and `baggage`
   (W3C Baggage) with exactly three members: `session.id`, `user.id`, `ouo.platform`
   (`web` or `mobile`). A real request looks like

   ```
   traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
   baggage: session.id=a4d47dfa-...,user.id=3c63803d-...,ouo.platform=web
   ```

2. `otelhttp.NewHandler` runs the propagator's `Extract` on the incoming headers
   **before** it starts the server span, so the request context already holds the
   remote span context and the baggage.
3. `BaggageSpanProcessor.OnStart(ctx, span)` fires for the server span and for every
   child span you start from that context. It reads `baggage.FromContext(ctx)` and
   calls `span.SetAttributes` with `session.id`, `user.id`, `ouo.platform`. Baggage
   stays in the context, so children get the same attributes with no extra code.
4. Tempo indexes span attributes, so `{ span.session.id = "a4d47dfa-..." }` matches
   the browser span, your server span and all its children in one search. rum-api
   runs exactly that query (plus `&& status = error`) to list the traces of a session
   and to compute `has_error`.
5. Log records do not go through span processors. `AttributesFromBaggage` is the
   same helper reused by the handlers (`identityLogAttrs` below) to put the three
   keys on every `slog` record, so Loki can filter `| session_id="..."` too.

Why baggage and not a custom header: it is the standard mechanism, the OTel JS and
Go propagators already implement it, and it survives hops through any other
OTel-instrumented service in between. Why span attributes and not resource
attributes: a resource describes the process, a session rotates while the process
lives (ADR-0002).

Gotcha: a malformed `baggage` header makes the Go propagator drop the whole header
silently. No error, no attributes. If `session.id` is missing in Tempo, look at the
raw header first.

## (e) Swap list: what to replace in your own code

Each row: in which file, what you have today, what it becomes, and why.

### 1. Server handler: wrap the mux with `otelhttp.NewHandler`

File: wherever you build your `http.Server` (your `main.go` or router package).

Replace

```go
srv := &http.Server{Addr: ":8081", Handler: mux}
```

with

```go
srv := &http.Server{Addr: ":8081", Handler: otelhttp.NewHandler(mux, "http.server",
	otelhttp.WithTracerProvider(otel.GetTracerProvider()),
	otelhttp.WithPropagators(otel.GetTextMapPropagator()),
	otelhttp.WithFilter(func(r *http.Request) bool { return r.URL.Path != "/healthz" }),
)}
```

Why: this one wrapper gives you a server span per request, extraction of
`traceparent` and `baggage`, the `http.request.method`, `http.response.status_code`,
`url.path`, `server.address` attributes, and the `http.server.request.duration`
histogram. `WithFilter` keeps the health probe out of Tempo (the container
HEALTHCHECK polls it every 10 s). otelhttp >= 0.60 reads `http.Request.Pattern` after
the Go 1.22+ `ServeMux` matched and renames the span to `GET /api/products/{id}` on
its own, so do **not** add a `WithSpanNameFormatter` that uses `r.URL.Path`: you
would get one span name per product id.

The reference, `examples/backend/internal/api/handlers.go`, `func (s *Server) Handler()`:

```go
// Handler returns the fully wired HTTP handler: CORS -> otelhttp server span
// -> router -> per-route middleware (route naming, request log, faults).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	s.route(mux, "GET "+healthPath, s.handleHealth, false)
	s.route(mux, "GET /api/products", s.handleListProducts, true)
	s.route(mux, "GET /api/products/{id}", s.handleGetProduct, true)
	s.route(mux, "GET /api/cart", s.handleGetCart, true)
	s.route(mux, "POST /api/cart", s.handleAddToCart, true)
	s.route(mux, "POST /api/checkout", s.handleCheckout, true)

	// otelhttp (>= v0.60) reads http.Request.Pattern after the mux matched,
	// renames the server span to "{method} {route}" and sets http.route on
	// its own, so no per-route span naming is needed here.
	return CORS(otelhttp.NewHandler(mux, "http.server",
		otelhttp.WithTracerProvider(s.tp),
		otelhttp.WithPropagators(s.prop),
		// The container HEALTHCHECK polls /healthz every few seconds; keep
		// that noise out of Tempo.
		otelhttp.WithFilter(func(r *http.Request) bool { return r.URL.Path != healthPath }),
	))
}
```

### 2. `http.route` on the server span

File: the same router. otelhttp computes span attributes before the mux routes, so it
sets `http.route` on the metric but **not** on the span. Set it yourself in a tiny
per-route middleware, otherwise Grafana's service map and any `span.http.route`
query are empty.

Replace

```go
mux.HandleFunc("GET /api/products", listProducts)
```

with

```go
mux.Handle("GET /api/products", instrument("GET /api/products", http.HandlerFunc(listProducts)))
```

where `instrument` is the reference middleware below (route attribute, one request
counter, one `request` log line per request with the baggage ids). Copy it from
`examples/backend/internal/api/handlers.go`, together with `statusRecorder` at the
bottom of that file:

```go
// instrument sets http.route on the server span, counts the request and
// writes one info log line per request carrying session.id and user.id from
// baggage. (otelhttp names the span from r.Pattern after the handler returns
// but computes span attributes before routing, so http.route is set here.)
func (s *Server) instrument(pattern string, next http.Handler) http.Handler {
	method, route, _ := strings.Cut(pattern, " ")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		start := time.Now()
		trace.SpanFromContext(ctx).SetAttributes(semconv.HTTPRoute(route))

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		attrs := []attribute.KeyValue{
			semconv.HTTPRequestMethodKey.String(method),
			semconv.HTTPRoute(route),
			semconv.HTTPResponseStatusCode(rec.status),
		}
		s.requests.Add(ctx, 1, metric.WithAttributes(attrs...))
		if route == healthPath {
			return // not logged either; see WithFilter above
		}

		logAttrs := []any{
			"http.request.method", method,
			"http.route", route,
			"url.path", r.URL.Path,
			"http.response.status_code", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
		}
		if q := r.URL.RawQuery; q != "" {
			logAttrs = append(logAttrs, "url.query", q)
		}
		logAttrs = append(logAttrs, identityLogAttrs(ctx)...)
		slog.InfoContext(ctx, "request", logAttrs...)
	})
}
```

### 3. Outgoing HTTP calls: `http.DefaultClient` -> a client with `otelhttp.NewTransport`

File: wherever you create the `http.Client` you call other services with.

Replace

```go
resp, err := http.DefaultClient.Do(req)
```

with

```go
client := &http.Client{Timeout: 60 * time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)}
resp, err := client.Do(req)
```

and always build the request with the handler's context:
`req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)`.

Why: `NewTransport` opens a client span and runs the propagator's `Inject`, so
`traceparent` **and** `baggage` (with `session.id`) travel to the next service,
which, if it has the same baggage processor, lands in the same session search.
`DefaultClient` sends nothing. The demo backend has no outbound calls; the reference
is `services/rum-api/main.go` (its Loki and Tempo clients):

```go
	httpClient := &http.Client{Timeout: 60 * time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)}
```

### 4. Logging: `slog.Info` -> `slog.InfoContext(ctx, ...)` plus the baggage ids

File: every handler and every helper that logs.

Replace

```go
slog.Info("order placed", "order.id", orderID)
```

with

```go
slog.InfoContext(ctx, "order placed", append([]any{"order.id", orderID}, identityLogAttrs(ctx)...)...)
```

Why: the `otelslog` bridge only attaches `trace_id` / `span_id` when the record
carries the request context. `slog.Info` without a context produces a log line that
Loki cannot link to a trace. `identityLogAttrs` (reference below) adds `session.id`,
`user.id`, `ouo.platform` as attributes, which Loki stores as structured metadata
(`session_id`, `user_id`, dots become underscores) so
`{service_name="orders-api"} | session_id="..."` works with zero label cardinality.

```go
// identityLogAttrs returns slog attributes for every ouo baggage member
// present (session.id, user.id, ouo.platform).
func identityLogAttrs(ctx context.Context) []any {
	var out []any
	for _, kv := range telemetry.AttributesFromBaggage(ctx) {
		out = append(out, string(kv.Key), kv.Value.AsString())
	}
	return out
}
```

The `slog.SetDefault` swap itself happened in `telemetry.Setup` (section c), so the
`slog` package API stays the same everywhere else in your code.

### 5. Custom spans and attributes inside handlers

File: each handler that does something worth timing (a DB query, a payment call).

Replace a plain function call

```go
charge(ctx, amount)
```

with a child span around it

```go
tracer := otel.Tracer("github.com/you/your-module")
ctx, span := tracer.Start(ctx, "payment.charge", trace.WithSpanKind(trace.SpanKindClient),
	trace.WithAttributes(attribute.Float64("payment.amount", amount), attribute.String("peer.service", "payment-gateway")))
defer span.End()
if err := charge(ctx, amount); err != nil {
	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
	return err
}
```

Why: `tracer.Start(ctx, ...)` parents the span to the server span through the
context, the baggage processor stamps it with `session.id`, and `RecordError` +
`SetStatus(codes.Error, ...)` are what make the trace show as failed in Tempo
(`status = error`) and the session show as errored in the plugin. Use
`trace.SpanFromContext(ctx).SetAttributes(...)` to enrich the current server span
(the reference sets `order.id` that way). Semantic convention constants
(`semconv.DBSystemNamePostgreSQL`, `semconv.DBQueryText(...)`, `semconv.HTTPRoute`)
come from `go.opentelemetry.io/otel/semconv/v1.37.0`; custom attributes are
prefixed `ouo.` in this repo, pick your own prefix.

The reference keeps one `trace.Tracer` on the server struct
(`s.tracer = tp.Tracer(instrumentationName)`) and takes it as an option so tests can
pass an in-memory provider; `otel.Tracer(name)` is the same thing without the
plumbing.

### 6. Propagators: TraceContext + Baggage

File: `internal/telemetry/telemetry.go` (already done if you copied it).

Replace nothing, but make sure you do **not** call `otel.SetTextMapPropagator` again
somewhere else with only `propagation.TraceContext{}`: that drops baggage and your
spans lose `session.id`. `NewPropagator()` returns the composite and is exported so
tests and the server use the same one.

### 7. CORS: allow `traceparent`, `tracestate`, `baggage`

File: your CORS middleware. Browsers strip any non-safelisted request header the
preflight did not allow, so if your `Access-Control-Allow-Headers` lists only
`content-type` the SDK's `traceparent` and `baggage` headers never reach you and
correlation breaks silently (the request itself still succeeds).

Replace

```go
h.Set("Access-Control-Allow-Headers", "content-type")
```

with

```go
h.Set("Access-Control-Allow-Headers", "content-type, traceparent, tracestate, baggage, x-user-id")
```

(`x-user-id` is the demo's fallback identity header; drop it if you do not use it.)
If you have no CORS middleware yet, `examples/backend/internal/api/cors.go` is
dependency-free and allows any `http://localhost:*` / `http://127.0.0.1:*` origin
plus exact origins from `CORS_ALLOWED_ORIGINS`. Copy it as is:

```go
package api

import (
	"net/http"
	"os"
	"strings"
)

// allowedHeaders must include traceparent, tracestate and baggage: browsers
// strip any non-safelisted request header the preflight did not allow, which
// would silently break trace correlation from the web demo.
const (
	allowedHeaders = "content-type, traceparent, tracestate, baggage, x-user-id"
	allowedMethods = "GET, POST, OPTIONS"
)

// CORS reflects the Origin header for any http://localhost:* or
// http://127.0.0.1:* origin plus the exact origins listed in the
// comma-separated CORS_ALLOWED_ORIGINS env var, answers preflight with 204,
// and passes everything else through untouched.
func CORS(next http.Handler) http.Handler {
	extra := extraOrigins(os.Getenv("CORS_ALLOWED_ORIGINS"))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (originAllowed(origin) || extra[origin]) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", allowedMethods)
			h.Set("Access-Control-Allow-Headers", allowedHeaders)
			h.Set("Access-Control-Max-Age", "600")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func originAllowed(origin string) bool {
	rest, ok := strings.CutPrefix(origin, "http://")
	if !ok {
		return false
	}
	host, port, _ := strings.Cut(rest, ":")
	if host != "localhost" && host != "127.0.0.1" {
		return false
	}
	if port == "" {
		return true
	}
	if strings.ContainsAny(port, "/?#@") {
		return false
	}
	for _, c := range port {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func extraOrigins(csv string) map[string]bool {
	out := map[string]bool{}
	for o := range strings.SplitSeq(csv, ",") {
		if o = strings.TrimSpace(strings.TrimSuffix(o, "/")); o != "" {
			out[o] = true
		}
	}
	return out
}
```

Order matters: `CORS(otelhttp.NewHandler(mux, ...))`, CORS on the outside, so the
`OPTIONS` preflight is answered with 204 before a span is opened.

### 8. Graceful shutdown flushes telemetry

File: your `main.go`. After `telemetry.Setup(ctx)` returns, defer the shutdown with
its own timeout, and stop the HTTP server on `SIGINT` / `SIGTERM` so the deferred
flush actually runs. The reference `run` function:

```go
func run(port string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	shutdownTelemetry, err := telemetry.Setup(ctx)
	if err != nil {
		return fmt.Errorf("telemetry setup: %w", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shutdownTelemetry(ctx); err != nil {
			slog.Error("telemetry shutdown", "error", err)
		}
	}()

	srv := &http.Server{
		Addr:              net.JoinHostPort("", port),
		Handler:           api.New().Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// WriteTimeout must exceed the ?fail=timeout fault (30s) so the
		// request really hangs instead of being cut by the server.
		WriteTimeout: 45 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("demo-backend listening",
			"addr", srv.Addr,
			"service.name", telemetry.ServiceName(),
			"service.version", telemetry.ServiceVersion,
			"otlp.endpoint", os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
		)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
```

## (f) Quick walk through the code

Read `examples/backend` in this order.

1. `main.go`: `PORT` env, `-check` flag (the distroless image has no curl, so the
   binary probes its own `/healthz` as the Docker HEALTHCHECK), `run()` wires
   `telemetry.Setup`, the `http.Server` and signal-driven shutdown.
2. `internal/telemetry/telemetry.go`: the SDK init from section (c): resource,
   propagator, tracer / meter / logger providers, OTLP/HTTP exporters, slog bridge.
3. `internal/telemetry/baggage.go`: the `BaggageSpanProcessor` and the
   `AttributesFromBaggage` / `BaggageValue` helpers from section (d).
4. `internal/telemetry/baggage_test.go`: proves with an in-memory exporter that a
   `baggage` header becomes `session.id` on the server span, that no baggage adds
   nothing, and that `traceparent` joins the incoming trace. Good template for your
   own test.
5. `internal/api/handlers.go`: `Server` struct (tracer, propagator, three metrics),
   `Handler()` (CORS -> otelhttp -> mux), `route` / `instrument` middleware, the five
   handlers with their child spans (`inventory.lookup`, `cart.load`,
   `payment.charge`, `db.query`), `userID` (baggage `user.id`, then `x-user-id`
   header, then `anonymous`), `identityLogAttrs`, JSON helpers, `statusRecorder`.
6. `internal/api/cors.go`: the CORS middleware from section (e) 7.
7. `internal/api/faults.go`: query-flag fault injection (`?delay`, `?fail`) plus the
   `slowQuery` child span and the `fail` helper that records an error on the span and
   logs it. Demo-only, but `slowQuery` and `fail` show the canonical error pattern.
8. `internal/api/store.go`: in-memory product catalogue and per-user carts. No
   telemetry in it, which is the point: instrumentation lives in the handlers.
9. `internal/api/api_test.go`: `httptest` round trips with an in-memory tracer
   provider, covering routes, identity from baggage, checkout failure, faults and
   CORS.
10. `Dockerfile`: two-stage build to `gcr.io/distroless/static-debian12:nonroot`
    with the `-check` HEALTHCHECK.
11. `README.md`: endpoints, env table, fault flags and the manual smoke test.

## (g) Run it locally and see the trace

Stack from `00-stack.md` is up. Start the reference backend against it (adjust
`4318` if you overrode `OUO_OTLP_HTTP_PORT`; `localhost:4318` works because the
collector is published on the loopback interface and you are on the stack host):

```bash
cd examples/backend
```

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_SERVICE_NAME=demo-backend OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=local go run .
```

It logs `demo-backend listening addr=:8081 ...`. In a second terminal, send one
request with the exact headers the SDKs send. The `traceparent` fixes the trace id
so you can fetch it by id right away:

```bash
curl -s -X POST http://localhost:8081/api/cart -H 'content-type: application/json' -H 'baggage: session.id=test-session,user.id=user-42,ouo.platform=web' -H 'traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' -d '{"productId":"p-1001","qty":2}'
```

Expected: a cart JSON with `"userId":"user-42"` (identity came from baggage). The
backend's stdout shows one `request` line with `session.id=test-session`
`user.id=user-42` `ouo.platform=web`.

Fetch the trace by id (near-instant):

```bash
curl -s http://localhost:3200/api/traces/0af7651916cd43dd8448eb211c80319c | head -c 600
```

Search by session with TraceQL (needs `start`/`end`; allow 10 to 60 s after the
request before it shows up):

```bash
curl -s -G http://localhost:3200/api/search --data-urlencode 'q={ resource.service.name = "demo-backend" && span.session.id = "test-session" }' --data-urlencode "start=$(( $(date +%s) - 600 ))" --data-urlencode "end=$(( $(date +%s) + 60 ))"
```

The log line in Loki, filtered by the structured-metadata field:

```bash
curl -s -G http://localhost:3100/loki/api/v1/query_range --data-urlencode 'query={service_name="demo-backend"} | session_id="test-session"' --data-urlencode "start=$(( $(date +%s) - 600 ))000000000" --data-urlencode 'limit=5'
```

The request counter in Mimir (no `_total` suffix, see `00-stack.md`):

```bash
curl -s -G http://localhost:9009/prometheus/api/v1/query --data-urlencode 'query=sum by (http_route) (ouo_demo_requests)'
```

In Grafana (http://localhost:3000, `admin` / `admin`):

- Explore -> Tempo -> TraceQL `{ span.session.id = "test-session" }`. Open the trace:
  the server span `POST /api/cart` has one child `inventory.lookup`, which has two
  `db.query` children (the SELECT and the INSERT). Its parent span id comes from the
  `traceparent` you sent and does not exist, so Grafana flags a missing root; a real
  browser session supplies it. Every span carries `session.id`, `user.id`,
  `ouo.platform`.
- On any span, "Logs for this span" runs the provisioned trace-to-logs query
  `{service_name="demo-backend"} | session_id="test-session"` and shows the
  `request` line.
- Explore -> Loki -> `{service_name="demo-backend"}` and click the `trace_id` field
  on a line to jump back to Tempo.

Your own service: same curls with your port and `OTEL_SERVICE_NAME`.

## (h) Fault switches (demo only)

The reference backend accepts query flags on every `/api/*` route so the demo apps
can produce slow, failed and timed-out sessions on purpose: `?delay=1500` sleeps
inside a `db.query` child span, `?fail=500` returns 500 with the error recorded on
the span and one error log, `?fail=timeout` hangs for 30 s, and
`POST /api/checkout` with `{"paymentMethod":"broken-card"}` always fails on the
`payment.charge` span. They live in `internal/api/faults.go` and
`handleCheckout`; do not copy them into a real service. The error-recording pattern
inside them (`span.RecordError`, `span.SetStatus(codes.Error, ...)`,
`slog.ErrorContext`) is the part worth keeping.
