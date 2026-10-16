# rum-api: YAML config file and S3 / MinIO replay store (2026-10-16)

Branch `claude/rum-api-yaml-s3-80440c`, stacked on `claude/sentry-bridge-design`. Goal
(founder, two prospective clients): operate rum-api like Loki and Tempo, a YAML config file
plus object storage in MinIO / S3. Details and traps: `kb/rum-api-config-s3.md`.

## Done

- **Config** (`internal/config`): nested `Config` with YAML tags; `Load(path, expandEnv,
  lookup)` = defaults < file < env, then `Validate` (all errors at once). Flags
  `-config.file`, `-config.expand-env` (`${VAR}`, `${VAR:-default}`, `$${` literal, bare
  `$VAR` untouched), `-config.verify` (print redacted YAML, exit 0 / 2). Every existing env
  variable keeps its name and overrides the file. New variables: `STORAGE_BACKEND`,
  `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  `S3_SESSION_TOKEN`, `S3_INSECURE`, `S3_INSECURE_SKIP_VERIFY`, `S3_FORCE_PATH_STYLE`,
  `S3_PREFIX`. Documented example: `services/rum-api/config.example.yaml` (loaded by a test).
- **Store** refactor: shared `prepareChunk` / `checkMeta` / `applyChunk` / meta codec in
  `internal/replay/meta.go`; `fs.go` uses them (behaviour unchanged, old tests pass).
- **S3 store** (`internal/replay/s3.go`): same `Store` interface; filesystem key layout
  under an optional prefix; chunk objects before meta; conditional `meta.json` PUT
  (If-Match / If-None-Match *) with retry, so replicas share a bucket; retried seq replaces;
  kind / project conflicts and size limits write nothing; `OpenVideo` = Stat + ETag-pinned
  lazy `minio.Object` (ranged GETs under `http.ServeContent`); `VideoFile.ETag` (API uses it
  when set); bucket check at start and `/readyz` `storage` check (`replay.Pinger`).
- **Dockerfile**: removed `ENV RUM_API_ADDR DATA_DIR` (they would override a mounted file;
  defaults are identical). At the rum-api-release session's request: the build stage
  cross-compiles (`FROM --platform=$BUILDPLATFORM`, `GOOS/GOARCH` from `TARGETOS/TARGETARCH`;
  `docker buildx --platform linux/amd64,linux/arm64` builds here without QEMU) and
  `ARG VERSION=dev` is stamped as `main.version` (`rum-api -version`, start-up log).
- **Compose**: rum-api reads `deploy/docker/rum-api/config.yaml` (`command:` with both
  flags); non-secret env moved into the file, tokens / OTEL / `GRAFANA_URL` stay in env.
  `minio` + `minio-init` (bucket + bucket-scoped `rum-api` user) under profile `s3`;
  `compose.s3.yaml` activates them and sets `STORAGE_BACKEND=s3` + keys. **Choice: opt-in**,
  because Loki, Tempo and Mimir use filesystem storage in the local stack.
- **Helm**: rendered ConfigMap `<release>-rum-api-config` (from `rumApi.config`,
  `rumApi.storage`, merged `rumApi.structuredConfig`), `args` with the flags, env only for
  secrets and OTel; `rumApi.storage.{backend,s3.*}`, `s3.existingSecret`,
  `rumApi.serviceAccountName`; no PVC and RollingUpdate on s3; validation (backend, bucket,
  keys vs existingSecret); `values-ha-example.yaml` now runs two replicas on S3. READMEs.

## Dependencies

- `github.com/minio/minio-go/v7` v7.4.1: S3 client (SigV4, path-style, conditional PUT,
  ranged GET, AWS credential chain incl. IRSA) in one module, smaller than aws-sdk-go-v2.
- `go.yaml.in/yaml/v3` v3.0.5: YAML parser for the config file (maintained successor of
  gopkg.in/yaml.v3; strict `KnownFields`, durations as strings).

## Verified

- `go vet ./...`, `gofmt -l .` clean; `go test -race ./...` passes, S3 tests against real
  MinIO both ways: `OUO_TEST_S3_ENDPOINT` (host MinIO) and self-started container
  (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `CI=true`). Mutation: removing the conditional
  headers makes `TestS3Replicas` fail 3/3 runs.
- Config tests: defaults, example file, expansion, env override (incl. empty = unset),
  strict keys, invalid values, redacted round trip.
- `helm lint`, `helm template` with default, kind, external-lgtm, ha-example and s3 values
  (ConfigMap, Secret keys, env, no PVC, strategy, validation failures). **Not** installed on
  kind this run.
- End to end, isolated compose project `ouo-s3v` (other stacks untouched; collector image
  `ouo-sb/collector:latest` reused because Docker Hub was flaky for builds, rum-api built
  from this branch): e2e scenario OK (40 sessions + rrweb chunk via the collector); a frames
  chunk via the replay receiver; Sentry golden captures journey / shop / touch (133
  envelopes, all 200) via the bridge on 4320. MinIO: 1 rrweb, 1 frames, 9 video replays
  (49 mp4). rum-api Range 206 / 304; Grafana plugin proxy Range 206 / 416; mp4 equals the
  bucket object. Plugin in the browser: video plays, timeline click seeks to segment 10/19
  at +55.9s, playback advances, all segment requests 206; frames and rrweb replays load.
  Without `compose.s3.yaml` the same file runs the filesystem store (files under
  `deploy/data/rum-api/replays`). Env-only `-config.verify` with the new image honours the
  old variables.

## For the releases session and example compose files

- The chart and `deploy/docker/compose.yaml` now start rum-api with
  `-config.file=/etc/rum-api/config.yaml -config.expand-env=true`: they need a rum-api
  image that has those flags. After merging main (PR #18), 0.2.0 is the first rum-api
  release and is cut after this PR, so `rumApi.image.tag: "0.2.0"` and
  `OUO_RUM_API_VERSION=0.2.0` are right once that tag is built; an older build exits with
  "flag provided but not defined".
- An example compose file that uses the published image can stay env-only (no file):
  set `OUO_INGEST_TOKEN`, `OUO_READ_TOKEN`, `LOKI_URL`, `TEMPO_URL`, `GRAFANA_URL`
  (browser-facing), `DATA_DIR` or the volume at `/data`, plus OTel `OTEL_*`. For S3 add
  `STORAGE_BACKEND=s3`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, and for MinIO `S3_FORCE_PATH_STYLE=true`, `S3_INSECURE=true`
  (plain HTTP). With a mounted file instead: the two flags as `command:` and the secrets
  as env, and do not set the other variables in env (they override the file).

## Left / next

- Helm install on kind with the s3 backend (MinIO in-cluster) was not run.
- Replay retention / lifecycle in the bucket (roadmap: lifecycle rules + sweeper).
- CI: `go test ./...` on `ubuntu-latest` now pulls `pgsty/minio` for the S3 tests (they
  fail rather than skip under `CI`); the CI owner may prefer a `services: minio` block with
  `OUO_TEST_S3_ENDPOINT`.
- Loki drops some golden-capture log lines as "entry too far behind" when replaying 3-day
  old captures; unrelated to the replay store.
