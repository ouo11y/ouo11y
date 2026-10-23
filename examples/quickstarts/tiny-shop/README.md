# Tiny Shop: Node API + React app, traced end to end

A two-folder app you can read in five minutes: an Express API (`backend/`) and a React page
(`frontend/`). Both are instrumented, so one click in the browser gives one trace from the
button to the API's manual spans, tagged with the RUM session:

```
tiny-shop-frontend  POST                       (fetch span, @ouo11y/browser)
└─ tiny-shop-backend  POST /api/checkout       (HTTP server span, auto-instrumentation)
   └─ checkout                                 (manual span)
      ├─ validate cart                         (manual span)
      └─ charge card                           (manual span, event "payment accepted")
every span: session.id, user.id               (browser baggage, copied by BaggageSpanProcessor)
```

| Path | What |
|---|---|
| `backend/instrumentation.js` | OpenTelemetry Node SDK init: OTLP exporter with the project credential, http + express auto-instrumentation, baggage -> span attributes |
| `backend/server.js` | the API: `GET /api/products`, `POST /api/checkout`, `GET /api/fail`, with manual spans |
| `frontend/src/rum.js` | `@ouo11y/browser` init: sessions, errors, fetch tracing with `traceparent` to the API, Web Vitals, replay |
| `frontend/src/main.jsx` | imports `./rum` first, before React renders |
| `frontend/src/App.jsx` | the shop: Add (custom event), Checkout, Call broken API (500), Throw error (crash) |

Needs Node 24 and Docker. Commands have no `$` prompt; each runs from the folder named above it.

**Rather build it yourself?** [build-it-yourself-from-scratch.md](build-it-yourself-from-scratch.md)
takes you from an empty folder to the same files, one step at a time: the plain app first, then
the stack, the backend instrumentation, and the browser SDK.

## 1. Run the ouo stack

The stack is one file, [`deploy/compose/quickstart.yaml`](../../../deploy/compose/quickstart.yaml).
Copy it into an empty folder as `compose.yaml`, log in to ghcr.io (the images are private for now:
[fast-tracked 00, "Pull access"](../../fast-tracked/00-stack.md)), then in that folder:

```bash
docker compose up -d
```

Grafana is on http://localhost:3000 (admin / testing567), the collector on `:4318` (OTLP) and
`:4319` (replay). Ports taken? See [Ports](#ports) below.

## 2. Build the browser SDK

`@ouo11y/browser` is not on npm yet; `frontend/package.json` points at `sdk/browser` in this repo,
which has to be built once. From the repo root:

```bash
npm ci
```

```bash
npm run -w sdk/browser build
```

## 3. Start the API

From `examples/quickstarts/tiny-shop/backend`:

```bash
npm install
```

```bash
npm start
```

It prints `[otel] tracing to http://localhost:4318/v1/traces` and serves on `:5001`.
`npm start` is `node --require ./instrumentation.js server.js`: the SDK has to load before
Express so the auto-instrumentation can patch it.

## 4. Start the web app

From `examples/quickstarts/tiny-shop/frontend`, in a second terminal:

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. The DevTools console shows `[ouo] @ouo11y/browser@... initialised`.
Click **Add** on a product, then **Checkout**, then **Call broken API** and **Throw error**.

## 5. See it in Grafana

Give Tempo up to a minute after the click before searching.

- **One trace across both apps:** Explore -> Tempo -> TraceQL
  `{ resource.service.name = "tiny-shop-backend" && name = "charge card" }`, open the trace: the root
  is the browser's `POST` span.
- **Backend only:** `{ resource.service.name = "tiny-shop-backend" }`. `GET /api/fail` is an error span
  with the recorded exception.
- **Browser events:** Explore -> Loki -> `{service_name="tiny-shop-frontend"}`: `session.start`,
  `navigation`, `cart.added`, `http.request.failed`, `exception`, `web_vital`.
- **The session:** More apps -> ouo11y RUM -> Sessions. After **Throw error** the session is
  `crashed`; it has a replay and its traces.

## Ports

If the quickstart runs on other ports (a `.env` next to its `compose.yaml` with
`OUO_OTLP_HTTP_PORT=14318`, `OUO_REPLAY_PORT=14319`, ...), point both apps at them:

```bash
OUO_OTLP_ENDPOINT=http://localhost:14318 npm start
```

and in `frontend/.env.local` (the replay URL is only derived when the endpoint is on 4318):

```
VITE_OUO_ENDPOINT=http://localhost:14318
VITE_OUO_REPLAY_ENDPOINT=http://localhost:14319
```

The API on another port: `PORT=5002 npm start` and `VITE_API_URL=http://localhost:5002` in
`frontend/.env.local`; `rum.js` builds `propagateTo` from it. The web app must stay on a
`localhost` or `127.0.0.1` origin, the only ones the quickstart collector allows (CORS).

## Copy it out of the repo

Both folders work anywhere. Outside the repo, install the published SDK from GitHub Packages
instead of the `file:../../../../sdk/browser` dependency. Once per machine, with the GitHub CLI
logged in:

```bash
gh auth refresh -s read:packages
```

```bash
npm config set @ouo11y:registry https://npm.pkg.github.com
```

```bash
npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"
```

then in your copy of `frontend/`: `npm install @ouo11y/browser@0.2.0`.

## Things that bite

- **OpenTelemetry JS 3.0** (`@opentelemetry/sdk-node` 0.300): `BatchSpanProcessor` is in
  `@opentelemetry/sdk-trace` (not `sdk-trace-base`) and takes `{ exporter }`, and `sdk-node` no
  longer re-exports `tracing`. Older snippets crash at start or at the first export.
- **`propagateTo` strings must equal the whole request URL.** OpenTelemetry compares a string with
  `===`, so `"http://localhost:5001"` matches no API call and the backend starts its own trace. Use a
  RegExp, as `rum.js` does.
- **The browser adds `traceparent` and `baggage` to cross-origin calls**, so the API must answer the
  CORS preflight for them (`cors()` in `server.js`).
- **Every OTLP request needs the project credential**, the backend's too:
  `Authorization: Basic base64("demo:pt_dev_demo_0000000000000000")`. Without it the collector answers 401.
