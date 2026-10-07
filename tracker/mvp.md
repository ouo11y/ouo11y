# MVP tracker

Phases are stacked pull requests on github.com/ZiadMansourM/ouo. Merge in order.

| Phase | Branch | PR | Status | Owner agents |
|---|---|---|---|---|
| 0 Foundation | `phase-0-foundation` | [#1](https://github.com/ZiadMansourM/ouo/pull/1) | review | orchestrator |
| 1 Platform + backend | `phase-1-platform` | [#2](https://github.com/ZiadMansourM/ouo/pull/2) | review | platform-infra, backend-demo |
| 2 Browser SDK + web demo | `phase-2-web` | [#3](https://github.com/ZiadMansourM/ouo/pull/3) | review | sdk-browser, web-demo |
| 3 rum-api | `phase-3-rum-api` | | review | rum-api |
| 4 Grafana plugin | `phase-4-plugin` | [#5](https://github.com/ZiadMansourM/ouo/pull/5) | review | grafana-plugin |
| 5 React Native | `phase-5-mobile` | [#6](https://github.com/ZiadMansourM/ouo/pull/6) | review | sdk-react-native |
| 6 End-to-end QA + reports | `phase-6-qa` | | todo | qa |

## Phase 0 Foundation

- [x] AGENTS.md, repository layout
- [x] docs/MVP.md with acceptance checks
- [x] docs/specs/session-lifecycle.md
- [x] ADR 0001 to 0005
- [x] kb, agents, tracker, reports skeletons with indexes

## Phase 1 Platform + backend

- [x] `deploy/docker/compose.yaml`: Grafana, Loki, Tempo, Mimir, OTel Collector (CORS on OTLP/HTTP), demo backend
- [x] Grafana provisioning: Loki, Tempo, Mimir datasources, trace to logs correlation on `session.id`
- [x] `examples/backend`: Go API with `/api/products`, `/api/cart`, `/api/checkout` (slow and 500 variants via query flags), OTel traces and logs, baggage `session.id` copied to spans (verified: `go vet`, `go test`, docker image, trace with `session.id` found in Tempo and log line in Loki; see `agents/backend-demo/summaries/2026-10-06-phase-1.md`)
- [x] Smoke script: send a test span via curl and find it in Tempo; send a test log and find it in Loki
- [x] kb/collector-lgtm.md filled

## Phase 2 Browser SDK + web demo

- [x] `sdk/browser`: init API, session manager (spec test cases 1 to 4 and 7), SpanProcessor + log attributes, fetch/XHR instrumentation with `traceparent` and baggage, errors (fatal / non-fatal), Web Vitals events, navigation events, rrweb recording with chunk upload (ADR-0003), privacy defaults, replay pause/disable (45 Vitest tests incl. jsdom integration against OTLP payloads; see `agents/sdk-browser/summaries/2026-10-06-phase-2.md`)
- [x] `examples/web`: React storefront with product, cart, checkout, buttons to trigger slow request, 500, uncaught error, handled error (verified by browser click-through against the backend; see `agents/web-demo/summaries/2026-10-06-phase-2.md`)
- [x] Verified: spans in Tempo with `session.id`, events in Loki, chunks on disk via rum-api stub or real (real Chromium session: 4 traces in Tempo incl. demo-backend child spans via baggage, 14 Loki records all with `session_id`, 8 gzip/keepalive chunks decoded by a Node stub; commands in the sdk-browser summary)
- [x] kb/otel-browser-sdk.md and kb/rrweb-chunking.md filled

## Phase 3 rum-api

- [x] `POST /v1/replay/chunks`, `GET /v1/sessions/{id}/replay` (+ `/replay/events` stream, `DELETE`; verified with curl and a real browser session: 11 gzip chunks on disk, 186 rrweb events served; see `agents/rum-api/summaries/2026-10-06-phase-3.md`)
- [x] `GET /v1/sessions` (range, platform, version, status, user filters), `GET /v1/sessions/{id}` (record + timeline events + traces) (verified: fresh web session listed as crashed with user, 22 traces, has_replay; timeline in order)
- [x] `GET /v1/stats/health` (percentages by platform and version) (verified: buckets per platform/service/version, rows sum to 100)
- [x] Session folding and classification per ADR-0004 with unit tests on fixture Loki responses (`services/rum-api/internal/session`, 8 fixtures incl. a real Loki response; synthetic mobile session classified errored / 9.9.9)
- [x] Tempo search per session with trace count and Tempo deep links (Explore `panes` URL opened in Grafana 13.2.1)
- [x] Own OTel instrumentation, Dockerfile, added to compose (`service.name=rum-api` traces in Tempo, logs in Loki)
- [x] kb/loki-session-queries.md and kb/tempo-session-search.md filled

## Phase 4 Grafana plugin

- [x] `plugins/ouo-rum-app` scaffold, route proxy to rum-api, loaded unsigned in compose Grafana (create-plugin 7.12.1 toolchain, `routes: rum/* -> jsonData.rumApiUrl`, provisioned via `deploy/docker/grafana/provisioning/plugins/ouo-rum-app.yaml`; verified: `/api/plugins/ouo-rum-app/settings` enabled, `/api/plugin-proxy/ouo-rum-app/rum/v1/stats/health` returns rum-api JSON; see `agents/grafana-plugin/summaries/2026-10-07-phase-4.md`)
- [x] Overview page: health percentages web and mobile by version, time range picker (verified in Grafana 13.2.1: tiles and version rows equal `GET /v1/stats/health?from=now-24h`)
- [x] Sessions page: table with filters, status, user, version, trace count (verified: crashed web session with user and 19 traces, filters pre-set from Overview links)
- [x] Session detail: timeline, trace list with Explore links, rrweb player synced to timeline markers (verified: Explore opens the Tempo trace view, marker and timeline clicks seek the player, inputs masked, sandboxed iframe; `agents/grafana-plugin/reports/phase-4-verification.html`)
- [x] kb/grafana-app-plugin.md filled

## Phase 5 React Native

- [x] `sdk/react-native`: session manager (spec cases 1, 2, 3, 5, 6, 7), app state handling, global error handler with fatal flag, crash marker, fetch instrumentation, OTLP export (36 Vitest tests; `npm run -w sdk/react-native build` then `npm run -w sdk/react-native test`)
- [x] `examples/mobile`: Expo app with the same storefront flows and buttons for handled error, fatal error, slow and failing requests; `service.version` from app config (`APP_VERSION` env); iOS Hermes bundle builds with `npx expo export --platform ios`
- [ ] Verified on iOS Simulator: sessions and crash show up in plugin with version split. **Not done: no Xcode on the build machine.** Verified instead headlessly (Node playground against the real collector) and with the Expo web build: 9 + 2 mobile sessions on 2.3.0 / 2.4.0 with the expected healthy / errored / crashed statuses in rum-api, health buckets per version, Tempo traces with demo-backend spans. See `agents/sdk-react-native/summaries/2026-10-07-phase-5.md`.
- [x] kb/otel-react-native.md filled

## Phase 6 End-to-end QA + reports

- [ ] Scripted scenario that produces N web and mobile sessions with known statuses, then asserts the API percentages and trace counts
- [ ] Every acceptance check in docs/MVP.md ticked with method
- [ ] HTML report in `reports/` with health charts, session to trace table, and a screenshot-free description of the replay flow
- [ ] README quickstart
