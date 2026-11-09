# MVP tracker

Phases are stacked pull requests on github.com/ouo11y/ouo11y. Merge in order.

| Phase | Branch | PR | Status | Owner agents |
|---|---|---|---|---|
| 0 Foundation | `phase-0-foundation` | [#1](https://github.com/ouo11y/ouo11y/pull/1) | done | orchestrator |
| 1 Platform + backend | `phase-1-platform` | [#2](https://github.com/ouo11y/ouo11y/pull/2) | done | platform-infra, backend-demo |
| 2 Browser SDK + web demo | `phase-2-web` | [#3](https://github.com/ouo11y/ouo11y/pull/3) | done | sdk-browser, web-demo |
| 3 rum-api | `phase-3-rum-api` | [#4](https://github.com/ouo11y/ouo11y/pull/4) | done | rum-api |
| 4 Grafana plugin | `phase-4-plugin` | [#5](https://github.com/ouo11y/ouo11y/pull/5) | done | grafana-plugin |
| 5 React Native | `phase-5-mobile` | [#6](https://github.com/ouo11y/ouo11y/pull/6) | done | sdk-react-native |
| 6 End-to-end QA + reports | `phase-6-qa` | [#7](https://github.com/ouo11y/ouo11y/pull/7) | done | qa |

## Phase 0 Foundation

- [x] AGENTS.md, repository layout
- [x] docs/MVP.md with acceptance checks
- [x] docs/specs/session-lifecycle.md
- [x] ADR 0001 to 0005
- [x] kb, agents, tracker, reports skeletons with indexes

## Phase 1 Platform + backend

- [x] `deploy/compose/compose.yaml`: Grafana, Loki, Tempo, Mimir, OTel Collector (CORS on OTLP/HTTP), demo backend
- [x] Grafana provisioning: Loki, Tempo, Mimir datasources, trace to logs correlation on `session.id`
- [x] `examples/backend`: Go API with `/api/products`, `/api/cart`, `/api/checkout` (slow and 500 variants via query flags), OTel traces and logs, baggage `session.id` copied to spans (verified: `go vet`, `go test`, docker image, trace with `session.id` found in Tempo and log line in Loki; see `project/agents/backend-demo/summaries/2026-10-06-phase-1.md`)
- [x] Smoke script: send a test span via curl and find it in Tempo; send a test log and find it in Loki
- [x] project/kb-archive/collector-lgtm.md filled

## Phase 2 Browser SDK + web demo

- [x] `sdk/browser`: init API, session manager (spec test cases 1 to 4 and 7), SpanProcessor + log attributes, fetch/XHR instrumentation with `traceparent` and baggage, errors (fatal / non-fatal), Web Vitals events, navigation events, rrweb recording with chunk upload (ADR-0003), privacy defaults, replay pause/disable (45 Vitest tests incl. jsdom integration against OTLP payloads; see `project/agents/sdk-browser/summaries/2026-10-06-phase-2.md`)
- [x] `examples/ouo-web`: React storefront with product, cart, checkout, buttons to trigger slow request, 500, uncaught error, handled error (verified by browser click-through against the backend; see `project/agents/web-demo/summaries/2026-10-06-phase-2.md`)
- [x] Verified: spans in Tempo with `session.id`, events in Loki, chunks on disk via rum-api stub or real (real Chromium session: 4 traces in Tempo incl. demo-backend child spans via baggage, 14 Loki records all with `session_id`, 8 gzip/keepalive chunks decoded by a Node stub; commands in the sdk-browser summary)
- [x] project/kb-archive/otel-browser-sdk.md and project/kb-archive/rrweb-chunking.md filled

## Phase 3 rum-api

- [x] `POST /v1/replay/chunks`, `GET /v1/sessions/{id}/replay` (+ `/replay/events` stream, `DELETE`; verified with curl and a real browser session: 11 gzip chunks on disk, 186 rrweb events served; see `project/agents/rum-api/summaries/2026-10-06-phase-3.md`)
- [x] `GET /v1/sessions` (range, platform, version, status, user filters), `GET /v1/sessions/{id}` (record + timeline events + traces) (verified: fresh web session listed as crashed with user, 22 traces, has_replay; timeline in order)
- [x] `GET /v1/stats/health` (percentages by platform and version) (verified: buckets per platform/service/version, rows sum to 100)
- [x] Session folding and classification per ADR-0004 with unit tests on fixture Loki responses (`services/rum-api/internal/session`, 8 fixtures incl. a real Loki response; synthetic mobile session classified errored / 9.9.9)
- [x] Tempo search per session with trace count and Tempo deep links (Explore `panes` URL opened in Grafana 13.2.1)
- [x] Own OTel instrumentation, Dockerfile, added to compose (`service.name=rum-api` traces in Tempo, logs in Loki)
- [x] project/kb-archive/loki-session-queries.md and project/kb-archive/tempo-session-search.md filled

## Phase 4 Grafana plugin

- [x] `plugins/ouo11y-rum-app` scaffold, route proxy to rum-api, loaded unsigned in compose Grafana (create-plugin 7.12.1 toolchain, `routes: rum/* -> jsonData.rumApiUrl`, provisioned via `deploy/compose/grafana/provisioning/plugins/ouo11y-rum-app.yaml`; verified: `/api/plugins/ouo11y-rum-app/settings` enabled, `/api/plugin-proxy/ouo11y-rum-app/rum/v1/stats/health` returns rum-api JSON; see `project/agents/grafana-plugin/summaries/2026-10-07-phase-4.md`)
- [x] Overview page: health percentages web and mobile by version, time range picker (verified in Grafana 13.2.1: tiles and version rows equal `GET /v1/stats/health?from=now-24h`)
- [x] Sessions page: table with filters, status, user, version, trace count (verified: crashed web session with user and 19 traces, filters pre-set from Overview links)
- [x] Session detail: timeline, trace list with Explore links, rrweb player synced to timeline markers (verified: Explore opens the Tempo trace view, marker and timeline clicks seek the player, inputs masked, sandboxed iframe; `project/agents/grafana-plugin/reports/phase-4-verification.html`)
- [x] project/kb-archive/grafana-app-plugin.md filled

## Phase 5 React Native

- [x] `sdk/react-native`: session manager (spec cases 1, 2, 3, 5, 6, 7), app state handling, global error handler with fatal flag, crash marker, fetch instrumentation, OTLP export (36 Vitest tests; `npm run -w sdk/react-native build` then `npm run -w sdk/react-native test`)
- [x] `examples/ouo-mobile`: Expo app with the same storefront flows and buttons for handled error, fatal error, slow and failing requests; `service.version` from app config (`APP_VERSION` env); iOS Hermes bundle builds with `npx expo export --platform ios`
- [x] Verified on iOS Simulator: sessions show up in plugin with version 2.3.0 (2026-10-08, iOS 27 simulator); crash flow verified on the simulator (fatal error, relaunch, session.end reason crash, Grafana shows crashed with replay). **Not done: no Xcode on the build machine.** Verified instead headlessly (Node playground against the real collector) and with the Expo web build: 9 + 2 mobile sessions on 2.3.0 / 2.4.0 with the expected healthy / errored / crashed statuses in rum-api, health buckets per version, Tempo traces with demo-backend spans. See `project/agents/sdk-react-native/summaries/2026-10-07-phase-5.md`.
- [x] project/kb-archive/otel-react-native.md filled

## Phase 6 End-to-end QA + reports

- [x] Scripted scenario that produces N web and mobile sessions with known statuses, then asserts the API percentages and trace counts (`tests/e2e/scenario.mjs` via `deploy/scripts/e2e.sh`: 40 sessions, 2 services x 2 versions x 5/3/2, health buckets, crashed lists, detail timelines, trace counts, Grafana links and datasource resolution; passes, run `muymf83c`; see `project/agents/qa/summaries/2026-10-08-phase-6.md`)
- [x] Every acceptance check in docs/MVP.md ticked with method (mobile check verified on Expo web, simulator still owed to Phase 5)
- [x] HTML report in `project/reports/` with health charts, session to trace table, and a screenshot-free description of the replay flow (`project/reports/mvp-verification.html`; the replay flow is described in the acceptance table and additionally illustrated with screenshots under `project/agents/qa/reports/`)
- [x] README quickstart (root `README.md`)

All MVP phases are merged (statuses corrected 2026-10-17). Bug 1 of `project/agents/qa/reports/phase-6-bugs.html` was fixed on 2026-10-08; the Phase 5 simulator check was done once Xcode was installed (Phase 7). Open work lives in [checklist.md](checklist.md).

## Phase 7 iOS replay (post-MVP, ADR-0006)

| Phase | Branch | PR | Status | Owner agents |
|---|---|---|---|---|
| 7 iOS replay | `phase-7-ios-replay` | [#9](https://github.com/ouo11y/ouo11y/pull/9) | done | ios-replay, rum-api, grafana-plugin |

- [x] `sdk/ios` Swift package: core (chunker, dedupe, redaction geometry, encoding) tested on macOS (35 tests, `sdk/ios/test.sh`); UIKit capture target written, compiles only to the stub without Xcode
- [x] Expo native module in `sdk/react-native/ios` exposing start/pause/resume/sessionDidRotate; Android no-op stub (autolinking resolves both; native compile pending Xcode)
- [x] `examples/ouo-mobile` uses a dev client (`expo prebuild`) with replay enabled (prebuild generated the project; `pod install` / `run:ios` pending Xcode)
- [x] rum-api accepts `kind: frames` chunks (8 MB), meta `kind`, `GET .../replay/frames` (validation of base64 JPEG magic, touches, viewport; 409 on mixed kinds and on events/frames of the other kind; `replay_kind` on session records; verified with `go test ./...` and curl against the rebuilt compose service, session `frames-test-1791471557`; see `project/agents/rum-api/summaries/2026-10-08-phase-7.md`)
- [x] Grafana plugin frame player with touches, scrubber, markers (34 Jest tests; visual check pending)
- [x] Verified on the iOS Simulator: text masked black in captured frames, replay plays in Grafana (project/agents/ios-replay/reports/phase-7-ios-verification.html): checkout input masked, `ouo-unmask` honoured, header texts masked, crash flow verified
- [x] project/kb-archive/ios-replay.md, project/kb-archive/xcode-setup.md

## Phase 7b UX and masking fixes

| Phase | Branch | PR | Status | Owner agents |
|---|---|---|---|---|
| 7b UX and masking | `phase-7b-ux-masking` | [#10](https://github.com/ouo11y/ouo11y/pull/10) | done | ios-replay, grafana-plugin |

- [x] Masking opt-out is correct: `maskInputs` (default true) governs text inputs separately from `maskText` (labels); `maskText: false` keeps inputs black. Swift 38 tests, RN 57 tests; verified on the iOS 27 simulator (`project/agents/ios-replay/reports/12-frame-masktext-false.jpg`)
- [x] Masking documented with opt-out options and per-view overrides in `sdk/react-native/README.md` and `sdk/ios/README.md`; demo uses `replay: { enabled: true, maskText: false }`
- [x] rum-api session records carry `replay_duration_ms` and `replay_frame_count` (list and detail), unit-tested, `go vet` / `go test` green, compose service rebuilt and checked with curl

- [x] Session detail keeps the Replay panel pinned while the Timeline scrolls in its own container; current event auto-scrolls into view during playback; panels stack below 900px (verified in Grafana 13.2.1 at 1400x900 and 800x900 on sessions `6843eaa9` and `e2a746a8`; `project/agents/grafana-plugin/reports/phase-7b-ux.html`)
- [x] Sessions list shows the replay duration and kind in a Replay column (`replay_duration_ms` / `replay_kind` from rum-api, play icon while the duration is unknown, "–" without replay; verified against the live list)
- [x] Sessions list columns are sortable client-side over the loaded page, default Started desc, indicator and tooltip (verified: Started, Status and Replay headers flip the order; 52 Jest tests incl. `sort.test.ts` and `SessionsTable.test.tsx`)

## Docs: fast-tracked onboarding (2026-10-10)

PR #12 (`fast-tracked`, stacked on #11). `examples/fast-tracked/` holds four copy-and-paste guides (stack, Go backend, React, Expo iOS) routed by `index.md`. Also fixed the demo apps' port fallbacks to the stock values. Status: done (merged). Agent folder: `project/agents/fast-tracked/`.
