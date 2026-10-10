# 00. Run the LGTM + collector stack

Goal: in about ten minutes you have Grafana, Loki, Tempo, Mimir, an OpenTelemetry
Collector, `rum-api` and the ouo Grafana plugin running on your machine, and you can
prove with `curl` that a trace, a log record and a metric make the full round trip.

Everything below is copy and paste. Commands have no `$` prompt. Every file you need
to copy is listed with its path in this repo and inlined when it is short.

```
browser / mobile / your backend --OTLP--> otel-collector --> tempo (traces)
                                                        --> loki  (logs / session events)
                                                        --> mimir (metrics)
grafana --> loki, tempo, mimir (provisioned datasources)
grafana app plugin --> rum-api --> loki + tempo + replay chunks on disk
```

## Prerequisites

- Docker Desktop (Compose v2 is bundled). The stack uses about 2 GB of RAM at rest.
- `curl`. `python3` only if you want to run `deploy/scripts/smoke.sh`.
- Node 24 and npm if you want the ouo Grafana plugin (the unified UI). Optional for
  the raw Grafana Explore experience.
- Free host ports: 3000, 3100, 3200, 9009, 4317, 4318, 13133, 8081, 8080. If any of
  them is taken, see "Ports and the .env override" below. Do not skip that check: an
  OTLP endpoint that belongs to another collector swallows your telemetry silently.

## Step 1. Get the files

The fastest route is to run the stack straight from a clone of this repo next to your
own project. Nothing in `deploy/` knows about your code; your backend only needs the
collector's URL.

```bash
git clone https://github.com/ZiadMansourM/ouo.git
```

```bash
cd ouo
```

If you would rather vendor the stack into your own repo, copy these paths **keeping
the same relative layout** (the compose file reaches `../../services/rum-api` and
`../../plugins/ouo-rum-app/dist` with relative paths):

| Ref file (copy as is) | What to change |
|---|---|
| `deploy/docker/compose.yaml` | delete the `backend` service block (it builds the ouo demo API) or point its `build.context` at your own Dockerfile. Nothing else. |
| `deploy/docker/.env.example` | copy to `deploy/docker/.env` only if a default host port collides |
| `deploy/docker/collector/config.yaml` | nothing. Add your dev server origin under `cors.allowed_origins` if it is not `http://localhost:*` or `http://127.0.0.1:*` |
| `deploy/docker/loki/config.yaml` | nothing |
| `deploy/docker/tempo/config.yaml` | nothing |
| `deploy/docker/mimir/config.yaml` | nothing |
| `deploy/docker/grafana/provisioning/datasources/datasources.yaml` | nothing |
| `deploy/docker/grafana/provisioning/plugins/ouo-rum-app.yaml` | nothing |
| `services/rum-api/` (whole Go module) | nothing; compose builds it |
| `plugins/ouo-rum-app/` (whole npm workspace) plus the root `package.json` workspaces entry | nothing; you build `dist/` once |
| `deploy/scripts/wait-ready.sh`, `deploy/scripts/smoke.sh` | nothing; both read `deploy/docker/.env` |

The full content of each config file is at the end of this page under "The ref files,
inlined".

## Step 2. Ports and the `.env` override

Default host ports (container ports never change):

| Service | Host port | Purpose |
|---|---|---|
| grafana | 3000 | UI, login `admin` / `admin` |
| loki | 3100 | Loki API (`/ready`, `/loki/api/v1/...`, OTLP at `/otlp/v1/logs`) |
| tempo | 3200 | Tempo API (`/ready`, `/api/search`, `/api/traces/{id}`) |
| mimir | 9009 | Mimir (`/ready`, `/prometheus/api/v1/...`, OTLP at `/otlp/v1/metrics`) |
| otel-collector | 4317 | OTLP/gRPC |
| otel-collector | 4318 | OTLP/HTTP (CORS enabled, this is what browsers and your backend use) |
| otel-collector | 13133 | collector health (`GET /`) |
| backend | 8081 | ouo demo backend (delete the service if you do not want it) |
| rum-api | 8080 | session and replay API used by the Grafana plugin |

To change any host port, copy the example file and edit it. Compose reads
`deploy/docker/.env` automatically and so do the scripts.

