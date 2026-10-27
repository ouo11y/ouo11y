# 2026-10-27: tiny-shop-otel, founder review round 1

Changes to `examples/quickstarts/tiny-shop-otel` after the founder followed the guide (PR #88).
Backend logs and metrics, also raised in the review, go to a separate example; the stale
`deploy/compose/quickstart.yaml` pins are a separate session.

## What was done

- **Stack, one folder per service** (the tiny-shop-signals layout): new `result/stack/` with
  `10-collector`, `20-tempo`, `30-loki`, `40-mimir`, `50-rum-api`, `60-grafana`, each file in its
  own collapsible block in guide step 4. Copied from the tiny-shop-signals branch, minus its
  dashboard. The guide no longer embeds `quickstart.yaml`, which still runs 0.3.0 images.
- **Images on `latest`**: collector, rum-api and grafana use `:latest`. Each compose file names the
  tested version and digest (collector 0.4.0, rum-api 0.5.0, grafana 0.5.0 with plugin 0.9.0).
- **rum-api 0.5.0 needs `OTEL_EXPORTER_OTLP_*`**: it now exports its own telemetry and otherwise
  retries `localhost:4318` every second. Set to the collector with the demo credential.
- **Relative paths**: no `~/Desktop`. Every command says which folder of `tiny-shop-otel/` it runs in.
- **Fetch spans from `@opentelemetry/browser-instrumentation/experimental/fetch`**: replaces the
  deprecated `@opentelemetry/instrumentation-fetch`, with the same options.
- **Readable event log lines**: every RUM log record has a one-line `body`, for example
  `GET http://localhost:5001/api/fail 500` or `LCP 176 ms good`.
- **Package explainer**: a collapsible table in step 6 covering `sdk-trace` vs `sdk-trace-web`,
  `instrumentation` vs `instrumentation-fetch` vs `browser-instrumentation`, `browser-sdk`, and the
  nonexistent `instrumentation-web`.
- **Step 8 now has a cost column**: what it takes to add each SDK feature to `telemetry/`, from
  easy (`setUser`, sampling, XHR) to hard (offline store with retry).
- README, kb `diy-browser-rum.md`: updated for all of the above.
- **Quickstart rules recorded** in `examples/quickstarts/index.md` ("Rules for every
  quickstart"), at the founder's request, so new quickstarts follow them without being told.
  tiny-shop-otel is the reference. The old "How a quickstart is built" section of the quickstarts
  README moved there. A table lists what tiny-shop and tiny-shop-funnels still have to change.

## Dependencies

- frontend: `@opentelemetry/browser-instrumentation` ^0.9.0 replaces
  `@opentelemetry/instrumentation-fetch`. It is the maintained fetch instrumentation, and it pulls a
  nested `@opentelemetry/instrumentation` 0.223.

## How it was verified

- `result/stack` started as compose project `tsotel-v2` on shifted ports (Grafana 23000,
  OTLP 24318, replay 24319). Six services were up and rum-api was healthy.
- Images pulled at `latest`: collector 0.4.0, rum-api 0.5.0, grafana 0.5.0 (plugin 0.9.0).
- Backend on 5011 and Vite on 5183, driven by headless Chromium (Add x2, Checkout, Call broken
  API, Throw error).
  - **Collector:** every `/v1/logs` and `/v1/traces` request answered 200, and replay chunks 202.
  - **Loki:** the lines read `session.start <id>`, `navigation (entry) -> /`, `cart.added {...}`,
    `GET .../api/fail 500`, `Error: Button exploded`, `TTFB 17 ms good`, `CLS 0.002 good`, ...
  - **Tempo:** the checkout trace has its root span from scope `@opentelemetry/browser-instrumentation/fetch`,
    then the API spans, all with the browser's `session.id`.
  - **rum-api through the plugin proxy:** the session is `crashed`, with 1 failed request, 4
    traces, an rrweb replay and its `device_id`.
- rum-api's own logs reach Loki (`service_name="rum-api"`) once the OTEL variables are set.
- `node examples/quickstarts/check-embeds.mjs`: in sync. lychee offline: 0 errors.

## For the next agent

- When tiny-shop-signals (#67) merges there are two near-identical `result/stack/` folders. Keep
  them per example, because each guide must stand alone. A config change in one probably applies
  to the other.
- With `latest`, the configs can fall behind a future rum-api. The guide's troubleshooting table
  says to pin the tested version.
