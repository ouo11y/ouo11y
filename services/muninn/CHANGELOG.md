# Changelog: muninn

`ghcr.io/ouo11y/muninn`, tag `muninn-v<version>`. Policy: `docs/releasing.md`. Design: `docs/adr/0019-collector-to-muninn.md`, `docs/specs/muninn.md`.

## Unreleased

## [0.2.0](https://github.com/ouo11y/ouo11y/compare/muninn-v0.1.0...muninn-v0.2.0) (2026-11-15)


### ⚠ BREAKING CHANGES

* **muninn:** debug files and erasure without rum-api (ADR-0026) ([#197](https://github.com/ouo11y/ouo11y/issues/197))

### Added

* **muninn:** debug files and erasure without rum-api (ADR-0026) ([#197](https://github.com/ouo11y/ouo11y/issues/197)) ([1011542](https://github.com/ouo11y/ouo11y/commit/1011542023dce3953d4a5f728c70eec0e8b4016d))

## 0.1.0 - unreleased

### Added

- First release of Muninn, the replay store (ADR-0019, spec `docs/specs/muninn.md` draft). OTLP/HTTP ingest at `POST /otlp/v1/logs` for `ouo.replay.chunk` and `ouo.replay.ended` records, validated per the spec and rejected one by one through OTLP partial success; one create-only object per chunk on S3-compatible storage or a directory; read API (list a session's replays, manifest with state and missing ranges, chunk as stored); delete with tombstones; retention sweeper with `ouo-retention` object tags; self-telemetry over OTLP.
- Fed by the spec-wire Collector configuration `deploy/compose/collector/config.muninn.yaml` (stock components, disk queue with fsync); `deploy/envs/ouo-env up <env> --muninn` runs both.
