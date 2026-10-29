# Appendix O: ouo on the web today (`@ouo11y/browser`, collector, rum-api, Grafana plugin)

What a web customer gets from this repository at commit `a283b5b` (branch `claude/web-sdk-research`, 2026-10-29), read from the code. Every fact carries `path:line @ a283b5b` (the sha is left out below when a whole table is from that commit). "Measured here" means run in this worktree on 2026-10-29. Nothing was run against a live stack: no `ouo-env` was started for this appendix.

Same ten sections as appendices A–F, adapted to our own code.

## 1. Sources

| Item | Value |
|---|---|
| Commit | `a283b5b` (`git rev-parse --short HEAD`) |
| `@ouo11y/browser` | 0.3.0 (`sdk/browser/package.json:3`), Apache-2.0, ESM only (`package.json:28`), entries `.` and `./react` (`package.json:40-51`) |
| Runtime dependencies | `@opentelemetry/api` ^1.9.1, `api-logs` 0.222.0, `core` ^2.11.0, `instrumentation` 0.222.0, `instrumentation-document-load` 0.67.0, `instrumentation-fetch` 0.222.0, `instrumentation-xml-http-request` 0.222.0, `opentelemetry-browser-detector` 0.222.0, `otlp-transformer` 0.222.0, `resources` ^2.11.0, `sdk-logs` 0.222.0, `sdk-trace-base` / `sdk-trace-web` ^2.11.0, `semantic-conventions` ^1.43.0, `rrweb` ^2.1.7, `web-vitals` ^6.2.3 (`sdk/browser/package.json:73-90`). React ≥16.8 optional peer (`package.json:109-116`) |
| `@ouo11y/sourcemaps` | 0.1.0 (`sdk/sourcemaps/package.json:3`), CLI `ouo-sourcemaps`; not yet on npm (checklist N41, `project/tracker/checklist.md:30`) |
| Grafana app plugin `ouo11y-rum-app` | 0.9.0 (`plugins/ouo11y-rum-app/package.json:3`), Grafana 13.2.2 packages, `rrweb-player` 2.1.7 (`package.json:22-28`) |
| Backend | `services/rum-api` (Go, about 9,100 lines without tests), `collector/` (receivers `ouoreplayreceiver`, `ouosentryreceiver`; processor `ouoratelimitprocessor`; extension `ouoauthextension`; exporter `ouoreplayexporter`) |
| Docs read | `sdk/browser/README.md`, `docs/first-party-endpoint.md`, `docs/sourcemaps.md`, `docs/compatibility.md`, `docs/operations/masking-proof.md`, ADR-0001 … ADR-0013 titles, `docs/specs/` (funnels, mobile-replay, mobile-vitals, sentry-bridge, session-lifecycle) |
| kb read | `project/kb/otel-browser-sdk.md`, `browser-delivery.md`, `browser-sdk-safety.md`, `funnels.md`, `sourcemaps-symbolication.md`, `diy-browser-rum.md` |
| Tracker read | `project/tracker/checklist.md` Focus (lines 11-31), N25 (115-123), N26 (124-129), N36 (22), N39 (28), N41 (30), N44 (31) |

Everything listed is open source in this repository.

## 2. Packages and frameworks

### Entries

| Entry | What it exports | Source |
|---|---|---|
| `@ouo11y/browser` | `initRUM`, `getRUM`, `SDK_VERSION`, `basicAuthorization`, `deriveIngestUrls`, `deriveReplayEndpoint`, types | `sdk/browser/src/index.ts:37-47,81` |
| `@ouo11y/browser/react` | `OuoErrorBoundary`, `useOuoRoute`, `routeTemplate`; a `"use client"` module | `sdk/browser/src/react/index.ts:38,72,87`; banner `sdk/browser/tsup.config.ts:83` |

### Frameworks

- **React** is the only framework package: an error boundary that reports `exception` with `ouo.exception.kind=react.error_boundary` and the component stack (`src/react/index.ts:45-53`), and a route-template hook for React Router (`src/react/index.ts:72-97`).
- **Next.js App Router**: the React entry is a client module, `initRUM` returns an inert instance without `window` (`src/index.ts:94-95`). A Next.js 15 production build was checked by hand, not in CI (`project/kb/browser-sdk-safety.md:49-53`).
- **Vue, Angular, Svelte, Nuxt, Remix**: nothing. `grep -rniE "vue|angular|svelte|nuxt|remix" sdk/browser/src` finds one comment (`src/index.ts:94`). Verified absent.
- SPA routing works for any router through the patched `history.pushState` / `replaceState` and `popstate` (`src/navigation.ts:46-62`); naming the route template outside React means calling `rum.setRoute()` by hand (`src/index.ts:390-395`).

### No-SDK path

`examples/quickstarts/tiny-shop-otel` feeds ouo with stock OpenTelemetry JS, rrweb and web-vitals in about 300 lines (`examples/quickstarts/tiny-shop-otel/result/frontend/src/telemetry/`: `config.js`, `session.js`, `otel.js`, `events.js`, `replay.js`). The contract rum-api reads is in `project/kb/diy-browser-rum.md:9-36`: Loki events folded per `session_id`, `exception` / `http.request.failed` for status, Tempo search on `session.id`, JSON replay chunks on `:4319/v1/replay/chunks`. That kb also records that OTel JS 3.0 deprecates `sdk-trace-web` and the 0.300 fetch / XHR instrumentations in favour of the opentelemetry-browser repo (`diy-browser-rum.md:38-55`); `@ouo11y/browser` is still on the 2.x / 0.222 line.

