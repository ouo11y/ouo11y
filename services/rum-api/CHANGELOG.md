# Changelog: rum-api

`ghcr.io/ouo11y/rum-api` (until 0.2.0: `ghcr.io/ziadmansourm/ouo/rum-api`), tag `rum-api-v<version>`.
Policy: `docs/releasing.md`. Earlier history: the rum-api agent summaries under `project/agents/rum-api/`.

## Unreleased

### Added

- Replay chunks keep their optional `masked` flag (frames and video); `GET /v1/sessions/{id}/replay`
  serves it per chunk and as the replay's `masked` (`false` as soon as one chunk is unmasked). Chunks
  stored before this version have none. A `masked` that is not a boolean is a 400.
- `GET /v1/sessions/{id}` has `context`: the session's device, OS, app build and deployment
  environment (latest value of each over its records), for the Grafana plugin's header.
- Traces whose root span is a generic `HTTP GET` get `root_url_path` (the root's `url.path`) from a
  second, best-effort Tempo search, so the plugin can name them `GET /path`.
- Start-up schema-version guard (`docs/operations/upgrade.md` section 4): rum-api records the
  highest replay `schema_version` it reads in `replays/schema.json` (filesystem: `DATA_DIR/replays/`,
  S3: `[<prefix>/]replays/`) and exits 1 with a message naming both versions when the store was
  last opened by a rum-api that reads a newer schema. A store without the marker (0.3.0 and older)
  is adopted; nothing else is rewritten.

## 0.3.0 (2026-10-18)

First release under `ghcr.io/ouo11y/rum-api` (ADR-0009).

### Changed

- Go module path `github.com/ouo11y/ouo11y/services/rum-api`; image `ghcr.io/ouo11y/rum-api`.
- Session links point at the Grafana plugin's new ID (`/a/ouo11y-rum-app/...`).

No API, storage or configuration change: a 0.2.0 data directory, bucket and config file work
unchanged. The minor bump keeps the three images (rum-api, collector, grafana) on one version for
the first `ouo11y` release.

## 0.2.0 (2026-10-17)

First tagged image: YAML config file (`-config.file`, `-config.expand-env`) and S3 / MinIO replay
storage next to the local disk; the collector is the edge (ADR-0007), rum-api is internal.
