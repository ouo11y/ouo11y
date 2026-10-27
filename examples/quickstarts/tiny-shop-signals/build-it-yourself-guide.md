# Build Tiny Shop Signals yourself

Quickstart 2. A small shop whose sessions carry what you need to understand them: frontend logs,
Web Vitals, backend metrics on a dashboard, and a checkout that fails one time in three so some
sessions are `errored`. You build, one step at a time, with no scripts:

1. a plain Express API and a plain React page, with no telemetry at all;
2. the ouo stack (the ouo collector, Tempo, Loki, Mimir, rum-api, Grafana), one folder per service;
3. the backend: OpenTelemetry traces, and three metrics on a provisioned dashboard;
4. the web app: `@ouo11y/browser` for sessions, Web Vitals and replay, plus your own log lines.

At the end your files are the same as [`result/`](result): compare with them when you are
stuck. Plan on about 40 minutes.

```
tiny-shop-signals/
├── stack/      the ouo stack, one folder per service
├── backend/    Express API, OpenTelemetry traces and metrics
└── frontend/   React app, @ouo11y/browser, frontend logs
```

Every command goes in its own block: run them one by one, in order. Paths are relative to
`tiny-shop-signals/`, wherever you create it, and each command says which of its folders it runs
in. When a step says "replace the file", select everything in it and paste the new content over it.

## Step 0. Check your tools

Node 24 or newer:

```bash
node -v
```

Docker Desktop (or Docker Engine with Compose 2.24 or later) must be running. This prints the
server details, not "Cannot connect":

```bash
docker info
```

VS Code's `code` command. If it is not found, open VS Code, press Cmd+Shift+P and run
**Shell Command: Install 'code' command in PATH**.

```bash
code --version
```

## Step 1. Create the folders and open VS Code

From the folder where you keep your projects:

```bash
mkdir -p tiny-shop-signals/backend tiny-shop-signals/stack
```

```bash
cd tiny-shop-signals
```

```bash
code .
```

In VS Code, open a terminal with Ctrl+\`. You will use three terminal tabs (the `+` button):
one for the backend, one for the frontend, one for the stack. Each new tab opens in
`tiny-shop-signals/`.

## Step 2. A simple API, no telemetry yet

In the first terminal tab, from `tiny-shop-signals/`:

```bash
cd backend
```

```bash
npm init -y
```

```bash
npm install express cors
```

| Package | What it does here |
|---|---|
| `express` | the HTTP server and its routes |
| `cors` | answers the browser's preflight: the web app on `:5173` calls the API on `:5001`, another origin |

Create `backend/server.js`. The checkout fails one time in three, like a flaky payment provider:

```js
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const products = [
  { id: 1, name: "Coffee", price: 4 },
  { id: 2, name: "Tea", price: 3 },
  { id: 3, name: "Cake", price: 6 },
];

app.get("/api/products", async (req, res) => {
  await sleep(80);
  res.json(products);
});

app.post("/api/checkout", async (req, res) => {
  await sleep(150);
  if (Math.random() < 1 / 3) return res.status(500).json({ error: "payment provider timeout" });
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

app.listen(5001, () => console.log("tiny-shop-signals API on http://localhost:5001"));
```

Run it, still in `backend/`:

```bash
node server.js
```

In another terminal tab, from `tiny-shop-signals/`, check that it answers:

```bash
curl localhost:5001/api/products
```

You get the three products as JSON. Leave the API running.

## Step 3. A plain React UI

In the second terminal tab, from `tiny-shop-signals/` (Vite creates `frontend/`):

```bash
npm create vite@latest frontend -- --template react --no-interactive
```

```bash
cd frontend
```

```bash
npm install
```

The template installs `react` and `react-dom` (the UI), `vite` (the dev server and the build) and
`@vitejs/plugin-react` (JSX and fast refresh), plus `oxlint` (a linter) and `@types/react`,
`@types/react-dom` (editor hints), which this guide does not use.

Replace `frontend/src/App.jsx` with:

```jsx
import { useEffect, useState } from "react";

const API = "http://localhost:5001";

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`).then((r) => r.json()).then(setProducts);
  }, []);

  async function checkout() {
    if (!email.includes("@")) {
      setMessage("Enter an email address first");
      return;
    }
    const res = await fetch(`${API}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: cart.map((p) => p.id) }),
    });
    if (!res.ok) {
      setMessage("Payment failed, try again");
      return;
    }
    const data = await res.json();
    setMessage(`Order #${data.orderId} placed`);
    setCart([]);
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "40px auto" }}>
      <h1>Tiny Shop</h1>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.name} (${p.price}) <button onClick={() => setMessage(`${p.name}: freshly made, $${p.price}`)}>View</button>{" "}
            <button onClick={() => setCart([...cart, p])}>Add</button>
          </li>
        ))}
      </ul>
      <p>Cart: {cart.length} item(s)</p>
      <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />{" "}
      <button onClick={checkout} disabled={!cart.length}>Checkout</button>
      <p>{message}</p>
    </main>
  );
}
```

Start it, still in `frontend/`:

```bash
npm run dev
```

Open http://localhost:5173. You see the three products (the page reached your API). Click
**Add**, type an email, then **Checkout** a few times: most say "Order #… placed", about one in
three says "Payment failed". The app works, and nothing is instrumented yet: when a checkout fails,
nobody but the shopper knows.

## Step 4. The stack, one service at a time

### 4a. Create the files

Six services, one folder each. Each folder holds that service's compose file and its config, and
each file starts with what the service is for, who sends it data and its ports. Open a block, copy
all of it, and paste it into the file named in its title (VS Code creates the folders when you
save a new file as `stack/10-collector/compose.yaml`).

`compose.yaml` only lists the service folders:

<details>
<summary><code>stack/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/compose.yaml -->
```yaml
# The ouo stack for tiny-shop-signals: one folder per service, each with its compose file and
# its config. This file only lists them. Start everything from this folder: `docker compose up -d`.
# Grafana http://localhost:3000 (admin / testing567), OTLP http://localhost:4318, replay :4319.
# Ports taken? Export OUO_GRAFANA_PORT, OUO_OTLP_HTTP_PORT, OUO_REPLAY_PORT before `up`.
include:
  - 10-collector/compose.yaml   # ingest: the only thing the apps talk to
  - 20-tempo/compose.yaml       # traces
  - 30-loki/compose.yaml        # logs and browser events
  - 40-mimir/compose.yaml       # metrics
  - 50-rum-api/compose.yaml     # sessions and replay for the Grafana plugin
  - 60-grafana/compose.yaml     # the UI: datasources, ouo11y RUM app, dashboard
