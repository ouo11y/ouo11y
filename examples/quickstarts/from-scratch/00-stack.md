# 00. Build the ouo stack yourself

The first guide of the [from-scratch series](README.md). You write the ouo stack by hand, one
service at a time, start it in Docker, and send it a first record with `curl`. Every later guide
sends its data here. Plan on about 20 minutes.

```
ouo-from-scratch/
└── stack/
    ├── compose.yaml          lists the five services below, nothing else
    ├── 10-collector/         OpenTelemetry Collector: the only thing your apps talk to
    ├── 20-tempo/             traces
    ├── 30-loki/              events: sessions, page views, clicks, errors, vitals
    ├── 40-muninn/            replay chunks
    └── 50-grafana/           the UI
```

What goes where:

```
browser, phone ──OTLP :4318──► Collector ──┬─ spans ─────────────────► Tempo  ──┐
   (Basic auth: project id + token)        ├─ events ────────────────► Loki   ──┼─► Grafana
                                           └─ replay chunks ─► Muninn (+ a reference in Loki)
```

Every command goes in its own block: run them one by one, in order. Paths are relative to
`ouo-from-scratch/`, wherever you create it. When a step says "create", make the file with that
path and paste the block into it. Long files are in collapsible sections: open one, copy it.

## Step 0. Check your tools

Docker Desktop (or any Docker with Compose v2.20 or newer, for `include:`) must be running. This
prints the server details, not "Cannot connect":

```bash
docker info
```

```bash
docker compose version
```

`curl`, to talk to the stack without an app:

```bash
curl --version
```

Everything you run is a released image: the stock OpenTelemetry Collector, Grafana's Tempo, Loki
and Grafana, and `ghcr.io/ouo11y/muninn`. You do not need a clone of the ouo11y repository.

## Step 1. Create the folders

From the folder where you keep your projects:

```bash
mkdir -p ouo-from-scratch/stack
```

```bash
cd ouo-from-scratch/stack
```

```bash
mkdir -p 10-collector 20-tempo 30-loki 40-muninn 50-grafana/provisioning/datasources
```

Open `ouo-from-scratch/` in your editor. Every file of this guide is under `stack/`.

## Step 2. The stack, one service at a time

Each folder holds one service: its `compose.yaml` and its config. Every file starts with a comment
that says what the service is for, who sends it data and which ports it opens. Ports are variables
(`${OUO_GRAFANA_PORT:-3000}`), so you can move them in step 3 without touching a file. Only the
collector (4318) and Grafana (3000) are published to your network; Loki, Tempo, Muninn and the
collector's health port are bound to `127.0.0.1`, for `curl`.

### The collector

**The collector is the edge: browsers and phones post OpenTelemetry (OTLP) to it with a project
id and token, and it decides where each record goes.** It is the stock contrib distribution of the
OpenTelemetry Collector, pinned to 0.160.0, with no ouo code in it.

<details>
<summary><code>stack/10-collector/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/from-scratch/result/stack/10-collector/compose.yaml -->
```yaml
# OpenTelemetry Collector: the only ingest. Browsers and phones post OTLP to 4318 with the
# project credential; it forwards spans to Tempo, events to Loki, and replay chunks to Muninn
# (with a reference record in Loki). Ports: 4318 OTLP/HTTP (public), 13133 health (loopback).
services:
  otel-collector:
    # The stock contrib distribution, pinned: it has every component config.yaml uses, the
    # replay disk queue (file_storage) included. ghcr.io/ouo11y/collector adds a per-client
    # rate limiter; its released 0.5.0 has no file_storage yet, so this guide uses contrib.
    image: otel/opentelemetry-collector-contrib:0.160.0
    command: ["--config=/etc/otelcol/config.yaml"]
    ports:
      - "${OUO_OTLP_HTTP_PORT:-4318}:4318"
      - "127.0.0.1:${OUO_COLLECTOR_HEALTH_PORT:-13133}:13133"
    environment:
      MUNINN_INGEST_TOKEN: mit_dev_0000000000000000   # must equal Muninn's ingest token
    volumes:
      - ./config.yaml:/etc/otelcol/config.yaml:ro
      - ./projects.htpasswd:/etc/otelcol/projects.htpasswd:ro
      - replay-queue:/var/lib/otelcol/replay-queue
    depends_on:
      replay-queue-init:
        condition: service_completed_successfully
      tempo: {condition: service_started}
      loki: {condition: service_started}
      muninn: {condition: service_started}

  # The collector runs as user 10001, and a new volume belongs to root: hand it over once.
  replay-queue-init:
    image: busybox:1.37
    command: ["chown", "10001:10001", "/var/lib/otelcol/replay-queue"]
    volumes:
      - replay-queue:/var/lib/otelcol/replay-queue

volumes:
  replay-queue:   # chunks waiting for Muninn survive a collector restart
```

