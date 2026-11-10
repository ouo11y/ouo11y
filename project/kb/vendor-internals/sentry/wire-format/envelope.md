# Sentry envelope framing

Versions: Relay 26.10.0 (`getsentry/relay` tag `26.10.0`, commit `b4194151`), self-hosted Sentry 26.10.0. Researched 2026-11-10 by `sentry-wire-storage` (Step 6). "Observed" means a request sent by our harness to Relay through self-hosted nginx (`localhost:9000`), with the response stored in [fixtures/relay-responses/](fixtures/relay-responses/index.md). "Read" means source or docs.

Item payloads are in [item-types/](item-types/index.md). Replay is in [replay-wire.md](replay-wire.md). Limits are in [limits-and-rate-limits.md](limits-and-rate-limits.md).

## Grammar

The develop docs give this grammar (read: <https://develop.sentry.dev/sdk/data-model/envelopes/>, accessed 2026-11-10):

```
Envelope = Headers { "\n" Item } [ "\n" ] ;
Item     = Headers "\n" Payload ;
Payload  = { * } ;
```

Relay parses it like this (read: [`relay-server/src/envelope/mod.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/mod.rs) `parse_headers`, `parse_items`, `require_termination`; [`item.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/item.rs) `Item::parse`):

1. The envelope header is the first JSON value, read with a streaming `serde_json` deserializer. The byte after it must be `\n` or end of input, else `missing newline after header or payload`.
2. Items are read until the end of input. Each item header is the next JSON value of a stream deserializer, which skips leading whitespace. So blank lines **between** items are accepted.
3. With `length`, the payload is exactly `length` bytes, and the next byte must be `\n` or end of input. A body that is too short is `unexpected end of file`.
4. Without `length`, the payload runs to the next `\n` or the end of input.
5. After the last item, one `\n` is fine. A second `\n` makes Relay try to parse another item header from nothing, which fails with `unexpected end of file`.
6. More than 500 items is `too many individual items` (`MAX_ENVELOPE_ITEMS`, [`constants.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/constants.rs)).

| Framing case | Relay 26.10.0 answer | Fixture |
|---|---|---|
| Item with `length`, trailing `\n` | 200 `{"id":...}` | `event-plain.json` |
| Item without `length` | 200 | `event-no-length.json` |
| No trailing newline at all | 200 | `event-no-trailing-newline.json` |
| Two trailing newlines | **400** `invalid event envelope` / `unexpected end of file` | `event-double-trailing-newline.json` |
| Empty line between two items | 200 | `blank-line-between-items.json` |
| `length` larger than the rest | 400 `unexpected end of file` | `event-length-too-long.json` |
| `length` shorter, next byte not `\n` | 400 `missing newline after header or payload` | `event-length-short-no-newline.json` |
| CRLF after headers | 400 `missing newline after header or payload` | `crlf-line-endings.json` |
| Header line only, no items | 200 `{"id":...}` (id echoed, nothing stored) | `header-only-no-items.json` |
| Empty body | 400 `empty request body` | `empty-body.json` |
| Envelope header not JSON | 400 `invalid envelope header` | `malformed-header.json` |
| Item header not JSON | 400 `invalid item header` | `item-header-not-json.json` |
| 501 items | 400 `too many individual items` | `limit-501-items.json` |

All observed 2026-11-10.

## Envelope header

`EnvelopeHeaders` (read: [`envelope/mod.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/mod.rs)) has typed fields and keeps every other key (`other`, for forward compatibility).

| Field | Type | Use in Relay | Source |
|---|---|---|---|
| `event_id` | 32 hex UUID | Id of the event the envelope belongs to. Relay **creates one** if an item creates an event (`Item::creates_event`) and none was sent. For replay items it is the replay id and is required. | `Envelope::parse_request` |
| `dsn` | string | Auth fallback when the request has no auth (see [auth-and-endpoints.md](auth-and-endpoints.md)). If present, its project id and public key must match the request, else 400 `project id header mismatch` / `public key header mismatch`. | `EnvelopeHeaders::complete` |
| `sdk` | `{name, version}` | Kept in the request meta. | `RequestMeta` |
| `sent_at` | RFC 3339 | Clock drift correction of every timestamp in the envelope. | `sent_at` |
| `trace` | DSC object | Dynamic sampling context. Parsed inside an error boundary: a bad `trace` does not fail the envelope. | `trace: Option<ErrorBoundary<DynamicSamplingContext>>` |
| `origin` | URL | Must match the request `Origin` if both are present. | `complete` |
| `required_features` | list | Internal, set only by Relay. | — |
| anything else | any | Kept and forwarded (`other`). | — |

### `trace` (dynamic sampling context)

Read: [`relay-sampling/src/dsc.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-sampling/src/dsc.rs) and <https://develop.sentry.dev/sdk/telemetry/traces/dynamic-sampling-context/> (accessed 2026-11-10).

| Key | Type on the wire | Meaning |
|---|---|---|
| `trace_id` | 32 hex | Trace id |
| `public_key` | 32 hex | DSN key of the head project. Relay uses it to load the **root project's** sampling config (`Envelope::sampling_key`, only when the envelope has an event, transaction or span) |
| `sample_rate` | string or number | Head sampling rate |
| `sample_rand` | string or number | Random value 0..1 shared by the trace |
| `sampled` | `"true"`/`"false"` or bool | Head decision |
| `release`, `environment`, `transaction` | string | Matched by dynamic sampling rules |
| `replay_id` | 32 hex | Replay of the head |
| `user_segment`, `user_id` | string | Legacy |

The harness sent a full DSC with a transaction (`item-transaction.json`) and the transaction was stored (`transactions_local`, see [../self-hosted-storage/follow-one-event.md](../self-hosted-storage/follow-one-event.md)).

## Item header

`ItemHeaderKey` (read: [`item.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/item.rs)). Unknown keys are kept (`MaybeKnown::Unknown`).