```

</details>

**The collector** is the only thing your apps talk to. It checks the project credential
(`projects.htpasswd`) and routes traces, logs, metrics and replay chunks.
<details>
<summary><code>stack/10-collector/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/10-collector/compose.yaml -->
```yaml
# ouo-collector: the only ingest. The browser SDK and the Node API send OTLP here; it checks the
# project credential and forwards traces to Tempo, logs to Loki, metrics to Mimir and replay
# chunks to rum-api. Ports: 4318 OTLP/HTTP, 4319 replay (both public), 13133 health (loopback).
services:
  otel-collector:
    # `latest` follows each release. Tested with 0.4.0: pin `collector:0.4.0` or
    # `collector@sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2` to stay on it.
    image: ghcr.io/ouo11y/collector:latest
    command: ["--config=/etc/otelcol/config.yaml"]
    ports:
      - "${OUO_OTLP_HTTP_PORT:-4318}:4318"
      - "${OUO_REPLAY_PORT:-4319}:4319"
      - "127.0.0.1:${OUO_COLLECTOR_HEALTH_PORT:-13133}:13133"
    environment:
      OUO_INGEST_TOKEN: it_dev_0000000000000000   # what it sends to rum-api; must equal rum-api's
    volumes:
      - ./config.yaml:/etc/otelcol/config.yaml:ro
      - ./projects.htpasswd:/etc/otelcol/projects.htpasswd:ro
    depends_on: [tempo, loki, mimir]
```

</details>
<details>
<summary><code>stack/10-collector/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/10-collector/config.yaml -->
```yaml
# ouo-collector pipelines, a trimmed copy of the full stack's config (no Sentry bridge, no
# rate limits). Receivers: OTLP/HTTP on 4318 and replay chunks on 4319, both behind the
# project credential in projects.htpasswd. Exporters: Tempo, Loki, Mimir and rum-api.

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  basicauth/server:
    htpasswd:
      file: /etc/otelcol/projects.htpasswd

receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        include_metadata: true       # keeps the authenticated project for resource/project
        auth:
          authenticator: basicauth/server
        cors:                        # the browser app runs on another origin
          allowed_origins: ["http://localhost:*", "http://127.0.0.1:*"]
          allowed_headers: [Authorization, Content-Type, Content-Encoding, traceparent, baggage]
  ouoreplay:
    endpoint: 0.0.0.0:4319
    include_metadata: true
    max_request_body_size: 8388608
    auth:
      authenticator: basicauth/server
    cors:
      allowed_origins: ["http://localhost:*", "http://127.0.0.1:*"]
      allowed_headers: [Authorization, Content-Type, Content-Encoding, X-Ouo-Session-Id, X-Ouo-Seq]

processors:
  # Stamp the authenticated project id on every resource (and drop any value the client sent).
  resource/project:
    attributes:
      - key: ouo.project.id
        action: delete
      - key: ouo.project.id
        from_context: auth.username
        action: upsert
  # Copy the OTLP event name into the `event.name` attribute, which Loki turns into a label.
  transform/events:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - set(log.attributes["event.name"], log.event_name) where log.event_name != "" and log.attributes["event.name"] == nil
  batch:
    timeout: 1s

exporters:
  otlp_grpc/tempo:
    endpoint: tempo:4317
    tls: { insecure: true }
  otlp_http/loki:
    endpoint: http://loki:3100/otlp
    tls: { insecure: true }
  otlp_http/mimir:
    endpoint: http://mimir:9009/otlp
    tls: { insecure: true }
  ouoreplay:
    endpoint: http://rum-api:8080
    ingest_token: ${env:OUO_INGEST_TOKEN}

service:
  extensions: [health_check, basicauth/server]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [resource/project, batch]
      exporters: [otlp_grpc/tempo]
    logs:
      receivers: [otlp]
      processors: [resource/project, transform/events, batch]
      exporters: [otlp_http/loki]
    metrics:
      receivers: [otlp]
      processors: [resource/project, batch]
      exporters: [otlp_http/mimir]
    logs/replay:
      receivers: [ouoreplay]
      exporters: [ouoreplay]
