# 2026-10-23: roadmap 8b data lifecycle

Branch `claude/8b-retention-deletion`, one PR to `main`. Scope: roadmap 8b and checklist
section 5 "8b". Owned paths: `services/rum-api`, the retention parts of `deploy/compose`,
`deploy/helm`, `deploy/vm`, `docs/operations`, the JS sampling of `sdk/react-native`.

## Done

- **Retention per signal from one entry.** Helm `retention` (`logs` 720h, `traces` 336h,
  `metrics` 2160h, `replays` 720h, `sweepInterval`, `projects.<id>.logs/replays`, `loki.*`
  deletion timings) renders Loki `retention_period` + compactor retention and deletes + per-project
  `retention_stream`, Tempo 3.0 `block_retention` (scheduler and worker), Mimir
  `compactor_blocks_retention_period`, rum-api `retention` / `projects`. Compose: `OUO_RETENTION_*`
  through `-config.expand-env=true` on Loki, Tempo and Mimir; per-project Loki retention in a new
  `deploy/compose/loki/runtime.yaml` (reloaded every 10 s). VM: `install.sh --retention
  logs=...,replays=...`, defaults kept in `.env`, a generated `OUO_ADMIN_TOKEN`. Loki and the Helm
  Loki promote `ouo.project.id` to the `ouo_project_id` stream label (one value per project), the
  only way to select a project in `retention_stream`.
- **Replay lifecycle.** `internal/lifecycle` sweeper (both backends, per-project retention,
  orphan folders without `meta.json`, idempotent, metrics `ouo.retention.*`), on start and every
  `retention.sweep_interval`. `replay.Lister` on FS and S3. On S3 every replay object carries
  `ouo-retention=<n>d`; `storage.s3.lifecycle_rules` makes rum-api own the bucket's
  `ouo-replays-*` expiration rules (others kept). Tags instead of a prefix rule because a prefix
  rule would expire `replays/schema.json`.
- **Delete by user / project.** `DELETE /v1/admin/users/{user}[?project=]`,
  `DELETE /v1/admin/projects/{project}`, `GET /v1/admin/audit`, `POST /v1/admin/retention/sweep`,
  behind the new `auth.admin_token` (404 when unset; the read token does not open it). User
  sessions come from Loki (`sum by (session_id)(count_over_time(... | user_id=...))`, one day per
  instant query); replays deleted at once; a Loki delete request over the log retention plus a
  day; the user's Tempo trace ids listed for `tempo-cli redact`. Tempo 3.0 has no delete API;
  project traces only expire.
- **Audit log.** `internal/audit`: `started` entry before anything is deleted (no entry, no
  deletion: 503), `completed` / `failed` after. Filesystem: `<data>/audit/deletions.jsonl` with a
  SHA-256 chain (`prev`) and `Verify`; S3: one create-only object per entry under
  `[<prefix>/]audit/`.
- **Sampling.** Shared deterministic rule `fmix32(fnv1a32(salt:id))/2^32 < rate`
  (`internal/sampling`, `sdk/react-native/src/sampling.ts`, shared vectors). RN:
  `session.sampleRate`, `replay.sampleRate`, `replay.onErrorSampleRate` (JS only: the native
  recorder is started / paused / resumed per session; error-triggered recording starts at the
  error, no earlier frames). rum-api `projects.<id>.sampling.{session_rate,replay_rate}` drops
  chunks at the sink (202 `sampled_out`, `ouo.replay.chunks_sampled_out`).
- **Docs.** `docs/operations/data-lifecycle.md` (procedures, every backend's behaviour, the live
  record), `docs/operations/masking-proof.md` with 11 screenshots, READMEs and CHANGELOGs of
  rum-api, the chart and the RN SDK, `project/kb/data-lifecycle.md`.

No new dependency (`minio-go/v7/pkg/lifecycle` is part of the existing module).

## Verified, and how

- `go test ./...` and `go vet ./...` in `services/rum-api` (S3 tests against a real MinIO via
  docker); `npx vitest run` (128) and `tsc --noEmit` in `sdk/react-native`; `helm lint` and
  `helm template` with per-project values, rendered rum-api config passes `-config.verify`;
  `bash -n deploy/vm/install.sh`; lychee offline on the touched docs.
- Live on `ouo-env 8b-retention-deletion` with `project/agents/rum-api/scripts/8b-lifecycle-live.mjs`
  (Loki cancel period / compaction / delete delay 1m, sweep 30s): ingest two users and a
  30-hour-old `ttltest` project; delete `u-del-r1` (read token 401, dry run, a first real run that
  Loki refused because of `start=0`, audited as `failed` with the replays already gone, then the
  fixed run); replays 404 at once; Loki request `processed` after 3 minutes, the user's lines gone,
  the other user's kept, `loki_compactor_deleted_lines` 6; `tempo-cli redact` job succeeded, both
  trace ids now return empty traces; audit file 6 lines with an intact chain across a restart;
  `ttltest` replays swept with a 1m override, its Loki chunks marked and removed from storage by a
  24h `retention_stream`. Full record: `docs/operations/data-lifecycle.md` section 7.
- Masking: web (Chromium, examples/ouo-web) and iOS 27 Simulator (examples/ouo-mobile Release
  builds with SDK defaults and with the example's `maskText: false`); stored rrweb events and
  decoded JPEG frames checked for the typed values.

## Not done / follow-ups

- Browser SDK sampling belongs to the browser-sampling session (`sdk/browser`); I messaged it the
  shared hash and option names (no reply seen). Its current `replay.sampleRate` uses
  `Math.random`, so rum-api's cap would not nest inside it until it switches.
- Server-side session cap on OTLP (spans, events): needs a collector processor reading the same
  per-project table; rum-api caps replays only.
- Not run live: S3 lifecycle rules actually expiring objects (daily evaluation), the chart on a
  cluster, Tempo / Mimir default retention periods elapsing, an iOS device.
- Loki 3.7.7 single binary kept serving expired chunks from its embedded chunk cache until a
  restart (storage was already clean); delete requests do not have this lag. Documented, not
  worked around.
- The scripted web journey (`examples/ouo-web/scripts/run.sh`) produced a session without a
  replay on this env, while a hand-driven session in the same build recorded one; not
  investigated (examples / sdk-browser area).
- Demo values used during the run (`ttltest` in `deploy/compose/rum-api/config.yaml` and
  `loki/runtime.yaml`, `maskText` in `examples/ouo-mobile`) were reverted; the committed files
  carry commented examples only.

## For the next agent

- Env `8b-retention-deletion` is left **up** for review: http://grafana.8b-retention-deletion.ouo.localhost
  (admin / testing567), admin token `at_dev_0000000000000000`. Take it down with
  `deploy/envs/ouo-env down 8b-retention-deletion` once the PR merges. It was started with
  `OUO_LOKI_DELETE_CANCEL_PERIOD=1m OUO_LOKI_COMPACTION_INTERVAL=1m OUO_LOKI_RETENTION_DELETE_DELAY=1m OUO_REPLAY_SWEEP_INTERVAL=30s`.
- Simulator `ouo-8b` (B82A38DF-23AD-43AF-9E8F-7EA9FBE78202) was created for this run and is shut down.
- Quirks worth knowing before touching this area are in `project/kb/data-lifecycle.md`.
