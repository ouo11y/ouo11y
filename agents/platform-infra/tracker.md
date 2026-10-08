# platform-infra tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-06 | compose.yaml with grafana, loki, tempo, mimir, otel-collector, backend | done |
| 2026-10-06 | collector CORS + pipelines to tempo / loki / mimir | done, smoke verified |
| 2026-10-06 | Loki label promotion (service_name, event_name, ouo_platform) | done, verified via /labels |
| 2026-10-06 | Grafana datasource provisioning + trace to logs on session.id | done, health OK |
| 2026-10-06 | deploy/scripts/smoke.sh, wait-ready.sh, deploy/README.md | done |
| 2026-10-06 | kb/collector-lgtm.md | done |
| later | Phase 3: add rum-api service to compose | todo |
| later | Phase 4: enable plugin dist volume on grafana | todo |