```bash
cp deploy/docker/.env.example deploy/docker/.env
```

`deploy/docker/.env.example` (ref file, inline):

```dotenv
# Host port overrides for deploy/docker/compose.yaml. Copy to deploy/docker/.env
# (gitignored) only if the defaults collide with something else on your machine.
OUO_GRAFANA_PORT=3000
OUO_LOKI_PORT=3100
OUO_TEMPO_PORT=3200
OUO_MIMIR_PORT=9009
OUO_OTLP_GRPC_PORT=4317
OUO_OTLP_HTTP_PORT=4318
OUO_COLLECTOR_HEALTH_PORT=13133
OUO_BACKEND_PORT=8081
OUO_RUM_API_PORT=8080
```

Example: on the ouo developer Mac other containers already own 3000, 3100, 3200,
4317 and 4318, so its `.env` is `3001 / 3101 / 3201 / 9009 / 4327 / 4328 / 13134 /
8082 / 8080`. Every URL on this page assumes the defaults; substitute your values.

In-cluster addresses are fixed and independent of `.env`: `otel-collector:4318`,
`loki:3100`, `tempo:3200`, `mimir:9009`, `rum-api:8080`.

## Step 3. Start

From the repo root:

```bash
docker compose -f deploy/docker/compose.yaml up -d
```

The first run pulls five images and builds `rum-api` (and the demo backend if you
kept it). Allow a couple of minutes.

Useful variants:

```bash
docker compose -f deploy/docker/compose.yaml ps
```

```bash
docker compose -f deploy/docker/compose.yaml logs -f otel-collector
```

```bash
docker compose -f deploy/docker/compose.yaml down
```

```bash
docker compose -f deploy/docker/compose.yaml down -v
```

`down` keeps the data (named volumes `ouo_grafana-data`, `ouo_loki-data`,
`ouo_tempo-data`, `ouo_mimir-data`). `down -v` wipes it. Replay chunks are a bind
mount at `deploy/data/rum-api` (gitignored) and survive `down -v`.

## Step 4. Verify the stack is ready

Loki, Tempo, Mimir and the collector ship distroless images (no shell, no `wget`),
so there are no Docker healthchecks. Readiness is probed over HTTP from the host.

Reference script (reads `.env`, polls every service up to 120 s):

```bash
deploy/scripts/wait-ready.sh
```

Manual equivalents, one per service. Each must print `200`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/ready
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3200/ready
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9009/ready
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:13133/
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/health
```

Grafana answers within seconds. Loki, Tempo and Mimir return a non-200 body that
explains what they are still waiting for (ring membership, ingester warm-up) for
roughly the first 15 to 30 s; keep polling.

Confirm the browser CORS path on the collector (the web SDK posts straight to it
from your dev server origin). You want `access-control-allow-origin` and
`access-control-allow-headers` in the reply:

```bash
curl -s -i -X OPTIONS http://localhost:4318/v1/traces -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type,traceparent,baggage'
```

### Send one trace by hand and find it in Tempo

This is what `deploy/scripts/smoke.sh` does for all three signals with assertions. If
you have `python3`, run it:

```bash
deploy/scripts/smoke.sh
```

The manual version for traces only. First set the timestamps and ids:

```bash
NOW_NS=$(( $(date +%s) * 1000000000 ))
```

```bash
TRACE_ID=0af7651916cd43dd8448eb211c80319c
```

Post one span with `session.id` as a span attribute (this is the attribute the ouo
SDKs and the backend baggage processor set):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4318/v1/traces -H 'Content-Type: application/json' --data-binary '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"hello"}},{"key":"ouo.platform","value":{"stringValue":"web"}}]},"scopeSpans":[{"scope":{"name":"hand"},"spans":[{"traceId":"'"$TRACE_ID"'","spanId":"b7ad6b7169203331","name":"GET /hello","kind":2,"startTimeUnixNano":"'"$((NOW_NS - 50000000))"'","endTimeUnixNano":"'"$NOW_NS"'","attributes":[{"key":"session.id","value":{"stringValue":"hand-session"}}],"status":{"code":1}}]}]}]}'
```

