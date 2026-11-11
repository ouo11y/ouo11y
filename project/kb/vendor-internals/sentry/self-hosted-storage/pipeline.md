# Self-hosted Sentry 26.10.0 ingest pipeline

Versions: self-hosted 26.10.0 (`feature-complete` profile), Relay 26.10.0, Sentry 26.10.0, Snuba 26.10.0, taskbroker 26.10.0, Kafka `confluentinc/cp-kafka:7.6.14`, ClickHouse `25.8.28.10001.altinitystable`, Postgres 18.6, seaweedfs 4.40, Valkey 8.1.10, memcached 1.6.45. Observed on compose project `sentry-sbx` on 2026-11-10 (`docker ps`, `docker inspect` commands, `kafka-consumer-groups --describe --all-groups`), plus source at the tags.

Diagram: [storage-explainer.html](storage-explainer.html).

## Front door

nginx (`:9000`) → `relay:3000` for `/api/store/`, `/api/<id>/...`, `/api/0/relays/`; everything else → `web:9000` (Django API and UI) ([`nginx.conf`](https://github.com/getsentry/self-hosted/blob/26.10.0/nginx.conf)).

Relay runs in processing mode (`processing.enabled: true`, Kafka `kafka:9092`, Redis `redis://redis:6379`, [`relay/config.example.yml`](https://github.com/getsentry/self-hosted/blob/26.10.0/relay/config.example.yml)). It fetches project configs from `web` (`/api/0/relays/projectconfigs/`), which builds them in a taskworker task and caches them in Redis as `relayconfig:<public key>` (observed keys). Quotas are Redis counters. If `taskbroker` is stuck, project configs never arrive and envelopes pile up in Relay (see `project/kb-archive/sentry-self-hosted.md`, "Ingest stuck").

## Relay → Kafka

Topic per item, from `StoreService` ([`relay-server/src/services/store.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/services/store.rs)) and default names in [`relay-kafka/src/config.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-kafka/src/config.rs):

| Data | Relay topic | Message format |
|---|---|---|
| error / default / security event without attachments | `ingest-events` | msgpack `{type: event, payload, event_id, project_id, org_id, start_time, remote_addr, attachments}` |
| error with attachments or user reports; attachment chunks; standalone attachments; `user_report` | `ingest-attachments` | msgpack `event`, `attachment_chunk`, `attachment`, `user_report` |
| transaction | `ingest-transactions` | msgpack `event` |
| feedback (`feedback` item) | `ingest-feedback-events` | msgpack `event` |
| spans (standalone, from transactions, OTLP) | `ingest-spans` | JSON span v2 |
| logs, trace metrics, NEL | `snuba-items` | protobuf `TraceItem` |
| replay segment (+ replay event + video) | `ingest-replay-recordings` | msgpack `replay_recording_not_chunked` |
| profile, profile chunk | `profiles` | msgpack |
| check-in | `ingest-monitors` | msgpack |
| session metrics | `ingest-metrics` | JSON metric bucket |
| outcomes | `outcomes`, `outcomes-billing` | JSON |

## Consumers (who reads what)

Observed consumer groups and the container that runs them:

| Topic | Group | Runs in | Does |
|---|---|---|---|
| `ingest-events` | `ingest-consumer` | `events-consumer` (`sentry run consumer ingest-events`) | caches the event, schedules `save_event` (taskworker): grouping, nodestore write, Postgres group, then produces to `events` |
| `ingest-attachments` | `ingest-consumer` | `attachments-consumer` | same plus attachments and user reports |
| `ingest-transactions` | `ingest-consumer` | `transactions-consumer` | save transaction → nodestore + `transactions` topic |
| `ingest-feedback-events` | `ingest-feedback` | `ingest-feedback-events` | feedback → issue platform occurrence |
| `ingest-occurrences` | `ingest-occurrences` | `ingest-occurrences` | issue platform occurrences → `generic-events` |
| `ingest-monitors` | `ingest-monitors` | `ingest-monitors` | cron check-ins → Postgres |
| `ingest-metrics` | `metrics-consumer` | `metrics-consumer` | string indexer → `snuba-metrics` |
| `ingest-spans` | `process-spans` | `process-spans` | buffers spans per trace/segment in Redis, flushes segments (`buffered-segments`), enriches → `snuba-items` |
| `ingest-replay-recordings` | `ingest-replay-recordings` | **`taskbroker`** (raw mode) → task `sentry.replays.tasks.process_replay_recording` in `taskworker` | writes the segment blob, publishes `ingest-replay-events` |
| `profiles` | `ingest-profiles-consumers-0` | **`taskbroker`** raw mode → `sentry.profiles.task.process_profile_from_kafka` | symbolicate, send to vroom |
| `events-/transactions-/metrics-subscription-results`, `subscription-results-eap-items` | various | **`taskbroker`** raw mode | alert subscriptions |
| `taskworker` | `taskworker` | `taskbroker` | all Celery-replacement tasks |
| `events` | `snuba-consumers` | `snuba-errors-consumer` | `errors_local` |
| `transactions` | `transactions_group` | `snuba-transactions-consumer` | `transactions_local` |
| `generic-events` | `generic_events_group` | `snuba-issue-occurrence-consumer` | `search_issues_local_v2` |
| `ingest-replay-events` | `snuba-consumers` | `snuba-replays-consumer` | `replays_local` |
| `snuba-items` | `eap_items_group` | `snuba-eap-items-consumer` | `eap_items_1_local` |
| `snuba-items` | `accepted_outcomes` | `snuba-outcomes-accepted-consumer` | accepted outcomes for EAP items |
| `outcomes`, `outcomes-billing` | `snuba-consumers` | `snuba-outcomes-consumer`, `-billing-consumer` | `outcomes_raw_local` |
| `snuba-metrics` | `snuba-metrics-consumers` | `snuba-metrics-consumer` | `metrics_raw_v2_local` |
| `group-attributes` | `snuba-group-attributes-consumers` | `snuba-group-attributes-consumer` | `group_attributes_local` |
| `processed-profiles`, `profiles-call-tree`, `snuba-profile-chunks` | `snuba-consumers` | `snuba-profiling-*` | `profiles_local`, `functions_raw_local`, `profile_chunks_local` |
| `event-replacements` | `snuba-replacers` | `snuba-replacer` | merges, deletes, reprocessing of errors |
| `events`, `transactions`, `generic-events` (+ commit logs) | `post-process-forwarder` | `post-process-forwarder-*` | after Snuba commit: alerts, workflows, replay links, ownership |

Snuba storage ↔ topic ↔ table (read: storage YAMLs under [`snuba/datasets/configuration/`](https://github.com/getsentry/snuba/tree/26.10.0/snuba/datasets/configuration)): `errors`←`events`→`errors_local`; `transactions`←`transactions`→`transactions_local`; `replays`←`ingest-replay-events`→`replays_local`; `eap_items`←`snuba-items`→`eap_items_1_local`; `search_issues`←`generic-events`→`search_issues_local_v2`; `outcomes_raw`←`outcomes`→`outcomes_raw_local`; `metrics_raw`←`snuba-metrics`→`metrics_raw_v2_local`; `profiles`←`processed-profiles`; `functions_raw`←`profiles-call-tree`; `profile_chunks`←`snuba-profile-chunks`; `group_attributes`←`group-attributes`; `groupedmessages`/`groupassignees`←`cdc` (no consumer running; tables empty).

## Stores

| Store | Container / volume | Holds | Detail |
|---|---|---|---|
| ClickHouse | `clickhouse` / `sentry-clickhouse` | every searchable row: errors, transactions, replays (metadata), EAP (spans, logs, trace metrics, processing errors), outcomes, session metrics, profiles index, issue platform | [clickhouse-schema.md](clickhouse-schema.md) |
| Nodestore | `seaweedfs` bucket `nodestore` (S3, zstd) | full event JSON of errors, transactions, feedback | [nodestore-postgres.md](nodestore-postgres.md) |
| Postgres | `postgres` / `sentry-postgres` | projects, keys, releases, groups (issues), grouphash, user reports, attachments metadata (and small attachments inline), monitors, string indexer | [nodestore-postgres.md](nodestore-postgres.md) |
| Filestore | `sentry-data` volume at `/data/files` in `web`, `taskworker` and all `sentry` containers | replay segments, larger attachments, release files | [object-storage.md](object-storage.md) |
| seaweedfs | `sentry-seaweedfs` | buckets `nodestore`, `profiles` | [object-storage.md](object-storage.md) |
| Redis (Valkey) | `sentry-redis` | Relay project configs, quotas, span buffer, event processing cache, taskworker schedules, digests, monitors volume history | — |
| memcached | — | Django cache (`default` cache) | — |
| symbolicator, vroom | own volumes | symbol caches, profiles (vroom writes profiles to the seaweedfs `profiles` bucket) | — |

## Outcomes

Every accepted or dropped unit produces an outcome on `outcomes`/`outcomes-billing` → `outcomes_raw_local` (and hourly/daily summing tables). For our test project the table showed accepted rows per category plus `invalid` reasons (`too_large:<item>`, `invalid_compression`, `invalid_minidump`, `invalid_replay_missing_recording`, `invalid_replay_video`, `invalid_monitor`, `invalid_json`, `profiling_invalid_json`, `project_id`), `filtered` `invalid-csp`, `rate_limited` `key_quota`, and `client_discard` from client reports ([fixtures/rows/outcomes_raw_local-step6-wire.jsonl](fixtures/rows/outcomes_raw_local-step6-wire.jsonl)). This is the only place where "200 but not stored" becomes visible. Exception: a gzip replay recording body was dropped by the Sentry task with no outcome.
