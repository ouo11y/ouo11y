# Funnels: what was non-obvious

Context: funnel reports (N46, ADR-0012, `docs/specs/funnels.md`), 2026-10-24.

- **Labels vs metadata in Loki.** `service_name`, `deployment_environment_name`, `ouo_platform`,
  `ouo_project_id` and `event_name` are stream labels (`deploy/compose/loki/config.yaml`,
  `otlp_config`), so funnel filters go in the selector; `service_version`, `session_id`,
  `user_id`, `url_path` and `ouo_event_custom` are structured metadata, filtered after a `|`.
- **`sum by (url_path)` works on structured metadata** in Loki 3: one instant query
  `sum by (url_path) (count_over_time({event_name="navigation"} [3600s]))` lists every path with
  its count. rum-api's `GET /v1/funnels/steps` uses it (`loki.Client.Counts`), much cheaper than
  pulling the events.
- **One query per step kind, not per step.** Pages: `{event_name="navigation"} | url_path=~"/|/products/.*"`
  (Loki regex filters are fully anchored); events: `{event_name=~"add_to_cart|order_paid"}`.
  Escape values with `regexp.QuoteMeta`, then `strconv.Quote`.
- **POST is a read.** `readAuth` only covered GET / DELETE / HEAD; `POST /v1/funnels/query` had
  to be added explicitly, or the read token would not protect it.
- **Custom events** from `rum.addEvent` carry `ouo.event.custom=true` (`ouo_event_custom` in
  Loki); OTel `logger.emit` records without `event.name` are not events and cannot be steps.
- **Grafana `Combobox` in jsdom** needs a canvas: mock `HTMLCanvasElement.prototype.getContext`
  with a `measureText` (see `plugins/ouo11y-rum-app/src/pages/Funnels.test.tsx`).
- **Generating sessions with a known answer**: Playwright, one browser context per session (fresh
  storage = new session and user), leave through `about:blank` so the SDK flushes at pagehide.
  Personas with a fixed depth give the exact per-step count to compare with
  (`examples/quickstarts/tiny-shop-funnels/result/generate-sessions/generate.mjs`); it matched
  rum-api exactly on three stacks.
- **npm inside some agent worktrees** fails with "Exit prior to config file resolving / call
  config.load() before reading values" for any command, `npm --version` included, while it works
  in the main checkout. Workaround: run from outside, `cd /tmp && npm --prefix <dir> ...`, and call
  `node_modules/.bin/{jest,tsc,eslint}` directly. `ouo-env up` runs `npm run build` in the checkout
  and hits it too: build the plugin first and write `git rev-parse HEAD` to
  `plugins/ouo11y-rum-app/dist/.ouo-env-built` so it skips the build. Cause not found.
