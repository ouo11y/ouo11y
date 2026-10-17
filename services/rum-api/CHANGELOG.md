# Changelog: rum-api

`ghcr.io/ouo11y/rum-api` (until 0.2.0: `ghcr.io/ziadmansourm/ouo/rum-api`), tag `rum-api-v<version>`.
Policy: `docs/releasing.md`. Earlier history: the rum-api agent summaries under `project/agents/rum-api/`.

## Unreleased

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
