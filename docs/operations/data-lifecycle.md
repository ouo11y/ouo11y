# Data lifecycle: retention, deletion, audit, sampling

How long ouo keeps each signal, how an operator deletes one user's or one project's data,
where every deletion is recorded, and how much is collected in the first place (roadmap 8b).

> **rum-api removed (2026-11-15).** Replays live in Muninn ([spec](../specs/muninn.md) section 9: retention per project, sweeper, S3 lifecycle tag), deletion and audit go through `ouo-erase` (section 3, [ADR-0026](../adr/0026-debug-files-and-erasure-without-rum-api.md)). The rum-api routes, sweeper, filesystem layout and hash-chain audit described below in sections 2 to 4 and 7 are the MVP record, kept for operators of older installs; they no longer exist on `main`.

| Signal | Store | Default retention | Enforced by | Per project | Delete by user / project |
|---|---|---|---|---|---|
| Logs and RUM events | Loki | 720h (30 d) | Loki compactor (`retention_period`) | yes (`retention_stream` on `ouo_project_id`) | Loki delete API, sent by `ouo-erase` |
| Traces | Tempo | 336h (14 d) | Tempo backend scheduler + worker (`block_retention`) | no (single tenant) | `tempo-cli redact` with the trace ids `ouo-erase` lists (user); retention only (project) |
| Metrics | Mimir | 2160h (90 d) | Mimir compactor (`compactor_blocks_retention_period`) | no (single tenant) | not needed: metrics carry no user id; a project's series age out |
| Replays | Muninn (S3 or a directory) | 720h (30 d) | Muninn sweeper; S3 lifecycle tag | yes (per project) | `ouo-erase`, immediately |

Retention is counted from the data's own time for Loki, Tempo and Mimir, and from a
session's last stored chunk for replays. Loki removes expired chunks from storage at
compaction, but a running single binary can keep answering queries for them from its
in-process chunk cache until the cache turns over or Loki restarts (seen on 3.7.7, section 7).

## 1. Set the retention

One entry per signal, in every deployment:

| Deployment | Where | Keys |
|---|---|---|
| Helm | `values.yaml` | `retention.logs`, `retention.traces`, `retention.metrics`, `retention.replays`, `retention.sweepInterval`, `retention.projects` |
| Compose (laptop, `ouo-env`) | `deploy/compose/.env` | `OUO_RETENTION_LOGS`, `OUO_RETENTION_TRACES`, `OUO_RETENTION_METRICS`, `OUO_RETENTION_REPLAYS`, `OUO_REPLAY_SWEEP_INTERVAL` |
| VM install | `/opt/ouo/deploy/compose/.env`, or `install.sh --retention logs=720h,traces=336h,metrics=2160h,replays=720h` | the compose keys |

Values are Go durations in hours (`720h`). Loki refuses a retention below `24h`. `0` keeps
replays forever; Loki, Tempo and Mimir treat `0` as "no retention" too.

What the entry becomes:

| Signal | Config key it renders |
|---|---|
| logs | Loki `limits_config.retention_period` (with `compactor.retention_enabled: true`); rum-api `retention.logs`, the window delete-by-user searches |
| traces | Tempo 3.0 `backend_scheduler.provider.compaction.compaction.block_retention` and `backend_worker.compaction.block_retention` (keep them equal) |
| metrics | Mimir `limits.compactor_blocks_retention_period` |
| replays | rum-api `retention.replays` |

With `lgtm.mode: external` the chart renders only rum-api; set the same keys in your Loki,
Tempo and Mimir deployments (the upstream `grafana/loki` chart: `loki.limits_config.retention_period`
and `loki.compactor.retention_enabled: true`; `grafana/tempo-distributed`: the two
`block_retention` keys; `grafana/mimir-distributed`: `mimir.structuredConfig.limits.compactor_blocks_retention_period`).

Apply: Helm rolls the pods on a config change (checksum annotations). Compose: `deploy/envs/ouo-env up <env>`
or, on a VM, `sudo systemctl restart ouo`.

### Per-project retention

