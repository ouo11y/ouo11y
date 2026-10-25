# Build Tiny Shop with OpenTelemetry and rrweb, without the ouo SDK

This guide is for teams that want ouo's sessions, errors, traces and replays but do not want
`@ouo11y/browser` in their web app. You instrument the browser yourself with the OpenTelemetry JS
SDK, [rrweb](https://github.com/rrweb-io/rrweb) and Google's
[web-vitals](https://github.com/GoogleChrome/web-vitals), and send the data to the ouo collector
in the shape ouo reads. Nothing in the browser is ouo code.

You build, one step at a time, with no scripts:

1. a plain Express API and a plain React page, with no telemetry at all;
2. the ouo stack (Grafana, Loki, Tempo, Mimir, the ouo collector) from one compose file;
3. the backend traced with the OpenTelemetry Node SDK (the same as in [Tiny Shop](../tiny-shop/build-it-yourself-guide.md));
4. the browser, by hand: OpenTelemetry spans and logs, a session id, the RUM events ouo
   understands, and rrweb replay in chunks.

At the end your files are the same as [`result/backend/`](result/backend) and
[`result/frontend/`](result/frontend): compare with them when you are stuck. Plan on about 45
minutes.

Every command goes in its own block: run them one by one, in order. When a step says
"replace the file", select everything in it and paste the new content over it.

## What ouo needs from a browser

This is the whole contract. The SDK does exactly this; here you do it yourself, and each line
links to the step that builds it.

| What | How | Step |
|---|---|---|
| **Where** | OTLP/HTTP to the collector (`:4318/v1/traces`, `:4318/v1/logs`), every request with `Authorization: Basic base64("<project id>:<project token>")` | [6a](#6a-send-spans-to-ouo) |
| **Who** | resource attributes `service.name`, `service.version`, `deployment.environment.name`, `ouo.platform = "web"` | [6a](#6a-send-spans-to-ouo) |
| **Which session** | `session.id` and `user.id` on **every** span and log record (attributes, not resource: the session can change while the page lives), and in the `baggage` header to your API | [6a](#6a-send-spans-to-ouo) |
| **What happened** | OTLP log records whose `event.name` is `session.start`, `session.end`, `exception`, `http.request.failed`, `navigation` or `web_vital`, with the attributes in [the session spec](../../../docs/specs/session-lifecycle.md#session-events-otel-log-records); any other name is a custom event | [6b](#6b-send-the-rum-events) |
| **Replay** | rrweb events in chunks `{ session_id, seq, started_at, ended_at, events }`, `POST` to the collector's replay port (`:4319/v1/replay/chunks`) with the same credential and `x-ouo-session-id`, `x-ouo-seq` headers | [6c](#6c-record-the-replay) |

From these, ouo builds the session (healthy, errored or crashed), its timeline, its traces and its
replay. A session whose events carry `ouo.exception.fatal = true` is `crashed`; one with a non-fatal
exception or an `http.request.failed` is `errored`.

## Step 0. Check your tools

Node 24 or newer:

```bash
node -v
```

Docker Desktop must be running. This prints the server details, not "Cannot connect":

```bash
docker info
```

VS Code's `code` command. If it is not found, open VS Code, press Cmd+Shift+P and run
**Shell Command: Install 'code' command in PATH**.

```bash
code --version
```

## Step 1. Create the folders and open VS Code

```bash
mkdir -p ~/Desktop/tiny-shop-otel/backend ~/Desktop/tiny-shop-otel/frontend ~/Desktop/tiny-shop-otel/stack
```

```bash
cd ~/Desktop/tiny-shop-otel
```

```bash
code .
```

In VS Code, open a terminal with Ctrl+\`. You will use three terminal tabs (the `+` button):
one for the backend, one for the frontend, one for the stack.

## Step 2. A simple API, no telemetry yet

In the first terminal tab:

```bash
cd ~/Desktop/tiny-shop-otel/backend
```

```bash
npm init -y
```

```bash
npm install express cors
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
  await sleep(80);
  res.json(products);
});

app.post("/api/checkout", async (req, res) => {
  await sleep(150);
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

app.get("/api/fail", (req, res) => {
  res.status(500).json({ error: "inventory service unavailable" });
});

app.listen(5001, () => console.log("tiny-shop API on http://localhost:5001"));
```

Run it:

```bash
node server.js
```

In another terminal tab, check that it answers:

```bash
curl localhost:5001/api/products
```

You get the three products as JSON. Leave the API running.

## Step 3. A dummy React UI

In the second terminal tab:

```bash
cd ~/Desktop/tiny-shop-otel
```

```bash
npm create vite@latest frontend -- --template react --no-interactive
```

```bash
cd frontend
```

```bash
npm install
```

Replace `frontend/src/App.jsx` with:

```jsx
import { useEffect, useState } from "react";

const API = "http://localhost:5001";

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`).then((r) => r.json()).then(setProducts);
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

  async function callBrokenApi() {
    const res = await fetch(`${API}/api/fail`);
    setMessage(`API answered ${res.status}`);
  }

  function crash() {
    throw new Error("Button exploded");
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "40px auto" }}>
      <h1>Tiny Shop</h1>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.name} (${p.price}) <button onClick={() => setCart([...cart, p])}>Add</button>
          </li>
        ))}
      </ul>
      <p>Cart: {cart.length} item(s)</p>
      <button onClick={checkout} disabled={!cart.length}>Checkout</button>{" "}
      <button onClick={callBrokenApi}>Call broken API</button>{" "}
      <button onClick={crash}>Throw error</button>
      <p>{message}</p>
    </main>
  );
}
```

Start it:

```bash
npm run dev
```

Open http://localhost:5173. You see the three products (the page reached your API). Click
**Add**, then **Checkout**: "Order #… placed". The app works, and nothing is instrumented yet.

## Step 4. Run the ouo stack from one file

### 4a. Create the compose file

The whole stack is one file: Grafana, Loki, Tempo, Mimir, rum-api and the ouo collector, with
their configuration inline. Open the block below, copy all of it, and paste it into a new file
`stack/compose.yaml` in VS Code. (It is the same file as
[`deploy/compose/quickstart.yaml`](../../../deploy/compose/quickstart.yaml).)

<details>
<summary><code>stack/compose.yaml</code> (click to open)</summary>

<!-- embed: deploy/compose/quickstart.yaml -->
```yaml
# ouo quickstart: the whole local stack in one file, as released: collector 0.3.0, rum-api 0.3.0, grafana 0.3.0 (commit 5939e41663b1).
# GENERATED by deploy/scripts/gen-quickstart.sh from deploy/compose at that release; do not
# edit by hand.
#
# Copy this file into an empty folder as compose.yaml, then:
#
#   echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin   # images are private for now
#   docker compose up -d
#
# Grafana          http://localhost:3000      admin / testing567, More apps -> ouo11y RUM
# OTLP/HTTP        http://localhost:4318      /v1/traces /v1/logs /v1/metrics
# Replay           http://localhost:4319      /v1/replay/chunks
# Credential       HTTP Basic, project id `demo`, project token `pt_dev_demo_0000000000000000`
#                  (Authorization: Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw)
#
# Ports collide? Set OUO_GRAFANA_PORT, OUO_OTLP_HTTP_PORT, OUO_REPLAY_PORT, ... in a .env
# file next to this one (names and defaults: deploy/compose/.env.example in the repo). An SDK
# then needs both URLs, e.g. endpoint :14318 and replayEndpoint :14319.
# Stop: `docker compose down`; wipe the data too: `docker compose down -v`.
#
# Development tokens only (they are public): fine on a laptop, never on a reachable host.
# A server install is deploy/vm/install.sh. Needs Docker Compose >= 2.24 (`configs.content`).
#
# No `name:` on purpose: the project is named after the folder, so two copies of this file in
# two folders are two separate stacks (a fixed name would make `down -v` in one remove the other).

services:
  grafana:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/grafana:${OUO_GRAFANA_VERSION:-0.3.0}
    ports:
      - "${OUO_GRAFANA_PORT:-3000}:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: ${OUO_GRAFANA_ADMIN_PASSWORD:-testing567}
      GF_AUTH_ANONYMOUS_ENABLED: "false"
      GF_USERS_DEFAULT_THEME: dark
      GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS: ouo11y-rum-app
      GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS: ouo11y-rum-app
      # Read by the plugin provisioning file; must equal rum-api's OUO_READ_TOKEN.
      OUO_READ_TOKEN: ${OUO_READ_TOKEN:-rt_dev_0000000000000000}
    configs:
      - source: grafana-datasources
        target: /etc/grafana/provisioning/datasources/datasources.yaml
      - source: grafana-plugin-app
        target: /etc/grafana/provisioning/plugins/ouo11y-rum-app.yaml
    volumes:
      - grafana-data:/var/lib/grafana
    depends_on:
      grafana-plugin:
        condition: service_completed_successfully
      loki:
        condition: service_started
      tempo:
        condition: service_started
      mimir:
        condition: service_started
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health >/dev/null 2>&1 || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 30

  # The grafana-data volume hides the plugin the image ships in /var/lib/grafana/plugins;
  # copy it onto the volume before every start so an image upgrade also upgrades the plugin.
  grafana-plugin:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/grafana:${OUO_GRAFANA_VERSION:-0.3.0}
    entrypoint: ["sh", "-ec"]
    command:
      - |
        mkdir -p /pvc/plugins
        rm -rf /pvc/plugins/ouo11y-rum-app
        cp -a /var/lib/grafana/plugins/ouo11y-rum-app /pvc/plugins/ouo11y-rum-app
        echo "ouo11y-rum-app $$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /pvc/plugins/ouo11y-rum-app/plugin.json | head -1) installed"
    volumes:
      - grafana-data:/pvc
    restart: "no"

  loki:
    image: grafana/loki:3.7.7
    command: ["-config.file=/etc/loki/config.yaml"]
    ports:
      - "${OUO_LOKI_PORT:-3100}:3100"
    configs:
      - source: loki
        target: /etc/loki/config.yaml
    volumes:
      - loki-data:/loki

  tempo:
    image: grafana/tempo:3.0.3
    command: ["-config.file=/etc/tempo/config.yaml"]
    ports:
      - "${OUO_TEMPO_PORT:-3200}:3200"
    configs:
      - source: tempo
        target: /etc/tempo/config.yaml
    volumes:
      - tempo-data:/var/tempo

  mimir:
    image: grafana/mimir:3.2.1
    command: ["-config.file=/etc/mimir/config.yaml"]
    ports:
      - "${OUO_MIMIR_PORT:-9009}:9009"
    configs:
      - source: mimir
        target: /etc/mimir/config.yaml
    volumes:
      - mimir-data:/data

  # The only ingest (ADR-0007): OTLP on 4318 and replay chunks on 4319, both behind HTTP
  # Basic project credentials checked against the projects-htpasswd config below.
  otel-collector:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/collector:${OUO_COLLECTOR_VERSION:-0.3.0}
    command: ["--config=/etc/otelcol/config.yaml"]
    ports:
      - "127.0.0.1:${OUO_OTLP_GRPC_PORT:-4317}:4317"
      - "${OUO_OTLP_HTTP_PORT:-4318}:4318"
      - "${OUO_REPLAY_PORT:-4319}:4319"
      - "${OUO_SENTRY_PORT:-4320}:4320"
      - "127.0.0.1:${OUO_COLLECTOR_HEALTH_PORT:-13133}:13133"
    environment:
      OUO_INGEST_TOKEN: ${OUO_INGEST_TOKEN:-it_dev_0000000000000000}
      OUO_ALLOWED_ORIGINS: ${OUO_ALLOWED_ORIGINS:-http://localhost:*,http://127.0.0.1:*}
      OUO_RATELIMIT_CLIENT_KEY: ${OUO_RATELIMIT_CLIENT_KEY:-address}
      OUO_SENTRY_UPSTREAM: ${OUO_SENTRY_UPSTREAM:-none}
      OUO_SENTRY_PROJECT_ID: ${OUO_SENTRY_PROJECT_ID:-1}
      OUO_SENTRY_PUBLIC_KEY: ${OUO_SENTRY_PUBLIC_KEY:-publickey0000000000000000000000}
      OUO_SENTRY_SERVICE_NAME: ${OUO_SENTRY_SERVICE_NAME:-sentry-demo}
    configs:
      - source: collector
        target: /etc/otelcol/config.yaml
      - source: projects-htpasswd
        target: /etc/otelcol/projects.htpasswd
    depends_on:
      - loki
      - tempo
      - mimir

  # Internal: replay chunk sink and the plugin's API. SDKs never talk to it.
  rum-api:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/rum-api:${OUO_RUM_API_VERSION:-0.3.0}
    command: ["-config.file=/etc/rum-api/config.yaml", "-config.expand-env=true"]
    ports:
      - "${OUO_RUM_API_PORT:-8080}:8080"
    environment:
      GRAFANA_URL: http://localhost:${OUO_GRAFANA_PORT:-3000}
      OUO_INGEST_TOKEN: ${OUO_INGEST_TOKEN:-it_dev_0000000000000000}
      OUO_READ_TOKEN: ${OUO_READ_TOKEN:-rt_dev_0000000000000000}
      # The image runs as nonroot. A named volume mounted on the existing nonroot home is
      # seeded with that owner; one mounted on /data would be root-owned and unwritable.
      DATA_DIR: /home/nonroot
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_EXPORTER_OTLP_HEADERS: ${OUO_BACKEND_OTLP_HEADERS:-Authorization=Basic%20ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw}
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_SERVICE_NAME: rum-api
      OTEL_RESOURCE_ATTRIBUTES: deployment.environment.name=local
    configs:
      - source: rum-api
        target: /etc/rum-api/config.yaml
    volumes:
      - rum-api-data:/home/nonroot
    depends_on:
      - loki
      - tempo
      - otel-collector

volumes:
  grafana-data:
  loki-data:
  tempo-data:
  mimir-data:
  rum-api-data:

configs:
  collector:
    # deploy/compose/collector/config.yaml
    content: |
      # ouo-collector configuration for the local stack (ADR-0007: the collector is the edge).
      #
      # Image: ouo/collector, built from collector/ (collector/builder.yaml). Compose mounts this
      # file and projects.htpasswd into /etc/otelcol/. Ports:
      #   4318 OTLP/HTTP  public  Basic auth (project id : project token), CORS
      #   4319 replay     public  Basic auth, CORS, POST /v1/replay/chunks
      #   4320 Sentry     public  Sentry SDK envelopes (ADR-0008), Sentry DSN key auth, forwarded to Sentry
      #   4317 OTLP/gRPC  loopback in compose, same Basic auth (send the Authorization metadata)
      #   13133 health    loopback
      #   8888 self-metrics (Prometheus pull, not published; they are also pushed to Mimir)
      #
      # Environment:
      #   OUO_INGEST_TOKEN     bearer the ouoreplay exporter sends to rum-api (must equal rum-api's)
      #   OUO_ALLOWED_ORIGINS  optional comma-separated CORS origin list, no spaces
      #                        (default http://localhost:*,http://127.0.0.1:*)
      #   OUO_RATELIMIT_CLIENT_KEY  address (default) or x_forwarded_for behind a reverse proxy
      #   OUO_SENTRY_UPSTREAM  Sentry ingest base URL the bridge forwards to (https://oNNN.ingest.sentry.io),
      #                        or "none" to answer locally (default none: no data leaves the laptop)
      #   OUO_SENTRY_PROJECT_ID, OUO_SENTRY_PUBLIC_KEY  the DSN's project id and public key
      #
      # Every receiver uses include_metadata: true so the resource processor and ouoratelimit
      # can read the authenticated project (auth.username) and request headers from the
      # client context. Anything that drops that context (batch) must come after them.

      extensions:
        health_check:
          endpoint: 0.0.0.0:13133
        basicauth/server:
          htpasswd:
            file: /etc/otelcol/projects.htpasswd

      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: 0.0.0.0:4317
              include_metadata: true
              auth:
                authenticator: basicauth/server
            http:
              # 0.0.0.0 inside the container; exposure is decided by the compose port binding.
              endpoint: 0.0.0.0:4318
              include_metadata: true
              max_request_body_size: 4194304   # 4 MiB, applied to the compressed and the decompressed body
              auth:
                authenticator: basicauth/server
              cors:
                allowed_origins: $${env:OUO_ALLOWED_ORIGINS:-http://localhost:*,http://127.0.0.1:*}
                allowed_headers: [Authorization, Content-Type, Content-Encoding, traceparent, baggage]
                exposed_headers: [Retry-After]
                max_age: 7200
        ouoreplay:
          endpoint: 0.0.0.0:4319
          include_metadata: true
          max_request_body_size: 8388608       # 8 MiB: frames chunks (rrweb chunks stop at max_rrweb_chunk_bytes, 4 MiB)
          auth:
            authenticator: basicauth/server
          cors:
            allowed_origins: $${env:OUO_ALLOWED_ORIGINS:-http://localhost:*,http://127.0.0.1:*}
            allowed_headers: [Authorization, Content-Type, Content-Encoding, X-Ouo-Session-Id, X-Ouo-Seq]
            exposed_headers: [Retry-After]
            max_age: 7200
        # Sentry SDK bridge (ADR-0008, docs/specs/sentry-bridge.md): apps change only their DSN host.
        # Every envelope is forwarded byte for byte to the project's upstream Sentry and Sentry's
        # answer goes back unchanged; accepted envelopes are translated into sessions, errors,
        # traces (logs/traces pipelines) and video replay chunks (routed to logs/replay).
        ouosentry:
          endpoint: 0.0.0.0:4320
          upstream_timeout: 30s
          projects:
            - sentry_project_id: "$${env:OUO_SENTRY_PROJECT_ID:-1}"
              public_keys: ["$${env:OUO_SENTRY_PUBLIC_KEY:-publickey0000000000000000000000}"]
              upstream: $${env:OUO_SENTRY_UPSTREAM:-none}
              ouo_project_id: demo
              service_name: $${env:OUO_SENTRY_SERVICE_NAME:-sentry-demo}

      connectors:
        # The Sentry bridge emits replay chunks on its logs output; send them to the replay
        # pipeline (ouoreplay exporter -> rum-api) and everything else to Loki.
        routing/sentry:
          default_pipelines: [logs]
          table:
            - context: log
              condition: log.attributes["ouo.replay.chunk"] == true
              pipelines: [logs/replay]

      processors:
        memory_limiter:
          check_interval: 1s
          limit_mib: 512
          spike_limit_mib: 128
        # Token buckets per project (auth.username) and per client; over the limit the OTLP
        # receiver answers 429 + Retry-After (gRPC RESOURCE_EXHAUSTED + RetryInfo). All
        # pipelines share one set of buckets. Behind a reverse proxy (deploy/vm sets
        # OUO_RATELIMIT_CLIENT_KEY=x_forwarded_for) the TCP peer is the proxy, so key the
        # client bucket on the first X-Forwarded-For hop instead of the address.
        ouoratelimit:
          project:
            rate: 1000
            burst: 5000
          client:
            rate: 100
            burst: 300
            key_from: $${env:OUO_RATELIMIT_CLIENT_KEY:-address}
          idle_timeout: 10m
        # Stamp the authenticated project on every resource, overwriting whatever the client
        # sent (delete first so a request without auth context can never keep a spoofed value).
        resource/project:
          attributes:
            - key: ouo.project.id
              action: delete
            - key: ouo.project.id
              from_context: auth.username
              action: upsert
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
        # Replay chunks -> rum-api's internal sink (POST /v1/replay/chunks with
        # X-Ouo-Project-Id, X-Ouo-Session-Id, X-Ouo-Seq and the ingest bearer).
        ouoreplay:
          endpoint: http://rum-api:8080
          ingest_token: $${env:OUO_INGEST_TOKEN}
          timeout: 30s
          sending_queue:
            enabled: true
            queue_size: 1000
          retry_on_failure:
            enabled: true
            max_elapsed_time: 5m
        debug:
          verbosity: basic

      service:
        extensions: [health_check, basicauth/server]
        telemetry:
          logs:
            level: info
          # Self-metrics (otelcol_receiver_*, otelcol_exporter_*, ouo_ratelimit_rejected_total,
          # ouo_replay_chunks_total): pushed to Mimir over OTLP every 15 s, and pullable on :8888
          # inside the network for debugging.
          metrics:
            level: normal
            readers:
              - periodic:
                  interval: 15000
                  exporter:
                    otlp:
                      protocol: http/protobuf
                      endpoint: http://mimir:9009/otlp/v1/metrics
              - pull:
                  exporter:
                    prometheus:
                      host: 0.0.0.0
                      port: 8888
        pipelines:
          traces:
            receivers: [otlp, ouosentry]
            processors: [memory_limiter, ouoratelimit, resource/project, batch]
            exporters: [otlp_grpc/tempo]
          logs:
            receivers: [otlp, routing/sentry]
            processors: [memory_limiter, ouoratelimit, resource/project, transform/events, batch]
            exporters: [otlp_http/loki]
          metrics:
            receivers: [otlp]
            processors: [memory_limiter, ouoratelimit, resource/project, batch]
            exporters: [otlp_http/mimir]
          # Replay chunks: one log record per chunk, project stamped by the receiver. No batch:
          # the receiver waits for the queue hand-off and answers 202, 429 or 503 per chunk.
          logs/replay:
            receivers: [ouoreplay, routing/sentry]
            processors: [memory_limiter, ouoratelimit]
            exporters: [ouoreplay]
          # Sentry bridge output before routing; the project is in the client context
          # (auth.username), so resource/project and ouoratelimit work downstream.
          logs/sentry:
            receivers: [ouosentry]
            processors: [memory_limiter]
            exporters: [routing/sentry]
  projects-htpasswd:
    # deploy/compose/collector/projects.htpasswd
    content: |
      # Development project registry for ouo-collector (basicauth extension, ADR-0007).
      # LOCAL USE ONLY. The demo token is public in this repository; never deploy this file.
      # One line per project. username = project id, password = project token, {SHA} hash.
      # Generate a line with   htpasswd -nbs PROJECT TOKEN
      # Comment lines in this file must never contain a colon character (see project/kb/collector-components.md).
      demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=
  loki:
    # deploy/compose/loki/config.yaml
    content: |
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
  tempo:
    # deploy/compose/tempo/config.yaml
    content: |
      # Tempo 3.x single binary, local storage, OTLP receiver, metrics generator -> Mimir.
      # Only keys that exist in 3.0.x are used; see project/kb/collector-lgtm.md.
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
  mimir:
    # deploy/compose/mimir/config.yaml
    content: |
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
  rum-api:
    # deploy/compose/rum-api/config.yaml
    content: |
      # rum-api configuration for the local stack, mounted at /etc/rum-api/config.yaml and
      # started with -config.file=/etc/rum-api/config.yaml -config.expand-env=true (like Loki
      # and Tempo). Every key and its environment override: services/rum-api/config.example.yaml.
      # Environment variables set in compose.yaml win over this file (GRAFANA_URL does, so the
      # deep links follow OUO_GRAFANA_PORT and deploy/vm/compose.tls.yaml's public domain).

      server:
        http_listen_address: ":8080"

      # Secrets come from the container environment (compose.yaml), never from this file.
      auth:
        ingest_token: "$${OUO_INGEST_TOKEN}"
        read_token: "$${OUO_READ_TOKEN}"

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
        # filesystem: deploy/data/rum-api/replays on the host (bind mount, like Loki and Tempo
        # keep their local filesystem storage). compose.s3.yaml switches this to s3
        # (STORAGE_BACKEND=s3) against the MinIO below.
        backend: filesystem
        filesystem:
          dir: /data
        s3:
          endpoint: minio:9000
          bucket: $${OUO_RUM_API_S3_BUCKET:-ouo-replays}
          region: us-east-1
          access_key_id: "$${S3_ACCESS_KEY_ID}"
          secret_access_key: "$${S3_SECRET_ACCESS_KEY}"
          insecure: true          # plain HTTP inside the compose network
          force_path_style: true  # MinIO
  grafana-datasources:
    # deploy/compose/grafana/provisioning/datasources/datasources.yaml
    content: |
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
                url: "$$$${__value.raw}"
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
              # `$${__span.tags[...]}` resolves both span attributes (session.id) and resource
              # attributes (service.name): Grafana merges process tags into __span.tags and the
              # field path goes through lodash `property`, so bracket keys with dots work.
              # session.id is structured metadata in Loki, so it is a `|` filter, never a
              # stream selector. `$$$$` escapes the provisioner's own $${ENV} expansion.
              tags:
                - key: service.name
                  value: service_name
              query: '{service_name="$$$${__span.tags["service.name"]}"} | session_id="$$$${__span.tags["session.id"]}"'

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
  grafana-plugin-app:
    # deploy/compose/grafana/provisioning/plugins/ouo11y-rum-app.yaml
    content: |
      # Enables the ouo11y RUM app plugin (plugins/ouo11y-rum-app, loaded unsigned from
      # /var/lib/grafana/plugins/ouo11y-rum-app) and points its "rum" route at the
      # in-network rum-api. The browser never talks to rum-api directly: the plugin
      # calls /api/plugin-proxy/ouo11y-rum-app/rum/v1/... and Grafana forwards to rumApiUrl,
      # adding `Authorization: Bearer <readToken>` from secureJsonData (ADR-0007 section 6).
      #
      # $${OUO_READ_TOKEN} is expanded by the Grafana provisioner from the container's
      # environment (compose passes it through; default rt_dev_0000000000000000, a
      # development value). It must equal rum-api's OUO_READ_TOKEN. Secure fields are
      # write-only: the settings API reports `secureJsonFields: {readToken: true}`.
      apiVersion: 1

      apps:
        - type: ouo11y-rum-app
          org_id: 1
          disabled: false
          jsonData:
            rumApiUrl: http://rum-api:8080
          secureJsonData:
            readToken: $${OUO_READ_TOKEN}
```

</details>

### 4b. Log in to ghcr.io

The ouo images are private for now. You need read access to the `ouo11y` packages and a
**classic** GitHub token with only the `read:packages` scope. Put the token in your shell
(`export GHCR_TOKEN=...`), never in a file, then:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <your-github-user> --password-stdin
```

### 4c. Check the ports

The stack publishes 3000 (Grafana), 3100, 3200, 9009, 8080, and the collector's 4318
(OTLP), 4319 (replay) and 4320. This prints nothing when they are all free:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|3100|3200|4318|4319|4320|8080|9009) '
```

If something is listed, do not stop it: move this stack instead. Create `stack/.env`:

```bash
code ~/Desktop/tiny-shop-otel/stack/.env
```

with:

```
OUO_OTLP_HTTP_PORT=14318
OUO_REPLAY_PORT=14319
OUO_SENTRY_PORT=14320
OUO_OTLP_GRPC_PORT=14317
OUO_COLLECTOR_HEALTH_PORT=14133
```

Compose reads `.env` on its own. Remember the new collector ports: steps 5 and 6 tell you
where they go. Another port listed (3000, 8080, ...)? Its variable is `OUO_GRAFANA_PORT`,
`OUO_RUM_API_PORT`, ... (all of them: the `${OUO_..._PORT:-...}` lines in `compose.yaml`).

### 4d. Start it

```bash
cd ~/Desktop/tiny-shop-otel/stack
```

```bash
docker compose up -d
```

```bash
docker compose ps -a
```

`grafana` and `rum-api` become `healthy`; `loki`, `tempo`, `mimir` and `otel-collector` are
`Up`; `grafana-plugin` is `Exited (0)`, which is right: it only copies the ouo plugin into
Grafana and stops.

Open http://localhost:3000 and log in with **admin / testing567**. **More apps -> ouo11y
RUM** is there and still empty.

## Step 5. Instrument the backend

The backend is the same as in Tiny Shop: the OpenTelemetry Node SDK has never needed the ouo SDK.
Stop the API with Ctrl+C in its terminal tab, then:

```bash
cd ~/Desktop/tiny-shop-otel/backend
```

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation-http @opentelemetry/instrumentation-express @opentelemetry/baggage-span-processor @opentelemetry/resources @opentelemetry/semantic-conventions
```

Create `backend/instrumentation.js`:

<!-- embed: examples/quickstarts/tiny-shop-otel/result/backend/instrumentation.js -->
```js
// OpenTelemetry SDK init. Loaded before the app with `node --require ./instrumentation.js`
// so the http and express instrumentations can patch those modules before server.js loads them.
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
const exporter = new OTLPTraceExporter({
  url: `${endpoint}/v1/traces`,
  headers: { Authorization: "Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw" },
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "tiny-shop-otel-backend",
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment.name": "local",
  }),
  spanProcessors: [
    // The browser sends `baggage: session.id=...,user.id=...`; copy it onto every span so
    // backend spans can be searched by the RUM session.
    new BaggageSpanProcessor(ALLOW_ALL_BAGGAGE_KEYS),
    // OTel JS 3.0: options object, `{ exporter }` (2.x took the exporter itself).
    new BatchSpanProcessor({ exporter }),
  ],
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
});

sdk.start();
console.log(`[otel] tracing to ${endpoint}/v1/traces`);

const shutdown = () => sdk.shutdown().finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

Replace `backend/server.js` with:

<!-- embed: examples/quickstarts/tiny-shop-otel/result/backend/server.js -->
```js
// The API. HTTP server spans come from the auto-instrumentation; the spans below are manual.
const express = require("express");
const cors = require("cors");
const { trace, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-otel-backend");
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
  // A parent span with two nested children.
  await tracer.startActiveSpan("checkout", async (span) => {
    span.setAttribute("app.cart.items", items.length);
    await tracer.startActiveSpan("validate cart", async (child) => {
      await sleep(30);
      child.end();
    });
    await tracer.startActiveSpan("charge card", async (child) => {
      await sleep(120);
      child.addEvent("payment accepted");
      child.end();
    });
    span.end();
  });
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

app.get("/api/fail", (req, res) => {
  // Enrich the auto-created HTTP span with the error.
  const span = trace.getActiveSpan();
  const err = new Error("inventory service unavailable");
  span?.recordException(err);
  span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT || 5001);
app.listen(port, () => console.log(`tiny-shop API on http://localhost:${port}`));
```

The SDK has to load **before** Express so the instrumentation can patch it. Save that as the
start script, then start the API:

```bash
npm pkg set scripts.start="node --require ./instrumentation.js server.js"
```

```bash
npm start
```

It prints `[otel] tracing to http://localhost:4318/v1/traces`. Collector on 14318 (step 4c)?
Stop it and start it with `OUO_OTLP_ENDPOINT=http://localhost:14318 npm start` instead.

The line that matters for this guide is `BaggageSpanProcessor`: in step 6a the browser sends
`baggage: session.id=...,user.id=...` with every API call, and this processor copies both onto
every backend span. The full walk-through of these two files is
[Tiny Shop, step 5](../tiny-shop/build-it-yourself-guide.md#step-5-instrument-the-backend).

## Step 6. Instrument the web app by hand

Stop Vite with Ctrl+C in its terminal tab, then install what the browser needs:

```bash
npm install @opentelemetry/api @opentelemetry/core @opentelemetry/resources @opentelemetry/sdk-trace @opentelemetry/sdk-logs @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-logs-otlp-http @opentelemetry/instrumentation @opentelemetry/instrumentation-fetch rrweb web-vitals
```

| Package | What it does here |
|---|---|
| `@opentelemetry/api` | what your code calls: `trace`, `logs`, `propagation`, `context` |
| `@opentelemetry/sdk-trace` | the tracer provider, span processors, and `StackContextManager` for the browser (OpenTelemetry JS 3.0 merged `sdk-trace-web` into it) |
| `@opentelemetry/sdk-logs` | the logger provider: RUM events are OTLP log records |
| `@opentelemetry/exporter-trace-otlp-http`, `exporter-logs-otlp-http` | send spans and logs to the collector over OTLP/HTTP |
| `@opentelemetry/instrumentation`, `instrumentation-fetch` | a span for every `fetch`, with `traceparent` on calls to your API |
| `@opentelemetry/core`, `resources` | the W3C trace-context and baggage propagators; the resource (who sent the data) |
| `rrweb` | records the DOM for session replay |
| `web-vitals` | LCP, INP, CLS, FCP, TTFB, measured the way Chrome measures them |

All the telemetry code goes in one folder, `frontend/src/telemetry/`. Create it:

```bash
mkdir src/telemetry
```

### 6a. Send spans to ouo

Three files: where the data goes, the session id, and OpenTelemetry itself.

Create `frontend/src/telemetry/config.js`:

<!-- embed: examples/quickstarts/tiny-shop-otel/result/frontend/src/telemetry/config.js -->
```js
// Where the telemetry goes and who this app is. Moved ports? Override in .env.local.

// The tiny-shop API (backend/).
export const API = import.meta.env.VITE_API_URL || "http://localhost:5001";

// The ouo collector: OTLP/HTTP for spans and logs, and the replay receiver for rrweb chunks.
export const OTLP_ENDPOINT = import.meta.env.VITE_OTLP_ENDPOINT || "http://localhost:4318";
export const REPLAY_ENDPOINT = import.meta.env.VITE_REPLAY_ENDPOINT || "http://localhost:4319";

// Every request to the collector carries the project credential:
// Basic base64("<project id>:<project token>"). The token is public by design: it ships in the bundle.
export const AUTHORIZATION = `Basic ${btoa("demo:pt_dev_demo_0000000000000000")}`;

export const SERVICE = {
  name: "tiny-shop-otel-frontend",
  version: "1.0.0",
  environment: "local",
};
```

Create `frontend/src/telemetry/session.js`. It keeps one session id per visit in
`localStorage`, shared by all tabs, and replaces it after 30 minutes without activity or after
4 hours, which are the rules ouo uses everywhere
([session lifecycle](../../../docs/specs/session-lifecycle.md)):

<!-- embed: examples/quickstarts/tiny-shop-otel/result/frontend/src/telemetry/session.js -->
```js
// The RUM session: one id for one visit, shared by every tab of the origin through localStorage.
// Same rules as ouo's SDKs (docs/specs/session-lifecycle.md): a session ends after 30 minutes
// without activity or after 4 hours, and the next signal starts a new one.
const SESSION_KEY = "tiny-shop.session";
const DEVICE_KEY = "tiny-shop.device";
const INACTIVITY_MS = 30 * 60 * 1000;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked (private mode, quota): the session lives as long as the page.
  }
}

// device.id: random, one per browser profile, kept across sessions. Never a fingerprint.
export const deviceId = read(DEVICE_KEY) ?? crypto.randomUUID();
write(DEVICE_KEY, deviceId);

const listeners = [];
let current = null;
let lastWrite = 0;

// fn("start", session, previousSession | null) and fn("end", session, reason).
export function onSessionChange(fn) {
  listeners.push(fn);
}

function endReason(session, now) {
  if (now - session.lastActivity >= INACTIVITY_MS) return "inactivity";
  if (now - session.startedAt >= MAX_DURATION_MS) return "max_duration";
  return null;
}

// The current session. Starts one on first use and replaces an expired one, so call it for
// every signal: the id it returns is always valid.
export function getSession() {
  const now = Date.now();
  current = read(SESSION_KEY) ?? current; // another tab may have touched or replaced it
  if (current && !endReason(current, now)) return current;

  const previous = current;
  current = {
    id: crypto.randomUUID(),
    // Anonymous until the app knows the user; the id stays with the browser across sessions.
    userId: previous?.userId ?? crypto.randomUUID(),
    startedAt: now,
    lastActivity: now,
    replaySeq: 0,
  };
  write(SESSION_KEY, current);
  if (previous) for (const fn of listeners) fn("end", previous, endReason(previous, now));
  for (const fn of listeners) fn("start", current, previous);
  return current;
}

// A click, a key, a scroll or a request: the session is still in use.
export function touch() {
  const session = getSession();
  session.lastActivity = Date.now();
  if (session.lastActivity - lastWrite >= 1000) {
    lastWrite = session.lastActivity;
    write(SESSION_KEY, session);
  }
}

// Replay chunks are numbered per session, and a reload continues the numbering.
export function nextReplaySeq() {
  const session = getSession();
  const seq = session.replaySeq++;
  write(SESSION_KEY, session);
  return seq;
}
```

Create `frontend/src/telemetry/otel.js`:

<!-- embed: examples/quickstarts/tiny-shop-otel/result/frontend/src/telemetry/otel.js -->
```js
// OpenTelemetry for the browser: spans and logs to the ouo collector over OTLP/HTTP.
import { context, logs, propagation, trace } from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, StackContextManager, TracerProvider } from "@opentelemetry/sdk-trace";
import { API, AUTHORIZATION, OTLP_ENDPOINT, REPLAY_ENDPOINT, SERVICE } from "./config.js";
import { deviceId, getSession, touch } from "./session.js";

const headers = { Authorization: AUTHORIZATION };

// Who sent the data. ouo.platform = "web" tells ouo this is a browser app.
const resource = resourceFromAttributes({
  "service.name": SERVICE.name,
  "service.version": SERVICE.version,
  "deployment.environment.name": SERVICE.environment,
  "ouo.platform": "web",
  "device.id": deviceId,
});

// session.id and user.id go on every span, not on the resource: the session can change while
// the page stays open.
class SessionSpanProcessor {
  onStart(span) {
    const session = getSession();
    span.setAttribute("session.id", session.id);
    span.setAttribute("user.id", session.userId);
  }
  onEnd() {}
  forceFlush() {
    return Promise.resolve();
  }
  shutdown() {
    return Promise.resolve();
  }
}

// traceparent joins the API's spans to the browser's trace; baggage carries session.id and
// user.id to the API. The baggage is added at inject time because the browser has no async
// context: baggage set with context.with() is gone by the time fetch sends the request.
class SessionPropagator {
  inner = new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  });
  inject(ctx, carrier, setter) {
    const session = getSession();
    const baggage = (propagation.getBaggage(ctx) ?? propagation.createBaggage())
      .setEntry("session.id", { value: session.id })
      .setEntry("user.id", { value: session.userId });
    this.inner.inject(propagation.setBaggage(ctx, baggage), carrier, setter);
  }
  extract(ctx, carrier, getter) {
    return this.inner.extract(ctx, carrier, getter);
  }
  fields() {
    return this.inner.fields();
  }
}

export const tracerProvider = new TracerProvider({
  resource,
  spanProcessors: [
    new SessionSpanProcessor(),
    new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${OTLP_ENDPOINT}/v1/traces`, headers }) }),
  ],
});

