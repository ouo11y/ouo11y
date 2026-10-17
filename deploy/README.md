# deploy

Observability stack for ouo: Grafana, Loki, Tempo, Mimir, the ouo OpenTelemetry Collector
distribution (`collector/`), rum-api and the demo backend, in one Docker Compose project.
`deploy/vm` adds TLS and systemd for a server install, `deploy/helm` is the Kubernetes chart.

```
browser SDK ──┐  Authorization: Basic base64("<project id>:<project token>")
mobile SDK  ──┼──> ouo-collector :4318  /v1/traces /v1/logs /v1/metrics  (OTLP/HTTP)
any OTel SDK ─┤                  :4319  /v1/replay/chunks                (replay receiver)
your backend ─┘        │  401 no/unknown credential · CORS preflight · 413 · 429 (per project, per client)
                       │  stamps resource ouo.project.id = Basic username (client value overwritten)
                       ├──OTLP──> tempo  (traces)   loki (logs / session events)   mimir (metrics)
                       └──replay chunks + X-Ouo-Project-Id + Bearer <ingest token>──> rum-api :8080 (internal)
                                                                                      └─> deploy/data/rum-api
grafana :3000 ──> loki, tempo, mimir (provisioned datasources)
   └─ ouo plugin ──plugin-proxy + Bearer <read token>──> rum-api /v1/* (never from the browser)
```

Rule of thumb (ADR-0007): **the project token is public, the ingest and read tokens are
secrets.** The project token ships inside browser bundles and only lets a client *write*
telemetry into one project, within the collector's CORS, size and rate limits. The ingest
token is the shared secret between the collector's replay exporter and rum-api; the read
token unlocks `GET/DELETE /v1/*` (sessions, replays). Both secrets live in `.env`, the
read token is also provisioned into the Grafana plugin's `secureJsonData`, and neither
ever reaches a browser. rum-api, Loki, Tempo and Mimir are internal: SDKs only ever talk
to the collector.

## Named environments (`ouo-env`, the default for agents)

Agents and the founder run stacks as named envs behind one proxy instead of raw
`docker compose` on numbered ports: `deploy/envs/ouo-env up <env>` gives
`http://grafana.<env>.ouo.localhost` (main: `http://grafana.ouo.localhost`, admin / testing567),
`ls`, `gc` and `down` keep the laptop clean, and only the SDK ingest ports a device needs are
published. See [envs/README.md](envs/README.md). The commands below are the plain compose path
(single stack, host ports from `.env`), still used by CI, the VM install and the fast-tracked guides.

## Start, stop, reset

```bash
docker compose -f deploy/compose/compose.yaml up -d          # start (builds collector/, examples/backend and services/rum-api)
docker compose -f deploy/compose/compose.yaml ps             # status
docker compose -f deploy/compose/compose.yaml logs -f otel-collector rum-api
docker compose -f deploy/compose/compose.yaml down           # stop, keep data
docker compose -f deploy/compose/compose.yaml down -v        # stop and wipe all data
```

A fresh clone works with no `.env`: every variable has the same default inside
`compose.yaml` (development tokens included) and `collector/projects.htpasswd` ships the
`demo` project. The first `up` builds the collector image with the OpenTelemetry Collector
Builder, which takes a few minutes. Data lives in named volumes (`ouo_grafana-data`,
`ouo_loki-data`, `ouo_tempo-data`, `ouo_mimir-data`). Replay chunks are bind-mounted from
`deploy/data/rum-api` (gitignored, created by compose on first start) so they survive
`down -v` and can be inspected.

**Released images instead of builds:** add `-f deploy/compose/compose.images.yaml` to pull
the pinned `ghcr.io/ziadmansourm/ouo/{collector,rum-api,grafana}` images. They are
**private until ouo reaches a stable version**, so log in once first with a classic
personal access token that has only `read:packages` (ask the ouo founder for read access
to the packages; keep the token in your shell, never in the repo):

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

Without it the pull fails with `denied` (HTTP 403); the plain `compose.yaml` above builds
from source and needs no login. Full steps: `examples/fast-tracked/00-stack.md`, Step 3.

