# Build Tiny Shop yourself, from scratch

This guide builds the [Tiny Shop](README.md) quickstart by hand, one step at a time, with no
scripts:

1. a plain Express API and a plain React page, both working with no telemetry at all;
2. the ouo stack (Grafana, Loki, Tempo, Mimir, the ouo collector) from one compose file;
3. the backend instrumented with the OpenTelemetry Node SDK, with manual spans, and its traces
   in Grafana;
4. the web app instrumented with `@ouo11y/browser`, and one trace from the click in the browser
   to the API's manual spans.

At the end your files are the same as [`result/backend/`](result/backend) and
[`result/frontend/`](result/frontend) next to this guide: compare with them when you are stuck. Plan on
about 30 minutes.

Every command goes in its own block: run them one by one, in order. When a step says
"replace the file", select everything in it and paste the new content over it.

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
mkdir -p ~/Desktop/tiny-shop/backend ~/Desktop/tiny-shop/frontend ~/Desktop/tiny-shop/stack
```

```bash
cd ~/Desktop/tiny-shop
```

```bash
code .
```

In VS Code, open a terminal with Ctrl+\`. You will use three terminal tabs (the `+` button):
one for the backend, one for the frontend, one for the stack.

## Step 2. A simple API, no telemetry yet

In the first terminal tab:

```bash
cd ~/Desktop/tiny-shop/backend
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

You get the three products as JSON. (A `%` at the end is zsh saying the output had no final
newline; it is not part of the answer.) Leave the API running.

## Step 3. A dummy React UI

In the second terminal tab:

```bash
cd ~/Desktop/tiny-shop
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

The whole stack is one file: Grafana, Loki, Tempo, Mimir, Muninn (replay) and the ouo collector, with
their configuration inline. Open the block below, copy all of it, and paste it into a new file
`stack/compose.yaml` in VS Code. (It is the same file as
[`deploy/compose/quickstart.yaml`](../../../deploy/compose/quickstart.yaml).)

<details>
<summary><code>stack/compose.yaml</code> (click to open)</summary>

<!-- embed: deploy/compose/quickstart.yaml -->
```yaml
# ouo quickstart: the whole local stack in one file, on the latest ouo release.
# GENERATED by deploy/scripts/gen-quickstart.sh; do not edit by hand.
#
# The ouo images default to :latest, the newest release. This file was generated for these
# releases (digest = the multi-arch image index at that version):
#
#   collector  0.5.0  sha256:64f2be4da3ee8f19633c8aa078f21a9ee192af48ae0d1ecb4659318e3bbddda5  OUO_COLLECTOR_VERSION
#   muninn     0.2.0  sha256:b4a1e95d346572372712aa8f6cd901146b96b9386d403126fe9b39da95fc3172  OUO_MUNINN_VERSION
#
# To stay on exactly these, put e.g. OUO_MUNINN_VERSION=0.2.0 (or 0.2.0@sha256:...) in a .env
# file next to this one. A later release that needs new configs comes with a regenerated file:
# fetch it again (deploy/compose/quickstart.yaml in the ouo11y/ouo11y repo).
#
# Copy this file into an empty folder as compose.yaml, then (the images are public, no docker login):
#
#   docker compose up -d
#
# Grafana          http://localhost:3000      admin / testing567 (Explore: Loki, Tempo, Mimir)
# OTLP/HTTP        http://localhost:4318      /v1/traces /v1/logs /v1/metrics (replay: scope ouo.replay on /v1/logs)
# Sentry bridge    http://localhost:4320      Sentry SDK DSN host (ADR-0008)
# Muninn           http://127.0.0.1:3400      replay store, read token mrt_dev_0000000000000000
# Credential       HTTP Basic, project id `demo`, project token `pt_dev_demo_0000000000000000`
#                  (Authorization: Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw)
#
# Ports collide? Set OUO_GRAFANA_PORT, OUO_OTLP_HTTP_PORT, OUO_MUNINN_PORT, ... in a .env
# file next to this one (names and defaults: deploy/compose/.env.example in the repo).
# Stop: `docker compose down`; wipe the data too: `docker compose down -v`.
#
# Development tokens only (they are public): fine on a laptop, never on a reachable host.
# A server install is deploy/vm/install.sh. Needs Docker Compose >= 2.24 (`configs.content`).
#
# No `name:` on purpose: the project is named after the folder, so two copies of this file in
# two folders are two separate stacks (a fixed name would make `down -v` in one remove the other).

