# 2026-10-28: tiny-shop-funnels, rules pass

Brings `examples/quickstarts/tiny-shop-funnels` in line with "Rules for every quickstart" in
`examples/quickstarts/index.md`, with tiny-shop-otel as the reference. Funnels shipped in
rum-api 0.5.0 and grafana 0.5.0 (plugin 0.9.0), so nothing is built from source any more.

## What was done

- **Rule 2, paths:** no `~/Desktop` or `~/ouo11y`. Step 1 is
  `mkdir -p tiny-shop-funnels/backend tiny-shop-funnels/stack tiny-shop-funnels/generate-sessions`
  from wherever the reader keeps projects, then `code .`. Four terminal tabs (API, shop, stack,
  generator) open in `tiny-shop-funnels/`; each step says which one and which folder (`cd backend`,
  `cd stack`, ...). Step 3 makes `frontend/src` itself. README run commands are one per block.
- **Rule 4, images:** `ghcr.io/ouo11y/{collector,rum-api,grafana}:latest`, each with a comment
  naming the tested version and index digest. `build:` blocks, `60-grafana/Dockerfile`,
  `OUO11Y_REPO` and the "clone the repository" step are gone. The README's "Released images" note,
  the "What's running" and "Each file explained" tables and the guide text say so.
- **rum-api 0.5.0 env:** `OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS/PROTOCOL` and `OTEL_SERVICE_NAME`,
  copied from tiny-shop-otel. rum-api now depends on the collector, so the collector no longer
  depends on rum-api (that would be a cycle).
- **New `40-mimir`:** rum-api 0.5.0 also pushes its own metrics. Without a metrics pipeline it
  logged `failed to upload metrics ... 404` every minute. Added `40-mimir` (copied from
  tiny-shop-otel, comment adjusted), the collector's metrics pipeline (the collector config is now
  tiny-shop-otel's plus two replay comments) and the Mimir datasource. Guide step 4: six services,
  9009 in the port check, `OUO_MIMIR_PORT`.
- **Guide step 4** now has 4a files, 4b ghcr.io login (classic token, `read:packages`), 4c port
  check with `stack/.env`, 4d start, as in the reference.
- **Rule 5, packages:** tables after each install: express/cors, react/vite, the backend
  OpenTelemetry packages (with "which Node package is which"), `@ouo11y/browser` (with what it
  brings and its deprecated OTel 2.x dependencies), and `playwright`.
- **`@ouo11y/browser` 0.2.1 -> 0.3.0**, the current release; no API change for this app.
- **Rule 1:** the guide opens with the folder tree and the time.
- **Rule 4, troubleshooting:** a row for a newer `latest` that rejects a config. The rows about
  `OUO11Y_REPO` and `--build` were replaced (an old cached grafana image -> `docker compose pull`).
  The README's "Things that bite" has the same item.
- **`examples/quickstarts/index.md`:** the funnels row no longer says "built from source", the
  build-from-source rule no longer cites funnels, and "Where each quickstart stands" says all / nothing.
- Checklist N47 updated.

## Dependencies

- frontend: `@ouo11y/browser` 0.2.1 -> 0.3.0, the latest release (`npm view` dist-tag `latest`).
- No other dependency changed. Backend packages are the same as tiny-shop-otel's (OpenTelemetry JS
  3.0 / 0.300, none deprecated); generator `playwright` 1.64.1 is the latest.

## How it was verified (2026-10-27 evening, UTC)

- `result/` copied out of the repository to the scratchpad; stack run as compose project
  `tiny-shop-funnels-verify` on 36xxx ports (`stack/.env`: Grafana 36000, OTLP 36318, replay
  36319, Loki 36100, Tempo 36200, Mimir 36009, health 36133). API on 36501, Vite on 36173.
- Images pulled that day at `latest`; digests equal the compose comments:
  collector 0.4.0 `sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2`,
  rum-api 0.5.0 `sha256:1ee9e606220df2c42f4ade4131fdd3f82085d6e814676a771754a85a6ae78336`,
  grafana 0.5.0 `sha256:57607a3616c88867644be1f69abb4681ca73df05d6bf2682543418f0dfeb622f`
  (plugin 0.9.0 per `/api/plugins/ouo11y-rum-app/settings`). Upstream: loki 3.7.7, tempo 3.0.3, mimir 3.2.1.
- Six services up, rum-api healthy; the empty-funnel check returns `a funnel has 2 to 10 steps`.
- `npm run generate` (50 sessions) printed 45 / 37 / 28 / 20 / 10.
- **rum-api through Grafana** (`/api/plugin-proxy/ouo11y-rum-app/rum/v1/...`):
  `POST funnels/query` = 45 / 37 / 28 / 20 / 10 sessions and users; `GET funnels/dropped` step 5 =
  10 sessions, all last on `/checkout`: 6 healthy (abandoned) and 4 errored (`http.request.failed`
  + `exception`, the declined card); `GET funnels/steps` lists the paths and events.
- **Funnels page** in headless Chromium: bars 45 / 37 / 28 / 20 / 10, 22.2%, drop-offs -8 / -9 / -8 / -10.
- **Replay** of declined session `a8a32029-…`: rrweb, 2 chunks, 43 events, the card number not in them.
- **Loki:** that session's lines `session.start`, `navigation`, `add_to_cart`, `checkout_submitted`,
  `http.request.failed`, `exception`, `web_vital`; rum-api's own line `rum-api listening`.
- **Tempo:** that session's error trace: browser `click` -> `POST` -> backend `POST /api/checkout`
  -> `checkout` -> `charge card` (error), every span with `session.id` and `user.id`. rum-api's own
  traces (`GET /v1/funnels/dropped`) are there too.
- **Mimir:** rum-api's `http_*` metrics; no `failed to upload` in rum-api's log.
- Guide intermediates built once: the plain `App.jsx` + `main.jsx` with `vite build`, the plain
  `server.js` with `node --check`.
- `node examples/quickstarts/check-embeds.mjs`: in sync. lychee offline: 0 errors.
- Torn down: `docker compose -p tiny-shop-funnels-verify down -v`; API and Vite stopped.

## For the next agent

- **Loki bodies are the event name** (`navigation`, `add_to_cart`): that is `@ouo11y/browser`
  (N57 on the tiny-shop-replay branch, #68); the example emits no log records of its own. SDK
  follow-up, not changed here.
- **`@ouo11y/browser` 0.3.0 depends on deprecated OTel 2.x browser packages** (N56, same branch);
  the guide says so in its package section.
- tiny-shop-replay (#68) has the same rum-api metrics 404 (no Mimir, no metrics pipeline). Add
  `40-mimir` there too, or turn rum-api's metrics off once it supports that.
