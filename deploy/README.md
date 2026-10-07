# deploy

Local observability stack for ouo: Grafana, Loki, Tempo, Mimir, an OpenTelemetry
Collector (contrib) and the demo backend, all in one Docker Compose project.

```
browser / mobile / backend --OTLP--> otel-collector --> tempo (traces)
                                                   --> loki  (logs / session events)
                                                   --> mimir (metrics)
grafana --> loki, tempo, mimir (provisioned datasources)
```

## Start, stop, reset

```bash
docker compose -f deploy/docker/compose.yaml up -d          # start (builds examples/backend and services/rum-api)
docker compose -f deploy/docker/compose.yaml ps             # status
docker compose -f deploy/docker/compose.yaml logs -f otel-collector
docker compose -f deploy/docker/compose.yaml down           # stop, keep data
docker compose -f deploy/docker/compose.yaml down -v        # stop and wipe all data
```

Data lives in named volumes (`ouo_grafana-data`, `ouo_loki-data`, `ouo_tempo-data`,
`ouo_mimir-data`). Replay chunks are bind-mounted from `deploy/data/rum-api` (gitignored,
created by compose on first start) so they survive `down -v` and can be inspected.

## Ports

| Service | Host port | Container | Purpose |
|---|---|---|---|
| grafana | 3000 | 3000 | UI, `admin` / `admin` |
| otel-collector | 4318 | 4318 | OTLP/HTTP (CORS for `http://localhost:*`, `http://127.0.0.1:*`) |
| otel-collector | 4317 | 4317 | OTLP/gRPC |
| otel-collector | 13133 | 13133 | collector health (`GET /`) |
| loki | 3100 | 3100 | Loki API (`/loki/api/v1/...`, OTLP at `/otlp/v1/logs`) |
| tempo | 3200 | 3200 | Tempo API (`/api/search`, `/api/traces/{id}`) |
| mimir | 9009 | 9009 | Mimir (`/prometheus/api/v1/...`, OTLP at `/otlp/v1/metrics`) |
| backend | 8081 | 8081 | demo backend (`/healthz`, `/api/products`, `/api/cart`, `/api/checkout`) |
| rum-api | 8080 | 8080 | session + replay API (`/healthz`, `/readyz`, `/v1/sessions`, `/v1/replay/chunks`, `/v1/stats/health`) |

Host ports can be changed without touching the compose file: copy
`deploy/docker/.env.example` to `deploy/docker/.env` and edit the `OUO_*_PORT`
values. Compose reads that file automatically; the scripts in `deploy/scripts/`
read it too. In-cluster addresses never change (`otel-collector:4318`,
`loki:3100`, `tempo:3200`, `mimir:9009`).

## Verify

```bash
deploy/scripts/wait-ready.sh   # polls /ready of every service
deploy/scripts/smoke.sh        # CORS preflight + 1 trace, 1 log, 1 metric round trip
```

`smoke.sh` sends OTLP/JSON to the collector with `service.name=smoke`,
`session.id=smoke-session`, `event.name=session.start`, then asserts:

- Tempo: `GET /api/search?q={ span.session.id = "smoke-session" }` returns the trace
  and `GET /api/traces/<id>` is 200.
- Loki: `{service_name="smoke", event_name="session.start", ouo_platform="web"} | session_id="smoke-session"`
  returns the record (labels are `service_name`, `event_name`, `ouo_platform`,
  `deployment_environment_name`; everything else is structured metadata).
- Mimir: `ouo_smoke_requests{run_id="..."}` is queryable through `/prometheus/api/v1/query`.
- The OPTIONS preflight from `Origin: http://localhost:5173` returns
  `Access-Control-Allow-Origin` and `Access-Control-Allow-Headers`.

Manual checks:

```bash
curl -i -X OPTIONS -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST" localhost:4318/v1/traces
curl localhost:8081/healthz
curl -H 'baggage: session.id=s1,user.id=u1,ouo.platform=web' localhost:8081/api/products
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
deploy/docker/compose.yaml                      the stack
deploy/docker/.env.example                      host port overrides
deploy/docker/collector/config.yaml             OTLP receiver (CORS) -> tempo / loki / mimir
deploy/docker/loki/config.yaml                  single binary, tsdb v13, OTLP label promotion
deploy/docker/tempo/config.yaml                 single binary, local blocks, metrics generator
deploy/docker/mimir/config.yaml                 monolithic, filesystem blocks
deploy/docker/grafana/provisioning/datasources  loki / tempo / mimir with fixed uids
deploy/data/rum-api/                            replay chunks written by rum-api (gitignored)
deploy/scripts/wait-ready.sh, smoke.sh          readiness and end to end smoke
```

## rum-api

`services/rum-api` (Go) is built from `../../services/rum-api` and listens on host port
`${OUO_RUM_API_PORT:-8080}`. It reads Loki (`http://loki:3100`) and Tempo
(`http://tempo:3200`) in-network, stores replay chunks under `deploy/data/rum-api/replays`,
and sends its own traces, logs and metrics to the collector as `service.name=rum-api`.
`GRAFANA_URL` is set from `OUO_GRAFANA_PORT` because the trace deep links it builds are
opened by the browser, not by the container. Full API and curl examples:
`services/rum-api/README.md`.

```bash
curl localhost:8080/readyz                                    # {"ready":true,"checks":{"loki":"ok","tempo":"ok"}}
curl 'localhost:8080/v1/sessions?from=now-1h'                 # session records with status, user, trace_count
curl 'localhost:8080/v1/stats/health?from=now-24h'            # healthy / errored / crashed per platform and version
curl localhost:8080/v1/sessions/<session_id>                  # record + timeline + traces (Grafana Explore links)
curl localhost:8080/v1/sessions/<session_id>/replay/events    # rrweb events for rrweb-player
```

The web demo's `VITE_RUM_API` must point at this port (default `http://localhost:8080`).

## Later phases

- **Phase 4 (Grafana plugin)**: Grafana already runs with
  `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo-rum-app` and
  `GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS=ouo-rum-app`. Uncomment the
  `../../plugins/ouo-rum-app/dist` volume on the grafana service once that directory
  exists; compose refuses to start when a bind-mount source is missing, which is why
  it is commented out today.

## Notes

- Loki, Tempo, Mimir and the collector images are distroless: no shell, no `wget`, so
  they have no Docker healthchecks. Use `wait-ready.sh`. The collector retries exports
  until the backends are up, Grafana tolerates datasources that are not ready yet.
- Tempo 3.x logs `no jobs found` errors from its backend scheduler every few seconds
  in single-binary mode; harmless.
- Pinned images: see `compose.yaml` and `kb/collector-lgtm.md`.
