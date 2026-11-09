# OTLP: how telemetry travels

Source: `docs/specification.md` in opentelemetry-proto v1.11.1. Status: Stable for traces, metrics and logs. Versions and evidence labels are in [otel-common-model.md](otel-common-model.md).

## Shape

OTLP has one operation, `Export`, with three transports: gRPC (port 4317), HTTP with binary protobuf, and HTTP with JSON (both port 4318). A browser can only use the HTTP forms.

| | Value |
|---|---|
| Method | `POST` |
| Paths | `/v1/traces`, `/v1/metrics`, `/v1/logs` |
| Binary | `Content-Type: application/x-protobuf` |
| JSON | `Content-Type: application/json` |
| Compression | `Content-Encoding: gzip`; servers MUST support `none` and `gzip` |
| Response type | Same content type as the request |

Requests are the `Export*ServiceRequest` messages. Each has one repeated field, the same as `LogsData` and friends.

## OTLP/JSON is not plain proto JSON

| Thing | OTLP/JSON rule |
|---|---|
| `traceId`, `spanId`, `parentSpanId` | Hex strings, not base64 |
| Other `bytes` (for example `bytesValue`) | Base64, the protobuf JSON default |
| Enums | Integers only. Names are not allowed |
| 64-bit integers, including timestamps | Decimal strings (numbers are also accepted when decoding) |
| Keys | lowerCamelCase only |
| Unknown fields | Receivers MUST ignore them |

So `bytes_value` in JSON costs 4/3 of the size before gzip. In protobuf it is raw.

## Results a server can return

| Situation | HTTP | Client must |
|---|---|---|
| Full success | `200`, `Export*ServiceResponse`, `partial_success` unset | Done |
| Partial success | `200`, `partial_success` with `rejected_*` count and `error_message` | **Not retry** |
| Warning only | `200`, `partial_success` with rejected = 0 and a message | Done |
| Bad data | `400`, body is a protobuf `Status` | **Not retry**, drop, count |
| Too large | `413` | Not retry |
| Throttled or overloaded | `429` or `503`, optional `Retry-After` | Retry, honour the header |
| Other retryable | `502`, `504` | Retry, exponential backoff with jitter |
| Any other 4xx/5xx | | **Not retry** |
| Disconnect, no response | | Retry with backoff |

Delivery is at least once. A client that gets no answer resends, so duplicates can happen; the spec calls this a deliberate trade. Acknowledgement is per hop, not end to end: a `200` from a Collector says nothing about the backend.

Empty requests get success. Senders should not create empty envelopes.

## Size limits

| Where | Value | Evidence |
|---|---|---|
| Spec recommended server and client limit | 64 MiB, measured after decompression | spec |
| Spec required when exceeded (HTTP) | `413 Content Too Large` | spec |
| Collector `confighttp` default | **20 MiB**, checked compressed and decompressed | source and tested |
| Collector when exceeded | **`400`** with "http: request body too large" | **tested** (differs from spec) |
| Mimir `max_otlp_request_size` | 100 MiB | source |
| VictoriaLogs `opentelemetry.maxRequestSize` | 64 MiB | source |
| Browser `fetch` with `keepalive` | **64 KiB across all in-flight keepalive requests** | WHATWG Fetch |

The browser limit is the one that actually shapes our design. A flush during page unload has to fit in 64 KiB in total, not per request.

Collector default batch is `send_batch_size` 8192, `timeout` 200 ms. SDK default batch processors are 512 records with a 5000 ms delay for spans and 1000 ms for logs, and a queue of 2048 (spec). Those SDK defaults assume a long-running process.

## Servers do not all follow the response rules (tested)

- **Loki** answers a good OTLP push with `204` and no body. The spec says `200` with a response message.
- **Loki** with one bad record in a batch answers **`400` for the whole request, yet the good records were stored**. It does not use `partial_success`. The client correctly stops retrying, but it believes the whole batch was lost.
- **Collector** answers `400` where the spec says `413`. Clients treat both as do-not-retry, so behaviour is the same, but do not code against `413`.

## Why this matters for an SDK

- Batching is worth more than any encoding choice (measured in [otel-signal-choice-and-backends.md](otel-signal-choice-and-backends.md)).
- Retry only on the listed codes.
- Record every drop, because the protocol asks for it and nothing else will tell us.