- **Logs.** A `retention_stream` entry per project on the `ouo_project_id` stream label
  (the label is promoted from the `ouo.project.id` resource attribute the collector stamps).
  Helm: `retention.projects.<id>.logs`. Compose and VM: `deploy/compose/loki/runtime.yaml`,
  which Loki reloads every 10 s:

  ```yaml
  overrides:
    fake:                      # Loki's tenant when auth_enabled is false
      retention_stream:
        - selector: '{ouo_project_id="ttltest"}'
          priority: 1
          period: 24h
  ```

  Lines ingested before the label was promoted (before 8b) carry `ouo_project_id` as
  structured metadata only and follow the global retention.
- **Replays.** Helm: `retention.projects.<id>.replays`. Compose and VM: `projects:` in
  `deploy/compose/rum-api/config.yaml`, then restart rum-api.
- **Traces and metrics** have no per-project retention: Tempo and Mimir run single-tenant
  in ouo. A project that needs a different trace retention needs its own tenant (a Phase 11
  multi-project item).

## 2. Replay chunk lifecycle

A session's replay is a folder (filesystem) or key prefix (S3): `replays/<session>/`
with `meta.json`, one `<seq>.json.gz` per chunk and `<seq>.mp4` for video chunks.

**Sweeper.** rum-api walks every session every `retention.sweep_interval` (default `1h`,
first pass at start-up) and deletes a session whose `meta.json` `updated_at` (the last
stored chunk) is older than its project's retention. Session folders without `meta.json`
(an interrupted upload or delete) are removed once their newest file is older than
`retention.orphan_grace` (default `1h`). It runs for both backends, is idempotent and safe
with several replicas (a session deleted twice is absent the second time).
`POST /v1/admin/retention/sweep` runs one pass on demand and returns
`{"scanned","expired","orphans","bytes","errors","duration_ns"}`.

**S3 lifecycle rules.** On S3, every replay object rum-api writes carries the tag
`ouo-retention=<n>d`: its project's replay retention in whole days, rounded up (`keep`
for `0`). One expiration rule per value expires the objects in the bucket itself, so
retention holds even while rum-api is down. `replays/schema.json` and the audit objects are
never tagged and never expire.

- `storage.s3.lifecycle_rules: true` (`S3_LIFECYCLE_RULES`, Helm
  `rumApi.storage.s3.lifecycleRules`, on in `compose.s3.yaml`): rum-api rewrites the
  bucket's `ouo-replays-*` rules at start-up from the retentions in use and keeps every other
  rule. Needs `s3:GetLifecycleConfiguration`, `s3:PutLifecycleConfiguration` and
  `s3:PutObjectTagging`.
- Otherwise provision them yourself, one rule per retention in use, for example on AWS:

  ```json
  {"Rules": [{
    "ID": "ouo-replays-30d", "Status": "Enabled",
    "Filter": {"And": {"Prefix": "replays/", "Tags": [{"Key": "ouo-retention", "Value": "30d"}]}},
    "Expiration": {"Days": 30}
  }]}
  ```

  `aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://rules.json`
  (prefix `<prefix>/replays/` with `storage.s3.prefix`). MinIO:
  `mc ilm rule add --expire-days 30 --prefix replays/ --tags "ouo-retention=30d" <alias>/<bucket>`.

Objects written before 8b have no tag; the sweeper expires them. S3 counts days from each
object's creation and runs once a day, so the sweeper is also what enforces sub-day test
retentions.

## 3. Delete by user, delete by project

**With Muninn (ADR-0026):** run `ouo-erase` (`libs/ouo-go/cmd/ouo-erase`) from inside the network.
It does what the rum-api routes below do, in the same order, against Loki, Tempo and Muninn, and keeps
its `started` / `completed` / `failed` records as create-only objects in Muninn (`ouo-erase audit`):

```bash
export MUNINN_ADMIN_TOKEN=...  # Muninn's auth.admin_token: the only token that deletes a project or writes audit records
ouo-erase user <user id> [--project <project id>] --reason <ticket> --actor dpo@example.com \
  --muninn-url http://muninn:3400 --loki-url http://loki:3100 --tempo-url http://tempo:3200 [--dry-run]
ouo-erase project <project id> --reason <ticket> --actor ops@example.com --muninn-url ... --loki-url ...
ouo-erase audit [--entry <id>] --muninn-url http://muninn:3400
```

A user is matched on `enduser_id` (the browser SDK's `enduser.id`) or `user_id` (React Native and the
Sentry bridge). `ouo-erase project` also removes the project's debug files from Muninn.

- **The admin token stays with the operator.** Muninn's read token, which every plugin backend holds,
  cannot delete a project or write an audit record; keep `MUNINN_ADMIN_TOKEN` out of plugin backends.
