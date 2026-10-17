# demo-backend

Small Go HTTP API that the ouo demo web and mobile apps call. It is fully
instrumented with the OpenTelemetry Go SDK so that browser/mobile spans and
backend spans join into one trace (W3C `traceparent`), and so that the
`session.id`, `user.id` and `ouo.platform` members the SDKs propagate in W3C
`baggage` are copied onto every backend span and log record.

## Run

In the local stack (built from this directory by `deploy/compose/compose.yaml`):

```bash
docker compose -f deploy/compose/compose.yaml up -d backend
```

Locally, against a collector on `localhost:4318` (check `deploy/compose/.env`
for the host port actually used on your machine):

```bash
cd examples/backend
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_SERVICE_NAME=demo-backend \
go run .
```

The API listens on `:8081` (`PORT` overrides it). Without a collector the
exporters log errors every few seconds but the API keeps serving.

Environment:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8081` | listen port |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP collector (traces, logs, metrics share it) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | only `http/protobuf` is compiled in |
| `OTEL_SERVICE_NAME` | `demo-backend` | `service.name` resource attribute |
| `OTEL_RESOURCE_ATTRIBUTES` | | extra resource attributes (`k=v,k2=v2`) |
| `CORS_ALLOWED_ORIGINS` | | extra exact origins, comma separated; `http://localhost:*` and `http://127.0.0.1:*` are always allowed |

Resource attributes always set: `service.version=0.1.0`,
`deployment.environment.name=local`.

## Endpoints

All responses are JSON. Identity: `user.id` from baggage, else the
`x-user-id` header, else `anonymous`. Carts are in memory per user.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/healthz` | | `{"status":"ok"}` (not traced, not logged) |
| GET | `/api/products` | | `[{id,name,price,image}]` (6 products) |
| GET | `/api/products/{id}` | | one product, 404 if unknown |
| GET | `/api/cart` | | `{userId,items:[{productId,name,qty,unitPrice,subtotal}],itemCount,total}` |
| POST | `/api/cart` | `{"productId":"p-1001","qty":2}` | cart summary (negative qty removes) |
| POST | `/api/checkout` | `{"paymentMethod":"card"}` | `{orderId,total,items}`; empties the cart |

`POST /api/checkout` with `"paymentMethod":"broken-card"` always returns
`500 {"error":"payment gateway unavailable"}` with the error recorded on the
`payment.charge` and server spans. This is the deterministic failure path the
demo apps use without query flags.

## Fault injection (any `/api/*` route)

| Query | Effect |
|---|---|
| `?delay=1500` | sleeps 1500 ms inside a child span `db.query` (`db.system.name=postgresql`, `db.query.text=SELECT pg_sleep($1) ...`), capped at 60 s |
| `?fail=500` | `500 {"error":"payment gateway unavailable"}`; `span.RecordError`, status Error, one error log line |
| `?fail=timeout` | hangs for 30 s (then 504) so clients can exercise their own timeouts; returns early if the client disconnects |

Flags combine: `?delay=300&fail=500` is slow and then fails.

## Telemetry

- Server span per request named `{METHOD} {route}` (for example
  `POST /api/checkout`), produced by `otelhttp`, plus child spans
  `inventory.lookup`, `cart.load`, `payment.charge` and `db.query`.
- `session.id`, `user.id`, `ouo.platform` from incoming baggage are set on
  every span (`internal/telemetry.BaggageSpanProcessor`) and on every log
  record, so Tempo `{ span.session.id = "<id>" }` matches backend spans.
- One `request` info log per request via `slog`, exported as OTLP logs
  (`otelslog` bridge) with trace and span ids, and mirrored to stdout.
- Metrics: `otelhttp`'s `http.server.request.duration` plus
  `ouo.demo.requests`, `ouo.demo.orders` and `ouo.demo.checkout.duration`.
- CORS: preflight answered with 204 and
  `Access-Control-Allow-Headers: content-type, traceparent, tracestate, baggage, x-user-id`.

Smoke test by hand:

```bash
curl -s -X POST localhost:8081/api/cart \
  -H 'content-type: application/json' \
  -H 'baggage: session.id=test-session,user.id=user-42,ouo.platform=web' \
  -d '{"productId":"p-1001","qty":2}'
curl -s -X POST 'localhost:8081/api/checkout?delay=200' \
  -H 'content-type: application/json' \
  -H 'baggage: session.id=test-session,user.id=user-42,ouo.platform=web' \
  -H 'traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' \
  -d '{"paymentMethod":"card"}'
# ~10 s later (Tempo search needs an explicit range; without start/end it only
# searches a tiny recent window):
NOW=$(date +%s)
curl -s "localhost:3200/api/search?q=%7B%20span.session.id%20%3D%20%22test-session%22%20%7D&start=$((NOW-600))&end=$((NOW+60))"
curl -s localhost:3200/api/traces/0af7651916cd43dd8448eb211c80319c | head -c 400
curl -s -G localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service_name="demo-backend"}' \
  --data-urlencode "start=$((NOW-600))000000000"
```

## Develop

```bash
go vet ./... && go test ./...
docker build -t ouo/demo-backend:dev .
docker run --rm -p 8081:8081 -e OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318 ouo/demo-backend:dev
```

The image is distroless (no shell); `demo-backend -check` is the container
HEALTHCHECK and probes `GET /healthz` on `PORT`.

Layout: `main.go` (server, graceful shutdown, `-check`),
`internal/telemetry` (OTel providers, propagator, baggage span processor),
`internal/api` (handlers, store, CORS, fault injection).