## Ports

| Service | Host binding | Container | Purpose |
|---|---|---|---|
| otel-collector | `0.0.0.0:4318` | 4318 | **OTLP/HTTP for every SDK**: `/v1/traces`, `/v1/logs`, `/v1/metrics`; Basic credential required; CORS for browsers |
| otel-collector | `0.0.0.0:4319` | 4319 | **replay receiver**: `POST /v1/replay/chunks`; same credential and CORS |
| otel-collector | `127.0.0.1:4317` | 4317 | OTLP/gRPC for backend development on this host |
| otel-collector | `127.0.0.1:13133` | 13133 | collector health (`GET /`) |
| grafana | `0.0.0.0:3000` | 3000 | UI, `admin` / `admin` |
| rum-api | `0.0.0.0:8080` | 8080 | **internal** read API (`/v1/sessions`, `/v1/stats/health`, read token) and replay sink (`POST /v1/replay/chunks`, ingest token); `/healthz`, `/readyz` open. Published for laptop debugging only; never exposed in production |
| backend | `0.0.0.0:8081` | 8081 | demo backend (`/healthz`, `/api/products`, `/api/cart`, `/api/checkout`) |
| loki | `0.0.0.0:3100` | 3100 | Loki API (`/loki/api/v1/...`, OTLP at `/otlp/v1/logs`) |
| tempo | `0.0.0.0:3200` | 3200 | Tempo API (`/api/search`, `/api/traces/{id}`) |
| mimir | `0.0.0.0:9009` | 9009 | Mimir (`/prometheus/api/v1/...`, OTLP at `/otlp/v1/metrics`) |
| minio (profile `s3`, opt-in) | `127.0.0.1:9000`, `127.0.0.1:9001` | 9000, 9001 | S3 API and web console for rum-api's s3 replay store (`minioadmin` / `minioadmin`, laptop only) |

On a server (`deploy/vm`) Caddy owns 80/443 and every port above is re-bound to loopback;
the collector is reached as `https://otel.<domain>`. Host ports can be changed without
touching the compose file: copy `deploy/compose/.env.example` to `deploy/compose/.env` and
edit the `OUO_*_PORT` values; compose and the scripts in `deploy/scripts/` read that file.
In-cluster addresses never change (`otel-collector:4318` / `4319`, `loki:3100`,
`tempo:3200`, `mimir:9009`, `rum-api:8080`).

## Environment (`deploy/compose/.env`, see `.env.example`)

| Variable | Default (compose) | Used by | Meaning |
|---|---|---|---|
| `OUO_INGEST_TOKEN` | `it_dev_0000000000000000` | otel-collector, rum-api | **secret** bearer the collector's replay exporter sends to rum-api's `POST /v1/replay/chunks`; same value on both sides |
| `OUO_READ_TOKEN` | `rt_dev_0000000000000000` | rum-api, Grafana | **secret** read token; Grafana gets it as `secureJsonData.readToken` through provisioning |
| `OUO_BACKEND_OTLP_HEADERS` | `Authorization=Basic%20ZGVtbzpw...` (demo) | backend, rum-api | `OTEL_EXPORTER_OTLP_HEADERS` the in-compose services use for their own telemetry (`%20` = space) |
| `OUO_PROJECT_ID`, `OUO_PROJECT_TOKEN` | `demo`, `pt_dev_demo_0000000000000000` | scripts only | which project `smoke.sh` / `e2e.sh` send as; must match a line in `collector/projects.htpasswd`. Compose does not read them |
| `OUO_*_PORT` | see table above | compose, scripts | host ports (`OUO_REPLAY_PORT` is new in 8a) |

Projects are not environment: they are lines in `deploy/compose/collector/projects.htpasswd`
(`<project id>:{SHA}<base64 sha1(token)>`, exactly what `htpasswd -nbs <id> <token>`
prints; cheap on purpose, the token is public). One line per project id: `basicauth` keeps
only the last line for an id, so rotation is a cut-over (replace the line, restart, ship the
new token; ADR-0007 section 2). After editing, `docker compose ... restart otel-collector`:

```bash
echo "pt_$(openssl rand -hex 16)"                                   # new token
htpasswd -nbs web-store pt_live_...  >> deploy/compose/collector/projects.htpasswd
# without apache2-utils:
printf '%s:{SHA}%s\n' web-store "$(printf '%s' pt_live_... | openssl dgst -binary -sha1 | openssl base64)" >> deploy/compose/collector/projects.htpasswd
```

**The defaults are development values and are committed to a public repo** (`demo` /
`pt_dev_demo_0000000000000000`, `it_dev_...`, `rt_dev_...`). They are fine while the
collector is reachable only from your laptop. Anything other people can reach needs
generated values: `echo pt_$(openssl rand -hex 16)` (and `it_`, `rt_`);
`deploy/vm/install.sh` does this for you and writes a server-side `projects.htpasswd`.

SDK configuration against this stack:

```ts
initRUM({ endpoint: "http://localhost:4318",   // replayEndpoint defaults to port 4319 of the same host
          projectId: "demo", projectToken: "pt_dev_demo_0000000000000000",
          service: { name: "web-store", version: "1.4.2", environment: "local" } });
```

Any stock OpenTelemetry SDK, your backend included, posts the same way:
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
`OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw`
(`base64("demo:pt_dev_demo_0000000000000000")`; `%20` is how the OTLP env variables
encode a space). Inside the compose network the endpoint is `http://otel-collector:4318`
with the same header, which is what the `backend` service does. A backend on the stack
host may also use the loopback gRPC port `localhost:4317`.

## Verify

```bash
deploy/scripts/wait-ready.sh   # /ready of every service, collector health + both public ports, rum-api /readyz
deploy/scripts/smoke.sh        # edge rules + 1 trace, 1 log, 1 metric, 1 replay chunk round trip through the collector
deploy/scripts/e2e.sh          # synthetic session matrix (tests/e2e/scenario.mjs) + rum-api / Grafana assertions
```

`smoke.sh` sends OTLP/JSON to the collector's `/v1/{traces,logs,metrics}` with the Basic
credential, `service.name=smoke`, `session.id=smoke-session`, `event.name=session.start`
and a deliberately wrong `ouo.project.id=spoofed`, plus one rrweb chunk to
`:4319/v1/replay/chunks`, then asserts:

- CORS: preflight from `Origin: http://localhost:5173` on both `:4318/v1/traces` and
  `:4319/v1/replay/chunks` returns `Access-Control-Allow-Origin` and allows
  `Authorization`; a preflight from `https://evil.example` returning allow-origin is
  reported as a warning (the list is global, ADR-0007 section 4).
- Auth: `POST` without credential `401`, wrong token `401`, unknown project id `401`,
  replay chunk without credential `401`; a direct `POST` to rum-api's
  `/v1/replay/chunks` without the ingest token `401` (the internal sink is not open).
- Collector accepted: OTLP `200` x3, replay `202`.
- Tempo: `{ span.session.id = "smoke-session" }` and
  `{ resource.ouo.project.id = "demo" }` both find the trace; `GET /api/traces/<id>` carries
  `ouo.project.id=demo` (the spoofed value is gone).
- Loki: `{service_name="smoke", event_name="session.start", ouo_platform="web"} | session_id="smoke-session" | ouo_project_id="demo"`
  returns the record (labels are `service_name`, `event_name`, `ouo_platform`,
  `deployment_environment_name`; everything else is structured metadata).
- Mimir: `ouo_smoke_requests{run_id="..."}` is queryable through `/prometheus/api/v1/query`.
- Replay: `GET rum-api/v1/sessions/smoke-replay-<run>/replay` is `401` without the read
  token and, with it, reports `chunk_count >= 1` and `project_id=demo`.