- **Tamper evidence exists only on S3 with Object Lock** on the `audit/` prefix. On Muninn's
  filesystem backend the records are plain create-only files that anyone with disk access can edit or
  remove without a trace (rum-api's filesystem audit was a hash chain; Muninn's is not).
- **A project delete can take minutes.** If `ouo-erase project` times out (Muninn gives it 10 minutes),
  the run is recorded `failed`; run it again: the delete is idempotent and the second run finishes it.

The rest of this section describes rum-api's routes, which stay until rum-api is removed.


rum-api's operator API is behind its own bearer, the **admin token** (`OUO_ADMIN_TOKEN`,
`auth.admin_token`; Helm `adminToken`; generated by `deploy/vm/install.sh`). The read token
does not open it, and without an admin token the endpoints answer 404. rum-api is internal:
call it from inside the network (`kubectl port-forward svc/<release>-rum-api 8080`, or on a VM
`curl http://127.0.0.1:8080`).

```bash
# One user (optionally only inside one project). dry_run=true reports without deleting.
curl -X DELETE -H "Authorization: Bearer $OUO_ADMIN_TOKEN" -H "X-Ouo-Actor: dpo@example.com" \
  "http://rum-api:8080/v1/admin/users/<user id>?project=<project id>&reason=<ticket>"

# One project.
curl -X DELETE -H "Authorization: Bearer $OUO_ADMIN_TOKEN" -H "X-Ouo-Actor: ops@example.com" \
  "http://rum-api:8080/v1/admin/projects/<project id>?reason=<ticket>"
```

The answer is the completed audit entry (200), the failed one (502, with what did and did not
happen), or 503 when the audit log cannot be written (then nothing was deleted).

What happens, in order:

1. A `started` entry is appended to the audit log. If that fails, nothing is deleted.
2. **Sessions.** For a user: Loki is asked for the distinct `session_id` of every line with
   `user_id="<id>"` (structured metadata the SDKs set from `setUser`) over `retention.logs`,
   one day at a time. For a project: every replay whose `meta.json` names the project.
3. **Traces (user).** The sessions' trace ids are looked up in Tempo (`span.session.id`)
   before anything is deleted and recorded in the entry (`tempo.trace_ids`).
4. **Replays.** Each session's replay folder / prefix is deleted at once.
5. **Loki.** A delete request is submitted: `{service_name=~".+"} | ouo_project_id="<p>" | user_id="<u>"`
   (without `?project=`: `| ouo_project_id!=""`, so only lines that came through the ouo
   collector match, which matters in a Loki shared with other senders,
   [existing-lgtm.md](existing-lgtm.md)) over the log retention plus a day (Loki refuses a zero start and splits a request into
   24-hour shards, so an all-time range is not an option). Loki applies it after `compactor.delete_request_cancel_period`
   (24h by default: the window in which `DELETE /loki/api/v1/delete?request_id=` can cancel
   it); from then on queries no longer return the lines, and the next compaction rewrites
   the chunks without them (`deletion_mode: filter-and-delete`). Compose knobs:
   `OUO_LOKI_DELETE_CANCEL_PERIOD`, `OUO_LOKI_COMPACTION_INTERVAL`; Helm: `retention.loki.*`.
   Status: `GET /loki/api/v1/delete` on Loki lists requests (`received`, `processed`).
6. A `completed` (or `failed`) entry with the counts and backend results is appended.

**Tempo.** Tempo 3.0 has no delete API. It has trace **redaction**: `tempo-cli redact`
sends trace ids to the backend scheduler, which rewrites the blocks holding them (progress
at `/status/backendscheduler`). For a user deletion, run it with the ids from the audit entry:

```bash
tempo-cli redact --tenant=single-tenant $(jq -r '.tempo.trace_ids[] | "--trace-id=" + .' entry.json) <tempo>:9095
```

