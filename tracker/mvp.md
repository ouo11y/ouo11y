# MVP tracker

Phases are stacked pull requests on github.com/ZiadMansourM/ouo. Merge in order.

| Phase | Branch | PR | Status | Owner agents |
|---|---|---|---|---|
| 0 Foundation | `phase-0-foundation` | | review | orchestrator |
| 1 Platform + backend | `phase-1-platform` | | todo | platform-infra, backend-demo |
| 2 Browser SDK + web demo | `phase-2-web` | | todo | sdk-browser, web-demo |
| 3 rum-api | `phase-3-rum-api` | | todo | rum-api |
| 4 Grafana plugin | `phase-4-plugin` | | todo | grafana-plugin |
| 5 React Native | `phase-5-mobile` | | todo | sdk-react-native |
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

- [ ] `sdk/browser`: init API, session manager (spec test cases 1 to 4 and 7), SpanProcessor + log attributes, fetch/XHR instrumentation with `traceparent` and baggage, errors (fatal / non-fatal), Web Vitals events, navigation events, rrweb recording with chunk upload (ADR-0003), privacy defaults, replay pause/disable
- [ ] `examples/web`: React storefront with product, cart, checkout, buttons to trigger slow request, 500, uncaught error, handled error
- [ ] Verified: spans in Tempo with `session.id`, events in Loki, chunks on disk via rum-api stub or real
- [ ] kb/otel-browser-sdk.md and kb/rrweb-chunking.md filled

## Phase 3 rum-api

- [ ] `POST /v1/replay/chunks`, `GET /v1/sessions/{id}/replay`
- [ ] `GET /v1/sessions` (range, platform, version, status, user filters), `GET /v1/sessions/{id}` (record + timeline events + traces)
- [ ] `GET /v1/stats/health` (percentages by platform and version)
- [ ] Session folding and classification per ADR-0004 with unit tests on fixture Loki responses
- [ ] Tempo search per session with trace count and Tempo deep links
- [ ] Own OTel instrumentation, Dockerfile, added to compose
- [ ] kb/loki-session-queries.md and kb/tempo-session-search.md filled

## Phase 4 Grafana plugin

- [ ] `plugins/ouo-rum-app` scaffold, route proxy to rum-api, loaded unsigned in compose Grafana
- [ ] Overview page: health percentages web and mobile by version, time range picker
- [ ] Sessions page: table with filters, status, user, version, trace count
- [ ] Session detail: timeline, trace list with Explore links, rrweb player synced to timeline markers
- [ ] kb/grafana-app-plugin.md filled

## Phase 5 React Native

- [ ] `sdk/react-native`: session manager (spec cases 1, 2, 3, 5, 6, 7), app state handling, global error handler with fatal flag, crash marker, fetch instrumentation, OTLP export
- [ ] `examples/mobile`: Expo app with the same storefront flows and buttons for handled error, fatal error, slow and failing requests; `service.version` from app config
- [ ] Verified on iOS Simulator: sessions and crash show up in plugin with version split
- [ ] kb/otel-react-native.md filled

## Phase 6 End-to-end QA + reports

- [ ] Scripted scenario that produces N web and mobile sessions with known statuses, then asserts the API percentages and trace counts
- [ ] Every acceptance check in docs/MVP.md ticked with method
- [ ] HTML report in `reports/` with health charts, session to trace table, and a screenshot-free description of the replay flow
- [ ] README quickstart
