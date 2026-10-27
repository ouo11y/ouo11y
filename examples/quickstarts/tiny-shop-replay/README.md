# Tiny Shop Replay: session replay, masking, rage and dead clicks

Quickstart 4 of the series. A small shop (an Express API and a React page, traced end to end) with
session replay turned on: watch what a shopper did, check that their password and card number
never left the browser, spot the buttons that frustrate them, and jump from the moment a checkout
failed to its trace and its error. Everything is in this folder: its own app, its own API and its
own stack.

Two ways to use it:

- **Build it yourself:** [build-it-yourself-guide.md](build-it-yourself-guide.md) writes every file
  in order, with a check after each step. About 30 minutes.
- **Run the finished result** in five minutes, below.

## What's new in this quickstart

| Bite | Where in the code | Where to see it |
|---|---|---|
| **Replay on, with sampling**: `replay.sampleRate` and `replay.onErrorSampleRate` | [`frontend/src/rum.js`](result/frontend/src/rum.js) | the **Replay** panel of a session page |
| **Masking**: every input masked, `ouo-block` hides an element, `ouo-mask` hides a text | [`frontend/src/App.jsx`](result/frontend/src/App.jsx) | the replay: asterisks and an empty box |
| **Rage and dead clicks**: a button that does nothing, a button that takes 3 s | `Apply coupon`, `Track my order` in `App.jsx`; `/api/orders/track` in [`server.js`](result/backend/server.js) | `ouo.dead_click`, `ouo.rage_click` on the session timeline |
| **Replay -> trace -> error**: a checkout with card `4000 0000 0000 0002` fails with a 500 | `POST /api/checkout` in `server.js` | session page: timeline, replay, Traces |
| **Where replay is stored and what it costs** | [`stack/50-rum-api/config.yaml`](result/stack/50-rum-api/config.yaml) | [below](#where-replay-goes-and-what-it-costs) |

<details>
<summary><b>What's running</b></summary>

| Service | Folder | Port on your machine | Job |
|---|---|---|---|
| ouo-collector | `stack/10-collector` | 4318 (OTLP), 4319 (replay) | the only ingest; checks the project credential, routes each signal |
| Tempo | `stack/20-tempo` | 3200 (loopback) | traces |
| Loki | `stack/30-loki` | 3100 (loopback) | browser events: clicks, rage and dead clicks, errors |
| rum-api | `stack/50-rum-api` | none | sessions (healthy / errored / crashed) and the replay store |
| Grafana + ouo11y RUM app | `stack/60-grafana` | 3000 | the UI, admin / testing567 |
| the API | `backend/` | 5001 | Express, OpenTelemetry Node SDK |
| the web app | `frontend/` | 5173 | React, `@ouo11y/browser` 0.3.0 |

</details>

<details>
<summary><b>How the data flows</b></summary>

```
browser (frontend/, @ouo11y/browser)               Node API (backend/, OTel Node SDK)
  spans, events  ──► :4318                            spans ──► :4318
  replay chunks  ──► :4319 (gzipped rrweb, every 5 s)
            └────────────────────────┬──────────────────────┘
                                     ▼
                       ouo-collector (10-collector)
            traces ──► Tempo     events ──► Loki     replay ──► rum-api
                                     │
           rum-api builds sessions from Loki + Tempo, stores replay chunks
                                     ▼
       Grafana (60-grafana): More apps -> ouo11y RUM -> Sessions -> a session
              timeline + replay + traces + logs on one page
```

</details>

<details>
<summary><b>Each file explained</b></summary>

| File | What it does |
|---|---|
| `result/frontend/src/rum.js` | `initRUM`: sessions, errors, fetch tracing with `traceparent` to the API, replay with its sampling, click signals |
| `result/frontend/src/App.jsx` | the shop: Add, a blocked partner banner, Apply coupon (dead), Track my order (slow), a checkout form, a masked shipping line |
| `result/frontend/src/main.jsx` | imports `./rum` before React renders |
| `result/backend/instrumentation.js` | OTel Node SDK: trace exporter with the project credential, http + express auto-instrumentation |
| `result/backend/server.js` | the API: products, a 3 s order tracker, a checkout that declines card `...0002` |
| `result/stack/compose.yaml` | only `include:` lines, one per service folder |
| `result/stack/10-collector/` | `compose.yaml`, `config.yaml` (pipelines, the replay receiver), `projects.htpasswd` (the `demo` project) |
| `result/stack/20-tempo/`, `30-loki/` | `compose.yaml` and the store's `config.yaml` |
| `result/stack/50-rum-api/` | `compose.yaml` and `config.yaml` (Loki, Tempo, session timeouts, replay storage) |
| `result/stack/60-grafana/` | `compose.yaml` and `provisioning/` (datasources, the plugin) |

</details>

## Run it in five minutes

Needs Node 24 and Docker Compose 2.24 or later. Commands have no `$` prompt; each runs from the
folder named above it.

**1. The stack.** The ouo images are private for now, so log in to ghcr.io once with a GitHub
token that has `read:packages`:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

From `result/stack` (ports taken? see [Ports](#ports) first):

```bash
docker compose up -d
```

**2. The API.** From `result/backend`:

```bash
npm install && npm start
```

**3. The web app.** From `result/frontend`, in a second terminal:

```bash
npm install && npm run dev
```

**4. Shop like a frustrated customer.** Open http://localhost:5173 and:

1. **Add** a coffee.
2. Click **Apply coupon** once. Nothing happens: a dead click.
3. Click **Track my order** four times quickly. It answers after 3 s: a rage click.
4. Fill the form with made-up values: a name, an email, a password, and card
   `4000000000000002`. Click **Checkout**: "Payment failed". Click it once more.
5. Change the card to `4242424242424242` and check out: the order is placed.

## See it in Grafana

http://localhost:3000, admin / testing567. More apps -> ouo11y RUM -> **Sessions**. Your session
is `errored`; click it. Replay chunks arrive every 5 seconds, so allow a few seconds.

### The replay

The **Replay** panel plays the session; the strip under it marks taps, errors and failed
requests. Clicking an item on the **Timeline** seeks the replay to that moment.

### Masking: check it in the replay

| On the page | In the replay | Why |
|---|---|---|
| name, email, card number | `*****` | `maskAllInputs: true` (the default) masks every `<input>` value at record time |
| account password | `*****` | `type="password"` is always masked by rrweb, whatever the options |
| the yellow partner banner | an empty space | `className="ouo-block"`: the element and its children are not recorded |
| "Shipping to Jane Doe" | `Shipping to **** ***` | `className="ouo-mask"`: the text is recorded as asterisks of the same length |

Masking happens in the browser, so the values never reach the collector. Check the stored chunks
yourself (from `result/stack`):

```bash
docker run --rm -v tiny-shop-replay_rum-api-data:/d alpine sh -c 'zcat /d/replays/*/*.json.gz' | grep -c 4000000000000002
```

It prints `0`. To hide an element you cannot put a class on, a third-party widget for example,
`@ouo11y/browser` 0.3.0 also takes CSS selectors next to the classes: `replay.blockSelector` and
`replay.maskTextSelector` in `rum.js`.

### Rage and dead clicks

On the timeline:

- `ouo.dead_click` on **Apply coupon**: a button click after which nothing changed in the page and
  no request was sent. The usual cause is a broken handler or a disabled-looking button.
- `ouo.rage_click` on **Track my order**, with `ouo_click_count=4`: three or more clicks within one
  second in one spot. The usual cause is a slow action without feedback.

Both are WARN log records, so you can count them across sessions in Explore -> Loki:

```logql
sum by (app_widget_name) (count_over_time({service_name="tiny-shop-replay-frontend", event_name=~"ouo.rage_click|ouo.dead_click"}[1h]))
```

### From a replay moment to its trace and its error

1. On the **Timeline**, click **Error: checkout failed: card declined**. The replay jumps to the
   click on Checkout.
2. Under **Traces**, the `click` trace that starts at that second has status **error**. Click
   **Open in Explore**.
3. The trace shows the browser's `click` and `POST`, then the API's `POST /api/checkout`,
   `checkout` and **`charge card`** in red, with the exception "card declined by payment
   provider". The browser's `traceparent` header is what joins the two halves.

## Where replay goes and what it costs

**Path.** The SDK records with rrweb, buffers events, and every 5 seconds (or at 256 KB) POSTs one
gzipped chunk to the collector's replay port, 4319, with the project credential. The collector
forwards it unchanged to rum-api, which is not reachable from outside the stack. The page talks to
the collector only.

**Storage.** rum-api writes chunks under `replays/<session id>/` (`000000.json.gz`, `000001...`,
plus `meta.json`). This stack uses `backend: filesystem` on the `rum-api-data` volume. For more
than one rum-api or for retention rules, set `backend: s3` with MinIO or any S3 bucket: the
commented example is in [`stack/50-rum-api/config.yaml`](result/stack/50-rum-api/config.yaml).

**Bytes.** Measured on this quickstart, one 13 s session with the clicks above: 3 chunks,
2.6 KB gzipped (15 KB of rrweb JSON). A real page with more DOM and more mutations costs more,
about a full snapshot (the DOM) on load and every 5 minutes, plus the changes in between.
Canvas, fonts and images are not recorded.

**CPU.** rrweb observes DOM mutations and input events; the cost grows with how much the page
changes, not with time. Chunks are gzipped asynchronously with the browser's native
`CompressionStream` (sent uncompressed where it is missing). Turn replay off with `replay: { enabled: false }`: rrweb is then never
loaded.

**Sampling.** The cheapest replay is the one you don't record:

| Setting | Effect |
|---|---|
| `session.sampleRate: 0.5` | half the sessions send nothing at all, replay included |
| `replay.sampleRate: 0.1` | of those sessions, one in ten is recorded from the first page |
| `replay.onErrorSampleRate: 1` | every other session keeps the last 30 to 60 s in memory and uploads it, and the rest of the session, after its first error |

The decision is made once per session from the session id and kept, so a session is never half
recorded. Try `sampleRate: 0, onErrorSampleRate: 1` in `rum.js`: only the sessions where checkout
failed get a replay, starting up to a minute before the error.

<details>
<summary><b>rum.js, the whole file</b></summary>

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

## Ports

The stack publishes 3000 (Grafana) and the collector's 4318 (OTLP) and 4319 (replay) to your
network, and 3100 (Loki), 3200 (Tempo) and 13133 (collector health) on loopback only. The API
uses 5001 and the web app 5173. This prints nothing when the stack's ports are all free:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|3100|3200|4318|4319|13133) '
```

If something is listed, do not stop it: move this stack instead. Create `stack/.env` (Compose
reads it on its own) with the ports that are taken, for example:

```
OUO_GRAFANA_PORT=13000
OUO_OTLP_HTTP_PORT=14318
OUO_REPLAY_PORT=14319
```

The others are `OUO_LOKI_PORT`, `OUO_TEMPO_PORT` and `OUO_COLLECTOR_HEALTH_PORT`. Then
`OUO_OTLP_ENDPOINT=http://localhost:14318 npm start` for the API, and in
`frontend/.env.local`:

```
VITE_OUO_ENDPOINT=http://localhost:14318
VITE_OUO_REPLAY_ENDPOINT=http://localhost:14319
```

The API on another port: `PORT=5002 npm start` and `VITE_API_URL=http://localhost:5002` in
`frontend/.env.local`. The web app must stay on `localhost` or `127.0.0.1`, the only origins the collector allows.

## Clean up

From `result/stack`: `docker compose down` (add `-v` to delete the data and the replays), then
stop both `npm` commands with Ctrl+C.

## Things that bite

- **A 4xx is not a failed request.** Only 5xx and network errors count (ADR-0004), so the decline
  answers 500. A 402 would show the error but not "failed request".
- **The error event has no trace id.** `rum.captureError` runs after `await fetch`, when the click
  span is no longer the active context, so the error and the trace are matched by time on the
  session page, not by id.
- **Fast automated clicks make rage clicks on anything**, inputs included: the detector looks at
  clicks in one spot, not at the element.
- **A newer `latest` can reject a config.** The ouo images use `:latest`; the comment above each
  `image:` line names the version this quickstart was tested with and its digest. If a service
  keeps restarting after a pull, `docker compose logs <service>` names the config key; pin the
  tested version there.
- **Replay needs the replay port too.** If you move 4318, set `VITE_OUO_REPLAY_ENDPOINT`; the SDK
  derives 4319 only from an endpoint on 4318.
