# Build Tiny Shop Sessions yourself, from an empty folder

From an empty folder to a shop where you drive the RUM session by hand: log in, switch user, log
out, end the session, let it time out, break it, and watch every step in Grafana. The plain app
comes first with no telemetry, then the stack, then the instrumentation, then the session features,
one step at a time. Each step ends with something you can see. About 45 minutes.

Long files are in collapsible sections: open one, copy it, paste it into the file named in its
title. What the rules mean (when a session starts, what ends it, the defaults, device id, why no IP
linking) is in the [README](README.md); this guide is the hands-on part.

```
tiny-shop-sessions/mine/
├── backend/    Express API, then OpenTelemetry traces
├── frontend/   React app, then @ouo11y/browser and the session panels
└── stack/      the ouo stack, one folder per service
```

Commands have no `$` prompt; each says which folder it runs from.

## Step 0. Check your tools

```bash
node --version
```

Node 24 or later.

```bash
docker compose version
```

Docker Compose 2.24 or later, with Docker running.

You also need this repository checked out. The session features used here are merged but not
released yet, so the browser SDK, rum-api and the Grafana plugin are built from its source (the
README's "Unreleased parts" says what changes after the release).

## Step 1. Create the empty folder

Build in `mine/`, next to `result/`: the stack's compose files point at the repository's sources
with relative paths, which resolve from there. `mine/` is in `.gitignore`.

From `examples/quickstarts/tiny-shop-sessions`:

```bash
mkdir -p mine/backend mine/frontend/src mine/stack && cd mine
```

## Step 2. A plain API, no telemetry yet

From `mine/backend`:

```bash
npm init -y && npm install express cors
```

Create `backend/server.js`:

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
  await sleep(40);
  res.json(products);
});

app.post("/api/checkout", async (req, res) => {
  await sleep(120);
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

// Always fails: the "Failed request" button in step 10.
app.get("/api/broken", (req, res) => {
  res.status(500).json({ error: "this endpoint always fails" });
});

app.listen(5001, () => console.log("tiny-shop-sessions API on http://localhost:5001"));
```

From `mine/backend`:

```bash
node server.js
```

**Check**, in another terminal:

```bash
curl -s http://localhost:5001/api/products
```

prints the three products. Stop the API with Ctrl+C.

## Step 3. A plain React shop, no telemetry yet

From `mine/frontend`:

```bash
npm init -y && npm install react react-dom && npm install -D vite @vitejs/plugin-react
```

You replace the generated `package.json` in step 6.

<details>
<summary><code>frontend/vite.config.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/frontend/vite.config.js -->
```js
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
});
```

</details>

<details>
<summary><code>frontend/index.html</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/frontend/index.html -->
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tiny Shop Sessions</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

</details>

Create `frontend/src/main.jsx` (step 6 adds the SDK to it):

```jsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Create `frontend/src/App.jsx`, the shop alone:

```jsx
import { useEffect, useState } from "react";

const API = "http://localhost:5001";
const box = { border: "1px solid #ccc", borderRadius: 6, padding: "8px 16px", marginBottom: 16 };
const h2 = { fontSize: 18, margin: "8px 0" };

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`)
      .then((r) => r.json())
      .then(setProducts);
  }, []);

  async function checkout() {
    const res = await fetch(`${API}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: cart.map((p) => p.id) }),
    });
    const data = await res.json();
    setMessage(`Order #${data.orderId} placed`);
    setCart([]);
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 640, margin: "32px auto", lineHeight: 1.5 }}>
      <h1>Tiny Shop</h1>
      <section style={box}>
        <h2 style={h2}>Shop</h2>
        <ul>
          {products.map((p) => (
            <li key={p.id}>
              {p.name} (${p.price}) <button onClick={() => setCart([...cart, p])}>Add</button>
            </li>
          ))}
        </ul>
        <p>
          Cart: {cart.length} item(s){" "}
          <button onClick={checkout} disabled={!cart.length}>
            Checkout
          </button>
        </p>
      </section>
      <p>{message}</p>
    </main>
  );
}
```

Start the API again (from `mine/backend`, `node server.js`), then from `mine/frontend`:

```bash
npx vite
```

**Check:** http://localhost:5173 lists three products; **Add** and **Checkout** print an order
number. Stop both with Ctrl+C.

## Step 4. The ouo stack, one service at a time

`stack/compose.yaml` only lists the service folders. Each folder holds that service's compose file
and its config, and each file starts with what the service is for, who sends it data and its ports.

<details>
<summary><code>stack/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/compose.yaml -->
```yaml
# The ouo stack for tiny-shop-sessions: one folder per service, each with its compose file and its
# config. This file only lists them. Start everything from this folder: `docker compose up -d`.
# Grafana http://localhost:3000 (admin / testing567), OTLP http://localhost:4318, replay :4319.
# Ports taken? Export OUO_GRAFANA_PORT, OUO_OTLP_HTTP_PORT, OUO_REPLAY_PORT before `up`.
name: tiny-shop-sessions   # compose project name: containers and the volumes use it
include:
  - 10-collector/compose.yaml   # ingest: the only thing the apps talk to, replay included
  - 20-tempo/compose.yaml       # traces
  - 30-loki/compose.yaml        # browser events: session.start / session.end, errors, failed requests
  - 50-rum-api/compose.yaml     # folds those events into sessions: status, end reason, user, device (built from source)
  - 60-grafana/compose.yaml     # the UI: datasources and the ouo11y RUM app (plugin from source)