The tenant of ouo's single-tenant Tempo is `single-tenant`; the scheduler listens on the
gRPC port 9095 (compose: `docker run --rm --network ouo-<env>_default grafana/tempo-cli:3.0.3 redact ... tempo:9095`;
Helm: the Tempo pod's 9095). A redacted trace still answers `GET /api/v2/traces/<id>` with
200, but with an empty trace (`{"trace":{}}`), and a search no longer finds it.
Redaction by attribute (one query instead of ids) arrives with Tempo 3.1; deleting a whole
project's traces is not possible in 3.0 beyond waiting for `block_retention`. Spans carry
`user.id`, so keep the trace retention as short as the product allows.

**Mimir.** Metrics carry no user or session id, so a user deletion does not touch them. A
project's series age out with `compactor_blocks_retention_period`.

**Grafana.** Dashboards and the plugin read the stores above; nothing to delete there.

## 4. Audit log

Append-only, one JSON object per event, next to the replays:

- **Filesystem:** `<data dir>/audit/deletions.jsonl` (compose: `deploy/data/rum-api/audit/`).
  Each line carries `prev`, the SHA-256 of the previous line: editing or removing a line
  breaks the chain at the next one. rum-api opens the file `O_APPEND` and fsyncs every line.
  For write-once storage at the OS level, `chattr +a` the file (Linux) or ship it to your log
  archive.
- **S3:** one object per event under `[<prefix>/]audit/<time>-<id>-<status>.json`, created
  with `If-None-Match: *` so rum-api can never overwrite one. Enable S3 Object Lock
  (compliance mode) on the bucket for immutability; the replay lifecycle rules never match
  these untagged objects.

`GET /v1/admin/audit?limit=100` (admin token) returns the newest entries, oldest first.

```json
{"id":"7f3a...","time":"2026-10-23T15:10:02Z","status":"completed","action":"delete_user",
 "user_id":"u-1042","project_id":"demo","actor":"dpo@example.com","reason":"GDPR-17 #88",
 "from":"2026-09-23T15:10:01Z","to":"2026-10-23T15:10:01Z","session_count":3,
 "sessions":["...","...","..."],"replays":{"deleted":2,"bytes":181234},
 "loki":{"status":"submitted","query":"{service_name=~\".+\"} | ouo_project_id=\"demo\" | user_id=\"u-1042\""},
 "tempo":{"status":"manual","trace_ids":["4bf9...","a01c..."]},"prev":"9c1e..."}
```

The retention sweeper does not write audit entries (it is policy, not a request); its
deletions are counted in metrics.

## 5. Sampling

Less data collected is less data to keep and delete. Both SDKs decide per session with the
same deterministic rule, and rum-api applies the same rule for a server-side cap:

```
sampled(session id, rate, salt) = fmix32(fnv1a32(salt + ":" + session id)) / 2^32 < rate
```

FNV-1a 32 over the UTF-16 code units, then MurmurHash3's 32-bit finalizer. Salts: `session`,
`replay`, `replay_on_error`. Reference implementations:
`services/rum-api/internal/sampling` and `sdk/react-native/src/sampling.ts` (shared test vectors).

`@ouo11y/react-native`:

| Option | Default | Effect |
|---|---|---|
| `session.sampleRate` | 1 | sessions outside it send no spans, events, logs or replay |
| `replay.sampleRate` | 1 | sessions recorded from their start |
| `replay.onErrorSampleRate` | 0 | of the sessions not recorded, these start recording at their first error (from the error on; the native recorder keeps no earlier frames) |

`@ouo11y/browser` (PR #50) uses the same rule, salts and option names; its on-error replay also
uploads the 30 to 60 seconds before the error from memory. Options: `sdk/browser/README.md`.

**Server-side per-project cap** (rum-api `projects.<id>.sampling`, Helm
`rumApi.sampling.<id>`): `session_rate`, `replay_rate` and `replay_on_error_rate`, default 1. The replay sink answers
`202 {"accepted": false, "sampled_out": true}` and stores nothing for a chunk whose session
falls outside either rate (counter `ouo.replay.chunks_sampled_out`). Because the rule is
deterministic, a cap of 0.1 under an SDK rate of 0.5 keeps exactly the SDK-sampled sessions
whose hash is below 0.1. A chunk does not say why the SDK recorded it, so a session (inside
`session_rate`) keeps its replay when it passes `replay_rate` (salt `replay`) **or**
`replay_on_error_rate` (salt `replay_on_error`): error-triggered replays survive a low
`replay_rate`, and the SDKs record an on-error session only after an error, so the second test
admits nothing else. The cap applies to replays only. Spans and events are not capped
server-side yet: that needs a collector processor reading the same table (follow-up for the
collector).

## 6. Metrics

rum-api exports through the collector (Mimir names have `.` replaced by `_`):

| Metric | Attributes | Meaning |
|---|---|---|
| `ouo.retention.sweeps` | `result` (ok, error) | sweeper passes |
| `ouo.retention.sessions_deleted` | `ouo.project.id`, `reason` (expired, orphan) | replays deleted by retention |
| `ouo.retention.bytes_deleted` | `ouo.project.id` | stored bytes deleted by retention |
| `ouo.retention.sweep.duration` | | seconds per pass (histogram) |
| `ouo.retention.sweep.last_success` | | Unix time of the last good pass (alert when it stops moving) |
| `ouo.deletions` | `action`, `status`, `dry_run` | delete-by-user / -project requests |
| `ouo.deletions.replays` | `action` | replays deleted by them |
| `ouo.replay.chunks_sampled_out` | `ouo.project.id` | chunks dropped by the server-side cap |

## 7. Verification

Unit and integration tests (`go test ./...` in `services/rum-api`, `npx vitest run` in
`sdk/react-native`): the sweeper (per-project retention, keep-forever, orphans, idempotent
second pass, a failing delete), deletions (user within a project, dry run, project, Loki failure
audited as `failed`, no audit means no deletion), the audit log (hash chain across a reopen,
tamper detection, concurrent appends, create-only bucket objects), the admin API (404 without a
token, 401 with the read or ingest token), the sink sampling cap, the Loki client, config
validation; on a real MinIO: session listing, `ouo-retention` tags on every object but
`schema.json`, `ApplyLifecycleRules` idempotent and keeping a foreign rule, audit objects that
cannot be overwritten. Helm: `helm lint` and `helm template` with per-project values, the rendered
rum-api config passes `rum-api -config.verify`.

Live on `ouo-env 8b-retention-deletion` (2026-10-23, script
`project/agents/rum-api/scripts/8b-lifecycle-live.mjs`, Loki cancel period, compaction interval and
delete delay 1m, sweep interval 30s):

1. **Ingest.** Project `demo` through the collector: user `u-del-r1` with two sessions, user
   `u-keep-r1` with one, each with 3 events, a span and an rrweb replay. Project `ttltest`
   (straight into Loki and the replay sink): one session with lines 30 hours old.
2. **Delete a user.** `DELETE /v1/admin/users/u-del-r1?project=demo` with the read token: 401.
   Dry run: 2 sessions, 2 replays counted, nothing deleted. Real: replays gone at once
   (`GET .../replay` 404), Loki request `received`, two trace ids listed. The first real attempt
   ran with a `start=0` Loki request, which Loki refused: the replays were deleted, the entry was
   `failed` with Loki's error and the API answered 502; fixed, the retry completed.
3. **Loki after compaction.** The request turned `processed` 3 minutes later;
   `loki_compactor_deleted_lines` 6 (2 sessions x 3 lines); `u-del-r1` 0 lines, `u-keep-r1`
   still 3 in the same streams.
4. **Tempo.** `tempo-cli redact` with the two ids: one `JOB_TYPE_REDACTION` job `SUCCEEDED`
   within a second; afterwards both ids answer with an empty trace (0 spans), a search by
   `session.id` finds nothing for the deleted sessions, and the kept session's trace still has
   its span.
5. **Audit.** `/data/audit/deletions.jsonl`: 6 lines (dry run, failed attempt, retry; each
   `started` + final), hash chain intact across a rum-api restart; `GET /v1/admin/audit` the same.
6. **Short-TTL project.** `ttltest` with replay retention 1m (rum-api `projects:`) and log
   retention 24h (`loki/runtime.yaml`): the sweeper deleted its replays (one at start-up, a fresh
   one 75 s after upload), the `demo` replay stayed; Loki's compactor marked the 3 `ttltest`
   chunks of the previous day's table and removed their files. Queries kept returning the lines
   from Loki's chunk cache until Loki restarted; after it, `ttltest` 0 lines, `demo` unchanged.

Not run live: the S3 lifecycle rules expiring objects (MinIO and AWS evaluate rules once a day;
the rules and tags are verified against MinIO in the tests), the Helm chart on a cluster
(rendered and lint only), Tempo and Mimir block retention reaching their 14 / 90 day defaults.

## Masking and legal templates

What a replay contains with the default masking, with screenshots: [masking-proof.md](masking-proof.md).
The data processing agreement template is legal material and lives outside this repository.