### CDN or loader snippet

None. tsup builds `format: ["esm"]` only (`sdk/browser/tsup.config.ts:40`); `grep -nE "iife|cdn|unpkg|jsdelivr|globalName" sdk/browser/tsup.config.ts sdk/browser/package.json` finds nothing. A site without a bundler cannot drop in a `<script>` tag, and there is no async loader that queues calls before the SDK arrives. Verified absent.

### Browser support floor

- Syntax floor ES2022 (`chrome94`, `edge94`, `firefox93`, `safari16.4`, `ios16.4`), checked by es-check in CI (`tsup.config.ts:37`, `package.json:70`).
- Supported (tested): Chrome / Edge of the last 2 years, Firefox of the last 2 years, Safari 18+ (`sdk/browser/README.md:237-243`). Optional APIs are feature-detected (`README.md:247-252`).
- Playwright e2e runs in Chromium, Firefox and WebKit (`README.md:253-254`).

### Bundle size (measured here)

npm cannot run in this worktree ("Exit prior to config file resolving", the known worktree quirk in `project/kb/browser-sdk-safety.md:158-162`). The build was run with the main checkout's `node_modules/.bin/tsup`, whose versions equal the lockfile's (tsup 8.5.1, terser 5.51.2, esbuild 0.27.7, rrweb 2.1.7, web-vitals 6.2.3, OTel 2.11.0 / 0.222.0). `dist/` was removed afterwards.

| File | Loaded | Raw bytes | gzip -9 bytes | Budget (`size-budget.json`) |
|---|---|---|---|---|
| `index.js` | eagerly (core: OTel trace + logs SDKs, fetch / XHR / document-load instrumentations, web-vitals, delivery, session) | 147,787 | **45,008** (43.95 KiB) | 44.0 KiB = 45,056 B: **48 bytes of headroom** |
| `react.js` | with the React entry | 1,066 | 652 | 1.0 KiB |
| `rrweb-JHYG35H5.js` | lazily, `import("rrweb")` only when replay is on and the session sampled (`src/replay/recorder.ts:109`) | 261,700 | 78,940 (77.1 KiB) | 82.0 KiB |

`node scripts/size.mjs --check` passed all three (`sdk/browser/scripts/size.mjs`, budgets `sdk/browser/size-budget.json:3-7`). The core is at its budget to within 48 bytes: the next feature in the core entry needs either a budget raise or code moved out.

## 3. RUM signals

All events are OTel log records with `event.name` set top-level and as an attribute, emitted in the root context (`src/telemetry/events.ts:36-49`). Spans and records get `session.id`, `user.id`, `ouo.user.anonymous`, `ouo.platform=web`, `service.version`, `session.previous_id` and `app.screen.name` from processors (`src/telemetry/correlation.ts:15-22,35-36,67-79`).

