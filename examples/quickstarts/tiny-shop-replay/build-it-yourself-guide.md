# Build Tiny Shop Replay yourself, from scratch

This guide builds the [Tiny Shop Replay](README.md) quickstart by hand, one step at a time, from
an empty folder:

1. a plain Express API and a plain React shop, working with no telemetry at all, with a button
   that does nothing, a slow button and a checkout that can fail;
2. the ouo stack (collector, Tempo, Loki, rum-api, Grafana), one small folder per service;
3. the API instrumented with the OpenTelemetry Node SDK, its traces in Grafana;
4. the shop instrumented with `@ouo11y/browser` and **session replay**: sampling, masking,
   rage and dead clicks, then from a replay moment to its trace and its backend error.

At the end your folder is the same as [`result/`](result) next to this guide: compare with it
when you are stuck. About 30 minutes.

```
tiny-shop-replay/
├── stack/      the ouo stack, one folder per service
├── backend/    Express API, OpenTelemetry traces
└── frontend/   React shop, @ouo11y/browser with session replay
```

Every command goes in its own block: run them one by one, in order. Paths are relative to
`tiny-shop-replay/`, wherever you create it, and each command says which of its folders it runs
in. When a step says "replace the file", select everything in it and paste the new content over it.

## Step 0. Check your tools

Node 24 or newer:

```bash
node -v
```

Docker Desktop must be running, with Compose 2.24 or later:

```bash
docker compose version
```

## Step 1. Create the folders

From the folder where you keep your projects:

```bash
mkdir -p tiny-shop-replay/backend tiny-shop-replay/frontend/src tiny-shop-replay/stack
```

```bash
cd tiny-shop-replay
```

Open the folder in your editor. You will use three terminal tabs: backend, frontend, stack. Each
new tab opens in `tiny-shop-replay/`.

## Step 2. A plain API, no telemetry yet

In the first terminal tab, from `tiny-shop-replay/`:

```bash
cd backend
```

Create `backend/package.json`:

```json
{
  "name": "tiny-shop-replay-backend",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "cors": "^2.8.6",
    "express": "^5.3.0"
  }
}
```

| Package | What it does here |
|---|---|
| `express` | the HTTP server and its routes |
| `cors` | answers the browser's preflight: the shop on 5173 calls the API on 5001, and from step 6 it adds `traceparent` and `baggage` headers |

Create `backend/server.js`. Besides the products, it has a route that takes 3 seconds (for a
button people will click again and again) and a checkout that declines any card ending in
`0002` with a 500:

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
  await sleep(50 + Math.random() * 100);
  res.json(products);
});

app.get("/api/orders/track", async (req, res) => {
  await sleep(3000);
  res.json({ status: "Your order is on its way" });
});

