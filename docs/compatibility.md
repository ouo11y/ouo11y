# Compatibility matrix

Which versions of the ouo components work together. One row per **release line** (major.minor;
patches never change a contract). The release check (`.github/workflows/release-check.yml`, on
every release PR) reads the two tables below with `.github/scripts/compat-check.mjs` and fails
when:

- a component's version in `.github/release-please/manifest.json` has no line here (a release PR
  that starts a new minor must add its row, stating what it needs);
- a "needs" bound names a version newer than the current version of that component;
- the replay `schema_version` values below differ from what the code accepts and emits;
- a Helm chart default image tag is newer than the released image.

It then starts the stack from the release PR's head and runs the end-to-end scenario
(`tests/e2e/scenario.mjs`): collector, rum-api and plugin at their newest lines, together.

Policy for bumps is in [`releasing.md`](releasing.md); the upgrade order in
[`operations/upgrade.md`](operations/upgrade.md).

## Release lines

`>= x.y.z` is a minimum; `-` means no dependency. SDKs talk only to the collector (ADR-0007);
their rum-api bound is what stores and serves what they send.

<!-- compat:lines -->
| Component | Line | Needs collector | Needs rum-api | Needs plugin | Needs Grafana | Replay | Notes |
|---|---|---|---|---|---|---|---|
| browser | 0.3 | >= 0.2.0 | >= 0.2.0 | - | - | rrweb (no `schema_version`) | gzip OTLP and replay with retry and an offline store; with rum-api >= 0.5 stacks are symbolicated from uploaded source maps (ADR-0011) and sessions carry `device_id`; older rum-api shows raw stacks |
| browser | 0.2 | >= 0.2.0 | >= 0.2.0 | - | - | rrweb (no `schema_version`) | HTTP Basic project credentials on OTLP and replay; 0.1.x posted unauthenticated |
| react-native | 0.2 | >= 0.2.0 | >= 0.2.0 | - | - | frames, schema 1 | vendors the `sdk/ios` Swift sources through CocoaPods |
| ios | 0.2 | >= 0.2.0 | >= 0.2.0 | - | - | frames, schema 1 | `POST /v1/replay/chunks` on the replay receiver (`:4319`) |
| collector | 0.4 | - | >= 0.2.0 | - | - | accepts schema <= 1 | replay exporter posts to rum-api with the ingest token; `ouo.rum.mode` on bridged data |
| rum-api | 0.4 | - | - | - | - | reads schema <= 1 | data lifecycle (8b), replay `masked` flag, session `context`; storage compatible with 0.3 |
| plugin | 0.8 | - | >= 0.4.0 | - | >= 13.0.0 | - | Timeline behind a toggle; with rum-api 0.3 the masking state and header context fall back |
| grafana | 0.4 | - | >= 0.4.0 | >= 0.8.0 | - | - | ships Grafana 13.2.1 with plugin 0.8.0 inside |
| chart | 0.1 | >= 0.3.0 | >= 0.3.0 | - | - | - | defaults to the grafana image 0.3.0; Kubernetes >= 1.25 |

## Replay schema

The replay chunk `schema_version` ([`specs/mobile-replay.md`](specs/mobile-replay.md)) is one
integer across the platform. Raising it is a breaking change for stored data (rum-api minor bump,
upgrade note in [`operations/upgrade.md`](operations/upgrade.md), section 4).

<!-- compat:schema -->
| Where | schema_version | Source |
|---|---|---|
| rum-api reads at most | 1 | `services/rum-api/internal/replay/schema.go` |
| collector replay receiver accepts at most | 1 | `collector/receiver/ouoreplayreceiver/chunk.go` |
| collector Sentry bridge emits (video) | 1 | `collector/receiver/ouosentryreceiver/replay.go` |
| iOS and React Native emit (frames) | 1 | `sdk/ios/Sources/OuoReplayCore/Models.swift` |

## Sentry SDKs through the bridge

Which Sentry SDK versions the `ouosentry` bridge (collector) is tested against
([`specs/sentry-bridge.md`](specs/sentry-bridge.md), checklist N3). Each captured version has a golden
journey in `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-<version>/` and a row in
`versions_test.go`: launch, navigation, network calls, a shop round, errors, 40 s background, native
crash, relaunch, captured from `examples/sentry-mobile` on the iOS 27 simulator. Client setup:
[`sentry-client-setup.md`](sentry-client-setup.md).

| `@sentry/react-native` | sentry-cocoa | Status | Notes |
|---|---|---|---|
| 8.30.0 to 8.32.0 (current major; 8.30.0 and 8.32.0 captured) | 9.30.1, 9.31.0 | **supported** | Everything in the spec: sessions, errors and native crashes, transactions with `http.client` spans, backend traces with `propagateTraceparent`, video replay with touches, logs, breadcrumbs, mobile vitals (app start, TTID, frames, stalls) |
| 7.11.0 (the Expo SDK 57 default) | 8.58.0 | **partial, upgrade to 8.x** | Sessions, errors, the native crash (`EXC_BREAKPOINT` instead of `EXC_BAD_ACCESS`), replay, logs and navigation are translated. Under Expo 57 (React Native 0.86) the SDK traces no `fetch`: no `http.client` spans, no `traceparent`, so no backend correlation and no failed-request records. It sends no app start, reports TTID in days (dropped) and stamps transactions hours in the past, so their spans fall outside their sessions. These are what the SDK sends; the bridge cannot repair them |
| other 8.x | 9.x | expected to work | Same envelope format; capture a golden journey before relying on it |
| 7.x other than 7.11.0, older majors | | untested | Only if a client runs one (founder decision 2026-10-17) |

Not built yet (medium term, checklist N3 and B6): native `sentry-cocoa` apps without React Native,
and `sentry-java` / `sentry-android` (no Android envelope or replay has been captured). Browser SDKs
are out of scope: the bridge has no CORS and does not translate rrweb replays.

A new SDK version is supported once its journey is captured (`examples/sentry-mobile/scripts/run.sh
--full` with `collector/tools/sentrytap` between the app and the bridge), committed under
`testdata/golden/ios-rn-<version>/journey`, given a row in `versions_test.go`, and the example's
`verify` passes against it.

## Rules of thumb

- Upgrade the collector and rum-api before the SDKs. An SDK one minor **behind** the collector
  is supported; an SDK **ahead** of it is not.
- The grafana image line names the Grafana base and the plugin inside; plugin-only users follow
  the plugin row.
- The chart pins image versions; a chart release never points at an image that is not tagged.
- Released together and verified: the release trains table in [`CHANGELOG.md`](../CHANGELOG.md).
