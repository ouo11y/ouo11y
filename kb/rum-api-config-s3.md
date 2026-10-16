# rum-api YAML config and S3 / MinIO replay store

Status: written 2026-10-16 by rum-api. Code: `services/rum-api/internal/config`,
`services/rum-api/internal/replay/s3.go`, `services/rum-api/config.example.yaml`,
`deploy/docker/compose.s3.yaml`, `deploy/helm/ouo` (`rumApi.storage`, `rumApi.structuredConfig`).

## Question

How is rum-api configured and operated like Loki and Tempo (a YAML file, secrets from the
environment, object storage), and what does an S3 replay store need to keep the filesystem
store's guarantees (range reads, de-duplicated retries, several replicas)?

## Config file

- Flags follow Loki: `-config.file`, `-config.expand-env` (off by default, as in Loki),
  plus `-config.verify` (load, validate, print the effective config with secrets redacted,
  exit 0 / 2). `-check` (container health probe) still works without the flags.
- Precedence: defaults < file < environment. All env variables rum-api read since Phase 3
  keep their names and **override** the file; an empty variable counts as unset (as before).
- Trap: an image or base manifest that sets env defaults (`ENV RUM_API_ADDR=:8080 DATA_DIR=/data`
  in the old Dockerfile) silently wins over every file. The Dockerfile now sets none; the
  Helm chart moved every non-secret value from `env:` into the ConfigMap. Keep only secrets
  and per-environment overrides in `env:`.
- `${VAR}` / `${VAR:-default}` expansion is a regex over the raw bytes before YAML parsing.
  Bare `$VAR` and lone `$` are left alone (secrets with `$` survive; Loki's envsubst would
  expand `$VAR`), `$${` is a literal `${`. Expanded values are not re-expanded. Quote
  expanded values in the file: a token containing `: ` or `#` would otherwise change the YAML.
- Strict decoding (`yaml.Decoder.KnownFields(true)`): a typo like `backnd:` fails start-up
  instead of being ignored. An empty file is `io.EOF` from the decoder, treated as "no keys".
- `go.yaml.in/yaml/v3` decodes and encodes `time.Duration` as strings (`30m`, `1m0s`); the
  `-config.verify` output round-trips through `Load`.

## S3 store

- Client: `github.com/minio/minio-go/v7` v7.4.1. Chosen over `aws-sdk-go-v2` (one module
  instead of core + config + credentials + s3 + feature/s3/manager + smithy); it speaks to
  AWS S3 and any S3 compatible store, SigV4, path-style, static keys or the AWS chain
  (`EnvAWS`, `EnvMinio`, `FileAWSCredentials`, `IAM` which covers EKS IRSA).
- Layout equals the filesystem: `[<prefix>/]replays/<session>/<seq %06d>.json.gz`,
  `<seq>.mp4`, `meta.json`, so `mc mirror <DATA_DIR>/replays <alias>/<bucket>/[<prefix>/]replays`
  migrates. Content types `application/gzip` (never `Content-Encoding: gzip`, which an HTTP
  client may transparently decode), `video/mp4`, `application/json`.
- Several replicas: `meta.json` is the only object two uploads of one session share. Puts are
  serialised per session in-process (like FS) and `meta.json` is written with a conditional
  PUT, `If-Match: <etag read>` or `If-None-Match: *` for a new replay
  (`PutObjectOptions.SetMatchETag` / `SetMatchETagExcept("*")`), re-read and re-applied on
  412 (precondition failed) or 409 (AWS `ConditionalRequestConflict` for racing conditional
  writes), at most 8 times. Verified: `TestS3Replicas` (two stores, 30 concurrent chunks of
  one session) passes, and **fails every run when the conditional headers are removed**
  (lost meta updates). AWS S3 supports conditional writes since late 2024; MinIO
  RELEASE.2026-08 does.
- Retried chunks: same `seq` overwrites its objects and replaces its meta entry (shared
  `applyChunk` in `internal/replay/meta.go`, used by both stores).
- Kind / project conflicts write nothing (checked before the first object PUT). If another
  replica changes the session's kind between our object writes and the meta write (only
  possible after a delete), the written objects are removed best effort.
- Range reads: `OpenVideo` does a `StatObject` (size, `LastModified`, ETag) and returns a
  lazy `*minio.Object` pinned to that ETag (`GetObjectOptions.SetMatchETag`, so a replace in
  between fails the read instead of mixing two segments). `http.ServeContent` seeks it and
  every `Seek` + `Read` is a ranged GET: `Range: bytes=100-199` is 206 with 100 bytes from
  the bucket. `VideoFile.ETag` carries the S3 ETag to the response (S3 `Last-Modified` has
  one-second resolution, so the size+mtime ETag of the filesystem store would collide).
