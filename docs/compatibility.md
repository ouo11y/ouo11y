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
| browser | 0.4 | >= 0.2.0 | >= 0.2.0 | - | - | `rrweb/2` as `ouo.replay.chunk` log records (OTLP protobuf) on `/v1/logs` | rebuilt on the client SDK spec `0.1.0-draft` ([ADR-0020](adr/0020-web-sdk-rebuilt-on-the-spec.md)): new API (`init`, `recordEvent`, ...) and the spec's wire names, so it is a breaking upgrade from 0.3. Telemetry works with the listed collector and rum-api: sessions, timelines, traces and symbolicated errors are listed; rum-api does not classify the new event names as vitals, clicks or navigations. **Replay is recorded but not playable yet**: no released collector routes scope `ouo.replay` (it forwards the chunks to Loki with their body) and no released plugin plays them; that needs the collector to Muninn route |
| browser | 0.3 | >= 0.2.0 | >= 0.2.0 | - | - | rrweb (no `schema_version`) | gzip OTLP and replay with retry and an offline store; with rum-api >= 0.5 stacks are symbolicated from uploaded source maps (ADR-0011) and sessions carry `device_id`; older rum-api shows raw stacks |
| browser | 0.2 | >= 0.2.0 | >= 0.2.0 | - | - | rrweb (no `schema_version`) | HTTP Basic project credentials on OTLP and replay; 0.1.x posted unauthenticated |
| react-native | 0.4 | >= 0.2.0 | >= 0.6.0 | - | - | `ouo-frames/3` and `ouo-video/1` as `ouo.replay.chunk` log records (OTLP protobuf) on `/v1/logs`, ended by `ouo.replay.ended` | failure isolation, consent, `beforeSend`, bypass sampling and the spec API ([ADR-0021](adr/0021-react-native-sdk-keep-and-extend.md) step A), so it is a breaking upgrade from 0.3: `session.id` is 32 lowercase hex, session baggage is opt-in, query values in recorded URLs are redacted, timeouts below 60 s are clamped. Telemetry works with the listed collector and rum-api. **Replay is stored but not playable yet**: the default collector config forwards the chunks to Loki with their body; a Collector on `deploy/compose/collector/config.muninn.yaml` stores them in Muninn >= 0.1.0, which no released plugin plays from. The replay endpoint (`:4319`, `replayEndpoint`) is gone |
| react-native | 0.3 | >= 0.5.0 | >= 0.6.0 | >= 0.10.0 | - | frames, schema 2 | iOS replay tiles (schema 2), the plugin plays them from 0.10; offline OTLP outbox, feedback, readable steps; vendors the `sdk/ios` Swift sources of its release commit through CocoaPods |
| react-native | 0.2 | >= 0.2.0 | >= 0.2.0 | - | - | frames, schema 1 | vendors the `sdk/ios` Swift sources through CocoaPods |
| ios | 0.3 | >= 0.5.0 | >= 0.6.0 | >= 0.10.0 | - | frames, schema 2 | first mirrored release; `OuoSDK` for native apps (sessions, screens, taps, OTLP logs and traces, network, crashes, hangs, vitals, feedback); the plugin plays schema 2 from 0.10 |
| ios | 0.2 | >= 0.2.0 | >= 0.2.0 | - | - | frames, schema 1 | `POST /v1/replay/chunks` on the replay receiver (`:4319`) |
| collector | 0.7 | - | >= 0.2.0 | - | - | accepts schema <= 2 | Sentry bridge `replay_wire: muninn`: Sentry replays as Muninn chunks (`rrweb/2` for browser recordings, `ouo-video/1` for mobile video) for a Collector that routes scope `ouo.replay` to Muninn >= 0.1.0 ([spec 9d](specs/sentry-bridge.md)); `legacy` (default) is unchanged |
| collector | 0.6 | - | >= 0.2.0 | - | - | accepts schema <= 2 | Sentry bridge `mirrors` and `passthrough_upstream` for production DSNs ([ADR-0028](adr/0028-sentry-bridge-mirrors-and-passthrough.md)), the request's `X-Forwarded-For` reaches `ouoratelimit`; React Native replay over OTLP (`pixel/frames`, `pixel/video`, ADR-0021). 0.6.1: a numeric Sentry `user.id` no longer drops the event |
| collector | 0.5 | - | >= 0.2.0 | - | - | accepts schema <= 2 | frames schema 2 checked at the edge, Sentry `feedback` / `user_report` as `feedback` records; schema 2 chunks need rum-api >= 0.6.0 (older rum-api answers 400) |
| collector | 0.4 | - | >= 0.2.0 | - | - | accepts schema <= 1 | replay exporter posts to rum-api with the ingest token; `ouo.rum.mode` on bridged data |
| muninn | 0.1 | - | - | - | - | stores any `ouo.replay.format` opaquely (`rrweb/2`, `ouo-frames/3`, `ouo-video/1`, `ouo-wireframe/1`) | the replay store ([ADR-0019](adr/0019-collector-to-muninn.md), [spec](specs/muninn.md)); fed by a Collector running `deploy/compose/collector/config.muninn.yaml`, which needs the `file_storage` extension (ouo-collector after 0.5.0, or any contrib Collector); no plugin plays from it yet |
| muninn | 0.2 | - | - | - | - | stores any `ouo.replay.format` opaquely (`rrweb/2`, `ouo-frames/3`, `ouo-video/1`, `ouo-wireframe/1`) | adds debug files and erasure ([ADR-0026](adr/0026-debug-files-and-erasure-without-rum-api.md), [spec](specs/muninn.md)): a public, write-only upload route checked by a per-project upload token (source maps and dSYM slices, write-once), private reads, project delete and create-only audit entries behind `auth.admin_token`. Breaking: `@ouo11y/sourcemaps` uploads here instead of rum-api, and erasure runs through `ouo-erase` (`libs/ouo-go`). Same Collector config as 0.1 |
| kit | 0.1 | - | - | - | - | plays `rrweb/2`; names `ouo-frames/3`, `ouo-video/1` and `ouo-wireframe/1` as stored, not playable | `@ouo11y/kit` ([ADR-0025](adr/0025-generic-libs-clients-own-plugin-and-access.md)): the replay player for a client's own frontend; it plays a Muninn >= 0.1.0 manifest (spec 7.2) with chunks fetched by the caller; React >= 18 |
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
