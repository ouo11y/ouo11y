# ouo11y

*Open Unified Observability.* Say "oh-you-oh-eleven-why", or **"ouo"** for short; always written
lowercase ([ADR-0009](docs/adr-archive/0009-org-and-product-naming.md)).

OpenTelemetry-native Real User Monitoring. Browser, React Native and iOS SDKs emit sessions, errors,
traces and replay through an OpenTelemetry Collector into Loki, Tempo and Mimir; replay chunks and
debug files go to Muninn, ouo's replay store ([ADR-0019](docs/adr/0019-collector-to-muninn.md)).
Clients build their own Grafana plugin on the generic libraries in `libs/` (`ouo-go`,
`@ouo11y/kit`; [ADR-0025](docs/adr/0025-generic-libs-clients-own-plugin-and-access.md)).

Status: the MVP is done; rum-api, the MVP Grafana plugin and the MVP replay path were removed on
2026-11-15. Current work: [`project/tracker/roadmap.md`](project/tracker/roadmap.md) and
[`project/tracker/checklist.md`](project/tracker/checklist.md).

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
# 1. the platform: Grafana, Loki, Tempo, Mimir, OTel Collector, Muninn + MinIO, demo backend
cp deploy/compose/.env.example deploy/compose/.env    # edit the OUO_*_PORT values if ports collide
docker compose -f deploy/compose/compose.yaml up -d --build
deploy/scripts/wait-ready.sh

# 2. the SDKs
npm install
npm run -w sdk/browser build
npm run -w sdk/react-native build

# 3. the web demo (storefront instrumented with @ouo11y/browser)
npm run -w examples/ouo-web dev                          # http://localhost:5173
```

Open Grafana at `http://localhost:${OUO_GRAFANA_PORT:-3000}` (admin / testing567) and use
Explore on Loki and Tempo. Use the web demo's Chaos page to produce errored and crashed
sessions. The mobile demo is in `examples/ouo-mobile` (Expo; see its README).

Check the pipeline:

```bash
deploy/scripts/e2e.sh                                # exit 0 = every assertion passed
deploy/scripts/smoke.sh                              # 1 trace, 1 log, 1 metric round trip
```

Unit tests: `npm run -w sdk/browser test`, `npm run -w sdk/react-native test`,
`cd services/muninn && go test ./...`, `cd libs/ouo-go && go test ./...`,
`cd examples/backend && go test ./...`.

## Where things live

| Path | What |
|---|---|
| `sdk/browser`, `sdk/react-native`, `sdk/ios` | the SDKs (`@ouo11y/browser`, `@ouo11y/react-native`, `OuoReplay`) |
| `collector/` | `ouo-collector`, the OpenTelemetry Collector distribution that is the only ingest (replay, Sentry bridge, rate limit) |
| `services/muninn` | Muninn, the replay and debug-file store (Go) |
| `libs/` | `ouo-go` (Go) and `@ouo11y/kit`, generic libraries for a client's own plugin |
| `deploy/` | `compose/` local stack and configs, `helm/` chart, `vm/` single-VM install, `envs/` named local environments (`ouo-env`), `images/`, `scripts/` |
| `examples/ouo-web`, `examples/ouo-mobile`, `examples/ouo-ios`, `examples/sentry-mobile`, `examples/backend` | demo apps |
| `examples/fast-tracked` | copy-and-paste guides to adopt ouo in your own stack, backend, web and iOS app |
| `examples/quickstarts` | standalone apps run against the one-file stack, e.g. `tiny-shop` (Node API + React, one trace end to end) |
| `tests/e2e` | the end-to-end scenario script; `mobile/`, the mobile SDK conformance suite ([spec](docs/specs/mobile-sdk.md)); `mobile-native/`, the native iOS suite |
| `docs/` | user-facing docs: [vision](docs/VISION.md), [specs](docs/specs/), [ADRs](docs/adr/README.md), [operations](docs/operations/index.md), [releasing](docs/releasing.md) ([index](docs/index.md)) |
| `project/` | how the project is run, not shipped: `agents/` (one folder per agent), `kb/` (knowledge base), `kb-archive/` (MVP-era knowledge base), `tracker/` ([checklist](project/tracker/checklist.md) and phase trackers), `reports/` (HTML verification reports) |

Working in this repository: read `AGENTS.md` first.
