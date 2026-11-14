# platform-infra

Owns `deploy/**` except `deploy/helm` (helm agent): named local envs (`deploy/envs/ouo-env`), Docker Compose stack (Grafana, Loki, Tempo, Mimir, OTel Collector on loopback, rum-api gateway, demo backend), provisioning, smoke / e2e / readiness scripts, the VM install path (`deploy/vm`: Caddy TLS, install.sh, systemd).

- [tracker.md](tracker.md)
- `summaries/` dated run summaries
  - [2026-10-06-phase-1.md](summaries/2026-10-06-phase-1.md) Phase 1 stack, verification, caveats
  - [2026-10-17-b2-ouo-env.md](summaries/2026-10-17-b2-ouo-env.md) B2 `deploy/envs/ouo-env`: proxy, named envs, gc, tests, what was verified, what waits for the founder
  - [2026-10-10-phase-8a.md](summaries/2026-10-10-phase-8a.md) Phase 8a: collector loopback-only, rum-api gateway env and tokens, smoke through rum-api, VM install with Caddy TLS; what was validated and what awaits the rum-api rebuild
  - [2026-10-23-8a-vm-upgrade-n12.md](summaries/2026-10-23-8a-vm-upgrade-n12.md) 8a: install.sh on fresh Ubuntu VMs (Lima), `--images` mode, upgrade 0.2.0 -> 0.3.0 with replays, rum-api schema guard, N12 Helm paths on kind
  - [2026-11-04-r4-existing-lgtm.md](summaries/2026-11-04-r4-existing-lgtm.md) R4 (pilot client): ouo on an existing Loki / Tempo / Mimir behind the customer's collector: docs, `compose.external.yaml`, rum-api tenant / headers / basic auth / delete URL, Helm wiring, two delete fixes, client-shaped e2e
- `reports/` HTML reports
  - [2026-10-23-8a-vm-upgrade-n12.html](reports/2026-10-23-8a-vm-upgrade-n12.html) verification report for the 2026-10-23 run (VM install, upgrade, guard, N12)
- `tools/` test tooling
  - [upgrade-replays.py](tools/upgrade-replays.py) seeds rrweb, frames and Sentry video replays through the collector and fingerprints every replay, session and health bucket before / after an upgrade
