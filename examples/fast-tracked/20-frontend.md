# 20. Add ouo RUM to your React web app

Goal: your own React app sends sessions, errors, traced `fetch` calls, Web Vitals and
rrweb replay to the local ouo stack, and you can see one session end to end in Grafana.
Budget: about 20 minutes. Everything below is copy and paste.

This page assumes `00-stack.md` is done (the stack is up) and, if you want backend spans
under your browser spans, `10-backend.md` too. Paths in this page are relative to the ouo
repository root unless they start with `/`.

## 0. What you get, and what you still have to do

The SDK does this on its own once `initRUM` has run:

- Session lifecycle per `docs/specs/session-lifecycle.md`: a UUID v4 `session.id` kept in
  `localStorage["ouo.session"]`, resumed across reloads, shared between tabs of the same
  origin, ended after 30 min of inactivity or 4 h total. It emits `session.start` and
  `session.end` (with `ouo.session.end_reason`) as OTel log records.
- `session.id`, `user.id`, `ouo.user.anonymous`, `ouo.platform=web`, `service.version` on
  every span and every log record.
- Uncaught errors (`window.onerror`) and unhandled promise rejections as `exception` log
  records with `ouo.exception.fatal=true` (the session counts as `crashed`, ADR-0004).
  `console.error`, failed resource loads and `rum.captureError()` are `exception` records
  with `ouo.exception.fatal=false` (session counts as `errored`).
- One `CLIENT` span per `fetch` / XHR, plus a `documentLoad` span from Navigation Timing.
  A response with status 5xx, or a network failure (status 0), also emits an
  `http.request.failed` log record. 4xx is not an error.
- `traceparent` and `baggage` (`session.id`, `user.id`, `ouo.platform`) headers on every
  same-origin request and on every request to an origin listed in `tracing.propagateTo`.
- `navigation` records on page load and on `pushState` / `replaceState` / `popstate`
  (React Router goes through `pushState`, nothing router specific is needed).
- `web_vital` records for TTFB, FCP, LCP, CLS, INP.
- rrweb replay: a chunk is uploaded every 5 s or at 256 KB, gzip, to the collector's
  replay receiver `POST /v1/replay/chunks` (port 4319); on `pagehide` the rest goes out with
  `keepalive`. Inputs are masked by default.
- One edge for everything (ADR-0007): spans and log records go to the OpenTelemetry
  Collector `POST /v1/traces` and `/v1/logs` (port 4318), replay to its replay receiver
  (port 4319), every request with `Authorization: Basic base64(projectId:projectToken)`.
  The collector checks the credential, the page origin (CORS), size and rate, stamps
  `ouo.project.id`, and forwards to Tempo, Loki and (replay) rum-api. The browser never
  talks to rum-api.

You still have to do these yourself:

1. Call `initRUM` before React renders with your collector URL, your project id and your
   project token (section 3).
2. Tell the SDK the origin of your backend in `tracing.propagateTo`, otherwise
   cross-origin requests get no `traceparent` / `baggage` and your traces end at the browser.
3. Make your backend's CORS answer allow the `traceparent`, `tracestate` and `baggage`
   request headers (section 5). Without that the browser blocks the preflight and the
   request itself fails.
4. Call `rum.setUser({ id })` when you know who the user is (section 4). Until then the
   session carries a persisted anonymous id.

## 1. Install the packages

`@ouo/browser` is an npm workspace package inside this repository. It is not published
to a registry yet, so you install it from the repository. Build it first (output goes to
`sdk/browser/dist`, which is what the package exposes):

```bash
npm install
```

```bash
npm run -w sdk/browser build
```

Then, in **your** app, pick one of the two install methods.

Option A, install from the folder. npm links the folder into `node_modules/@ouo/browser`.
This is the same mechanism the demo app `examples/web` uses (an npm workspace link, see
`kb/web-demo-storefront.md`), so any rebuild in `sdk/browser` is picked up by your app
without reinstalling:

```bash
npm install /absolute/path/to/ouo/sdk/browser
```

Option B, install from a tarball. Verified with `npm pack --dry-run` in `sdk/browser`:
the tarball is named `ouo-browser-0.2.0.tgz` and contains `dist/index.js`,
`dist/index.d.ts`, the lazily loaded `dist/rrweb-*.js` chunk (plus source maps),
`package.json`, `README.md`, `CHANGELOG.md` and `LICENSE` (614 kB packed, 9 files). Build the tarball inside the ouo repository:

