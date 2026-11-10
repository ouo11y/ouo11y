# Profiles and cron check-ins: profile, profile_chunk, check_in

Versions: Relay 26.10.0, Sentry 26.10.0, vroom 26.10.0. Researched 2026-11-10.

## `profile` (transaction profiles, v1)

A Sample-format profile tied to one transaction. Requires an envelope `event_id`; normally sent in the same envelope as its `transaction`. Header may carry `sampled: false` when the transaction was sampled out. Parsed and validated by `relay-profiling` ([`relay-profiling/src/`](https://github.com/getsentry/relay/tree/26.10.0/relay-profiling/src)): platforms Android (legacy format), Cocoa, JavaScript, Node, Python, PHP, Rust and others; max 50 MiB. Categories `profile`, `profile_indexed`, plus `profile_backend` or `profile_ui`. Kafka `profiles` (msgpack), consumed in self-hosted by **taskbroker raw mode** (`sentry.profiles.task.process_profile_from_kafka`, [`taskbroker/config.yml`](https://github.com/getsentry/self-hosted/blob/26.10.0/taskbroker/config.yml)), which symbolicates and hands the profile to **vroom**; vroom writes the blob to the seaweedfs bucket `profiles` and metadata to `processed-profiles` / `profiles-call-tree` → `profiles_local` / `functions_raw_local`. Not tested by us.

## `profile_chunk` (continuous profiling, v2)

Header `platform` decides the category: backend platforms `profile_chunk`, UI platforms (`cocoa`, `android`, `javascript`, ...) `profile_chunk_ui`; with no `platform` header the item has no category. `profile_chunk_ui` is accepted as an alias type name (Android SDK 8.10/8.11 sent it). Payload: `{version: "2", chunk_id, profiler_id, platform, release, environment, client_sdk, debug_meta, profile: {samples[], stacks[], frames[], thread_metadata{}}, measurements}`. Kafka `profiles` → vroom → `snuba-profile-chunks` → `profile_chunks_local`. Observed: our minimal chunk got 200 and then `invalid` `profiling_invalid_json` (category 26), so it needs real samples.

## `check_in` (cron monitors)

`CheckIn` in [`relay-monitors/src/lib.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-monitors/src/lib.rs):

| Key | Notes |
|---|---|
| `check_in_id` | UUID; reuse it to close an `in_progress` check-in |
| `monitor_slug` | normalized to a slug (max 50 chars) |
| `status` | `ok`, `error`, `in_progress`, `missed`, `unknown` |
| `environment` | |
| `duration` | seconds |
| `monitor_config` | upsert config: `schedule {type: crontab|interval, value, unit}`, `checkin_margin`, `max_runtime`, `timezone`, `failure_issue_threshold`, `recovery_threshold`, `owner` |
| `contexts.trace.trace_id` | links the check-in to a trace |

Limit 100 KiB. Category `monitor`. Kafka `ingest-monitors` → `ingest-monitors` consumer → Postgres `sentry_monitor`, `sentry_monitorcheckin`; misses are detected by `monitors-clock-tick`/`-tasks` and become issue occurrences (type 4001). Observed: our check-in with `monitor_config` auto-created monitor `step6-wire-cron` (1 check-in row); later a "missed check-in" occurrence appeared in `search_issues_local_v2`. The HTTP form `/api/{id}/cron/{slug}/{key}/?status=ok` got 202 but, without a config, no monitor was created (outcome `invalid_monitor`).