```

</details>
<details>
<summary><code>stack/10-collector/projects.htpasswd</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/10-collector/projects.htpasswd -->
```text
# Projects allowed to send data: one line per project, project id and SHA hash of its token.
# Read by the collector's basicauth extension. The `demo` token (pt_dev_demo_0000000000000000)
# is public: local use only. Make a line with htpasswd -nbs PROJECT TOKEN. No colon in comments.
demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=
```

</details>

**The three stores**: Tempo for traces, Loki for logs and browser events, Mimir for metrics.
<details>
<summary><code>stack/20-tempo/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/20-tempo/compose.yaml -->
```yaml
# Tempo: stores traces. The collector sends it spans from the browser and the API over OTLP/gRPC;
# Grafana and rum-api query it on 3200. Port 3200 is published for curl; nothing else needs it.
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

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/20-tempo/config.yaml -->
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
<details>
<summary><code>stack/30-loki/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/30-loki/compose.yaml -->
```yaml
# Loki: stores logs. The collector sends it the browser's events and frontend logs over OTLP
# (/otlp); Grafana and rum-api query it on 3100 (rum-api builds sessions from these records).
# Port 3100 is published on loopback for curl.
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

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/30-loki/config.yaml -->
```yaml
# Loki 3.x single binary, filesystem storage, native OTLP ingestion on 3100.
# Only service_name, deployment_environment_name, event_name and ouo_platform become labels;
# everything else (session.id, user.id, trace_id, your log attributes) is structured metadata.
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
      ignore_defaults: true         # the defaults would index per-browser ids
      attributes_config:
        - action: index_label
          attributes: [service.name, deployment.environment.name, ouo.platform]
    log_attributes:
      - action: index_label
        attributes: [event.name, ouo.platform]

analytics:
  reporting_enabled: false
```

</details>
<details>
<summary><code>stack/40-mimir/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/40-mimir/compose.yaml -->
```yaml
# Mimir: stores metrics. The collector pushes the API's OTLP metrics to /otlp; Grafana queries
# it with PromQL on 9009 (/prometheus). Port 9009 is published on loopback for curl.
services:
  mimir:
    image: grafana/mimir:3.2.1
    command: ["-config.file=/etc/mimir/config.yaml"]
    ports:
      - "127.0.0.1:${OUO_MIMIR_PORT:-9009}:9009"
    volumes:
      - ./config.yaml:/etc/mimir/config.yaml:ro
      - mimir-data:/data

volumes:
  mimir-data:
```

</details>
<details>
<summary><code>stack/40-mimir/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/40-mimir/config.yaml -->
```yaml
# Mimir in monolithic mode (target: all) on one machine, filesystem storage.
# OTLP push at :9009/otlp/v1/metrics, PromQL at :9009/prometheus.
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
    kvstore: { store: memberlist }

distributor:
  ring:
    instance_addr: 127.0.0.1
    kvstore: { store: memberlist }

ingester:
  ring:
    instance_addr: 127.0.0.1
    replication_factor: 1
    kvstore: { store: memberlist }

store_gateway:
  sharding_ring:
    instance_addr: 127.0.0.1
    replication_factor: 1
    kvstore: { store: memberlist }

ruler_storage:
  storage_prefix: rules

alertmanager_storage:
  storage_prefix: alertmanager

memberlist:
  bind_addr: [127.0.0.1]
  join_members: []

limits:
  # Keep OTel metric names as sent: shop.orders becomes shop_orders, not shop_orders_total.
  otel_metric_suffixes_enabled: false
```

</details>

**rum-api** builds sessions from Loki and Tempo and gives each a status (healthy, errored,
crashed); the Grafana plugin reads it. From 0.5.0 it also sends its own traces and logs through the
collector, hence the `OTEL_EXPORTER_OTLP_*` lines.
<details>
<summary><code>stack/50-rum-api/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/50-rum-api/compose.yaml -->
```yaml
# rum-api: the ouo platform service behind the Grafana plugin. It builds the session list
# (healthy / errored / crashed) from Loki and Tempo and stores replay chunks the collector
# forwards. Internal: only the collector and Grafana talk to it, on 8080 inside the network.
services:
  rum-api:
    # `latest` follows each release. Tested with 0.5.0: pin `rum-api:0.5.0` or
    # `rum-api@sha256:1ee9e606220df2c42f4ade4131fdd3f82085d6e814676a771754a85a6ae78336` to stay on it.
    image: ghcr.io/ouo11y/rum-api:latest
    command: ["-config.file=/etc/rum-api/config.yaml", "-config.expand-env=true"]
    environment:
      GRAFANA_URL: http://localhost:${OUO_GRAFANA_PORT:-3000}   # for deep links
      OUO_INGEST_TOKEN: it_dev_0000000000000000   # the collector's; development value
      OUO_READ_TOKEN: rt_dev_0000000000000000     # Grafana's; development value
      DATA_DIR: /home/nonroot                     # the image runs as nonroot
      # rum-api's own traces and logs (0.5.0 and later), through the collector like the shop's.
      # Without these it retries localhost:4318 inside its container and logs every failure.
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_EXPORTER_OTLP_HEADERS: Authorization=Basic%20ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_SERVICE_NAME: rum-api
    volumes:
      - ./config.yaml:/etc/rum-api/config.yaml:ro
      - rum-api-data:/home/nonroot
    depends_on: [loki, tempo, otel-collector]

volumes:
  rum-api-data:
```

</details>
<details>
<summary><code>stack/50-rum-api/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/50-rum-api/config.yaml -->
```yaml
# rum-api configuration: where Loki and Tempo are, and the session timeouts.
# The tokens come from the environment set in compose.yaml (-config.expand-env=true).
# Replays are stored on the rum-api-data volume.
server:
  http_listen_address: ":8080"

auth:
  ingest_token: "${OUO_INGEST_TOKEN}"
  read_token: "${OUO_READ_TOKEN}"

loki:
  url: http://loki:3100
  datasource_uid: loki