Expect `200`. Fetch it by id (works within a second or two):

```bash
curl -s http://localhost:3200/api/traces/$TRACE_ID | head -c 300
```

Search by session (TraceQL). Tempo only searches a tiny recent window when you omit
`start`/`end`, so always pass them. Searchable about 10 to 60 s after ingestion:

```bash
curl -s -G http://localhost:3200/api/search --data-urlencode 'q={ span.session.id = "hand-session" }' --data-urlencode "start=$(( $(date +%s) - 600 ))" --data-urlencode "end=$(( $(date +%s) + 60 ))"
```

Logs and metrics follow the same pattern: `POST /v1/logs` and `POST /v1/metrics` on
port 4318, then query `http://localhost:3100/loki/api/v1/query_range` and
`http://localhost:9009/prometheus/api/v1/query`. Exact bodies are in
`deploy/scripts/smoke.sh`.

## Step 5. rum-api and the Grafana plugin (the unified UI)

`rum-api` is already part of the compose project and starts with everything else.
It reads Loki and Tempo in-network, stores replay chunks under
`deploy/data/rum-api/replays`, and sends its own telemetry to the collector as
`service.name=rum-api`. Check it:

```bash
curl -s http://localhost:8080/readyz
```

Expected: `{"ready":true,"checks":{"loki":"ok","tempo":"ok"}}` (503 while Loki or
Tempo are still starting). Full API in `services/rum-api/README.md`.

The Grafana plugin is the Overview / Sessions / Session detail UI. Grafana loads it
unsigned from a bind mount of `plugins/ouo-rum-app/dist`. When `dist/` does not
exist Docker mounts an empty directory and Grafana starts without the plugin, so you
build it once and then re-create the Grafana container so the mount is picked up.

From the repo root:

```bash
npm install
```

```bash
npm run -w plugins/ouo-rum-app build
```

```bash
docker compose -f deploy/docker/compose.yaml up -d grafana
```

If Grafana was already running with an empty mount, force a restart:

```bash
docker compose -f deploy/docker/compose.yaml restart grafana
```

Check the plugin is enabled and points at rum-api in-network:

```bash
curl -s -u admin:admin http://localhost:3000/api/plugins/ouo-rum-app/settings
```

Expect `"enabled":true` and `"jsonData":{"rumApiUrl":"http://rum-api:8080"}`. The
browser never calls rum-api directly: the plugin requests
`/api/plugin-proxy/ouo-rum-app/rum/v1/...` and Grafana forwards to `rumApiUrl`.
Prove the proxy works:

```bash
curl -s -u admin:admin 'http://localhost:3000/api/plugin-proxy/ouo-rum-app/rum/v1/stats/health?from=now-24h'
```

After a JS-only rebuild a hard reload in the browser is enough (Grafana caches
`module.js?_cache=<version>`). Restart Grafana only if `src/plugin.json` changed.

## Step 6. Log in to Grafana

Open http://localhost:3000 and sign in with `admin` / `admin` (set in `compose.yaml`
via `GF_SECURITY_ADMIN_USER` / `GF_SECURITY_ADMIN_PASSWORD`; anonymous access is off).

- Explore -> Tempo -> TraceQL `{ span.session.id = "hand-session" }` finds the span
  you posted above.
- Explore -> Loki -> `{event_name="session.start"}` once an SDK has sent a session.
- Explore -> Mimir -> `traces_spanmetrics_calls_total` (written by Tempo's metrics
  generator) once traces flow.
- http://localhost:3000/a/ouo-rum-app/overview is the plugin Overview page.

Datasources are provisioned with fixed uids `loki`, `tempo`, `mimir` and are not
editable from the UI. Trace to logs is a custom query on `service_name` plus
`session_id`; logs to trace uses the `trace_id` structured metadata field.

## What each collector pipeline does

`deploy/docker/collector/config.yaml` is the single ingress for browser, mobile and
backend telemetry. One `otlp` receiver (gRPC 4317, HTTP 4318), three pipelines:

- **traces**: `otlp` -> `memory_limiter`, `batch` -> `otlp_grpc/tempo` (Tempo's own
  OTLP gRPC receiver on `tempo:4317`).