```

</details>

From `mine/stack`:

```bash
mkdir -p 10-collector 20-tempo 30-loki 50-rum-api 60-grafana/provisioning/datasources 60-grafana/provisioning/plugins
```

### Ingest: the collector

The only thing the apps talk to. It checks the project credential and routes each signal.

<details>
<summary><code>stack/10-collector/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/10-collector/compose.yaml -->
```yaml
# ouo-collector: the only ingest. The browser SDK and the Node API send OTLP here; it checks the
# project credential and forwards traces to Tempo, logs to Loki and replay chunks to rum-api.
# The browser uploads replay to 4319 only: rum-api is never exposed. Ports: 4318 OTLP/HTTP, 4319 replay (both public), 13133 health (loopback).
services:
  otel-collector:
    image: ghcr.io/ouo11y/collector:0.3.0
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
    depends_on: [tempo, loki, rum-api]
```

</details>

<details>
<summary><code>stack/10-collector/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/10-collector/config.yaml -->
```yaml
# ouo-collector pipelines, a trimmed copy of the full stack's config (no Sentry bridge, no
# rate limits, no metrics). Receivers: OTLP/HTTP on 4318 and replay chunks on 4319, both behind
# the project credential in projects.htpasswd. Exporters: Tempo, Loki and rum-api.

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
  # Replay: the SDK POSTs gzipped rrweb chunks here (X-Ouo-Session-Id, X-Ouo-Seq headers).
  ouoreplay:
    endpoint: 0.0.0.0:4319
    include_metadata: true
    max_request_body_size: 8388608   # 8 MB per chunk; the SDK flushes at 256 KB
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
  # Replay chunks go on, unchanged, to rum-api, which stores them (see 50-rum-api/config.yaml).
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
    logs/replay:
      receivers: [ouoreplay]
      exporters: [ouoreplay]
```

</details>

<details>
<summary><code>stack/10-collector/projects.htpasswd</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/10-collector/projects.htpasswd -->
```text
# Projects allowed to send data: one line per project, project id and SHA hash of its token.
# Read by the collector's basicauth extension. The `demo` token (pt_dev_demo_0000000000000000)
# is public: local use only. Make a line with htpasswd -nbs PROJECT TOKEN. No colon in comments.
demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=
```

</details>

### Traces and events: Tempo and Loki

<details>
<summary><code>stack/20-tempo/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/20-tempo/compose.yaml -->
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

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/20-tempo/config.yaml -->
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

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/30-loki/compose.yaml -->
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

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/30-loki/config.yaml -->
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

### Sessions: rum-api

rum-api reads the `session.start` / `session.end` events in Loki and folds them into one record per
session: status, state, end reason, `user_id` and `device_id`. Its `session:` block is the server's
own timeout, for sessions whose browser never says goodbye (a closed tab).

<details>
<summary><code>stack/50-rum-api/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/50-rum-api/compose.yaml -->
```yaml
# rum-api: the ouo platform service behind the Grafana plugin. It folds the session events in Loki
# into one record per session: status (healthy / errored / crashed), state and end reason, user_id
# and device_id; it also stores the replay chunks the collector forwards. Internal: only the
# collector and Grafana talk to it, on 8080 inside the network.
#
# Built from source: `device_id` on the session record and the `device=` filter are newer than the
# released ghcr.io/ouo11y/rum-api:0.3.0. Once a rum-api release with them is tagged, replace
# `build:` with `image: ghcr.io/ouo11y/rum-api:<that version>` (see the README, "Unreleased parts").
services:
  rum-api:
    build:
      context: ../../../../../../services/rum-api   # this repository's services/rum-api
      args: { VERSION: sessions-from-source }
    image: tiny-shop-sessions/rum-api:from-source
    command: ["-config.file=/etc/rum-api/config.yaml", "-config.expand-env=true"]
    environment:
      GRAFANA_URL: http://localhost:${OUO_GRAFANA_PORT:-3000}   # for deep links
      OUO_INGEST_TOKEN: it_dev_0000000000000000   # the collector's; development value
      OUO_READ_TOKEN: rt_dev_0000000000000000     # Grafana's; development value
      DATA_DIR: /home/nonroot                     # the image runs as nonroot
    volumes:
      - ./config.yaml:/etc/rum-api/config.yaml:ro
      - rum-api-data:/home/nonroot
    depends_on: [loki, tempo]

