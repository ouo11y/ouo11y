# ouo11y

*Open Unified Observability.* Say "oh-you-oh-eleven-why", or **"ouo"** for short; always written
lowercase ([ADR-0009](docs/adr/0009-org-and-product-naming.md)).

OpenTelemetry-native Real User Monitoring. Browser and React Native SDKs emit sessions, errors,
traces and (web) rrweb replay through an OpenTelemetry Collector into Loki, Tempo and Mimir;
`rum-api` folds the signals into session records and a Grafana app plugin shows health
percentages, a sessions list and a session detail with timeline, traces and replay.

Status: MVP, all phases implemented, Phase 6 verification done. See `project/tracker/mvp.md` for the
phase table, open boxes and pull requests, and `project/reports/mvp-verification.html` for the
end-to-end verification report.

## Prerequisites

- Docker with Compose v2
- Node 24 and npm (npm workspaces)
- Go 1.26 (only to run the Go tests; the services build inside Docker)

## Quickstart

Only want to run the stack, without the source? Copy
[`deploy/compose/quickstart.yaml`](deploy/compose/quickstart.yaml) into an empty folder and
`docker compose up -d` (released images, public on ghcr.io so no `docker login`; all config
inlined). From a clone:

```bash
# 1. the platform: Grafana, Loki, Tempo, Mimir, OTel Collector, demo backend, rum-api
cp deploy/compose/.env.example deploy/compose/.env    # edit the OUO_*_PORT values if ports collide
docker compose -f deploy/compose/compose.yaml up -d --build
deploy/scripts/wait-ready.sh

# 2. the SDKs and the Grafana plugin
npm install
npm run -w sdk/browser build
npm run -w sdk/react-native build
npm run -w plugins/ouo11y-rum-app build                 # dist/ is bind-mounted into Grafana
docker compose -f deploy/compose/compose.yaml restart grafana

# 3. the web demo (storefront instrumented with @ouo11y/browser)
npm run -w examples/ouo-web dev                          # http://localhost:5173
```

Open Grafana at `http://localhost:${OUO_GRAFANA_PORT:-3000}` (admin / testing567) and go to
**More apps -> ouo11y RUM** (`/a/ouo11y-rum-app`): Overview (health by platform and version),
Sessions (filters, status, user, traces, replay), Session detail (timeline, traces with
Explore links, rrweb replay). Use the web demo's Chaos page to produce errored and crashed
sessions. The mobile demo is in `examples/ouo-mobile` (Expo; see its README).

Prove the pipeline end to end with the scripted scenario (40 synthetic web and mobile
sessions with known statuses, then assertions against rum-api and Grafana):

```bash
deploy/scripts/e2e.sh                                # exit 0 = every assertion passed
deploy/scripts/smoke.sh                              # 1 trace, 1 log, 1 metric round trip
```

Unit tests: `npm run -w sdk/browser test`, `npm run -w sdk/react-native test`,
`npm run -w plugins/ouo11y-rum-app test`, `cd services/rum-api && go test ./...`,
`cd examples/backend && go test ./...`.

## Where things live

| Path | What |
|---|---|
| `sdk/browser`, `sdk/react-native`, `sdk/ios` | the SDKs (`@ouo11y/browser`, `@ouo11y/react-native`, `OuoReplay`) |
| `collector/` | `ouo-collector`, the OpenTelemetry Collector distribution that is the only ingest (replay, Sentry bridge, rate limit) |
| `services/rum-api` | Go service: session aggregation, replay storage, JSON API |
| `plugins/ouo11y-rum-app` | the Grafana app plugin |
| `deploy/` | `compose/` local stack and configs, `helm/` chart, `vm/` single-VM install, `envs/` named local environments (`ouo-env`), `images/`, `scripts/` |
| `examples/ouo-web`, `examples/ouo-mobile`, `examples/sentry-mobile`, `examples/backend` | demo apps |
| `examples/fast-tracked` | copy-and-paste guides to adopt ouo in your own stack, backend, web and iOS app |
| `examples/quickstarts` | standalone apps run against the one-file stack, e.g. `tiny-shop` (Node API + React, one trace end to end) |
| `tests/e2e` | the end-to-end scenario script; `mobile/`, the mobile SDK conformance suite ([spec](docs/specs/mobile-sdk.md)) |
| `docs/` | user-facing docs: [MVP](docs/MVP.md), [vision](docs/VISION.md), [specs](docs/specs/), [ADRs](docs/adr/README.md), [operations](docs/operations/index.md), [releasing](docs/releasing.md) ([index](docs/index.md)) |
| `project/` | how the project is run, not shipped: `agents/` (one folder per agent), `kb/` (knowledge base), `tracker/` ([checklist](project/tracker/checklist.md) and phase trackers), `reports/` (HTML verification reports) |

Working in this repository: read `AGENTS.md` first.
