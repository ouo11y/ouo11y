# deploy

Observability stack for ouo: Grafana, Loki, Tempo, Mimir, an OpenTelemetry Collector
(contrib), rum-api and the demo backend, in one Docker Compose project. `deploy/vm`
adds TLS and systemd for a server install, `deploy/helm` is the Kubernetes chart.

```
browser SDK ──┐  OTLP/HTTP + X-Ouo-Project-Token        (untrusted clients)
mobile SDK  ──┼──> rum-api :8080 ─ /ingest/otlp/v1/{traces,logs,metrics}, /v1/replay/chunks
any OTel SDK ─┘        │  401 no/unknown token · 403 origin not allowed · 413 · 429 · 400
                       │  stamps resource ouo.project.id, re-encodes protobuf
                       ▼
your backend ────> otel-collector :4318 (127.0.0.1 only) ──> tempo  (traces)
rum-api's own                                             ──> loki   (logs / session events)
telemetry  ──────>                                        ──> mimir  (metrics)
                                                             replay chunks -> deploy/data/rum-api

grafana :3000 ──> loki, tempo, mimir (provisioned datasources)
   └─ ouo plugin ──plugin-proxy + Bearer <read token>──> rum-api /v1/* (never from the browser)
```

Rule of thumb (ADR-0007): **the project token is public, the read token is secret.** The
project token ships inside browser bundles and only lets a client *write* telemetry into
one project, within rum-api's origin, size and rate limits. The read token unlocks
`GET/DELETE /v1/*` (sessions, replays); it lives in `.env`, is provisioned into the Grafana
plugin's `secureJsonData`, and must never reach a browser.

## Start, stop, reset

```bash
docker compose -f deploy/docker/compose.yaml up -d          # start (builds examples/backend and services/rum-api)
docker compose -f deploy/docker/compose.yaml ps             # status
docker compose -f deploy/docker/compose.yaml logs -f rum-api otel-collector
docker compose -f deploy/docker/compose.yaml down           # stop, keep data
docker compose -f deploy/docker/compose.yaml down -v        # stop and wipe all data
```

A fresh clone works with no `.env`: every variable has the same default inside
`compose.yaml` (development tokens included). Data lives in named volumes
(`ouo_grafana-data`, `ouo_loki-data`, `ouo_tempo-data`, `ouo_mimir-data`). Replay chunks
are bind-mounted from `deploy/data/rum-api` (gitignored, created by compose on first
start) so they survive `down -v` and can be inspected.

## Ports

| Service | Host binding | Container | Purpose |
|---|---|---|---|
| grafana | `0.0.0.0:3000` | 3000 | UI, `admin` / `admin` |
| rum-api | `0.0.0.0:8080` | 8080 | **the only endpoint for SDKs**: `/ingest/otlp/v1/{traces,logs,metrics}`, `/v1/replay/chunks` (project token); `/v1/sessions`, `/v1/stats/health` (read token); `/healthz`, `/readyz` (open) |
| backend | `0.0.0.0:8081` | 8081 | demo backend (`/healthz`, `/api/products`, `/api/cart`, `/api/checkout`) |
| otel-collector | `127.0.0.1:4318` | 4318 | OTLP/HTTP for **trusted processes on this host only**; no CORS, browsers cannot use it |
| otel-collector | `127.0.0.1:4317` | 4317 | OTLP/gRPC, same rule |
| otel-collector | `127.0.0.1:13133` | 13133 | collector health (`GET /`) |
| loki | `0.0.0.0:3100` | 3100 | Loki API (`/loki/api/v1/...`, OTLP at `/otlp/v1/logs`) |
| tempo | `0.0.0.0:3200` | 3200 | Tempo API (`/api/search`, `/api/traces/{id}`) |
| mimir | `0.0.0.0:9009` | 9009 | Mimir (`/prometheus/api/v1/...`, OTLP at `/otlp/v1/metrics`) |

