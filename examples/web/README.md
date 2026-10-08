# web-store (ouo web demo)

React 18 + Vite + TypeScript storefront instrumented with the `@ouo/browser`
RUM SDK. It exists to produce every kind of signal the MVP needs: sessions,
custom events, handled and uncaught errors, traced `fetch` calls that join
backend spans, Web Vitals and rrweb replay chunks.

Pages: `/` product grid, `/products/:id`, `/cart`, `/checkout`, `/order/:id`,
`/chaos` (fault buttons). A floating "chaos" button opens the same panel on
every other page.

## Run

From the repository root (npm workspaces; Node 24):

```bash
npm install                                 # links sdk/browser as @ouo/browser
npm run -w sdk/browser build                # the SDK is consumed from its dist/
npm run -w examples/web dev                 # http://localhost:5173
```

The demo backend and the LGTM stack must be running (`docker compose -f
deploy/docker/compose.yaml up -d`). Check `deploy/docker/.env` for the host
ports in use on your machine; the defaults below match this repository's
override file (backend 8082, OTLP/HTTP 4328, Grafana 3001).

Build and preview:

```bash
npm run -w examples/web build               # tsc (strict) + vite build -> dist/
npm run -w examples/web preview             # http://localhost:4173
```

Without the SDK package (for example before `sdk/browser` is built) the app
still runs against a console-logging stub that implements the same interface:

```bash
VITE_RUM_STUB=1 npm run -w examples/web dev
npm run -w examples/web build:stub
```

The footer shows "(rum stub)" when the stub is active.

## Environment

Copy `.env.example` to `.env` and adjust.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_OTLP_ENDPOINT` | `http://localhost:4328` | OTel Collector OTLP/HTTP base URL (traces and logs) |
| `VITE_RUM_API` | `http://localhost:8082` | rum-api base URL for replay chunk upload (Phase 3; placeholder until then) |
| `VITE_BACKEND_URL` | `http://localhost:8082` | demo backend; `tracing.propagateTo` is derived from it |
| `VITE_APP_VERSION` | `1.4.2` | reported as `service.version` |
| `VITE_RUM_STUB` | unset | `1` builds against `src/rum-stub.ts` instead of `@ouo/browser` |
| `VITE_RUM_DEBUG` | unset | `1` turns on SDK debug logging |

All SDK usage is in `src/rum.ts`; pages import `rum` from there. `src/api.ts`
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
- Chaos: "Handled error" (`rum.captureError(new Error("handled"))`,
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

On the checkout form the card number input has class `ouo-mask` (text masked
in the replay), the promo code field has class `ouo-block` (not recorded at
all), and all inputs are masked anyway because the SDK is initialised with
`maskAllInputs: true`.

## What to look for in Grafana

Grafana: `http://localhost:3001` (admin / admin) on this machine, `3000` by
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

Replay chunks are posted to `VITE_RUM_API` `POST /v1/replay/chunks`; until
rum-api ships (Phase 3) those requests fail in the network tab and nothing
else is affected.

## API usage from the command line

The flow above, without a browser (uses the same endpoints the app calls):

```bash
B=http://localhost:8082; H='content-type: application/json'; U='x-user-id: cli-user'
curl -s $B/api/products | head -c 200
curl -s -X POST $B/api/cart -H "$H" -H "$U" -d '{"productId":"p-1001","qty":2}'
curl -s $B/api/cart -H "$U"
curl -s -X POST $B/api/checkout -H "$H" -H "$U" -d '{"paymentMethod":"card"}'
curl -s -X POST "$B/api/checkout?fail=500" -H "$H" -H "$U" -d '{"paymentMethod":"card"}'
```