| Key | Meaning |
|---|---|
| `type` | Item type, see [item-types/](item-types/index.md). Unknown strings become `ItemType::Unknown` |
| `length` | Payload bytes. Optional when the payload has no newline |
| `item_count` | Required for container items (`log`, `trace_metric`, span v2). Must equal the number of items in the container. Outcomes are counted from this header (observed: a log item with `item_count: 5` and 2 items produced 5 `invalid_json` `log_item` outcomes) |
| `content_type` | MIME type. Selects container formats (`application/vnd.sentry.items.log+json`, `...span.v2+json`, `...trace-metric+json`), trace attachments and internal integrations |
| `filename` | Attachments |
| `attachment_type` | Attachments: `event.attachment`, `event.minidump`, `event.applecrashreport`, `event.payload`, `event.breadcrumbs`, `event.view_hierarchy`, `unreal.context`, `unreal.logs`, `event.nv_gpudmp`, `event.nv_shader_debug` ([`attachment.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/attachment.rs)) |
| `platform` | `profile_chunk`: picks the `profile_chunk` or `profile_chunk_ui` category |
| `span_count` | Transactions: number of child spans, for outcomes |
| `sampled` | Profiles: `false` if the transaction was sampled out |
| `meta_length`, `span_id` | Trace attachments (attachment v2) |
| `attachment_length` | Attachment placeholders (`application/vnd.sentry.attachment-ref+json`) |
| `sentry_release`, `sentry_environment` | Set by Relay on some items |
| `fully_normalized` | Set by Relay |

Internal fields that never go on the wire: `stored_key`, `routing_hint`, `rate_limited`, `source_quantities`.

## Request content type and compression

- The request `Content-Type` is not checked on `/envelope/` (observed: `text/plain;charset=UTF-8` accepted in `auth-envelope-dsn-only.json`). The canonical value is `application/x-sentry-envelope` ([`content_type.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/content_type.rs)).
- `Content-Encoding`: Relay wraps every route in `tower_http` `RequestDecompression` built with `decompression-gzip`, `-deflate`, `-br`, `-zstd` ([`relay-server/Cargo.toml`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/Cargo.toml), [`middlewares/decompression.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/middlewares/decompression.rs)).

| Content-Encoding | Observed | Fixture |
|---|---|---|
| none | 200 | `event-plain.json` |
| `gzip` | 200 | `event-gzip.json` |
| `deflate` (zlib wrapper, RFC 9110) | 200 | `event-deflate-zlib.json` |
| `deflate` with raw deflate | **400** `deflate decompression error` | `event-deflate-raw.json` |
| `br` | 200 | `event-br.json` |
| `zstd` | 200 | `event-zstd.json` |
| `x-gzip` | **415**, empty body | `event-x-gzip.json` |
| `gzip` header, plain body | 400 `Invalid gzip header` | `event-gzip-header-plain-body.json` |

Relay's body limits apply to the **decompressed** body: a 210 KiB gzip body that inflates to 210 MiB got 413 `length limit exceeded` (`limit-gzip-210MiB-decompressed.json`). nginx in front checks the **compressed** size (`client_max_body_size 100m`, [`nginx.conf`](https://github.com/getsentry/self-hosted/blob/26.10.0/nginx.conf)); observed 413 HTML from nginx (`limit-nginx-101MiB-raw.json`).

## Response

- 200 with `{"id":"<event_id>"}` when the envelope header has an event id (or Relay made one), else `{}` (read: `StoreResponse` in [`endpoints/envelope.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/endpoints/envelope.rs)).
- 200 does **not** mean stored. Payload validation, project lookup, filters, most quotas and PII scrubbing run after the response. Drops are visible only as outcomes (see [../self-hosted-storage/pipeline.md](../self-hosted-storage/pipeline.md#outcomes)). Example: a well formed key that no project has answered 200 (`auth-unknown-key.json`).
- Errors are JSON `{"detail": "...", "causes": [...]}` (`ApiErrorResponse`). Status codes: [limits-and-rate-limits.md](limits-and-rate-limits.md#status-codes).
- CORS headers on every store route: `access-control-allow-origin: *`, `access-control-expose-headers: x-sentry-error,x-sentry-rate-limits,retry-after` (observed, all fixtures). Preflight allows the headers `x-sentry-auth, x-requested-with, x-forwarded-for, origin, referer, accept, content-type, authentication, authorization, content-encoding, transfer-encoding`, method POST, max age 3600 (read: [`middlewares/cors.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/middlewares/cors.rs)).

## Event and item combinations

`check_envelope_size_limits` ([`utils/sizes.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/utils/sizes.rs)) puts `event`, `transaction`, `security`, `raw_security`, `replay_event`, `feedback` and `form_data` into **one** limit bucket with `total_count: 1`. One envelope can hold only one of them:

| Envelope | Observed | Fixture |
|---|---|---|
| `event` + `attachment` | 200 | `item-attachment.json` |
| `event` + `session` | 200 | `item-session-in-error-envelope.json` |
| `event` + `transaction` | **413** `size limits for type 'transaction'` | `combo-event-plus-transaction.json` |
| `event` + `replay_event` + `replay_recording` | **413** `size limits for type 'replay_event'` | `combo-event-plus-replay_event.json` |
| two `replay_event` | **413** | `item-replay-two-events.json` |

The whole envelope is rejected, not only the extra item. A proxy that merges items from different SDK envelopes must keep this rule.
