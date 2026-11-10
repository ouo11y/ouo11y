# PostHog storage: Kafka topics, ClickHouse tables, replay blobs, retention

- **PostHog server:** `PostHog/posthog` main at commit `d231ab1719020024c6219d10dc7775f6621fd72c` (2026-11-10T02:55Z).
- **Method:** read from source (sparse checkout). No PostHog instance was run, because Docker memory is taken by self-hosted Sentry (Step 6 rules).
- **Date:** 2026-11-10.
- **Source key:** `ph:` = `https://github.com/PostHog/posthog/blob/d231ab1719020024c6219d10dc7775f6621fd72c/`. *(inferred)* marks interpretation.

## 1. Ingestion path

| Stage | What happens | Source |
|---|---|---|
| rust/capture | Validates the token, decompresses, splits by event name, writes to Kafka | ph:rust/capture/src/router.rs, v0_request.rs L230-239 |
| Kafka topics | Listed in the next table | ph:rust/capture/src/config.rs L512-609 |
| Analytics ingestion | Node ingestion pipeline (`nodejs/src/ingestion`): person processing, then ClickHouse `events` | ph:nodejs/src/ingestion/ |
| Replay ingestion | Node `session-recordings-blob-v2` consumer → S3 blocks plus `session_replay_events` metadata | ph:nodejs/src/ingestion/pipelines/sessionreplay/ |
| Errors | `ingestion-errortracking-main` → "cymbal" (Rust, `rust/cymbal`, not read) does symbolication and fingerprinting *(inferred from the topic and dir names)* | config.rs L575-579 |

Kafka topics written by capture:

| Topic | Content |
|---|---|
| `events_plugin_ingestion` (overflow `_overflow`, historical `_historical`) | Analytics |
| `session_recording_snapshot_item_events` (overflow `session_recording_snapshot_item_overflow`) | Replay. Keyed by session id. Optional lz4 envelope (`KAFKA_REPLAY_ENVELOPE_COMPRESSION`, default `none`) |
| `ingestion-errortracking-main` | `$exception` |
| `heatmaps_ingestion` | `$$heatmap` |
| `ingestion-clientwarnings-main-1` | `$$client_ingestion_warning` |
| `events_plugin_ingestion_ai` | `$ai_*` |
| `events_plugin_ingestion_dlq` | Dead letter |

Replay overflow: a Redis limiter keyed by session id reroutes very busy sessions to the overflow topic (ph:rust/capture/src/events/recordings.rs L535-559).

## 2. Events in ClickHouse

Source: ph:posthog/models/event/sql.py.

- **Columns** (L121-202):
  - `uuid`, `event`, `properties` (JSON string, ZSTD(3)), `timestamp DateTime64(6,'UTC')`, `team_id`, `distinct_id`, `elements_chain`, `created_at`
  - Person columns: `person_id`, `person_properties`, `person_created_at`, `person_mode`
  - `group0..4_properties` / `_created_at`
  - Materialized columns: `$session_id`, `$session_id_uuid`, `$window_id`, `$group_0..4`, `elements_chain_*`, `dmat_string_0..9`
  - Kafka `_timestamp` / `_offset`, `inserted_at`
- **`sharded_events`:** `ReplacingMergeTree(_timestamp)`, `PARTITION BY toYYYYMM(timestamp)`, `ORDER BY (team_id, toDate(timestamp), event, cityHash64(distinct_id), cityHash64(uuid))`, `SAMPLE BY cityHash64(distinct_id)` (L221-222, L344-364).
- **`events` / `writable_events`:** Distributed tables, sharded by `sipHash64(distinct_id)` (L774-797).
- **No TTL on `events`.** Only `sharded_events_recent` has one, 9 days (L710-718).

All properties live in one JSON string column. Fast filters come from materialized columns (`mat_*` / `dmat_*`). This is the opposite of an OTel-style typed attribute map *(inferred design note)*.

## 3. Sessions in ClickHouse

- **`raw_sessions_v3`** (ph:posthog/models/raw_sessions/sessions_v3.py):
  - Engine: `AggregatingMergeTree`, `PARTITION BY toYYYYMM(session_timestamp)`, `ORDER BY (team_id, session_timestamp, session_id_v7)` (L193-235).
  - `session_id_v7` is the UUIDv7 `$session_id` stored as `UInt128`, so the session start time is inside the id.
