# Changelog: ouo-collector image

`ghcr.io/ouo11y/collector` (until 0.2.0: `ghcr.io/ziadmansourm/ouo/collector`), tag `collector-v<version>`. The version is
`dist.version` in `builder.yaml` (`ouo-collector --version`). Policy: `docs/releasing.md`.

## Unreleased

## [0.5.0](https://github.com/ouo11y/ouo11y/compare/collector-v0.4.0...collector-v0.5.0) (2026-10-31)


### Added

* **collector:** count auth failures, rate-limit empty exports, internal project; live edge QA (N13, N15, N16, N4) ([#48](https://github.com/ouo11y/ouo11y/issues/48)) ([82fc68a](https://github.com/ouo11y/ouo11y/commit/82fc68a9f0ca506ee698a66b276edb675c75819e))
* **collector:** mobile vitals, Sentry SDK range, examples with trace-continuity verify ([#45](https://github.com/ouo11y/ouo11y/issues/45)) ([131b206](https://github.com/ouo11y/ouo11y/commit/131b2063324a28ad991a05db7e03c2f9cb0cc427))
* **react-native:** feedback primitive with plugin view and Sentry mapping (W6) ([b94514f](https://github.com/ouo11y/ouo11y/commit/b94514f3448af04b71d41d53c3bf365df02177b3))
* **replay:** frames schema 2 in rum-api, the collector and the frame player (W3a) ([3e6afc9](https://github.com/ouo11y/ouo11y/commit/3e6afc944d019a8ba3688fa6a3e92b1d7b8168bb))


### Fixed

* **deps:** golang.org/x/net 0.60.0 and dompurify 3.4.17 ([cd1f011](https://github.com/ouo11y/ouo11y/commit/cd1f0118c3649b3aa6ac782a60567f0f46ed584c))

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
