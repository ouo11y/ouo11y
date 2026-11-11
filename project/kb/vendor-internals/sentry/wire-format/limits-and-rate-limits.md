# Size limits, data categories, rate limits and status codes

Versions: Relay 26.10.0, self-hosted 26.10.0. Researched 2026-11-10.

## Size limits

Defaults from `impl Default for Limits` in [`relay-config/src/config.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-config/src/config.rs). Self-hosted does not override any of them ([`relay/config.example.yml`](https://github.com/getsentry/self-hosted/blob/26.10.0/relay/config.example.yml)); its nginx caps the raw request at 100 MiB first. Per-item checks run in `check_envelope_size_limits` ([`utils/sizes.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/utils/sizes.rs)); the request-body limits are axum `DefaultBodyLimit` per route and apply after decompression.

| Limit | Default | Applies to | Observed |
|---|---|---|---|
| nginx `client_max_body_size` | 100 MiB (compressed) | every request | 413 HTML from nginx at 101 MiB |
| `max_envelope_size` | 200 MiB (decompressed) | envelope route body | 413 `length limit exceeded` at 210 MiB gunzipped |
| `max_event_size` | 1 MiB | each of `event`, `transaction`, `security`, `raw_security`, `replay_event`, `feedback`, `form_data`; **one** of them per envelope | 413 at 1 MiB + 10 B |
| `max_attachment_size` | 200 MiB | each `attachment`, `unreal_report`, `user_report` | — |
| `max_attachments_size` | 200 MiB | all attachments in one envelope | — |
| `max_attachment_count` | 30 | attachments per envelope | — |
| `max_replay_compressed_size` | 10 MiB | `replay_recording`, `replay_video` item (one each) | 413 at 10 MiB + 10 B |
| `max_replay_uncompressed_size` | 100 MiB | recording after zlib inflate, during scrubbing | — |
| `max_replay_message_size` | 15 MiB | event + recording + video in one Kafka message | — |
| `max_sessions_size` / `max_session_count` | 10 MiB / 100 | `session` + `sessions` items | — |
| `max_client_reports_size` / `_count` | 100 KiB / 100 | `client_report` items | 413 at 101 items |
| `max_check_in_size` | 100 KiB | one `check_in` | — |
| `max_profile_size` | 50 MiB | one `profile` or `profile_chunk` | — |
| `max_log_size` | 2 MiB | one log inside a `log` container | 413 at 2 MiB + 10 B |
| `max_trace_metric_size` | 1 MiB | one trace metric | — |
| `max_span_size` | 10 MiB | one span | — |
| `max_standalone_span_count` | 25 | legacy (non-container) `span` items per envelope | — |
| `max_container_size` | 12 MiB | whole `log` / `trace_metric` / span v2 container, and the OTLP routes' body | — |
| `max_metric_buckets_size` | 1 MiB | `metric_buckets` | — |
| `max_upload_size` | 10 GiB | TUS `/upload/` | — |
| `MAX_ENVELOPE_ITEMS` | 500 items | any envelope | 400 at 501 |
| `MAX_JSON_SIZE` | 256 KiB | Relay-protocol routes | — |

