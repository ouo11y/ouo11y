# Self-hosted storage fixtures

Observed 2026-11-10 on self-hosted Sentry 26.10.0 (`sentry-sbx`), read-only. IP addresses replaced by `0.0.0.0`.

| Path | What it is |
|---|---|
| [clickhouse-schema/](clickhouse-schema/) | `SHOW CREATE TABLE` for all 49 objects of database `default`, one `.sql` per table, plus `_engines.tsv` (engine, partition, order, TTL per table) |
| [kafka-topics.tsv](kafka-topics.tsv) | All 83 Kafka topics with partition count and per-topic configs |
| [nodestore-error-event.json](nodestore-error-event.json) | One error event as stored in the seaweedfs `nodestore` bucket, decoded (default value + `unprocessed` subkey) |
| [replay-segment-0-decoded.json](replay-segment-0-decoded.json) | A web replay segment file from `/data/files`, inflated |
| [replay-video-segment-0-decoded.json](replay-video-segment-0-decoded.json) | A video replay segment file, inflated and unpacked |
| [rows/errors_local-error-event.jsonl](rows/errors_local-error-event.jsonl) | The `errors_local` row of the followed error |
| [rows/transactions_local-transaction.jsonl](rows/transactions_local-transaction.jsonl) | One `transactions_local` row |
| [rows/replays_local-web-video-link.jsonl](rows/replays_local-web-video-link.jsonl) | `replays_local` rows: web segments, video segment, error link |
| [rows/eap_items_1_local-span-log-metric.jsonl](rows/eap_items_1_local-span-log-metric.jsonl) | EAP rows: spans, logs, trace metrics (attribute maps merged) |
| [rows/outcomes_raw_local-step6-wire.jsonl](rows/outcomes_raw_local-step6-wire.jsonl) | Every outcome of the test project |
