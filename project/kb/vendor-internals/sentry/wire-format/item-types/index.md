# Envelope item types (Relay 26.10.0)

Every `type` string Relay 26.10.0 knows (`ItemType` and `FromStr` in [`relay-server/src/envelope/item.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/item.rs)), its family file, the Kafka topic it reaches in self-hosted, and what we observed. Researched 2026-11-10.

| `type` | Family file | Creates event | Container | Kafka topic (first hop) | Observed |
|---|---|---|---|---|---|
| `event` | [events-and-feedback.md](events-and-feedback.md) | yes | no | `ingest-events` (or `ingest-attachments` with attachments) | stored, `errors_local` |
| `transaction` | [events-and-feedback.md](events-and-feedback.md) | yes | no | `ingest-transactions`; child spans → `ingest-spans` | stored, `transactions_local` + EAP spans |
| `security` | [events-and-feedback.md](events-and-feedback.md) | yes | no | `ingest-events` | via `/security/` endpoint only |
| `raw_security` | [events-and-feedback.md](events-and-feedback.md) | yes | no | `ingest-events` | filtered (`invalid-csp`) |
| `form_data` | [events-and-feedback.md](events-and-feedback.md) | merged into event | no | — | not tested |
| `user_report` | [events-and-feedback.md](events-and-feedback.md) | no | no | `ingest-attachments` | 200; see notes |
| `feedback` | [events-and-feedback.md](events-and-feedback.md) | yes | no | `ingest-feedback-events` | issue type 6001 in `search_issues` |
| `attachment` | [attachments-and-crashes.md](attachments-and-crashes.md) | some types | no | `ingest-attachments` | stored inline in Postgres |
| `unreal_report` | [attachments-and-crashes.md](attachments-and-crashes.md) | yes | no | `ingest-attachments` | via `/unreal/` only |
| `session` | [sessions-and-client-reports.md](sessions-and-client-reports.md) | no | yes | `ingest-metrics` (as metrics) | metrics rows |
| `sessions` | [sessions-and-client-reports.md](sessions-and-client-reports.md) | no | yes | `ingest-metrics` | metrics rows |
| `client_report` | [sessions-and-client-reports.md](sessions-and-client-reports.md) | no | yes | `outcomes` (as `client_discard`) | outcome rows |
| `metric_buckets` | [spans-logs-metrics.md](spans-logs-metrics.md) | no | yes | `ingest-metrics` for the `sessions` namespace only; span and transaction metrics are dropped ("no longer ingested", `send_metric_message`) | not tested (Relay-to-Relay) |
| `span` | [spans-logs-metrics.md](spans-logs-metrics.md) | no | yes (v2) | `ingest-spans` | EAP `item_type 1` |
| `log` | [spans-logs-metrics.md](spans-logs-metrics.md) | no | yes | `snuba-items` | EAP `item_type 3` |
| `trace_metric` | [spans-logs-metrics.md](spans-logs-metrics.md) | no | yes | `snuba-items` | EAP `item_type 8` |
| `integration` | [spans-logs-metrics.md](spans-logs-metrics.md) | no | no | — | 400 from SDKs (internal only) |
| `replay_event` | [../replay-wire.md](../replay-wire.md) | no (needs event_id) | no | inside `ingest-replay-recordings` | `replays_local` |
| `replay_recording` | [../replay-wire.md](../replay-wire.md) | no | no | `ingest-replay-recordings` | segment file |
| `replay_video` | [../replay-wire.md](../replay-wire.md) | no | no | `ingest-replay-recordings` | segment file with video |
| `profile` | [profiles-and-check-ins.md](profiles-and-check-ins.md) | no (needs event_id) | yes | `profiles` | not tested |
| `profile_chunk` (alias `profile_chunk_ui`) | [profiles-and-check-ins.md](profiles-and-check-ins.md) | no | yes | `profiles` (then vroom → `snuba-profile-chunks`) | minimal chunk rejected (`profiling_invalid_json`) |
| `check_in` | [profiles-and-check-ins.md](profiles-and-check-ins.md) | no | yes | `ingest-monitors` | monitor auto-created |
| anything else | [removed-and-unknown.md](removed-and-unknown.md) | — | — | dropped by a processing Relay | 200, then dropped |

Names from the task brief that **do not exist** in Relay 26.10.0: `nel` (now an endpoint that makes logs), `otel_span`, `otel_log` (now `integration` items made by the OTLP endpoint), `statsd`, `metric_meta`, `user_report_v2` (the wire name is `feedback`). See [removed-and-unknown.md](removed-and-unknown.md).