- **logs**: `otlp` -> `memory_limiter`, `transform/events`, `batch` -> `otlp_http/loki`
  (Loki native OTLP at `http://loki:3100/otlp`). The `transform/events` processor
  copies the OTLP top-level `event_name` field into the `event.name` log attribute
  when it is missing, and copies `ouo.platform` from the resource to the record when
  the SDK only set it on the resource. Both become Loki stream labels (see the Loki
  `otlp_config` below), which is what lets rum-api select `{event_name="session.start"}`
  without scanning everything.
- **metrics**: `otlp` -> `memory_limiter`, `batch` -> `otlp_http/mimir` (Mimir OTLP
  at `http://mimir:9009/otlp`). Mimir runs with `otel_metric_suffixes_enabled: false`,
  so a counter named `ouo.demo.requests` is queried as `ouo_demo_requests`, not
  `ouo_demo_requests_total`.

**Why CORS on the receiver**: the browser SDK posts OTLP/HTTP directly from the page
origin (for example the Vite dev server on `http://localhost:5173`) to port 4318.
Without `cors.allowed_origins` the preflight fails and the browser drops every export
without an error you can see in the collector. `allowed_headers: ["*"]` is needed
because the SDK sends `content-type`, and your own backend must do the same for
`traceparent`, `tracestate` and `baggage` (covered in `10-backend.md`).

Collector >= 0.150 names the exporters `otlp_grpc` / `otlp_http`; `otlp` and
`otlphttp` are deprecated aliases. Pinned images: Grafana 13.2.1, Loki 3.7.7,
Tempo 3.0.3, Mimir 3.2.1, collector-contrib 0.160.0.

## The ref files, inlined

Copy each one byte for byte to the same relative path in your project.

### `deploy/docker/compose.yaml` (excerpt: the parts you may touch)

The whole file is about 130 lines; here are the two blocks that matter when you
adapt it. The `backend` block is the ouo demo API, delete it or point it at your
Dockerfile. The environment it receives is exactly what your own service needs.

```yaml
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.160.0
    command: ["--config=/etc/otelcol/config.yaml"]
    ports:
      - "${OUO_OTLP_GRPC_PORT:-4317}:4317"   # OTLP gRPC
      - "${OUO_OTLP_HTTP_PORT:-4318}:4318"   # OTLP HTTP (CORS enabled for browsers)
      - "${OUO_COLLECTOR_HEALTH_PORT:-13133}:13133" # health_check extension
    volumes:
      - ./collector/config.yaml:/etc/otelcol/config.yaml:ro
    depends_on:
      - loki
      - tempo
      - mimir

  backend:
    build:
      context: ../../examples/backend
    ports:
      - "${OUO_BACKEND_PORT:-8081}:8081"
    environment:
      PORT: "8081"
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_SERVICE_NAME: demo-backend
      OTEL_RESOURCE_ATTRIBUTES: deployment.environment.name=local
      CORS_ALLOWED_ORIGINS: http://localhost:5173,http://127.0.0.1:5173
    depends_on:
      - otel-collector
```

The `grafana` service mounts `./grafana/provisioning` read-only and the plugin build
output `../../plugins/ouo-rum-app/dist` at `/var/lib/grafana/plugins/ouo-rum-app`,
with `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo-rum-app` and
`GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS=ouo-rum-app`. The `rum-api`
service builds `../../services/rum-api`, gets `LOKI_URL=http://loki:3100`,
`TEMPO_URL=http://tempo:3200`, `GRAFANA_URL=http://localhost:${OUO_GRAFANA_PORT:-3000}`
(browser-facing, used in deep links) and mounts `../data/rum-api` at `/data`.

### `deploy/docker/collector/config.yaml`