</details>

**The pipeline.** Read it from the bottom (`service.pipelines`) up. Three things are ouo-specific,
and each is a stock component:

- `basicauth/projects` checks `Authorization: Basic base64(<project id>:<token>)` against
  `projects.htpasswd`, and `resource/project` writes the project id onto every record as
  `ouo.project.id`, whatever the client claimed.
- `routing/replay` sends records of instrumentation scope `ouo.replay` (the SDKs' replay chunks)
  to Muninn, and everything else to Loki.
- `file_storage/replay` puts Muninn's sending queue on disk, so a chunk the SDK was told is
  accepted survives a collector restart or a Muninn outage.

<details>
<summary><code>stack/10-collector/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/from-scratch/result/stack/10-collector/config.yaml -->
```yaml
# Collector pipeline. Every request needs HTTP Basic `<project id>:<project token>` from
# projects.htpasswd; the project id is stamped on every record as ouo.project.id.
#
#   OTLP :4318 -> traces              -> Tempo
#              -> logs, scope ouo.rum    -> Loki
#              -> logs, scope ouo.replay -> Muninn (disk queue)  + a reference record in Loki
extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  basicauth/projects:
    htpasswd:
      file: /etc/otelcol/projects.htpasswd
  # The replay queue is written to disk (fsync) before the SDK gets its 2xx.
  file_storage/replay:
    directory: /var/lib/otelcol/replay-queue
    create_directory: true
    fsync: true

receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        include_metadata: true
        max_request_body_size: 4194304   # 4 MiB; a replay chunk is at most 1 MiB
        auth:
          authenticator: basicauth/projects
        cors:
          allowed_origins: ["http://localhost:*", "http://127.0.0.1:*"]
          allowed_headers: [Authorization, Content-Type, Content-Encoding, traceparent, baggage]
          exposed_headers: [Retry-After]

connectors:
  # Replay chunks go one way, everything else the other.
  routing/replay:
    error_mode: propagate
    default_pipelines: [logs]
    table:
      - context: log
        condition: instrumentation_scope.name == "ouo.replay"
        pipelines: [logs/replay, logs/replay-index]

processors:
  # The authenticated project wins over anything the client sent.
  resource/project:
    attributes:
      - key: ouo.project.id
        action: delete
      - key: ouo.project.id
        from_context: auth.username
        action: upsert
  # Loki indexes event.name; OTLP carries it as the record's event name.
  transform/events:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - set(log.attributes["event.name"], log.event_name) where log.event_name != "" and log.attributes["event.name"] == nil
  # Loki's copy of a chunk: its attributes, no bytes, and where Muninn keeps it.
  transform/replay-ref:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - set(log.body, "") where log.event_name == "ouo.replay.chunk"
          - set(log.attributes["ouo.replay.ref"], Concat(["muninn:", resource.attributes["ouo.project.id"], log.attributes["session.id"], log.attributes["ouo.replay.id"], log.attributes["ouo.replay.stream.id"], String(log.attributes["ouo.replay.sequence"])], "/")) where log.event_name == "ouo.replay.chunk"
  batch:
    timeout: 1s

exporters:
  otlp_grpc/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  otlp_http/loki:
    endpoint: http://loki:3100/otlp
    tls:
      insecure: true
  otlp_http/muninn:
    logs_endpoint: http://muninn:3400/otlp/v1/logs
    compression: none   # chunk bodies are already gzipped
    tls:
      insecure: true
    headers:
      Authorization: Bearer ${env:MUNINN_INGEST_TOKEN}
    sending_queue:
      enabled: true
      storage: file_storage/replay
      block_on_overflow: false   # a full queue answers 503, and the SDK retries later
    retry_on_failure:
      enabled: true
      max_elapsed_time: 0        # keep retrying while Muninn is down

service:
  extensions: [health_check, basicauth/projects, file_storage/replay]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [resource/project, batch]
      exporters: [otlp_grpc/tempo]
    logs/in:
      receivers: [otlp]
      processors: [resource/project]
      exporters: [routing/replay]
    logs:
      receivers: [routing/replay]
      processors: [transform/events, batch]
      exporters: [otlp_http/loki]
    logs/replay:   # no batch: the SDK's 2xx waits for the disk queue
      receivers: [routing/replay]
      exporters: [otlp_http/muninn]
    logs/replay-index:
      receivers: [routing/replay]
      processors: [transform/replay-ref, transform/events, batch]
      exporters: [otlp_http/loki]
```

</details>

**The projects allowed to send.** One line per project: its id, then the SHA-1 of its token. The
`demo` token, `pt_dev_demo_0000000000000000`, is public: it can only write into project `demo`,
and it is meant for your laptop.

<details>
<summary><code>stack/10-collector/projects.htpasswd</code> (click to open)</summary>

<!-- embed: examples/quickstarts/from-scratch/result/stack/10-collector/projects.htpasswd -->
```text
# Projects allowed to send data: one line per project, project id and SHA hash of its token.
# Read by the collector's basicauth extension. The `demo` token (pt_dev_demo_0000000000000000)
# is public: local use only. Make a line with htpasswd -nbs PROJECT TOKEN. No colon in comments.
demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=
```

</details>

To add a project later, make its line with `htpasswd -nbs <project> <token>` (Apache's tool, on
macOS already installed) and append it.

### Tempo

**Tempo stores traces: the page load and every `fetch` the browser SDK traces.**

<details>
<summary><code>stack/20-tempo/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/from-scratch/result/stack/20-tempo/compose.yaml -->
```yaml
# Tempo: stores traces. The collector sends it the browser's spans over OTLP/gRPC (4317);
# Grafana and your plugin query it on 3200, published on loopback for curl.
services:
  tempo:
    image: grafana/tempo:3.0.3
    command: ["-config.file=/etc/tempo/config.yaml"]
    ports:
      - "127.0.0.1:${OUO_TEMPO_PORT:-3200}:3200"
    volumes:
      - ./config.yaml:/etc/tempo/config.yaml:ro
      - tempo-data:/var/tempo

volumes:
  tempo-data:
```

</details>

<details>
<summary><code>stack/20-tempo/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/from-scratch/result/stack/20-tempo/config.yaml -->
```yaml
# Tempo 3.x single binary with local storage. Receives OTLP from the collector on 4317, serves
# queries on 3200 (Grafana streams search results over that port, hence stream_over_http).
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

querier:
  frontend_worker:
    frontend_address: 127.0.0.1:9095

storage:
  trace:
    backend: local
    wal:
      path: /var/tempo/wal
    local:
      path: /var/tempo/blocks
```

</details>

### Loki

**Loki stores events: every session start, page view, click, error and vital is one OTLP log
record with an event name.** The config decides which attributes become stream labels. Keep that
list short: `session.id` stays structured metadata (one stream per session would make Loki slow),
and the plugin of guide 03 filters on it with `| session_id="..."`.

<details>
<summary><code>stack/30-loki/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/from-scratch/result/stack/30-loki/compose.yaml -->
```yaml
# Loki: stores events. The collector sends it every RUM event over OTLP (/otlp); Grafana and
# your plugin query it on 3100, published on loopback for curl.
services:
  loki:
    image: grafana/loki:3.7.7
    command: ["-config.file=/etc/loki/config.yaml"]
    ports:
      - "127.0.0.1:${OUO_LOKI_PORT:-3100}:3100"
    volumes:
      - ./config.yaml:/etc/loki/config.yaml:ro
      - loki-data:/loki

volumes:
  loki-data:
```

</details>

<details>
<summary><code>stack/30-loki/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/from-scratch/result/stack/30-loki/config.yaml -->
```yaml
# Loki 3.x single binary, filesystem storage, native OTLP ingestion on 3100.
# Stream labels: service_name, deployment_environment_name, ouo_platform, ouo_project_id and
# event_name. Everything else (session.id, enduser.id, trace_id, ...) is structured metadata:
# filter on it with `| session_id="..."`, never in the {selector}.
auth_enabled: false

server:
  http_listen_port: 3100
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

limits_config:
  allow_structured_metadata: true   # required for OTLP
  otlp_config:
    resource_attributes:
      ignore_defaults: true         # the defaults would index per-device ids
      attributes_config:
        - action: index_label
          attributes: [service.name, deployment.environment.name, ouo.platform, ouo.project.id]
    log_attributes:
      - action: index_label
        attributes: [event.name, ouo.platform]

analytics:
  reporting_enabled: false
```

</details>

### Muninn

**Muninn stores replay chunks, one file per chunk, and serves a replay's manifest and chunks to a
backend that holds its read token.** Browsers never reach it: the collector writes with the ingest
token, your plugin's backend (guide 03) reads with the read token. Both tokens below are public
development values.

<details>
<summary><code>stack/40-muninn/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/from-scratch/result/stack/40-muninn/compose.yaml -->
```yaml
# Muninn: the replay store. The collector posts replay chunks to it (/otlp/v1/logs, ingest
# token); your plugin's backend reads them (/api/v1/..., read token). It keeps one file per
# chunk in the muninn-data volume. Port 3400 on loopback for curl; browsers never reach it.
services:
  muninn:
    image: ghcr.io/ouo11y/muninn:0.1.0
    command: ["-config.file=/etc/muninn/config.yaml", "-config.expand-env=true"]
    ports:
      - "127.0.0.1:${OUO_MUNINN_PORT:-3400}:3400"
    environment:
      MUNINN_INGEST_TOKEN: mit_dev_0000000000000000   # the collector's; public, local only
      MUNINN_READ_TOKEN: mrt_dev_0000000000000000     # your plugin's (guide 03); public, local only
      OTEL_SDK_DISABLED: "true"                       # Muninn's own telemetry: off here
    volumes:
      - ./config.yaml:/etc/muninn/config.yaml:ro
      - muninn-data:/data

volumes:
  muninn-data:
```

</details>

<details>
<summary><code>stack/40-muninn/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/from-scratch/result/stack/40-muninn/config.yaml -->
```yaml
# Muninn on a local directory. Every key and its default:
# https://github.com/ouo11y/ouo11y/blob/main/services/muninn/config.example.yaml
server:
  http_listen_port: 3400
multitenancy_enabled: false   # every request is tenant "anonymous"
auth:
  ingest_token: ${MUNINN_INGEST_TOKEN}
  read_token: ${MUNINN_READ_TOKEN}
storage:
  backend: filesystem
  filesystem:
    directory: /data
retention:
  default: 720h               # replays older than 30 days are removed
```

</details>

### Grafana

**Grafana is the UI. For now it reads Loki and Tempo as datasources; guide 03 adds your own
plugin.** `admin` / `testing567` is a development password.

Create `stack/50-grafana/compose.yaml`. Guide 03 replaces it with a version that loads your
plugin:

```yaml
# Grafana: the UI. It reads Loki and Tempo directly (provisioning/datasources). Port 3000,
# admin / testing567: development credentials, public.
services:
  grafana:
    image: grafana/grafana:13.2.5
    ports:
      - "${OUO_GRAFANA_PORT:-3000}:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: testing567
    volumes:
      - ./provisioning:/etc/grafana/provisioning:ro
    depends_on: [loki, tempo]
```

<details>
<summary><code>stack/50-grafana/provisioning/datasources/datasources.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/from-scratch/result/stack/50-grafana/provisioning/datasources/datasources.yaml -->
```yaml
# Grafana datasources: Loki (events) and Tempo (traces), inside the compose network.
# A Loki line with a trace_id links to its trace in Tempo.
apiVersion: 1

datasources:
  - name: Loki
    uid: loki
    type: loki
    url: http://loki:3100
    isDefault: true
    jsonData:
      derivedFields:
        - name: TraceID
          datasourceUid: tempo
          matcherType: label
          matcherRegex: trace_id
          url: "$${__value.raw}"
          urlDisplayLabel: View trace

  - name: Tempo
    uid: tempo
    type: tempo
    url: http://tempo:3200
    jsonData:
      lokiSearch:
        datasourceUid: loki
```

</details>

### The top file

**`stack/compose.yaml` only lists the folders**, one line each, so the stack reads like its own
table of contents.

<!-- embed: examples/quickstarts/from-scratch/result/stack/compose.yaml -->
```yaml
# The ouo stack, one folder per service. This file only lists them; each folder holds the
# service's compose file and its config. Start everything from this folder: `docker compose up -d`.
# Grafana http://localhost:3000 (admin / testing567), OTLP http://localhost:4318.
# Ports taken? Put OUO_GRAFANA_PORT=... and OUO_OTLP_HTTP_PORT=... in stack/.env.
name: ouo-from-scratch   # compose project name: containers and volumes use it
include:
  - 10-collector/compose.yaml   # ingest: the only thing your apps talk to, replay included
  - 20-tempo/compose.yaml       # traces: page loads and fetch requests
  - 30-loki/compose.yaml        # events: sessions, page views, clicks, errors, vitals
  - 40-muninn/compose.yaml      # replay chunks, one file per chunk
  - 50-grafana/compose.yaml     # the UI: Loki and Tempo, and your plugin (guide 03)
```

## Step 3. Check the ports

The stack needs 3000 (Grafana) and 4318 (OTLP) on your network, and 3100, 3200, 3400 and 13133
on loopback. This lists what already listens on them; no output means they are free:

```bash
lsof -nP -iTCP:3000 -iTCP:4318 -iTCP:3100 -iTCP:3200 -iTCP:3400 -iTCP:13133 -sTCP:LISTEN
```

If one is taken, do not stop what holds it: move ouo instead. Create `stack/.env` with the ports
you want, for example:

```text
OUO_GRAFANA_PORT=3001
OUO_OTLP_HTTP_PORT=4328
```

The other variables are `OUO_LOKI_PORT`, `OUO_TEMPO_PORT`, `OUO_MUNINN_PORT` and
`OUO_COLLECTOR_HEALTH_PORT`. If you move a port, use the new one wherever the next guides say
`localhost:3000`, `localhost:4318` and so on.

## Step 4. Start it

From `stack/`:

```bash
docker compose up -d
```

The first start pulls about 1 GB of images. Then every service is up, and `replay-queue-init` has
exited with 0 (it hands the queue volume to the collector's user, once):

```bash
docker compose ps -a
```

The collector answers its health check:

```bash
curl -s localhost:13133
```

You see `{"status":"Server available",...}`.

## Step 5. Send a first record

Without a credential the collector refuses (`401`):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:4318/v1/logs -H 'Content-Type: application/json' -d '{}'
```

With the `demo` credential it takes an OTLP log record, the same shape the SDKs send (`200`):

```bash
curl -s -w " %{http_code}\n" -u demo:pt_dev_demo_0000000000000000 -H 'Content-Type: application/json' localhost:4318/v1/logs -d '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"curl"}}]},"scopeLogs":[{"scope":{"name":"ouo.rum"},"logRecords":[{"eventName":"hello","body":{"stringValue":"hello from curl"}}]}]}]}'
```

Now find it in Grafana:

1. Open http://localhost:3000 and sign in as `admin` / `testing567`.
2. Open **Explore**, pick the **Loki** datasource, switch the query editor to **Code** and run:

   ```logql
   {service_name="curl"}
   ```

You see one line, `hello from curl`. Open it: the labels show `event_name = hello` and
`ouo_project_id = demo`. The project id came from your credential, not from the record.

The stack is ready. Leave it running for [01. A web app](01-web.md).

## Clean up

Stop the stack and keep its data (from `stack/`):

```bash
docker compose down
```

Stop it and delete the data too (every session, trace and replay):

```bash
docker compose down -v
```

## When something does not work

| What you see | Why | Fix |
|---|---|---|
| `include` is not a valid key, or `services.include` errors | Docker Compose older than v2.20 | Update Docker Desktop |
| `Bind for 0.0.0.0:3000 failed: port is already allocated` | Something else listens on that port | Step 3: move ouo with `stack/.env` |
| The collector restarts; its log says `permission denied` on `/var/lib/otelcol/replay-queue` | The collector started before `replay-queue-init` handed it the volume | `docker compose down`, then `docker compose up -d`: the collector waits for the init now |
| `401` with the `demo` credential | `projects.htpasswd` was changed, or the token is mistyped | The line must be exactly `demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=` |
| The collector exits with `unknown type` for `basicauth`, `routing` or `file_storage` | The image is not the contrib distribution | Use `otel/opentelemetry-collector-contrib:0.160.0` |
| Loki shows nothing for `{service_name="curl"}` | The time picker is older than the record, or the record was refused | Set the range to "Last 15 minutes"; read `docker compose logs otel-collector loki` |
| A newer image rejects a config | Every image here is pinned; if you changed a tag, its config may have changed | `docker compose logs <service>`, go back to the pinned tag |

## Why these pieces

- **No ouo collector image.** `ghcr.io/ouo11y/collector` adds a per-client rate limiter and an
  auth-failure counter to the same stock components. Its released 0.5.0 does not include
  `file_storage`, which the replay queue needs, so this guide uses contrib. A later collector
  release can replace the `image:` line, with its `ouoratelimit` processor added to the config.
- **No Mimir.** The SDKs send traces and events, not metrics. Add Mimir (and a `metrics` pipeline)
  when your backends send metrics.
- **No rum-api, no ouo plugin.** Since [ADR-0025](../../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md)
  the UI on top of this data is yours: guide 03 builds one with the generic libraries `ouo-go` and
  `@ouo11y/kit`.