```bash
npm pack -w sdk/browser --pack-destination /tmp
```

Then install it in your app:

```bash
npm install /tmp/ouo-browser-0.2.0.tgz
```

Both methods also pull the `@opentelemetry/*`, `rrweb` and `web-vitals` packages listed in
`sdk/browser/package.json` into your `node_modules`. They are not used at runtime: the
build bundles everything (`noExternal` in `sdk/browser/tsup.config.ts`), so your app loads
one ESM entry of about 40 KB gzipped and downloads rrweb (about 80 KB gzipped) only when
replay is enabled and the session is sampled.

If you are starting a React app from nothing, this is what the demo uses (Node 24, ESM,
TypeScript strict). You do not need any of these if your app already has them:

```bash
npm install react react-dom react-router-dom
```

```bash
npm install -D vite @vitejs/plugin-react typescript @types/react @types/react-dom
```

- `react`, `react-dom`: the app itself.
- `react-router-dom`: client-side routing; the SDK sees route changes through `pushState`.
- `vite`, `@vitejs/plugin-react`: dev server with `import.meta.env.VITE_*` variables, which is how
  the demo passes endpoints in.
- `typescript`, `@types/react`, `@types/react-dom`: the SDK ships `.d.ts`, so you get typed options.

Requirements: `@ouo/browser` is ESM only and needs Node `>=24` for the build tooling
(`engines` in `sdk/browser/package.json`).

## 2. Endpoint, project credentials and environment

The SDK needs one URL and one pair of credentials. All three come from the stack started in
`00-stack.md`:

| Option | Local default | What is behind it |
|---|---|---|
| `endpoint` | `http://localhost:4318` | The collector's OTLP/HTTP receiver. The SDK posts to `/v1/traces` and `/v1/logs`. |
| `replayEndpoint` | derived: `http://localhost:4319` | The collector's replay receiver (`/v1/replay/chunks`). When `endpoint` uses port 4318 the SDK assumes 4319 on the same host; otherwise it uses `endpoint` itself (a proxy such as Caddy routing `/v1/replay/*`, section 7 of the ADR). Set it only when neither applies. |
| `projectId` | `demo` | The project id, used as the HTTP Basic username. |
| `projectToken` | `pt_dev_demo_0000000000000000` | The project's public token, the HTTP Basic password. The collector answers `401` without the right pair. |

**The token is a public identifier, not a secret.** It ships in your JavaScript bundle where
anyone can read it, exactly like every RUM vendor's "public key" or DSN. It only names the
project that telemetry is written into, under the collector's origin, size and rate limits
(ADR-0007). A stock OpenTelemetry SDK can use the same credential with
`OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64(id:token)>`. The local stack is
provisioned with the development values above (`deploy/docker/.env.example`,
`OUO_PROJECT_ID` / `OUO_PROJECT_TOKEN`, hashed into the collector's htpasswd file); for
anything other than the local stack, use the values from your project's configuration. Do not
put a rum-api **read** token in the browser; that one is secret and only Grafana uses it.

Default host ports are in `deploy/docker/.env.example`: Grafana 3000, collector 4318 (OTLP)
and 4319 (replay), demo backend 8081, Loki 3100, Tempo 3200. rum-api is internal: nothing in
the browser needs its port. If you created `deploy/docker/.env` to move ports, use those
values instead everywhere below: for the demo app, copy `examples/web/.env.example` to
`examples/web/.env` (gitignored) and change `VITE_OTLP_ENDPOINT` and `VITE_BACKEND_URL`.

CORS is handled by the collector (both receivers share the `confighttp` settings): the local
config allows `http://localhost:*` and `http://127.0.0.1:*`, and its preflight answer lists
`Authorization`, `Content-Type`, `Content-Encoding`, `traceparent`, `baggage` and the replay
headers (ADR-0007 section 4). So Vite on 5173, 5174, 3001 or any other `localhost` port works
without touching the stack. A CORS error in the console with no `POST` following the
`OPTIONS` means your page's origin is not in the collector's `allowed_origins` (or
`Authorization` is missing from its allowed headers); a `401` on the `POST` means the id or
token is wrong.

The demo reads its endpoint and credentials from Vite env variables. Copy this to `.env` in
your app (ref: `examples/web/.env.example`, adjusted to the stock ports):

```bash
# Collector OTLP/HTTP base URL. The SDK posts to /v1/{traces,logs} and derives :4319/v1/replay/chunks.
VITE_OTLP_ENDPOINT=http://localhost:4318
# HTTP Basic project credentials (Authorization: Basic base64(id:token)). Development values of the local stack.
VITE_OUO_PROJECT_ID=demo
VITE_OUO_PROJECT_TOKEN=pt_dev_demo_0000000000000000
# Your backend. tracing.propagateTo is derived from it.
VITE_BACKEND_URL=http://localhost:8081
# Reported as service.version on every signal.
VITE_APP_VERSION=1.0.0
# Set to 1 to enable SDK debug logging in the browser console.
# VITE_RUM_DEBUG=1
```

## 3. Initialise the SDK before React renders

> **Important: we do this ourselves.** The SDK does not auto-start. You add one module that
> calls `initRUM` and import it as the first side-effect import in `main.tsx`, before
> `App` is imported, so no component can render or `fetch` before the session, the fetch
> instrumentation and the error handlers exist.

Create `src/rum.ts`. This is the demo's file, copy it as is (ref:
`examples/web/src/rum.ts`). Only change `service.name` and, if you do not use the demo's
stub mechanism, drop the two `__OUO_RUM_STUB__` lines:

```ts
// All @ouo/browser usage lives here. Pages import { rum } and never the SDK.
import { initRUM, type RUM } from "@ouo/browser";

declare const __OUO_RUM_STUB__: boolean;

export const USER_STORAGE_KEY = "ouo.demo.user_id";

const env = import.meta.env;

export const config = {
  // The collector is the only host the SDK talks to (ADR-0007): OTLP to ${otlpEndpoint}/v1/{traces,logs},
  // replay chunks to the replay receiver, which the SDK derives as port 4319 when the endpoint is on 4318.
  otlpEndpoint: env.VITE_OTLP_ENDPOINT ?? "http://localhost:4318",
  // HTTP Basic project credentials. The token is public, not a secret: it ships in the bundle and only
  // names the project. These are the development values the local stack is provisioned with.
  projectId: env.VITE_OUO_PROJECT_ID ?? "demo",
  projectToken: env.VITE_OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000",
  backendUrl: env.VITE_BACKEND_URL ?? "http://localhost:8081",
  appVersion: env.VITE_APP_VERSION ?? "1.4.2",
  stub: typeof __OUO_RUM_STUB__ !== "undefined" && __OUO_RUM_STUB__,
  debug: env.VITE_RUM_DEBUG === "1",
} as const;

export function storedUserId(): string | undefined {
  try {
    return localStorage.getItem(USER_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const initialUser = storedUserId();

export const rum: RUM = initRUM({
  endpoint: config.otlpEndpoint,
  projectId: config.projectId,
  projectToken: config.projectToken,
  service: { name: "web-store", version: config.appVersion, environment: "local" },
  tracing: { propagateTo: [new RegExp("^" + escapeRegExp(config.backendUrl))] },
  replay: { enabled: true, maskAllInputs: true },
  ...(initialUser ? { user: { id: initialUser } } : {}),
  debug: config.debug,
});

export function setUser(id: string): void {
  const trimmed = id.trim();
  try {
    if (trimmed) localStorage.setItem(USER_STORAGE_KEY, trimmed);
    else localStorage.removeItem(USER_STORAGE_KEY);
  } catch {
    // storage unavailable; the SDK still gets the user for this page
  }
  if (trimmed) rum.setUser({ id: trimmed });
}
```

Then import it first in `src/main.tsx`. This is the demo's `main.tsx` as is (ref:
`examples/web/src/main.tsx`); the only line that matters for RUM is `import "./rum"`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./rum"; // initialise the SDK before anything renders or fetches
import App from "./App";
import { CartProvider } from "./cart";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <CartProvider>
        <App />
      </CartProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
```

`initRUM` must be called once. A second call logs a warning and returns the first
instance, so React StrictMode double-rendering and Vite HMR are safe. A missing or empty
`projectId` or `projectToken` throws
`[ouo] initRUM: \`projectId\` is required ...` (or `projectToken`) before anything is
installed, so a misconfigured build fails on the first page load instead of posting telemetry
that the collector rejects with `401`.

