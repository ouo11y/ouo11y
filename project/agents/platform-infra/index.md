# platform-infra

Owns `deploy/**` except `deploy/helm` (helm agent): Docker Compose stack (Grafana, Loki, Tempo, Mimir, OTel Collector on loopback, rum-api gateway, demo backend), provisioning, smoke / e2e / readiness scripts, the VM install path (`deploy/vm`: Caddy TLS, install.sh, systemd).

- [tracker.md](tracker.md)
- `summaries/` dated run summaries
  - [2026-10-06-phase-1.md](summaries/2026-10-06-phase-1.md) Phase 1 stack, verification, caveats
  - [2026-10-10-phase-8a.md](summaries/2026-10-10-phase-8a.md) Phase 8a: collector loopback-only, rum-api gateway env and tokens, smoke through rum-api, VM install with Caddy TLS; what was validated and what awaits the rum-api rebuild