export const loggerProvider = new LoggerProvider({
  resource,
  processors: [
    new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${OTLP_ENDPOINT}/v1/logs`, headers }) }),
  ],
});

context.setGlobalContextManager(new StackContextManager().enable());
propagation.setGlobalPropagator(new SessionPropagator());
trace.setGlobalTracerProvider(tracerProvider);
logs.setGlobalLoggerProvider(loggerProvider);

// Called for every failed fetch; set by events.js (it emits http.request.failed).
let onFailedFetch = () => {};
export function setFailedFetchHandler(fn) {
  onFailedFetch = fn;
}

registerInstrumentations({
  instrumentations: [
    new FetchInstrumentation({
      // Only calls to our API get the trace headers. A RegExp: a plain string must equal the whole URL.
      propagateTraceHeaderCorsUrls: [new RegExp(`^${API}/`)],
      // Never trace the telemetry itself.
      ignoreUrls: [new RegExp(`^${OTLP_ENDPOINT}/`), new RegExp(`^${REPLAY_ENDPOINT}/`)],
      applyCustomAttributesOnSpan(span, request, result) {
        touch();
        if (result.status >= 400) onFailedFetch(request.method ?? "GET", result.url, result.status);
      },
    }),
  ],
});

// Send what is batched now (the page is being hidden and may never come back).
export function flushTelemetry() {
  void tracerProvider.forceFlush();
  void loggerProvider.forceFlush();
}
```

What each part is for:

- **The resource** says who sent the data. `ouo.platform = "web"` is how ouo knows a browser
  sent it; `service.version` is the app version that session health is broken down by.
- **`SessionSpanProcessor`** puts `session.id` and `user.id` on every span when it starts. That
  is how ouo lists a session's traces.
- **`SessionPropagator`** sends `traceparent` (one trace from the click to the API) and
  `baggage` with the session (the API's `BaggageSpanProcessor` copies it onto its spans). It adds
  the baggage itself on every request: the browser has no async context, so baggage set with
  `context.with()` is gone by the time `fetch` sends the request.
- **`propagateTraceHeaderCorsUrls`** must be a RegExp: OpenTelemetry compares a plain string with
  the **whole** request URL, so `"http://localhost:5001"` matches no call and the API starts its own
  trace.
- **`ignoreUrls`** keeps the exporters' own requests to the collector out of the traces.
- **The logger provider** is set up now and used in step 6b.

Create `frontend/src/telemetry/index.js`, a first version that only starts the session:

```js
// RUM without the ouo SDK. Import this first, before React.
import "./otel.js";
import { getSession } from "./session.js";

console.log("[telemetry] session", getSession().id);

export { API } from "./config.js";
export function addEvent() {}
```

Replace `frontend/src/main.jsx` with:

<!-- embed: examples/quickstarts/tiny-shop-otel/result/frontend/src/main.jsx -->
```jsx
// Start the telemetry before React renders anything.
import "./telemetry";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

In `frontend/src/App.jsx`, replace the line `const API = "http://localhost:5001";` with:

```jsx
import { API, addEvent } from "./telemetry";
```

Collector moved to 14318 in step 4c? Create `frontend/.env.local`:

```
VITE_OTLP_ENDPOINT=http://localhost:14318
VITE_REPLAY_ENDPOINT=http://localhost:14319
```

Start Vite:

```bash
npm run dev
```

Reload http://localhost:5173 with DevTools open. The Console prints
`[telemetry] session <uuid>`. In the Network tab, the API calls have an `OPTIONS` preflight
(the browser asks the API to accept `traceparent` and `baggage`) and a few seconds later a
`POST /v1/traces` to the collector answers `200`.

Click **Add**, then **Checkout**, wait up to a minute, then in Grafana: **Explore**, **Tempo**,
**TraceQL**:

```
{ resource.service.name = "tiny-shop-otel-backend" && name = "charge card" }
```

Open the newest trace. Its root is the browser:

```
tiny-shop-otel-frontend  POST
└─ tiny-shop-otel-backend  POST /api/checkout
   ├─ middleware - corsMiddleware, middleware - jsonParser, request handler - /api/checkout
   └─ checkout
      ├─ validate cart
      └─ charge card
```

Click any span, the browser's and the API's: `session.id` and `user.id` are on all of them, and
they are the id the Console printed.

### 6b. Send the RUM events

Spans alone are not a session for ouo: it builds sessions from log records. Create
`frontend/src/telemetry/events.js`:

<!-- embed: examples/quickstarts/tiny-shop-otel/result/frontend/src/telemetry/events.js -->
```js
// RUM events as OpenTelemetry log records. ouo reads them by event.name
// (session.start, exception, http.request.failed, navigation, web_vital); any other name is a
// custom event on the session timeline.
import { logs, SeverityNumber } from "@opentelemetry/api";
import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";
import { setFailedFetchHandler } from "./otel.js";
import { deviceId, getSession, onSessionChange } from "./session.js";

const logger = logs.getLogger("tiny-shop-rum");

export function emit(name, attributes = {}, { severity = "INFO", session = getSession() } = {}) {
  logger.emit({
    eventName: name,
    severityNumber: SeverityNumber[severity],
    severityText: severity,
    attributes: { "event.name": name, "session.id": session.id, "user.id": session.userId, ...attributes },
  });
}

// A custom event, e.g. addEvent("cart.added", { "product.id": 1 }).
export function addEvent(name, attributes) {
  emit(name, attributes);
}

// session.start and session.end, with the ids of the session they are about.
onSessionChange((type, session, detail) => {
  if (type === "start") {
    emit(
      "session.start",
      {
        "ouo.session.started_at": session.startedAt,
        "device.id": deviceId,
        ...(detail ? { "session.previous_id": detail.id } : {}),
      },
      { session },
    );
  } else {
    emit(
      "session.end",
      {
        "ouo.session.end_reason": detail,
        "ouo.session.duration_ms": session.lastActivity - session.startedAt,
        "device.id": deviceId,
      },
      { session },
    );
  }
});

// Uncaught errors and unhandled rejections. fatal = true marks the session "crashed"; the
// page keeps running, so the session goes on.
export function captureErrors() {
  const report = (error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    emit(
      "exception",
      {
        "exception.type": err.name,
        "exception.message": err.message,
        "exception.stacktrace": err.stack ?? "",
        "ouo.exception.fatal": true,
        "ouo.exception.handled": false,
      },
      { severity: "ERROR" },
    );
  };
  addEventListener("error", (event) => report(event.error ?? event.message));
  addEventListener("unhandledrejection", (event) => report(event.reason));
}

// A 4xx or 5xx answer marks the session "errored". The fetch span has the details.
setFailedFetchHandler((method, url, status) => {
  emit(
    "http.request.failed",
    { "http.request.method": method, "url.full": url, "http.response.status_code": status },
    { severity: "WARN" },
  );
});

// Page views: the first load and every client-side route change.
export function trackNavigation() {
  let from = document.referrer ? new URL(document.referrer).pathname : "";
  const report = () => {
    if (location.pathname === from) return;
    emit("navigation", { "url.path": location.pathname, "ouo.navigation.from": from });
    from = location.pathname;
  };
  report();
  const pushState = history.pushState;
  history.pushState = function (...args) {
    pushState.apply(this, args);
    report();
  };
  addEventListener("popstate", report);
}

// Core Web Vitals from Google's web-vitals library. Most are final only when the page is hidden.
export function trackWebVitals() {
  const report = (metric) =>
    emit("web_vital", {
      "ouo.web_vital.name": metric.name,
      "ouo.web_vital.value": metric.value,
      "ouo.web_vital.rating": metric.rating,
    });
  onCLS(report);
  onFCP(report);
  onINP(report);
  onLCP(report);
  onTTFB(report);
}
```

- **`emit`** is the one function that makes a RUM event: an OTLP log record with `eventName` and
  the same name as the `event.name` attribute, plus `session.id` and `user.id`.
- **`session.start` / `session.end`** come from `session.js` when it starts or replaces a session.
  `session.end` is a courtesy: ouo also ends a session on its own after 30 minutes of silence.
- **`exception`** with `ouo.exception.fatal = true` marks the session `crashed`. For a caught
  error you report yourself, send `fatal: false` and `handled: true`: the session is `errored`.
- **`http.request.failed`** comes from the fetch instrumentation's `applyCustomAttributesOnSpan`
  hook in `otel.js`, for every 4xx and 5xx answer.
- **`navigation`** is a page view; `trackNavigation` also wraps `history.pushState`, which is
  what client-side routers call.
- **`web_vital`** values come from `web-vitals`. Most of them are only final when the page is
  hidden, which is why step 6c flushes when that happens.

Replace `frontend/src/telemetry/index.js` with a second version:

```js
// RUM without the ouo SDK. Import this first, before React.
import { captureErrors, trackNavigation, trackWebVitals } from "./events.js";
import { flushTelemetry } from "./otel.js";
import { getSession, touch } from "./session.js";

getSession(); // resume the session, or start one (session.start)
captureErrors();
trackNavigation();
trackWebVitals();

// User activity keeps the session alive.
for (const type of ["click", "keydown", "scroll", "touchstart"]) {
  addEventListener(type, touch, { capture: true, passive: true });
}

// The tab is hidden: it may be closed next, so send everything now.
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushTelemetry();
});

console.log("[telemetry] session", getSession().id);

export { API } from "./config.js";
export { addEvent } from "./events.js";
```

Your session started in step 6a, before `session.start` existed. Start a fresh one: in the
DevTools Console run

```js
localStorage.removeItem("tiny-shop.session")
```

and reload. Click **Add** twice, **Checkout**, **Call broken API** and **Throw error**, then switch
to another browser tab for a moment (the page is hidden: the Web Vitals are sent).

In Grafana, **Explore**, **Loki**:

```
{service_name="tiny-shop-otel-frontend"}
```

`session.start`, `navigation`, `web_vital`, `cart.added`, `http.request.failed` and `exception`,
each with `session_id`. Then **More apps -> ouo11y RUM -> Sessions**: your session is there,
`crashed`, with 1 failed request and its traces. The replay panel is still empty.

### 6c. Record the replay

Create `frontend/src/telemetry/replay.js`:

<!-- embed: examples/quickstarts/tiny-shop-otel/result/frontend/src/telemetry/replay.js -->
```js
// Session replay: rrweb records the page, and the events go to ouo in chunks
// (docs/adr/0003-replay-model.md): { session_id, seq, started_at, ended_at, events },
// POST /v1/replay/chunks on the collector's replay port, every 5 s or at 256 KB.
import { record } from "rrweb";
import { AUTHORIZATION, REPLAY_ENDPOINT } from "./config.js";
import { getSession, nextReplaySeq, onSessionChange } from "./session.js";

const FLUSH_INTERVAL_MS = 5000;
const MAX_CHUNK_BYTES = 256 * 1024;
const KEEPALIVE_MAX_BYTES = 60 * 1024; // browsers cap keepalive request bodies at 64 KiB in total

let buffer = [];
let bufferBytes = 0;
let chunk = null; // { session_id, seq, started_at } of the events in the buffer
let timer = null;

function push(event) {
  if (buffer.length === 0) {
    // The chunk belongs to the session that was current when its first event happened.
    chunk = { session_id: getSession().id, seq: nextReplaySeq(), started_at: event.timestamp };
    timer = setTimeout(flushReplay, FLUSH_INTERVAL_MS);
  }
  buffer.push(event);
  bufferBytes += JSON.stringify(event).length;
  if (bufferBytes >= MAX_CHUNK_BYTES) flushReplay();
}

// Sends the buffered events as one chunk. pageHidden: the page may be gone after this.
export function flushReplay(pageHidden = false) {
  if (buffer.length === 0) return;
  clearTimeout(timer);
  const body = JSON.stringify({ ...chunk, ended_at: buffer[buffer.length - 1].timestamp, events: buffer });
  const headers = {
    "content-type": "application/json",
    Authorization: AUTHORIZATION,
    "x-ouo-session-id": chunk.session_id,
    "x-ouo-seq": String(chunk.seq),
  };
  buffer = [];
  bufferBytes = 0;
  fetch(`${REPLAY_ENDPOINT}/v1/replay/chunks`, {
    method: "POST",
    headers,
    body,
    // keepalive lets the request outlive the page, but only for small bodies.
    keepalive: pageHidden && body.length < KEEPALIVE_MAX_BYTES,
  }).catch((err) => console.warn("[replay] chunk upload failed", err));
}

export function startReplay() {
  record({
    emit: push,
    maskAllInputs: true, // what users type never leaves the browser
    blockClass: "ouo-block", // elements with this class are recorded as an empty box
    maskTextClass: "ouo-mask", // text inside elements with this class is masked
    checkoutEveryNms: 5 * 60 * 1000, // a full snapshot every 5 minutes keeps seeking fast
  });
  // A new session needs its own full snapshot: send the old session's events first.
  onSessionChange((type, session, previous) => {
    if (type !== "start" || !previous) return;
    flushReplay(document.visibilityState === "hidden");
    record.takeFullSnapshot();
  });
}
```

- **One session, one replay, many chunks.** rrweb emits a stream of events; they are cut into
  chunks every 5 seconds or at 256 KB. `seq` numbers the chunks of a session and is kept in the
  session, so a reload continues the numbering; ouo plays the chunks in `seq` order.
- **Each chunk names its session** twice: `session_id` in the body, and `x-ouo-session-id` /
  `x-ouo-seq` headers that the collector checks before it stores the chunk.
- **A new session needs a full snapshot.** rrweb's later events only describe changes, so when
  the session is replaced the old chunk is sent and `record.takeFullSnapshot()` starts the new
  session's replay from a complete page.
- **Privacy.** `maskAllInputs` keeps what users type out of the replay. Add the class
  `ouo-block` to an element to record it as an empty box, `ouo-mask` to mask its text.
- **Leaving the page.** `keepalive` lets the last request outlive the page, but browsers allow
  only 64 KiB of keepalive bodies at a time, so a bigger last chunk is sent without it.

Replace `frontend/src/telemetry/index.js` with its final version:

<!-- embed: examples/quickstarts/tiny-shop-otel/result/frontend/src/telemetry/index.js -->
```js
// RUM without the ouo SDK: OpenTelemetry + rrweb + web-vitals. Import this first, before React.
import { captureErrors, trackNavigation, trackWebVitals } from "./events.js";
import { flushTelemetry } from "./otel.js";
import { flushReplay, startReplay } from "./replay.js";
import { getSession, touch } from "./session.js";

getSession(); // resume the session, or start one (session.start)
captureErrors();
trackNavigation();
trackWebVitals();
startReplay();

// User activity keeps the session alive.
for (const type of ["click", "keydown", "scroll", "touchstart"]) {
  addEventListener(type, touch, { capture: true, passive: true });
}

// The tab is hidden: it may be closed next, so send everything now.
addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  flushReplay(true);
  flushTelemetry();
});