services:
  grafana:
    image: grafana/grafana:13.2.5
    ports:
      - "${OUO_GRAFANA_PORT:-3000}:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: ${OUO_GRAFANA_ADMIN_PASSWORD:-testing567}
      GF_AUTH_ANONYMOUS_ENABLED: "false"
      GF_USERS_DEFAULT_THEME: dark
    configs:
      - source: grafana-datasources
        target: /etc/grafana/provisioning/datasources/datasources.yaml
    volumes:
      - grafana-data:/var/lib/grafana
    depends_on:
      - loki
      - tempo
      - mimir
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health >/dev/null 2>&1 || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 30

  loki:
    image: grafana/loki:3.7.7
    command: ["-config.file=/etc/loki/config.yaml", "-config.expand-env=true"]
    ports:
      - "${OUO_LOKI_PORT:-3100}:3100"
    environment:
      OUO_RETENTION_LOGS: ${OUO_RETENTION_LOGS:-720h}
      OUO_LOKI_COMPACTION_INTERVAL: ${OUO_LOKI_COMPACTION_INTERVAL:-10m}
      OUO_LOKI_RETENTION_DELETE_DELAY: ${OUO_LOKI_RETENTION_DELETE_DELAY:-2h}
      OUO_LOKI_DELETE_CANCEL_PERIOD: ${OUO_LOKI_DELETE_CANCEL_PERIOD:-24h}
    configs:
      - source: loki
        target: /etc/loki/config.yaml
      - source: loki-runtime
        target: /etc/loki/runtime.yaml
    volumes:
      - loki-data:/loki

  tempo:
    image: grafana/tempo:3.0.3
    command: ["-config.file=/etc/tempo/config.yaml", "-config.expand-env=true"]
    ports:
      - "${OUO_TEMPO_PORT:-3200}:3200"
    environment:
      OUO_RETENTION_TRACES: ${OUO_RETENTION_TRACES:-336h}
    configs:
      - source: tempo
        target: /etc/tempo/config.yaml
    volumes:
      - tempo-data:/var/tempo

  mimir:
    image: grafana/mimir:3.2.1
    command: ["-config.file=/etc/mimir/config.yaml", "-config.expand-env=true"]
    ports:
      - "${OUO_MIMIR_PORT:-9009}:9009"
    environment:
      OUO_RETENTION_METRICS: ${OUO_RETENTION_METRICS:-2160h}
    configs:
      - source: mimir
        target: /etc/mimir/config.yaml
    volumes:
      - mimir-data:/data

  # The only ingest (ADR-0007): OTLP on 4318 behind HTTP Basic project credentials checked
  # against the projects-htpasswd config below, the Sentry bridge on 4320. Replay chunks
  # (scope ouo.replay on /v1/logs) go to Muninn through a disk queue.
  otel-collector:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/collector:${OUO_COLLECTOR_VERSION:-latest}
    command: ["--config=/etc/otelcol/config.yaml"]
    ports:
      - "127.0.0.1:${OUO_OTLP_GRPC_PORT:-4317}:4317"
      - "${OUO_OTLP_HTTP_PORT:-4318}:4318"
      - "${OUO_SENTRY_PORT:-4320}:4320"
      - "127.0.0.1:${OUO_COLLECTOR_HEALTH_PORT:-13133}:13133"
    environment:
      MUNINN_ENDPOINT: http://muninn:3400
      MUNINN_INGEST_TOKEN: ${OUO_MUNINN_INGEST_TOKEN:-mit_dev_0000000000000000}
      MUNINN_TENANT: anonymous
      OUO_ALLOWED_ORIGINS: ${OUO_ALLOWED_ORIGINS:-http://localhost:*,http://127.0.0.1:*}
      OUO_RATELIMIT_CLIENT_KEY: ${OUO_RATELIMIT_CLIENT_KEY:-address}
      OUO_RATELIMIT_PROJECT_RATE: ${OUO_RATELIMIT_PROJECT_RATE:-1000}
      OUO_RATELIMIT_PROJECT_BURST: ${OUO_RATELIMIT_PROJECT_BURST:-5000}
      OUO_RATELIMIT_CLIENT_RATE: ${OUO_RATELIMIT_CLIENT_RATE:-100}
      OUO_RATELIMIT_CLIENT_BURST: ${OUO_RATELIMIT_CLIENT_BURST:-300}
      OUO_SENTRY_UPSTREAM: ${OUO_SENTRY_UPSTREAM:-none}
      OUO_SENTRY_PROJECT_ID: ${OUO_SENTRY_PROJECT_ID:-1}
      OUO_SENTRY_PUBLIC_KEY: ${OUO_SENTRY_PUBLIC_KEY:-publickey0000000000000000000000}
      OUO_SENTRY_SERVICE_NAME: ${OUO_SENTRY_SERVICE_NAME:-sentry-demo}
    configs:
      - source: collector
        target: /etc/otelcol/config.yaml
      - source: projects-htpasswd
        target: /etc/otelcol/projects.htpasswd
    volumes:
      - replay-queue:/var/lib/otelcol/replay-queue
    depends_on:
      - loki
      - tempo
      - mimir

  # MinIO: Muninn's object store (internal).
  minio:
    image: ${OUO_MINIO_IMAGE:-pgsty/minio:RELEASE.2026-08-04T00-00-00Z}
    command: ["server", "/data", "--console-address", ":9001"]
    ports:
      - "127.0.0.1:${OUO_MINIO_PORT:-9000}:9000"
      - "127.0.0.1:${OUO_MINIO_CONSOLE_PORT:-9001}:9001"
    environment:
      MINIO_ROOT_USER: ${OUO_MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${OUO_MINIO_ROOT_PASSWORD:-minioadmin}
    volumes:
      - minio-data:/data

  # Bucket and a Muninn user whose policy reaches only that bucket. Idempotent.
  muninn-init:
    image: ${OUO_MC_IMAGE:-pgsty/mc:RELEASE.2026-09-16T00-00-00Z}
    depends_on:
      - minio
    environment:
      MINIO_ROOT_USER: ${OUO_MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${OUO_MINIO_ROOT_PASSWORD:-minioadmin}
      BUCKET: ${OUO_MUNINN_S3_BUCKET:-ouo-muninn}
      MUNINN_KEY: ${OUO_MUNINN_S3_ACCESS_KEY:-muninn}
      MUNINN_SECRET: ${OUO_MUNINN_S3_SECRET_KEY:-muninn-dev-secret-0000}
    entrypoint: ["/bin/sh", "-ec"]
    command:
      - |
        i=0; until mc alias set local http://minio:9000 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
          i=$$((i+1)); [ $$i -lt 60 ] || { echo "minio not reachable"; exit 1; }; sleep 1; done
        mc ready local
        mc mb --ignore-existing "local/$$BUCKET"
        cat > /tmp/muninn-policy.json <<POLICY
        {"Version":"2012-10-17","Statement":[
          {"Effect":"Allow","Action":["s3:GetBucketLocation","s3:ListBucket"],"Resource":["arn:aws:s3:::$$BUCKET"]},
          {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:GetObjectTagging","s3:PutObjectTagging"],"Resource":["arn:aws:s3:::$$BUCKET/*"]}]}
        POLICY
        mc admin policy create local muninn /tmp/muninn-policy.json
        mc admin user add local "$$MUNINN_KEY" "$$MUNINN_SECRET"
        mc admin policy attach local muninn --user "$$MUNINN_KEY" || true
        echo "bucket $$BUCKET and user $$MUNINN_KEY ready"

  # Muninn (ADR-0019): the internal replay store. SDKs never talk to it.
  muninn:
    image: ${OUO_IMAGE_REGISTRY:-ghcr.io/ouo11y}/muninn:${OUO_MUNINN_VERSION:-latest}
    command: ["-config.file=/etc/muninn/config.yaml", "-config.expand-env=true"]
    ports:
      - "127.0.0.1:${OUO_MUNINN_PORT:-3400}:3400"
    environment:
      MUNINN_INGEST_TOKEN: ${OUO_MUNINN_INGEST_TOKEN:-mit_dev_0000000000000000}
      MUNINN_READ_TOKEN: ${OUO_MUNINN_READ_TOKEN:-mrt_dev_0000000000000000}
      MUNINN_ADMIN_TOKEN: ${OUO_MUNINN_ADMIN_TOKEN:-mat_dev_0000000000000000}
      OUO_UPLOAD_TOKEN_DEMO: ${OUO_UPLOAD_TOKEN_DEMO:-ut_dev_demo_0000000000000000}
      MUNINN_S3_BUCKET: ${OUO_MUNINN_S3_BUCKET:-ouo-muninn}
      MUNINN_S3_ACCESS_KEY: ${OUO_MUNINN_S3_ACCESS_KEY:-muninn}
      MUNINN_S3_SECRET_KEY: ${OUO_MUNINN_S3_SECRET_KEY:-muninn-dev-secret-0000}
      OUO_RETENTION_REPLAYS: ${OUO_RETENTION_REPLAYS:-720h}
      OUO_REPLAY_SWEEP_INTERVAL: ${OUO_REPLAY_SWEEP_INTERVAL:-1h}
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_EXPORTER_OTLP_HEADERS: ${OUO_BACKEND_OTLP_HEADERS:-Authorization=Basic%20aW50ZXJuYWw6cHRfZGV2X2ludGVybmFsXzAwMDAwMDAwMDAwMDAw}
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_SERVICE_NAME: muninn
      OTEL_RESOURCE_ATTRIBUTES: deployment.environment.name=local
    configs:
      - source: muninn
        target: /etc/muninn/config.yaml
    depends_on:
      muninn-init:
        condition: service_completed_successfully

volumes:
  grafana-data:
  loki-data:
  tempo-data:
  mimir-data:
  minio-data:
  replay-queue:

configs:
  collector:
    # deploy/compose/collector/config.yaml
    content: |
      # ouo-collector configuration for the local stack (ADR-0007: the collector is the edge;
      # ADR-0019: replay goes to Muninn, docs/specs/muninn.md section 5).
      #
      # Replay chunks are ordinary OTLP log records (scope ouo.replay) on the ordinary
      # /v1/logs endpoint; stock components route them to Muninn:
      #
      #   otlp :4318 -> memory_limiter -> ouoratelimit -> resource/project -> routing/replay
      #     scope != ouo.replay -> logs              (transform/events, batch)  -> Loki
      #     scope == ouo.replay -> logs/replay       (no batch: COL-3)          -> otlp_http/muninn [disk queue, fsync]
      #                         -> logs/replay-index (body dropped, ref set)    -> Loki
      #
      # The Sentry SDK bridge (ADR-0008) on :4320 sends traces to Tempo and logs to Loki. Its
      # video replay chunks (ouo.replay.chunk=true) have no store yet:
      # they are dropped (counted by the debug exporter) until Muninn takes them.
      #
      # Ports: 4318 OTLP/HTTP public (Basic auth, CORS), 4320 Sentry public (DSN key auth), 4317 gRPC, 13133 health, 8888 metrics.
      #
      # Environment:
      #   OUO_ALLOWED_ORIGINS  optional comma-separated CORS origin list, no spaces
      #   OUO_RATELIMIT_CLIENT_KEY  address (default) or x_forwarded_for behind a reverse proxy
      #   OUO_RATELIMIT_{PROJECT,CLIENT}_{RATE,BURST}  bucket sizes (defaults 1000/5000 and 100/300)
      #   OUO_SENTRY_UPSTREAM  Sentry ingest base URL the bridge forwards to, or "none" (default)
      #   OUO_SENTRY_PROJECT_ID, OUO_SENTRY_PUBLIC_KEY, OUO_SENTRY_SERVICE_NAME  the bridged DSN
      #   MUNINN_ENDPOINT      Muninn base URL (default http://muninn:3400)
      #   MUNINN_INGEST_TOKEN  bearer for POST /otlp/v1/logs; must equal Muninn's auth.ingest_token
      #   MUNINN_TENANT        X-Scope-OrgID sent to Muninn: one tenant per Collector (COL-9)
      #   OUO_REPLAY_QUEUE_BYTES  disk queue bound in bytes (default 2 GiB, COL-5 / Q12)

      extensions:
        health_check:
          endpoint: 0.0.0.0:13133
        basicauth/server:
          htpasswd:
            file: /etc/otelcol/projects.htpasswd
        ouoauth:
          authenticator: basicauth/server
        ouoratelimit:
          processor: ouoratelimit
        # The replay exporter's persistent queue (COL-4): every enqueue is written with fsync
        # before the pipeline call returns, so the SDK's 2xx means "on disk" (SDK spec TRN-12).
        # The directory is a named volume in compose (Q12: StatefulSet volume in Helm).
        file_storage/replay:
          directory: /var/lib/otelcol/replay-queue
          create_directory: true
          fsync: true
          timeout: 5s

      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: 0.0.0.0:4317
              include_metadata: true
              auth:
                authenticator: ouoauth
              middlewares:
                - id: ouoratelimit
            http:
              endpoint: 0.0.0.0:4318
              include_metadata: true
              max_request_body_size: 4194304   # 4 MiB; a chunk body is at most 1 MiB (RPL-10)
              auth:
                authenticator: ouoauth
              middlewares:
                - id: ouoratelimit
              cors:
                allowed_origins: $${env:OUO_ALLOWED_ORIGINS:-http://localhost:*,http://127.0.0.1:*}
                allowed_headers: [Authorization, Content-Type, Content-Encoding, traceparent, baggage]
                exposed_headers: [Retry-After]
                max_age: 7200
        # Sentry SDK bridge (ADR-0008, docs/specs/sentry-bridge.md): apps change only their DSN host.
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
        # The Sentry bridge's video replay chunks have no store (see the header): route them
        # to the debug exporter and everything else to Loki.
        routing/sentry:
          default_pipelines: [logs/sentry-out]
          table:
            - context: log
              condition: log.attributes["ouo.replay.chunk"] == true
              pipelines: [logs/sentry-replay]
        # COL-2: route by instrumentation scope, after the project is stamped, before any batch.
        # error_mode propagate: the default would send a record whose condition failed to the
        # default pipeline, body included.
        routing/replay:
          error_mode: propagate
          default_pipelines: [logs]
          table:
            - context: log
              condition: instrumentation_scope.name == "ouo.replay"
              pipelines: [logs/replay, logs/replay-index]

      processors:
        memory_limiter:
          check_interval: 1s
          limit_mib: 512
          spike_limit_mib: 128
        ouoratelimit:
          project:
            rate: $${env:OUO_RATELIMIT_PROJECT_RATE:-1000}
            burst: $${env:OUO_RATELIMIT_PROJECT_BURST:-5000}
          client:
            rate: $${env:OUO_RATELIMIT_CLIENT_RATE:-100}
            burst: $${env:OUO_RATELIMIT_CLIENT_BURST:-300}
            key_from: $${env:OUO_RATELIMIT_CLIENT_KEY:-address}
          idle_timeout: 10m
        # COL-9: the authenticated project overwrites whatever the client sent.
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
        transform/events:
          error_mode: ignore
          log_statements:
            - context: log
              statements:
                - set(log.attributes["event.name"], log.event_name) where log.event_name != "" and log.attributes["event.name"] == nil
                - set(log.attributes["ouo.platform"], resource.attributes["ouo.platform"]) where log.attributes["ouo.platform"] == nil and resource.attributes["ouo.platform"] != nil
        # COL-6, COL-7 (Q3: one reference record per chunk): Loki's copy keeps the attributes,
        # gets ouo.replay.ref and loses the chunk bytes. An empty string, not nil: set(body, nil)
        # is a no-op without the ottl.set.allowNil gate and would send the chunk to Loki.
        # ouo.replay.ended records pass unchanged.
        # The body goes first, and errors are ignored: this copy is a hint, and by the time it
        # runs the chunk may already be in Muninn's queue, so failing here would only make the
        # SDK resend (and queue) the chunk again. A record the ref cannot be built for still
        # reaches Loki without its bytes.
        transform/replay-ref:
          error_mode: ignore
          log_statements:
            - context: log
              statements:
                - set(log.body, "") where log.event_name == "ouo.replay.chunk"
                - set(log.attributes["ouo.replay.ref"], Concat(["muninn:", resource.attributes["ouo.project.id"], log.attributes["session.id"], log.attributes["ouo.replay.id"], log.attributes["ouo.replay.stream.id"], String(log.attributes["ouo.replay.sequence"])], "/")) where log.event_name == "ouo.replay.chunk"

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
        # Q1: Muninn's OTLP/HTTP logs endpoint with the stock exporter.
        otlp_http/muninn:
          logs_endpoint: $${env:MUNINN_ENDPOINT:-http://muninn:3400}/otlp/v1/logs
          compression: none   # COL-10: chunk bodies are already compressed
          timeout: 30s
          tls:
            insecure: true
          headers:
            Authorization: Bearer $${env:MUNINN_INGEST_TOKEN}
            X-Scope-OrgID: $${env:MUNINN_TENANT:-anonymous}
          sending_queue:
            enabled: true
            storage: file_storage/replay
            sizer: bytes
            queue_size: $${env:OUO_REPLAY_QUEUE_BYTES:-2147483648}
            block_on_overflow: false   # COL-5: full queue -> 503 to the SDK, never block
            num_consumers: 4
          # COL-8: retry 429/502/503/504 and network failures without a time limit.
          retry_on_failure:
            enabled: true
            initial_interval: 1s
            max_interval: 60s
            max_elapsed_time: 0
        debug:
          verbosity: basic

      service:
        extensions: [health_check, basicauth/server, ouoauth, ouoratelimit, file_storage/replay]
        telemetry:
          logs:
            level: info
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
          metrics:
            receivers: [otlp]
            processors: [memory_limiter, ouoratelimit, resource/project, batch]
            exporters: [otlp_http/mimir]
          logs/in:
            receivers: [otlp]
            processors: [memory_limiter, ouoratelimit, resource/project]
            exporters: [routing/replay]
          logs:
            receivers: [routing/replay]
            processors: [transform/events, batch]
            exporters: [otlp_http/loki]
          # COL-3: no batch processor, so the receiver waits for the queue write.
          logs/replay:
            receivers: [routing/replay]
            exporters: [otlp_http/muninn]
          logs/replay-index:
            receivers: [routing/replay]
            processors: [transform/replay-ref, transform/events, batch]
            exporters: [otlp_http/loki]
          # Sentry bridge output; the project is in the client context (auth.username).
          logs/sentry:
            receivers: [ouosentry]
            processors: [memory_limiter, ouoratelimit, resource/project]
            exporters: [routing/sentry]
          logs/sentry-out:
            receivers: [routing/sentry]
            processors: [transform/events, batch]
            exporters: [otlp_http/loki]
          logs/sentry-replay:
            receivers: [routing/sentry]
            exporters: [debug]
  projects-htpasswd:
    # deploy/compose/collector/projects.htpasswd
    content: |
      # Development project registry for ouo-collector (basicauth extension, ADR-0007).
      # LOCAL USE ONLY. The demo token is public in this repository; never deploy this file.
      # One line per project. username = project id, password = project token, {SHA} hash.
      # Generate a line with   htpasswd -nbs PROJECT TOKEN
      # Comment lines in this file must never contain a colon character (see project/kb-archive/collector-components.md).
      demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=
      # internal = the platform's own telemetry (Muninn, demo backend), token pt_dev_internal_00000000000000,
      # so it has its own rate-limit buckets and never spends a client project's quota.
      internal:{SHA}wXBw3q7GMLhIo7ifP3a0fC2Z14M=
  loki:
    # deploy/compose/loki/config.yaml
    content: |
      # Loki 3.x single-binary, filesystem storage, native OTLP ingestion.
      # Started with -config.expand-env=true: the OUO_* variables below come from compose.yaml (retention,
      # deletion timings; docs/operations/data-lifecycle.md).
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

      # Retention and deletion (roadmap 8b): the compactor applies limits_config.retention_period
      # (and per-project retention_stream entries from runtime.yaml) and processes delete
      # requests (POST /loki/api/v1/delete, sent by `ouo-erase` in libs/ouo-go).
      compactor:
        working_directory: /loki/compactor
        compaction_interval: $${OUO_LOKI_COMPACTION_INTERVAL:-10m}
        retention_enabled: true
        # Chunks marked for deletion are removed after this delay.
        retention_delete_delay: $${OUO_LOKI_RETENTION_DELETE_DELAY:-2h}
        delete_request_store: filesystem
        # Grace period during which a delete request can be cancelled before the compactor
        # acts on it.
        delete_request_cancel_period: $${OUO_LOKI_DELETE_CANCEL_PERIOD:-24h}

      # Per-project overrides (retention_stream on the ouo_project_id label), reloaded every
      # 10 s without a restart.
      runtime_config:
        file: /etc/loki/runtime.yaml
        period: 10s

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
        # Retention of every stream (OUO_RETENTION_LOGS, at least 24h); runtime.yaml can set a
        # shorter or longer one per project. Delete requests remove lines from chunks.
        retention_period: $${OUO_RETENTION_LOGS:-720h}
        deletion_mode: filter-and-delete
        # Label promotion for OTLP (ADR-0001): only service_name, event_name,
        # ouo_platform and ouo_project_id (one value per project, for per-project
        # retention_stream and deletes) become stream labels; session.id stays
        # structured metadata so cardinality stays low. Loki rewrites "." to "_".
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
                  - ouo.project.id
          log_attributes:
            - action: index_label
              attributes:
                - event.name
                - ouo.platform

      analytics:
        reporting_enabled: false
  loki-runtime:
    # deploy/compose/loki/runtime.yaml
    content: |
      # Loki runtime overrides, reloaded every 10 s (runtime_config in config.yaml): edit and
      # save, no restart. Per-project log retention goes here as retention_stream entries on
      # the ouo_project_id stream label; the default is limits_config.retention_period
      # (OUO_RETENTION_LOGS). Loki's single tenant is "fake" (auth_enabled: false).
      # docs/operations/data-lifecycle.md, section Per-project retention.
      #
      # overrides:
      #   fake:
      #     retention_stream:
      #       - selector: '{ouo_project_id="ttltest"}'
      #         priority: 1
      #         period: 24h          # at least 24h
      overrides: {}
  tempo:
    # deploy/compose/tempo/config.yaml
    content: |
      # Tempo 3.x single binary, local storage, OTLP receiver, metrics generator -> Mimir.
      # Started with -config.expand-env=true (trace retention from compose.yaml).
      # Only keys that exist in 3.0.x are used; see project/kb-archive/collector-lgtm.md.
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

      # Trace retention (roadmap 8b): blocks older than block_retention are deleted by the
      # backend scheduler's retention job (hourly) run on the backend worker. Both carry the
      # compaction settings in 3.0; keep them equal. Tempo has no delete API: single traces
      # are removed with `tempo-cli redact` (docs/operations/data-lifecycle.md).
      backend_scheduler:
        provider:
          compaction:
            compaction:
              block_retention: $${OUO_RETENTION_TRACES:-336h}

      backend_worker:
        compaction:
          block_retention: $${OUO_RETENTION_TRACES:-336h}

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
      # Started with -config.expand-env=true (metric retention from compose.yaml).
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
        # Metric retention (roadmap 8b): the compactor deletes blocks older than this. 0 keeps
        # everything.
        compactor_blocks_retention_period: $${OUO_RETENTION_METRICS:-2160h}

      usage_stats:
        enabled: false
  muninn:
    # deploy/compose/muninn/config.yaml
    content: |
      # Muninn in the local stack (compose.yaml). Every key and its default:
      # services/muninn/config.example.yaml. Secrets come from the environment.
      server:
        http_listen_port: 3400
      multitenancy_enabled: false   # tenant "anonymous"; the Collector sends one fixed X-Scope-OrgID
      auth:
        ingest_token: $${MUNINN_INGEST_TOKEN}
        read_token: $${MUNINN_READ_TOKEN}
        admin_token: $${MUNINN_ADMIN_TOKEN}   # ouo-erase: project delete and audit entries
      storage:
        backend: s3
        s3:
          endpoint: minio:9000
          bucket: $${MUNINN_S3_BUCKET:-ouo-muninn}
          access_key_id: $${MUNINN_S3_ACCESS_KEY}
          secret_access_key: $${MUNINN_S3_SECRET_KEY}
          insecure: true
      retention:
        default: $${OUO_RETENTION_REPLAYS:-720h}
        sweep_interval: $${OUO_REPLAY_SWEEP_INTERVAL:-1h}
      # Debug files (spec section 13, ADR-0026): the CI upload token of the demo project.
      # Development value, public like the tokens above.
      debug_files:
        upload_tokens:
          - project: demo
            token: $${OUO_UPLOAD_TOKEN_DEMO:-ut_dev_demo_0000000000000000}
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
```

</details>

### 4b. Check that ghcr.io answers

The ouo images are public: no GitHub account, no token, no `docker login`. Check that this
machine can pull them:

```bash
docker pull ghcr.io/ouo11y/collector:latest
```

`denied` means Docker still sends an old ghcr.io login whose token expired: run
`docker logout ghcr.io`, then pull again.

### 4c. Check the ports

The stack publishes 3000 (Grafana), 3100, 3200, 9009, 8080, and the collector's 4318
(OTLP) and 4320. This prints nothing when they are all free:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|3100|3200|4318|4320|9009) '
```

If something is listed (often another collector on 4318-4320), do not stop it: move this
stack instead. Create `stack/.env`:

```bash
code ~/Desktop/tiny-shop/stack/.env
```

with:

```
OUO_OTLP_HTTP_PORT=14318
OUO_SENTRY_PORT=14320
OUO_OTLP_GRPC_PORT=14317
OUO_COLLECTOR_HEALTH_PORT=14133
```

Compose reads `.env` on its own. Remember the new collector ports: steps 5 and 6 tell you
where they go. Another port listed (3000, 8080, ...)? Its variable is `OUO_GRAFANA_PORT`, ... (all of them: the `${OUO_..._PORT:-...}` lines in `compose.yaml`).

### 4d. Start it

```bash
cd ~/Desktop/tiny-shop/stack
```

```bash
docker compose up -d
```

```bash
docker compose ps -a
```

`grafana` becomes `healthy`; `loki`, `tempo`, `mimir` and `otel-collector` are `Up`.

Open http://localhost:3000 and log in with **admin / testing567**. **Explore** has the Loki,
Tempo and Mimir datasources, still empty.

## Step 5. Instrument the backend

Stop the API with Ctrl+C in its terminal tab, then:

```bash
cd ~/Desktop/tiny-shop/backend
```

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation-http @opentelemetry/instrumentation-express @opentelemetry/baggage-span-processor @opentelemetry/resources @opentelemetry/semantic-conventions
```

What each package is for: `api` is what your code calls (`trace.getTracer`); `sdk-node`
runs the SDK; `sdk-trace` has the span processors; `exporter-trace-otlp-http` sends spans
to the collector; the two `instrumentation-*` packages create the HTTP server and Express
spans for you; `baggage-span-processor` copies the browser's session id onto your spans
(step 6); `resources` and `semantic-conventions` name the service.

### 5a. Initialise the SDK

Create `backend/instrumentation.js`:

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
    [ATTR_SERVICE_NAME]: "tiny-shop-backend",
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment.name": "local",
  }),
  spanProcessors: [
    // The browser SDK sends `baggage: session.id=...,user.id=...`; copy it onto every span so
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

Three things to know about it:

- **The credential.** The collector accepts nothing without
  `Authorization: Basic base64("<project id>:<project token>")`. The quickstart ships the
  `demo` project; check the value with `printf 'demo:pt_dev_demo_0000000000000000' | base64`.
- **The endpoint.** `http://localhost:4318` unless you moved the collector in step 4c; then
  start the API with `OUO_OTLP_ENDPOINT=http://localhost:14318` (shown below).
- **OpenTelemetry JS 3.0.** `BatchSpanProcessor` comes from `@opentelemetry/sdk-trace` and takes
  `{ exporter }`. Snippets written for 2.x use `sdk-trace-base` and `new BatchSpanProcessor(exporter)`;
  that version starts fine and crashes at the first export.

### 5b. Add manual spans

Replace `backend/server.js` with:

```js
// The API. HTTP server spans come from the auto-instrumentation; the spans below are manual.
const express = require("express");
const cors = require("cors");
const { trace, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-backend");
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

`startActiveSpan` makes the new span the current one while the callback runs, so the spans
started inside it become its children, and all of them become children of the HTTP span the
auto-instrumentation opened for the request. Always `end()` a span you started.

### 5c. Run it with the SDK loaded first

The SDK has to load **before** Express, so the instrumentation can patch it. Save that as the
start script:

```bash
npm pkg set scripts.start="node --require ./instrumentation.js server.js"
```

```bash
npm start
```

It prints `[otel] tracing to http://localhost:4318/v1/traces`. Collector on 14318 (step 4c)?
Stop it and start it this way instead:

```bash
OUO_OTLP_ENDPOINT=http://localhost:14318 npm start
```

Send some traffic from another tab:

```bash
curl -X POST -H 'content-type: application/json' -d '{"items":[1,2]}' localhost:5001/api/checkout
```

```bash
curl localhost:5001/api/fail
```

### 5d. See the backend traces in Grafana

Wait up to a minute (Tempo's search catches up; open a trace by id and it is there sooner), then in Grafana: **Explore**, data source
**Tempo**, **TraceQL** tab:

```
{ resource.service.name = "tiny-shop-backend" }
```

Open the `POST /api/checkout` trace: `POST /api/checkout` -> the Express middleware spans ->
`checkout` -> `validate cart` and `charge card` (with its `payment accepted` event). The
`GET /api/fail` trace is red, with the exception recorded on it.

## Step 6. Instrument the web app

Stop Vite with Ctrl+C in its terminal tab, then:

```bash
npm install @ouo11y/browser@0.2.1
```

### 6a. Initialise the SDK

Create `frontend/src/rum.js`:

```js
// ouo browser SDK init: sessions, errors, fetch tracing, Web Vitals and replay.
import { initRUM } from "@ouo11y/browser";

// The tiny-shop API (backend/). Moved it? VITE_API_URL in .env.local.
export const API = import.meta.env.VITE_API_URL || "http://localhost:5001";

export const rum = initRUM({
  // The ouo collector. Moved ports? Set VITE_OUO_ENDPOINT in .env.local.
  endpoint: import.meta.env.VITE_OUO_ENDPOINT || "http://localhost:4318",
  projectId: "demo",
  projectToken: "pt_dev_demo_0000000000000000", // public by design, ships in the bundle
  service: { name: "tiny-shop-frontend", version: "1.0.0", environment: "local" },
  // Calls to the API get `traceparent` + `baggage`, so its spans join the browser's trace.
  // Use a RegExp: OpenTelemetry compares a string entry with the whole request URL.
  tracing: { propagateTo: [new RegExp(`^${API}/`)] },
  replay: { enabled: true, maskAllInputs: true },
  debug: true,
});
```

- **The package is `@ouo11y/browser`.** Importing `@ouo/browser` (its old name) fails with
  "could not be resolved".
- **`propagateTo`** lists the URLs that get the `traceparent` and `baggage` headers. That is what
  joins the API's spans to the browser's trace and carries `session.id` to the backend. Use a
  RegExp: OpenTelemetry compares a plain string with the **whole** request URL, so
  `"http://localhost:5001"` matches no call at all and the backend quietly starts its own trace.
- **The project token** is public by design: it ships in every page, like any RUM key.

Collector moved to 14318 in step 4c? Create `frontend/.env.local`:

```
VITE_OUO_ENDPOINT=http://localhost:14318
```

### 6b. Load it before React

Replace `frontend/src/main.jsx` with:

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

### 6c. Use it in the app

Replace `frontend/src/App.jsx` with:

```jsx
import { useEffect, useState } from "react";
import { API, rum } from "./rum";

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
    rum.addEvent("cart.added", { "product.id": p.id, "product.name": p.name });
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

Compared with step 3: the API URL now comes from `rum.js` (the same value `propagateTo` uses),
and **Add** records a custom `cart.added` event.

### 6d. Run it

```bash
npm run dev
```

Reload http://localhost:5173 and open DevTools -> Console:
`[ouo] @ouo11y/browser@0.2.1 initialised {...}`. In the Network tab, each call to the API now
has an `OPTIONS` preflight before it: the browser is asking the API to accept `traceparent`
and `baggage`, and `cors()` in `server.js` says yes.

## Step 7. See the full picture

Click **Add** twice, **Checkout**, **Call broken API**, then **Throw error**. Wait up to a
minute.

**One trace across both apps.** Explore -> Tempo -> TraceQL:

```
{ resource.service.name = "tiny-shop-backend" && name = "charge card" }
```

Open the newest trace. Its root is now the browser:

```
tiny-shop-frontend  POST
└─ tiny-shop-backend  POST /api/checkout
   ├─ middleware - corsMiddleware, middleware - jsonParser, request handler - /api/checkout
   └─ checkout
      ├─ validate cart
      └─ charge card
```

Click any backend span: `session.id` and `user.id` are on it, copied from the browser's
`baggage` by the `BaggageSpanProcessor`.

**Browser events.** Explore -> Loki:

```
{service_name="tiny-shop-frontend"}
```

`session.start`, `navigation`, `cart.added`, `http.request.failed` (the 500), `exception`
(the thrown error) and `web_vital` records, each with `session_id`.

## Step 8. Clean up

Stop the API and Vite with Ctrl+C. Stop the stack, keeping its data:

```bash
cd ~/Desktop/tiny-shop/stack
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
| `denied` when pulling `ghcr.io/ouo11y/...` | an old, expired ghcr.io login: `docker logout ghcr.io` (step 4b) |
| Vite: `@ouo/browser ... could not be resolved` | the package is `@ouo11y/browser` |
| `Cannot read properties of undefined (reading 'export')` in the API | OpenTelemetry 2.x code: `new BatchSpanProcessor({ exporter })` from `@opentelemetry/sdk-trace` |
| The backend trace starts at `POST /api/checkout`, without the browser span | `propagateTo` does not match the API URL (use the RegExp), or the page was not reloaded after editing `rum.js` |
| No `OPTIONS` before the API calls | same as above: no trace headers are being added |
| CORS error on `/v1/traces` or `/v1/logs` in the console | the page is not on `localhost` / `127.0.0.1` (the collector's allowed origins), or the endpoint is wrong after moving ports (`VITE_OUO_ENDPOINT`) |
| `401` from the collector | the `Authorization` header is missing or wrong |
| Nothing in Tempo yet | wait up to a minute: new traces reach search later than trace-by-id |