### The options, one by one

Names, defaults and meanings are taken from `sdk/browser/src/types.ts` and
`sdk/browser/src/index.ts`.

| Option | Default | What it does |
|---|---|---|
| `endpoint` | required | Collector OTLP/HTTP base. Spans go to `<endpoint>/v1/traces`, log records to `<endpoint>/v1/logs`, batched (logs every 1 s, spans every 2 s, 64 per batch) and force-flushed when the tab is hidden or unloaded. |
| `replayEndpoint` | derived | Replay receiver base; chunks go to `<replayEndpoint>/v1/replay/chunks`. Default: `endpoint` with port 4319 when `endpoint` uses port 4318, otherwise `endpoint` itself. You do not need to set it for the local stack. |
| `projectId` | required | Project id, the Basic auth username. Throws at init when missing, empty or containing `:`. |
| `projectToken` | required | Public project token, the Basic auth password. Sent with the id as `Authorization: Basic ...` on every request above. Throws at init when missing or empty. |
| `service.name` | required | `service.name` resource attribute. This is the `service=` filter in rum-api and the `service_name` label in Loki. |
| `service.version` | required | `service.version`, also copied onto every span and log record. Health percentages are grouped by it. |
| `service.environment` | required | `deployment.environment.name`. |
| `tracing.propagateTo` | `[]` | Origins (RegExp or exact string) that get `traceparent` and `baggage`. Same-origin requests always get them. Put your backend origin here. |
| `tracing.ignoreUrls` | `[]` | URLs never traced. The OTLP and replay endpoints are always ignored. |
| `tracing.documentLoad` | `true` | Emit the `documentLoad` span. |
| `replay.enabled` | `true` | When `false` rrweb is never downloaded. |
| `replay.maskAllInputs` | `true` | Every input value is recorded as asterisks. Keep it on unless you have a reason. Add class `ouo-mask` to mask an element's text, `ouo-block` to leave an element out of the recording entirely. |
| `replay.sampleRate` | `1` | Fraction of sessions that get a replay, decided once per session and persisted with it. |
| `replay.flushIntervalMs` | `5000` | Upload a chunk at least this often. |
| `replay.maxChunkBytes` | `262144` | Upload a chunk when the buffer reaches this size. |
| `session.inactivityTimeoutMs` | `1800000` (30 min) | Session ends after this much inactivity. |
| `session.maxDurationMs` | `14400000` (4 h) | Session ends after this total duration. |
| `user.id` | anonymous | Initial user id. Otherwise an anonymous id is generated, persisted under `localStorage["ouo.user"]` and flagged `ouo.user.anonymous=true`. |
| `debug` | `false` | Log every SDK decision to the console with the `[ouo]` prefix (session id, exports, replay uploads). |

About `propagateTo`: the demo derives it from `VITE_BACKEND_URL` with
`new RegExp("^" + escapeRegExp(backendUrl))`. If you have several backend origins, list
them all. A plain string is matched exactly against the request URL, so prefer the RegExp
form for an origin.

## 4. Use the `rum` object in your code

Everything you can call is on the `RUM` interface in `sdk/browser/src/types.ts`:

```ts
import { rum } from "./rum";

rum.setUser({ id: "user-42" });                         // after login; persisted with the session
rum.addEvent("add_to_cart", { product_id: "p-1", qty: 2 }); // custom event, ouo.event.custom=true
rum.captureError(err, { "cart.id": "c-1" });            // handled error, ouo.exception.fatal=false
rum.session.id(); rum.session.userId();                 // for showing in a footer or a support form
rum.replay.pause(); rum.replay.resume(); rum.replay.isRecording();
await rum.flush();                                      // send everything now instead of on the batch timer
```

Set the user as soon as you know it. rum-api uses the latest non-empty `user.id` seen in
the session, so a `setUser` after the session started is fine. The demo stores the id in
`localStorage` and also sends it as `x-user-id` so the backend and the browser agree
(`examples/web/src/api.ts`); copy that file if your backend wants the same.

Do not add `traceparent` or `baggage` headers in your own fetch wrapper. The SDK's fetch
instrumentation adds them to every request whose origin matches `propagateTo`.

## 5. Make your backend accept the headers