```yaml
# OpenTelemetry Collector (contrib) for the ouo local stack.
# Single ingress for browser, mobile and backend telemetry.

extensions:
  health_check:
    endpoint: 0.0.0.0:13133

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
        cors:
          # Browser SDK (Vite dev server) posts directly to the collector.
          allowed_origins:
            - "http://localhost:*"
            - "http://127.0.0.1:*"
          allowed_headers:
            - "*"
          max_age: 7200

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128
  batch:
    timeout: 1s
    send_batch_size: 512
    send_batch_max_size: 1024
  # Copy the OTLP top-level event_name (OTel Logs API `eventName`) into the
  # `event.name` log attribute so Loki can index it as a label regardless of
  # whether the SDK set it as a field or as an attribute. Also makes sure
  # `ouo.platform` exists as a log attribute when it was only set on the resource.
  transform/events:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - set(log.attributes["event.name"], log.event_name) where log.event_name != "" and log.attributes["event.name"] == nil
          - set(log.attributes["ouo.platform"], resource.attributes["ouo.platform"]) where log.attributes["ouo.platform"] == nil and resource.attributes["ouo.platform"] != nil

# Collector >= 0.150 names the exporters otlp_grpc / otlp_http (otlp / otlphttp are deprecated aliases).
exporters:
  otlp_grpc/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  otlp_http/loki:
    endpoint: http://loki:3100/otlp
    tls:
      insecure: true
  otlp_http/mimir:
    endpoint: http://mimir:9009/otlp
    tls:
      insecure: true
  debug:
    verbosity: basic

service:
  extensions: [health_check]
  telemetry:
    logs:
      level: info
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_grpc/tempo]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, transform/events, batch]
      exporters: [otlp_http/loki]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/mimir]
```

### `deploy/docker/loki/config.yaml`

The part that matters for ouo is `limits_config.otlp_config`: only `service.name`,
`service.namespace`, `deployment.environment.name`, `ouo.platform` (resource) and
`event.name`, `ouo.platform` (record) become stream labels. `session.id`, `user.id`,
`trace_id` and everything else land in structured metadata, so cardinality stays flat
and you filter with `| session_id="..."`. Loki rewrites `.` to `_` in label names.

```yaml
# Loki 3.x single-binary, filesystem storage, native OTLP ingestion.
auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: warn

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: "2024-01-01"
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

storage_config:
  tsdb_shipper:
    active_index_directory: /loki/tsdb-index
    cache_location: /loki/tsdb-cache

compactor:
  working_directory: /loki/compactor
  retention_enabled: false

pattern_ingester:
  enabled: true

ruler:
  storage:
    type: local
    local:
      directory: /loki/rules

limits_config:
  # Structured metadata is required for OTLP ingestion: every attribute that is
  # not promoted to a label lands there (session.id, user.id, trace_id, ...).
  allow_structured_metadata: true
  volume_enabled: true
  reject_old_samples: true
  reject_old_samples_max_age: 168h
  ingestion_rate_mb: 32
  ingestion_burst_size_mb: 64
  max_label_names_per_series: 30
  # Label promotion for OTLP (ADR-0001): only service_name, event_name and
  # ouo_platform become stream labels; session.id stays structured metadata
  # so cardinality stays low. Loki rewrites "." to "_" in label names.
  otlp_config:
    resource_attributes:
      # Loki's default list also promotes service.instance.id, k8s.*, cloud.* which
      # would explode cardinality for browser SDKs; replace it with a fixed set.
      ignore_defaults: true
      attributes_config:
        - action: index_label
          attributes:
            - service.name
            - service.namespace
            - deployment.environment.name
            - ouo.platform
    log_attributes:
      - action: index_label
        attributes:
          - event.name
          - ouo.platform

analytics:
  reporting_enabled: false
```

### `deploy/docker/tempo/config.yaml`

Single binary, local blocks, OTLP receiver on 4317/4318 (in-network only), and a
metrics generator that remote-writes `traces_spanmetrics_*` and
`traces_service_graph_*` into Mimir, which feed Grafana's service map.