- `GetObject` is lazy: `NoSuchKey` surfaces on the first read (`gzip.NewReader`, `io.ReadAll`)
  or `Stat`, not on the call; map it there.
- `NewS3` checks `BucketExists` (missing bucket or wrong keys exit at start-up) and the store
  implements `replay.Pinger`, so `/readyz` reports `"storage": "ok"`. rum-api never creates
  buckets; deployments do (compose `minio-init`, Terraform, ...).
- Delete removes `meta.json` first (the session disappears for readers at once), then lists
  and batch-removes the rest.

## MinIO images (2026)

- `minio/minio` and `minio/mc` on Docker Hub return "access denied", `quay.io/minio/*` has
  no manifests: MinIO stopped publishing community images. `pgsty/minio` (community
  maintained fork, "SILO", same server; `minio --version` prints
  `RELEASE.2026-08-04T00-00-00Z`) and `pgsty/mc` are maintained and multi-arch. Pinned:
  `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `pgsty/mc:RELEASE.2026-09-16T00-00-00Z`;
  overridable with `OUO_MINIO_IMAGE` / `OUO_MC_IMAGE` and, for the tests, `OUO_TEST_MINIO_IMAGE`.
- `pgsty/minio` has no `which`; do not rely on curl / mc inside it for a healthcheck.
  `minio-init` waits with a retry loop on `mc alias set` and `mc ready`.
- Upstream `go install github.com/minio/minio@latest` still builds a working server
  (pseudo-version `v0.0.0-20260212...`, version string `DEVELOPMENT.GOGET`); used once as a
  fallback while Docker Hub was unreachable from the Docker daemon.

## Tests against a real MinIO

- `internal/replay/s3_test.go`: `OUO_TEST_S3_ENDPOINT` uses a running MinIO; otherwise the
  test starts one with `docker run -p 127.0.0.1::9000` and removes it in `TestMain`. Without
  either it skips locally but **fails when `CI` is set**, so CI cannot pass by skipping.
  GitHub's `ubuntu-latest` has Docker, so the existing `go test ./...` CI step runs them.
- Trap (first CI run, all S3 tests red with `docker port: exit status 1`): on a runner
  without the image, `docker run -d` prints the pull progress to stderr; reading
  `CombinedOutput()` as the container id passed the pull log to `docker port` ("page not
  found"). Locally the image was cached, so it never showed. The harness now runs
  `docker pull -q` first, reads only stdout of `docker run`, keeps the container (no
  `--rm`, removed in `TestMain`) and puts its state and logs into any failure.
- `contract_test.go` runs the same behaviour list against FS and S3 (rrweb ordering and gzip
  pass-through, retries, kind / project conflicts, frames, video limits, slim JSON, ranged
  reads, manifest, delete, 20 concurrent puts, validation).

## Deploy choices

- Local compose: Loki, Tempo and Mimir use filesystem storage, so rum-api stays on the
  filesystem by default; MinIO is in `compose.yaml` under profile `s3` and
  `compose.s3.yaml` turns it on (`profiles: !reset []`) and sets `STORAGE_BACKEND=s3`.
  `minio-init` creates the bucket and a bucket-scoped `rum-api` user.
- Helm: `rumApi.storage.backend: s3` renders no PVC, switches the Deployment to
  RollingUpdate, takes keys from `rumApi.storage.s3.existingSecret` (`access-key-id`,
  `secret-access-key`), static values, or pod identity (`rumApi.serviceAccountName`).
  The chart now passes `-config.file`, so it needs a rum-api image newer than 0.2.0.

## Verified (2026-10-16)

Isolated compose project `ouo-s3v` (ports 3300 / 3110 / 3210 / 4418-4420 / 8190 / 9100),
`compose.yaml` + `compose.s3.yaml`: e2e scenario OK (40 sessions, rrweb chunk through the
collector), a frames chunk through the replay receiver, the three Sentry golden captures
(133 envelopes) through the bridge; MinIO held 1 rrweb, 1 frames and 9 video replays (49
mp4 segments). Range through Grafana's plugin proxy: 206 / 416, conditional 304 on rum-api;
mp4 bytes equal the bucket object. Plugin: the video replay plays, a timeline click seeks
to segment 10/19 and playback advances across segments (all segment requests 206); frames
and rrweb replays load. The same stack without the override ran the filesystem store from
the same config file.