Why loopback for the collector: a browser or phone must never reach the collector
(ADR-0007 section 8), but a backend you run with `go run .` on this machine still exports
to `http://localhost:4318` exactly as before. On a server (`deploy/vm`) every port except
Caddy's 80/443 is loopback. Host ports can be changed without touching the compose file:
copy `deploy/docker/.env.example` to `deploy/docker/.env` and edit the `OUO_*_PORT`
values; compose and the scripts in `deploy/scripts/` read that file. In-cluster addresses
never change (`otel-collector:4318`, `loki:3100`, `tempo:3200`, `mimir:9009`, `rum-api:8080`).

## Environment (`deploy/docker/.env`, see `.env.example`)

| Variable | Default (compose) | Used by | Meaning |
|---|---|---|---|
| `OUO_PROJECT_ID` | `demo` | rum-api | project id stamped as resource attribute `ouo.project.id` on every payload (the client's value is overwritten) |
| `OUO_PROJECT_TOKEN` | `pt_dev_demo_0000000000000000` | rum-api, SDKs, scripts | **public** write token, header `X-Ouo-Project-Token` |
| `OUO_ALLOWED_ORIGINS` | `http://localhost:*,http://127.0.0.1:*` | rum-api | origins allowed to post from a browser; requests without `Origin` (mobile, servers) pass |
| `OUO_READ_TOKEN` | `rt_dev_0000000000000000` | rum-api, Grafana | **secret** read token; Grafana gets it as `secureJsonData.readToken` through provisioning |
| `OUO_COLLECTOR_OTLP_ENDPOINT` | `http://otel-collector:4318` (fixed) | rum-api | where validated OTLP is forwarded |
| `OUO_PROJECTS_FILE` | unset | rum-api | multi-project YAML (`projects.example.yaml`); uncomment the variable and the bind mount in `compose.yaml` |
| `OUO_MAX_INGEST_BYTES`, `OUO_RATE_LIMIT_RPS/BURST`, `OUO_IP_RATE_LIMIT_RPS/BURST`, `OUO_TRUST_PROXY` | rum-api defaults | rum-api | limits (ADR-0007 section 4); the VM override sets `OUO_TRUST_PROXY=true` behind Caddy |
| `OUO_*_PORT` | see table above | compose, scripts | host ports |

**The defaults are development values and are committed to a public repo.** They are
fine while rum-api is reachable only from your laptop. Anything other people can reach
needs generated tokens: `echo pt_$(openssl rand -hex 16)`, `echo rt_$(openssl rand -hex 16)`
(`deploy/vm/install.sh` does this for you).

SDK configuration against this stack:

```ts
initRUM({ endpoint: "http://localhost:8080", projectToken: "pt_dev_demo_0000000000000000",
          service: { name: "web-store", version: "1.4.2", environment: "local" } });
```

Any stock OpenTelemetry SDK can post through the gateway too:
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:8080/ingest/otlp`
`OTEL_EXPORTER_OTLP_HEADERS=X-Ouo-Project-Token=pt_dev_demo_0000000000000000`.

## Verify

```bash
deploy/scripts/wait-ready.sh   # polls /ready of every service, incl. rum-api /readyz
deploy/scripts/smoke.sh        # gateway rules + 1 trace, 1 log, 1 metric round trip through rum-api
deploy/scripts/e2e.sh          # synthetic session matrix (tests/e2e/scenario.mjs) + rum-api / Grafana assertions
```

`smoke.sh` sends OTLP/JSON to `rum-api /ingest/otlp/v1/*` with the project token,
`service.name=smoke`, `session.id=smoke-session`, `event.name=session.start` and a
deliberately wrong `ouo.project.id=spoofed`, then asserts:

- rum-api: preflight from `Origin: http://localhost:5173` returns
  `Access-Control-Allow-Origin` and allows `X-Ouo-Project-Token`; preflight from
  `https://evil.example` returns no allow-origin; the collector on `127.0.0.1:4318`
  answers no browser preflight at all.
- rum-api: `POST` without token is `401`, unknown token `401`, valid token with a foreign
  `Origin` `403`.
- Tempo: `{ span.session.id = "smoke-session" }` and
  `{ resource.ouo.project.id = "demo" }` both find the trace; `GET /api/traces/<id>` carries
  `ouo.project.id=demo` (the spoofed value is gone).
- Loki: `{service_name="smoke", event_name="session.start", ouo_platform="web"} | session_id="smoke-session" | ouo_project_id="demo"`
  returns the record (labels are `service_name`, `event_name`, `ouo_platform`,
  `deployment_environment_name`; everything else is structured metadata).
- Mimir: `ouo_smoke_requests{run_id="..."}` is queryable through `/prometheus/api/v1/query`.

`e2e.sh` exports `OUO_RUM_API`, `OUO_OTLP_URL=$OUO_RUM_API/ingest/otlp`,
`OUO_PROJECT_ID`, `OUO_PROJECT_TOKEN`, `OUO_READ_TOKEN`, `OUO_GRAFANA_URL`,
`OUO_GRAFANA_AUTH` (and the pre-8a `OUO_RUM_API_URL`) for `tests/e2e/scenario.mjs`.

Manual checks:

```bash
TOKEN=pt_dev_demo_0000000000000000
curl -i -X OPTIONS -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,x-ouo-project-token" localhost:8080/ingest/otlp/v1/traces
curl -i -X POST localhost:8080/ingest/otlp/v1/traces -H 'content-type: application/json' -d '{"resourceSpans":[]}'                 # 401
curl -i -X POST localhost:8080/ingest/otlp/v1/traces -H "x-ouo-project-token: $TOKEN" -H 'content-type: application/json' -d '{"resourceSpans":[]}'   # 200
curl -i 'localhost:8080/v1/sessions?from=now-1h'                                                     # 401 without the read token
curl -H 'authorization: Bearer rt_dev_0000000000000000' 'localhost:8080/v1/sessions?from=now-1h'    # 200
curl -H 'baggage: session.id=s1,user.id=u1,ouo.platform=web' localhost:8081/api/products             # demo backend -> collector directly
curl -G localhost:3200/api/search --data-urlencode 'q={ resource.service.name = "demo-backend" && span.session.id = "s1" }'
```

In Grafana (http://localhost:3000, admin/admin): Explore -> Tempo -> search
`{ span.session.id = "smoke-session" }`; open a span and use "Logs for this span"
(trace to logs is a custom query on `service_name` + `session_id`). Explore -> Loki ->
`{event_name="session.start"}`. The Tempo metrics generator writes
`traces_spanmetrics_*` and `traces_service_graph_*` to Mimir, which feed the
service map.

## Layout

```
deploy/docker/compose.yaml                      the stack (collector on loopback, rum-api gateway env)
deploy/docker/.env.example                      ports, tokens, origins, VM variables (dev values, loud warning)
deploy/docker/projects.example.yaml             multi-project registry shape for OUO_PROJECTS_FILE
deploy/docker/collector/config.yaml             OTLP receiver (no CORS) -> tempo / loki / mimir
deploy/docker/loki/config.yaml                  single binary, tsdb v13, OTLP label promotion
deploy/docker/tempo/config.yaml                 single binary, local blocks, metrics generator
deploy/docker/mimir/config.yaml                 monolithic, filesystem blocks
deploy/docker/grafana/provisioning/datasources  loki / tempo / mimir with fixed uids
deploy/docker/grafana/provisioning/plugins      ouo-rum-app enabled, rumApiUrl + secureJsonData.readToken
deploy/data/rum-api/                            replay chunks written by rum-api (gitignored)
deploy/scripts/wait-ready.sh, smoke.sh, e2e.sh  readiness, gateway + round-trip smoke, e2e scenario runner
deploy/vm/                                      Caddy TLS override, install.sh, systemd unit, README
deploy/helm/                                    Kubernetes chart (helm agent)
```

## rum-api

`services/rum-api` (Go) is built from `../../services/rum-api` and listens on host port
`${OUO_RUM_API_PORT:-8080}`. It is the ingest gateway (project token, per-project CORS,
size and rate limits, `ouo.project.id` stamping, forward to
`OUO_COLLECTOR_OTLP_ENDPOINT`), reads Loki (`http://loki:3100`) and Tempo
(`http://tempo:3200`) in-network, stores replay chunks under `deploy/data/rum-api/replays`,
and sends its own traces, logs and metrics to the collector as `service.name=rum-api`
(including `ouo.ingest.requests` / `ouo.ingest.bytes` counters). `GRAFANA_URL` is set from
`OUO_GRAFANA_PORT` because the trace deep links it builds are opened by the browser, not
by the container. Full API and curl examples: `services/rum-api/README.md`.

```bash
curl localhost:8080/readyz                                                                     # {"ready":true,"checks":{"loki":"ok","tempo":"ok"}}
RT='authorization: Bearer rt_dev_0000000000000000'
curl -H "$RT" 'localhost:8080/v1/sessions?from=now-1h'                 # session records with status, user, trace_count
curl -H "$RT" 'localhost:8080/v1/stats/health?from=now-24h'            # healthy / errored / crashed per platform and version
curl -H "$RT" localhost:8080/v1/sessions/<session_id>                  # record + timeline + traces (Grafana Explore links)
curl -H "$RT" localhost:8080/v1/sessions/<session_id>/replay/events    # rrweb events for rrweb-player
```

The web demo's `VITE_RUM_API` must point at this port (default `http://localhost:8080`)
and `VITE_OUO_PROJECT_TOKEN` at the project token.

## Grafana app plugin

`plugins/ouo-rum-app` is the MVP UI (Overview, Sessions, Session detail with replay). It is
loaded **unsigned** (`GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo-rum-app`,
`GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS=ouo-rum-app`) from the bind mount
`../../plugins/ouo-rum-app/dist -> /var/lib/grafana/plugins/ouo-rum-app`. When `dist/` does
not exist Docker creates an empty directory and Grafana starts without the plugin.

```bash
npm install && npm run -w plugins/ouo-rum-app build       # repo root
docker compose -f deploy/docker/compose.yaml up -d grafana  # (re)create so the mount is picked up
open http://localhost:${OUO_GRAFANA_PORT:-3000}/a/ouo-rum-app/overview
```

`grafana/provisioning/plugins/ouo-rum-app.yaml` enables the app for org 1 with
`jsonData.rumApiUrl: http://rum-api:8080` and `secureJsonData.readToken: ${OUO_READ_TOKEN}`.
The provisioner expands `${OUO_READ_TOKEN}` from the Grafana container's environment
(compose passes it through). The plugin never calls rum-api from the browser: it requests
`/api/plugin-proxy/ouo-rum-app/rum/v1/...` and Grafana forwards to `rumApiUrl` adding
`Authorization: Bearer <readToken>` (route `rum/*` in `plugin.json`). The URL and token can
be changed at `/plugins/ouo-rum-app` (Configuration) without restarting Grafana. Restart
Grafana after changing `src/plugin.json`; for JS-only rebuilds a hard browser reload is enough.

```bash
curl -u admin:admin localhost:3000/api/plugins/ouo-rum-app/settings | jq '{enabled, jsonData, secureJsonFields}'   # secureJsonFields.readToken: true
curl -u admin:admin 'localhost:3000/api/plugin-proxy/ouo-rum-app/rum/v1/stats/health?from=now-24h'
```

## Server install (`deploy/vm`)

```bash
curl -fsSL https://raw.githubusercontent.com/ZiadMansourM/ouo/main/deploy/vm/install.sh \
  | sudo bash -s -- --domain ouo.example.com --email you@example.com
```

Caddy terminates TLS for `OUO_DOMAIN` (Grafana) and `OUO_RUM_DOMAIN` (rum-api), every
other port is re-bound to loopback, tokens are generated, a systemd unit keeps the stack
up across reboots. Details, firewall, data locations, upgrade and backup:
`deploy/vm/README.md`. Kubernetes: `deploy/helm/README.md`.

## Notes

- Loki, Tempo, Mimir and the collector images are distroless: no shell, no `wget`, so
  they have no Docker healthchecks. Use `wait-ready.sh`. The collector retries exports
  until the backends are up, Grafana tolerates datasources that are not ready yet.
- Tempo 3.x logs `no jobs found` errors from its backend scheduler every few seconds
  in single-binary mode; harmless.
- Loki, Tempo and Mimir are still published on `0.0.0.0` in the laptop stack so Explore-style
  curls work from other devices on your LAN; the VM override binds them to loopback.
- Pinned images: see `compose.yaml` and `kb/collector-lgtm.md`.
