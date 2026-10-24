# Changelog: ouo-collector image

`ghcr.io/ouo11y/collector` (until 0.2.0: `ghcr.io/ziadmansourm/ouo/collector`), tag `collector-v<version>`. The version is
`dist.version` in `builder.yaml` (`ouo-collector --version`). Policy: `docs/releasing.md`.

## Unreleased

## 0.4.0 (2026-10-24)

### Added

- Sentry bridge (`ouosentry`) parity: `captureMessage` as `sentry.message` (A1), HTTP span names and
  `server.*` / `url.*` attributes (A5), release / environment / OS / device on logs and per session
  (A2, A3), `session.previous_id` (A9), back navigations (A11), timeline without a replay (A8), error
  context allowlist with opt-in `copy_tags` (A6), native frames keep addresses and debug images (A7),
  startup logs join their session (N2).
- Mobile vitals from Sentry transaction `measurements` (A4, `docs/specs/mobile-vitals.md`); supported
  Sentry SDK range with golden journeys (N3).
- `ouoauth` extension counting auth failures (`ouo_auth_failures_total{reason}`), empty OTLP exports
  rate-limited by `ouoratelimit`, an `internal` project for the platform's own telemetry (N13).

### Fixed

- `golang.org/x/net` 0.60.0.

## 0.3.0 (2026-10-18)

First release under `ghcr.io/ouo11y/collector` (ADR-0009).

### Changed

- Renamed for ADR-0009: image `ghcr.io/ouo11y/collector`, Go modules `github.com/ouo11y/ouo11y/collector/...`
  (`builder.yaml` and its replace directives). Component type names (`ouosentry`, `ouoreplay`,
  `ouoratelimit`) and the binary `ouo-collector` are unchanged, so collector configs keep working.

### Added

- `ouosentry` receiver: resource attribute `ouo.rum.mode = sentry` on everything it translates,
  so dashboards can split a Sentry-to-ouo rollout by cohort (`examples/sentry-mobile/ROLLOUT.md`).

## 0.2.0 (2026-10-17)

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