```yaml
# Tempo 3.x single binary, local storage, OTLP receiver, metrics generator -> Mimir.
# Only keys that exist in 3.0.x are used; see kb/collector-lgtm.md.
# Grafana >= 11 streams search/trace results over gRPC on the HTTP port (h2c).
stream_over_http_enabled: true

server:
  http_listen_port: 3200
  log_level: warn

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318

# Tempo 3.0 removed the 2.x `ingester` and `compactor` top-level blocks
# (block-builder / live-store replace them); defaults are fine locally.

querier:
  frontend_worker:
    frontend_address: 127.0.0.1:9095

query_frontend:
  search:
    duration_slo: 5s
    throughput_bytes_slo: 1.073741824e+09
  trace_by_id:
    duration_slo: 5s

metrics_generator:
  registry:
    external_labels:
      source: tempo
  storage:
    path: /var/tempo/generator/wal
    remote_write:
      - url: http://mimir:9009/api/v1/push
        send_exemplars: true

storage:
  trace:
    backend: local
    wal:
      path: /var/tempo/wal
    local:
      path: /var/tempo/blocks

overrides:
  defaults:
    metrics_generator:
      processors: [service-graphs, span-metrics]
```

### `deploy/docker/mimir/config.yaml`

```yaml
# Mimir monolithic mode, filesystem storage, OTLP push at /otlp/v1/metrics.
target: all
multitenancy_enabled: false

server:
  http_listen_port: 9009
  grpc_listen_port: 9095
  log_level: warn

common:
  storage:
    backend: filesystem
    filesystem:
      dir: /data/blocks

blocks_storage:
  storage_prefix: blocks
  bucket_store:
    sync_dir: /data/tsdb-sync
  tsdb:
    dir: /data/tsdb

compactor:
  data_dir: /data/compactor
  sharding_ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: memberlist

distributor:
  ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: memberlist

ingester:
  ring:
    instance_addr: 127.0.0.1
    replication_factor: 1
    kvstore:
      store: memberlist

store_gateway:
  sharding_ring:
    instance_addr: 127.0.0.1
    replication_factor: 1
    kvstore:
      store: memberlist

ruler_storage:
  storage_prefix: rules

alertmanager_storage:
  storage_prefix: alertmanager

memberlist:
  bind_addr: [127.0.0.1]
  join_members: []

limits:
  # Accept metrics without OTel-style unit/type suffix mangling and keep resource attrs.
  otel_metric_suffixes_enabled: false
  max_global_series_per_user: 1000000
  ingestion_rate: 100000
  ingestion_burst_size: 500000
  out_of_order_time_window: 5m

usage_stats:
  enabled: false
```

### `deploy/docker/grafana/provisioning/datasources/datasources.yaml`

Fixed uids (`loki`, `tempo`, `mimir`) so that rum-api deep links and the plugin
always resolve. `$$` escapes the provisioner's own `${ENV}` expansion.

```yaml
apiVersion: 1

deleteDatasources:
  - name: Loki
    orgId: 1
  - name: Tempo
    orgId: 1
  - name: Mimir
    orgId: 1

datasources:
  - name: Loki
    uid: loki
    type: loki
    access: proxy
    url: http://loki:3100
    editable: false
    jsonData:
      maxLines: 1000
      derivedFields:
        # OTLP log records carry the trace id as structured metadata `trace_id`.
        - name: TraceID
          datasourceUid: tempo
          matcherType: label
          matcherRegex: trace_id
          url: "$${__value.raw}"
          urlDisplayLabel: View trace

  - name: Tempo
    uid: tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    editable: false
    jsonData:
      streamingEnabled:
        search: true
      nodeGraph:
        enabled: true
      serviceMap:
        datasourceUid: mimir
      tracesToMetrics:
        datasourceUid: mimir
        spanStartTimeShift: "-5m"
        spanEndTimeShift: "5m"
      lokiSearch:
        datasourceUid: loki
      tracesToLogsV2:
        datasourceUid: loki
        spanStartTimeShift: "-30m"
        spanEndTimeShift: "30m"
        filterByTraceID: false
        filterBySpanID: false
        customQuery: true
        # `${__span.tags[...]}` resolves both span attributes (session.id) and resource
        # attributes (service.name): Grafana merges process tags into __span.tags and the
        # field path goes through lodash `property`, so bracket keys with dots work.
        # session.id is structured metadata in Loki, so it is a `|` filter, never a
        # stream selector. `$$` escapes the provisioner's own ${ENV} expansion.
        tags:
          - key: service.name
            value: service_name
        query: '{service_name="$${__span.tags["service.name"]}"} | session_id="$${__span.tags["session.id"]}"'

  - name: Mimir
    uid: mimir
    type: prometheus
    access: proxy
    url: http://mimir:9009/prometheus
    editable: false
    jsonData:
      httpMethod: POST
      prometheusType: Mimir
      prometheusVersion: "2.9.1"
      timeInterval: 15s
      exemplarTraceIdDestination:
        - name: trace_id
          datasourceUid: tempo
```