Browser requests that carry `traceparent`, `tracestate` and `baggage` to another origin
trigger a CORS preflight. Your backend must answer `OPTIONS` with
`Access-Control-Allow-Headers` that includes those three names (plus whatever you send,
such as `content-type`). The demo backend's exact value is in
`examples/backend/internal/api/cors.go`:

```
content-type, traceparent, tracestate, baggage, x-user-id
```

It also sets `Access-Control-Allow-Origin` to the requesting origin,
`Access-Control-Allow-Methods` and `Access-Control-Max-Age: 600`. If your backend is the
Go one from `10-backend.md`, this is already done. Then the backend's OTel SDK extracts the
trace context and the baggage, and its server span lands under your browser's `fetch` span
in one trace with `session.id` on it.

## 6. Run it and verify

Start your app. For the demo:

```bash
npm run -w examples/web dev
```

Open http://localhost:5173, type a user id in the header, press "Set user", click a
product, "Add to cart". Then get your session id. In the demo it is in the footer. In your
own app, paste this in the browser devtools console (not bash):

```js
JSON.parse(localStorage.getItem("ouo.session")).id
```

Export it for the commands below:

```bash
SID=paste-your-session-id-here
```

What you should see in the browser before touching the stack: with `VITE_RUM_DEBUG=1` the
console shows `[ouo] @ouo/browser@0.2.0 initialised` with `endpoint`, `replayEndpoint`, the
derived `traces`, `logs` and `replay` URLs, `projectId`, session and user (the token is never
logged). The network tab shows `POST http://localhost:4318/v1/logs` and
`POST http://localhost:4318/v1/traces` (status 200, request header
`Authorization: Basic ...`) and `POST http://localhost:4319/v1/replay/chunks` (status 202,
`content-encoding: gzip`, headers `Authorization`, `x-ouo-session-id` and `x-ouo-seq`
counting up from 0). Each one is preceded by an `OPTIONS` preflight the first time, then
cached. If you see `401`, the id or token in `.env` does not match the collector's htpasswd;
a CORS error with no `POST` means your origin is not in the collector's `allowed_origins`.

### rum-api

rum-api is internal (ADR-0007): the browser never calls it, and its read API is locked with
the stack's read token (`OUO_READ_TOKEN`, `rt_dev_0000000000000000` on the local stack; the
Grafana plugin injects it server side). On the local Docker stack it is still reachable from
this host on port 8080 for the checks below. Export the read token once:

```bash
RT='Authorization: Bearer rt_dev_0000000000000000'
```

Sessions started in the last hour:

```bash
curl -s -H "$RT" 'http://localhost:8080/v1/sessions?from=now-1h' | jq '.sessions[] | {session_id, user_id, status, state, event_count, trace_count, has_replay}'
```

What you should see: one record for your session with `platform: "web"`, your
`service_name` and `service_version`, `status: "healthy"` (no errors yet),
`state: "active"`, `has_replay: true`, `replay_kind: "rrweb"`.

One session with its timeline and traces:

```bash
curl -s -H "$RT" "http://localhost:8080/v1/sessions/$SID" | jq '.timeline[] | {ts, type, name}'
```

What you should see: `session.start`, `navigation` (kind `load`), `web_vital` lines (TTFB
at least; FCP, LCP, CLS, INP arrive as the page is used), `navigation` (kind `push`) for the
product page, and your custom event (`add_to_cart` in the demo, `type: "custom"`).

```bash
curl -s -H "$RT" "http://localhost:8080/v1/sessions/$SID" | jq '.traces[] | {trace_id, root_name, root_service, span_count, has_error}'
```

What you should see: one trace per `fetch` (`GET`, `POST`) with `root_service` equal to
your `service.name` and `span_count` greater than 1 when the backend joined the trace.

The replay meta and its events:

```bash
curl -s -H "$RT" "http://localhost:8080/v1/sessions/$SID/replay" | jq '{kind, chunk_count, first_seq, last_seq, bytes}'
```

```bash
curl -s -H "$RT" --compressed "http://localhost:8080/v1/sessions/$SID/replay/events" | head -c 300
```

What you should see: `kind: "rrweb"`, `chunk_count` of at least 1 and growing every 5 s
while the tab is open, and a JSON array whose first events have `type` 4 (meta) and 2 (full
snapshot).

### Loki (session events)