- **Aggregate columns** (L88-190):
  - Identity and time: `distinct_id(s)`, `min/max_timestamp`
  - URLs: `urls`, `entry`/`end`/`last_external_click_url`
  - Client: browser, OS, device, viewport
  - Geo: `geoip_*`
  - Attribution: `entry_utm_*`, gclid/fbclid
  - Counters: `pageview`/`autocapture`/`screen` unique counts
  - Other: `flag_key_values`, `event_names`, `hosts`, `emails`, `has_replay_events`
- **Filled by materialized views:**
  - `raw_sessions_v3_mv` reads `sharded_events`. It only accepts valid UUIDv7 session ids within ±31 days (L421-455).
  - `raw_sessions_v3_recordings_mv` reads `sharded_session_replay_events` and sets `has_replay_events` (L555-672).
- **HogQL `sessions` virtual table** (ph:posthog/hogql/database/schema/sessions_v3.py L90-185):
  - Time: `$start_timestamp`, `$end_timestamp`, `$session_duration`
  - Entry: `$entry_current_url`, `$entry_pathname`
  - End and exit: `$end_*`, `$exit_*`
  - Counts and flags: `$pageview_count`, `$autocapture_count`, `$screen_count`, `$is_bounce`, `$has_replay_events`
  - Attribution: `$channel_type`
- **Older generations still in the tree:** `raw_sessions` v2 (sessions_v2.py) and `sessions` v1 (posthog/models/sessions/sql.py).

**There is no session row written by the client.** A session is purely an aggregation over events by `$session_id`.

## 4. Replay storage

### Consumer and blocks

Source: ph:nodejs/src/ingestion/pipelines/sessionreplay/.

1. The consumer group `session-recordings-blob-v2` reads `session_recording_snapshot_item_events`.
2. It parses messages, with lz4/gzip value support capped at 64 MB.
3. Messages without `$snapshot_items` or `$session_id`, or whose header and body ids do not match, go to the DLQ (`session_recording_snapshot_item_dlq`) (parse-message-step.ts L27-85, L260-331).
4. Events are grouped per session into a **block**: newline-delimited JSON where every line is `[windowId, rrwebEvent]` (sessions/session-block-recorder.ts L77-95, L181).
5. Blocks are compressed with **snappy** by default (brotli is supported) and may be **encrypted with a per-session key** (sessions/block-compression.ts L7-9; session-block-recorder.ts L101, L335).
6. **The batch is flushed** when it reaches 100 MB (`SESSION_RECORDING_MAX_BATCH_SIZE_KB`; 2 MB in dev) or is 10 s old (`SESSION_RECORDING_MAX_BATCH_AGE_MS`) (session-batch-manager.ts L117-119; config.ts L143-144).

### Object storage layout

- **One S3 object per flush**, written by multipart upload, holding many sessions' blocks back to back.
- **Key:** `{prefix}/{retentionPeriod}/{Date.now()}-{16 hex}`. The prefix defaults to `session_recordings` and the bucket to `posthog` (s3-session-batch-writer.ts L157-162; retention-aware-batch-writer.ts L71-80; config.ts L145-146).
- **Each block is addressed by a byte range:** `s3://posthog/session_recordings/30d/1794…-a1b2…?range=bytes=1024-8191` (s3-session-batch-writer.ts L110-129).
- **Retention prefixes:** `30d`, `90d`, `1y`, `5y`. *(inferred)* Expiry is a bucket lifecycle rule per prefix, configured outside the repo.
- **Dev defaults:** SeaweedFS at `http://localhost:8333` or `http://seaweedfs:8333` (config.ts L147; ph:posthog/settings/session_replay_v2.py L8-27). The older generic object storage settings use a MinIO-style `objectstorage:19000` (ph:posthog/settings/object_storage.py L8-25).

### `session_replay_events` (metadata only)

Source: ph:posthog/session_recordings/sql/session_replay_event_sql.py.

