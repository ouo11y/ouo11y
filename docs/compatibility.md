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
| react-native | 0.3 | >= 0.5.0 | >= 0.6.0 | >= 0.10.0 | - | frames, schema 2 | iOS replay tiles (schema 2), the plugin plays them from 0.10; offline OTLP outbox, feedback, readable steps; vendors the `sdk/ios` Swift sources of its release commit through CocoaPods |
| react-native | 0.2 | >= 0.2.0 | >= 0.2.0 | - | - | frames, schema 1 | vendors the `sdk/ios` Swift sources through CocoaPods |
| ios | 0.3 | >= 0.5.0 | >= 0.6.0 | >= 0.10.0 | - | frames, schema 2 | first mirrored release; `OuoSDK` for native apps (sessions, screens, taps, OTLP logs and traces, network, crashes, hangs, vitals, feedback); the plugin plays schema 2 from 0.10 |
| ios | 0.2 | >= 0.2.0 | >= 0.2.0 | - | - | frames, schema 1 | `POST /v1/replay/chunks` on the replay receiver (`:4319`) |
| collector | 0.5 | - | >= 0.2.0 | - | - | accepts schema <= 2 | frames schema 2 checked at the edge, Sentry `feedback` / `user_report` as `feedback` records; schema 2 chunks need rum-api >= 0.6.0 (older rum-api answers 400) |
| collector | 0.4 | - | >= 0.2.0 | - | - | accepts schema <= 1 | replay exporter posts to rum-api with the ingest token; `ouo.rum.mode` on bridged data |
| rum-api | 0.6 | - | - | - | - | reads schema <= 2 | frames schema 2 (ADR-0014), dSYM upload and native crash symbolication (W7); writes schema 2 into the store marker, so afterwards rum-api 0.4 and 0.5 refuse to start on its store; 0.3.0 and older have no guard and must never run on it (upgrade.md section 4) |
| rum-api | 0.5 | - | - | - | - | reads schema <= 1 | source maps upload and symbolication (ADR-0011), funnels (ADR-0012), session `device_id`; storage compatible with 0.4 (maps stored next to the replays) |
| rum-api | 0.4 | - | - | - | - | reads schema <= 1 | data lifecycle (8b), replay `masked` flag, session `context`; storage compatible with 0.3 |
| plugin | 0.10 | - | >= 0.4.0 | - | >= 13.0.0 | plays schema <= 2 | frame player on a canvas for schema 2 tiles; native symbolicated frames need rum-api >= 0.6.0; readable mobile steps and the feedback list |
| plugin | 0.9 | - | >= 0.4.0 | - | >= 13.0.0 | - | Funnels page needs rum-api >= 0.5.0; source-mapped stacks need rum-api >= 0.5.0 and show the raw stack otherwise |
| plugin | 0.8 | - | >= 0.4.0 | - | >= 13.0.0 | - | Timeline behind a toggle; with rum-api 0.3 the masking state and header context fall back |
| grafana | 0.6 | - | >= 0.4.0 | >= 0.10.0 | - | - | ships Grafana 13.2.5 with plugin 0.10.0 inside; schema 2 replays and native symbolicated frames need rum-api >= 0.6.0 |
| grafana | 0.5 | - | >= 0.4.0 | >= 0.9.0 | - | - | ships Grafana 13.2.1 with plugin 0.9.0 inside (0.5.1 was never released; its 13.2.5 base ships in 0.6.0); funnels and source-mapped stacks need rum-api >= 0.5.0 |
| grafana | 0.4 | - | >= 0.4.0 | >= 0.8.0 | - | - | ships Grafana 13.2.1 with plugin 0.8.0 inside |
| chart | 0.2 | >= 0.5.0 | >= 0.6.0 | - | - | - | first published chart; defaults to rum-api 0.6.0, collector 0.5.0 and the grafana image 0.6.0 (plugin 0.10.0); roll forward only, no rollback to chart 0.1.x once rum-api 0.6.0 has run; `lgtm.external.tenantId` / `lokiDeleteUrl` reach rum-api as `loki.tenant_id`, `tempo.tenant_id`, `loki.delete_url`, keys rum-api 0.6.0 rejects: the chart refuses them with a rum-api tag <= 0.6.0 (needs the next rum-api release, operations/existing-lgtm.md); Kubernetes >= 1.25 |
| chart | 0.1 | >= 0.3.0 | >= 0.3.0 | - | - | - | defaults to the grafana image 0.3.0; Kubernetes >= 1.25 |