```bash
curl -sG http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode "query={service_name=~\".+\", event_name=~\".+\"} | session_id=\"$SID\"" \
  --data-urlencode "start=$(( $(date +%s) - 3600 ))000000000" \
  --data-urlencode "end=$(date +%s)000000000" \
  --data-urlencode limit=5000 --data-urlencode direction=forward \
  | jq '.data.result[] | [.stream.event_name, .stream.ouo_exception_fatal, .values[0][0]]'
```

What you should see: the same events as the timeline, as Loki streams labelled
`event_name`, with `session_id`, `user_id`, `service_version` and (for exceptions)
`ouo_exception_fatal` as structured metadata. In Grafana Explore the equivalent query is
`{service_name="web-store"} | session_id="<id>"`.

### Tempo (traces by session)

Tempo needs `start` and `end` in Unix seconds, and traces are searchable about 10 s after
export:

```bash
curl -sG http://localhost:3200/api/search \
  --data-urlencode "q={ span.session.id = \"$SID\" }" \
  --data-urlencode start=$(( $(date +%s) - 3600 )) --data-urlencode end=$(date +%s) \
  | jq '.traces[] | {traceID, rootServiceName, rootTraceName, durationMs}'
```

What you should see: one trace per request, `rootServiceName` equal to your
`service.name`. Open one with
`curl -s http://localhost:3200/api/traces/<traceID> | jq` and look for the backend's server
span under the browser span; both carry `session.id` and `user.id` attributes.

### Grafana

Open http://localhost:3000 (admin / testing567). The ouo RUM app plugin is at:

- Overview, `http://localhost:3000/a/ouo-rum-app/overview`: healthy / errored / crashed
  percentages per platform and app version, from `GET /v1/stats/health`.
- Sessions, `http://localhost:3000/a/ouo-rum-app/sessions`: the session list with status,
  user, event and trace counts, replay duration; filters for platform, status, version,
  user. Click your session.
- Session detail, `http://localhost:3000/a/ouo-rum-app/sessions/<id>`: the timeline, the
  traces with "open in Explore" links, and the rrweb player pinned at the top playing the
  chunks you just uploaded with inputs masked.

Explore also works on its own: Tempo with `{ span.session.id = "<id>" }`, Loki with
`{service_name="web-store"} | session_id="<id>"`, and "Logs for this span" from a Tempo
span jumps to Loki filtered on the same `session_id`.

### Make it errored and crashed

To see the other two statuses, from the demo's `/chaos` page: "Handled error"
(`rum.captureError`) or "500 response" turns the session `errored`; "Uncaught error" or
"Unhandled rejection" turns it `crashed`. In your own app: `throw new Error("boom")` in a
click handler, then re-run the sessions curl and check `status`. Note that React 18
development builds re-throw handler errors once more, so `vite dev` reports an uncaught
error twice; the production build reports it once (`kb/web-demo-storefront.md`).

## 7. Quick walk through the demo code (`examples/web/src`)

Read in this order.

- `examples/web/index.html`: the Vite entry, loads `/src/main.tsx` as a module.
- `src/main.tsx`: imports `./rum` first, then mounts `App` inside `BrowserRouter` and
  `CartProvider`. The order of the imports is the whole trick.
- `src/rum.ts`: the only module that imports `@ouo/browser`. Reads the `VITE_*` variables,
  calls `initRUM`, exports `rum`, `config`, `storedUserId` and `setUser`.
- `src/api.ts`: typed `fetch` wrapper for the backend (`getProducts`, `addToCart`,
  `checkout`, fault flags `delay` / `fail`, `ApiError` with status). Sets `x-user-id` only;
  `traceparent` and `baggage` come from the SDK.
- `src/cart.tsx`: React context for the server-side cart; `add()` emits the
  `add_to_cart` custom event through `rum.addEvent`.
- `src/App.tsx`: the route table (`/`, `/products/:id`, `/cart`, `/checkout`,
  `/order/:id`, `/chaos`, 404), all under `Layout`.
- `src/components/Layout.tsx`: header with the "Set user" form (calls `setUser`), footer
  showing `rum.session.id()` and `rum.session.userId()`, and the floating chaos drawer.
- `src/pages/ProductsPage.tsx`, `ProductPage.tsx`, `CartPage.tsx`: plain data fetching and
  cart actions; each `fetch` becomes a span without any RUM code in the page.
- `src/pages/CheckoutPage.tsx`: emits `checkout_submitted`, then `POST /api/checkout`.
  The card number input has class `ouo-mask` and the promo field `ouo-block`, which is
  how you mark sensitive DOM for the replay.
