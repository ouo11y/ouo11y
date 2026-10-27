# 2026-10-27 — tiny-shop-signals against the quickstart rules (PR #67)

Brought `examples/quickstarts/tiny-shop-signals` in line with
[the rules for every quickstart](../../../../examples/quickstarts/index.md#rules-for-every-quickstart),
with `tiny-shop-otel` as the reference. Rebased PR #67 onto `main` (after #88 and #96).

## What changed, rule by rule

1. **Shape.** The guide now builds the plain app first (an Express API and a Vite React page, no
   telemetry), then the stack, then the instrumentation. It opens with what you build, the folder
   tree and the time it takes (about 40 min), and ends with clean-up and a troubleshooting table.
2. **Paths and commands.** `mkdir -p tiny-shop-signals/backend tiny-shop-signals/stack`, three
   terminal tabs that open in `tiny-shop-signals/`, and every command says which folder it runs in.
   One command per block: `npm install && npm start` and the joined `curl`s are split, and the
   README's clean-up is now in blocks. "Replace the file" is explained once at the top.
3. **Stack.** It already had the folder layout. Added the guide's 4a–4d (files, ghcr.io login,
   port check with `lsof`, start) and ports moved through `stack/.env`, not `export` (README too).
4. **Images.** collector, rum-api and grafana are on `:latest`, with a comment above each `image:`
   naming the tested version and digest (the same as tiny-shop-otel). rum-api gets
   `OTEL_EXPORTER_OTLP_*` pointed at the collector and `depends_on: otel-collector`. The
   troubleshooting table has the "newer `latest` rejects a config" row. Configs are byte-identical
   to tiny-shop-otel's, which were verified on rum-api 0.5.0 and grafana 0.5.0.
5. **Packages.** A table for each install (`express`/`cors`, the Vite template, the 11 backend
   OpenTelemetry packages, the frontend's two). A "Which OpenTelemetry logs package is which?"
   block: `api-logs` (used, pinned 0.222.0), `logs` from `@opentelemetry/api` 1.10 (current, but a
   different global the SDK does not register with), `sdk-logs`/exporter (inside the SDK),
   `api-events`/`sdk-events` (deprecated on npm). It also says that `@ouo11y/browser` 0.3.0 still
   depends on the deprecated `sdk-trace-web` and `instrumentation-fetch`.
   `@ouo11y/browser` bumped from `^0.2.1` to `^0.3.0`, `vite` from `^8.3.4` to `^8.3.5`. No new
   dependency. Lockfiles regenerated in the scratchpad (npm fails inside the worktree).
6. **Readable telemetry.** The app's logs already had the message as their body. The SDK's
   `web_vital` events have `web_vital` as their body (an SDK choice), so the guide and README
   query them with a `line_format` that prints `LCP 96 ms good` / `CLS 0.002 good`.
7. **Embeds.** All stack, backend and frontend files are embedded and checked.
8. Not an alternative to an ouo component, so no trade-offs step.

Also: the dashboard's "Checkouts per minute" panel drew `failed` in green; it now has fixed colours
(placed green, failed red). The checklist follow-up for the SDK log API was `N42`, which `main`
already uses: it is now **N54**.

## Verified (rule 9)

- Images pulled today, `:latest` digests equal to the comments:
  collector 0.4.0 `sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2`,
  rum-api 0.5.0 `sha256:1ee9e606220df2c42f4ade4131fdd3f82085d6e814676a771754a85a6ae78336`,
  grafana 0.5.0 (plugin 0.9.0) `sha256:57607a3616c88867644be1f69abb4681ca73df05d6bf2682543418f0dfeb622f`.
- `result/` copied out of the repo, compose project `tiny-shop-signals-verify`, ports 35000 (Grafana),
  35318/35319 (collector), 35100/35200/35009/35133 (loopback) from `stack/.env`; API on 35001, Vite
  on 35173. All six services up, rum-api healthy, no error or warning lines from rum-api or the
  collector, rum-api's own traces in Tempo.
- Intermediate files built once: the guide's plain `server.js` (3 of 12 checkouts answered 500)
  and the plain `App.jsx` in a fresh `npm create vite@latest` app (`vite build` OK).
- Headless Chromium (Playwright 1.64.1): View, Add, Checkout with no email, then 8 and 10
  checkouts with an email, then hide the page.
  - **Loki:** app lines `catalog loaded`, `product viewed`, `added to cart`,
    `checkout failed validation` (WARN), `checkout failed` (ERROR), `order placed`, each with
    `session_id`; vitals through the `line_format` query: `TTFB 5 ms good`, `FCP 96 ms good`,
    `LCP 96 ms good`, `INP 40 ms good`, `CLS 0.002 good`.
  - **Tempo:** `charge card && status = error` finds the failed checkouts; one trace from the
    browser `click` -> `POST` -> `POST /api/checkout` -> `checkout` -> `charge card` (error),
    `session.id` on every span.
  - **Mimir:** `shop_http_requests`, `shop_http_request_duration_bucket` (p95 195 ms),
    `shop_orders` 21 placed / 5 failed; the "Tiny Shop API" dashboard in the Tiny Shop folder shows
    all five panels (screenshot checked, before and after the colour fix).
  - **ouo11y RUM** via `/api/plugin-proxy/ouo11y-rum-app/rum/v1/sessions`: the session with failures
    is `errored`, 3 failed requests, 13 traces, rrweb replay; the one without failures is `healthy`.
    The session page (screenshot) shows the timeline with vitals and "Failed request 500", the
    replay, the traces and the Logs section with the app's lines.
- `node examples/quickstarts/check-embeds.mjs`: in sync. `lychee --offline` on the changed
  Markdown: 0 errors.
- Torn down: `docker compose -p tiny-shop-signals-verify down -v`, the API and Vite PIDs killed.

## Left / for the next agent

- `@ouo11y/browser`: a log API (N54), a readable body for its own events (`LCP 96 ms good` rather
  than `web_vital`), `SDK_VERSION` still `0.2.0` in 0.3.0, and moving to OpenTelemetry JS 3.0
  (`sdk-trace`, `browser-instrumentation`, `@opentelemetry/api` `logs`). When the SDK moves,
  drop the `api-logs` pin and the "which logs package" block.
- Express 5 prints the `app.listen` message even on `EADDRINUSE` (kb).
- PR #68 (tiny-shop-replay) touches the same README and index rows: whichever lands second rebases.