The develop docs (<https://develop.sentry.dev/sdk/data-model/envelopes/#size-limits>, accessed 2026-11-10) still list older numbers: 1 MiB for spans and logs and 4 KiB for client reports. Relay 26.10.0 accepts more (2 MiB per log, 10 MiB per span, 100 KiB of client reports). Trust Relay.

An item over its limit fails the **whole** request with 413 `envelope exceeded size limits for type '<item>'` and an `invalid` outcome `too_large:<item>` for every item in it (observed in `outcomes_raw_local`).

## Data categories per item

From `Item::quantities` ([`envelope/item.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/item.rs)). Numbers are the `DataCategory` ids stored in the `outcomes_*` tables ([`relay-base-schema/src/data_category.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-base-schema/src/data_category.rs)).

| Item | Categories (id) | Quantity |
|---|---|---|
| `event` | `error` (1) | 1. Events with no level/exception are `default` (0) after processing |
| `transaction` | `transaction` (2), `transaction_indexed` (9), `span` (12), `span_indexed` (16) | 1; spans = 1 + `span_count` |
| `security`, `raw_security` | `security` (3) | 1 |
| `attachment` | `attachment` (4) bytes, `attachment_item` (22) | payload bytes, 1 |
| `unreal_report` | `error` (1) | 1 |
| `session`, `sessions` | `session` (5) | `item_count` or 1 |
| `user_report`, `feedback` | `feedback` (14) | 1 |
| `profile` | `profile` (6), `profile_indexed` (11), plus `profile_backend` (35) or `profile_ui` (36) | 1 |
| `profile_chunk` | `profile_chunk` (18) or `profile_chunk_ui` (26) by `platform` header; none if no header | 1 |
| `replay_event`, `replay_recording`, `replay_video` | `replay` (7) | 1 each at the edge; a processed web replay (event + recording) counts 2, a video replay 1 |
| `check_in` | `monitor` (10) | 1 |
| `span` | `span` (12), `span_indexed` (16) | `item_count` or 1 |
| `log` | `log_item` (23), `log_byte` (24) | `item_count`, payload bytes |
| `trace_metric` | `trace_metric` (33), `trace_metric_byte` (37) | `item_count`, payload bytes |
| OTLP / NEL / Vercel logs | `log_item`, `log_byte` | |
| OTLP spans | `span`, `span_indexed` | |
| `client_report`, `metric_buckets`, `form_data`, unknown | none | |

Outcome ids (`outcomes_raw_local.outcome`): 0 accepted, 1 filtered, 2 rate_limited, 3 invalid, 4 abuse, 5 client_discard, 6 cardinality_limited (read: [`services/outcome/mod.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/services/outcome/mod.rs) `OutcomeId`). Client reports become `client_discard` outcomes with the SDK's reason (observed: `ratelimit_backoff` for `replay`, `sample_rate` for `transaction`, `queue_overflow` for `error`).

## Rate limits

### Header grammar

Written by `format_rate_limits` ([`utils/rate_limits.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/utils/rate_limits.rs)), defined in <https://develop.sentry.dev/sdk/expected-features/rate-limiting/> (accessed 2026-11-10):

```
X-Sentry-Rate-Limits: <limit>[, <limit>...]
limit = retry_after ":" categories ":" scope [ ":" reason_code [ ":" namespaces ] ]
categories = category { ";" category }     ; empty = all categories
scope = "organization" | "project" | "key"
namespaces = namespace { ";" namespace }   ; only for metric_bucket
```

Relay writes `", "` between limits, and an empty reason followed by `:` when only namespaces are present. SDK rules from the doc: apply the header on **every** response, also 200; on 429 without the header use `Retry-After` for all categories; with neither, back off 60 s for all categories; ignore unknown categories; never map them to `default`.

### Observed 429

Project key `rateLimit` set to `{window: 60, count: 1}` through the API for 3 minutes, then removed (fixtures `ratelimit-*.json`).

```
HTTP/1.1 429 Too Many Requests
retry-after: 33
x-sentry-rate-limits: 33:default;error;security:key:key_quota
{"detail":"Sentry dropped data due to a quota or internal rate limit being reached. This will not affect your application. See https://docs.sentry.io/product/accounts/quotas/ for more information."}
```

- The first requests after the change still got 200: the quota is enforced in processing (Redis counters) and Relay learns the limit from the first rejection, then answers 429 at the edge until `retry_after` runs out. It took about 60 to 90 s after the API change.
- A key rate limit covers only `default;error;security`. While errors were limited, a transaction and a session in their own envelopes got 200.
- An envelope with a limited `event` and an unlimited `session` got **429** with the header for the event categories; the session item is still queued (`check_rate_limits` returns an error if any propagatable limit was enforced, [`endpoints/common.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/endpoints/common.rs)).
- Dropped items produce `rate_limited` (2) outcomes with reason `key_quota` (observed: 7 errors).
- We did not observe `X-Sentry-Rate-Limits` on a 200. Relay's code path for it (`HandledEnvelope.rate_limits`) exists but the envelope handler only turns enforced limits into a 429 (unverified whether self-hosted ever sends the header on 200).

## Status codes

From `IntoResponse for BadStoreRequest` and `BadEventMeta` ([`endpoints/common.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/endpoints/common.rs), [`extractors/request_meta.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/extractors/request_meta.rs)).

| Status | When | SDK should |
|---|---|---|
| 200 | accepted for processing (not yet stored) | drop the envelope from the outbox |
| 202 | cron check-in endpoint | same |
| 400 | invalid envelope, JSON, compression, event id, multipart, minidump, unsupported protocol version, bad key format, project id mismatch, internal items | drop, do not retry |
| 401 | missing, multiple or bad auth | drop |
| 403 | `EventRejected` (e.g. project id of key ≠ path, disabled key, project disabled) | drop |
| 413 | envelope or item over a size limit (Relay) or body over 100 MiB (nginx, HTML body) | drop |
| 415 | unsupported `Content-Encoding` (e.g. `x-gzip`), OTLP with a content type other than JSON/protobuf | drop |
| 429 | rate limited; `Retry-After` + `X-Sentry-Rate-Limits` | back off per category |
| 500 | upload failed, multipart lock failure | retry |
| 503 | queue full, project config unavailable, memory over limit | retry later |
