# ouo-web: the web path (`@ouo11y/browser`)

React 18 + Vite + TypeScript storefront instrumented with the `@ouo11y/browser`
RUM SDK. It exists to produce every kind of signal the MVP needs: sessions,
custom events, handled and uncaught errors, traced `fetch` calls that join
backend spans, Web Vitals and rrweb replay chunks.

Pages: `/` product grid, `/products/:id`, `/cart`, `/checkout`, `/order/:id`,
`/chaos` (fault buttons). A floating "chaos" button opens the same panel on
every other page.

Path: `@ouo11y/browser` in the page → ouo collector (OTLP + replay) → Loki / Tempo / Mimir and
rum-api, and `fetch` to `examples/backend` with `traceparent` and `baggage`, so browser and backend
spans are one trace. On the web, clients use the ouo SDK only: there is no Sentry-web example (the
bridge does not translate browser envelopes, `docs/specs/sentry-bridge.md`).

## Five-minute run

Needs Docker, Node 24 and Python 3. From the repository root, `npm ci` once.

**Plain compose (clients).** The stack with the released images (`ghcr.io/ouo11y/*:0.3.0`). The
images are public, no `docker login`:

```bash
docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.images.yaml up -d
examples/ouo-web/scripts/run.sh            # build, serve on :4173, journey, verify
```

**ouo-env (us).** The same released images in a named env, or the checkout's own build without `--images`:

```bash
deploy/envs/ouo-env up web-demo --images
examples/ouo-web/scripts/run.sh --env web-demo
deploy/envs/ouo-env down web-demo
```

`run.sh --first-party` builds the app with `VITE_OTLP_ENDPOINT=/otel` and serves it with
`scripts/serve-first-party.mjs`, which proxies `/otel` to the collector on the app's own origin: the
setup that keeps ad blockers from dropping telemetry ([first-party endpoint](../../docs/first-party-endpoint.md)).

`run.sh` builds the app against the stack (`.env` here, copied from `.env.example`, overrides the
stock ports), serves it with `vite preview`, runs the scripted journey in a headless browser
(`scripts/journey.mjs`: two products into the cart, a card checkout, a third product and a
`broken-card` checkout that the backend fails with 500, then on the Chaos page a dead button, four
fast clicks on it, a 300 ms long task and a render error) and then `scripts/verify.py`:

- Loki, the wire of the client SDK spec: one `session.start`, `ouo.view.id` and a sanitised document
  URL on every record, no MVP event names, every Web Vital the browser supports as
  `browser.web_vital`, clicks as `browser.user_action.click`, a dead and a rage click as
  `ouo.user_action.frustration`, the error boundary's handled `exception` with its debug ids,
  route names (`ouo.view.name`), and replay as `ouo.replay.chunk` records in sequence with one
  `ouo.replay.ended`;
- Tempo: every backend request is a client span in a trace of its own (a click never starts a
  trace), no `click` or `soft-navigation` spans, one `documentLoad` span;
- rum-api (the MVP read path): the journey's session with its timeline and traces, and the render
  error symbolicated back to its source;
- trace continuity, checklist N24 (`examples/tools/tracecheck.py`):
  - every request the backend logged is a sampled trace in Tempo;
  - no backend span has a missing parent;
  - browser and backend spans share one trace id;
  - backend spans carry the `session.id` from baggage;
  - one backend span per request the page sent, and as many traces as distinct `traceparent` trace
    ids (one click with two requests is one trace);
  - CORS allows `traceparent`, `tracestate` and `baggage`;
  - nothing in the window came through the Sentry bridge.

`--browsers chromium,firefox,webkit` runs the journey and verify once per browser (each its own
session, `journey-<browser>.json`); the default is Chromium. `--playwright-image
mcr.microsoft.com/playwright:v1.64.1-noble` runs the journey in that image (the three browsers and
their system libraries are in it; CI does this), serving the built app inside the container. That is
also how to run Firefox on macOS 27, where Playwright's Firefox does not start. Exit status 0 means
every check passed. Then open Grafana (compose: http://localhost:3000, ouo-env:
the URL `ouo-env up` prints; admin / testing567), the ouo11y RUM app, and the session.

CI runs the same journey and verify in Chromium, Firefox and WebKit on every change to this example,
the backend or the browser SDK (job `examples` in `.github/workflows/ci.yml`), after the SDK's own
Playwright suite.

