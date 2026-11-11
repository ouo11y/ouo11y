# ClickHouse schema in self-hosted Sentry 26.10.0

Versions: Snuba 26.10.0, ClickHouse `25.8.28.10001.altinitystable`, single node. Observed 2026-11-10 with read-only `clickhouse-client` queries on `sentry-sbx-clickhouse-1`. Every `CREATE TABLE` is in [fixtures/clickhouse-schema/](fixtures/clickhouse-schema/) and every engine line in [fixtures/clickhouse-schema/_engines.tsv](fixtures/clickhouse-schema/_engines.tsv). Migrations live in [`snuba/snuba_migrations/`](https://github.com/getsentry/snuba/tree/26.10.0/snuba/snuba_migrations).

One database, `default`, 49 objects. Single-node self-hosted uses only `*_local` tables (no `*_dist`). There is **no** sessions table, no spans table and no logs table: spans, logs and trace metrics are rows of `eap_items_1_local`; sessions are metrics.

## Tables that hold our data

| Table | Engine | PARTITION BY | ORDER BY | TTL | What |
|---|---|---|---|---|---|
| `errors_local` | ReplacingMergeTree(deleted) | `(retention_days, toMonday(timestamp))` | `(project_id, toStartOfDay(timestamp), primary_hash, cityHash64(event_id))`, SAMPLE BY `cityHash64(event_id)` | `timestamp + retention_days` | one row per error event (`events` topic) |
| `transactions_local` | ReplacingMergeTree(deleted) | `(retention_days, toMonday(finish_ts))` | `(project_id, toStartOfDay(finish_ts), transaction_name, cityHash64(span_id))` | `finish_ts + retention_days` | one row per transaction |
| `replays_local` | ReplacingMergeTree | `(retention_days, toMonday(timestamp))` | `(project_id, toStartOfDay(timestamp), cityHash64(replay_id), event_hash)` | `timestamp + retention_days` | one row per replay segment event, per click/tap action, per error link |
| `replays_aggregated_local` | AggregatingMergeTree (MV `replays_aggregation_mv`) | `(retention_days, toMonday(to_hour_timestamp))` | `(project_id, to_hour_timestamp, replay_id, retention_days)` | `to_hour_timestamp + retention_days` | per replay per hour: counts, started_at, finished_at, min_segment_id, browser/os/device, user |
| `eap_items_1_local` | ReplacingMergeTree | `(retention_days, toMonday(timestamp))` | `(organization_id, project_id, item_type, timestamp, trace_id, item_id)`, PRIMARY KEY `(organization_id, project_id, item_type, timestamp)` | `timestamp + retention_days` | EAP: spans (1), logs (3), trace metrics (8), processing errors (13), … |
| `eap_items_1_downsample_{8,64,512}_local` | ReplacingMergeTree + MVs | same | same | same | 1/8, 1/64, 1/512 samples for fast queries |
| `eap_items_2_*` | ReplacingMergeTree(version) | same | same | same | next-generation EAP table, empty here |
| `eap_item_co_occurring_attrs_*` | Replacing/SummingMergeTree | `(retention_days, toMonday(date))` | `(organization_id, project_id, date, item_type, key_hash, …)` | `date + retention_days` | which attribute keys occur together (UI suggestions) |
| `search_issues_local_v2` | ReplacingMergeTree(deleted) | `(retention_days, toMonday(client_timestamp))` | `(project_id, toStartOfDay(client_timestamp), primary_hash, cityHash64(occurrence_id))` | `client_timestamp + retention_days` | issue platform occurrences: feedback (6001), cron failures (4001), performance issues |
| `group_attributes_local` | ReplacingMergeTree(deleted) | — | `(project_id, group_id)` | none | issue status/assignee mirror |
| `outcomes_raw_local` | MergeTree | `toMonday(timestamp)` | `(org_id, project_id, timestamp)` | **30 days** fixed | every outcome |
| `outcomes_hourly_local` | SummingMergeTree | `toMonday(timestamp)` | `(org_id, project_id, key_id, outcome, reason, timestamp, category)` | **90 days** | hourly sums (Stats page) |
| `outcomes_daily_local_v2` | SummingMergeTree | `toStartOfMonth(timestamp)` | `(org_id, project_id, key_id, outcome, reason, timestamp, category)` | **13 months** | daily sums |
| `metrics_raw_v2_local` | MergeTree | `toStartOfInterval(timestamp, 3 days)` | `(use_case_id, metric_type, org_id, project_id, metric_id, timestamp)` | **7 days** | raw metric buckets (sessions) |
| `metrics_counters_v2_local`, `metrics_sets_v2_local`, `metrics_distributions_v2_local` | AggregatingMergeTree (MVs `*_polymorphic_mv_v4_local`) | `(retention_days, toMonday(timestamp))` | `(use_case_id, org_id, project_id, metric_id, granularity, timestamp, tags.key, tags.value, retention_days)` | `timestamp + retention_days` | release health aggregates |
| `profiles_local` | ReplacingMergeTree | `(retention_days, toMonday(received))` | `(organization_id, project_id, toStartOfDay(received), cityHash64(profile_id))` | `received + retention_days` | transaction profile metadata |
| `profile_chunks_local` | ReplacingMergeTree | `(retention_days, toStartOfDay(start_timestamp))` | `(project_id, profiler_id, start_timestamp, cityHash64(chunk_id))` | `end_timestamp + retention_days` | continuous profiling chunk index |
| `functions_raw_local` → `functions_mv_local` | MergeTree → AggregatingMergeTree | 12 h / week | … | 1 day / retention | profiled function stats |
| `discover_local` | Merge over `errors_local` and `transactions_local` | — | — | — | Discover queries |
| `groupedmessage_local`, `groupassignee_local` | ReplacingMergeTree(offset) | — | — | — | CDC copies of Postgres, empty (no `cdc` consumer) |
| `llm_proxy_cost_raw_local` | MergeTree | month | … | 365 days | not used by us |
| `migrations_local` | ReplacingMergeTree | — | — | — | Snuba migration state |

All tables partition by `retention_days` first, so a project with a different retention lands in other partitions and the TTL drops whole parts.

## `errors_local` columns (summary)

`project_id, timestamp, event_id, platform, environment, release, dist, ip_address_v4/v6, user, user_id, user_name, user_email, sdk_name, sdk_version, http_method, http_referer, tags.key/value, flags.key/value, contexts.key/value, transaction_name, span_id, trace_id, partition, offset, message_timestamp, retention_days, deleted, group_id, primary_hash, hierarchical_hashes, received, message, title, culprit, level, location, version, type, exception_stacks.*, exception_frames.*, sdk_integrations, modules.*, exception_main_thread, trace_sampled, num_processing_errors, replay_id, symbolicated_in_app, …`. Stack frames are flattened into parallel arrays; the full event (breadcrumbs, request, extra) is **not** here, it is in nodestore. Observed row: [fixtures/rows/errors_local-error-event.jsonl](fixtures/rows/errors_local-error-event.jsonl).

## `replays_local` columns (summary)

`replay_id, event_hash, segment_id (UInt16, NULL for non-segment rows), timestamp, replay_start_timestamp, replay_type, error_sample_rate, session_sample_rate, trace_ids, error_ids, urls, title, url, platform, environment, release, dist, ip_address_v4/v6, user, user_id, user_name, user_email, user_geo_*, os_*, browser_*, device_*, ota_updates_*, sdk_name, sdk_version, tags, click_* (node_id, tag, id, class, text, role, alt, testid, aria_label, title, component_name, is_dead, is_rage), tap_message, tap_view_class, tap_view_id, count_errors, count_urls, count_info_events, count_warning_events, count_error_events, info_id, warning_id, error_id, fatal_id, debug_id, is_archived, viewed_by_id, retention_days, partition, offset`.

Row kinds (observed): segment rows (from `replay_event`, `segment_id` set), action rows (clicks/taps parsed by the Sentry task, `click_*` set), event-link rows (`segment_id` NULL, `error_id`/`info_id`/... set, from `post-process-forwarder`), viewed/archived rows. The **recording itself is not in ClickHouse**; see [object-storage.md](object-storage.md). Observed rows: [fixtures/rows/replays_local-web-video-link.jsonl](fixtures/rows/replays_local-web-video-link.jsonl).

## `eap_items_1_local` columns

`organization_id, project_id, item_type (UInt8), timestamp (DateTime, seconds), trace_id (UUID), conversation_id, session_id, ai_conversation_id, item_id (UInt128), sampling_weight, sampling_factor, server_sample_rate, client_sample_rate, retention_days, indexed_name, downsampled_retention_days, attributes_bool Map(String,Bool), attributes_int Map(String,Int64), attributes_string_0..39 Map(String,String), attributes_float_0..39 Map(String,Float64), attributes_array_* Maps, attributes_array JSON, version` plus materialized `_hash_map_*` arrays. String and float attributes are sharded over 40 maps by key hash. 184 columns in total.

`item_type` values (`TraceItemType` from sentry-protos 0.80.0, observed in the Snuba container): 0 unspecified, 1 span, 2 error, 3 log, 4 uptime check, 5 uptime result, 6 replay, 7 occurrence, 8 metric, 9 profile function, 10 attachment, 11 preprod, 12 user session, 13 processing error, 14 workflow engine evaluation. Observed for our project: 1 (9 rows), 3 (4), 8 (2), 13 (16). Sub-second timestamps and span duration are attributes (`sentry.start_timestamp_precise`, `sentry.end_timestamp_precise`, `sentry.duration_ms` in `attributes_float_*`). Rows: [fixtures/rows/eap_items_1_local-span-log-metric.jsonl](fixtures/rows/eap_items_1_local-span-log-metric.jsonl).

## Which API reads which table

| Product / API | Table(s) |
|---|---|
| Issues, issue events, Discover errors | `errors_local` (+ nodestore for the full event) |
| Performance transactions | `transactions_local` |
| Traces, Explore spans/logs/metrics, trace view | `eap_items_1_local` (RPC `EndpointTraceItemTable`, `EndpointGetTrace`, …) |
| Replay list, replay details | `replays_local` / `replays_aggregated_local` |
| Replay recording segments | filestore files, not ClickHouse |
| Feedback list, cron issues | `search_issues_local_v2` |
| Stats / usage | `outcomes_hourly_local`, `outcomes_daily_local_v2` |
| Release health (crash-free) | `metrics_counters_v2_local`, `metrics_sets_v2_local` |
| Profiling | `profiles_local`, `profile_chunks_local`, `functions_mv_local` + seaweedfs `profiles` bucket |

The read-api agent's folder covers the HTTP APIs themselves.