tempo:
  url: http://tempo:3200
  datasource_uid: tempo

session:
  inactivity: 30m
  max_duration: 4h

storage:
  backend: filesystem
```

</details>

**Grafana** with the ouo11y RUM app, its datasources, and the API dashboard that step 5 fills.
<details>
<summary><code>stack/60-grafana/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/60-grafana/compose.yaml -->
```yaml
# Grafana with the ouo11y RUM app plugin: the UI for everything above. It reads Tempo, Loki and
# Mimir directly and sessions from rum-api through the plugin. Port 3000, admin / testing567.
# provisioning/ sets up the datasources, the plugin and the "Tiny Shop API" dashboard.
services:
  grafana:
    # `latest` follows each release. Tested with 0.5.0: pin `grafana:0.5.0` or
    # `grafana@sha256:57607a3616c88867644be1f69abb4681ca73df05d6bf2682543418f0dfeb622f` to stay on it.
    image: ghcr.io/ouo11y/grafana:latest
    ports:
      - "${OUO_GRAFANA_PORT:-3000}:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: testing567
      GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS: ouo11y-rum-app
      GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS: ouo11y-rum-app
      OUO_READ_TOKEN: rt_dev_0000000000000000   # read by provisioning/plugins; equals rum-api's
    volumes:
      - ./provisioning:/etc/grafana/provisioning:ro
      - ./dashboards:/var/lib/grafana/dashboards:ro
    depends_on: [loki, tempo, mimir, rum-api]
```

</details>
<details>
<summary><code>stack/60-grafana/provisioning/datasources/datasources.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/60-grafana/provisioning/datasources/datasources.yaml -->
```yaml
# Grafana datasources: Loki (logs), Tempo (traces), Mimir (metrics), all inside the network.
# The uids are fixed because rum-api's config and the dashboard refer to them.
# Log lines with a trace_id link to the trace in Tempo.
apiVersion: 1

datasources:
  - name: Loki
    uid: loki
    type: loki
    url: http://loki:3100
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

  - name: Mimir
    uid: mimir
    type: prometheus
    url: http://mimir:9009/prometheus
    isDefault: true
    jsonData:
      prometheusType: Mimir
      timeInterval: 15s
```

</details>
<details>
<summary><code>stack/60-grafana/provisioning/plugins/ouo11y-rum-app.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/60-grafana/provisioning/plugins/ouo11y-rum-app.yaml -->
```yaml
# Enables the ouo11y RUM app (More apps -> ouo11y RUM) and points it at rum-api.
# Grafana adds the read token to every call it forwards; ${OUO_READ_TOKEN} comes from the
# container environment and must equal rum-api's.
apiVersion: 1

apps:
  - type: ouo11y-rum-app
    org_id: 1
    jsonData:
      rumApiUrl: http://rum-api:8080
    secureJsonData:
      readToken: ${OUO_READ_TOKEN}
```

</details>
<details>
<summary><code>stack/60-grafana/provisioning/dashboards/dashboards.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/60-grafana/provisioning/dashboards/dashboards.yaml -->
```yaml
# Loads every dashboard JSON file in /var/lib/grafana/dashboards (the dashboards/ folder next
# to compose.yaml) into the "Tiny Shop" folder. Edit the JSON file and restart Grafana to change one.
apiVersion: 1

providers:
  - name: tiny-shop
    folder: Tiny Shop
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

</details>
<details>
<summary><code>stack/60-grafana/dashboards/tiny-shop-api.json</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/stack/60-grafana/dashboards/tiny-shop-api.json -->
```json
{
  "uid": "tiny-shop-api",
  "title": "Tiny Shop API",
  "description": "The API's OpenTelemetry metrics in Mimir: request rate, errors, latency and orders.",
  "tags": [
    "tiny-shop",
    "ouo"
  ],
  "schemaVersion": 41,
  "time": {
    "from": "now-30m",
    "to": "now"
  },
  "refresh": "10s",
  "panels": [
    {
      "type": "timeseries",
      "title": "Requests per second, by route and status",
      "gridPos": {
        "x": 0,
        "y": 0,
        "w": 12,
        "h": 8
      },
      "datasource": {
        "type": "prometheus",
        "uid": "mimir"
      },
      "fieldConfig": {
        "defaults": {
          "unit": "reqps"
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (http_route, http_response_status_code) (rate(shop_http_requests[1m]))",
          "legendFormat": "{{http_route}} {{http_response_status_code}}"
        }
      ]
    },
    {
      "type": "timeseries",
      "title": "Request duration p50 / p95 (ms)",
      "gridPos": {
        "x": 12,
        "y": 0,
        "w": 12,
        "h": 8
      },
      "datasource": {
        "type": "prometheus",
        "uid": "mimir"
      },
      "fieldConfig": {
        "defaults": {
          "unit": "ms"
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "histogram_quantile(0.5, sum by (le) (rate(shop_http_request_duration_bucket[1m])))",
          "legendFormat": "p50"
        },
        {
          "refId": "B",
          "expr": "histogram_quantile(0.95, sum by (le) (rate(shop_http_request_duration_bucket[1m])))",
          "legendFormat": "p95"
        }
      ]
    },
    {
      "type": "stat",
      "title": "Orders placed since the API started",
      "gridPos": {
        "x": 0,
        "y": 8,
        "w": 6,
        "h": 6
      },
      "datasource": {
        "type": "prometheus",
        "uid": "mimir"
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(shop_orders{app_order_result=\"placed\"})"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "decimals": 0
        },
        "overrides": []
      }
    },
    {
      "type": "stat",
      "title": "Checkouts failed since the API started",
      "gridPos": {
        "x": 6,
        "y": 8,
        "w": 6,
        "h": 6
      },
      "datasource": {
        "type": "prometheus",
        "uid": "mimir"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 1
              }
            ]
          },
          "decimals": 0
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(shop_orders{app_order_result=\"failed\"})"
        }
      ]
    },
    {
      "type": "timeseries",
      "title": "Checkouts per minute, by result",
      "gridPos": {
        "x": 12,
        "y": 8,
        "w": 12,
        "h": 6
      },
      "datasource": {
        "type": "prometheus",
        "uid": "mimir"
      },
      "fieldConfig": {
        "defaults": {},
        "overrides": [
          {
            "matcher": { "id": "byName", "options": "placed" },
            "properties": [{ "id": "color", "value": { "mode": "fixed", "fixedColor": "green" } }]
          },
          {
            "matcher": { "id": "byName", "options": "failed" },
            "properties": [{ "id": "color", "value": { "mode": "fixed", "fixedColor": "red" } }]
          }
        ]
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (app_order_result) (rate(shop_orders[1m])) * 60",
          "legendFormat": "{{app_order_result}}"
        }
      ]
    }
  ]
}
```