React integrations: `src/App.tsx` wraps the routes in `OuoErrorBoundary` and names each route with
`useOuoRoute(routeTemplate(matchRoutes(routes, location)))` from `@ouo11y/browser/react`. The Chaos
page has "Render error", "Long task (300 ms)" and "Dead button" (click it fast for a rage click).

Server-rendered pages: this app is a static SPA, so there is no `<meta name="traceparent">` here;
see the SDK README, "Linking the page load" (`examples/backend` belongs to the bridge examples and is
unchanged).

## Develop


From the repository root (npm workspaces; Node 24):

```bash
npm install                                 # links sdk/browser as @ouo11y/browser
npm run -w sdk/browser build                # the SDK is consumed from its dist/
npm run -w examples/ouo-web dev                 # http://localhost:5173
```

The demo backend and the LGTM stack must be running (`docker compose -f
deploy/compose/compose.yaml up -d`). The defaults below are the stock host ports
from `deploy/compose/.env.example`. If you moved ports in `deploy/compose/.env`,
copy `.env.example` to `.env` here and change the URLs.

Build and preview:

```bash
npm run -w examples/ouo-web build               # tsc (strict) + vite build -> dist/
npm run -w examples/ouo-web preview             # http://localhost:4173
```

Without the SDK package (for example before `sdk/browser` is built) the app
still runs against a console-logging stub that implements the same interface:

```bash
VITE_RUM_STUB=1 npm run -w examples/ouo-web dev
npm run -w examples/ouo-web build:stub
```

The footer shows "(rum stub)" when the stub is active.

## Environment

Copy `.env.example` to `.env` and adjust.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_OTLP_ENDPOINT` | `http://localhost:4318` | collector OTLP/HTTP base URL. The SDK posts to `/v1/traces` and `/v1/logs`; replay chunks are `ouo.replay.chunk` log records on `/v1/logs` |
| `VITE_OUO_PROJECT_ID` | `demo` | project id, the HTTP Basic username |
| `VITE_OUO_PROJECT_TOKEN` | `pt_dev_demo_0000000000000000` | public project token, the HTTP Basic password; the development value the whole local stack agrees on |
| `VITE_BACKEND_URL` | `http://localhost:8081` | demo backend; `propagation.urls` is derived from it |
| `VITE_APP_VERSION` | `1.4.2` | reported as `service.version` |
| `VITE_RUM_STUB` | unset | `1` builds against `src/rum-stub.ts` instead of `@ouo11y/browser` |
| `VITE_RUM_DEBUG` | unset | `1` turns on SDK debug logging |
| `VITE_OUO_SESSION_SAMPLE_RATE` | `1` | `sampling.sessionRate`: fraction of sessions that send telemetry |
| `VITE_OUO_REPLAY_SAMPLE_RATE` | `1` | `replay.sessionRate` / `replay.bufferRate`: fraction of sampled sessions that record replay |
| `VITE_OUO_REPLAY_MODE` | `session` | `replay.mode`: `session`, `buffer` (kept in memory, sent after an unhandled error) or `off` |
| `VITE_OUO_REPLAY_FORMAT` | `structure` | `replay.format`: `structure` (DOM description, text as `***`; the supported format) or `pixel` (masked images of the viewport; experimental) |

