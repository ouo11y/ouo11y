# 2026-10-24 quickstart 2: tiny-shop-signals (N41)

## Done

`examples/quickstarts/tiny-shop-signals/`: a standalone copy of tiny-shop (own frontend, backend,
stack; no reference to tiny-shop's files) adding one bite, signals:

- Frontend logs `log.info/warn/error` (`frontend/src/log.js`) on catalog loaded, product viewed,
  added to cart, checkout failed validation (warn), checkout failed (error), order placed.
- Web Vitals (SDK default), explained one line each, with the hidden/automated-tab caveat.
- Backend metrics: `shop.http.requests`, `shop.http.request.duration` (ms histogram),
  `shop.orders{app.order.result}`, exported every 10 s to the collector; provisioned dashboard
  "Tiny Shop API" (Tiny Shop folder).
- Failing path: `POST /api/checkout` returns 500 one time in three (error on `charge card`), so
  sessions become `errored`; README explains healthy / errored / crashed.
- Stack split: `stack/compose.yaml` (only `include:`), `10-collector` (trimmed config: no Sentry
  bridge, no rate limits), `20-tempo`, `30-loki`, `40-mimir`, `50-rum-api`, `60-grafana`; every file
  opens with what / who sends / ports. Pinned `0.3.0` images, `docker login ghcr.io` documented.
- README (what's new first, collapsible what's running / data flow / each file, five-minute run),
  build-it-yourself guide with 27 checked embeds, both indexes, kb note, checklist N41 and N42.

Dependencies added (examples only): `@opentelemetry/sdk-metrics` + `exporter-metrics-otlp-http`
(Node metrics), `@opentelemetry/api-logs` 0.222.0 (frontend logs through the SDK's provider).

## Verified (how)

Clean stack, project `tss-verify`, shifted ports (Grafana 13000, OTLP 14318, replay 14319), API on
5011, Vite on 5183, driven in the built-in browser:

- Loki: app logs (`added to cart` 17, `order placed` 12, `checkout failed` 4, `checkout failed
  validation` 1, ...) with `session_id`, `trace_id`; the plugin's session page lists them under
  **Logs (42)**.
- Vitals: TTFB only while the pane was hidden; after a fronted reload, clicks and navigating away:
  CLS, FCP, INP, LCP, TTFB in Loki and on the session timeline.
- Mimir: `shop_http_requests`, `shop_http_request_duration_bucket`, `shop_orders` (placed 12 /
  failed 4); dashboard panels render data (checked page text after login).
- rum-api via the plugin proxy: the session is `errored` with 4 failed requests.
- `node examples/quickstarts/check-embeds.mjs` in sync; lychee offline on the changed files.

## Left / next

- N42: `@ouo11y/browser` has no `rum.log` API; the example uses `@opentelemetry/api-logs`
  directly. When the SDK gains one, drop `log.js`.
- The stack folder is not generated or checked in CI against `deploy/compose` (the trimmed
  configs differ on purpose); a `compose config` CI check like N29's would catch drift.
- Not in CI: the example run is manual, like tiny-shop.
- Stack `tss-verify` was torn down with `down -v`; no env left running.