volumes:
  rum-api-data:
```

</details>

<details>
<summary><code>stack/50-rum-api/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/50-rum-api/config.yaml -->
```yaml
# rum-api configuration: where Loki and Tempo are, and the session timeouts.
# The tokens come from the environment set in compose.yaml (-config.expand-env=true).
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

# The server's own end rules, for sessions whose browser never sent `session.end` (the tab was
# closed, the laptop slept): no signal for `inactivity` means ended (reason inactivity), older than
# `max_duration` means max_duration. They match the SDK defaults (30 min, 4 h). The quickstart's
# "short timeout" switch only changes the SDK: the SDK then sends `session.end` itself, and rum-api
# uses the reason it was given.
session:
  inactivity: 30m
  max_duration: 4h

# Where replay chunks are stored. filesystem: files under DATA_DIR, here the rum-api-data volume
# (<dir>/replays/<session id>/, one chunk per upload, in sequence order). For more
# than one rum-api, or real retention, use backend: s3 with MinIO or any S3 bucket:
#   storage:
#     backend: s3
#     s3: { endpoint: "minio:9000", bucket: ouo-replays, insecure: true, force_path_style: true,
#           access_key_id: ..., secret_access_key: ... }
storage:
  backend: filesystem
```

</details>

### The UI: Grafana and the ouo11y RUM app

<details>
<summary><code>stack/60-grafana/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/60-grafana/compose.yaml -->
```yaml
# Grafana with the ouo11y RUM app plugin: the UI for everything above. It reads Tempo and Loki
# directly, and sessions and replays from rum-api through the plugin. Port 3000,
# admin / testing567. provisioning/ sets up the datasources and the plugin.
#
# Plugin from source: the device id on the session page and the Device filter on the Sessions page
# are newer than the released ghcr.io/ouo11y/grafana:0.3.0. Stock Grafana loads the plugin this
# repository builds (`npm run build -w plugins/ouo11y-rum-app`), mounted from its dist/ folder.
# Once a grafana image with them is tagged, use `image: ghcr.io/ouo11y/grafana:<that version>`
# and drop the plugin volume (see the README, "Unreleased parts").
services:
  grafana:
    image: grafana/grafana:13.2.1
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
      # this repository's plugins/ouo11y-rum-app/dist, built from source
      - ../../../../../../plugins/ouo11y-rum-app/dist:/var/lib/grafana/plugins/ouo11y-rum-app:ro
    depends_on: [loki, tempo, rum-api]
```

</details>

<details>
<summary><code>stack/60-grafana/provisioning/datasources/datasources.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/60-grafana/provisioning/datasources/datasources.yaml -->
```yaml
# Grafana datasources: Loki (browser events), Tempo (traces), both inside the network.
# The uids are fixed because rum-api's config refers to them.
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
    isDefault: true
    jsonData:
      lokiSearch:
        datasourceUid: loki