### `deploy/docker/grafana/provisioning/plugins/ouo-rum-app.yaml`

```yaml
# Enables the ouo RUM app plugin (plugins/ouo-rum-app, loaded unsigned from
# /var/lib/grafana/plugins/ouo-rum-app) and points its "rum" route at the
# in-network rum-api. The browser never talks to rum-api directly: the plugin
# calls /api/plugin-proxy/ouo-rum-app/rum/v1/... and Grafana forwards to rumApiUrl.
apiVersion: 1

apps:
  - type: ouo-rum-app
    org_id: 1
    disabled: false
    jsonData:
      rumApiUrl: http://rum-api:8080
```

### `deploy/scripts/wait-ready.sh`

Reference for the readiness loop. It sources `deploy/docker/.env`, then polls
`/ready` on Loki, Tempo and Mimir, `/` on the collector health port and
`/api/health` on Grafana until each returns 200 or `OUO_READY_TIMEOUT` (120 s)
passes.

```bash
#!/usr/bin/env bash
# Wait until Loki, Tempo, Mimir, the collector and Grafana answer their readiness endpoints.
# Honors the OUO_*_PORT overrides from deploy/docker/.env (same defaults as compose.yaml).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${OUO_ENV_FILE:-$SCRIPT_DIR/../docker/.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

LOKI="http://localhost:${OUO_LOKI_PORT:-3100}"
TEMPO="http://localhost:${OUO_TEMPO_PORT:-3200}"
MIMIR="http://localhost:${OUO_MIMIR_PORT:-9009}"
COLLECTOR_HEALTH="http://localhost:${OUO_COLLECTOR_HEALTH_PORT:-13133}"
GRAFANA="http://localhost:${OUO_GRAFANA_PORT:-3000}"
TIMEOUT="${OUO_READY_TIMEOUT:-120}"

wait_for() {
  local name="$1" url="$2" deadline=$((SECONDS + TIMEOUT))
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" == "200" ]]; do
    if (( SECONDS >= deadline )); then
      echo "FAIL: $name not ready after ${TIMEOUT}s ($url): $(curl -s "$url" | head -c 200)" >&2
      return 1
    fi
    sleep 2
  done
  echo "ready: $name ($url)"
}

wait_for loki "$LOKI/ready"
wait_for tempo "$TEMPO/ready"
wait_for mimir "$MIMIR/ready"
wait_for otel-collector "$COLLECTOR_HEALTH/"
wait_for grafana "$GRAFANA/api/health"
```

## What you should see

- `docker compose -f deploy/docker/compose.yaml ps` lists `grafana`, `loki`, `tempo`,
  `mimir`, `otel-collector`, `rum-api` (and `backend` if kept) as `running`; `grafana`
  shows `(healthy)`.
- The five readiness curls print `200`. `deploy/scripts/wait-ready.sh` prints five
  `ready:` lines.
- The CORS preflight reply contains `Access-Control-Allow-Origin: http://localhost:5173`.
- `curl http://localhost:3200/api/traces/0af7651916cd43dd8448eb211c80319c` returns a
  JSON trace, and the TraceQL search returns one entry under `traces`.
- `curl http://localhost:8080/readyz` returns `{"ready":true,...}`.
- `deploy/scripts/smoke.sh` ends with `SMOKE OK: trace_id=... session.id=smoke-session ...`.
- Grafana at http://localhost:3000 logs you in as `admin`, Connections -> Data sources
  lists Loki, Tempo and Mimir, and http://localhost:3000/a/ouo-rum-app/overview renders
  the plugin (empty until an SDK sends sessions).
- `docker compose -f deploy/docker/compose.yaml logs otel-collector` shows no
  `Exporting failed` lines once the backends are ready. Tempo logging `no jobs found`
  every few seconds is harmless in single-binary mode.

Next: `10-backend.md` wires your Go service into this collector.
