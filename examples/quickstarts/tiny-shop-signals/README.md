# Tiny Shop Signals: logs, Web Vitals, metrics and an errored session

Quickstart 2 of the series. The same small shop as quickstart 1 (an Express API and a React page,
traced end to end), plus the signals that make a session worth looking at: frontend logs, Web
Vitals, backend metrics on a dashboard, and a checkout that fails sometimes. Everything is in this
folder: its own app, its own API and its own stack.

## What's new compared to tiny-shop

| Bite | Where in the code | Where to see it |
|---|---|---|
| **Frontend logs**: `log.info / warn / error` on product viewed, added to cart, checkout failed validation, checkout failed, order placed | [`frontend/src/log.js`](result/frontend/src/log.js), [`App.jsx`](result/frontend/src/App.jsx) | Loki, and the **Logs** section of the session page |
| **Web Vitals**: FCP, LCP, CLS, INP, TTFB | on by default in [`rum.js`](result/frontend/src/rum.js) | the session timeline, and Loki `event_name="web_vital"` |
| **Backend metrics**: request count, duration histogram, orders by result | [`backend/server.js`](result/backend/server.js), [`instrumentation.js`](result/backend/instrumentation.js) | Mimir, and the provisioned **Tiny Shop API** dashboard |
| **A failing path**: one checkout in three answers 500 | `POST /api/checkout` in `server.js` | sessions marked `errored` in the ouo11y RUM app |
| **A readable stack**: one folder per service, each file opens with what it is for | [`stack/`](result/stack/compose.yaml) | `docker compose up -d` in `stack/` |

<details>
<summary><b>What's running</b></summary>

| Service | Folder | Port on your machine | Job |
|---|---|---|---|
| ouo-collector | `stack/10-collector` | 4318 (OTLP), 4319 (replay) | the only ingest; checks the project credential, routes each signal |
| Tempo | `stack/20-tempo` | 3200 (loopback) | traces |
| Loki | `stack/30-loki` | 3100 (loopback) | logs and browser events |
| Mimir | `stack/40-mimir` | 9009 (loopback) | metrics |
| rum-api | `stack/50-rum-api` | none | sessions (healthy / errored / crashed) and replays, for the plugin |
| Grafana + ouo11y RUM app | `stack/60-grafana` | 3000 | the UI, admin / testing567 |
| the API | `backend/` | 5001 | Express, OpenTelemetry Node SDK |
| the web app | `frontend/` | 5173 | React, `@ouo11y/browser` |

</details>

<details>
<summary><b>How the data flows</b></summary>

```
browser (frontend/, @ouo11y/browser)            Node API (backend/, OTel Node SDK)
  spans, events, logs, web vitals, replay          spans, metrics
            │  OTLP/HTTP :4318, replay :4319              │  OTLP/HTTP :4318
            └──────────────────────┬──────────────────────┘
                                   ▼
                     ouo-collector (10-collector)
          traces ──► Tempo     logs ──► Loki     metrics ──► Mimir
          replay chunks ──► rum-api
                                   │
     rum-api reads Loki + Tempo to build sessions and their status
                                   ▼
          Grafana (60-grafana): Explore, Tiny Shop API dashboard,
                     More apps -> ouo11y RUM -> Sessions
```

</details>

<details>
<summary><b>Each file explained</b></summary>

| File | What it does |
|---|---|
| `result/frontend/src/rum.js` | `initRUM`: sessions, errors, fetch tracing with `traceparent` to the API, Web Vitals, replay |
| `result/frontend/src/log.js` | `log.info / warn / error`: OpenTelemetry log records through the logger provider the SDK registers, so they carry the session id |
| `result/frontend/src/App.jsx` | the shop: View, Add, an email field, Checkout; one log per meaningful event |
| `result/frontend/src/main.jsx` | imports `./rum` before React renders |
| `result/backend/instrumentation.js` | OTel Node SDK: trace and metric exporters with the project credential, http + express auto-instrumentation |
| `result/backend/server.js` | the API: `GET /api/products`, `POST /api/checkout` (fails one time in three), manual spans, three metrics |
| `result/stack/compose.yaml` | only `include:` lines, one per service folder |
| `result/stack/10-collector/` | `compose.yaml`, `config.yaml` (pipelines), `projects.htpasswd` (the `demo` project) |
| `result/stack/20-tempo/`, `30-loki/`, `40-mimir/` | `compose.yaml` and the store's `config.yaml` |
| `result/stack/50-rum-api/` | `compose.yaml` and `config.yaml` (where Loki and Tempo are, session timeouts) |
| `result/stack/60-grafana/` | `compose.yaml`, `provisioning/` (datasources, the plugin, the dashboard folder) and `dashboards/tiny-shop-api.json` |

</details>

Two ways to use it:

- **Build it yourself:** [build-it-yourself-guide.md](build-it-yourself-guide.md) writes every file
  in order, the plain app first, then each signal. About 30 minutes.
- **Run the finished result** in five minutes, below.

## Run it in five minutes

Needs Node 24 and Docker Compose 2.24 or later. Commands have no `$` prompt; each runs from the
folder named above it.