```

</details>

<details>
<summary><code>stack/60-grafana/provisioning/plugins/ouo11y-rum-app.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/stack/60-grafana/provisioning/plugins/ouo11y-rum-app.yaml -->
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

### Start it

Grafana loads the plugin from the repository's `plugins/ouo11y-rum-app/dist`, so build it first,
together with the browser SDK you need in step 6. From the repository root:

```bash
npm ci && npm run build -w sdk/browser -w plugins/ouo11y-rum-app
```

The collector image is private for now: log in to ghcr.io once with a GitHub token that has
`read:packages`:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

From `mine/stack` (the first run builds rum-api, a few minutes):

```bash
docker compose up -d --build
```

**Check:** `docker compose ps` lists five services running, and http://localhost:3000 opens
Grafana (admin / testing567) with **More apps -> ouo11y RUM** and no sessions yet. Ports taken?
See the README's "Ports" section.

## Step 5. Instrument the API

<details>
<summary><code>backend/package.json</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/backend/package.json -->
```json
{
  "name": "tiny-shop-sessions-backend",
  "private": true,
  "version": "1.0.0",
  "description": "ouo quickstart: Express API with OpenTelemetry traces",
  "type": "commonjs",
  "scripts": {
    "start": "node --require ./instrumentation.js server.js"
  },
  "engines": {
    "node": ">=24"
  },
  "dependencies": {
    "@opentelemetry/api": "^1.10.0",
    "@opentelemetry/baggage-span-processor": "^0.6.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.300.0",
    "@opentelemetry/instrumentation-express": "^0.72.0",
    "@opentelemetry/instrumentation-http": "^0.300.0",
    "@opentelemetry/resources": "^3.0.0",
    "@opentelemetry/sdk-node": "^0.300.0",
    "@opentelemetry/sdk-trace": "^3.0.0",
    "@opentelemetry/semantic-conventions": "^1.43.0",
    "cors": "^2.8.6",
    "express": "^5.3.0"
  }
}
```

</details>

<details>
<summary><code>backend/instrumentation.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/backend/instrumentation.js -->
```js
// OpenTelemetry SDK init: traces to the ouo collector over OTLP/HTTP.
// Loaded before the app with `node --require ./instrumentation.js` so the http and express
// instrumentations can patch those modules before server.js loads them.
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
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

// This API sends traces only. Without these two lines the NodeSDK also starts its default OTLP
// metrics and logs exporters, which post to localhost:4318 without the credential (401).
process.env.OTEL_METRICS_EXPORTER ??= "none";
process.env.OTEL_LOGS_EXPORTER ??= "none";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "tiny-shop-sessions-backend",
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment.name": "local",
  }),
  spanProcessors: [
    // The browser SDK sends `baggage: session.id=...,user.id=...`; copy it onto every span so
    // backend spans can be searched by the RUM session.
    new BaggageSpanProcessor(ALLOW_ALL_BAGGAGE_KEYS),
    new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }) }),
  ],
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
});

sdk.start();
console.log(`[otel] traces to ${endpoint}`);

const shutdown = () => sdk.shutdown().finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

</details>

The final `server.js`: the same routes, plus a manual `checkout` span.

<details>
<summary><code>backend/server.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/backend/server.js -->
```js
// The API: products, a checkout, and an endpoint that always fails for the "break it" panel.
// HTTP server spans come from the auto-instrumentation; the checkout span is manual.
const express = require("express");
const cors = require("cors");
const { trace } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-sessions-backend");

const app = express();
// The browser calls this API from another origin and adds `traceparent` and `baggage` headers
// (the baggage carries session.id and user.id); cors() answers the preflight for them.
app.use(cors());
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const products = [
  { id: 1, name: "Coffee", price: 4 },
  { id: 2, name: "Tea", price: 3 },
  { id: 3, name: "Cake", price: 6 },
];

app.get("/api/products", async (req, res) => {
  await sleep(40);
  res.json(products);
});

app.post("/api/checkout", async (req, res) => {
  const items = req.body.items || [];
  const orderId = await tracer.startActiveSpan("checkout", async (span) => {
    span.setAttribute("app.cart.items", items.length);
    await sleep(120);
    span.end();
    return Math.floor(Math.random() * 100000);
  });
  res.json({ ok: true, orderId });
});

// "Break it" -> "Failed request": always 500. The browser records `http.request.failed`, which
// marks the session errored.
app.get("/api/broken", (req, res) => {
  res.status(500).json({ error: "this endpoint always fails" });
});

const port = Number(process.env.PORT || 5001);
app.listen(port, () => console.log(`tiny-shop-sessions API on http://localhost:${port}`));
```

</details>

From `mine/backend`:

```bash
npm install && npm start
```

**Check:** it prints `[otel] traces to http://localhost:4318`. Run
`curl -s http://localhost:5001/api/products` once, then in Grafana, **Explore -> Tempo -> Search**,
service `tiny-shop-sessions-backend`: a `GET /api/products` trace. Search lags behind ingest by up
to a minute; run the query again if it is empty. Leave the API running.