console.log("[telemetry] session", getSession().id);

export { API } from "./config.js";
export { addEvent } from "./events.js";
```

### 6d. The custom event

Replace `frontend/src/App.jsx` with the final version. Compared with step 3, the API URL comes
from `telemetry/config.js` (the same value the fetch instrumentation matches), and **Add**
records a custom `cart.added` event:

<!-- embed: examples/quickstarts/tiny-shop-otel/result/frontend/src/App.jsx -->
```jsx
import { useEffect, useState } from "react";
import { API, addEvent } from "./telemetry";

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`).then((r) => r.json()).then(setProducts);
  }, []);

  function addToCart(p) {
    setCart([...cart, p]);
    // A custom event: a log record with event.name "cart.added" in Loki.
    addEvent("cart.added", { "product.id": p.id, "product.name": p.name });
  }

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

  async function callBrokenApi() {
    // A 500: recorded as http.request.failed in the browser and as an error span in the API.
    const res = await fetch(`${API}/api/fail`);
    setMessage(`API answered ${res.status}`);
  }

  function crash() {
    // An uncaught error: an exception event, and the session is marked crashed.
    throw new Error("Button exploded");
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "40px auto" }}>
      <h1>Tiny Shop</h1>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.name} (${p.price}) <button onClick={() => addToCart(p)}>Add</button>
          </li>
        ))}
      </ul>
      <p>Cart: {cart.length} item(s)</p>
      <button onClick={checkout} disabled={!cart.length}>Checkout</button>{" "}
      <button onClick={callBrokenApi}>Call broken API</button>{" "}
      <button onClick={crash}>Throw error</button>
      <p>{message}</p>
    </main>
  );
}
```

