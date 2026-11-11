# Event items: event, transaction, security, raw_security, form_data, user_report, feedback

Versions: Relay 26.10.0, Sentry 26.10.0. Researched 2026-11-10. The full event schema is in Relay's `Event` ([`relay-event-schema/src/protocol/event.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-event-schema/src/protocol/event.rs)) and the develop docs <https://develop.sentry.dev/sdk/data-model/event-payloads/> (accessed 2026-11-10). This file lists what matters on the wire; field-level SDK usage is in the sibling `browser-sdk/` and `mobile-sdks/` folders.

## Shared rules

- One of `event`, `transaction`, `security`, `raw_security`, `feedback`, `replay_event`, `form_data` per envelope (one `event` limit bucket, count 1, 1 MiB). See [../envelope.md](../envelope.md#event-and-item-combinations).
- The envelope `event_id` should equal the payload `event_id`. If the envelope has none, Relay makes one.
- Relay normalizes (timestamps with `sent_at` drift, user agent, IP, GeoIP, stack trace limits, PII scrubbing) before Kafka. Grouping, symbolication and issue creation happen in Sentry (`ingest-events` consumer → `save_event` task → nodestore + `events` topic → Snuba).

## `event` (errors and messages)

Payload: event JSON. Important top-level keys: `event_id`, `timestamp`, `platform`, `level`, `logger`, `transaction`, `release`, `dist`, `environment`, `server_name`, `message`/`logentry`, `exception.values[]` (`type`, `value`, `module`, `mechanism{type,handled,synthetic,...}`, `stacktrace.frames[]`), `threads`, `breadcrumbs.values[]`, `contexts` (`trace`, `replay`, `device`, `os`, `app`, `browser`, `runtime`, `culture`, `feedback`, ...), `tags`, `extra`, `user`, `request`, `sdk`, `debug_meta.images[]`, `fingerprint`, `modules`.

Category `error` (or `default` when no error level). Kafka: `ingest-events`, or `ingest-attachments` when the envelope also carries attachments or user reports ([`services/store.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/services/store.rs), `event_topic`). The message is msgpack `{type: "event", payload: <event JSON>, start_time, event_id, project_id, org_id, remote_addr, attachments: [...]}`.

Observed: 22 error events stored for project `step6-wire` in `errors_local`; one has `replay_id` set from `contexts.replay.replay_id` and caused a replay link row ([../../self-hosted-storage/follow-one-event.md](../../self-hosted-storage/follow-one-event.md)). Events from our harness had no source maps, so Sentry also wrote EAP `processing error` items (`item_type 13`, `error_type: js_no_source`).

## `transaction`

Payload: event JSON with `type: "transaction"`, `transaction`, `transaction_info.source`, `start_timestamp`, `timestamp`, `contexts.trace{trace_id, span_id, parent_span_id, op, status, data}`, `spans[]`, `measurements` (web vitals), `breakdowns`.

Relay extracts the segment span and every child span and sends them to `ingest-spans` (span count goes in the `span_count` header for outcomes). The transaction itself goes to `ingest-transactions` → `transactions` topic → `transactions_local`. Observed: our transaction gave 1 row in `transactions_local` and 2 spans in EAP (segment `pageload` and child `http.client` named `HTTP`). Categories: `transaction`, `transaction_indexed`, `span`, `span_indexed`.

## `security` and `raw_security`

`raw_security` is the browser report as received by `/api/{id}/security/`: CSP (`csp-report`), Expect-CT, Expect-Staple, HPKP. Relay turns it into a `security` event (`relay-event-schema/src/protocol/security_report.rs`). Query params `sentry_release` and `sentry_environment` set release and environment. Inbound filters (the CSP filter in [`relay-filter/src/csp.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-filter/src/csp.rs)) can drop it. Observed: our CSP report got 200 and then `filtered` `invalid-csp`.

## `form_data`

Multipart fields from the minidump and attachments endpoints, stored as a stream of JSON tuples and merged into the event (`sentry` key or `sentry[...]` fields). Not sent by SDKs inside envelopes.

## `user_report` (legacy feedback)

Payload: `{"event_id": "<event>", "name": "...", "email": "...", "comments": "..."}` ([`relay-event-schema/src/protocol/user_report.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-event-schema/src/protocol/user_report.rs)). Category `feedback`. Relay sends it to `ingest-attachments` as a `user_report` message; Sentry saves a `sentry_userreport` row and, in 26.x, also creates a feedback issue.

## `feedback` (user feedback v2, `UserReportV2`)

Payload: an event with `contexts.feedback`:

| Key | Meaning |
|---|---|
| `message` | the text (required) |
| `contact_email`, `name` | reporter |
| `url` | page |
| `source` | e.g. `widget`, `api` |
| `associated_event_id` | error it belongs to |
| `replay_id` | replay it belongs to |

Kafka `ingest-feedback-events` → Sentry `ingest-feedback` consumer → issue platform occurrence type 6001 (`search_issues_local_v2`) and a `sentry_groupedmessage` row titled `User Feedback: <message>`.

Observed with one `feedback` item that had `associated_event_id` and one legacy `user_report` for the same error, sent 1 s apart: two 6001 feedback issues exist, both with the feedback item's text, and one `sentry_userreport` row whose `comments` is the feedback text; the legacy report's text was not found anywhere. We did not trace why (probably the feedback shim writing a `UserReport` for `associated_event_id` and the unique `(project_id, event_id)` key). Treat it as: do not send both forms for one error.