app.post("/api/checkout", async (req, res) => {
  await sleep(150);
  if (String(req.body.cardLast4 || "") === "0002") return res.status(500).json({ error: "card declined" });
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

const port = Number(process.env.PORT || 5001);
app.listen(port, () => console.log(`tiny-shop-replay API on http://localhost:${port}`));
```

```bash
npm install
```

```bash
npm start
```

In the third terminal tab:

```bash
curl -s -X POST localhost:5001/api/checkout -H 'content-type: application/json' -d '{"items":[1],"cardLast4":"0002"}'
```

You see `{"error":"card declined"}`. Leave the API running.

## Step 3. A plain React shop, no telemetry yet

In the second terminal tab, from `tiny-shop-replay/`:

```bash
cd frontend
```

Create `frontend/package.json`:

```json
{
  "name": "tiny-shop-replay-frontend",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.3.1",
    "react-dom": "^19.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^6.1.2",
    "vite": "^8.3.4"
  }
}
```

| Package | What it does here |
|---|---|
| `react`, `react-dom` | the shop's UI |
| `vite` | the dev server on 5173 and the build |
| `@vitejs/plugin-react` | lets Vite compile JSX |

These two files do not change again:

<details>
<summary><code>frontend/vite.config.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/frontend/vite.config.js -->
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

<!-- embed: examples/quickstarts/tiny-shop-replay/result/frontend/index.html -->
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tiny Shop Replay</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

</details>

Create `frontend/src/main.jsx`:

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

Create `frontend/src/App.jsx`: a partner banner, the products, **Apply coupon** (its handler is
empty on purpose), **Track my order** (calls the 3 s route, shows nothing while it waits), a
checkout form with a password and a card number, and a shipping line:

```jsx
import { useEffect, useState } from "react";

const API = "http://localhost:5001";

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [card, setCard] = useState({ name: "", email: "", password: "", number: "" });
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`).then((r) => r.json()).then(setProducts);
  }, []);

  const field = (key) => (e) => setCard({ ...card, [key]: e.target.value });

  function applyCoupon() {}

  async function trackOrder() {
    const res = await fetch(`${API}/api/orders/track`);
    setMessage((await res.json()).status);
  }

  async function checkout(e) {
    e.preventDefault();
    const res = await fetch(`${API}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: cart.map((p) => p.id), cardLast4: card.number.slice(-4) }),
    });
    if (!res.ok) {
      setMessage("Payment failed, try another card");
      return;
    }
    const data = await res.json();
    setMessage(`Order #${data.orderId} placed`);
    setCart([]);
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "40px auto" }}>
      <h1>Tiny Shop</h1>
      <aside style={{ background: "#fde68a", padding: 8 }}>
        Partner offer for customer #48213: 20% off with code PARTNER20
      </aside>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.name} (${p.price}) <button onClick={() => setCart([...cart, p])}>Add</button>
          </li>
        ))}
      </ul>
      <p>
        Cart: {cart.length} item(s) <button onClick={applyCoupon}>Apply coupon</button>{" "}
        <button onClick={trackOrder}>Track my order</button>
      </p>
      <form onSubmit={checkout} style={{ display: "grid", gap: 6 }}>
        <input placeholder="name on card" value={card.name} onChange={field("name")} />
        <input placeholder="email" value={card.email} onChange={field("email")} />
        <input type="password" placeholder="account password" value={card.password} onChange={field("password")} />
        <input placeholder="card number" autoComplete="cc-number" value={card.number} onChange={field("number")} />
        <button disabled={!cart.length}>Checkout</button>
      </form>
      <p>
        Shipping to <span>{card.name || "Jane Doe, 12 Baker Street"}</span>
      </p>
      <p>{message}</p>
    </main>
  );
}
```

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. You see the yellow banner and three products. **Add** a coffee;
**Apply coupon** does nothing; **Track my order** answers after 3 s; card `4000000000000002`
gives "Payment failed", card `4242424242424242` places an order. The shop works, and nothing is
recorded yet.

## Step 4. The ouo stack, one service at a time

In the third terminal tab, from `tiny-shop-replay/`:

```bash
cd stack
```

### 4a. The list of services

`compose.yaml` only lists the service folders and names the compose project, so the replay
volume is `tiny-shop-replay_rum-api-data` (step 8 reads it).

<details>
<summary><code>stack/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/compose.yaml -->
```yaml
# The ouo stack for tiny-shop-replay: one folder per service, each with its compose file and its
# config. This file only lists them. Start everything from this folder: `docker compose up -d`.
# Grafana http://localhost:3000 (admin / testing567), OTLP http://localhost:4318, replay :4319.
# Ports taken? Export OUO_GRAFANA_PORT, OUO_OTLP_HTTP_PORT, OUO_REPLAY_PORT before `up`.
name: tiny-shop-replay   # compose project name: containers and the rum-api-data volume use it
include:
  - 10-collector/compose.yaml   # ingest: the only thing the apps talk to, replay included
  - 20-tempo/compose.yaml       # traces
  - 30-loki/compose.yaml        # browser events (clicks, rage and dead clicks, errors)
  - 50-rum-api/compose.yaml     # sessions, and where replay chunks are stored
  - 60-grafana/compose.yaml     # the UI: datasources and the ouo11y RUM app
```

</details>

### 4b. The collector: the only thing the apps talk to

It takes OTLP on 4318 and replay chunks on 4319 (the `ouoreplay` receiver), both behind the
project credential, and forwards traces to Tempo, events to Loki and replay chunks unchanged to
rum-api. The page never talks to rum-api.

```bash
mkdir -p 10-collector
```

<details>
<summary><code>stack/10-collector/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/10-collector/compose.yaml -->
```yaml
# ouo-collector: the only ingest. The browser SDK and the Node API send OTLP here; it checks the
# project credential and forwards traces to Tempo, logs to Loki and replay chunks to rum-api.
# The browser uploads replay to 4319 only: rum-api is never exposed.
# Ports: 4318 OTLP/HTTP, 4319 replay (both public), 13133 health (loopback).
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
    depends_on: [tempo, loki]