## Replay schema

The replay chunk `schema_version` ([`specs/mobile-replay.md`](specs/mobile-replay.md)) is one
integer across the platform. Raising it is a breaking change for stored data (rum-api minor bump,
upgrade note in [`operations/upgrade.md`](operations/upgrade.md), section 4).

<!-- compat:schema -->
| Where | schema_version | Source |
|---|---|---|
| rum-api reads at most | 2 | `services/rum-api/internal/replay/schema.go` |
| collector replay receiver accepts at most | 2 | `collector/receiver/ouoreplayreceiver/chunk.go` |
| collector Sentry bridge emits (video, stays 1 per ADR-0014) | 1 | `collector/receiver/ouosentryreceiver/replay.go` |
| iOS and React Native emit (frames) | 2 | `sdk/ios/Sources/OuoReplayCore/Models.swift` |

## React Native hosts

The app-side versions `@ouo11y/react-native` (0.3 line) runs in. The JavaScript side (sessions, JS
errors, OTLP, network, taps, feedback) needs only `react-native` >= 0.74; the native side (replay,
native crashes, hangs, terminations, vitals, gzip delivery) is an Expo module and needs
`expo-modules-core` >= 2.0 (Expo SDK 52 and later: `expo-module-gradle-plugin`). Bare apps add Expo
modules with `npx install-expo-modules` ([`sdk/react-native/README.md`](../sdk/react-native/README.md#bare-react-native),
"Bare React Native"). Not in the release check's tables: it reads `compat:` markers only.

| Host | React Native | Expo SDK / `expo-modules-core` | iOS min / Xcode | Android: AGP / Kotlin / Gradle / JDK / compileSdk / minSdk | Status | Evidence |
|---|---|---|---|---|---|---|
| Expo (managed, prebuild) | 0.86.3 | 57 / 57.0.x | 15.1 / Xcode 27 | 8.12 / 2.1.20 / 9.3.1 / 17 / 36 / 24 | **built and tested** (the SDK's own target) | `examples/ouo-mobile`, the conformance suites, CI jobs `examples` and `android` |
| Bare + `install-expo-modules`, Firebase pods, static frameworks | 0.82.1 | 54 (`--sdk-version 54.0.0`) / 3.0.30 with a two-line patch | 15.1 / Xcode 27 | 8.12.0 / 2.1.20 / 9.0.0 (React Native 0.82's) / 17 / 36 / 24 | **built and tested** | `examples/ouo-bare-rn` (iOS Simulator `scripts/verify-ios.sh`, Android emulator API 35 conformance suite), CI job `bare-rn` (build) |
| Bare + `install-expo-modules` | 0.81, 0.83 to 0.85 | 54, 55, 56 (the installer's default) | 15.1 (SDK 54, 55), 16.4 (SDK 56) | the React Native version's | expected to work, untested | same path as 0.82 without the patch |
| Expo or bare | 0.76 to 0.80 | 52, 53 / 2.x | 15.1 | the React Native version's | untested | `expo-modules-core` >= 2.0 is the peer range |
| Bare without Expo modules | >= 0.74 | none | - | - | JavaScript side only; native capabilities are no-ops | `sdk/react-native/README.md`, "Session replay" |

Expo SDK 55 does not build on React Native 0.82 (it uses `RCTDevMenuConfiguration`, added in 0.83),
and SDK 54's `expo-modules-core` 3.0.30 needs `#import <ReactCommon/CallInvoker.h>` and
`#import <react/bridging/CallbackWrapper.h>` in `ios/JSI/EXJSIUtils.h` on 0.82
(`examples/ouo-bare-rn/patches/`). The SDK's own native code needed no change for these versions.
Known issues of the 0.82 toolchain under Xcode 27 that are not ouo's (the `fmt` pod, pod
deployment targets, the UIScene life cycle) are in
[`project/kb/rn-bare-install-expo-modules.md`](../project/kb/rn-bare-install-expo-modules.md).

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