## Step 6. Instrument the web app

`@ouo11y/browser` 0.2.1 on npm has no `endSession`, `clearUser` or `device.id` yet. Pack the SDK
you built in step 4 into the app's `vendor/` folder. From the repository root:

```bash
mkdir -p examples/quickstarts/tiny-shop-sessions/mine/frontend/vendor
```

```bash
npm pack -w sdk/browser --pack-destination examples/quickstarts/tiny-shop-sessions/mine/frontend/vendor
```

Replace `frontend/package.json`; it installs that file. Once the next release is on npm, use
`"@ouo11y/browser": "<that version>"` instead.

<details>
<summary><code>frontend/package.json</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/frontend/package.json -->
```json
{
  "name": "tiny-shop-sessions-frontend",
  "private": true,
  "version": "1.0.0",
  "description": "ouo quickstart: React shop that teaches the RUM session lifecycle",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "engines": {
    "node": ">=24"
  },
  "dependencies": {
    "@ouo11y/browser": "file:vendor/ouo11y-browser-0.2.1.tgz",
    "react": "^19.3.1",
    "react-dom": "^19.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^6.1.2",
    "vite": "^8.3.4"
  }
}
```

</details>

<details>
<summary><code>frontend/.gitignore</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/frontend/.gitignore -->
```text
# The @ouo11y/browser tarball packed from sdk/browser (see the README, "Unreleased parts").
vendor/
```

</details>

The SDK init. The new part for this quickstart is `session:`: the inactivity timeout and the
maximum duration are init options, read once; the switch you add in step 9 stores its choice in
`localStorage` and reloads the page.

<details>
<summary><code>frontend/src/rum.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/frontend/src/rum.js -->
```js
// ouo browser SDK init. The bite of this quickstart is the session: when it starts, what ends it,
// and how it follows the user (setUser / clearUser) and the browser (device.id).
import { initRUM } from "@ouo11y/browser";

// The API (backend/). Moved it? VITE_API_URL in .env.local.
export const API = import.meta.env.VITE_API_URL || "http://localhost:5001";

// The "Short inactivity timeout" switch on the page stores its choice here and reloads: the
// timeout is an init option, read once.
export const SHORT_TIMEOUT_KEY = "tiny-shop.short-timeout";
export const shortTimeout = localStorage.getItem(SHORT_TIMEOUT_KEY) === "1";

export const rum = initRUM({
  // The ouo collector, the only thing the page talks to. Moved ports? Set VITE_OUO_ENDPOINT and
  // VITE_OUO_REPLAY_ENDPOINT in .env.local.
  endpoint: import.meta.env.VITE_OUO_ENDPOINT || "http://localhost:4318",
  replayEndpoint: import.meta.env.VITE_OUO_REPLAY_ENDPOINT || undefined,
  projectId: "demo",
  projectToken: "pt_dev_demo_0000000000000000", // public by design, ships in the bundle
  service: { name: "tiny-shop-sessions-frontend", version: "1.0.0", environment: "local" },
  // Calls to the API get `traceparent` + `baggage` (session.id, user.id), so its spans join the
  // browser's trace.
  tracing: { propagateTo: [new RegExp(`^${API}/`)] },

  session: {
    // Defaults: 30 min without activity ends the session (`inactivity`), and no session lasts more
    // than 4 h (`max_duration`). The switch shortens inactivity to 1 min so you can watch it.
    inactivityTimeoutMs: shortTimeout ? 60_000 : 30 * 60_000,
    maxDurationMs: 4 * 60 * 60_000,
    sampleRate: 1, // keep every session: this is a demo
  },
  replay: { enabled: true, sampleRate: 1, maskAllInputs: true },
  // `[ouo] session started <id> (previous <id>)` and the other decisions in the console.
  debug: true,
});
```

</details>

Load it before React renders:

<details>
<summary><code>frontend/src/main.jsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/frontend/src/main.jsx -->
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

In `App.jsx`, take the API URL from `rum.js`: replace the line
`const API = "http://localhost:5001";` with

```jsx
import { API } from "./rum";
```

From `mine/frontend`:

```bash
npm install && npm run dev
```

**Check:** reload http://localhost:5173 and click **Add** a few times. The browser console shows
`[ouo] session started <id>` (`session resumed` after a reload). In Grafana, **More apps ->
ouo11y RUM -> Sessions** lists a `healthy` session within a minute, with an anonymous user and a
few traces.