- `src/pages/OrderPage.tsx`, `NotFoundPage.tsx`: receipt from router state; 404.
- `src/components/ChaosPanel.tsx` and `src/pages/ChaosPage.tsx`: one button per signal the
  SDK must capture (slow, 500, timeout, uncaught, unhandled rejection, handled,
  `console.error`, custom event, pause/resume replay, flush). The best place to copy from
  when you want to test a path in your own app.
- `src/components/ProductCard.tsx`: presentational only.
- `src/rum-stub.ts` and `vite.config.ts`: with `VITE_RUM_STUB=1` the alias maps
  `@ouo/browser` to a console-logging stub with the same interface, so the app builds
  before the SDK is built. Optional for you.

## 8. Quick walk through the SDK (`sdk/browser/src`)

Where to look when you want to know what a signal contains.

- `index.ts`: the public entry. `initRUM` validates the credentials and derives the ingest
  URLs, wires the OTel `LoggerProvider` and `WebTracerProvider` with OTLP/HTTP JSON
  exporters (with the `Authorization: Basic` header), starts the session, registers the
  fetch / XHR / document-load instrumentations, installs error capture, navigation and
  Web Vitals, starts the replay recorder, and flushes on `visibilitychange: hidden` and
  `pagehide`. Returns the `RUM` object.
- `ingest.ts`: `deriveIngestUrls` (collector base to `/v1/{traces,logs}`, replay base
  derived 4318 to 4319 or explicit, `/v1/replay/chunks`), `basicAuthorization` (UTF-8 safe
  base64 of `id:token`) and the credential validation. Pure, exported, unit-tested in
  `test/ingest.test.ts`.
- `types.ts`: every option and the `RUM` interface, with defaults in the doc comments.
- `session/manager.ts` (with `storage.ts`, `clock.ts`, `ids.ts`): the session state
  machine. Persists `ouo.session` and `ouo.user`, resumes or rotates on init, inactivity
  and max-duration timers, cross-tab sync through the `storage` event, replay `seq` and
  sampling stored with the session. Emits `session.start` / `session.end`.
- `activity.ts`: which DOM events count as activity (click, keydown, scroll, touchstart,
  pointerdown, tab visible).
- `telemetry/correlation.ts`: the span and log processors that stamp `session.id`,
  `user.id`, `ouo.user.anonymous`, `ouo.platform`, `service.version` and
  `session.previous_id` on every signal.
- `telemetry/propagator.ts`: W3C TraceContext plus Baggage propagator that injects
  `session.id`, `user.id`, `ouo.platform` into `baggage` at inject time.
- `telemetry/resource.ts`, `telemetry/events.ts`: resource attributes (service, browser,
  OS) and the emitter that turns an event into an OTel log record with `event.name`.
- `network.ts`: fetch and XHR instrumentations, `propagateTo` and `ignoreUrls`, and the
  rule that 5xx or status 0 emits `http.request.failed`.
- `errors/install.ts`, `errors/classify.ts`: `window.onerror`, `unhandledrejection`,
  resource load errors and `console.error` capture, and the mapping to
  `exception.*`, `ouo.exception.fatal`, `ouo.exception.handled`, `ouo.exception.kind`.
- `navigation.ts`: patches `history.pushState` / `replaceState`, listens to `popstate`,
  emits `navigation`.
- `vitals.ts`: `web-vitals` callbacks to `web_vital` records.
- `replay/recorder.ts`: lazy `import("rrweb")`, `maskAllInputs`, `ouo-block` /
  `ouo-mask` classes, full snapshot every 5 min, pause / resume, sampling.
- `replay/chunker.ts`: buffers rrweb events, cuts a chunk every 5 s or at 256 KB,
  sequential upload queue with 3 retries and a 2 MB cap.
- `replay/uploader.ts`: gzip with `CompressionStream`, `POST /v1/replay/chunks` with
  `Authorization: Basic`, `x-ouo-session-id` / `x-ouo-seq`, `keepalive` on unload (same
  headers on both paths).
- `logger.ts`, `version.ts`: the `[ouo]` debug logger and the SDK version string.

More detail: `sdk/browser/README.md`, `kb/otel-browser-sdk.md`, `kb/rrweb-chunking.md`.
