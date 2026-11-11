# Kafka topics in self-hosted Sentry 26.10.0

Observed 2026-11-10 on `sentry-sbx-kafka-1` (`confluentinc/cp-kafka:7.6.14`, KRaft, one broker): `kafka-topics --list` returned **83 topics**, every one with **1 partition** and replication factor 1. Full list with per-topic configs: [fixtures/kafka-topics.tsv](fixtures/kafka-topics.tsv). Consumer groups: [pipeline.md](pipeline.md#consumers-who-reads-what).

## Retention

- Broker default `KAFKA_LOG_RETENTION_HOURS=3` (container env). Topics without their own `retention.ms` keep data about **3 hours** (Relay topics such as `ingest-events`, `ingest-replay-recordings`, `ingest-spans`, `profiles`, `taskworker`).
- Snuba-created topics set their own config: most `retention.ms=86400000` (1 day), dead-letter topics and `event-replacements` 7 days, commit logs compacted.
- `max.message.bytes` 50 MB on most topics; `events`/`transactions` 25 MB, `snuba-items`, `snuba-metrics`, `ingest-replay-events` 10 MB. Relay's producer sets `message.max.bytes: 50000000` ([`relay/config.example.yml`](https://github.com/getsentry/self-hosted/blob/26.10.0/relay/config.example.yml)).

Kafka is a buffer, not a store: replaying from Kafka is possible only within these windows.

## Topics by role

| Role | Topics |
|---|---|
| Relay → Sentry ingest | `ingest-events`, `ingest-attachments`, `ingest-transactions`, `ingest-feedback-events`, `ingest-monitors`, `ingest-metrics`, `ingest-replay-recordings`, `ingest-spans`, `profiles`, `outcomes`, `outcomes-billing` |
| Relay → Snuba directly | `snuba-items` (logs, trace metrics) |
| Sentry → Snuba | `events`, `transactions`, `generic-events`, `ingest-replay-events`, `snuba-metrics`, `processed-profiles`, `profiles-call-tree`, `snuba-profile-chunks`, `group-attributes`, `event-replacements`, `snuba-items` (spans after `process-spans`, replay trace items) |
| Span buffering | `buffered-segments`, `buffered-segments-dlq` |
| Issue platform | `ingest-occurrences`, `generic-events`, `monitors-incident-occurrences` |
| Snuba commit logs (post-process sync) | `snuba-commit-log`, `snuba-transactions-commit-log`, `snuba-generic-events-commit-log`, `snuba-metrics-commit-log`, `snuba-items-commit-log`, `snuba-eap-spans-commit-log`, `snuba-generic-metrics-counters-commit-log` |
| Alert subscriptions | `scheduled-subscriptions-*`, `*-subscription-results`, `subscription-results-eap-items`, `eap-spans-subscription-results` |
| Tasks | `taskworker`, `taskworker-control`, `taskworker-dlq` |
| Crons | `monitors-clock-tick`, `monitors-clock-tasks` |
| Uptime | `uptime-results`, `snuba-uptime-results` |
| Dead letters | `*-dlq`, `snuba-dead-letter-*` |
| Deletes / mutations | `snuba-lw-deletions-eap-items`, `snuba-lw-deletions-generic-events`, `snuba-eap-mutations` |
| Other | `cdc`, `ingest-events-backlog`, `ingest-transactions-backlog`, `ingest-performance-metrics`, `ingest-generic-metrics-dlq`, `snuba-generic-metrics`, `snuba-ourlogs`, `snuba-queries`, `snuba-llm-proxy-cost`, `shared-resources-*`, `__consumer_offsets` |

Present but with no consumer group observed: `snuba-ourlogs` (logs now go through `snuba-items`), `snuba-generic-metrics`, `ingest-performance-metrics`, `cdc` (Relay drops span/transaction metrics, see [../wire-format/item-types/spans-logs-metrics.md](../wire-format/item-types/spans-logs-metrics.md#metric_buckets)).

## Messages we sampled (observed, payloads not committed)

Read with `kafka-console-consumer --partition 0 --offset <end-1> --max-messages 1` (no consumer group created):

- `ingest-replay-recordings`: msgpack map keys `type` (`replay_recording_not_chunked`), `replay_id`, `key_id`, `org_id`, `project_id`, `received`, `retention_days`, `payload` (`{"segment_id":N}\n` + zlib), `replay_event` (JSON), `replay_video`, `relay_snuba_publish_disabled`.
- `ingest-replay-events`: JSON `{"type":"replay_event","start_time":...,"replay_id":...,"project_id":...,"segment_id":null,"retention_days":90,"payload":{"type":"event_link","replay_id":...,"event_hash":...,"timestamp":...,"error_id":...}}` (an error-to-replay link).
- `snuba-items`: protobuf `TraceItem` (sentry-protos 0.80.0 in the Snuba image).
