# Changelog: muninn

`ghcr.io/ouo11y/muninn`, tag `muninn-v<version>`. Policy: `docs/releasing.md`. Design: `docs/adr/0019-collector-to-muninn.md`, `docs/specs/muninn.md`.

## Unreleased

## 0.1.0 - unreleased

### Added

- First release of Muninn, the replay store (ADR-0019, spec `docs/specs/muninn.md` draft). OTLP/HTTP ingest at `POST /otlp/v1/logs` for `ouo.replay.chunk` and `ouo.replay.ended` records, validated per the spec and rejected one by one through OTLP partial success; one create-only object per chunk on S3-compatible storage or a directory; read API (list a session's replays, manifest with state and missing ranges, chunk as stored); delete with tombstones; retention sweeper with `ouo-retention` object tags; self-telemetry over OTLP.
- Fed by the spec-wire Collector configuration `deploy/compose/collector/config.muninn.yaml` (stock components, disk queue with fsync); `deploy/envs/ouo-env up <env> --muninn` runs both.