## Step 7. Show the session in the page

The SDK keeps three records in `localStorage`: the session, the user and the device. Reading them
has no side effects. (`rum.session.id()` has one: it starts the next session when the last one
ended, so a panel that polls it would never let a session stay ended.)

<details>
<summary><code>frontend/src/session.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/frontend/src/session.js -->
```js
// What the SDK has stored about the session, the user and the device, read straight from
// localStorage for the "Your session" panel.
//
// Why not rum.session.id()? It starts a new session when the last one has ended: calling it every
// second to refresh the panel would itself be activity. Reading the stored records has no side
// effects, so after "End session" or an inactivity timeout you can see the session marked ended
// until your next click starts the next one.
function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

export function storedSession() {
  // ouo.session: { id, startedAt, lastActivity, previousId?, endedAt?, endReason? }
  // ouo.user:    { id, anonymous }     ouo.device: { id }
  return { session: read("ouo.session"), user: read("ouo.user"), device: read("ouo.device") };
}
```

</details>

<details>
<summary><code>frontend/src/SessionPanel.jsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/frontend/src/SessionPanel.jsx -->
```jsx
// "Your session": what the SDK has stored, refreshed every second. Reads localStorage only (see
// session.js), so watching the panel never counts as activity.
import { useEffect, useState } from "react";
import { shortTimeout } from "./rum";
import { storedSession } from "./session";

export default function SessionPanel() {
  const [stored, setStored] = useState(storedSession());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => {
      setStored(storedSession());
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const { session, user, device } = stored;
  const idleFor = session ? Math.round((now - session.lastActivity) / 1000) : 0;
  const state = session?.endedAt
    ? `ended (${session.endReason}), your next click starts a new one`
    : `active, idle ${idleFor} s`;

  return (
    <section style={box}>
      <h2 style={h2}>Your session</h2>
      <table>
        <tbody>
          <Row k="session.id" v={session?.id} />
          <Row k="state" v={state} />
          <Row k="session.previous_id" v={session?.previousId || "none (first session on this device)"} />
          <Row k="user.id" v={user ? `${user.id}${user.anonymous ? " (anonymous)" : ""}` : ""} />
          <Row k="device.id" v={device?.id} />
          <Row k="inactivity timeout" v={shortTimeout ? "1 min (short)" : "30 min (default)"} />
        </tbody>
      </table>
    </section>
  );
}

function Row({ k, v }) {
  return (
    <tr>
      <td style={{ paddingRight: 16 }}>
        <code>{k}</code>
      </td>
      <td>
        <code>{v}</code>
      </td>
    </tr>
  );
}

export const box = { border: "1px solid #ccc", borderRadius: 6, padding: "8px 16px", marginBottom: 16 };
export const h2 = { fontSize: 18, margin: "8px 0" };
```

</details>

In `App.jsx`, delete the `const box = ...` and `const h2 = ...` lines and add:

```jsx
import SessionPanel, { box, h2 } from "./SessionPanel";
```

and put `<SessionPanel />` right under `<h1>Tiny Shop</h1>`.

**Check:** the **Your session** panel shows a `session.id`, `active, idle 0 s` counting up, an
anonymous `user.id` and a `device.id`. Reload: the same session id (a reload resumes it). Open a
second tab on the same URL: the same id again (tabs of one site share it). Click **Add**: the
idle counter goes back to 0, a click is activity.

## Step 8. Log in, switch user, log out, end the session

