# Changelog: ouo-collector image

`ghcr.io/ziadmansourm/ouo/collector`, tag `collector-v<version>`. The version is
`dist.version` in `builder.yaml` (`ouo-collector --version`). Policy: `RELEASING.md`.

## Unreleased

## 0.2.0 (not tagged yet)

First released image. OpenTelemetry Collector components pinned to 0.160.0.

### Added

- `ouoreplay` receiver (`:4319`, `POST /v1/replay/chunks`) and exporter (to rum-api), and
  the `ouoratelimit` processor (ADR-0007).
- `ouosentry` receiver (`:4320`): Sentry SDK envelopes to OTLP, optional forwarding to Sentry
  (ADR-0008).
- Upstream: `otlp` receiver, `basicauth` and `health_check` extensions, `batch`,
  `memory_limiter`, `attributes`, `resource`, `transform` processors, `otlp`, `otlphttp`,
  `debug` exporters, `routing` connector, env / file / yaml config providers.

### Compatibility

- rum-api >= 0.2.0 (replay chunk ingest with the ingest token).