`e2e.sh` exports `OUO_OTLP_URL` (`http://localhost:4318`), `OUO_REPLAY_URL`
(`http://localhost:4319`), `OUO_PROJECT_ID`, `OUO_PROJECT_TOKEN`, `OUO_PROJECT_BASIC`
(the base64), `OUO_RUM_API_URL` (`http://localhost:8080`, read side), `OUO_READ_TOKEN`,
`OUO_GRAFANA_URL`, `OUO_GRAFANA_AUTH` for `tests/e2e/scenario.mjs`.

Manual checks:

```bash
B=ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw   # printf 'demo:pt_dev_demo_0000000000000000' | base64
curl -i -X OPTIONS -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: authorization,content-type" localhost:4318/v1/traces
curl -i -X POST localhost:4318/v1/traces -H 'content-type: application/json' -d '{"resourceSpans":[]}'                               # 401
curl -i -X POST localhost:4318/v1/traces -H "authorization: Basic $B" -H 'content-type: application/json' -d '{"resourceSpans":[]}'   # 200
curl -i -X POST localhost:4319/v1/replay/chunks -H "authorization: Basic $B" -H 'content-type: application/json' \
  -d '{"session_id":"demo-1","seq":0,"started_at":1000,"ended_at":2000,"events":[{"type":4,"data":{"href":"http://x"},"timestamp":1000},{"type":2,"data":{},"timestamp":1001}]}'   # 202
curl -i 'localhost:8080/v1/sessions?from=now-1h'                                                     # 401 without the read token
curl -H 'authorization: Bearer rt_dev_0000000000000000' 'localhost:8080/v1/sessions?from=now-1h'    # 200
curl -H 'authorization: Bearer rt_dev_0000000000000000' localhost:8080/v1/sessions/demo-1/replay    # the chunk arrived via the collector
curl -H 'baggage: session.id=s1,user.id=u1,ouo.platform=web' localhost:8081/api/products             # demo backend -> collector (in-network, Basic header)
curl -G localhost:3200/api/search --data-urlencode 'q={ resource.service.name = "demo-backend" && span.session.id = "s1" }'
```