<details>
<summary><code>frontend/src/AccountPanel.jsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/frontend/src/AccountPanel.jsx -->
```jsx
// "Account": a fake login with two users, logout, End session and the short-timeout switch.
// Each button is one SDK call; the comments say what it does to the session.
import { useState } from "react";
import { rum, SHORT_TIMEOUT_KEY, shortTimeout } from "./rum";
import { box, h2 } from "./SessionPanel";

// Two fake accounts. A real app calls rum.setUser after its own login succeeds.
const USERS = ["alice@example.com", "bob@example.com"];

export default function AccountPanel({ onMessage }) {
  const [loggedIn, setLoggedIn] = useState(null); // the shop's own idea of who is logged in

  function login(email) {
    // Anonymous -> alice: the same session, now with user.id = alice (a login during the visit).
    // alice -> bob: the session ends with `user_change` and a new one starts, previous_id = alice's.
    rum.setUser({ id: email });
    setLoggedIn(email);
    onMessage(`Logged in as ${email}`);
  }

  function logout() {
    // Back to a fresh anonymous id, in a new session (`user_change`).
    rum.clearUser();
    setLoggedIn(null);
    onMessage("Logged out");
  }

  function endSession() {
    // `manual`: the session ends now; the next click, request or navigation starts the next one.
    rum.endSession();
    onMessage("Session ended. Click anything to start the next one.");
  }

  function toggleShortTimeout() {
    localStorage.setItem(SHORT_TIMEOUT_KEY, shortTimeout ? "0" : "1");
    location.reload(); // the timeout is an init option
  }

  return (
    <section style={box}>
      <h2 style={h2}>Account</h2>
      <p style={{ color: "#666", margin: "4px 0" }}>{loggedIn ? `Logged in as ${loggedIn}` : "Not logged in"}</p>
      {USERS.map((u) => (
        <button key={u} onClick={() => login(u)} disabled={loggedIn === u}>
          {loggedIn ? `Switch to ${u}` : `Log in as ${u}`}
        </button>
      ))}{" "}
      <button onClick={logout} disabled={!loggedIn}>
        Log out
      </button>{" "}
      <button onClick={endSession}>End session</button>
      <p>
        <label>
          <input type="checkbox" checked={shortTimeout} onChange={toggleShortTimeout} /> Short inactivity timeout
          (1 min, reloads the page)
        </label>
      </p>
    </section>
  );
}
```

</details>

In `App.jsx`, add

```jsx
import AccountPanel from "./AccountPanel";
```

and put `<AccountPanel onMessage={setMessage} />` under `<SessionPanel />`.

**Check**, watching the panel after each click:

| Click | `session.id` | `session.previous_id` | `user.id` |
|---|---|---|---|
| **Log in as alice** | unchanged | unchanged | alice: a login keeps the session |
| **Switch to bob** | new | alice's session | bob: `user_change` |
| **Log out** | new | bob's session | a new anonymous id: `user_change` |
| **End session** | unchanged, state `ended (manual)` | | |
| then **Add** | new | the ended one | unchanged |

`device.id` never changes. The console shows each decision as `[ouo] ...` (`debug: true` in
`rum.js`).

## Step 9. Watch an inactivity timeout

Nothing to write: the switch is in `AccountPanel.jsx`. Tick **Short inactivity timeout** (the page
reloads; the panel says `1 min (short)`), then touch nothing, with the tab in front.

**Check:** after a minute the state reads `ended (inactivity), your next click starts a new one`.
Click **Add**: a new session whose `session.previous_id` is the timed-out one. Untick the switch
to go back to 30 minutes.

"Next click" is really "next activity or signal": anything the SDK sends starts the next session,
a `long_animation_frame` event included. A tab in the background, whose timers the browser
throttles, can produce those by itself.

Closing the tab ends nothing at once: the session just stops getting activity, and rum-api ends
it on its own after 30 minutes without signals.

## Step 10. Break it

<details>
<summary><code>frontend/src/BreakItPanel.jsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/frontend/src/BreakItPanel.jsx -->
```jsx
// "Break it": one button per way a session goes bad. errored = something failed and the user
// carried on; crashed = an uncaught error. Neither ends the session on the web.
import { API, rum } from "./rum";
import { box, h2 } from "./SessionPanel";

export default function BreakItPanel({ onMessage }) {
  function handledError() {
    // Caught and reported: the session becomes `errored`.
    try {
      JSON.parse("{ not json");
    } catch (err) {
      rum.captureError(err, { "app.action": "parse saved cart" });
      onMessage("Handled error reported: session is now errored");
    }
  }

  function uncaughtError() {
    // Thrown and never caught: the SDK's `error` listener reports it as fatal and the session
    // becomes `crashed`. On the web the page keeps working and the session does not end.
    setTimeout(() => {
      throw new Error("Uncaught: cart total is NaN");
    });
    onMessage("Uncaught error thrown: session is now crashed");
  }

  async function failedRequest() {
    // A 500 from the API: the SDK records `http.request.failed`, the session becomes `errored`.
    const res = await fetch(`${API}/api/broken`);
    onMessage(`GET /api/broken answered ${res.status}: session is now errored`);
  }

  return (
    <section style={box}>
      <h2 style={h2}>Break it</h2>
      <button onClick={handledError}>Handled error</button> <button onClick={uncaughtError}>Uncaught error</button>{" "}
      <button onClick={failedRequest}>Failed request</button>
    </section>
  );
}
```

