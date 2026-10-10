# platform-infra tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-06 | compose.yaml with grafana, loki, tempo, mimir, otel-collector, backend | done |
| 2026-10-06 | collector CORS + pipelines to tempo / loki / mimir | done, smoke verified |
| 2026-10-06 | Loki label promotion (service_name, event_name, ouo_platform) | done, verified via /labels |
| 2026-10-06 | Grafana datasource provisioning + trace to logs on session.id | done, health OK |
| 2026-10-06 | deploy/scripts/smoke.sh, wait-ready.sh, deploy/README.md | done |
| 2026-10-06 | kb/collector-lgtm.md | done |
| 2026-10-06 | Phase 3: add rum-api service to compose | done |
| 2026-10-06 | Phase 4: enable plugin dist volume on grafana | done |
| 2026-10-10 | Phase 8a: collector loopback-only + no CORS, rum-api gateway env + projects.example.yaml, plugin secureJsonData.readToken, smoke/e2e/wait-ready through rum-api with negative checks, deploy/vm (Caddy TLS override, install.sh, systemd, README), deploy/README + fast-tracked 00/10 + kb updated | done statically (compose config, collector validate, caddy validate + throwaway TLS run); live smoke pending rum-api rebuild, see summaries/2026-10-10-phase-8a.md |
