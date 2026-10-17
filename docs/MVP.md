# MVP scope

This is the full MVP. Nothing else ships before every check below is green. The wider vision (`VISION.md`) waits.

## Applications under observation

| App | Stack | Purpose |
|---|---|---|
| Web | React + Vite, `sdk/browser` | sessions, errors, fetch tracing, Web Vitals, rrweb replay |
| Mobile | React Native (Expo), `sdk/react-native` | sessions, errors, crashes, app version |
| Backend | Go, OTel Go SDK | receives traced requests from web and mobile, has deliberately slow and failing endpoints |

## Platform

- OpenTelemetry SDKs in every app, OTLP to an OpenTelemetry Collector, exported to Loki (logs/events), Tempo (traces), Mimir (metrics). Grafana on top.
- `services/rum-api` (Go): replay chunk ingestion and storage, session aggregation over Loki and Tempo, JSON API for the plugin.
- `plugins/ouo11y-rum-app` (Grafana app plugin): one unified experience with pages Overview, Sessions, Session detail (timeline, traces, replay).

## Questions the MVP must answer

1. What percentage of mobile sessions were healthy / errored / crashed, per app version, in a time range.
2. Same for web sessions.
3. Of the N sessions in the last hour, which were crashing, which user each belongs to, and how many traces each session has, with a link to every trace in Tempo.
4. When a session starts, when it ends, and why (inactivity, max duration, background, crash). Normative spec in `specs/session-lifecycle.md`.
5. For a web session, play back its replay and see errors, requests and traces on the same timeline. One session has exactly one replay, made of ordered chunks (ADR-0003).

## Acceptance checks

- [x] `docker compose up` brings up Grafana, Loki, Tempo, Mimir, Collector, rum-api, demo backend. (method: `compose ps` 7 services up, `wait-ready.sh`, rum-api `/readyz` ok; Phase 6)
- [x] Web demo produces sessions, errors, traces that reach Tempo and Loki with `session.id` attached. (method: live browser sessions healthy / errored / crashed, Loki 11/11 records with `session_id`, Tempo 13 traces by `span.session.id`; Phase 6)
- [x] Mobile demo produces sessions with `service.version`, errors, and a crash that is classified as crashed. (method: Expo web build of examples/mobile, session on 2.3.0 with handled error, 500, fatal, relaunch -> rum-api crashed / end_reason crash; plus 20 scripted qa-mobile sessions; iOS Simulator not run, no Xcode; Phase 6)
- [x] Backend spans join the browser and mobile spans in one trace via W3C Trace Context. (method: Tempo serviceStats web-store 1 + demo-backend 5 spans in one trace, same for mobile-store; Grafana Explore trace view; Phase 6)
- [x] Overview page shows healthy / errored / crashed percentages for web and for mobile split by version. (method: scripted matrix 5/3/2 per version equals `/v1/stats/health` buckets; Overview page rows equal the API; Phase 6)
- [x] Sessions page lists sessions with status, user, platform, version, trace count. (method: Sessions page shows the three QA sessions with status, user, web-store 1.4.2, traces; scripted crashed-id list with service_version; Phase 6)
- [x] Session detail shows a timeline (session start, errors, requests, session end), lists traces with Tempo links, and plays the replay for web sessions. (method: detail of the crashed session, 15 ordered events incl. session end, 10 traces, Explore link opens the Tempo trace view, replay plays and seeks; Phase 6)
- [x] Replay masks inputs by default and can be disabled independently of telemetry. (method: replay iframe DOM shows `*` for card, name, email; `replay.pause()` stops chunk uploads while telemetry continues, resume restarts them; `DELETE .../replay` -> has_replay=false; `replay.enabled=false` unit-tested; Phase 6)
- [x] Session ends are inferred correctly for the four end reasons in the spec and covered by tests. (method: sdk/browser 45 + sdk/react-native 36 + rum-api session tests; live inactivity rotation (new id, `session.end` inactivity, `session.previous_id`) and live mobile crash on relaunch; background by unit test only; Phase 6)

## Explicit non-goals for the MVP

Source maps, anomaly detection, views model, product analytics, multi-tenancy, auth beyond Grafana's own, Kubernetes, S3 (filesystem storage is enough), native crash capture on mobile (JS fatal errors only), replay for mobile.