## Step 7. See the full picture

Reload http://localhost:5173. Click **Add** twice, **Checkout**, **Call broken API**, then
**Throw error**. In the Network tab, `POST /v1/replay/chunks` on port 4319 answers `202` every
few seconds. Switch to another tab for a moment, then wait up to a minute.

**More apps -> ouo11y RUM -> Sessions**, open the newest session:

- the header says `crashed`, with 1 crash, 1 failed request and its traces;
- the timeline lists the navigation, `session.start`, the Web Vitals, both `cart.added`, the
  failed request and the exception;
- the **Replay** panel plays what you clicked;
- each trace opens in Tempo, from the browser's `fetch` span to the API's `charge card`.

This is the same session the ouo SDK would have produced, from code you own.

## Step 8. What the ouo SDK adds on top

What you built covers the contract. `@ouo11y/browser` also does the following; add what you
need, or switch to it later without changing anything on the server side.

| The SDK | Here |
|---|---|
| Records the replay in one tab at a time (a lease in `localStorage`) | every open tab records; two tabs of one session interleave in its replay |
| Keeps unsent data in IndexedDB and retries after a network error | a failed request is lost |
| gzips OTLP and replay bodies | plain JSON (the collector also accepts `Content-Encoding: gzip`) |
| `setUser()` / `clearUser()` / `endSession()`, with the `user_change` and `manual` end reasons | an anonymous user id per browser |
| XHR spans, click and interaction spans, long tasks, resource and `console.error` errors | `fetch` spans and uncaught errors |
| Session sampling, a byte cap on buffered replay, a kill switch | every session is recorded and sent |
| `ouo.sdk.name` / `ouo.sdk.version` and the browser and OS resource attributes | not sent |

