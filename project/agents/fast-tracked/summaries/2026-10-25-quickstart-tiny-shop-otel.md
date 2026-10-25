# 2026-10-25: quickstart `examples/quickstarts/tiny-shop-otel`

## What was done

- New quickstart for customers who do not want `@ouo11y/browser` in their web app: Tiny Shop with
  the browser instrumented by hand with OpenTelemetry JS 3.0, rrweb and web-vitals, sending exactly
  what rum-api reads (N48).
  - `result/frontend/src/telemetry/`: `config.js` (URLs, credential, service), `session.js`
    (session id in `localStorage`, 30 min / 4 h, shared by tabs, replay `seq`), `otel.js`
    (resource with `ouo.platform`, tracer + logger providers, OTLP exporters, fetch
    instrumentation, `SessionSpanProcessor`, `SessionPropagator` for `traceparent` + session
    baggage), `events.js` (`session.start` / `session.end`, `exception`, `http.request.failed`,
    `navigation`, `web_vital`, custom events), `replay.js` (rrweb chunks every 5 s / 256 KB to
    `/v1/replay/chunks`, full snapshot on rotation), `index.js`.
  - `result/backend/`: the Tiny Shop API, service renamed `tiny-shop-otel-backend`.
  - `build-it-yourself-guide.md`: opens with the browser contract (one table), then the usual
    empty-folder path: plain app, stack, backend, and the browser in three checkpoints (6a spans
    with `session.id`, 6b RUM events and a `crashed` session, 6c replay), plus what the SDK adds
    on top (tab lease, offline store, gzip, `setUser`, XHR / clicks / long tasks, sampling).
    Every code block of a result file is an `<!-- embed: -->` checked by `check-embeds.mjs`.
  - `README.md`: run `result/` as is, ports, things that bite.
- kb `diy-browser-rum.md`: the contract as rum-api reads it, OTel JS 3.0 browser changes, testing quirks.
- Index rows: `examples/quickstarts/README.md` and `index.md`, `docs/index.md`, kb index, this
  agent's tracker and summaries index, checklist N48.

## Dependencies (new, example only)

frontend: `@opentelemetry/{api, core, resources, sdk-trace, sdk-logs, exporter-trace-otlp-http,
exporter-logs-otlp-http, instrumentation, instrumentation-fetch}` (spans, logs, export, fetch
tracing, propagators), `rrweb` (replay), `web-vitals` (vitals), `react`, `react-dom`, `vite`,
`@vitejs/plugin-react` (the Vite React template). backend: same as tiny-shop. Lockfiles committed.

## How it was verified

`deploy/compose/quickstart.yaml` (collector / rum-api / grafana 0.3.0) as an isolated compose
project on shifted ports (Grafana 23000, OTLP 24318, replay 24319), API on 5011, Vite on 5183.

- In-app browser, clicks Add x2, Checkout, Call broken API, Throw error: every `/v1/logs` and
  `/v1/traces` POST 200, replay chunks 202. rum-api: session `crashed`, crash 1, failed request 1,
  `trace_count` 2 then 4, `has_replay` true (`rrweb`). Tempo: one trace
  `tiny-shop-otel-frontend POST` -> `POST /api/checkout` -> middleware, `checkout`,
  `validate cart`, `charge card`, all with the browser's `session.id` and `user.id`. Grafana
  plugin session page: timeline, traces, and the replay plays the shop.
- Headless Chromium (Playwright 1.64.1): the same clicks, then `lastActivity` moved back 31 min and
  a reload. Session 1 ends `inactivity` with `session.end` (`duration_ms`), session 2 starts with
  `session.previous_id` = session 1, replay `seq` continues, both have replays; FCP, LCP, CLS,
  TTFB and INP arrive as `web_vital`; traces 4 and 2 once the rum-api Tempo cache expired.
- The guide's two intermediate `index.js` versions (6a, 6b) were extracted from the guide and
  built; 6b run headless gives the checkpoint the guide promises (session `crashed`, 1 failed
  request, no replay yet, 3 traces in Tempo).
- `node examples/quickstarts/check-embeds.mjs`: in sync.

Not done: a literal walk of the guide from an empty folder by a person; steps 0 to 5 are the
tiny-shop guide's, already followed once.

## For the next agent

- npm cannot run inside this worktree while the main checkout has a conflicted workspace
  `package.json` (kb `diy-browser-rum.md`): lockfiles were produced from a copy in the scratchpad.
- If the browser SDK's wire format changes (event names, replay headers), this guide changes with
  it: the contract table at the top of the guide is the list to check.
