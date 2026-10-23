# Build Tiny Shop yourself, from scratch

This guide builds the [Tiny Shop](README.md) quickstart by hand, one step at a time, with no
scripts:

1. a plain Express API and a plain React page, both working with no telemetry at all;
2. the ouo stack (Grafana, Loki, Tempo, Mimir, the ouo collector) from one compose file;
3. the backend instrumented with the OpenTelemetry Node SDK, with manual spans, and its traces
   in Grafana;
4. the web app instrumented with `@ouo11y/browser`, and one trace from the click in the browser
   to the API's manual spans.

At the end your files are the same as `backend/` and `frontend/` next to this guide. Plan on
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

### 4a. Get the files

The stack is one compose file, and the browser SDK is not on npm yet, so take both from a
shallow clone of the repo. In the third terminal tab:

```bash
cd ~/Desktop/tiny-shop
```

```bash
git clone --depth 1 https://github.com/ouo11y/ouo11y.git
```

```bash
cp ouo11y/deploy/compose/quickstart.yaml stack/compose.yaml
```

(Without a clone: open `deploy/compose/quickstart.yaml` on GitHub, click **Raw**, copy all
of it and paste it into `stack/compose.yaml`.)

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

If something is listed (often another collector on 4318-4320), do not stop it: move this
stack instead. Create `stack/.env`:

```bash
code ~/Desktop/tiny-shop/stack/.env
```

with:

```
OUO_OTLP_HTTP_PORT=14318
OUO_REPLAY_PORT=14319
OUO_SENTRY_PORT=14320
OUO_OTLP_GRPC_PORT=14317
OUO_COLLECTOR_HEALTH_PORT=14133
```

Compose reads `.env` on its own. Remember the new collector ports: steps 5 and 7 tell you
where they go. Another port listed (3000, 8080, ...)? Its variable is `OUO_GRAFANA_PORT`,
`OUO_RUM_API_PORT`, ... (all of them: `deploy/compose/.env.example` in the clone).

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

`grafana` and `rum-api` become `healthy`; `loki`, `tempo`, `mimir` and `otel-collector` are
`Up`; `grafana-plugin` is `Exited (0)`, which is right: it only copies the ouo plugin into
Grafana and stops.

Open http://localhost:3000 and log in with **admin / testing567**. **More apps -> ouo11y
RUM** is there and still empty.

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
(step 7); `resources` and `semantic-conventions` name the service.

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

## Step 6. Build the browser SDK

`@ouo11y/browser` is not on npm yet: build it from the clone and pack it into a file npm can
install.

```bash
cd ~/Desktop/tiny-shop/ouo11y
```

```bash
npm ci
```

```bash
npm run -w sdk/browser build
```

```bash
npm pack -w sdk/browser --pack-destination ~/Desktop/tiny-shop
```

That writes `~/Desktop/tiny-shop/ouo11y-browser-0.2.0.tgz`.

## Step 7. Instrument the web app

Stop Vite with Ctrl+C in its terminal tab, then:

```bash
cd ~/Desktop/tiny-shop/frontend
```

```bash
npm install ../ouo11y-browser-0.2.0.tgz
```

### 7a. Initialise the SDK

Create `frontend/src/rum.js`:

```js
// ouo browser SDK init: sessions, errors, fetch tracing, Web Vitals and replay.
import { initRUM } from "@ouo11y/browser";

// The tiny-shop API (backend/). Moved it? VITE_API_URL in .env.local.
export const API = import.meta.env.VITE_API_URL || "http://localhost:5001";

export const rum = initRUM({
  // The ouo collector. Moved ports? Set VITE_OUO_ENDPOINT and VITE_OUO_REPLAY_ENDPOINT in .env.local
  // (the replay URL is derived only when the endpoint uses port 4318).
  endpoint: import.meta.env.VITE_OUO_ENDPOINT || "http://localhost:4318",
  replayEndpoint: import.meta.env.VITE_OUO_REPLAY_ENDPOINT || undefined,
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

Collector moved to 14318 in step 4c? Create `frontend/.env.local`; the replay URL is only
derived on its own when the endpoint is on 4318:

```
VITE_OUO_ENDPOINT=http://localhost:14318
VITE_OUO_REPLAY_ENDPOINT=http://localhost:14319
```

### 7b. Load it before React

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

### 7c. Use it in the app

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

### 7d. Run it

```bash
npm run dev
```

Reload http://localhost:5173 and open DevTools -> Console:
`[ouo] @ouo11y/browser@0.2.0 initialised {...}`. In the Network tab, each call to the API now
has an `OPTIONS` preflight before it: the browser is asking the API to accept `traceparent`
and `baggage`, and `cors()` in `server.js` says yes.

## Step 8. See the full picture

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

**The session.** More apps -> ouo11y RUM -> Sessions: your session is `crashed` (the uncaught
error), with its traces and a replay of what you clicked.

## Step 9. Clean up

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
| `denied` when pulling `ghcr.io/ouo11y/...` | not logged in to ghcr.io, or no read access yet: step 4b |
| Vite: `@ouo/browser ... could not be resolved` | the package is `@ouo11y/browser` |
| `Cannot read properties of undefined (reading 'export')` in the API | OpenTelemetry 2.x code: `new BatchSpanProcessor({ exporter })` from `@opentelemetry/sdk-trace` |
| The backend trace starts at `POST /api/checkout`, without the browser span | `propagateTo` does not match the API URL (use the RegExp), or the page was not reloaded after editing `rum.js` |
| No `OPTIONS` before the API calls | same as above: no trace headers are being added |
| CORS error on `/v1/traces` or `/v1/replay/chunks` in the console | the page is not on `localhost` / `127.0.0.1` (the collector's allowed origins), or the replay URL is wrong after moving ports (`VITE_OUO_REPLAY_ENDPOINT`) |
| `401` from the collector | the `Authorization` header is missing or wrong |
| Nothing in Tempo yet | wait up to a minute: new traces reach search later than trace-by-id |