</details>

**Image versions.** The three ouo images use the `latest` tag, which follows every release. The
compose files say which version this guide was tested with and its digest: pin
`ghcr.io/ouo11y/rum-api:0.5.0`, or the `@sha256:...` digest, to keep a stack on one version. The
configs in this guide are written for the tested versions; a much newer rum-api may refuse a
config key it no longer knows, and the error in `docker compose logs rum-api` names it.

### 4b. Log in to ghcr.io

The ouo images are private for now. You need read access to the `ouo11y` packages and a
**classic** GitHub token with only the `read:packages` scope. Put the token in your shell
(`export GHCR_TOKEN=...`), never in a file, then:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <your-github-user> --password-stdin
```

### 4c. Check the ports

The stack publishes 3000 (Grafana) and the collector's 4318 (OTLP) and 4319 (replay) to your
network, and 3100, 3200, 9009 and 13133 on loopback only. This prints nothing when they are all free:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|3100|3200|4318|4319|9009|13133) '
```

If something is listed, do not stop it: move this stack instead. From `stack/`:

```bash
code .env
```

and set the ports that are taken, for example:

```
OUO_GRAFANA_PORT=13000
OUO_OTLP_HTTP_PORT=14318
OUO_REPLAY_PORT=14319
```

Compose reads `.env` on its own. The others are `OUO_LOKI_PORT`, `OUO_TEMPO_PORT`,
`OUO_MIMIR_PORT` and `OUO_COLLECTOR_HEALTH_PORT` (the `${OUO_..._PORT:-...}` lines in the
compose files). Remember the new collector ports: steps 5 and 6 tell you where they go.

### 4d. Start it

In the third terminal tab, from `tiny-shop-signals/`:

```bash
cd stack
```

```bash
docker compose up -d
```

```bash
docker compose ps
```

Six services are `Up`, and `rum-api` becomes `healthy`. Open http://localhost:3000 and log in
with **admin / testing567** (development credentials, public: local use only).
**Dashboards -> Tiny Shop -> Tiny Shop API** is there with no data yet, and
**More apps -> ouo11y RUM** is still empty.

## Step 5. Instrument the backend: traces and metrics

Stop the API with Ctrl+C in its terminal tab (still in `backend/`), then:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace @opentelemetry/sdk-metrics @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/instrumentation-http @opentelemetry/instrumentation-express @opentelemetry/baggage-span-processor @opentelemetry/resources @opentelemetry/semantic-conventions
```

| Package | What it does here |
|---|---|
| `@opentelemetry/api` | what `server.js` calls: `trace` for manual spans, `metrics` for the counters and the histogram |
| `@opentelemetry/sdk-node` | `NodeSDK`: starts tracing, metrics and the instrumentations in one call |
| `@opentelemetry/sdk-trace` | `BatchSpanProcessor`, which sends spans in batches (OpenTelemetry JS 3.0 replaced `sdk-trace-base` with it) |
| `@opentelemetry/sdk-metrics` | `PeriodicExportingMetricReader`, which exports every metric every 10 s |
| `@opentelemetry/exporter-trace-otlp-http`, `exporter-metrics-otlp-http` | send spans and metrics to the collector over OTLP/HTTP |
| `@opentelemetry/instrumentation-http`, `instrumentation-express` | a server span for every request, named after the Express route |
| `@opentelemetry/baggage-span-processor` | copies the browser's `baggage` (`session.id`, `user.id`) onto every backend span |
| `@opentelemetry/resources`, `semantic-conventions` | the resource (who sends the data) and the standard attribute names |

Create `backend/instrumentation.js`. It starts the OpenTelemetry Node SDK before the app; new
compared to Tiny Shop is the `PeriodicExportingMetricReader`, which sends every metric to the
collector's `/v1/metrics` every 10 seconds, with the same project credential as the traces.

<details>
<summary><code>backend/instrumentation.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/backend/instrumentation.js -->
```js
// OpenTelemetry SDK init: traces and metrics, both to the ouo collector over OTLP/HTTP.
// Loaded before the app with `node --require ./instrumentation.js` so the http and express
// instrumentations can patch those modules before server.js loads them.
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
const { BaggageSpanProcessor, ALLOW_ALL_BAGGAGE_KEYS } = require("@opentelemetry/baggage-span-processor");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions");

// The ouo collector, the only ingest. Moved ports? OUO_OTLP_ENDPOINT=http://localhost:14318
const endpoint = process.env.OUO_OTLP_ENDPOINT || "http://localhost:4318";