**1. The stack.** The ouo images are private for now, so log in to ghcr.io once with a GitHub
token that has `read:packages`:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

From `result/stack`:

```bash
docker compose up -d
```

**2. The API.** From `result/backend`:

```bash
npm install && npm start
```

It prints `[otel] traces and metrics to http://localhost:4318`.

**3. The web app.** From `result/frontend`, in a second terminal:

```bash
npm install && npm run dev
```

Open http://localhost:5173 **in a normal browser tab and keep it in front.** Click **View** and
**Add** on a few products, **Checkout** once with the email empty (a validation warning), then type
an email and check out five or six times: about one in three fails. Finally open another tab or
reload: the browser reports LCP, CLS and INP when the page is hidden.

## See it in Grafana

http://localhost:3000, admin / testing567. Allow a minute for the first data.

### Frontend logs

Explore -> Loki:

```logql
{service_name="tiny-shop-signals-frontend"} | scope_name="tiny-shop-signals-frontend"
```

`scope_name` keeps only the app's own logs (the SDK's events have `@ouo11y/browser`). Only the
problems: add `| severity_text=~"WARN|ERROR"`. One session: `| session_id="<id>"`. Each line has a
**View trace** link when it was logged during a traced click.

On the session page (More apps -> ouo11y RUM -> Sessions -> a session) the **Logs** section lists
the same lines, next to the timeline, the replay and the traces.

### Web Vitals

| Vital | In one line | Good |
|---|---|---|
| TTFB | time to first byte: how long the server took to start answering the page | < 800 ms |
| FCP | first contentful paint: when the first text or image appeared | < 1.8 s |
| LCP | largest contentful paint: when the main content appeared | < 2.5 s |
| CLS | cumulative layout shift: how much the page jumped around while loading (no unit) | < 0.1 |
| INP | interaction to next paint: the slowest reaction to a click or key press | < 200 ms |

They are on the session timeline ("Web vital LCP 812 (good)") and in Loki:

```logql
{service_name="tiny-shop-signals-frontend", event_name="web_vital"}
```

**A hidden or automated tab drops FCP and LCP.** Browsers only report paint timings for a page
that was visible while it loaded, and LCP, CLS and INP are sent when the page is hidden or
unloaded. A tab opened in the background, or driven by a test tool, may report TTFB only. Click
around in a real foreground tab, then switch tab or reload.

### Backend metrics

Dashboards -> Tiny Shop -> **Tiny Shop API**: requests per second by route and status, p50 / p95
duration, orders placed and checkouts failed. In Explore -> Mimir:

```promql
sum by (http_route, http_response_status_code) (rate(shop_http_requests[1m]))
histogram_quantile(0.95, sum by (le) (rate(shop_http_request_duration_bucket[1m])))
sum by (app_order_result) (shop_orders)
```

OpenTelemetry names (`shop.http.requests`) become Prometheus names with underscores. The stack
keeps them without the `_total` suffix (`otel_metric_suffixes_enabled: false` in Mimir's config).

### An errored session

More apps -> ouo11y RUM -> Sessions. Every session gets a status (ADR-0004):

- **healthy**: no error at all.
- **errored**: something went wrong and the user carried on: a handled exception
  (`rum.captureError`) or a failed HTTP request (`http.request.failed`, like the checkout 500).
- **crashed**: an uncaught error (on the web the page keeps running, but the session is marked) or
  a fatal app crash on mobile.

A session that hit a failed checkout is `errored`, with "Failed request 500" on its timeline and
the `checkout failed` log line in its Logs section. The rules are in
[the session lifecycle spec](../../../docs/specs/session-lifecycle.md).

## Ports

Ports taken? Export the new ports before `docker compose up -d` (in `result/stack`):

```bash
export OUO_GRAFANA_PORT=13000 OUO_OTLP_HTTP_PORT=14318 OUO_REPLAY_PORT=14319
```

Then `OUO_OTLP_ENDPOINT=http://localhost:14318 npm start` for the API, and in
`frontend/.env.local`:

```
VITE_OUO_ENDPOINT=http://localhost:14318
VITE_OUO_REPLAY_ENDPOINT=http://localhost:14319
```

The API on another port: `PORT=5002 npm start` and `VITE_API_URL=http://localhost:5002` in
`frontend/.env.local`. The web app must stay on `localhost` or `127.0.0.1`, the only origins the
collector allows.

## Clean up

From `result/stack`: `docker compose down` (add `-v` to delete the data), then stop both `npm`
commands with Ctrl+C.

## Things that bite

- **Frontend logs need no extra exporter.** `@ouo11y/browser` registers the global OpenTelemetry
  logger provider; `log.js` only asks it for a logger. Pin `@opentelemetry/api-logs` to the version
  the SDK uses (0.222.0 for 0.2.1) so npm installs one copy.
- **`increase()` on a fresh counter undercounts.** The first sample has nothing before it, so the
  dashboard's totals read the counter itself (`sum(shop_orders{...})`), which resets when the API
  restarts.
- **Every OTLP request needs the project credential**, the API's metrics too: without
  `Authorization: Basic ...` the collector answers 401.
- **`propagateTo` strings must equal the whole URL**; `rum.js` uses a RegExp.