- **One Kafka row per block** goes to `clickhouse_session_replay_events` (shared/metadata/session-metadata-store.ts L20-50).
- **The table** is an `AggregatingMergeTree`, sharded.
  - `PARTITION BY toYYYYMM(min_first_timestamp)`, `ORDER BY (toDate(min_first_timestamp), team_id, session_id)`, `index_granularity = 512` (L117-143).
  - Written through a Distributed table sharded by `sipHash64(distinct_id)` (L252-274).

| Column | Aggregate | Meaning |
|---|---|---|
| `session_id`, `team_id`, `distinct_id` | key | |
| `min_first_timestamp`, `max_last_timestamp` | min / max | Recording span |
| `block_first_timestamps`, `block_last_timestamps`, `block_urls` | groupArrayArray | **The block index.** Each `block_url` is an S3 URL with a byte range |
| `first_url`, `all_urls` | argMin / groupUniqArrayArray | |
| `click_count`, `keypress_count`, `mouse_activity_count`, `active_milliseconds` | sum | Activity, computed at ingestion from plain-JSON rrweb events (one reason posthog-js does not gzip those) |
| `console_log_count`, `console_warn_count`, `console_error_count` | sum | From `rrweb/console@1` |
| `size`, `message_count`, `event_count` | sum | |
| `snapshot_source`, `snapshot_library`, `snapshot_mode_v2` | argMin | `web` / `mobile`. Mode = `screenshot` or `wireframe` |
| `retention_period_days` | max | |
| `is_deleted` | max | Deletion marker |
| `ai_tags_*`, `ai_highlighted`, `surfacing_score` | — | AI summaries |

**No TTL in the current DDL.** Migration 0140 added one and migration 0145 removed it (session_replay_event_migrations_sql.py L225-233; ph:posthog/clickhouse/migrations/0145_session_replay_events_fix_retention_type.py L24-29).

## 5. Retention and deletion

- **Team setting `session_recording_retention_period`:** `30d` / `90d` / `1y` / `5y`. Default `30d`, and **`5y` for self-hosted** (non-cloud) teams (ph:posthog/models/team/team.py L139-144, L274-278, L438-446). Days are 30 / 90 / 365 / 1825 (ph:posthog/session_recordings/data_retention.py L3-13).
- **At ingestion**, the retention period picks the S3 prefix and is stamped on every metadata row (retention-aware-batch-writer.ts L27-47).
- **Deleting a recording:**
  - API `destroy` or `bulk_delete` (max 100 per call) → recording-api `POST /api/projects/:team_id/recordings/delete`.
  - That **deletes the per-session encryption key** (crypto-shredding) and writes `is_deleted = 1` metadata rows (ph:posthog/session_recordings/session_recording_api.py L1385-1430, L1878-1900; ph:nodejs/src/session-replay/recording-api/recording-api.ts L324; recording-service.ts L434-505).
- **Events:** no ClickHouse TTL. Deletion goes through person or data deletion jobs (not read).

## Remote config built server-side

`ph:posthog/models/remote_config.py` builds what `/array/{token}/config` returns. `posthog/api/decide.py` is gone at this commit.

- **Top-level keys** (`build_config`, L268-324):
  - `supportedCompression: ["gzip","gzip-js"]`
  - `hasFeatureFlags`
  - `captureDeadClicks`
  - `capturePerformance`
  - `autocapture_opt_out`
  - `autocaptureExceptions`
  - `analytics.endpoint`
  - `elementsChainAsString`
  - `errorTracking`
  - `logs`
  - `sessionRecording`
  - `quotaLimited`
- **`sessionRecording` keys** (L126-248):
  - Base: `endpoint: "/s/"`, `consoleLogRecordingEnabled`, `recorderVersion: "v2"`, `minimumDurationMilliseconds`, `networkPayloadCapture`, `masking`, `urlBlocklist`, `scriptConfig`, `domains`, `recordCanvas`, `canvasFps` (3), `canvasQuality` (`"0.4"`).
  - V1: `sampleRate` (a string, or null for 100%), `linkedFlag`, `urlTriggers`, `eventTriggers`, `triggerMatchType`, `version: 1`.
  - V2: `version: 2` plus `triggerGroups`.
