# 2026-11-13 Muninn and the spec-wire Collector config, built for the pilot

Branch `claude/muninn-collector-build-43a659`, cut from `origin/main` at `f278fe4c` (browser 0.4.0 released). Design read from PR #180 (branch `claude/collector-muninn-design-757046`, not merged): ADR-0019, the draft `docs/specs/muninn.md`, `project/kb/muninn/collector-path/`. None of those files is copied here; PR #180 owns them, so this branch's Markdown names them without links (they do not exist on `main` yet).

## What was done

- **`services/muninn`**, a new Go 1.26 module, standard library HTTP. OTLP/HTTP protobuf ingest at `POST /otlp/v1/logs` with the spec's validation (section 3, MUN-5 to MUN-19), one create-only container object per chunk on S3 (minio-go) or a directory, `ended.json` and tombstones, the read API (list, manifest with computed state and missing ranges, chunk as stored), delete with tombstone, retention sweeper with S3 retention tags, `schema.json` layout check, `/ready` and `/healthz`, self-telemetry over OTLP (the spec's seven metrics, delete audit logs). Dockerfile like rum-api's (distroless, `-check` health probe). README and `config.example.yaml`.
- **Collector**: `deploy/compose/collector/config.muninn.yaml`, the spec wire only. OTLP receiver with the existing auth, rate limit, project stamping and CORS; `routing/replay` on `instrumentation_scope.name == "ouo.replay"`; `logs/replay` with no batch processor to the stock `otlp_http/muninn` exporter with a persistent `file_storage` queue (fsync, bytes sizer, 2 GiB, no blocking, retry without time limit); `logs/replay-index` sends Loki a copy with an empty body and `ouo.replay.ref`. No MVP component. `config.yaml`, the MVP components and `services/rum-api` are untouched.
- **`collector/builder.yaml`**: one line added, `extension/storage/filestorage v0.160.0`. Justification: the stock extension that gives the replay exporter its fsync-ed disk queue (COL-4); nothing else in the distribution persists a queue. **`collector/Dockerfile`**: creates `/var/lib/otelcol/replay-queue` owned by nonroot so a new named volume is writable.
- **Stack**: `deploy/compose/compose.muninn.yaml` (MinIO from `compose.yaml`'s `s3` profile, a `muninn-init` bucket and bucket-scoped user, Muninn, the collector switched to `config.muninn.yaml` with a `replay-queue` volume) and `deploy/compose/muninn/config.yaml`. `deploy/envs/ouo-env up <env> --muninn` adds that file, routes `muninn.<env>.ouo.localhost`, drops Muninn's and MinIO's loopback ports, waits for `/ready`, and exports `OUO_MUNINN_URL` and `OUO_COMPOSE_PROJECT`; the flag is kept in the env state. Tests in `deploy/envs/lib.test.mjs`.
- **CI** (`.github/workflows/ci.yml`): `services/muninn` in the `go` job's paths and matrix; a `muninn` image in the `images` job (build, `-version` smoke, Trivy); the `collector` job also validates `config.muninn.yaml`; the collector image smoke checks `file_storage` is compiled in.
- **End-to-end check**: `tests/e2e/muninn/` (own `package.json` with the **published** `@ouo11y/browser` 0.4.0, esbuild 0.27.7 to bundle it for the page, Playwright 1.64.1 as in `tests/e2e`).

New dependencies: `services/muninn` uses only modules rum-api already uses (minio-go for S3, the OTel Go SDK and exporters, `go.yaml.in/yaml/v3`, `go.opentelemetry.io/proto/otlp` for the OTLP types). `tests/e2e/muninn` adds esbuild (bundle the released SDK and its OTel dependencies into one script for a static page) and the published `@ouo11y/browser` 0.4.0 (the task is to test the release, not `sdk/browser`).

## Verified, and how

- `services/muninn`: `go vet ./...` clean, `go test -race ./...` passes. Tests cover the four format ids plus an unknown one stored and served byte for byte with the right `Content-Encoding`, `Content-Type` and `ETag` (`TestFormatsStoredByteForByte`); a table of 20 invalid records each rejected with its reason while its neighbour is stored; duplicate and conflict; first end record stays; out-of-order arrival, gaps, idle timeout and a late chunk closing a gap; delete, late chunk after delete, new replay in a deleted session, tombstone swept after the TTL; retention sweep and retention 0; tags; the ingest status codes (401, 400, 415, 413 including a gzip bomb, 400 on garbage); cross-tenant and cross-project 404; 503 with `Retry-After` on a store error and on a panic; refusal of a newer layout; gzip on JSON reads.
- Store tests against the env's real MinIO (`docker run golang:1.26` on the env network with `OUO_TEST_S3_*`): both backends pass, including 8 concurrent create-only writes of one key giving exactly one winner.
- `ouo-collector validate` passes for `config.muninn.yaml` and still for `config.yaml` (ocb v0.160.0 build with the new line).
- `node --test deploy/envs/*.test.mjs`: 16 of 16.
- In the env, objects carry `ouo-retention=37d` (720 h plus the 7-day tombstone TTL) and `schema.json` is `{"layout_version":1,...}`. Muninn's delete audit record is in Loki under `service_name="muninn"`.
- **End-to-end**, `deploy/envs/ouo-env up muninn-collector-build-43a659 --muninn`, then `eval "$(deploy/envs/ouo-env env muninn-collector-build-43a659)"` and `node tests/e2e/muninn/run.mjs`. Chromium loads a page with the published `@ouo11y/browser` 0.4.0 (`replay.mode: "structure/dom"`, `chunkMaxMs: 1000`), six clicks add DOM rows, `shutdown()` closes the stream; every `/v1/logs` request is captured on the way out. Output of the run:

```text
PASS  browser sent replay chunks to /v1/logs  (4 chunk requests)
PASS  list: one replay for the session, complete, rrweb/2  ({"replay_id":"022a7a301200e45beaec0d15d6951533","state":"complete","start_time":1794528874349,"end_time":1794528878211,"chunk_count":4,"byte_size":1467,"formats":["rrweb/2"],"stream_count":1})
PASS  manifest: 200, one stream, no missing sequence  (state complete)
PASS  manifest: every chunk the browser sent is held  (4 held, 4 sent)
PASS  manifest: sequences 0..n in order
PASS  manifest: end record complete, last_sequence = n
PASS  chunks: 200, Content-Encoding gzip, format header
PASS  chunks: sha256 of every body matches manifest and ETag
PASS  chunks: every body is byte-for-byte the body the SDK sent
PASS  rrweb: the first keyframe chunk opens with Meta (4), FullSnapshot (2)  (keyframe chunk 1: 4,2,3...; chunk 0: 0,1 keyframe=false)
PASS  rrweb: timestamps never go backwards across chunks  (35 events)
PASS  rrweb: the recording holds the page's marker text
PASS  rrweb: the clicks' DOM mutations are recorded
PASS  loki: one reference record per chunk with ouo.replay.ref  (4 records, e.g. muninn:/demo/e2fbf8128c839e582dd4679bfa8a6378/022a7a301200e45beaec0d15d6951533/d648964e889ee82ebbde62bc5b712fbd/0)
PASS  loki: reference records carry no chunk bytes (empty body)
PASS  queue: Muninn is down  (GET /ready -> 504)
PASS  queue: the collector answers 2xx while Muninn is down  (HTTP 200)
PASS  queue: the chunk reaches Muninn after it comes back, bytes unchanged  (10.5 s after start)
PASS  invalid: Muninn answers 200 with partial_success rejected=1, reason hash_mismatch  (200 {"rejected":1,"message":"hash_mismatch: sha256 does not match the body"})
PASS  invalid: the valid neighbour is stored, the bad chunk is not
PASS  invalid: through the collector, 2xx to the SDK and never stored  (collector 200, manifest 404)
PASS  invalid: OTLP/JSON answers 415
PASS  delete: 204
PASS  delete: manifest 404, chunk 404, session list empty
PASS  delete: a late chunk is accepted and stays invisible (tombstone)

25/25 checks passed in 70 s
```

## Where the code depends on Q1 to Q15

Every question was built on its recommended answer. A different answer touches these places:

| Q | Recommendation built | Where |
|---|---|---|
| Q1 | OTLP/HTTP endpoint, stock exporter | `services/muninn/internal/muninn/ingest.go` (whole ingest), `config.muninn.yaml` `otlp_http/muninn` |
| Q2 | One SDK endpoint, routing by scope | `config.muninn.yaml` `routing/replay` and `logs/in`; no replay port in `compose.muninn.yaml` |
| Q3 | One Loki reference per chunk | `config.muninn.yaml` `transform/replay-ref`, `logs/replay-index`; e2e `lokiRefs` |
| Q4 | One container object per chunk, no stored manifest | `internal/muninn/keys.go` (layout, container), `read.go` `buildReplay` (manifest from a listing), the header cache in `Server.header` |
| Q5 | No database | everything is in `store.Store`; `Sweep` lists the store |
| Q6 | Tenant header and project now | `keys.go` (tenant is the first key segment), `server.go` `tenant()`, `multitenancy_enabled`; `MUNINN_TENANT` in `config.muninn.yaml` (one tenant per Collector) |
| Q7 | Retention per replay from its last object, sweeper plus tags | `read.go` `Sweep`, `ingest.go` `retentionTags`, `config.Retention` |
| Q8 | MVP replays not migrated | nothing built; rum-api untouched |
| Q9 | rum-api decided later | nothing built; rum-api still runs for the plugin |
| Q10 | SDK spec owns media types; rrweb is NDJSON | `read.go` `mediaTypes` (`rrweb/2` is `application/x-ndjson`, everything else `application/octet-stream`; the SDK spec has no media types yet); e2e parses NDJSON |
| Q11 | Validate in Muninn only | `ingest.go` `validate`; the Collector config validates nothing |
| Q12 | Named volume, 2 GiB | `compose.muninn.yaml` `replay-queue`, `config.muninn.yaml` `queue_size` (`OUO_REPLAY_QUEUE_BYTES`), `collector/Dockerfile` |
| Q13 | Vendor video touches | not touched (vendor receivers out of scope) |
| Q14 | Port 3400 | `config.Defaults`, `Dockerfile`, `compose.muninn.yaml`, `deploy/envs/lib.mjs` `MUNINN_ROUTES` |
| Q15 | Four stricter rules | `ingest.go` `validate`: 32-hex ids (`bad_id`), encoding `gzip`/`identity`, format syntax, empty body rejected (`size_mismatch`). The browser SDK 0.4.0 passes all four (e2e) |

## Where the code reads the draft spec its own way

None of these diverges from a MUST; each is a choice the spec leaves open, listed so the founder or the spec author can overrule it.

- An integral `doubleValue` is accepted where the spec says `int` (lenient towards JSON-minded encoders). Stored as sent.
- An empty chunk body is rejected with `size_mismatch` (the spec forbids empty bodies in 3.3 but names no reason).
- The sweeper lists the whole store each interval (the spec says per project; same cost, one loop).
- S3 lifecycle rules are not written (MUN-52 says MAY); only tags are.
- A read-route panic answers 503, like ingest.

## SDK finding (not fixed: `sdk/` is out of scope)

`@ouo11y/browser` 0.4.0 sends a first chunk (sequence 0, segment 0, `keyframe=false`) that holds only rrweb's DomContentLoaded and Load events; the Meta and FullSnapshot keyframe come in sequence 1 as segment 1. A reader following RDR-3 can never play segment 0, and the stream's first chunk is not a keyframe. Worth a look by the browser SDK's owner against RPL-6.

## What is left

- **Founder**: confirm Q1 to Q15 and merge PR #180 first or together; this PR's docs name its files without links until then. When #180 merges, `project/kb/muninn/index.md` gets its `collector-path/` row back (both PRs add the file; a two-line conflict).
- Not tested (see `project/kb/muninn/implementation/collector-path-verified.md`): Collector kill -9 right after a 2xx; full queue answering 503; queue throughput on a real disk; memory with 1 MiB chunks; spec 12's conformance suite as a separate harness (the Go tests and the e2e cover most of its rows).
- **Release**: no `muninn-v*` tag pattern in `release-images.yml` or release-please component yet, and no license file (rum-api is AGPL, the rest Apache 2.0): the founder picks Muninn's before its first image is published.
- **Helm** (out of scope here): a Muninn Deployment and ClusterIP Service on port 3400 with an S3 secret (bucket, keys) and the ingest and read tokens; the collector as a StatefulSet with a PersistentVolumeClaim at `/var/lib/otelcol/replay-queue` (Q12) running `config.muninn.yaml`; `MUNINN_ENDPOINT`, `MUNINN_INGEST_TOKEN`, `MUNINN_TENANT` in its environment; alert on the Collector's failed-send counter for `otlp_http/muninn`.
- The MVP path (`config.yaml`, `ouoreplay*`, rum-api's replay code) stays until the founder removes it. Without `--muninn`, nothing changes for any env.

## Review

The app could not start a separate reviewer session from this run (Remote Control), so the second read came from a fresh subagent with no access to the author's reasoning. Its verdict was `Review: changes needed`, and it posted that on the PR.

| # | Finding | Answer |
|---|---|---|
| 1 | High: a NaN or ±Inf double attribute made `json.Marshal` fail. For a chunk that meant a 503 on every retry, which pins a queue consumer for ever. For an end record it stored an empty `ended.json` that then broke reads. | Fixed. `validate` rejects non-finite numbers at any depth as `bad_attribute`. Marshal errors become rejections. A repeat over an unreadable stored chunk is a `conflict`, not a 503. Tests added. |
| 2 | Medium: one undecodable object made the whole session list and manifest answer 503. | Fixed. Decode failures are wrapped in `errCorrupt`, then logged and skipped. Store errors still answer 503. Test added. |
| 3 | Low: the sweeper lists the whole store every interval; the spec says per project. | Kept. The request cost is the same: one list request per 1000 objects, whichever way the listing is split. Splitting per project needs a delimiter listing in `store.Store`, which is one more concept. Worth doing when memory per sweep matters. |
| 4 | Low: S3 `notFound` matched any 404, including a missing bucket, and `Ping` ignored the result of `BucketExists`. | Fixed. Only `NoSuchKey` counts as not found, and `Ping` fails when the bucket is missing. |
| 5 | Low: new parent directories were not fsynced. | Fixed. `mkdirSynced` syncs the parent of each directory it creates. |
| 6 | Low: an error in `transform/replay-ref` would fail the SDK request after the chunk was already queued. | Fixed. The body is cleared first, and `error_mode` is `ignore`. |
| – | Simplify: the `read()` wrapper also wraps the two DELETE routes. | Renamed to `api()`. |
| – | Simplify: `--muninn` stays on for later `up` runs. | Kept on purpose, like the env's port block: a plain `up` should not silently switch the replay path. `down --purge` resets it. |

## Env

`muninn-collector-build-43a659` was used for all runs. After the review fixes it was rebuilt, and the end-to-end check passed 25 of 25 again in 64 s. The env was then taken down with `ouo-env down`; its volumes are kept, and `--purge` removes them.