</details>

Now replace `App.jsx` with the final one: the three panels above the shop.

<details>
<summary><code>frontend/src/App.jsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-sessions/result/frontend/src/App.jsx -->
```jsx
// The shop, with the three session panels above it.
import { useEffect, useState } from "react";
import AccountPanel from "./AccountPanel";
import BreakItPanel from "./BreakItPanel";
import { API } from "./rum";
import SessionPanel, { box, h2 } from "./SessionPanel";

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`)
      .then((r) => r.json())
      .then(setProducts);
  }, []);

  async function checkout() {
    const res = await fetch(`${API}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: cart.map((p) => p.id) }),
    });
    const data = await res.json();
    setMessage(`Order #${data.orderId} placed`);
    setCart([]);
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 640, margin: "32px auto", lineHeight: 1.5 }}>
      <h1>Tiny Shop</h1>
      <SessionPanel />
      <AccountPanel onMessage={setMessage} />
      <BreakItPanel onMessage={setMessage} />
      <section style={box}>
        <h2 style={h2}>Shop</h2>
        <ul>
          {products.map((p) => (
            <li key={p.id}>
              {p.name} (${p.price}) <button onClick={() => setCart([...cart, p])}>Add</button>
            </li>
          ))}
        </ul>
        <p>
          Cart: {cart.length} item(s){" "}
          <button onClick={checkout} disabled={!cart.length}>
            Checkout
          </button>
        </p>
      </section>
      <p>{message}</p>
    </main>
  );
}
```

</details>

**Check:** the page shows four boxes: Your session, Account, Break it, Shop. **Uncaught error**
prints the error in the console, yet the page keeps working and the session id stays the same: on
the web an uncaught error marks the session, it does not end it.

## Step 11. See it in Grafana

Run this sequence once, so there is one session of each kind: **Add** and **Failed request**;
**Log in as alice**; **Switch to bob** and **Handled error**; **Log out** and **Uncaught error**;
**End session** and **Add**.

http://localhost:3000, admin / testing567, **More apps -> ouo11y RUM**. Allow a minute.

**Check:**

- **Overview**: 2 errored and 1 crashed sessions from this sequence; every other session (from
  steps 6 to 9) is healthy.
- **Sessions**: alice's session `errored` (the failed request), bob's `errored` (the handled
  error), the anonymous one after the logout `crashed`.
- Open bob's: `ended · user_change`, **User** bob, **Previous session** links to alice's,
  **Device** is the `device.id` from the panel. Click the device: every session of this browser.
- The same from rum-api:

```bash
curl -s -u admin:testing567 "http://localhost:3000/api/plugin-proxy/ouo11y-rum-app/rum/v1/sessions?from=now-1h&to=now"
```

Each session has `end_reason` (`user_change`, `manual`, `inactivity`, or null while active),
`status`, `user_id` and the same `device_id`.

Your `mine/` now holds the same files as `result/`.

## Step 12. Clean up

From `mine/stack`: `docker compose down -v`, then stop the API and the web app with Ctrl+C.
Delete `mine/` when you are done.

## When something does not work

| Symptom | Why, and the fix |
|---|---|
| `npm install` in `frontend` fails on `vendor/ouo11y-browser-0.2.1.tgz` | the SDK was not packed: run step 6's two commands from the repository root |
| `docker compose up` cannot build rum-api, or Grafana has no ouo11y RUM app | `mine/` is not at `examples/quickstarts/tiny-shop-sessions/mine` (the paths are relative), or the plugin was not built (step 4) |
| The collector does not start: `denied` pulling the image | log in to ghcr.io (step 4) |
| Tempo search finds no trace yet | search lags behind ingest by up to a minute: run it again |
| No sessions in the plugin | wait a minute; `docker compose logs otel-collector`; the page must be on `localhost` or `127.0.0.1` |
| The panel never shows `ended` after End session | something calls `rum.session.id()` on a timer: it starts the next session; read `localStorage` as `session.js` does |
| A new session started while you waited for the timeout | a signal, not a click, started it: a background tab can emit `long_animation_frame` events; keep it in front |
| Clearing site data does not give a new session | the SDK writes the session back when the page unloads: close the tab first, or use a private window |
| A session ended `inactivity` with the switch off | it was idle 30 minutes, or the tab was closed and rum-api inferred the end |
