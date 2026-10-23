# Data lifecycle: retention, deletion, redaction (Loki 3.7.7, Tempo 3.0.3, Mimir 3.2.1)

Learned while building roadmap 8b (2026-10-23, `docs/operations/data-lifecycle.md`). Verified on an
`ouo-env` unless marked otherwise.

## Loki

- `-config.expand-env=true` expands `${...}` **in comments too**: a comment containing `${OUO_*}`
  stops Loki at start-up with `failed parsing config: missing closing brace`. Write "the OUO_*
  variables" in comments.
- Retention needs `compactor.retention_enabled: true` and, since 3.x, `compactor.delete_request_store`
  (`filesystem` for the single binary); without the store Loki refuses to start. `limits_config.retention_period`
  is the default, `retention_stream` entries (stream-label selectors only, at least 24h) override it.
  Per-tenant `retention_stream` in the runtime config file works without a restart; the tenant
  is `fake` with `auth_enabled: false` (`loki_runtime_config_last_reload_successful` confirms the reload;
  `GET /runtime_config` answered 404 on 3.7.7 single binary).
- Delete API (`POST /loki/api/v1/delete?query=&start=&end=`, compactor): `start=0` is rejected
  (`invalid start time`), and requests are sharded by `compactor.delete_max_interval` (24h), so a
  1970 start would create ~20k shards. rum-api uses the log retention plus a day.
- Delete queries accept structured-metadata label filters: `{service_name=~".+"} | ouo_project_id="demo" | user_id="u"`
  removed exactly that user's lines (`loki_compactor_deleted_lines` 6 = 2 sessions x 3) and kept
  another user's lines in the same streams.
- Timing: the request stays `received` for `delete_request_cancel_period` (default 24h), then the
  compactor processes it on its next `compaction_interval` run and marks it `processed`; the lines
  were gone from queries at that point. With 1m / 1m it took 3 minutes end to end.
- Old-timestamp lines (30h old, accepted because `reject_old_samples_max_age` is 168h) are not
  queryable until flushed (`query_ingesters_within` 3h): `POST /flush`.
- Retention removes the chunks from storage at compaction (`loki_boltdb_shipper_retention_marker_count_total{table=...}`
  counts the marked chunks; the files were gone from `/loki/chunks` a minute later with
  `retention_delete_delay: 1m`), but the single binary kept answering queries for those lines
  from its embedded chunk cache (on by default, 100 MB) and the ingester's local copy of the
  index table until Loki restarted. Delete requests do not have this lag: the querier filters
  their lines itself. Plan retention as "gone from storage at compaction, gone from queries
  once the cache turns over".
- Promoting `ouo.project.id` to the `ouo_project_id` stream label (one value per project) is what
  makes per-project `retention_stream` possible; structured metadata cannot be selected there.

## Tempo 3.0

- Retention is `block_retention` under `backend_scheduler.provider.compaction.compaction` and
  `backend_worker.compaction` (both exist, both default 336h); the 2.x `compactor:` block is gone.
- No delete API. `tempo-cli redact --tenant=single-tenant --trace-id=<id>... tempo:9095`
  (image `grafana/tempo-cli:3.0.3`, gRPC to the single binary's 9095) works on the **local**
  backend: one `JOB_TYPE_REDACTION` job, `SUCCEEDED` in `/status/backendscheduler`.
- A redacted trace still answers `GET /api/v2/traces/<id>` with **200** and `{"trace":{},...}`:
  check the span count, not the status code. Search (`{ span.session.id = "..." }`) no longer
  finds it. Verified on traces 3 minutes old at redaction time.
- Query-based redaction (by attribute) is Tempo 3.1.

## Mimir

- `limits.compactor_blocks_retention_period` takes Go or Prometheus durations; `/config` prints
  `2160h` back as `90d`.

## S3 lifecycle (MinIO, AWS)

- Lifecycle rules cannot exclude a key, so a prefix rule on `replays/` would also expire
  `replays/schema.json` (the upgrade guard). Filter by an object tag instead (`ouo-retention=<n>d`),
  which also gives per-project rules. `PutObject` with `UserTags` needs `s3:PutObjectTagging`
  on AWS; managing rules needs `s3:Get/PutLifecycleConfiguration`.
- minio-go `GetBucketLifecycle` on a bucket without rules returns `NoSuchLifecycleConfiguration`;
  `SetBucketLifecycle(nil)` removes all rules.

## Sampling hash

- Plain FNV-1a 32 of `salt + ":" + id` is not good enough for two independent decisions: for
  sequential ids the session and replay decisions agreed only 35% of the time at rate 0.5 (should
  be ~50%). Adding MurmurHash3's fmix32 finalizer fixes it. Shared vectors live in
  `services/rum-api/internal/sampling` and `sdk/react-native/test/sampling.test.ts`.

## ouo-env

- rum-api's `/data` is the named volume `ouo-<env>_rum-api-data`, not `deploy/data`: read the audit
  log with `docker cp ouo-<env>-rum-api-1:/data/audit/deletions.jsonl .`.
- `docker compose ... up -d <service>` outside `ouo-env up` must repeat the env's variables
  (`OUO_LOKI_*`, `OUO_REPLAY_SWEEP_INTERVAL`), or the service is recreated with the defaults.