// Every request needs the project credential: Basic base64("<project id>:<project token>").
// This is the quickstart's `demo` project: base64("demo:pt_dev_demo_0000000000000000").
const headers = { Authorization: "Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw" };

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "tiny-shop-signals-backend",
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment.name": "local",
  }),
  spanProcessors: [
    // The browser SDK sends `baggage: session.id=...,user.id=...`; copy it onto every span so
    // backend spans can be searched by the RUM session.
    new BaggageSpanProcessor(ALLOW_ALL_BAGGAGE_KEYS),
    new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }) }),
  ],
  // New in this example: metrics. The collector forwards /v1/metrics to Mimir. Every 10 s the
  // reader exports the current value of every counter and histogram in server.js.
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, headers }),
      exportIntervalMillis: 10000,
    }),
  ],
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
});

sdk.start();
console.log(`[otel] traces and metrics to ${endpoint}`);

const shutdown = () => sdk.shutdown().finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

</details>

Replace `backend/server.js`. It adds three metrics: a request counter and a duration histogram,
filled by a small middleware for every request, and `shop.orders`, a business counter labelled
`placed` or `failed`. The failing checkout now records the error on its `charge card` span.

<details>
<summary><code>backend/server.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/backend/server.js -->
```js
// The API. HTTP server spans come from the auto-instrumentation; the spans and the metrics
// below are manual.
const express = require("express");
const cors = require("cors");
const { trace, metrics, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-signals-backend");
const meter = metrics.getMeter("tiny-shop-signals-backend");

// Three metrics, named like OpenTelemetry semantic conventions. Mimir turns dots into
// underscores: shop_http_requests, shop_http_request_duration_bucket, shop_orders.
const requests = meter.createCounter("shop.http.requests", {
  description: "API requests, by route and status code",
});
const duration = meter.createHistogram("shop.http.request.duration", {
  description: "API request duration",
  unit: "ms",
  advice: { explicitBucketBoundaries: [10, 25, 50, 100, 200, 400, 800] },
});
const orders = meter.createCounter("shop.orders", {
  description: "Checkouts, by result (placed or failed) and number of items",
});

const app = express();
// The browser calls this API from another origin and adds `traceparent` and `baggage`
// headers; cors() answers the preflight for them.
app.use(cors());
app.use(express.json());

// Count and time every request once the response is sent.
app.use((req, res, next) => {
  const start = performance.now();
  res.on("finish", () => {
    const attrs = { "http.route": req.route?.path ?? "unknown", "http.response.status_code": res.statusCode };
    requests.add(1, attrs);
    duration.record(performance.now() - start, attrs);
  });
  next();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const products = [
  { id: 1, name: "Coffee", price: 4 },
  { id: 2, name: "Tea", price: 3 },
  { id: 3, name: "Cake", price: 6 },
];

app.get("/api/products", async (req, res) => {
  // A manual span around a "database" call.
  const result = await tracer.startActiveSpan("db.select products", async (span) => {
    span.setAttribute("db.system.name", "fake-db");
    await sleep(50 + Math.random() * 100);
    span.setAttribute("app.products.count", products.length);
    span.end();
    return products;
  });
  res.json(result);
});

app.post("/api/checkout", async (req, res) => {
  const items = req.body.items || [];
  // The deliberately failing path: one checkout in three fails at the payment step and
  // answers 500. The browser records `http.request.failed`, so that session is `errored`.
  const declined = Math.random() < 1 / 3;
  await tracer.startActiveSpan("checkout", async (span) => {
    span.setAttribute("app.cart.items", items.length);
    await tracer.startActiveSpan("validate cart", async (child) => {
      await sleep(30);
      child.end();
    });
    await tracer.startActiveSpan("charge card", async (child) => {
      await sleep(120);
      if (declined) {
        const err = new Error("payment provider timeout");
        child.recordException(err);
        child.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      } else {
        child.addEvent("payment accepted");
      }
      child.end();
    });
    span.end();
  });
  orders.add(1, { "app.order.result": declined ? "failed" : "placed", "app.cart.items": items.length });
  if (declined) return res.status(500).json({ error: "payment provider timeout" });
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

const port = Number(process.env.PORT || 5001);
app.listen(port, () => console.log(`tiny-shop-signals API on http://localhost:${port}`));
```

</details>

The SDK has to load **before** Express so the instrumentation can patch it. Save that as the
start script, then start the API, still in `backend/`:

```bash
npm pkg set scripts.start="node --require ./instrumentation.js server.js"
```

```bash
npm start
```

It prints `[otel] traces and metrics to http://localhost:4318`. Collector on 14318 (step 4c)?
Stop it and start it with `OUO_OTLP_ENDPOINT=http://localhost:14318 npm start` instead.

In another terminal tab, from `tiny-shop-signals/`, call it a few times:

```bash
curl -s localhost:5001/api/products
```

```bash
curl -s -X POST -H 'content-type: application/json' -d '{"items":[1]}' localhost:5001/api/checkout
```

Within 30 seconds **Dashboards -> Tiny Shop -> Tiny Shop API** shows requests per second and the
first orders. In **Explore -> Tempo -> TraceQL**, `{ resource.service.name = "tiny-shop-signals-backend" && name = "charge card" }`
finds the checkouts (traces reach search up to a minute after the call).

## Step 6. Instrument the web app: the ouo SDK, logs and Web Vitals

Stop Vite with Ctrl+C in its terminal tab (still in `frontend/`), then:

```bash
npm install @ouo11y/browser @opentelemetry/api-logs@0.222.0
```

| Package | What it does here |
|---|---|
| `@ouo11y/browser` | the ouo browser SDK: the session id, errors, `fetch` spans with `traceparent` and `baggage` to the API, Web Vitals, rrweb replay, all sent to the collector with the project credential |
| `@opentelemetry/api-logs` | the logs API that `log.js` asks for a logger; the SDK registers the logger provider behind it. Pinned to 0.222.0, the version `@ouo11y/browser` 0.3.0 uses, so npm installs one copy |

<details>
<summary>Which OpenTelemetry logs package is which? (click to open)</summary>

| Package | Status | Here |
|---|---|---|
| `@opentelemetry/api-logs` | experimental ("Logs Bridge API"), the 0.2xx line of OpenTelemetry JS 2.x | used: `@ouo11y/browser` 0.3.0 registers its logger provider with this package's global. Two copies of it (another version) means two globals, and your logs go nowhere |
| `@opentelemetry/api` `logs` | current: OpenTelemetry JS 3.0 moved the logs API into the stable API (1.10) | not used yet: it keeps its own global, which `@ouo11y/browser` 0.3.0 does not register with, so a logger from it drops every record |
| `@opentelemetry/sdk-logs`, `exporter-logs-otlp-http` | current | not installed: the SDK already has its logger provider and exporter |
| `@opentelemetry/api-events`, `sdk-events` | deprecated (an event is a log record with an `eventName`) | not used |

`@ouo11y/browser` 0.3.0 is built on OpenTelemetry JS 2.x and still depends on
`@opentelemetry/sdk-trace-web` and `instrumentation-fetch`, which are deprecated in favour of
`sdk-trace` and `@opentelemetry/browser-instrumentation`. You do not install or import them; they
come with the SDK until it moves to 3.0.

</details>

`rum.js` starts `@ouo11y/browser`. Web Vitals need no option: the SDK reports FCP, LCP, CLS,
INP and TTFB as `web_vital` events by default. Create `frontend/src/rum.js`:

<details>
<summary><code>frontend/src/rum.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/frontend/src/rum.js -->
```js
// ouo browser SDK init: sessions, errors, fetch tracing, Web Vitals and replay.
import { initRUM } from "@ouo11y/browser";

// The API (backend/). Moved it? VITE_API_URL in .env.local.
export const API = import.meta.env.VITE_API_URL || "http://localhost:5001";

export const rum = initRUM({
  // The ouo collector. Moved ports? Set VITE_OUO_ENDPOINT and VITE_OUO_REPLAY_ENDPOINT in .env.local
  // (the replay URL is derived only when the endpoint uses port 4318).
  endpoint: import.meta.env.VITE_OUO_ENDPOINT || "http://localhost:4318",
  replayEndpoint: import.meta.env.VITE_OUO_REPLAY_ENDPOINT || undefined,
  projectId: "demo",
  projectToken: "pt_dev_demo_0000000000000000", // public by design, ships in the bundle
  service: { name: "tiny-shop-signals-frontend", version: "1.0.0", environment: "local" },
  // Calls to the API get `traceparent` + `baggage`, so its spans join the browser's trace.
  // Use a RegExp: OpenTelemetry compares a string entry with the whole request URL.
  tracing: { propagateTo: [new RegExp(`^${API}/`)] },
  // Web Vitals (FCP, LCP, CLS, INP, TTFB) are on by default: one `web_vital` event each.
  replay: { enabled: true, maskAllInputs: true },
  debug: true,
});
```

</details>

`log.js` gives the app `log.info / warn / error`. A logger taken from `@opentelemetry/api-logs`
sends through the SDK's logger provider: every line gets the session id, the user id and the page,
and goes to Loki. The message is the record's body, so each Loki line reads as a sentence.
Create `frontend/src/log.js`:

<details>
<summary><code>frontend/src/log.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/frontend/src/log.js -->
```js
// Frontend logs: `log.info / log.warn / log.error`, each an OpenTelemetry log record.
// @ouo11y/browser registers the global LoggerProvider, so these records get the session id,
// user id, page and route like the SDK's own events, and go to Loki through the collector.
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

const logger = logs.getLogger("tiny-shop-signals-frontend");

function emit(severityNumber, severityText, body, attributes) {
  logger.emit({ severityNumber, severityText, body, attributes });
}

export const log = {
  info: (message, attrs) => emit(SeverityNumber.INFO, "INFO", message, attrs),
  warn: (message, attrs) => emit(SeverityNumber.WARN, "WARN", message, attrs),
  error: (message, attrs) => emit(SeverityNumber.ERROR, "ERROR", message, attrs),
};
```

</details>

Replace `frontend/src/main.jsx`, so the SDK starts before React renders:

<details>
<summary><code>frontend/src/main.jsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/frontend/src/main.jsx -->
```jsx
// Initialise ouo before React renders anything.
import "./rum";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

</details>

Replace `frontend/src/App.jsx`. It takes `API` from `rum.js` and logs what a person on the support
desk would want to read: catalog loaded, product viewed, added to cart, checkout failed validation
(`warn`), checkout failed (`error`), order placed.

<details>
<summary><code>frontend/src/App.jsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-signals/result/frontend/src/App.jsx -->
```jsx
import { useEffect, useState } from "react";
import { log } from "./log";
import { API } from "./rum";

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`)
      .then((r) => r.json())
      .then((list) => {
        setProducts(list);
        log.info("catalog loaded", { "app.products.count": list.length });
      });
  }, []);

  function view(p) {
    setMessage(`${p.name}: freshly made, $${p.price}`);
    log.info("product viewed", { "product.id": p.id, "product.name": p.name });
  }

  function addToCart(p) {
    setCart([...cart, p]);
    log.info("added to cart", { "product.id": p.id, "app.cart.items": cart.length + 1 });
  }

  async function checkout() {
    // Validation failure: a warning, nothing is sent to the API.
    if (!email.includes("@")) {
      log.warn("checkout failed validation", { "app.validation.field": "email" });
      setMessage("Enter an email address first");
      return;
    }
    const res = await fetch(`${API}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: cart.map((p) => p.id) }),
    });
    if (!res.ok) {
      // The API fails one checkout in three. The SDK already records `http.request.failed`
      // (the session becomes errored); this log says what it meant for the shopper.
      log.error("checkout failed", { "http.response.status_code": res.status, "app.cart.items": cart.length });
      setMessage("Payment failed, try again");
      return;
    }
    const data = await res.json();
    log.info("order placed", { "app.order.id": data.orderId, "app.cart.items": cart.length });
    setMessage(`Order #${data.orderId} placed`);
    setCart([]);
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "40px auto" }}>
      <h1>Tiny Shop</h1>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.name} (${p.price}) <button onClick={() => view(p)}>View</button>{" "}
            <button onClick={() => addToCart(p)}>Add</button>
          </li>
        ))}
      </ul>
      <p>Cart: {cart.length} item(s)</p>
      <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />{" "}
      <button onClick={checkout} disabled={!cart.length}>Checkout</button>
      <p>{message}</p>
    </main>
  );
}
```

</details>

Collector moved to 14318 in step 4c? Create `frontend/.env.local`:

```
VITE_OUO_ENDPOINT=http://localhost:14318
VITE_OUO_REPLAY_ENDPOINT=http://localhost:14319
```

Start Vite, still in `frontend/`:

```bash
npm run dev
```

Open http://localhost:5173 in a normal tab with DevTools open and keep it in front. The Console
prints `[ouo]` lines with the session id. **View** and **Add** a few products, **Checkout** once
with no email, then with an email five or six times. Then switch to another tab: that is when the
browser hands over LCP, CLS and INP.

## Step 7. Read the signals

Wait up to a minute, then in Grafana:

**Frontend logs.** **Explore -> Loki**, code mode:

```logql
{service_name="tiny-shop-signals-frontend"} | scope_name="tiny-shop-signals-frontend"
```

Each line is the message the app logged: `catalog loaded`, `product viewed`, `added to cart`,
`checkout failed validation`, `checkout failed`, `order placed`. `scope_name` keeps only the
app's own logs (the SDK's events have `@ouo11y/browser`). Only the problems: add
`| severity_text=~"WARN|ERROR"`. Open a line for its `session_id`, `product_id` or
`http_response_status_code`.

**Web Vitals.** The SDK's events carry their name as the body (`web_vital`); `line_format` makes
each line say what it measured:

```logql
{service_name="tiny-shop-signals-frontend", event_name="web_vital"} | line_format `{{.ouo_web_vital_name}} {{if eq .ouo_web_vital_name "CLS"}}{{printf "%.3f" (float64 .ouo_web_vital_value)}}{{else}}{{printf "%.0f ms" (float64 .ouo_web_vital_value)}}{{end}} {{.ouo_web_vital_rating}}`
```

Lines like `LCP 176 ms good` and `CLS 0.002 good`. Only TTFB? The tab was hidden or automated while it loaded: reload it
in front.

**Metrics.** **Dashboards -> Tiny Shop -> Tiny Shop API**: requests per second by route and
status, p50 / p95 duration, orders placed and checkouts failed.

**The session.** **More apps -> ouo11y RUM -> Sessions**. Yours is `errored` if a checkout failed;
open it for the timeline (the Web Vitals, "Failed request 500"), the replay, the traces from the
browser's `POST` to the API's `charge card`, and the **Logs** section with the same lines as Loki.

What each signal means, and the healthy / errored / crashed rules, are in the
[README](README.md#see-it-in-grafana).

## Step 8. Clean up

Stop the API and Vite with Ctrl+C. Stop the stack, keeping its data (in the stack's tab, from
`stack/`):

```bash
docker compose down
```

or delete its data too:

```bash
docker compose down -v
```

## When something does not work

| You see | Cause and fix |
|---|---|
| `Bind for 0.0.0.0:4318 failed: port is already allocated` | another stack has the port: step 4c, move this one with `stack/.env` |
| `rum-api` keeps restarting after a pull | a newer `latest` that wants a different config: `docker compose logs rum-api` names the key; pin the tested version (step 4a, "Image versions") |
| `denied` when pulling `ghcr.io/ouo11y/...` | not logged in to ghcr.io, or no read access yet: step 4b |
| the API prints export errors with 401 | the `Authorization` header in `instrumentation.js` is missing or wrong |
| dashboard empty after a minute | the API is not on the collector's port (`OUO_OTLP_ENDPOINT`), or no request was made yet |
| CORS error on the collector in the console | the page is not on `localhost` / `127.0.0.1` (the collector's allowed origins), or a port in `.env.local` is wrong |
| no frontend logs, SDK events fine | two copies of `@opentelemetry/api-logs`: in `frontend/`, `npm ls @opentelemetry/api-logs` must show one version |
| only TTFB among the vitals | the tab was hidden or automated: load it in a foreground tab, then switch tab |
| every session `healthy` | no checkout failed yet; try a few more (one in three fails) |
| nothing in Tempo yet | wait up to a minute: new traces reach search later than trace-by-id |