```

</details>

<details>
<summary><code>stack/10-collector/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/10-collector/config.yaml -->
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

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/10-collector/projects.htpasswd -->
```text
# Projects allowed to send data: one line per project, project id and SHA hash of its token.
# Read by the collector's basicauth extension. The `demo` token (pt_dev_demo_0000000000000000)
# is public: local use only. Make a line with htpasswd -nbs PROJECT TOKEN. No colon in comments.
demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=
```

</details>

### 4c. Tempo and Loki: traces and browser events

Rage and dead clicks are browser events, so they land in Loki.

```bash
mkdir -p 20-tempo 30-loki
```

<details>
<summary><code>stack/20-tempo/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/20-tempo/compose.yaml -->
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

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/20-tempo/config.yaml -->
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

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/30-loki/compose.yaml -->
```yaml
# Loki: stores logs. The collector sends it the browser's events (clicks, errors) over OTLP
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

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/30-loki/config.yaml -->
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

### 4d. rum-api: sessions, and where replay is stored

The `storage` block: `filesystem` writes each chunk to `replays/<session id>/` on the
`rum-api-data` volume; the comment shows the `s3` settings for MinIO or any S3 bucket.

```bash
mkdir -p 50-rum-api
```

<details>
<summary><code>stack/50-rum-api/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/50-rum-api/compose.yaml -->
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

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/50-rum-api/config.yaml -->
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

### 4e. Grafana and the ouo11y RUM app

```bash
mkdir -p 60-grafana/provisioning/datasources 60-grafana/provisioning/plugins
```

<details>
<summary><code>stack/60-grafana/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/60-grafana/compose.yaml -->
```yaml
# Grafana with the ouo11y RUM app plugin: the UI for everything above. It reads Tempo and Loki
# directly, and sessions and replays from rum-api through the plugin. Port 3000, admin / testing567.
# provisioning/ sets up the datasources and the plugin.
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
    depends_on: [loki, tempo, rum-api]
```

</details>

<details>
<summary><code>stack/60-grafana/provisioning/datasources/datasources.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/60-grafana/provisioning/datasources/datasources.yaml -->
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

<!-- embed: examples/quickstarts/tiny-shop-replay/result/stack/60-grafana/provisioning/plugins/ouo11y-rum-app.yaml -->
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

### 4f. Start it

The ouo images are private for now: log in to ghcr.io once with a GitHub token that has
`read:packages`.

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

**Image versions.** The three ouo images use the `latest` tag, which follows every release. The
comment above each `image:` line says which version this guide was tested with and its digest:
pin `ghcr.io/ouo11y/rum-api:0.5.0`, or the `@sha256:...` digest, to keep the stack on one version.
The configs above are written for the tested versions; a much newer image may refuse a config key,
and `docker compose logs <service>` names it.