## Step 9. Clean up

Stop the API and Vite with Ctrl+C. Stop the stack, keeping its data:

```bash
cd ~/Desktop/tiny-shop-otel/stack
```

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
| `denied` when pulling `ghcr.io/ouo11y/...` | not logged in to ghcr.io, or no read access yet: step 4b |
| `401` from `/v1/traces`, `/v1/logs` or `/v1/replay/chunks` | the `Authorization` header is missing or wrong (`AUTHORIZATION` in `config.js`) |
| CORS error on the collector in the console | the page is not on `localhost` / `127.0.0.1` (the collector's allowed origins), or a port in `.env.local` is wrong |
| The backend trace starts at `POST /api/checkout`, without the browser span | `propagateTraceHeaderCorsUrls` does not match the API URL (use the RegExp), or the page was not reloaded |
| Backend spans have no `session.id` | the `baggage` header is not sent (`SessionPropagator` not registered) or `BaggageSpanProcessor` is missing in `instrumentation.js` |
| Traces and logs in Grafana, but no session in ouo11y RUM | the log records lack `session.id`, or the resource lacks `ouo.platform` or `service.name` |
| A session with no replay | no `202` from `:4319/v1/replay/chunks`: check the port (`VITE_REPLAY_ENDPOINT`) and the headers |
| Replay shows a blank page | the chunk with the full snapshot was lost; reload the page to record a new one |
| No `LCP` or `FCP` in Loki | the page loaded in a background tab: web-vitals reports them only for pages that were visible while loading |
| Nothing in Tempo yet | wait up to a minute: new traces reach search later than trace-by-id |
