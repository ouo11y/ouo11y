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
- `plugins/ouo-rum-app` (Grafana app plugin): one unified experience with pages Overview, Sessions, Session detail (timeline, traces, replay).

## Questions the MVP must answer

1. What percentage of mobile sessions were healthy / errored / crashed, per app version, in a time range.
2. Same for web sessions.
3. Of the N sessions in the last hour, which were crashing, which user each belongs to, and how many traces each session has, with a link to every trace in Tempo.
4. When a session starts, when it ends, and why (inactivity, max duration, background, crash). Normative spec in `specs/session-lifecycle.md`.
5. For a web session, play back its replay and see errors, requests and traces on the same timeline. One session has exactly one replay, made of ordered chunks (ADR-0003).

## Acceptance checks

- [ ] `docker compose up` brings up Grafana, Loki, Tempo, Mimir, Collector, rum-api, demo backend.
- [ ] Web demo produces sessions, errors, traces that reach Tempo and Loki with `session.id` attached.
- [ ] Mobile demo produces sessions with `service.version`, errors, and a crash that is classified as crashed.
- [ ] Backend spans join the browser and mobile spans in one trace via W3C Trace Context.
- [ ] Overview page shows healthy / errored / crashed percentages for web and for mobile split by version.
- [ ] Sessions page lists sessions with status, user, platform, version, trace count.
- [ ] Session detail shows a timeline (session start, errors, requests, session end), lists traces with Tempo links, and plays the replay for web sessions.
- [ ] Replay masks inputs by default and can be disabled independently of telemetry.
- [ ] Session ends are inferred correctly for the four end reasons in the spec and covered by tests.

## Explicit non-goals for the MVP

Source maps, anomaly detection, views model, product analytics, multi-tenancy, auth beyond Grafana's own, Kubernetes, S3 (filesystem storage is enough), native crash capture on mobile (JS fatal errors only), replay for mobile.
