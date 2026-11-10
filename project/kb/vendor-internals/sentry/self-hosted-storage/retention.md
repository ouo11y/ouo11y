# Retention in self-hosted Sentry 26.10.0

Versions: self-hosted 26.10.0, Sentry/Relay/Snuba 26.10.0. Researched 2026-11-10. Our instance: `SENTRY_EVENT_RETENTION_DAYS=90` (`.env.custom`).

## Where the number comes from

`SENTRY_EVENT_RETENTION_DAYS` → Sentry option `system.event-retention-days` → project config `eventRetention` → Relay stamps `retention_days` on every Kafka message (default 90 when unset, `DEFAULT_EVENT_RETENTION` in [`constants.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/constants.rs)) → Snuba writes it into the `retention_days` column and the partition key. Observed: every row we wrote has `retention_days = 90`; replay files live under `90/`.

## Per store

| Store | Mechanism | Effective retention here |
|---|---|---|
| ClickHouse `errors`, `transactions`, `replays`, `eap_items*`, `search_issues`, `profiles`, `profile_chunks`, `metrics_*_v2` | table TTL `timestamp + toIntervalDay(retention_days)`; parts drop when the whole `(retention_days, week)` partition expires | 90 days (plus up to a week of partition granularity) |
| `outcomes_raw_local` | fixed TTL | 30 days |
| `outcomes_hourly_local` | fixed TTL | 90 days |
| `outcomes_daily_local_v2` | fixed TTL | 13 months |
| `metrics_raw_v2_local` | fixed TTL | 7 days (aggregates keep 90) |
| `functions_raw_local` | fixed TTL | 1 day |
| `group_attributes_local`, `groupedmessage_local` | none | until deleted |
| Nodestore (seaweedfs `nodestore`) | S3 lifecycle `Expiration.Days = SENTRY_EVENT_RETENTION_DAYS`, installed by [`install/bootstrap-s3-nodestore.sh`](https://github.com/getsentry/self-hosted/blob/26.10.0/install/bootstrap-s3-nodestore.sh); `sentry cleanup` calls `nodestore.cleanup()`, a no-op for this backend | 90 days (lifecycle rule not inspected on our bucket) |
| Postgres groups, releases, user reports, check-ins, replay segment rows | `sentry cleanup --days 90` (cron in `sentry-cleanup` container, `0 0 * * *`, [`docker-compose.yml`](https://github.com/getsentry/self-hosted/blob/26.10.0/docker-compose.yml)): deletes by `date_added`/`last_seen` older than `--days` ([`runner/commands/cleanup.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/runner/commands/cleanup.py)) | 90 days |
| Attachments (`sentry_eventattachment`) | `date_expires` (set to receive time + retention, observed +90 days); cleanup deletes expired rows and their blobs | 90 days |
| **Replay segment files** (`/data/files/<retention>/...`) | written by key with `storage_kv`; no Postgres row, no TTL on the filesystem backend; `sentry cleanup` deletes `ReplayRecordingSegment` rows only (empty here) | **not deleted by any job we found** (inference from source; the `90/` prefix exists for bucket lifecycle rules on GCS/S3). Unverified over time |
| Kafka | broker `log.retention.hours=3`, Snuba topics 1 or 7 days | hours to days |
| Redis | per-key TTLs (project configs, quotas, span buffer) | minutes to hours |
| symbolicator caches | `symbolicator-cleanup --repeat 1h` | symbolicator config |

## Replay retention specifically

- `replays_local` and `replays_aggregated_local`: 90 days by TTL.
- Segment blobs: see the row above. In SaaS, GCS lifecycle on the `30/`, `60/`, `90/` prefixes does it (StorageBlob docstring, [`replays/lib/storage.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/lib/storage.py)).
- Deleting a replay through the API runs `delete_recording_async` (task in [`replays/tasks.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/tasks.py)) which deletes the blobs and writes deletion rows.

For Muninn reading through Sentry's API: a replay listed in `replays_local` will always have segments for 90 days; after that the list entry disappears even if the files remain.
