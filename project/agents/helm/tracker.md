# helm tracker

| Date | Event |
|---|---|
| 2026-10-10 | Phase 8a: Helm chart deploy/helm/ouo (rum-api, collector, Grafana+plugin image, bundled or external LGTM), deploy/images/grafana, verified on kind ouo-8a (install, 3 upgrades, ingest trace to Tempo, read token via plugin proxy), project/kb/helm-kind.md; external / HA values render only (see summaries/2026-10-10-phase-8a.md) |
| 2026-10-13 | Phase 8a rev 2 (collector is the edge): chart runs `ouo/collector` with the reference config as ConfigMap, `projects` rendered to a `{SHA}` htpasswd Secret, public Service 4318/4319 + optional Ingress (`/v1/replay` -> 4319), internal Service 4317/8888/13133, rum-api ClusterIP only with `OUO_INGEST_TOKEN`/`OUO_READ_TOKEN`; verified on kind ouo-8a (401/200 OTLP, Tempo stamp over spoof, replay 202 -> rum-api + plugin, CORS, 429, upgrade with new project). Finding: two htpasswd lines per project do not overlap (last wins), chart refuses duplicate ids (see summaries/2026-10-10-phase-8a-rev2.md) |
