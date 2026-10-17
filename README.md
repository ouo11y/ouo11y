# ouo

OpenTelemetry-native Real User Monitoring. Browser and React Native SDKs emit sessions, errors,
traces and (web) rrweb replay through an OpenTelemetry Collector into Loki, Tempo and Mimir;
`rum-api` folds the signals into session records and a Grafana app plugin shows health
percentages, a sessions list and a session detail with timeline, traces and replay.

Status: MVP, all phases implemented, Phase 6 verification done. See `tracker/mvp.md` for the
phase table, open boxes and pull requests, and `reports/mvp-verification.html` for the
end-to-end verification report.

## Prerequisites

- Docker with Compose v2
- Node 24 and npm (npm workspaces)
- Go 1.26 (only to run the Go tests; the services build inside Docker)

## Quickstart

```bash
# 1. the platform: Grafana, Loki, Tempo, Mimir, OTel Collector, demo backend, rum-api
cp deploy/docker/.env.example deploy/docker/.env    # edit the OUO_*_PORT values if ports collide
docker compose -f deploy/docker/compose.yaml up -d --build
deploy/scripts/wait-ready.sh

# 2. the SDKs and the Grafana plugin
npm install
npm run -w sdk/browser build
npm run -w sdk/react-native build
npm run -w plugins/ouo-rum-app build                 # dist/ is bind-mounted into Grafana
docker compose -f deploy/docker/compose.yaml restart grafana

# 3. the web demo (storefront instrumented with @ouo/browser)
npm run -w examples/web dev                          # http://localhost:5173
```

Open Grafana at `http://localhost:${OUO_GRAFANA_PORT:-3000}` (admin / testing567) and go to
**More apps -> ouo RUM** (`/a/ouo-rum-app`): Overview (health by platform and version),
Sessions (filters, status, user, traces, replay), Session detail (timeline, traces with
Explore links, rrweb replay). Use the web demo's Chaos page to produce errored and crashed
sessions. The mobile demo is in `examples/mobile` (Expo; see its README).

Prove the pipeline end to end with the scripted scenario (40 synthetic web and mobile
sessions with known statuses, then assertions against rum-api and Grafana):

```bash
deploy/scripts/e2e.sh                                # exit 0 = every assertion passed
deploy/scripts/smoke.sh                              # 1 trace, 1 log, 1 metric round trip
```

Unit tests: `npm run -w sdk/browser test`, `npm run -w sdk/react-native test`,
`npm run -w plugins/ouo-rum-app test`, `cd services/rum-api && go test ./...`,
`cd examples/backend && go test ./...`.

## Where things live

| Path | What |
|---|---|
| `docs/MVP.md`, `docs/VISION.md` | scope, acceptance checks (ticked with the method), long-term vision |
| `docs/specs/`, `docs/adr/` | session lifecycle spec, architecture decision records |
| `tracker/` | phase trackers and status (`tracker/mvp.md`) |
| `agents/` | one folder per agent: what it did, verified and left (`agents/index.md`) |
| `kb/` | knowledge base, one file per topic (`kb/index.md`) |
| `reports/` | cross-cutting HTML reports (`reports/index.md`) |
| `deploy/` | compose stack, collector / Loki / Tempo / Mimir / Grafana config, scripts |
| `services/rum-api` | Go service: session aggregation, replay storage, JSON API |
| `sdk/browser`, `sdk/react-native` | the SDKs (`@ouo/browser`, `@ouo/react-native`) |
| `plugins/ouo-rum-app` | the Grafana app plugin |
| `examples/web`, `examples/mobile`, `examples/backend` | demo apps |
| `examples/fast-tracked` | copy-and-paste guides to adopt ouo in your own stack, backend, web and iOS app |
| `tests/e2e` | the end-to-end scenario script |

Working in this repository: read `AGENTS.md` first.