| Signal | What ouo does | Code |
|---|---|---|
| **Sessions** | Random id in `localStorage` key `ouo.session`; 30 min inactivity, 4 h max (`src/session/manager.ts:9,11-12`); end reasons `inactivity`, `max_duration`, `user_change`, `manual` (`manager.ts:21`); `session.start` / `session.end` events (`manager.ts:345,392-396,403,424`); tabs share it through the `storage` event (`src/index.ts:218-222`); stable random `device.id` (`src/session/device.ts`, resource attribute `src/telemetry/resource.ts:30`). Storage is `localStorage` only, no cookie (`grep -rni cookie sdk/browser/src` finds one comment, `transport/delivery.ts:294`), so **no session across subdomains**. Falls back to memory when storage throws or is full (`src/session/storage.ts:25-36`). |
| **Errors** | `error` listener in capture phase (also catches resource load failures), `unhandledrejection`, patched `console.error`, `captureError`, React boundary (`src/errors/install.ts:31-63,66-99`, `src/index.ts:381-386`). Fatal = uncaught or unhandled rejection; handled otherwise (`src/errors/classify.ts:35-48`). Stack sent as the raw string `exception.stacktrace` (`classify.ts:12-19,41`); `ouo.exception.debug_ids` for source maps (`classify.ts:56-66`). No client-side stack parsing, no dedup or rate limit of repeated errors (`grep -rniE "dedup|throttle|maxErrors|rate" sdk/browser/src/errors` is empty), no breadcrumbs attached to the error (the session timeline plays that role). |
| **Web vitals** | web-vitals 6: CLS, FCP, LCP, TTFB, INP (`src/vitals.ts:35-47`); INP followed with `reportAllChanges` and emitted at `visibilitychange` / `pagehide` (`vitals.ts:42-57`). Attributes: name, value, rating, id, delta, navigation type, `url.path` (`vitals.ts:6-15`). **No attribution**: imports from `"web-vitals"`, not `"web-vitals/attribution"` (`vitals.ts:1`), so no INP target / event type / LoAF breakdown, no LCP element or resource URL, no CLS shift sources. `url.path` is the path at report time, so CLS and a late INP of a SPA carry the route the user was on when the tab was hidden, not the landing route (`vitals.ts:33,44`). |
| **Page loads** | `DocumentLoadInstrumentation` (`documentLoad`, `documentFetch`, `resourceFetch` spans), with `ignoreNetworkEvents` and `ignorePerformancePaintEvents` (`src/index.ts:239-241`); `<meta name="traceparent">` links it to the server span (`README.md:175-198`). A `navigation` event of kind `load` with the referrer path (`src/navigation.ts:64-78`). |
| **Soft navigations** | Patched `pushState` / `replaceState` + `popstate` emit `navigation` (`src/navigation.ts:24-62`) and open a `soft-navigation` idle span that ends 1 s after the last request or DOM mutation, capped at 15 s (`navigation.ts:34-37`, `src/interactions/tracker.ts:43-44`). No per-route vitals. |
| **Resources** | Only the resources present at page load, as `resourceFetch` spans of `documentLoad`. No `PerformanceObserver` on `resource` afterwards (`grep -rnE "type: *\"resource\"|'resource'|entryTypes" sdk/browser/src` is empty). Failed resource loads are `exception` events of kind `resource`, severity warn (`src/errors/install.ts:34-44`). |
| **Network** | OTel fetch and XHR instrumentations: one CLIENT span per request, `traceparent` + `baggage` (`session.id`, `user.id`, `ouo.platform`) to same-origin and `tracing.propagateTo` (`src/network.ts:45-73`, `src/telemetry/propagator.ts:22-24`). `ignoreNetworkEvents: true` (`network.ts:48,66`): no DNS / TCP / TLS / TTFB breakdown on the span. `http.request.failed` event for 5xx and status 0 only, 4xx is not an error (`network.ts:18-20,32-43`). **No request or response bodies, no headers** (`grep -rniE "requestBody|responseBody|\.text\(\)|\.clone\(\)|getAllResponseHeaders" sdk/browser/src` finds only the SDK's own `Retry-After` read, `transport/delivery.ts:307`). `url.full` keeps the query string; there is no URL sanitizer. |
| **Long tasks / LoAF** | Long Animation Frames on Chromium 123+, else Long Tasks; threshold 100 ms, 50 per page (`src/longtasks.ts:69-96`). LoAF events name the longest script: invoker, source URL, function, char position (`longtasks.ts:31-54`). Nothing in Firefox and Safari (`longtasks.ts:65-68`). |
| **Interactions** | A `click` idle span per click parents the requests and soft navigation it causes, through a fallback context manager (no zone.js) (`src/interactions/clicks.ts:87-99`, `src/index.ts:205-211`). A click without children is not exported (`README.md:166-167`). Element described by a CSS-like path and an accessible name; text only from buttons and links, never inside `ouo-mask` / `ouo-block`, never input values (`src/interactions/element.ts:28-46`). No keyboard, scroll, form-submit or hover interactions. |
| **Rage / dead clicks** | `ouo.rage_click`: ≥3 clicks within 1 s on one element or within 30 px (`src/interactions/clicks.ts:41-59,74-85`). `ouo.dead_click`: a button or link click with no request, mutation or navigation before idle (`clicks.ts:88-98`, `element.ts:60-82`). No "error click". |
| **Console** | `console.error` only, reported as an `exception` of kind `console` (`src/errors/install.ts:66-99`). `console.log` / `warn` / `info` are not captured (`grep -rnE "console\.(warn|log|info|debug) *=" sdk/browser/src` is empty). |
| **Custom events** | `rum.addEvent(name, attrs)` → log record with `ouo.event.custom=true` (`src/index.ts:387-389`). Custom spans through the global OTel API (the SDK registers the tracer provider, `index.ts:207`). No custom metrics API. |
| **User identity** | `setUser({ id })`, `clearUser()`; anonymous to identified keeps the session, identified to another rotates it (`src/types.ts:136-138,192-201`). `UserOptions` has only `id`: no email, name or traits. No global attributes API (`setAttribute` / `setContext` / `setTag`: `grep -nE "setAttribute|setContext|setTag|setGlobal" sdk/browser/src/types.ts` is empty) and no `beforeSend` hook to drop or scrub events (`grep -rniE "beforeSend|sanitiz|redact|scrub" sdk/browser/src` is empty). |
| **Feature flags** | None in the web SDK or rum-api (`grep -rniE "feature_flag|featureflag|openfeature" sdk/browser/src services/rum-api` is empty). OpenFeature is used only by the mobile example (`examples/sentry-mobile/src/rollout.ts`). |
| **Sampling** | Head sampling per session, deterministic from the session id (`fmix32(fnv1a32(salt:id))`, `src/session/sampling.ts:12-32`), salts `session`, `replay`, `replay_on_error`; unsampled sessions record no spans (`src/telemetry/sampling.ts:12-22`), no log records (`sampling.ts:29-39`) and send `traceparent` flag 00. No per-signal rates (errors, vitals, traces separately). |
| **Context** | Resource: OS name and version from the UA (`src/telemetry/resource.ts:7-18,32-36`), `browser.*` from the OTel browser detector (`resource.ts:37`). rum-api's session header shows only `os_*`, device and environment keys, not the browser (`services/rum-api/internal/session/event.go:99-102`). No geo (by design: no IP linking, `README.md:112`), no viewport, no connection type. |

## 4. Replay

| Aspect | ouo today | Code |
|---|---|---|
| Recorder | rrweb 2.1.7, bundled and patched at build time so a blocked iframe is neither recorded nor observed (Safari observer leak fix) | `sdk/browser/tsup.config.ts:5-29` |
| Options | `maskAllInputs` (default true), `blockClass: "ouo-block"`, `maskTextClass: "ouo-mask"`, `blockSelector` always includes `iframe.rr-block`, optional `maskTextSelector`, `checkoutEveryNms` 5 min (30 s while buffering), `recordCanvas: false`, `collectFonts: false`, `inlineImages: false`, `slimDOMOptions { script, comment }`, `errorHandler` returns true | `src/replay/recorder.ts:303-321`, constants `recorder.ts:38-52` |
| Masking default | **Inputs masked, page text recorded**. No `maskAllText` option; `grep -rniE "maskAllText|maskTextFn|maskInputFn" sdk/browser/src/replay` is empty. Documented in `docs/operations/masking-proof.md:13-15` | |
| Canvas | Off, not configurable (`recorder.ts:312`) | |
| Iframes | rrweb default: same-origin iframes recorded; `recordCrossOriginIframes` not set, so cross-origin iframes are not | `recorder.ts:304-321` |
| Shadow DOM | rrweb default (open shadow roots); not covered by any test (`grep -rniE "shadow|attachShadow" sdk/browser/test sdk/browser/e2e` is empty) | |
| Input / mouse sampling | rrweb defaults; no `sampling` option passed | `recorder.ts:304-321` |
| Compression | `CompressionStream("gzip")` in the delivery layer, bodies ≥1 KB, not at page hide (`src/transport/gzip.ts:9-14`, `transport/delivery.ts:259-273`). No worker (`grep -rniE "worker" sdk/browser/src` is empty). The chunk is `JSON.stringify`-ed on the main thread (`src/replay/uploader.ts:35`), and every rrweb event is stringified once more for its size estimate (`src/replay/chunker.ts:90,222-228`) | |
| Chunking | Every 5 s or 256 KB; pending data capped at 2 MB, oldest chunks dropped; 3 upload attempts per chunk on top of the delivery layer's retries | `src/replay/chunker.ts:47-49,89-104,171-181,191-218` |
| Chunk format | `{session_id, seq, started_at, ended_at, events}` with `x-ouo-session-id`, `x-ouo-seq` headers to `${replayEndpoint}/v1/replay/chunks` | `chunker.ts:6-12`, `uploader.ts:33-44` |
| Snapshot too large | A full snapshot over 2 MB stops replay for the page view and emits `ouo.replay.skipped` | `recorder.ts:263-278` |
| On-error buffer | `replay.onErrorSampleRate`: keep the last 30–60 s (two checkouts) in memory, upload it and switch to full on the first `exception` of severity error | `recorder.ts:152-168,283-296`, trigger `src/index.ts:305-309` |
| Multi-tab | One recording tab per session: a `BroadcastChannel("ouo.replay")` lease, claimed by focus, pointerdown, keydown, visible; rrweb custom event `ouo.tab` | `src/replay/tabs.ts:3-51`, `recorder.ts:231-261,330` |
| Network / console in replay | Neither: no rrweb plugins (`grep -rniE "plugins:|getRecordConsolePlugin" sdk/browser/src/replay` is empty). The session page shows the session's traces and logs next to the player instead | |
| Privacy controls at runtime | `rum.replay.pause()` / `resume()` (`src/index.ts:396-400`) | |
| Player | Grafana plugin wraps `rrweb-player` 2.1.7 in a sandboxed iframe (`plugins/ouo11y-rum-app/src/components/ReplayPlayer.tsx:5,28-69`); markers for timeline events on the scrub bar (`components/ReplayMarkers.tsx`, `utils/markers.ts`); a log line seeks the replay (`pages/SessionDetail.tsx:383`) | |
| Storage | rum-api stores chunks gzip on a filesystem or S3 (`services/rum-api/internal/replay/fs.go:58-59`, `replay/s3.go`), default retention 720 h (`services/rum-api/internal/config/config.go:118-120`) | |

## 5. Transport and OpenTelemetry

| Aspect | ouo today | Code |
|---|---|---|
| Format | OTLP/HTTP **JSON** for traces and logs (`JsonTraceSerializer`, `JsonLogsSerializer`), own exporter over the delivery layer | `src/transport/exporter.ts:4,62-68` |
| Endpoints | `${endpoint}/v1/traces`, `/v1/logs`; replay on port 4319 when `endpoint` is on 4318, else the same base | `src/types.ts:140-153`, `src/ingest.ts:94-116` |
| Auth | `Authorization: Basic base64(projectId:projectToken)` on every request; the token is public (ADR-0007) | `src/types.ts:154-165`, `README.md:49-56` |
| Batching | Own processors (not OTel's batchers, which skip a flush while one runs): logs every 1 s / 64 / queue 2048, spans every 2 s / 64 / queue 1024 | `src/index.ts:161-168,192-197`, `src/telemetry/batch.ts:90,114` |
| gzip | `CompressionStream` on the main thread's event loop (the stream itself is native, async), ≥1 KB, kept only if smaller; skipped on the page-hide path | `src/transport/delivery.ts:259-273`, `transport/gzip.ts:1-14` |
| Keepalive | Every request uses `keepalive` while a shared 60 KB / 9-request budget allows | `src/transport/keepalive.ts:7-29`, `delivery.ts:284` |
| Page hide | `visibilitychange` hidden and `pagehide` flush; at hide the OTLP batch is halved until each part fits the keepalive budget; what does not fit is parked in the store and also sent plainly | `src/index.ts:317-335`, `transport/exporter.ts:42-51`, `delivery.ts:229-250` |
| `sendBeacon` | Off by default: a beacon cannot carry `Authorization`; only through a first-party proxy that adds it (checklist N44 open) | `delivery.ts:51-56,316-321`, `checklist.md:31` |
| Retries | 5 attempts, exponential backoff with equal jitter 1 s → 30 s, `Retry-After` honoured, over 60 s goes to the store; 408 / 429 / 5xx / network retried, other 4xx dropped; 30 s timeout | `src/transport/retry.ts:5-39`, `delivery.ts:128-139,284-286` |
| Offline | IndexedDB `ouo-delivery` with memory fallback, 5 MB cap oldest-first, 24 h max age; drained on `online`, `pageshow`, after a success and on the next page load, one tab at a time with a Web Lock | `src/transport/index.ts:9-26`, `transport/store.ts:5,222-245`, `delivery.ts:145-152,435` |
| Delivery counters | `rum.deliveryStats()`: sent, retried, queued, dropped with reasons, raw and wire bytes | `src/types.ts:220-234` |
| First-party endpoint | A relative `endpoint` (`/otel`) resolves against the page; nginx, Caddy and Next.js proxy recipes | `src/ingest.ts:44-52`, `docs/first-party-endpoint.md` |
| CSP / Trusted Types | SDK and rrweb record need no `unsafe-eval`, no `unsafe-inline`, `trusted-types 'none'` passes in three engines (`e2e/csp.spec.ts`) | `README.md:283-286`, `project/kb/browser-sdk-safety.md:65-72` |
| OTel interop | Uses the global OTel API; an app that registered its own OTel first keeps it (`src/index.ts:203-211`). Events are log records with `event.name`, not the incubating `browser.*` semconv events (`checklist.md:126`) | |
| Collector side | OTLP receiver on 4318 with basic auth, per-project and per-client rate limits, CORS, 4 MiB body (`deploy/compose/collector/config.yaml:44-66,113-121`); replay receiver on 4319, 8 MiB (`config.yaml:68-78`) | |

## 6. Backend and UI a web customer gets

### rum-api endpoints (`services/rum-api/internal/httpapi/server.go:97-121`)

`POST /v1/replay/chunks` (from the collector's replay exporter); `GET /v1/sessions`, `/v1/sessions/{id}`, `/traces`, `/logs`, `/vitals`, `/replay`, `/replay/events`, `/replay/frames`, `/replay/video[/{seq}]`; `DELETE /v1/sessions/{id}/replay`; `GET /v1/stats/health`; `PUT /v1/sourcemaps`, `GET /v1/sourcemaps`, `POST /v1/symbolicate`; `POST /v1/funnels/query`, `GET /v1/funnels/dropped`, `GET /v1/funnels/steps`; admin `DELETE /v1/admin/users/{user}`, `DELETE /v1/admin/projects/{project}`, `GET /v1/admin/audit`, `POST /v1/admin/retention/sweep`.

### Session folding and health

- Sessions are **folded at query time** from Loki events; there is no session table (`services/rum-api/internal/session/fold.go:90-117`, `httpapi/sessions.go:119-141`). The Loki client pages 5,000 lines at a time, at most 20 pages, so one list query reads at most 100,000 events (`internal/loki/client.go:24-36,106-131`); the list looks back `session.max_duration` (4 h) before `from` (`services/rum-api/main.go:289`).
- Status (ADR-0004): any fatal exception → `crashed`, any other `exception` or `http.request.failed` → `errored` (`session/fold.go:97-110`). A `console.error` from a third-party script or a broken image (resource error) therefore marks the session `errored`.
- Health % per platform, service and version (`internal/session/stats.go:8-60`), shown on the Overview page.
- Session list filters: time range, platform, service, version, user, status, limit ≤1000 (`httpapi/sessions.go:72-112`). No filter by URL, error message, event name, browser, has-replay, vital rating or duration.

### Errors: no grouping

**Errors are not grouped into issues.** `grep -rniE "fingerprint|issue_id|/v1/issues"` over `sdk/browser/src`, `plugins/ouo11y-rum-app/src`, `services/rum-api` and `collector` (`.ts`, `.tsx`, `.go`, tests excluded) returns nothing. An exception exists only as an item in one session's timeline (`httpapi/sessions.go:38-48`), symbolicated on read when maps exist. There is no cross-session error list, count per error, first / last seen, affected users, regression, assignment or resolve state.

### Web vitals in the backend

`web_vital` events are typed (`internal/session/event.go:45,73`) and appear as timeline items titled "Web vital LCP" with value and rating (`plugins/ouo11y-rum-app/src/components/Timeline.tsx:59-63`). `/v1/sessions/{id}/vitals` and the header vitals row are **mobile vitals only** (`internal/session/vitals.go:11-31`, `pages/SessionDetail.tsx:51-58`). No aggregate of web vitals anywhere: no p75 by page, no trend, no distribution (rum-api `grep -rn web_vital services/rum-api --include='*.go'` shows only the type mapping and the log filter, `httpapi/logs.go:29`).

### Plugin pages (`plugins/ouo11y-rum-app/src/components/App.tsx:17-23`, `plugin.json`)

| Page | What it shows |
|---|---|
| Overview | Healthy / errored / crashed tiles per platform (web, mobile) and a table per service version, linking to Sessions (`pages/Overview.tsx:16-113`) |
| Sessions | Filters above; table sorted client-side (`pages/Sessions.tsx:15-128`, `components/SessionsTable.tsx`) |
| Session detail | Header (status, context), timeline (`components/Timeline.tsx`), rrweb player or frames / video player for mobile, replay markers and activity, traces table with Explore links (`components/TracesTable.tsx`), logs panel, symbolicated stacks with an Original / Raw toggle (`components/StackTrace.tsx`) (`pages/SessionDetail.tsx:226-383`) |
| Funnels | Page and custom-event steps, session-counted, dropped-session drill-down (ADR-0012, `pages/Funnels.tsx`, `components/FunnelChart.tsx`, `components/DroppedSessions.tsx`) |

`ouo.rage_click`, `ouo.dead_click`, `ouo.long_animation_frame`, `ouo.long_task` and `ouo.replay.skipped` render as generic custom events: the timeline knows only `session.start`, `navigation`, `exception`, `http.request.failed`, `web_vital`, `custom`, `session.end` (`components/Timeline.tsx:34-75`; noted open in `checklist.md:123`).

### Dashboards and alerting

- Provisioned Grafana content is two datasources files and the plugin (`deploy/compose/grafana/provisioning/{datasources,plugins}`). No dashboards (`find deploy plugins/ouo11y-rum-app/src -iname '*dashboard*'` is empty) and no alert rules (`find deploy -iname '*alert*rule*'` is empty; the only `alert` hits are Mimir's alertmanager storage config, `deploy/compose/mimir/config.yaml:54`). Verified absent.
- Tempo's metrics generator writes `traces_spanmetrics_*` and `traces_service_graph_*` to Mimir (`deploy/compose/tempo/config.yaml:48,68-69`, `deploy/README.md:216-219`), so request rate, error rate and latency of browser fetch spans exist as metrics a customer could chart or alert on in Grafana by hand. The browser itself sends no OTel metrics.

### Source maps (ADR-0011, `docs/sourcemaps.md`)

`ouo-sourcemaps inject` appends a debug-id snippet to each bundle; `upload` sends maps to rum-api with a secret upload token; symbolication happens on read, so maps uploaded after an error still apply (`docs/sourcemaps.md:5-13`). Fallback key: `service.version` + URL path (`docs/sourcemaps.md:11`). Uploads go to rum-api directly, which is never public: CI on hosted runners cannot reach it until N41's collector upload path exists (`docs/sourcemaps.md:35,143`). Maps kept 90 days (`docs/sourcemaps.md:139`). No Vite / webpack plugin yet (N41).

### Data lifecycle

Retention defaults: logs 720 h, traces 336 h, metrics 2160 h, replays 720 h (`deploy/compose/compose.yaml:70,86,97,203`). Admin deletion by user or project with dry run and an audit log (`httpapi/admin.go:16-149`). Server-side sampling cap per project applies to **replay chunks only** (`httpapi/admin.go:163-181`); OTLP traces and logs are not sampled server-side (the collector pipelines have no sampling processor, `deploy/compose/collector/config.yaml:198-206`).

### Self-hosted footprint

The compose stack a customer runs: Grafana 13.2.1, Loki 3.7.7, Tempo 3.0.3, Mimir 3.2.1, `ouo/collector`, rum-api, MinIO (+ init job) for replay objects (`deploy/compose/compose.yaml:25-245`); a Helm chart with the same set (`deploy/helm/ouo/templates/{lgtm,collector,grafana,rum-api}`). Seven long-running services, five stateful volumes (`compose.yaml:274-278`).

## 7. Performance footprint

Measured already (all in this repository):

| What | Result | Source |
|---|---|---|
| Bundle | 45,008 B gzip core, 78,940 B gzip lazy rrweb (measured here, section 2) | |
| rrweb cost, Chromium, 10,000 elements | full snapshot 1,045 KB JSON; start task time 67 ms with replay (one 42 ms block) vs 18 ms SDK without replay vs 7 ms no SDK; 10 s of 10k text mutations/s: 698 ms script with replay vs 108 ms without; heap 10.4 MB vs 2.2 MB; 12.2 MB of replay sent; blocking the table brings it to 23 ms / 161 ms / 3.8 MB / 2 KB | `project/kb/browser-sdk-safety.md:125-132` |
| 50,000 elements | snapshot about 5 MB, over the 2 MB bound: replay stops with `ouo.replay.skipped` | `browser-sdk-safety.md:134-138` |
| 1 h soak | no growth after warm-up in listeners, observers, timers, DOM nodes, (Chromium) heap, in Chromium and WebKit | `checklist.md:24`, `project/agents/sdk-browser/reports/long-sessions-2026-10-24.html` |
| Compression ratio | 13.5 KB OTLP batch → 0.6 KB; 6.8 KB rrweb chunk → 0.3 KB | `project/kb/browser-delivery.md:24-25` |
| Host-page safety | same page transcript with and without the SDK under storage blocked / full and collector down, three engines | `e2e/faults.spec.ts`, `README.md:290-293` |

Not measured: the SDK's effect on the page's own INP, LCP or TBT (no Lighthouse or field A/B; `grep -rln "lighthouse|TBT" sdk/browser examples/ouo-web project/kb` is empty); the main-thread cost of `JSON.stringify` + `estimateBytes` per replay event on a mutation-heavy page beyond the 10k test; init time on a low-end mobile CPU; bytes on the wire per minute for a realistic journey; any comparison with another vendor's web SDK (`docs/benchmarks.md` is the mobile benchmark only; the web one is Appendix M). WebKit has no CPU counters in the harness (`browser-sdk-safety.md:139-140`).

## 8. Claims in our own docs vs the code

| Claim | Code | Verdict |
|---|---|---|
| "The main entry is about 42 KB gzipped" (`sdk/browser/README.md:16`) | 45,008 B = 43.95 KiB measured here; the budget is 44.0 KiB | **Stale**: 42.0 was the size after the terser switch (`browser-sdk-safety.md:146`); later merges grew it to the budget |
| rrweb chunk "about 77 KB gzipped" (`README.md:17`) | 77.1 KiB | Correct |
| `ouo.sdk.version` | `SDK_VERSION = "0.2.0"` (`sdk/browser/src/version.ts:2`) while `package.json:3` is 0.3.0; release-please's `extra-files` for `sdk/browser` do not include `version.ts` (`.github/release-please/config.json:25-32`) | **Bug**: every 0.3.0 install reports `ouo.sdk.version=0.2.0`; the debug example in `README.md:347` also says 0.2.0 |
| Root README lists Overview, Sessions, Session detail (`README.md:45-47`) | The plugin also has Funnels (`plugin.json`, `App.tsx:21`) | Incomplete |
| "Every span and log record carries … `app.screen.name` once a route is named" (`README.md:118-121`) | `correlation.ts:36,71` | Correct |
| Replay "on `pagehide` the remaining buffer leaves uncompressed with `keepalive`" (`README.md:228`) | True up to the 60 KB keepalive budget; a larger last chunk is parked in IndexedDB and sent on the next page load of the origin (`delivery.ts:230-250`) | Correct, with the caveat stated in the Delivery table (`README.md:322`) |
| Rage click "on one element or spot" (`README.md:135`) | widget id equal or within 30 px (`clicks.ts:75`) | Correct |
| Web vitals "Engine support: Chromium all five; Firefox no CLS; WebKit TTFB, FCP, LCP, INP" (`README.md:388-390`) | web-vitals behaviour, verified by e2e per the README | Not re-checked here |
| "A per-project server-side override is not part of the SDK" (`README.md:222`) | rum-api applies one to replay chunks only (`admin.go:163-181`) | Correct; the doc could say traces and logs are never capped server-side |

No case found where the code does something important that the README does not mention.

## 9. Gaps: what a Sentry / Datadog / PostHog web customer would look for

Each item was checked in the code at `a283b5b`; the command is the evidence.

| # | Expected feature | State in ouo | Evidence |
|---|---|---|---|
| 1 | Error grouping into issues (fingerprint, count, users, first / last seen, regressions) and an issue workflow (assign, resolve, ignore) | **Verified absent** | `grep -rniE "fingerprint|issue_id|/v1/issues"` over SDK, plugin, rum-api, collector: 0 hits; no route in `server.go:97-121` |
| 2 | Cross-session errors page | **Verified absent** | Plugin routes: Overview, Sessions, Session detail, Funnels only (`App.tsx:18-22`) |
| 3 | Alerts (error rate, crash-free %, vitals, new issue) | **Verified absent** (no provisioned rules; Grafana alerting on Loki / Mimir is possible by hand) | `find deploy -iname '*alert*rule*'`: 0; provisioning has `datasources`, `plugins` only |
| 4 | Web vitals dashboards (p75 by page, trends, distribution, per-browser) | **Verified absent** | `find deploy plugins/ouo11y-rum-app/src -iname '*dashboard*'`: 0; `/vitals` is mobile-only (`session/vitals.go:11-31`) |
| 5 | Vitals attribution (INP target and phases, LCP element / resource, CLS sources) | **Verified absent** | `src/vitals.ts:1` imports `"web-vitals"`, `grep attribution src/vitals.ts`: 0 |
| 6 | Session search beyond platform / status / service / version / user (URL, error text, event, browser, has replay, duration) | **Verified absent** | `httpapi/sessions.go:79-112` |
| 7 | Heatmaps, scroll maps, click maps | **Verified absent** | `grep -rniE heatmap` over SDK, plugin, rum-api: 0 (click coordinates are recorded on click spans and rage / dead events, `clicks.ts:66-71`) |
| 8 | User feedback widget / surveys | **Verified absent** | `grep -rniE "feedback|survey" sdk/browser/src plugins/ouo11y-rum-app/src`: 0 |
| 9 | Profiling (JS Self-Profiling API) | **Verified absent** | `grep -rniE profil sdk/browser/src`: 0 |
| 10 | Framework packages beyond React (Vue, Angular, Svelte, Next.js-specific, Nuxt, Remix) | **Verified absent** | `grep -rniE "vue|angular|svelte|nuxt|remix" sdk/browser/src`: one comment |
| 11 | Network request / response body and header capture | **Verified absent** | `grep -rniE "requestBody|responseBody|\.text\(\)|\.clone\(\)|getAllResponseHeaders" sdk/browser/src`: only `Retry-After` |
| 12 | Console logs (log / warn / info) as breadcrumbs or in replay | **Verified absent** (only `console.error`) | `grep -rnE "console\.(warn|log|info|debug) *=" sdk/browser/src`: 0 |
| 13 | Network and console panels inside the replay player | **Verified absent** in the recording (no rrweb plugins); the session page shows traces and logs beside the player | `grep -rniE "plugins:|getRecordConsolePlugin" sdk/browser/src/replay`: 0 |
| 14 | Mask all text by default / privacy-first replay preset | **Verified absent**: inputs masked, text recorded unless `ouo-mask` | `recorder.ts:306-310`; `docs/operations/masking-proof.md:13-15` |
| 15 | Canvas recording | **Verified absent** (hard-coded off) | `recorder.ts:312` |
| 16 | Replay compression in a Web Worker | **Verified absent** | `grep -rniE worker sdk/browser/src`: 0 |
| 17 | CDN script / loader snippet with call queue | **Verified absent** | ESM only, `tsup.config.ts:40` |
| 18 | `beforeSend` / event filter and URL / PII scrubbing | **Verified absent**; `url.full` keeps query strings (`navigation.ts:29`) | `grep -rniE "beforeSend|sanitiz|redact|scrub" sdk/browser/src`: 0 |
| 19 | Global context / tags / user traits | **Verified absent** (user id only) | `src/types.ts:136-138,192-222` |
| 20 | Feature flag tracking | **Verified absent** | `grep -rniE "feature_flag|featureflag|openfeature" sdk/browser/src services/rum-api`: 0 |
| 21 | Consent / opt-out API (cookieless mode, opt-out persistence) | **Verified absent** (only `replay.pause()`, `shutdown()`, not initialising) | `grep -rniE "consent|optOut|doNotTrack" sdk/browser/src`: 0 |
| 22 | Resource timing after page load, and DNS / TCP / TTFB breakdown on fetch spans | **Verified absent** | `ignoreNetworkEvents: true` (`network.ts:48,66`); no `resource` observer |
| 23 | Cross-subdomain sessions | **Verified absent** (`localStorage` per origin) | `grep -rni cookie sdk/browser/src`: one comment |
| 24 | Client-side error dedup / rate limit (an error loop floods the queue up to 2048 records, then the collector's rate limit) | **Verified absent** | `grep -rniE "dedup|throttle|maxErrors|rate" sdk/browser/src/errors`: 0; queue `src/index.ts:166` |
| 25 | Dedicated rendering of rage / dead clicks, long tasks, replay skipped in the UI | **Absent** (shown as custom) | `Timeline.tsx:34-75` |
| 26 | Server-side sampling of traces / logs | **Absent** (replay only) | `admin.go:163-181`; collector pipelines `config.yaml:198-205` |
| 27 | Public source-map upload path and bundler plugins | **Absent** (rum-api direct only; N41 open) | `docs/sourcemaps.md:143` |
| 28 | Beacons without a proxy | **Absent** (N44 open) | `delivery.ts:51-56`, `checklist.md:31` |
| 29 | Release health in the Sentry sense (adoption, crash-free users) | **Partial**: healthy / errored / crashed % of sessions per version; no adoption curve, no crash-free users | `session/stats.go:28-60` |
| 30 | Product analytics (trends, retention, paths) | **Partial**: funnels only | ADR-0012, `pages/Funnels.tsx` |

What ouo has that a web customer would recognise: OTel-native traces with W3C propagation into the backend and server-rendered page linking, sessions with health classification, rrweb replay with on-error buffering and multi-tab coordination, rage / dead clicks, LoAF with script attribution, source-map symbolication on read, funnels, first-party endpoint, offline delivery, a self-hosted stack on Grafana LGTM.

## 10. Takeaways

1. **The SDK is solid; the product around it is thin.** Capture, delivery and page safety are at or near the field's level (guards, offline IndexedDB, keepalive budget, CSP / Trusted Types, 1 h soak). What a web team lacks is on the read side: no error grouping or issues, no alerts, no web-vitals aggregates or dashboards, and a session list filterable by six fields.
2. **Error grouping is the largest single gap.** Every exception lives only inside its session. A fingerprint (type + top symbolicated frames, or message template) computed in rum-api at read time over Loki, plus an errors page in the plugin, would make the existing data usable the way Sentry users expect.
3. **Web vitals are collected but never summarised.** The events already carry name, value, rating and `url.path`; a p75-by-route view and a provisioned dashboard on Loki are cheap. Switching to `web-vitals/attribution` costs bytes the core budget does not have (48 bytes of headroom), so attribution needs a budget decision or a separate entry.
4. **The core bundle is at its budget.** 45,008 B gzip against 45,056 B. Any new capture feature (attribution, console breadcrumbs, network details) needs code moved to a lazy chunk or a raised budget. The README's "about 42 KB" is stale.
5. **Replay privacy default differs from Sentry's.** ouo masks inputs and records page text; Sentry masks all text by default. A `maskAllText` option (rrweb supports it) would close the gap for customers who ask.
6. **Replay serialisation is all on the main thread** (two `JSON.stringify` passes per event path); moving chunk building and gzip into a worker is the known fix if Appendix M shows the cost.
7. **Small fixes found:** `SDK_VERSION` reports 0.2.0 for 0.3.0 (add `src/version.ts` to release-please `extra-files`); root README omits Funnels; `ouo.*` interaction events render as generic custom events.
8. **Scale ceiling to keep in mind:** sessions are folded per request from at most 100,000 Loki events per list query, with no session index; fine for pilots, a limit for a busy site's 24 h view.
9. **Framework reach:** React only, ESM only. Vue / Angular packages and a CDN build are the most visible absences for teams coming from Sentry or Datadog.
