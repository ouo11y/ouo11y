# Quickstart signals: frontend logs, vitals, Node metrics (tiny-shop-signals)

Learned building `examples/quickstarts/tiny-shop-signals` (2026-10-24) against the 0.3.0 images
and `@ouo11y/browser` 0.2.1.

- **No `rum.log` API in `@ouo11y/browser` 0.2.1.** The `RUM` interface has `addEvent`,
  `captureError`, `setUser`, `setRoute`, nothing for plain logs. It does call
  `logs.setGlobalLoggerProvider`, so an app gets session-tagged logs with
  `logs.getLogger(name).emit({ severityNumber, severityText, body, attributes })` from
  `@opentelemetry/api-logs`. Pin `@opentelemetry/api-logs` to the SDK's exact version (0.222.0) so
  npm dedupes it; a second copy can miss the global provider. The `SessionLogProcessor` adds
  `session.id`, `user.id`, page and route to these records like to the SDK's own events.
- **Telling app logs from SDK events in Loki:** both are `service_name=<app>`; the app's have
  `scope_name=<logger name>`, the SDK's `scope_name="@ouo11y/browser"`. Filter with
  `| scope_name="..."`. Severity alone does not separate them (SDK events are INFO too).
- **The plugin session page shows them** in its **Logs (n)** section; the **Timeline** lists only
  SDK events (vitals, failed requests, navigation, rage clicks).
- **Vitals:** a page loaded in a background or automated tab reports TTFB only. In a fronted tab,
  FCP/LCP/CLS/INP arrive after the page is hidden (navigate away or switch tab).
- **Node metrics to Mimir:** `NodeSDK({ metricReaders: [new PeriodicExportingMetricReader({ exporter })] })`
  (sdk-node 0.300, sdk-metrics 3.0). With `otel_metric_suffixes_enabled: false` a counter
  `shop.orders` is `shop_orders` (no `_total`), a ms histogram `shop.http.request.duration` is
  `shop_http_request_duration_bucket` (no unit suffix). Attributes `http.route` -> `http_route`.
- **`increase(counter[$__range])` undercounts** on a counter that starts inside the range (the
  first sample has no predecessor): a "total" stat should read the counter itself.
- **Split stack with `include:`:** each included file resolves its relative bind mounts against its
  own folder, and `depends_on` across included files works. Port overrides were verified with
  exported shell variables. Mounting the whole `provisioning/` folder read-only logs a harmless
  `can't read alerting provisioning files` error.
- **Grafana image without a data volume:** the plugin the `ghcr.io/ouo11y/grafana` image ships in
  `/var/lib/grafana/plugins` stays visible, so the full stack's plugin-copy init container is not
  needed.
- **`logs` from `@opentelemetry/api` 1.10 is not a substitute (2026-10-27).** OpenTelemetry JS 3.0
  moved the logs API into the stable API, but it stores its provider under the
  `opentelemetry.js.api.1` global, while `@opentelemetry/api-logs` uses
  `Symbol.for("io.opentelemetry.js.api.logs")`. `@ouo11y/browser` 0.3.0 (OTel JS 2.x) registers
  only with the latter, so a logger from `@opentelemetry/api` drops every record silently. Checked
  in Node with both packages side by side. `@ouo11y/browser` 0.3.0 still pins `api-logs` 0.222.0.
- **SDK events have their name as the Loki line** (`web_vital`, `body: name` in
  `sdk/browser/src/telemetry/events.ts`). A readable vitals line without an SDK change:
  `| line_format` with `{{if eq .ouo_web_vital_name "CLS"}}{{printf "%.3f" (float64 .ouo_web_vital_value)}}{{else}}{{printf "%.0f ms" (float64 .ouo_web_vital_value)}}{{end}}`
  gives `LCP 96 ms good`, `CLS 0.002 good`. `printf "%.0f"` alone turns CLS into `0`; `round` is
  not a Loki template function.
- **`@ouo11y/browser` 0.3.0 prints `@ouo11y/browser@0.2.0 initialised`** in debug: its
  `SDK_VERSION` constant was not bumped with the release.
- **Express 5 calls the `app.listen` callback on `EADDRINUSE` too**, so "API on http://localhost:5001"
  is printed even when another process holds the port and the server exits.
- **Local quirk:** `npm` failed inside this worktree path (`call config.load() before reading
  values`, even `npm -v`) but worked in a scratch copy; lockfiles were made there.
