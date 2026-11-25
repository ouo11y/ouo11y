# Changelog: ouo-collector image

`ghcr.io/ouo11y/collector` (until 0.2.0: `ghcr.io/ziadmansourm/ouo/collector`), tag `collector-v<version>`. The version is
`dist.version` in `builder.yaml` (`ouo-collector --version`). Policy: `docs/releasing.md`.

## Unreleased

## [0.7.0](https://github.com/ouo11y/ouo11y/compare/collector-v0.6.1...collector-v0.7.0) (2026-11-25)


### Added

* **collector:** Sentry replays on the Muninn wire (rrweb/2 for browsers, ouo-video/1 for mobile) ([#221](https://github.com/ouo11y/ouo11y/issues/221)) ([d010231](https://github.com/ouo11y/ouo11y/commit/d01023124c8cb9e7a1c7c2004a9e40092b44515b))

## [0.6.1](https://github.com/ouo11y/ouo11y/compare/collector-v0.6.0...collector-v0.6.1) (2026-11-25)


### Fixed

* **collector:** numeric Sentry user.id no longer drops the event ([#218](https://github.com/ouo11y/ouo11y/issues/218)) ([50b8b1d](https://github.com/ouo11y/ouo11y/commit/50b8b1d12846178b515cc2af76e25b89fc08ebe5))

## [0.6.0](https://github.com/ouo11y/ouo11y/compare/collector-v0.5.0...collector-v0.6.0) (2026-11-18)


### ⚠ BREAKING CHANGES

* **react-native:** session replay over OTLP with pixel/frames and pixel/video on iOS and Android (ADR-0021) ([#184](https://github.com/ouo11y/ouo11y/issues/184))

### Added

* **collector:** hold Sentry user reports until their error, bridge feedback in the sentry-mobile journey ([7f2e315](https://github.com/ouo11y/ouo11y/commit/7f2e315cba45310f06f9fa3fe93903cce50d035e))
* **collector:** Sentry bridge mirrors and passthrough for production DSNs (ADR-0028) ([60094b2](https://github.com/ouo11y/ouo11y/commit/60094b255f5ee647d0ed7d6bfb871eee37096722))
* **muninn:** replay store and spec-wire Collector config for the pilot ([#185](https://github.com/ouo11y/ouo11y/issues/185)) ([e39a938](https://github.com/ouo11y/ouo11y/commit/e39a938d8f4e9c4e580e57653bd537f95adb9335))
* **react-native:** session replay over OTLP with pixel/frames and pixel/video on iOS and Android (ADR-0021) ([#184](https://github.com/ouo11y/ouo11y/issues/184)) ([edd3fa2](https://github.com/ouo11y/ouo11y/commit/edd3fa28889c4252de4c12e9a08c8091d177ca13))


### Fixed

* **collector:** bump klauspost/compress to v1.20.2 for GO-2026-6865 ([4705348](https://github.com/ouo11y/ouo11y/commit/47053484a79206a0c9ed0e7664af0c4afee00dcf))

## [0.5.0](https://github.com/ouo11y/ouo11y/compare/collector-v0.4.0...collector-v0.5.0) (2026-10-31)

### Added

- **Replay frames schema 2** (ADR-0014, `docs/specs/mobile-replay.md`): the `ouoreplay` receiver
  accepts `schema_version` up to 2 and checks every frame as rum-api 0.6 does (exactly one of
  `jpeg` and `patches`, a full image first, base64 JPEG, patches inside the latest full image);
  a chunk that fails is refused at the edge with `400`
  ([3e6afc9](https://github.com/ouo11y/ouo11y/commit/3e6afc944d019a8ba3688fa6a3e92b1d7b8168bb)).
- **User feedback through the Sentry bridge** (W6, `docs/specs/sentry-bridge.md` section 9c):
  Sentry `feedback` events and legacy `user_report` envelopes become the same `feedback` record
  the React Native SDK sends (`ouo.feedback.message`, `ouo.feedback.contact`, `ouo.feedback.id`);
  a new session rule `event` finds a report's session by the error event id it names
  ([b94514f](https://github.com/ouo11y/ouo11y/commit/b94514f3448af04b71d41d53c3bf365df02177b3)).

### Compatibility

- Upgrade rum-api to 0.6 before this collector carries schema 2 chunks: rum-api 0.5 and older
  answer `400` to them. Everything else works with rum-api >= 0.2.0, as 0.4 did.
- The Sentry bridge still emits video replays at schema 1 (ADR-0014).

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
