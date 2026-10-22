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
| browser | 0.2 | >= 0.2.0 | >= 0.2.0 | - | - | rrweb (no `schema_version`) | HTTP Basic project credentials on OTLP and replay; 0.1.x posted unauthenticated |
| react-native | 0.2 | >= 0.2.0 | >= 0.2.0 | - | - | frames, schema 1 | vendors the `sdk/ios` Swift sources through CocoaPods |
| ios | 0.2 | >= 0.2.0 | >= 0.2.0 | - | - | frames, schema 1 | `POST /v1/replay/chunks` on the replay receiver (`:4319`) |
| collector | 0.3 | - | >= 0.2.0 | - | - | accepts schema <= 1 | replay exporter posts to rum-api with the ingest token; `ouo.rum.mode` on bridged data |
| rum-api | 0.3 | - | - | - | - | reads schema <= 1 | same API and storage as 0.2 |
| plugin | 0.7 | - | >= 0.2.0 | - | >= 13.0.0 | - | ID `ouo11y-rum-app` (was `ouo-rum-app` up to 0.6) |
| grafana | 0.3 | - | >= 0.2.0 | >= 0.7.0 | - | - | ships Grafana 13.2.1 with plugin 0.7.0 inside |
| chart | 0.1 | >= 0.3.0 | >= 0.3.0 | - | - | - | defaults to the grafana image 0.3.0; Kubernetes >= 1.25 |

## Replay schema

The replay chunk `schema_version` ([`specs/mobile-replay.md`](specs/mobile-replay.md)) is one
integer across the platform. Raising it is a breaking change for stored data (rum-api minor bump,
upgrade note in [`operations/upgrade.md`](operations/upgrade.md), section 4).

<!-- compat:schema -->
| Where | schema_version | Source |
|---|---|---|
| rum-api reads at most | 1 | `services/rum-api/internal/replay/parse.go` |
| collector replay receiver accepts at most | 1 | `collector/receiver/ouoreplayreceiver/chunk.go` |
| collector Sentry bridge emits (video) | 1 | `collector/receiver/ouosentryreceiver/replay.go` |
| iOS and React Native emit (frames) | 1 | `sdk/ios/Sources/OuoReplayCore/Models.swift` |

## Rules of thumb

- Upgrade the collector and rum-api before the SDKs. An SDK one minor **behind** the collector
  is supported; an SDK **ahead** of it is not.
- The grafana image line names the Grafana base and the plugin inside; plugin-only users follow
  the plugin row.
- The chart pins image versions; a chart release never points at an image that is not tagged.
- Released together and verified: the release trains table in [`CHANGELOG.md`](../CHANGELOG.md).