All SDK usage is in `src/rum.ts`; pages import `rum` from there. The id and
token are read from `VITE_OUO_PROJECT_ID` / `VITE_OUO_PROJECT_TOKEN` and are
public by design (they end up in the built JavaScript as a Basic credential,
like any RUM vendor's key). `src/api.ts`
wraps `fetch` for the backend and adds `x-user-id`; `traceparent` and
`baggage` come from the SDK's fetch instrumentation, never from app code.

## Demo script

Set a user first: type an id (for example `user-42`) in the header and press
"Set user". It is stored in `localStorage`, passed to `rum.setUser`, and sent
as `x-user-id` on every API call. The footer shows the current `session.id`
and user id; copy the session id for the Grafana queries below. A page reload
keeps the session (it is persisted by the SDK); to start a fresh session clear
site data or wait for the inactivity timeout.

### Healthy session

1. Open `http://localhost:5173/`, set a user.
2. Click a product, set a quantity, "Add to cart" (emits `add_to_cart`).
3. Open Cart, press Checkout, fill name, email, card number, keep payment
   method `card`, press Pay (emits `checkout_submitted`, `POST /api/checkout`).
4. The order page shows the order id. No errors, no failed requests: the
   session classifies as `healthy`.

### Errored session (non-fatal)

Any one of these marks the session `errored` (ADR-0004):

- Checkout with payment method `broken-card`: the backend answers 500, the SDK
  emits `http.request.failed`.
- Chaos: "500 response" (`POST /api/checkout?fail=500`).
- Chaos: "Handled error" (`recordException(new Error("handled"))`,
  `ouo.exception.fatal = false`).
- Chaos: "Timeout" (`GET /api/products?fail=timeout`, aborted client-side after
  5 s) ends with no response status, which the SDK counts as a failed request
  (`http.request.failed`, status 0). "Slow request" (`?delay=2000`) only
  produces a slow span.

### Crashed session (fatal)

- Chaos: "Uncaught error" throws inside a click handler and reaches
  `window.onerror`.
- Chaos: "Unhandled rejection" rejects a promise with no handler.

Both are `exception` events with `ouo.exception.fatal = true`; the page keeps
running but the session is counted as `crashed`. Note: React 18 development
builds re-throw errors from event handlers once more through
`invokeGuardedCallback`, so the browser console shows the uncaught error
twice in `vite dev`. The production build (`vite preview`) reports it once.

### Other buttons

- "console.error" logs `console failure` (non-fatal if the SDK captures console).
- "Custom event" sends `add_to_cart` with `product_id` and `qty`.
- "Pause replay" / "Resume replay" toggle rrweb recording and show
  `rum.replay.isRecording()` (polled every second; rrweb is loaded lazily so it
  reads `false` for a moment after page load); telemetry keeps flowing while
  replay is paused.
- "Flush" calls `rum.flush()` so spans, logs and replay chunks are sent now
  instead of on the next batch timer.

### Replay privacy

All text and every input are masked in the replay by default; the public
storefront is marked `data-ouo-unmask`. On the checkout form the card number
input has `data-ouo-mask` (masked even inside an unmasked area; payment fields
can never be unmasked anyway) and the promo code field has `data-ouo-block`
(not recorded at all).

## What to look for in Grafana

Grafana: `http://localhost:3001` (admin / testing567) on this machine, `3000` by
default. Open Explore.

Tempo (traces of one session, browser and backend spans in one trace):

```
{ span.session.id = "<session id>" }
```

Click a trace: the `GET /api/products` or `POST /api/checkout` browser span has
the backend's server span and its `inventory.lookup` / `payment.charge` /
`db.query` children below it. The `?delay=2000` request shows a 2 s
`db.query`; the `?fail=500` one is red with `payment gateway unavailable`.

Loki (session events of one session):

```
{service_name="web-store"} | session_id="<session id>"
```

Expect `session.start`, `navigation`, `add_to_cart`, `checkout_submitted`,
`exception` (with `ouo_exception_fatal` true or false) and
`http.request.failed` lines, plus the backend's own `request` logs under
`{service_name="demo-backend"} | session_id="<session id>"`.

From a Tempo span, "Logs for this span" jumps to Loki filtered on the same
`session_id` (provisioned trace-to-logs correlation).

Everything the SDK sends goes to the collector: `POST <VITE_OTLP_ENDPOINT>/v1/traces`
and `/v1/logs` (replay chunks too, as OTLP protobuf), each with
`Authorization: Basic base64(id:token)`. A `401` in the network tab means the id
or token does not match the collector's htpasswd; a CORS error with no POST at
all means `http://localhost:5173` is not in the collector's `allowed_origins`
or `Authorization` is missing from its allowed headers. rum-api is internal and
never reached from the browser.

## API usage from the command line

The flow above, without a browser (uses the same endpoints the app calls):

```bash
B=http://localhost:8081; H='content-type: application/json'; U='x-user-id: cli-user'
curl -s $B/api/products | head -c 200
curl -s -X POST $B/api/cart -H "$H" -H "$U" -d '{"productId":"p-1001","qty":2}'
curl -s $B/api/cart -H "$U"
curl -s -X POST $B/api/checkout -H "$H" -H "$U" -d '{"paymentMethod":"card"}'
curl -s -X POST "$B/api/checkout?fail=500" -H "$H" -H "$U" -d '{"paymentMethod":"card"}'
```