In Grafana (http://localhost:3000, admin/testing567): Explore -> Tempo -> search
`{ span.session.id = "smoke-session" }`; open a span and use "Logs for this span"
(trace to logs is a custom query on `service_name` + `session_id`). Explore -> Loki ->
`{event_name="session.start"}`. The Tempo metrics generator writes
`traces_spanmetrics_*` and `traces_service_graph_*` to Mimir, which feed the
service map.

## Layout

```
deploy/compose/compose.yaml                      the stack (collector built from ../../collector, public 4318/4319; rum-api internal)
deploy/compose/.env.example                      ports, ingest/read tokens, script project, VM variables (dev values, loud warning)
deploy/compose/collector/config.yaml             ouo-collector config: basicauth, CORS, ouoreplay, ouoratelimit, project stamp -> tempo / loki / mimir, rum-api
deploy/compose/collector/projects.htpasswd       development project registry (demo); one `{SHA}` line per project token
deploy/compose/compose.s3.yaml                   opt-in override: MinIO + bucket init, rum-api on storage.backend s3
deploy/compose/rum-api/config.yaml               rum-api config file (-config.file, ${VAR} expansion for the tokens / S3 keys)
deploy/compose/loki/config.yaml                  single binary, tsdb v13, OTLP label promotion
deploy/compose/tempo/config.yaml                 single binary, local blocks, metrics generator
deploy/compose/mimir/config.yaml                 monolithic, filesystem blocks
deploy/compose/grafana/provisioning/datasources  loki / tempo / mimir with fixed uids
deploy/compose/grafana/provisioning/plugins      ouo-rum-app enabled, rumApiUrl + secureJsonData.readToken
deploy/data/rum-api/                            replay chunks written by rum-api (gitignored)
deploy/scripts/wait-ready.sh, smoke.sh, e2e.sh  readiness, edge + round-trip smoke, e2e scenario runner (OUO_*_URL overrides; `ouo-env env <env>` prints them)
deploy/envs/                                    ouo-env: named local envs behind one Traefik proxy (README)
deploy/vm/                                      Caddy TLS override, install.sh, systemd unit, README
deploy/helm/                                    Kubernetes chart (helm agent)
collector/                                      ocb manifest, Dockerfile, ouoreplay receiver/exporter, ouoratelimit processor (collector agent)
```

## The collector

`collector/` is a custom OpenTelemetry Collector distribution built with ocb: upstream
`otlp` receiver, `basicauth`, `resource`/`attributes`/`transform`, `batch`,
`memory_limiter`, the OTLP exporters, `health_check`, plus ouo's `ouoreplay` receiver and
exporter and `ouoratelimit` processor. Compose builds it as `ouo/collector` from
`../../collector` and mounts `deploy/compose/collector/config.yaml` at
`/etc/otelcol/config.yaml` and `projects.htpasswd` at `/etc/otelcol/projects.htpasswd`.
It needs `OUO_INGEST_TOKEN` in its environment for the replay exporter. Config details:
`project/kb/collector-lgtm.md` and the collector agent's notes.

## rum-api

`services/rum-api` (Go) is built from `../../services/rum-api`, configured like Loki and
Tempo by a mounted YAML file (`deploy/compose/rum-api/config.yaml`, started with
`-config.file=/etc/rum-api/config.yaml -config.expand-env=true`; every key is in
`services/rum-api/config.example.yaml`) and listens on host port
`${OUO_RUM_API_PORT:-8080}` (laptop only). It is internal: the collector's replay exporter
posts chunks to `POST /v1/replay/chunks` with `X-Ouo-Project-Id` and `Authorization:
Bearer <OUO_INGEST_TOKEN>`; Grafana's plugin proxy reads `GET /v1/*` with
`Bearer <OUO_READ_TOKEN>`. It reads Loki (`http://loki:3100`) and Tempo
(`http://tempo:3200`) in-network, stores replay chunks under `deploy/data/rum-api/replays`,
and sends its own traces, logs and metrics to the collector as `service.name=rum-api`
(including `ouo.replay.chunks` / `ouo.replay.bytes`). `GRAFANA_URL` is set from
`OUO_GRAFANA_PORT` because the trace deep links it builds are opened by the browser, not
by the container. Environment variables override the file, so the tokens and
`GRAFANA_URL` stay in compose's `environment:`; `docker compose exec rum-api /rum-api
-config.file=/etc/rum-api/config.yaml -config.expand-env=true -config.verify` prints the
effective config with secrets redacted. Full API and curl examples:
`services/rum-api/README.md`.

### Replays in MinIO (opt-in)

Loki, Tempo and Mimir keep local filesystem storage in this stack, so rum-api does too by
default (`storage.backend: filesystem`, `deploy/data/rum-api`). Object storage is opt-in:

```bash
docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.s3.yaml up -d
curl localhost:8080/readyz          # {"checks":{"loki":"ok","storage":"ok","tempo":"ok"},"ready":true}
open http://localhost:9001          # MinIO console, minioadmin / minioadmin, bucket ouo-replays
```

`compose.s3.yaml` activates the `minio` and `minio-init` services of `compose.yaml`
(profile `s3`) and sets `STORAGE_BACKEND=s3` plus the S3 keys on rum-api. `minio-init`
creates the bucket (`OUO_RUM_API_S3_BUCKET`, default `ouo-replays`) and a `rum-api` user
whose policy only reaches that bucket (`OUO_RUM_API_S3_ACCESS_KEY` /
`OUO_RUM_API_S3_SECRET_KEY`); rum-api never runs with the root credentials and never
creates buckets. Objects use the filesystem layout, `replays/<session_id>/<seq>.json.gz`,
`<seq>.mp4`, `meta.json`; existing replays move over with
`mc mirror deploy/data/rum-api/replays local/ouo-replays/replays`.
`docker compose -f deploy/compose/compose.yaml --profile s3 up -d minio minio-init` starts
MinIO alone, e.g. for the rum-api S3 tests (`OUO_TEST_S3_ENDPOINT=localhost:9000
go test ./internal/replay/`; without it the tests start their own MinIO container).

The official `minio/minio` and `minio/mc` images are no longer published; the stack pins
the community-maintained builds `pgsty/minio` and `pgsty/mc` (same server and client,
override with `OUO_MINIO_IMAGE` / `OUO_MC_IMAGE`). Any S3 compatible store works for
rum-api; see `project/kb/rum-api-config-s3.md`.

```bash
curl localhost:8080/readyz                                                                     # {"ready":true,"checks":{"loki":"ok","tempo":"ok"}}
RT='authorization: Bearer rt_dev_0000000000000000'
curl -H "$RT" 'localhost:8080/v1/sessions?from=now-1h'                 # session records with status, user, trace_count
curl -H "$RT" 'localhost:8080/v1/stats/health?from=now-24h'            # healthy / errored / crashed per platform and version
curl -H "$RT" localhost:8080/v1/sessions/<session_id>                  # record + timeline + traces (Grafana Explore links)
curl -H "$RT" localhost:8080/v1/sessions/<session_id>/replay/events    # rrweb events for rrweb-player
```

The web demo's `VITE_OTLP_ENDPOINT` points at the collector (default `http://localhost:4318`)
and `VITE_OUO_PROJECT_ID` / `VITE_OUO_PROJECT_TOKEN` at the project credential; it never
needs rum-api's URL.

## Grafana app plugin

`plugins/ouo-rum-app` is the MVP UI (Overview, Sessions, Session detail with replay). It is
loaded **unsigned** (`GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo-rum-app`,
`GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS=ouo-rum-app`) from the bind mount
`../../plugins/ouo-rum-app/dist -> /var/lib/grafana/plugins/ouo-rum-app`. When `dist/` does
not exist Docker creates an empty directory and Grafana starts without the plugin.

```bash
npm install && npm run -w plugins/ouo-rum-app build       # repo root
docker compose -f deploy/compose/compose.yaml up -d grafana  # (re)create so the mount is picked up
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
curl -u admin:testing567 localhost:3000/api/plugins/ouo-rum-app/settings | jq '{enabled, jsonData, secureJsonFields}'   # secureJsonFields.readToken: true
curl -u admin:testing567 'localhost:3000/api/plugin-proxy/ouo-rum-app/rum/v1/stats/health?from=now-24h'
```

## Server install (`deploy/vm`)

```bash
curl -fsSL https://raw.githubusercontent.com/ZiadMansourM/ouo/main/deploy/vm/install.sh \
  | sudo bash -s -- --domain ouo.example.com --email you@example.com
```

Caddy terminates TLS for `OUO_DOMAIN` (Grafana) and `OUO_OTEL_DOMAIN` (the collector:
`/v1/replay/*` to 4319, everything else to 4318), every other port is re-bound to
loopback, a project credential and both secrets are generated, the project's `{SHA}` line
is written to a server-side `projects.htpasswd`, a systemd unit keeps the stack up across
reboots. Details, firewall, data locations, upgrade and backup: `deploy/vm/README.md`.
Kubernetes: `deploy/helm/README.md`.

## Notes

- Loki, Tempo, Mimir and the collector images are distroless: no shell, no `wget`, so
  they have no Docker healthchecks. Use `wait-ready.sh`. The collector retries exports
  until the backends are up, Grafana tolerates datasources that are not ready yet.
- Every OTLP client needs the Basic credential, in-network services included: the
  `backend` and `rum-api` services carry `OTEL_EXPORTER_OTLP_HEADERS` (from
  `OUO_BACKEND_OTLP_HEADERS`), so their own telemetry is stamped with the demo project.
- Tempo 3.x logs `no jobs found` errors from its backend scheduler every few seconds
  in single-binary mode; harmless.
- Loki, Tempo, Mimir and rum-api are still published on `0.0.0.0` in the laptop stack so
  Explore-style curls work from other devices on your LAN; the VM override binds them to
  loopback.
- Pinned images: see `compose.yaml` and `project/kb/collector-lgtm.md`; collector component
  versions in `collector/builder.yaml`.