**Check the ports.** The stack publishes 3000 (Grafana) and the collector's 4318 (OTLP) and 4319
(replay) to your network, and 3100, 3200 and 13133 on loopback only. This prints nothing when
they are all free:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|3100|3200|4318|4319|13133) '
```

If something is listed, do not stop it: move this stack instead. Create `stack/.env` with the
ports that are taken, for example:

```
OUO_GRAFANA_PORT=13000
OUO_OTLP_HTTP_PORT=14318
OUO_REPLAY_PORT=14319
```

Compose reads `.env` on its own. The others are `OUO_LOKI_PORT`, `OUO_TEMPO_PORT` and
`OUO_COLLECTOR_HEALTH_PORT`. Remember the new collector ports: steps 5 and 6 say where they go.
Then, from `stack/`:

```bash
docker compose up -d
```

```bash
docker compose ps
```

Five services are up, rum-api `(healthy)`. Open http://localhost:3000 (admin / testing567),
then More apps -> ouo11y RUM -> Sessions: no sessions yet.

## Step 5. Instrument the API

In the backend tab, stop the API with Ctrl+C.

### 5a. The SDK packages and the start script

Replace `backend/package.json` with the version below: the OpenTelemetry packages, and a
`start` script that loads `instrumentation.js` before the app.

<details>
<summary><code>backend/package.json</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/backend/package.json -->
```json
{
  "name": "tiny-shop-replay-backend",
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

```bash
npm install
```

| Package | What it does here |
|---|---|
| `@opentelemetry/api` | what your code calls: `trace`, `SpanStatusCode` in `server.js` |
| `@opentelemetry/sdk-node` | `NodeSDK`: starts the tracer provider, the instrumentations and the context manager in one call |
| `@opentelemetry/sdk-trace` | `BatchSpanProcessor`, which sends spans in batches (OpenTelemetry JS 3.0 merged `sdk-trace-base` and `sdk-trace-node` into it) |
| `@opentelemetry/exporter-trace-otlp-http` | sends spans to the collector over OTLP/HTTP, with the project credential |
| `@opentelemetry/instrumentation-http`, `instrumentation-express` | a server span for every request, named after its Express route |
| `@opentelemetry/baggage-span-processor` | copies the browser's `baggage` (`session.id`, `user.id`) onto every span, so the API's spans belong to the RUM session |
| `@opentelemetry/resources`, `semantic-conventions` | the resource (`service.name`, `service.version`) and the standard attribute names |

<details>
<summary>Which OpenTelemetry Node package is which? (click to open)</summary>

As of OpenTelemetry JS 3.0:

| Package | Status | What it is |
|---|---|---|
| `@opentelemetry/sdk-trace` | current | The tracer provider and span processors, for Node and the browser. |
| `@opentelemetry/sdk-trace-base`, `sdk-trace-node` | deprecated (last versions 2.x) | The 2.x split of the same thing; `sdk-trace` replaces both. |
| `@opentelemetry/sdk-node` | current, 0.x | One-call setup. Its 0.300 line goes with the 3.0 packages. |
| `@opentelemetry/auto-instrumentations-node` | current, contrib | Every Node instrumentation at once. This guide picks only `http` and `express`, to keep the install small and the spans readable. |

</details>

### 5b. Initialise the SDK

Create `backend/instrumentation.js`: traces to the collector with the project credential, and
the browser's `baggage` (the RUM session id) copied onto every span.

<details>
<summary><code>backend/instrumentation.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/backend/instrumentation.js -->
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

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "tiny-shop-replay-backend",
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

### 5c. Manual spans and an error span

Replace `backend/server.js`: the checkout now runs in a `checkout` span with a `charge card`
child that records the exception when the card is declined.

<details>
<summary><code>backend/server.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/backend/server.js -->
```js
// The API. HTTP server spans come from the auto-instrumentation; the spans below are manual.
const express = require("express");
const cors = require("cors");
const { trace, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-replay-backend");

const app = express();
// The browser calls this API from another origin and adds `traceparent` and `baggage`
// headers; cors() answers the preflight for them.
app.use(cors());
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const products = [
  { id: 1, name: "Coffee", price: 4 },
  { id: 2, name: "Tea", price: 3 },
  { id: 3, name: "Cake", price: 6 },
];

app.get("/api/products", async (req, res) => {
  await sleep(50 + Math.random() * 100);
  res.json(products);
});

// The slow button: 3 s with no feedback in the page, enough to make people click again.
app.get("/api/orders/track", async (req, res) => {
  await sleep(3000);
  res.json({ status: "Your order is on its way" });
});

app.post("/api/checkout", async (req, res) => {
  const items = req.body.items || [];
  // The failing path, on demand: a card ending in 0002 is declined (a common test card), so you
  // know which checkout to look for in the replay. Any other card succeeds.
  const declined = String(req.body.cardLast4 || "") === "0002";
  await tracer.startActiveSpan("checkout", async (span) => {
    span.setAttribute("app.cart.items", items.length);
    await tracer.startActiveSpan("charge card", async (child) => {
      await sleep(120);
      if (declined) {
        const err = new Error("card declined by payment provider");
        child.recordException(err);
        child.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      }
      child.end();
    });
    if (declined) span.setStatus({ code: SpanStatusCode.ERROR, message: "card declined" });
    span.end();
  });
  if (declined) return res.status(500).json({ error: "card declined" });
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

const port = Number(process.env.PORT || 5001);
app.listen(port, () => console.log(`tiny-shop-replay API on http://localhost:${port}`));
```

</details>

```bash
npm start
```

It prints `[otel] traces to http://localhost:4318`. Collector on 14318 (step 4f)? Stop it and
start it with `OUO_OTLP_ENDPOINT=http://localhost:14318 npm start` instead.

Run the curl from step 2 again, then, after a minute or two (Tempo indexes new traces for search
in the background), in Grafana, Explore -> Tempo -> TraceQL:

```
{ name = "charge card" && status = error }
```

The trace has `POST /api/checkout`, `checkout` and a red `charge card` with an `exception`
event.

## Step 6. Instrument the shop, with session replay

In the frontend tab, stop Vite with Ctrl+C.

### 6a. Add the SDK

Replace `frontend/package.json`: the only new line is `@ouo11y/browser`, pinned.

<details>
<summary><code>frontend/package.json</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/frontend/package.json -->
```json
{
  "name": "tiny-shop-replay-frontend",
  "private": true,
  "version": "1.0.0",
  "description": "ouo quickstart: React app with @ouo11y/browser session replay, masking, rage and dead clicks",
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
    "@ouo11y/browser": "0.3.0",
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

```bash
npm install
```

| Package | What it does here |
|---|---|
| `@ouo11y/browser` 0.3.0 | the ouo browser SDK: sessions, errors, fetch spans with `traceparent` to the API, rage and dead clicks, and session replay (rrweb) with sampling and masking |

<details>
<summary>What <code>@ouo11y/browser</code> brings with it (click to open)</summary>

You install one package; npm adds its dependencies. The ones worth knowing:

| Package | What the SDK uses it for |
|---|---|
| `rrweb` | records the DOM for the replay; loaded only when replay is on and the session is sampled |
| `web-vitals` | LCP, INP, CLS, FCP and TTFB |
| `@opentelemetry/sdk-trace-web`, `sdk-logs`, `instrumentation-fetch`, `instrumentation-xml-http-request`, `instrumentation-document-load` | spans and log records in the OpenTelemetry 2.x line |

`sdk-trace-web`, `instrumentation-fetch` and `instrumentation-xml-http-request` are deprecated
upstream in favour of OpenTelemetry JS 3.0 and `@opentelemetry/browser-instrumentation`. They
still work, and your code never imports them; moving the SDK to the 3.0 line is tracked for
`@ouo11y/browser`. [Tiny Shop with OpenTelemetry](../tiny-shop-otel/build-it-yourself-guide.md)
shows the 3.0 packages used by hand.

</details>

### 6b. Initialise it, with replay and its sampling

Create `frontend/src/rum.js`. Sampling is decided once per session from its id and kept:
`session.sampleRate` first (an unsampled session sends nothing), then `replay.sampleRate`
(recorded from the first page), then `replay.onErrorSampleRate` for the rest (the last 30 to
60 s kept in memory and uploaded only when an error happens). Everything is 1 here so every
session has a replay. `maskAllInputs` and the click options are written out with their defaults.

<details>
<summary><code>frontend/src/rum.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/frontend/src/rum.js -->
```js
// ouo browser SDK init: sessions, errors, fetch tracing, and session replay with its sampling,
// masking and click signals.
import { initRUM } from "@ouo11y/browser";

// The API (backend/). Moved it? VITE_API_URL in .env.local.
export const API = import.meta.env.VITE_API_URL || "http://localhost:5001";

export const rum = initRUM({
  // The ouo collector, the only thing the page talks to. Spans and events go to 4318, replay
  // chunks to 4319 (derived from `endpoint` when it uses port 4318). Moved ports? Set
  // VITE_OUO_ENDPOINT and VITE_OUO_REPLAY_ENDPOINT in .env.local.
  endpoint: import.meta.env.VITE_OUO_ENDPOINT || "http://localhost:4318",
  replayEndpoint: import.meta.env.VITE_OUO_REPLAY_ENDPOINT || undefined,
  projectId: "demo",
  projectToken: "pt_dev_demo_0000000000000000", // public by design, ships in the bundle
  service: { name: "tiny-shop-replay-frontend", version: "1.0.0", environment: "local" },
  // Calls to the API get `traceparent` + `baggage`, so its spans join the browser's trace and the
  // replay, the click and the backend error share one trace id.
  tracing: { propagateTo: [new RegExp(`^${API}/`)] },

  // Session sampling comes first: a session that is not sampled sends nothing, replay included.
  session: { sampleRate: 1 },

  // New in this example: session replay (rrweb).
  replay: {
    enabled: true,
    // Of the sampled sessions, the share recorded from the first page. 1 here so every session of
    // the quickstart has a replay; 0.1 is a common production start.
    sampleRate: 1,
    // Of the sessions NOT picked by sampleRate, the share that keeps the last 30 to 60 s in memory
    // and uploads it (and the rest of the session) after the first error. Only matters when
    // sampleRate < 1: try sampleRate 0 and onErrorSampleRate 1 to see replays of errors only.
    onErrorSampleRate: 1,
    // Every <input> value is replaced by asterisks in the replay: email, password, card number.
    // Default true. For finer control leave it on and use the classes below on other elements.
    maskAllInputs: true,
  },
  // Rage clicks (3 clicks within 1 s in one spot) and dead clicks (a button click after which
  // nothing changed and nothing was requested) are on by default; the defaults, spelled out:
  clicks: { rageClicks: { threshold: 3, windowMs: 1000, radiusPx: 30 }, deadClicks: true },
  debug: true,
});
```

</details>

### 6c. Load it before React

Replace `frontend/src/main.jsx`: only the first two lines are new.

<details>
<summary><code>frontend/src/main.jsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/frontend/src/main.jsx -->
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

### 6d. Masking and errors in the app

Replace `frontend/src/App.jsx`. Compared with step 3:

- `API` and `rum` come from `./rum`;
- the banner gets `className="ouo-block"`: rrweb does not record it at all;
- the shipping name gets `className="ouo-mask"`: recorded as asterisks;
- the inputs need nothing: `maskAllInputs` masks them, and `type="password"` is always masked;
- a failed checkout calls `rum.captureError`, so the error is on the session timeline.

<details>
<summary><code>frontend/src/App.jsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts/tiny-shop-replay/result/frontend/src/App.jsx -->
```jsx
import { useEffect, useState } from "react";
import { API, rum } from "./rum";

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [card, setCard] = useState({ name: "", email: "", password: "", number: "" });
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`).then((r) => r.json()).then(setProducts);
  }, []);

  const field = (key) => (e) => setCard({ ...card, [key]: e.target.value });

  // Dead click on purpose: the handler does nothing, so no DOM change and no request follow.
  function applyCoupon() {}

  // Slow on purpose: the API takes 3 s and the button shows nothing meanwhile, so people click
  // again and again. Three clicks within a second make a rage click.
  async function trackOrder() {
    const res = await fetch(`${API}/api/orders/track`);
    setMessage((await res.json()).status);
  }

  async function checkout(e) {
    e.preventDefault();
    // Only the last four digits leave the browser; the card number itself is masked in the replay.
    const res = await fetch(`${API}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: cart.map((p) => p.id), cardLast4: card.number.slice(-4) }),
    });
    if (!res.ok) {
      // The SDK already records `http.request.failed` (the session becomes errored); captureError
      // adds an exception with a stack, on the same trace, so the replay links to it.
      rum.captureError(new Error(`checkout failed: ${(await res.json()).error}`));
      setMessage("Payment failed, try another card");
      return;
    }
    const data = await res.json();
    setMessage(`Order #${data.orderId} placed`);
    setCart([]);
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "40px auto" }}>
      <h1>Tiny Shop</h1>

      {/* ouo-block: the element is not recorded at all; the replay shows an empty box its size. */}
      <aside className="ouo-block" style={{ background: "#fde68a", padding: 8 }}>
        Partner offer for customer #48213: 20% off with code PARTNER20
      </aside>

      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.name} (${p.price}) <button onClick={() => setCart([...cart, p])}>Add</button>
          </li>
        ))}
      </ul>
      <p>
        Cart: {cart.length} item(s) <button onClick={applyCoupon}>Apply coupon</button>{" "}
        <button onClick={trackOrder}>Track my order</button>
      </p>

      {/* Inputs: masked because of maskAllInputs. type="password" is masked by rrweb in any case. */}
      <form onSubmit={checkout} style={{ display: "grid", gap: 6 }}>
        <input placeholder="name on card" value={card.name} onChange={field("name")} />
        <input placeholder="email" value={card.email} onChange={field("email")} />
        <input type="password" placeholder="account password" value={card.password} onChange={field("password")} />
        <input placeholder="card number" autoComplete="cc-number" value={card.number} onChange={field("number")} />
        <button disabled={!cart.length}>Checkout</button>
      </form>

      {/* ouo-mask: text that is not an input is recorded as asterisks of the same length. */}
      <p>
        Shipping to <span className="ouo-mask">{card.name || "Jane Doe, 12 Baker Street"}</span>
      </p>
      <p>{message}</p>
    </main>
  );
}
```

</details>

Moved the collector's ports in step 4f? Create `frontend/.env.local` with them before you start
Vite, for example:

```
VITE_OUO_ENDPOINT=http://localhost:14318
VITE_OUO_REPLAY_ENDPOINT=http://localhost:14319
```

```bash
npm run dev
```

Reload http://localhost:5173. In the browser's developer tools, Network tab, a `POST` to
`localhost:4319/v1/replay/chunks` (answer `202`) appears every few seconds while you move around: replay chunks.

## Step 7. Shop like a frustrated customer, then watch it

1. **Add** a coffee.
2. Click **Apply coupon** once.
3. Click **Track my order** four times quickly.
4. Fill the form with made-up values and card `4000000000000002`; click **Checkout**.
5. Change the card to `4242424242424242` and check out.

In Grafana, More apps -> ouo11y RUM -> Sessions, your session is `errored` (allow a few seconds).
Open it. The **Replay** panel plays what you did, and the timeline lists `ouo.dead_click` (Apply
coupon), `ouo.rage_click` (Track my order, `ouo_click_count=4`), "Failed request 500" and "Error:
checkout failed: card declined".

## Step 8. Prove the masking

In the replay the four inputs show asterisks, the banner's place is empty, and the shipping line
reads `Shipping to **** ***`. Then check what was stored:

```bash
docker run --rm -v tiny-shop-replay_rum-api-data:/d alpine sh -c 'zcat /d/replays/*/*.json.gz' | grep -c -e 4000000000000002 -e PARTNER20
```

It prints `0`: neither the card number nor the blocked banner left the browser.

## Step 9. From the replay moment to its trace and its error

1. On the timeline click **Error: checkout failed: card declined**: the replay seeks to the
   Checkout click.
2. Under **Traces**, the `click` trace starting at that second has status **error**: click
   **Open in Explore**.
3. The trace holds the browser's `click` and `POST` and the API's `POST /api/checkout`,
   `checkout` and the red `charge card` with "card declined by payment provider". The
   `traceparent` header the SDK added to the fetch is what joins them.

## Step 10. What it cost

```bash
docker run --rm -v tiny-shop-replay_rum-api-data:/d alpine sh -c 'cat /d/replays/*/meta.json'
```

`chunk_count` and `bytes` (gzipped): a few chunks and a few KB for this session. The README's
[Where replay goes and what it costs](README.md#where-replay-goes-and-what-it-costs) explains
bytes, CPU and how sampling cuts both.

## Step 11. Clean up

In the stack tab (the volume holds the replays):

```bash
docker compose down -v
```

Then Ctrl+C in the backend and frontend tabs.

## When something does not work

| Symptom | Cause |
|---|---|
| `docker compose up` says `denied` | not logged in to ghcr.io, or the token lacks `read:packages` |
| `port is already allocated` | another stack uses the port: step 4f, move this one with `stack/.env` |
| a service keeps restarting after a pull | a newer `latest` that wants a different config: `docker compose logs <service>` names the key; pin the tested version (step 4f, "Image versions") |
| `EADDRINUSE` on 5001, or the shop shows another app's data | another API holds 5001: `PORT=5002 npm start`, and `VITE_API_URL=http://localhost:5002` in `frontend/.env.local` |
| TraceQL finds nothing right after step 5 | Tempo's search index lags a minute or two; open the trace by id, or wait |
| the API prints export errors with 401 | the `Authorization` header in `instrumentation.js` is missing or wrong |
| no trace in Tempo after step 5 | the API was started with `node server.js` instead of `npm start` (no `--require`) |
| session listed, Replay panel empty | no requests to `:4319`: the collector's replay port is not published, or you moved 4318 without setting `VITE_OUO_REPLAY_ENDPOINT` |
| no `ouo.dead_click` | the click caused a request or a DOM change; `applyCoupon` must stay empty |
| no `ouo.rage_click` | fewer than 3 clicks within 1 s in one spot |
| the error is on the timeline but no "Failed request" | the API answered 4xx; only 5xx counts |
| `grep -c` prints more than 0 | an input lost `maskAllInputs`, or the banner lost `ouo-block` |
