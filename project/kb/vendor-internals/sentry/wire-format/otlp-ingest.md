# Sentry's OTLP ingest (Relay 26.10.0)

Versions: Relay 26.10.0, self-hosted 26.10.0. Researched 2026-11-10. Relevant to topology (b): an OTel Collector fanning out to Sentry with the `otlphttp` exporter.

## Endpoints

Read: [`relay-server/src/endpoints/integrations/otlp.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/endpoints/integrations/otlp.rs), routes nested at `/api/{project_id}/integration/otlp` in [`endpoints/mod.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/endpoints/mod.rs).

| Signal | URL | Status |
|---|---|---|
| Traces | `POST /api/{project_id}/integration/otlp/v1/traces` (trailing `/` also) | supported |
| Logs | `POST /api/{project_id}/integration/otlp/v1/logs` (trailing `/` also) | supported; requires the org feature `organizations:ourlogs-ingestion` (`with_required_feature(Feature::OurLogsIngestion)`), on by default in self-hosted |
| Metrics | none | 404 (observed `otlp-metrics-json.json`) |
| gRPC | none | HTTP only |

For an OTel Collector: `otlphttp` exporter with `traces_endpoint`/`logs_endpoint` set to these full URLs (the default `endpoint` + `/v1/traces` join gives `.../integration/otlp/v1/traces` when `endpoint` is `https://host/api/<id>/integration/otlp`).

## Request

- Content type: `application/json` or `application/x-protobuf` (also `application/json; charset=utf-8`). Anything else: 415 with an OTLP `Status` body `{"code":3,"message":"unsupported content type: text/plain"}` (observed).
- `Content-Encoding`: same decompression layer as envelopes: gzip, deflate (zlib), br, zstd (observed gzip 200).
- Auth: the same sources as envelopes, typically header `x-sentry-auth: sentry sentry_key=<public key>`. `Authorization: Bearer` is **not** accepted (observed 401 `{"code":16,"message":"missing authorization information"}`).
- Body limit: `max_container_size` = 12 MiB after decompression.

## Responses

Read: `SuccessResponse`, `OtlpError` in `otlp.rs`; observed in fixtures `otlp-*.json`.

| Case | Status | Body |
|---|---|---|
| success, JSON | 200 | `{}` |
| success, protobuf | 200 | empty `ExportTraceServiceResponse` (0 bytes), `content-type: application/x-protobuf` |
| bad content type | 415 | `Status{code: 3 InvalidArgument}` as JSON |
| no auth | 401 | `Status{code: 16 Unauthenticated}` |
| rate limited | 429 | `Status{code: 8 ResourceExhausted}`, plus `Retry-After` and `X-Sentry-Rate-Limits` from the inner error |
| too large | 413 | `Status{code: 8}` |

Partial success (`partialSuccess.rejectedSpans`) is never reported; drops after the response show only as outcomes.

## How it is processed

The request body is wrapped into an **internal** envelope item `type: integration` with content type `application/vnd.sentry.integration.otel.spans+json|protobuf` or `...otel.logs+json|protobuf` ([`relay-server/src/integrations/mod.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/integrations/mod.rs)). Internal items must be converted by the same Relay; an SDK that sends `type: integration` gets 400 `envelope contains internal items` (observed `item-integration-forbidden.json`).

### Spans (`relay-spans`)

`otel_to_sentry_span` in [`relay-spans/src/otel_to_sentry_v2.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-spans/src/otel_to_sentry_v2.rs) turns each OTLP span into a Sentry span v2, then the normal span pipeline runs (Kafka `ingest-spans` → `process-spans` → `snuba-items` → EAP).

| OTLP | Sentry span v2 |
|---|---|
| `traceId`, `spanId`, `parentSpanId` | same (a bad trace id becomes a random one) |
| `name` | `name`. If empty: `db` when any `db*` attribute exists; `http.server`/`http.client`/`http` when `http.method`/`http.request.method` exists (by kind) |
| `kind` | attribute `sentry.kind` (`internal`, `server`, `client`, `producer`, `consumer`) |
| `startTimeUnixNano`, `endTimeUnixNano` | `start_timestamp`, `end_timestamp` |
| `status` | `status` (`ok`/`error`), message → `sentry.status.message` |
| `attributes` | copied as typed attributes |
| resource attributes | `resource.<key>` attributes (e.g. `resource.service.name`); resource also sets `sentry.platform` |
| scope | `instrumentation.name`, `instrumentation.version` |
| `links` | span links |
| `flags` remote bit | `sentry.is_remote`; a root or remote span is a segment (`sentry.segment.id` = own id) |
| `traceState` `th`/sample rate | `sentry.client_sample_rate` if not set |
| **`events`** | **dropped** (including exception events) |
| — | `sentry.origin = auto.otlp.spans` |

Observed in EAP (`eap_items_1_local`, `item_type = 1`): our JSON span with `http.request.method` and kind client got `sentry.op = http.client`, `sentry.origin = auto.otlp.spans`; the protobuf span with no attributes got op `default`.

### Logs (`relay-ourlogs`)

`otel_to_sentry_log` in [`relay-ourlogs/src/otel_to_sentry.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-ourlogs/src/otel_to_sentry.rs):

| OTLP | Sentry log |
|---|---|
| `severityNumber` 1-4 / 5-8 / 9-12 / 13-16 / 17-20 / 21-24 | `trace` / `debug` / `info` / `warn` / `error` / `fatal`; outside that range, parsed from `severityText`, default `info` |
| `body` | `body` (non-string bodies are stringified) |
| `traceId`, `spanId` | `trace_id`, `span_id` |
| `timeUnixNano` (else `observedTimeUnixNano`) | `timestamp` |
| attributes, resource (`resource.*`), scope (`instrumentation.*`) | attributes |
| — | `sentry.origin = auto.otlp.logs` |

Observed: our OTLP log landed in `eap_items_1_local` with `item_type = 3`, `sentry.body = "otlp json log"`, `resource.service.name`, `sentry.span_id`.

## What this means for topology (b)

- A Collector can send our own OTLP traces and logs to Sentry directly. No metrics, no replay, no sessions, no errors-as-issues through OTLP (an OTLP exception event does not create a Sentry issue, because span events are dropped).
- Sentry SDK envelopes cannot be sent over OTLP. Fan-out of Sentry SDK traffic needs an envelope-aware component (our `ouosentry` receiver forwards raw envelopes).
