# platform-infra tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-06 | compose.yaml with grafana, loki, tempo, mimir, otel-collector, backend | done |
| 2026-10-06 | collector CORS + pipelines to tempo / loki / mimir | done, smoke verified |
| 2026-10-06 | Loki label promotion (service_name, event_name, ouo_platform) | done, verified via /labels |
| 2026-10-06 | Grafana datasource provisioning + trace to logs on session.id | done, health OK |
| 2026-10-06 | deploy/scripts/smoke.sh, wait-ready.sh, deploy/README.md | done |
| 2026-10-06 | project/kb/collector-lgtm.md | done |
| 2026-10-06 | Phase 3: add rum-api service to compose | done |
| 2026-10-06 | Phase 4: enable plugin dist volume on grafana | done |
| 2026-10-10 | Phase 8a: collector loopback-only + no CORS, rum-api gateway env + projects.example.yaml, plugin secureJsonData.readToken, smoke/e2e/wait-ready through rum-api with negative checks, deploy/vm (Caddy TLS override, install.sh, systemd, README), deploy/README + fast-tracked 00/10 + kb updated | superseded by revision 2 (next row) |
| 2026-10-10 | Phase 8a rev 2 (ADR-0007 revised, collector is the edge): compose builds ouo/collector from collector/, publishes 4318 + 4319, mounts config + projects.htpasswd, OUO_INGEST_TOKEN on collector and rum-api, rum-api gateway vars + projects.example.yaml removed, Basic header on in-compose OTLP clients; .env.example; smoke/e2e/wait-ready against the collector with Basic credential, replay 4319 -> rum-api read-back; deploy/vm Caddy otel.<domain> path split 4319/4318, install.sh writes {SHA} htpasswd + pt_/it_/rt_ tokens and prints projectId/projectToken snippet; deploy/README, vm README, fast-tracked 00/10, kb updated | done, merged in #14; live smoke and e2e by qa 2026-10-13 (run `mv6swsxe`, `project/reports/phase-8a-verification.html`) (N1 2026-10-17) |
| 2026-10-23 | 8a VM install on fresh Ubuntu 24.04 VMs (Lima): install.sh `--images`, bind-mount ownership, unit per install mode, 0.2.0 layout migration and installer hand-over, Sentry route, `--allowed-origins`; compose `grafana-plugin` init; upgrade 0.2.0 -> 0.3.0 rehearsed with replays; rum-api schema guard; N12 Helm paths on kind ([summaries/2026-10-23-8a-vm-upgrade-n12.md](summaries/2026-10-23-8a-vm-upgrade-n12.md)) | done, PR #46 |
| 2026-10-17 | B2 `deploy/envs/ouo-env` built and verified on `sbx` and a gc run; founder stack migration to `main` pending the founder's OK ([summaries/2026-10-17-b2-ouo-env.md](summaries/2026-10-17-b2-ouo-env.md)) | done, migration open |
| 2026-10-23 | N29 single-file quickstart: `deploy/compose/quickstart.yaml` + `deploy/scripts/gen-quickstart.sh` (`--check` in CI job `quickstart`), docs in fast-tracked 00, deploy/README, README, releasing ([summaries/2026-10-23-n29-quickstart.md](summaries/2026-10-23-n29-quickstart.md)) | done |
