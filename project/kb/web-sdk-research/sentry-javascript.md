# Appendix A: Sentry in the browser (sentry-javascript and Sentry's rrweb fork)

Written 2026-10-29 by the `sentry-javascript` research session. Everything below was read in the source unless it is marked `[docs only]`, `[blog only]` or `[PR only]`. Sizes marked "measured here" were measured on 2026-10-29 from the public CDN.

**Citation key.**

- `sj:<path>:<line>` = `getsentry/sentry-javascript` at tag **11.10.0**, commit `9e336604b4ef77804a6669fea8e272e18ed8f0ce` (2026-10-28). Paths are relative to the repo root.
- `srr:<path>:<line>` = `getsentry/rrweb` (Sentry's fork) at tag **2.45.0**, commit `a946342f59ed09598dd8329d0ace43f7bce4c956` (2026-10-28), the version pinned by `sj:packages/replay-internal/package.json:14-15`.
- `rr:<path>` = upstream `rrweb-io/rrweb` at `e051ddbf` (tag `rrweb@2.2.0`, 2026-10-24), read only to tell fork changes from upstream.

Version 11 is a major release from 2026-09-23 (`git log 11.0.0`). Several facts that older write-ups repeat are no longer true. The web-vitals library is no longer vendored. Span streaming is the default. `sendDefaultPii` is gone. Transaction-based profiling is gone. Section 9 lists these.

## 1. Sources

| Source | Version studied | Licence | Notes |
|---|---|---|---|
| `github.com/getsentry/sentry-javascript` | 11.10.0, `9e336604` | MIT (`sj:LICENSE:1-3`) | Cloned blobless. A private worktree was checked out at the tag. No install scripts were run. The monorepo now also holds the bundler plugins (`sj:packages/bundler-plugins`). |
| `github.com/getsentry/rrweb` (branch `sentry-v2`) | 2.45.0, `a946342f` | MIT | Published as `@sentry/rrweb`, `@sentry/rrweb-snapshot`, `@sentry/rrdom`, `@sentry/rrweb-types`, `@sentry/rrweb-worker` (`srr:README.md:9-18`) |
| `github.com/rrweb-io/rrweb` | `e051ddbf` (rrweb 2.2.0) | MIT | Upstream, for the diff |
| PR comment "size-limit report" on getsentry/sentry-javascript#25907 | develop `f7b6364`, 2026-10-29 | n/a | The CI-measured gzip sizes of every preset, one day after 11.10.0. Fetched with `gh api`. |
| Docs: Replay performance overhead | fetched 2026-10-29, "last updated Sept 25, 2023" | n/a | https://docs.sentry.io/product/session-replay/web/performance-overhead/ |
| Blog: "Measuring Session Replay Overhead" | 2023 | n/a | https://blog.sentry.io/measuring-session-replay-overhead/ |
| Docs: Understanding Sessions; Replay issue types | fetched 2026-10-29 | n/a | https://docs.sentry.io/platforms/javascript/session-replay/understanding-sessions/ and `/issue-types/` |
| `github.com/getsentry/web-benchmark` README | fetched 2026-10-29 | n/a | The successor of the removed `overhead-metrics` package (7.2) |
| Public CDN `browser.sentry-cdn.com/11.10.0/*.min.js` | 11.10.0 | MIT | Sizes measured here, piped through `wc`/`gzip -9`. Nothing was saved. |

Everything that runs in the page is open source. The server pieces are not MIT: the replay player and issue detection live in `getsentry/sentry` (FSL), and ingestion lives in Relay (FSL). The loader-script template is served by the Sentry server. A minified copy is checked in as a test fixture, `sj:dev-packages/browser-integration-tests/fixtures/loader.js` (2,643 bytes).

## 2. Packages and frameworks

### 2.1 npm packages (browser side)

In v11 the internal packages lost the `@sentry-internal/` scope, except the worker.

| Package | Role | Key deps |
|---|---|---|
| `@sentry/browser` | Client, default integrations, transports, tracing, profiling, feature flag integrations, CDN bundle entry points | `@sentry/core`, `@sentry/browser-utils`, `@sentry/replay`, `@sentry/replay-canvas`, `@sentry/feedback`, `@sentry/conventions ^0.29.0` (`sj:packages/browser/package.json:40-46`) |
| `@sentry/core` | Platform-neutral client, scopes, envelopes, rate limits, idle spans, span streaming, sessions | none |
| `@sentry/browser-utils` | DOM, history and XHR instrumentation; performance entries; web vitals; interactions | **`web-vitals ^6.2.3`** (`sj:packages/browser-utils/package.json`, dependencies) |
| `@sentry/replay` (source dir `replay-internal`) | Session Replay | `@sentry/rrweb 2.45.0`, `@sentry/rrweb-snapshot 2.45.0`, `fflate 0.8.3` (`sj:packages/replay-internal/package.json:2,14-16`) |
| `@sentry-internal/replay-worker` | The compression worker, inlined as a string | `fflate 0.8.3` |
| `@sentry/replay-canvas` | Canvas recording (opt-in) | `@sentry/rrweb` `CanvasManager` |
| `@sentry/feedback` | Feedback widget, modal, screenshot editor | `preact ^10.29.8` (dev dependency, bundled in) |

**Browser floor:** Safari 15+ since v11. Safari 14 was dropped (`sj:MIGRATION.md:42`). npm builds are transpiled with the `es2015` preset (`sj:dev-packages/rollup-utils/npmHelpers.mjs:141`). Module formats are ESM and CJS on npm and IIFE on the CDN.

### 2.2 CDN bundles and the loader script

- CDN bundles are named by feature set: `bundle`, `bundle.tracing`, `bundle.replay`, `bundle.tracing.replay`, `…feedback`, `…logs.metrics` (`sj:packages/browser/src/index.bundle.*.ts`).
- Single integrations are published as separate CDN files and can be loaded at runtime with `lazyLoadIntegration()`. The URL is `${cdnBaseUrl||'https://browser.sentry-cdn.com'}/${SDK_VERSION}/${bundle}.min.js` (`sj:packages/browser/src/utils/lazyLoadIntegration.ts:10-27,114-116`). The list includes `replayIntegration`, `replayCanvasIntegration`, `feedbackModalIntegration`, `feedbackScreenshotIntegration`, `browserProfilingIntegration`, `interactionsIntegration` and others. `feedbackAsyncIntegration` uses this to fetch the modal and screenshot code only when the widget opens (`sj:packages/browser/src/feedbackAsync.ts:2,9`).
- **Loader script.** A small stub defines `window.Sentry`.
  - It queues calls and buffers `error` / `unhandledrejection` events.
  - It loads the full bundle on the first error or `capture*` call ("lazy") or eagerly (`data-lazy="no"`).
  - On load it calls `init` and replays the queue.
  - It adds `browserTracingIntegration` when `tracesSampleRate` is set and `replayIntegration` when a replay sample rate is set (`sj:dev-packages/browser-integration-tests/fixtures/loader.js`, minified).
  - The SDK installs `window.onerror` by **assignment**, not `addEventListener`, so it can consume the loader's buffered errors the same way (`sj:packages/core/src/instrument/globalError.ts:20-24`). The typed loader subset is `sj:packages/browser/src/loader-types.ts`.

### 2.3 Framework packages: what each adds on top of `@sentry/browser`

| Package | Client-side additions (from `src/` listings) |
|---|---|
| `@sentry/react` | `ErrorBoundary` and `reactErrorHandler` for React 19 `onCaughtError`/`onUncaughtError`. Both attach the component stack as a linked `cause` error named `React ErrorBoundary <name>` (`sj:packages/react/src/error.ts:39-60,82`). `Profiler`/`withProfiler` create `ui.react.mount/update/render` spans (`profiler.tsx`). Router integrations for React Router v3/v6/v7 (including lazy routes and a route manifest), TanStack Router, and a Redux enhancer. Minimum React 17 (`sj:MIGRATION.md:55`). |
| `@sentry/vue` | `app.config.errorHandler` wrapping, component tracking spans (mount/update), Vue Router and TanStack Router routing instrumentation, a route provider, a Pinia plugin (`sj:packages/vue/src/`) |
| `@sentry/angular` | `ErrorHandler` provider, a `TraceService` for router spans, a `TraceDirective` for component init spans, Zone.js helpers (`sj:packages/angular/src/{errorhandler,tracing,zone}.ts`) |
| `@sentry/svelte` | A component-tracking **preprocessor** that injects init/update span code at build time, plus `withSentryConfig` (`sj:packages/svelte/src/{preprocessors,performance,config}.ts`) |
| `@sentry/nextjs` | App Router and Pages Router navigation instrumentation. Next's `onRouterTransitionStart` hook in `instrumentation-client.ts` is used when present, with fallbacks (`sj:packages/nextjs/src/client/routing/appRouterRoutingInstrumentation.ts:80-91`). Parameterized route names. Trace meta tags. A **`tunnelRoute`** rewrite that sends browser envelopes through the Next server (`sj:packages/nextjs/src/client/tunnelRoute.ts`). `withSentryConfig` for source-map upload. Minimum Next 14. |
| `@sentry/nuxt`, `@sentry/sveltekit`, `@sentry/solidstart`, `@sentry/tanstackstart-react`, `@sentry/astro`, `@sentry/react-router`, `@sentry/remix` | Each is client plus server: the client re-exports the framework's browser package with a routing integration. The server side handles SSR/edge and Vite/webpack plugins for source maps. `@sentry/astro` ships its own tunnel (`sj:packages/astro/src/tunnel.ts`). Remix 3 has no bundler, so the whole client file is size-limited (`sj:.size-limit.js:209-216`). |
| `@sentry/solid`, `@sentry/ember`, `@sentry/gatsby` | Error boundary or router integrations. Ember is a v2 addon with manual setup in v11. |

Route names come from a **route provider**. A framework SDK registers it with `setRouteProvider` on the client (`sj:packages/browser/src/client.ts:131-133`), so pageload and navigation spans get parameterized names instead of raw pathnames.

## 3. RUM

### 3.1 Default integrations

`eventFilters`, `functionToString`, `conversationId`, `browserApiErrors`, `breadcrumbs`, `console`, `globalHandlers`, `linkedErrors`, `dedupe`, `httpContext`, `cultureContext`, `browserSession` (`sj:packages/browser/src/sdk.ts:30-49`).

Tracing, replay, feedback, profiling, web vitals and interactions are opt-in integrations. `init` does three more things:

- It turns itself off inside an embedded browser extension unless `skipBrowserExtensionCheck` is set (`sdk.ts:98-99,122`).
- It resolves the managed tunnel (`sdk.ts:121`).
- It uses `makeFetchTransport` (`sdk.ts:125`).

### 3.2 Sessions: two unrelated session models

**Release-health session** (`browserSessionIntegration`):

- One session per page load. The default `lifecycle` is `'page'`; `'route'` starts a new session on every history change (`sj:packages/browser/src/integrations/browsersession.ts:14-26,86-97`).
- **No storage, no idle timeout, no cross-tab sharing.** The session lives in memory on the isolation scope. Duration is discarded (`ignoreDuration: true`): "Automatically captured sessions are akin to page views" (`:37-41`).
- The first session envelope is deferred with `whenIdleOrHidden` so it does not compete with LCP (`:43-57`; `sj:packages/browser-utils/src/web-vitals/utils.ts:164`).
- A user change after that first send re-sends the session so `did` gets filled (`:68-84`).
- Status rules:
  - The first error sets `errors: 1` and sends an update.
  - An unhandled exception (`mechanism.handled === false`) sets the status to **`unhandled`** in the browser, not `crashed` (`sj:packages/browser/src/client.ts:135-136`; `sj:packages/core/src/client.ts:1374-1405`).
  - In v11 `captureMessage` marks the session errored too, because `attachStacktrace` now defaults to `true` (`sj:MIGRATION.md:637-647`).
- Session `aggregates` exist only on the server side (`sj:packages/core/src/integrations/http/record-request-session.ts`). The browser sends one `session` item per page or route.

**Replay session** (`@sentry/replay`):

- Stored in **`sessionStorage`** under `sentryReplaySession` when `stickySession` is true (default). It therefore survives reloads in the same tab but is **per tab**: no cross-tab sharing (`sj:packages/replay-internal/src/constants.ts:9`; `session/saveSession.ts:8-17`; `integration.ts:115`).
- **Idle pause 5 min:** recording pauses. **Idle expiry 15 min:** a new session starts on the next activity. **Max length 60 min** (`constants.ts:14-18,55-56`; `util/isSessionExpired.ts:7-21`).
- The replay id is not the release-health session id. They are linked only through events (4.6).

**Traces across page loads.** `linkPreviousTrace: 'in-memory'` is the default. Each new pageload or navigation root span gets a `previous_trace` span link if the previous root started within 1 h. Opt in to `sessionStorage` (`sentry_previous_trace`) to keep the link across reloads (`sj:packages/browser/src/tracing/linkedTraces.ts:37-42,173-190`; `browserTracingIntegration.ts:289,638`).

### 3.3 Errors

| Aspect | Implementation | Code |
|---|---|---|
| Global handlers | `window.onerror` and `window.onunhandledrejection` by assignment, chaining the previous handler. `mechanism.type` is `auto.browser.global_handlers.onerror` / `.onunhandledrejection`, with `handled: false`. | `sj:packages/core/src/instrument/globalError.ts:20-48`; `globalUnhandledRejection.ts:22-38`; `sj:packages/browser/src/integrations/globalhandlers.ts:54-106` |
| Wrapped browser APIs | `browserApiErrorsIntegration` wraps `setTimeout`, `setInterval`, `requestAnimationFrame`, `XMLHttpRequest.send` (onload/onerror/onprogress/onreadystatechange) and `addEventListener` on 30 prototypes (`EventTarget,Window,Node,…`) in try/catch. Errors thrown in callbacks get real stacks and a mechanism instead of `Script error.`. | `sj:packages/browser/src/integrations/browserapierrors.ts:6-67` |
| Stack parsing | Regex line parsers, Chrome (priority 30) and Gecko (50) by default. Opera and WinJS parsers exist but are not default. **Max 50 frames.** Lines are cut at 1,024 chars. Sentry's own frames are stripped. | `sj:packages/browser/src/stack-parsers.ts:29-33,56-114,183-185`; `sj:packages/core/src/utils/stacktrace.ts:6,33,57-62` |
| Linked errors | Follows `error.cause` up to **5** deep | `sj:packages/core/src/integrations/linkederrors.ts:11-17` |
| Dedupe | Compares with the **previous** event only: same message, or same exception type and value, plus the same fingerprint and the same frames → drop | `sj:packages/core/src/integrations/dedupe.ts:12-31,47-151` |
| Filtering | Built-in `ignoreErrors` list (`Script error.`, ResizeObserver loop, googletag, Instagram/Facebook webview noise, CEFSharp …) plus `allowUrls`/`denyUrls`. Optional `thirdPartyErrorFilterIntegration` uses build-time module metadata to drop or tag errors with third-party frames (4 modes). | `sj:packages/core/src/integrations/eventFilters.ts:12-25`; `sj:packages/core/src/integrations/third-party-errors-filter.ts:19-33` |
| Grouping hints | **No client-side grouping.** The SDK sends `fingerprint` only when the user sets it on the scope or event; grouping is server-side. The scope **transaction name** is kept as the URL path, even when span names are low-cardinality fallbacks, because "error events are grouped by" it (`browserTracingIntegration.ts:768-771,808-815`). | |
| Context lines | Browser `contextLinesIntegration` (opt-in) adds lines only for **inline `<script>` code in the page HTML**, default 5 lines (`dataCollection.frameContextLines`). For JS files the server fetches sources or uses source maps. | `sj:packages/browser/src/integrations/contextlines.ts:6,22-45` |
| Debug IDs / source maps | The bundler plugin injects a snippet that stores `new Error().stack → debugId` in `globalThis._sentryDebugIds` and appends `//# debugId=<uuid>` to each bundle. At event time the SDK parses those stacks into a filename → debugId map (cached by key count) and puts `debug_meta.images` on the event. The native `_debugIds` map (Vercel / TC39 proposal) is also read. | `sj:packages/bundler-plugins/src/core/index.ts:99`; `sj:packages/bundler-plugins/src/core/debug-id-upload.ts:98-118`; `sj:packages/core/src/utils/debug-ids.ts:26-70`; `sj:packages/core/src/utils/prepareEvent.ts:71,145,196-212` |
| `captureConsole` | Opt-in. Every `console.<level>` call becomes an event: `console.error` with an Error argument → `captureException`; `console.assert` → message "Assertion failed: …"; otherwise `captureMessage` with a synthetic stack. Marked `handled: true` by default. | `sj:packages/core/src/integrations/captureconsole.ts:14-101` |
| Other opt-ins | `httpClientIntegration` (HTTP 5xx as errors), `reportingObserverIntegration`, `extraErrorDataIntegration`, `rewriteFramesIntegration`, `graphqlClientIntegration` | `sj:packages/browser/src/integrations/` |

**Breadcrumbs.**

- **100** kept by default (`maxBreadcrumbs`) (`sj:packages/core/src/breadcrumbs.ts:12,26`; `sj:packages/core/src/scope.ts:32`).
- The default `breadcrumbsIntegration` records:
  - `dom`: `ui.click` / `ui.input` (keypress) with a CSS-ish element path from `htmlTreeAsString`, `maxStringLength` capped at 1,024;
  - `xhr`;
  - `fetch`;
  - `history` (`navigation`);
  - `sentry.event` / `sentry.transaction`.
  (`sj:packages/browser/src/integrations/breadcrumbs.ts:36-80,99,128-158,208,250`.)
- Console breadcrumbs moved to the separate default `consoleIntegration`. It records all `CONSOLE_LEVELS` (debug, info, warn, error, log, assert, trace) as `category: 'console'` (`sj:packages/core/src/integrations/console.ts:32-94`; `sj:MIGRATION.md:1595`).

### 3.4 Page loads, SPA navigations and idle spans

`browserTracingIntegration` is skipped entirely for bot user agents (`browserTracingIntegration.ts:350,428-432`).

**Pageload.**

- Started in `afterAllSetup` with `startTime = performance.timeOrigin`, so DNS, TLS, TTFB and parsing are inside the span even if the SDK loads late (`browserTracingIntegration.ts:640-652,766-781`).
- It continues a server trace from `<meta name="sentry-trace">` / `<meta name="baggage">` or from **`Server-Timing`** entries with those names (`:557-563,841-858`).
- `disableAutoFinish` keeps it open until `document.readyState` is `interactive` or `complete`. After that, idle logic ends it (`:395-421`). `enableReportPageLoaded` lets the app end it explicitly (`:578-583`).

**SPA navigation detection.**

- `history.pushState` / `replaceState` are wrapped with `fill()`, plus a `popstate` listener (`sj:packages/browser-utils/src/instrumentation/history.ts:37,83-84`). Every URL change starts a `navigation` idle span with a **new trace id** and `parentSpan: null` (`browserTracingIntegration.ts:507-536,654-695`).
- **Redirect heuristic:** a navigation within **1.5 s** of the previous root span start, with no click or keydown in the last 1.5 s, becomes a zero-length `navigation.redirect` child instead of a new root (`:445-451,857-881`).
- **bfcache restores** (`pageshow` with `persisted`) start their own navigation span tagged `browser.navigation.type=back-forward-cache` (`:694-735`).
- The Navigation API and `soft-navigation` entries are **not** used to start spans. Soft-navigation entries are used only to attribute web vitals (3.5).
- Framework routers call `startBrowserTracingNavigationSpan` directly with parameterized names (2.3).

**Idle span** (`sj:packages/core/src/tracing/idleSpan.ts`):

- Defaults: `idleTimeout` **1,000 ms**, `finalTimeout` **30,000 ms**, `childSpanTimeout` **15,000 ms** (`:26-30`).
- Each child span start cancels the idle timer. When the last child ends, the idle timer restarts (`:214-284,362-400`).
- If a child stays open longer than `childSpanTimeout`, the span ends with reason `heartbeatFailed` (`:249-254`).
- The end timestamp is **trimmed** to the latest child end, capped at `start + finalTimeout` (`:157-203`).
- Children that started after the end or ran longer than final + idle are discarded (`:335-350`).
- The finish reason is recorded as an attribute (`:306-307`).
- Background tab: on `visibilitychange` → hidden, the active root span is ended with status `cancelled` and `sentry.cancellation_reason=document.hidden` (`sj:packages/browser/src/tracing/backgroundtab.ts:10-45`). `pagehide` ends the root span and flushes (`browserTracingIntegration.ts:595-611`).
- After a route span ends, the scope keeps its trace id, so errors after the pageload still join that trace until the next navigation (`:470-488`).

**Child spans attached at the end of a route span** (`addPerformanceEntries`, `sj:packages/browser-utils/src/performance/entries.ts:212-276`):

- `navigation` timing phases (`_addNavigationSpans`, `:293`);
- `paint`;
- **resource spans** with op `resource.<initiatorType>`, skipping `fetch`/`xmlhttprequest` entries, which come from request instrumentation (`:426-450`). Attributes include `transferSize`, `encodedBodySize`, `decodedBodySize`, `renderBlockingStatus`, `deliveryType` and `responseStatus` (`:476-490`). `ignoreResourceSpans` filters by op.
- `performance.mark/measure` spans moved to the opt-in `userTimingIntegration` in v11 (`sj:MIGRATION.md:1600-1601`).

### 3.5 Web vitals, long tasks, LoAF, interactions

- **Library:** the npm package **`web-vitals ^6.2.3`** (the standard build, not `web-vitals/attribution`). It replaced the vendored copy in v11 (CHANGELOG "Replace vendored web-vitals with web-vitals@6 dependency" #23070; bumped to 6.2.3 in #25062). `onCLS`, `onFCP`, `onINP`, `onLCP`, `onTTFB` are wrapped (`sj:packages/browser-utils/src/instrumentation/performanceObserver.ts:2,325-385`).
- **Attribution is Sentry's own:**
  - LCP element and URL: `lcp.element`, `lcp.url` (`sj:packages/browser-utils/src/web-vitals/tracking.ts:247,256`).
  - Up to N CLS sources: `cls.source.<n>` (`:277`), as `browser.web_vital.*` attributes on streamed spans (`web-vitals/spans.ts:217-223,325`).
  - INP target: captured by its own capture-phase listeners on ~25 event types, storing `timestamp → htmlTreeAsString(target)` before the Event Timing entry arrives (`web-vitals/inp.ts:15-56,74-105,156`). The INP event type maps to `ui.interaction.click|hover|drag|press` (`web-vitals/spans.ts:57-62,459`).
  - INP values above **60 s** are discarded as implausible (`inp.ts:24`).
  - The Event Timing observer runs with `durationThreshold: 0` (`performanceObserver.ts:419-420`).
- **Where vitals go** (`sj:packages/browser/src/integrations/webVitals.ts:72-146`):
  - `webVitalsIntegration` is auto-added by `browserTracingIntegration` (`browserTracingIntegration.ts:622-633`).
  - With span streaming (the v11 default) LCP, CLS and INP are **standalone spans**. With `traceLifecycle: 'static'`, LCP and CLS are measurements on the pageload span, and INP is always a span.
  - **Per soft navigation:** in browsers with the Soft Navigations API (`PerformanceObserver.supportedEntryTypes.includes('soft-navigation')`), each soft navigation gets its own LCP, CLS and INP joined to its navigation span (`web-vitals/softNavs.ts:1-70`; `sj:MIGRATION.md:581-597`).
  - **Per bfcache restore** too (`sj:MIGRATION.md:609`).
  - CLS and LCP no longer send intermediate values (`reportAllChanges` off when soft navs or bfcache are reported; `performanceObserver.ts:173-177,334,348`).
- **Long Animation Frames:** used when `long-animation-frame` is supported (default `enableLongAnimationFrame: true`). Otherwise long tasks (`browserTracingIntegration.ts:283-284,436-444`).
  - Each LoAF becomes a `ui.long-animation-frame` child of the **active** span, but only while a span is active, so frames outside pageload, navigation or interaction are not reported.
  - Attributes: `browser.script.invoker`, `invoker_type`, `code.file.path` (sourceURL), function name and char position of the **first** script (`entries.ts:139-200`).
  - Long tasks become `ui.long-task` spans, also only under an active span (`entries.ts:101-130`).
- **Interaction spans:** the opt-in `interactionsIntegration` starts an idle `ui.action.click` span on click (same 1 s / 30 s / 15 s defaults) when no pageload or navigation is running (`sj:packages/browser-utils/src/performance/interactions.ts:21-45,183-212`; `sj:MIGRATION.md:1625-1627`).

### 3.6 Network and propagation

- `fetch` (via `@sentry/core` instrumentation) and XHR (`sj:packages/browser-utils/src/instrumentation/xhr.ts`) create `http.client` spans (`traceFetch`/`traceXHR` default true). With `enableHTTPTimings` (default true) the matching Resource Timing entry is attached as attributes (`sj:packages/browser/src/tracing/request.ts:122-126,174-195,263`).
- **Headers:** `sentry-trace` and `baggage` always. W3C **`traceparent`** only with `propagateTraceparent: true` (default **false**) (`request.ts:150,438-462`; `sj:packages/core/src/types/options.ts:487-489`).
- **Targets** (`shouldAttachHeaders`, `request.ts:274-312`):
  - With no `tracePropagationTargets`, headers go to **same-origin** requests only.
  - Otherwise the full URL is matched, and the pathname too for same-origin requests. Matching is case-insensitive since v11 (`sj:MIGRATION.md:753`).
- **Tracing without performance:** when tracing is off, the SDK still propagates a stable trace id and a random `propagationSpanId` per route, so backend errors link to the page (`browserTracingIntegration.ts:526-530,566-571`).
- **DSC in `baggage`:** `sentry-trace_id`, `sentry-sample_rand`, `sentry-replay_id` (only in replay session mode, 4.6) and others.
- **Body capture** belongs to replay (4.5). The `dataCollection.httpBodies` v11 default (`true`) is used by server-side SDKs (`sj:MIGRATION.md:172-197`).

### 3.7 Frustration signals

These are emitted by replay, not by tracing (4.4). Error clicks are a server-side join of clicks and errors in the replay `[docs only]`.

### 3.8 Logs, metrics, custom spans

- `Sentry.logger.*` and `Sentry.metrics.*` add `logs` and `metrics` envelope items, with `sentry.replay_id` attached when a replay is active (`sj:packages/core/src/logs/internal.ts:120`; `sj:packages/core/src/metrics/internal.ts:113`).
- Custom spans: `startSpan`, `startInactiveSpan`, `startSpanManual`.

### 3.9 Feature flags

- Integrations: LaunchDarkly (an inspector hook of type `flag-used`), OpenFeature (a provider hook: `after` and `error`), Statsig (`gate_evaluation` events), Unleash (`fill()` of `isEnabled`), GrowthBook, plus a generic `featureFlagsIntegration` (`sj:packages/browser/src/integrations/featureFlags/*/integration.ts`).
- All of them call `_INTERNAL_insertFlagToScope` and `_INTERNAL_addFeatureFlagToActiveSpan`:
  - An **LRU of the last 100** evaluations on the scope is copied to `contexts.flags.values[{flag, result}]` on error events.
  - **Up to 10** per span are recorded as `flag.evaluation.<key>` attributes.
  - **Only boolean values are recorded.** Others are a no-op (`sj:packages/core/src/utils/featureFlags.ts:8-25,77-129`).

## 4. Session replay

### 4.1 Recorder and options

`replayIntegration` wraps `record()` from `@sentry/rrweb`. Defaults (`sj:packages/replay-internal/src/integration.ts:111-224`):

| Option | Default | Note |
|---|---|---|
| `maskAllText` | **true** | text replaced with `*` |
| `maskAllInputs` | **true** | plus `maskInputOptions.password` |
| `blockAllMedia` | **true** | blocks `img,image,svg,video,object,picture,embed,map,audio,link[rel=icon],link[rel=apple-touch-icon]` and ignores the CSS `background-image` (`:23-24,224-231`) |
| `maskAttributes` | `title`, `placeholder`, `aria-label` | |
| `mask`/`unmask`/`block`/`unblock`/`ignore` | selectors | the fork adds `unblockSelector` and `unmaskTextSelector` (4.8) |
| rrweb options | `slimDOMOptions: 'all'`, `inlineStylesheet: true`, **`inlineImages: false`**, **`collectFonts: true`**, errors from rrweb tagged `__rrweb__` and dropped from reporting (`:175-191`; `coreHandlers/handleGlobalEvent.ts:76-81`) | |
| `flushMinDelay` / `flushMaxDelay` | **5,000 / 5,500 ms** | debounce with `maxWait` (`constants.ts:20-24`; `replay.ts:208-210`) |
| `minReplayDuration` | **4,999 ms** (capped at 50 s) | shorter replays are not sent (`constants.ts:46-53`; `replay.ts:1306-1316`) |
| `maxReplayDuration` | **60 min** | |
| `mutationBreadcrumbLimit` | **750** | a `replay.mutations` breadcrumb when one mutation batch exceeds it |
| `mutationLimit` | **10,000** | the replay **stops** (`reason: 'mutationLimit'`) when one batch exceeds it (`replay.ts:1362-1405`) |
| `slowClickTimeout` | **7,000 ms** | 4.4 |
| `networkDetailAllowUrls` | `[]` | bodies and headers only for listed URLs (4.5) |
| `useCompression` | true | 4.3 |
| `_experiments.recordCrossOriginIframes` | false | |
| iOS / iPadOS | rrweb `sampling.mousemove: false` | it blocked the main thread (issue #14534) (`util/getRecordingSamplingOptions.ts:5-22`) |
| Throttle | at most **300 custom events per 5 s** (breadcrumbs, performance spans). Then one `replay.throttled` breadcrumb. | `replay.ts:212-218,813-830` |

Replay sample rates live in `init`: `replaysSessionSampleRate`, `replaysOnErrorSampleRate` (`integration.ts:427-440`).

### 4.2 Modes, buffer length and segmenting

- **Sampling** happens once per replay session: `random < sessionSampleRate` → `'session'`, else `errorSampleRate > 0` → `'buffer'`, else not recorded (`session/createSession.ts:7-24`; `replay.ts:325-358,906`).
- **Buffer (on-error) mode:**
  - rrweb runs with `checkoutEveryNms: 60_000` (`BUFFER_CHECKOUT_TIME`) (`constants.ts:26-27`; `replay.ts:449-453`).
  - On each checkout in buffer mode the event buffer is **cleared** and restarts from the new full snapshot (`util/addEvent.ts:62-71`; `util/handleRecordingEmit.ts:57-59`). At error time the buffer therefore holds **0–60 s** (since the last full snapshot), not a steady 60 s. The docs say "the last 60 seconds" `[docs only]`.
  - Each error event draws again against `errorSampleRate`. Only events with an `exception` and no `type` count (`coreHandlers/util/shouldSampleForBufferEvent.ts:22-27`).
  - A sampled error gets `tags.replayId`. After the error is sent successfully, `sendBufferedReplayOrFlush` uploads the buffer and switches to session mode (`coreHandlers/handleGlobalEvent.ts:83-100`; `coreHandlers/handleAfterSendEvent.ts:14-66`). `replay_type` stays `buffer`.
  - `beforeErrorSampling` can veto.
- **Session mode:** each `addUpdate` triggers the debounced flush, so segments are cut every **5–5.5 s** of activity (`replay.ts:641-660`). Optional `_experiments.continuousCheckout` forces a full snapshot at most every 6 min to speed up seeking (`:455-464`).
- **Pause / expiry:**
  - 5 min without user activity pauses recording.
  - 15 min expires the session; the next activity starts a new replay id.
  - 60 min stops the replay (`replay.ts:186-190,758-790`).
  - A flush is refused when the duration exceeds `maxReplayDuration + 5 s` (`:1307`).
- **Max buffer size:** **20 MB** uncompressed per segment (`REPLAY_MAX_EVENT_BUFFER_SIZE`). Exceeding it stops the replay (`constants.ts:43-44`; `eventBuffer/EventBufferCompressionWorker.ts:69-73`; `EventBufferArray.ts:46-49`).

### 4.3 Compression in a Web Worker

- The worker source is an inlined string. `getWorkerURL()` makes a **Blob URL** with `type: 'text/javascript'` (Safari rejects untyped blobs) (`sj:packages/replay-worker/src/index.ts:6-14`).
- It compresses with **fflate** `Zlib` streaming: each event is pushed as a JSON string with `,` separators; `finish()` closes the `]` and returns the zlib bytes (`sj:packages/replay-worker/src/Compressor.ts:1-60,67`).
- **Fallback:** recording starts at once into an in-memory `EventBufferArray`. When the worker reports ready, buffered events are replayed into it (`eventBuffer/EventBufferProxy.ts:84-140`). If `new Worker()` throws, for example under CSP without `worker-src blob:`, or the worker fails to load, the SDK stays on the array buffer and sends **uncompressed JSON** (`eventBuffer/index.ts:19-54`).
- `workerUrl` lets the app host the worker file itself (CSP-friendly).
- The build flag `__SENTRY_EXCLUDE_REPLAY_WORKER__` drops the inlined worker (`:56-62`). Measured size effect in 7.1.

### 4.4 Slow, multi, rage and dead clicks

`ClickDetector` (`sj:packages/replay-internal/src/coreHandlers/handleClick.ts`):

- **Eligible elements:** only `A`, `BUTTON` and `INPUT[type=submit|button]`. Not links with `download` or `target` ≠ `_self`. Not matches of `slowClickIgnoreSelectors` (`:283-312`).
- After a click it waits for a DOM mutation (via the rrweb mutation callback) or a scroll. `threshold` = min(3,000 ms, timeout). A scroll counts only within **300 ms** (`constants.ts:38-41`; `replay.ts:220-232`).
- Checked every **1 s** (`:279`). If no mutation came within the threshold, it emits `ui.slowClickDetected` with `timeAfterClickMs`, `endReason` (`mutation` if a late mutation came before the 7 s timeout, else `timeout`), `clickCount`, `node` and the selector (`:219-250`).
- Further clicks on the same element while one is pending increment `clickCount`. `ui.multiClick` is emitted when `clickCount > 1` (`:160-171,254-266`).
- **Classification is server-side** `[docs only]`:
  - "Dead click" = no DOM update or scroll within 7 s.
  - "Rage click" = 3+ clicks on a dead-click-eligible element within the 7 s window.
  - Both are created as issues "during replay ingest".

### 4.5 Network, console, performance data inside the replay

- **Network:** fetch and XHR become rrweb custom events (`resource.fetch` / `resource.xhr` spans) with method, status and sizes.
- **Headers and bodies** are recorded only for URLs in `networkDetailAllowUrls` and not in `networkDetailDenyUrls` (`coreHandlers/util/fetchUtils.ts:87`).
  - Default headers: `content-length`, `content-type`, `accept` (`integration.ts:26`).
  - Bodies are on by default for allowed URLs (`networkCaptureBodies: true`), truncated at **150,000 chars** (`constants.ts:32-33`; `coreHandlers/util/networkUtils.ts:183-187`).
- **Console:** console breadcrumbs go into the replay, with each argument normalized and truncated to **5,000 chars** (`constants.ts:35-36`; `coreHandlers/handleBreadcrumbs.ts:53-61`).
- **Performance:** navigation, resource and paint entries; LCP, CLS and INP as `web-vital` entries; and `performance.memory` (Chromium only) every flush (`util/createPerformanceEntries.ts:21-25,200,262`; `util/addMemoryEntry.ts:14-43`; `coreHandlers/performanceObserver.ts:34-40`).
- Error events sent while a replay runs get their `breadcrumbs` **deleted**, because the replay carries them (`coreHandlers/handleGlobalEvent.ts:40-42`).
- Segment 0 carries an `options` custom event with the sampling and privacy settings (`util/handleRecordingEmit.ts:188-206`).

### 4.6 Linking replay ↔ errors ↔ traces

| Direction | How | Code |
|---|---|---|
| error → replay | `tags.replayId` on errors (session mode, or sampled in buffer mode) | `coreHandlers/handleGlobalEvent.ts:88-95` |
| replay → error | `replay_event.error_ids` (max 100 per segment), from sent error events | `coreHandlers/handleAfterSendEvent.ts:42-49`; `util/sendReplayRequest.ts:41-51` |
| replay → trace | `replay_event.trace_ids` and `segment_names` from transactions or segment spans | `handleAfterSendEvent.ts:26-36` |
| trace → replay | `replay_id` in the DSC (`baggage: sentry-replay_id=`), **session mode only**, removed when the replay session expires. The segment (root) span gets `sentry.replay_id`. | `util/addGlobalListeners.ts:35-47`; `util/resetReplayIdOnDynamicSamplingContext.ts`; `integration.ts:371` |
| feedback → replay | `contexts.feedback.replay_id`. Opening the widget flushes a buffered replay. | `coreHandlers/handleGlobalEvent.ts:59-71` |
| logs / metrics → replay | `sentry.replay_id` attribute | 3.8 |

### 4.7 Payload format

- One envelope per segment with two items (`util/createReplayEnvelope.ts:8-31`):
  1. `replay_event`, a JSON event: `type`, `replay_id`, `segment_id`, `replay_type` (`session`/`buffer`), `replay_start_timestamp`, `timestamp`, `error_ids`, `trace_ids`, `segment_names`, `urls` (`util/sendReplayRequest.ts:40-51`).
  2. `replay_recording` with an explicit `length`: the bytes `{"segment_id":N}\n` followed by the **zlib-deflated** (or plain) JSON array of rrweb events (`util/prepareRecordingData.ts:16-26`).
- Sends are retried up to 3 times from 5 s (`constants.ts:29-30`).
- Rate-limit headers covering `replay` stop the replay.
- The shared envelope format is in [sentry-envelope-format.md](../sentry-envelope-format.md).

### 4.8 Canvas, iframes, shadow DOM, and the rrweb fork

- **Canvas** is opt-in through `replayCanvasIntegration` (`sj:packages/replay-canvas/src/canvas.ts`).
  - Snapshots are taken as **WebP** at `low` 1 fps / q 0.25, `medium` (default) 2 fps / q 0.4, `high` 4 fps / q 0.5 (`:35-62,72`).
  - Max canvas size is 1,280 px per side (`:66,74-77`). `enableManualSnapshot` is available for WebGL apps.
  - The fork's `CanvasManager` encodes in a worker (`@sentry/rrweb-worker`).
- Same-origin iframes and shadow DOM are recorded (rrweb). They can be compiled out with `__RRWEB_EXCLUDE_IFRAME__` / `__RRWEB_EXCLUDE_SHADOW_DOM__` (`srr:packages/rrweb/src/record/index.ts:62-65`).
- Cross-origin iframes need `_experiments.recordCrossOriginIframes` and the SDK inside the iframe.

**What the fork changes vs upstream rrweb.** The version numbers diverged: fork 2.45.0 vs upstream 2.2.0. The fork's own summary (`srr:README.md:20-27`):

- Hooks and plugins are removed (the types remain but have no effect).
- Build flags turn the iframe, canvas and shadow-DOM managers into no-ops.
- Canvas is off unless `getCanvasManager` is passed to `record()`.

Checked against upstream `rr:` with `git grep`. Options present in the fork and absent upstream:

- `onMutation(mutations, helpers)`: lets the SDK inspect each batch and drop it or return a filtered list (2.45.0, fork PR #341). Replay's `mutationLimit` and `ignoreMutations` rely on it (`srr:packages/rrweb/src/types.ts:88,109-112`).
- `maskAllText`, `unmaskTextSelector`, `unblockSelector`, `maskAttributeFn` (`srr:…/types.ts:55-65`).
- `getCanvasManager` (`:89-91`).

Further fork work:

- Native `setTimeout`/`requestAnimationFrame` taken from a hidden **sandbox iframe**, so Zone.js / Angular patches do not intercept rrweb timers, with a fallback to window timers since 2.44.1 (`srr:packages/rrweb/src/utils.ts:614-650`). Upstream has a similar untainted-prototype helper for DOM prototypes (`rr:packages/utils/src/index.ts:46-62`).
- Mutation-buffer unlock after a failed full snapshot.
- Shadow-DOM observer teardown.
- Masking hidden inputs.
- Attribute-mutation optimisations ported back and forth (`srr:CHANGELOG.md:1-60,231,252,373-400`).

`mutation.ts` is 936 lines in the fork vs 757 upstream.

### 4.9 Player

The player is `@sentry/rrweb-player` / `rrweb` `Replayer` inside the FSL `getsentry/sentry` frontend. It was not studied here; Appendix A of the mobile study covers its video variant.

## 5. Transport and OpenTelemetry

- **Endpoint:** `POST {dsn host}/api/{project}/envelope/?sentry_version=7&sentry_key=…&sentry_client=…`. Auth is in the query string, so the default `text/plain` body is a CORS "simple request" with no preflight (`sj:packages/core/src/api.ts:17-33`).
- **Batching:** no time-based batching for errors. Each event is its own envelope, through a promise buffer of **40** in-flight requests (`sj:packages/browser/src/transports/fetch.ts:7,67`). Streamed spans are buffered per trace and flushed every **5 s**, at 1,000 spans, or at 5 MB, as `span` items with content type `application/vnd.sentry.items.span.v2+json` (`sj:packages/core/src/tracing/spans/spanBuffer.ts:12-17,82-123`; `spans/envelope.ts:42`).
- **Compression:** **none on the transport.** Only replay recordings are deflated (4.3).
- **Page hide:**
  - `fetch(..., { keepalive: pendingBodySize <= 60_000 && pendingCount < 15 })`, under the browser's 64 KiB keepalive budget (`fetch.ts:40`). `referrerPolicy: 'strict-origin'` (`:27`).
  - The native `fetch` is taken from a clean iframe (`getNativeImplementation('fetch')`) to avoid patched globals (`:14`).
  - On `visibilitychange` → hidden the client flushes outcome reports and, in a microtask, calls `flush()`, which drains span, log and metric buffers (`sj:packages/browser/src/client.ts:161-189`).
  - `pagehide` ends the active route span and flushes (3.4).
- **Rate limits:** `X-Sentry-Rate-Limits` per category (`retry_after:categories:scope:reason:namespaces`) and `Retry-After`. The default backoff is **60 s** (`sj:packages/core/src/utils/ratelimit.ts:8,53-90`).
- **Offline:** opt-in `makeBrowserOfflineTransport(makeFetchTransport)`.
  - It stores failed envelopes in IndexedDB `sentry-offline` / `queue`, max **30** (`sj:packages/browser/src/transports/offline.ts:38-69,100-139,176`).
  - Retries back off from 5 s, doubling to at most 1 h. Client reports are not queued. `flushAtStartup` is available (`sj:packages/core/src/transports/offline.ts:12-13,34,82-160`).
- **Tunnel (ad blockers):**
  - `tunnel: '<url>'` posts envelopes to the app's own origin. The envelope header carries the DSN, so the server forwards it.
  - v11 adds **`tunnel: true`**: a managed same-origin path derived from the DSN as `/<fnv1a32(dsn) base36>`, sent with `Content-Type: application/x-sentry-envelope` because SvelteKit and Astro CSRF checks reject `text/plain` (`sj:packages/browser/src/utils/managedTunnel.ts:15-42`; `sj:packages/core/src/utils/tunnel.ts:108-112`).
  - Server handlers: `serveTunnel` in core, Next.js `tunnelRoute`, Astro `tunnel.ts`.
- **CSP needs:** `connect-src` for the ingest host or tunnel; `worker-src blob:` for replay compression (else a silent fallback to uncompressed); `script-src` for the CDN when lazy-loading integrations; `img-src`/`media-src` for nothing (media is blocked by default).
- **OpenTelemetry in the browser: none.** `@sentry/browser`, `browser-utils`, `replay`, `feedback` and the browser framework packages have no `@opentelemetry/*` dependency and export no OTLP. A grep of `src/` finds only comments.
  - OTel shows up in naming only: span attributes come from `@sentry/conventions`, which follows semconv names (`url.full`, `url.path`, `code.file.path`, `http.route`).
  - The streamed span v2 schema is OTel-shaped: `trace_id`, `span_id`, `parent_span_id`, `name`, `start_timestamp`, `end_timestamp`, `status: ok|error`, typed attributes, `links` (`sj:packages/core/src/types/span.ts:46-83`). It is still a Sentry envelope item, not OTLP.
  - On the server, v11 stops "taking over" the OTel setup. `@sentry/node` exports `getOtlpTracesEndpoint(dsn)` → `/api/{project}/integration/otlp/v1/traces/` for a user's own `OTLPTraceExporter`. `openTelemetryIntegration` (server-utils) shares the trace context of an external OTel SDK (`sj:packages/server-utils/src/opentelemetry.ts:38-87`; `sj:MIGRATION.md:16,72`).
  - The browser can propagate W3C `traceparent` only when opted in (3.6).

## 6. Other features

- **Issue grouping, alerts, release health dashboards, replay issues:** all server-side. The SDK supplies `fingerprint` (user-set), `mechanism`, debug ids, the transaction name and release/session envelopes.
- **Source maps:** debug-id based (3.3). Upload is done by `@sentry/bundler-plugins` (webpack, Vite, esbuild, Rollup) or sentry-cli. The release-name injection file is `sj:packages/bundler-plugins/sentry-release-injection-file.js`.
- **Feedback widget** (`@sentry/feedback`):
  - A Preact UI in a shadow root: a floating button, a form and an optional screenshot editor.
  - **Screenshot** = `navigator.mediaDevices.getDisplayMedia({ video, audio: false, preferCurrentTab: true })`. The user must grant screen sharing. One frame of the stream is drawn to a `<canvas>`, cropped or annotated in the editor, and exported as **PNG** (`sj:packages/feedback/src/screenshot/components/useTakeScreenshot.tsx:18,71-92`; `screenshot/components/ScreenshotEditor.tsx:95,346`; `screenshot/integration.ts:25`).
  - Screenshots are disabled on mobile UAs, iPadOS and insecure contexts (`util/isScreenshotSupported.ts:16-32`).
  - The feedback is a `type: 'feedback'` event with `contexts.feedback {message, name, email, url, replay_id}` and the screenshot as an attachment (`sj:packages/core/src/feedback.ts:16-26`).
  - Sizes are in 7.1.
- **Profiling** (`browserProfilingIntegration`):
  - Uses the **JS Self-Profiling API** (`new Profiler({ sampleInterval: 10, maxBufferSize: 3000 })`), so the document must be served with **`Document-Policy: js-profiling`**. Without it the constructor throws and the SDK logs that and skips (`sj:packages/browser/src/profiling/utils.ts:225,245-265`). Chromium only.
  - v11 removed per-transaction profiling. `profileSessionSampleRate` is drawn once per page, and `profileLifecycle: 'trace'` (while root spans are active) or `'manual'` (`utils.ts:286-305`; `profiling/integration.ts:15-36`; `sj:MIGRATION.md:1820-1825`).
  - Data goes out as `profile_chunk` items every **60 s** (`profiling/UIProfiler.ts:22,32,316-337,421`).
  - Observation, not verified at runtime: the buffer is sized for 30 s (`MAX_PROFILE_DURATION_MS = 30_000` / 10 ms = 3,000 samples) while chunks are 60 s, so a continuously sampled chunk may hit `maxBufferSize` halfway.
- **Feature flags:** 3.9.
- **Consent / privacy:**
  - `dataCollection` replaces `sendDefaultPii`. **The v11 default is more permissive**: `userInfo`, cookies, headers, bodies, query params and GenAI I/O are on (`sj:MIGRATION.md:172-197`).
  - In the browser, `userInfo` controls IP inference: `infer_ip: 'auto'|'never'` in the SDK settings (`sj:packages/browser/src/client.ts:138-147`).
  - There is no cookieless mode to configure: the browser SDK writes no cookies and no localStorage. Replay uses `sessionStorage`; linked traces optionally use `sessionStorage`; the offline transport uses IndexedDB.
- **No heatmaps, funnels, product analytics or surveys** in the SDK.

## 7. Performance footprint

### 7.1 Bundle size

**How it is gated now.** Until 2026-10-21 `.size-limit.js` carried absolute `limit:` values. Commit `3f00b107c` "ci: Check bundle size increases per PR (#24737)" removed them. CI now builds every preset on the PR, compares it with the latest develop baseline, and **fails when any gzipped preset grows by more than 500 bytes** unless the PR carries the label `Accept Bundlesize Increase` (`sj:dev-packages/size-limit-gh-action/index.mjs:13,98,149-160`; `utils/SizeLimitFormatter.mjs:3,87-92`). Sizes are size-limit `kB` (1,000 bytes), gzip, webpack-bundled ESM importing only the named exports (`sj:.size-limit.js:4-216`).

| Preset (`sj:.size-limit.js` entry) | Last absolute limit (at `3f00b107c^`) | CI-measured, develop `f7b6364` (PR #25907, 2026-10-29) |
|---|---|---|
| `@sentry/browser` (init only = errors, breadcrumbs, sessions) | 35 KB | **30.43 kB** |
| … with tree-shaking flags (`__SENTRY_DEBUG__`, `__RRWEB_EXCLUDE_*`, `__SENTRY_EXCLUDE_REPLAY_WORKER__`) | 34 KB | 28.53 kB |
| + Tracing (`browserTracingIntegration`) | 58 KB | **52.69 kB** |
| + Tracing + Span Streaming | 58 KB | 52.70 kB |
| + Tracing, Profiling | 61 KB | 55.62 kB |
| + Tracing, Replay | 97 KB | **92.95 kB** |
| + Tracing, Replay, with tree-shaking flags | 86 KB | 81.55 kB |
| + Tracing, Replay with Canvas | 102 KB | 97.69 kB |
| + Tracing, Replay, Feedback | 115 KB | **110.67 kB** |
| + Feedback (no tracing) | 53 KB | 47.98 kB |
| + `sendFeedback` (API only) | 40 KB | 35.51 kB |
| + FeedbackAsync | 46 KB | 40.61 kB |
| + Logs / + Metrics / both | 37 / 36 / 37 KB | 31.71 / 31.43 / 32.39 kB |
| `@sentry/react` / + Tracing | 37 / 60 KB | 32.22 / 54.95 kB |
| `@sentry/vue` / + Tracing | 44 / 61 KB | 38.71 / 55.57 kB |
| `@sentry/svelte` | 35 KB | 30.45 kB |
| `@sentry/nextjs` (client) | 62 KB | 57.82 kB |
| `@sentry/sveltekit` (client) | 58 KB | 53.14 kB |
| `@sentry/core/browser` | 19 KB | 13.95 kB |

Increments from the CI numbers:

- tracing ≈ +22.3 kB;
- replay ≈ +40.3 kB on top of tracing;
- the tree-shaking flags save ≈ 11.4 kB on the replay preset (mostly the inlined worker plus iframe and shadow-DOM code);
- canvas ≈ +4.7 kB;
- feedback ≈ +17.6 kB eager, ≈ +10.2 kB with the async variant;
- profiling ≈ +2.9 kB.

**Published CDN bundles, 11.10.0, measured here** (raw bytes; `gzip -9` locally; the CDN serves `Content-Encoding: gzip` only, no brotli, `Cache-Control: max-age=31536000`):

| File | Raw | gzip -9 | Served gzip (Content-Length) | CI (`f7b6364`) |
|---|---|---|---|---|
| `bundle.min.js` (errors) | 95,063 | 32,371 | 32,422 | 32.15 kB |
| `bundle.tracing.min.js` | 158,404 | 53,389 | | 53.19 kB |
| `bundle.replay.min.js` | 227,684 | 73,839 | | |
| `bundle.tracing.replay.min.js` | 280,564 | 91,703 | 91,980 | 91.35 kB |
| `bundle.tracing.replay.feedback.min.js` | 294,285 | 97,664 | | 97.48 kB |
| `bundle.tracing.replay.feedback.logs.metrics.min.js` | 300,258 | 99,475 | | 99.49 kB |
| `bundle.feedback.min.js` | 108,802 | 38,087 | | |
| lazy `replay-canvas.min.js` / `feedback-modal.min.js` / `feedback-screenshot.min.js` / `browserprofiling.min.js` | 14,967 / 37,197 / 8,544 / 14,988 | 5,358 / 13,551 / 3,238 / 5,716 | | |

The loader stub is 2.6 KB raw (fixture). The docs still say "the Replay plugin is about 36 KB gzipped" `[docs only]`. The CI figure today is ≈ 40 kB.

### 7.2 Runtime overhead: vendor numbers and how they were measured

| Claim | Number | Method | Where |
|---|---|---|---|
| Replay overhead table, median of **50 runs** on an **Apple M1 MacBook Pro**, scenario "load Sentry, go to Errors, add 4 columns, wait, add a column, wait" (a mutation-heavy data table), three variants (none / SDK / SDK+Replay) | LCP 1599 / 1546 / 1529 ms (σ 386/511/354); CLS 0.40 all; FID 1.26 / 1.30 / 1.50 ms; **TBT 2621.67 / 2663.35 / 3036.80 ms**; avg memory 119.26 / 125.12 / 124.84 MB; max memory 320.66 / 359.21 / 339.03 MB; **upload 21 B / 3.84 KB / 272.51 KB**; download ≈ 8.07 MB | Playwright + Chromium harness ("Measuring Session Replay Overhead" methodology) | `[docs only]` https://docs.sentry.io/product/session-replay/web/performance-overhead/ , "last updated Sept 25, 2023" (SDK 7.x era). A simpler "4 settings pages" scenario: ≈ +100 ms TBT. |
| "Imperceptible to end-users for most apps" and "the only way to get accurate numbers is to measure yourself" | n/a | n/a | same page `[docs only]` |

**Benchmark code:**

- `dev-packages/overhead-metrics` (Playwright; collected CPU, memory, network, LCP, CLS, FID for none / Sentry / Sentry+Replay and posted a PR comment) was **deleted** on 2024-10-28 in `765213be4` (#14087), "We are not really using this ever". It lives on outside the repo as `getsentry/web-benchmark` (same design, `--runs`, `--cpu` throttle, `--network` options) `[docs only]`.
- What runs today is **`.github/workflows/lighthouse.yml`**: a **nightly**, non-blocking job ("Never blocks merges", `:3-4`). It builds `dev-packages/e2e-tests/test-applications/lighthouse-react` in 11 modes (`no-sentry`, `init-only`, `errors-only`, `minimal-integrations`, `no-integrations`, `no-browser-api-errors`, `no-breadcrumbs`, `no-browser-session`, `tracing`, `tracing-lazy-import`, `tracing-replay`) and uploads them to an external Lighthouse lab (`sj:scripts/lighthouse-bundle-and-upload.mjs:1-45`). The results are not in the repo.
- The only **merge-blocking** performance gate is bundle size (7.1).

### 7.3 Main thread vs worker

- **Main thread:**
  - rrweb snapshot and MutationObserver serialization;
  - `JSON.stringify` of every replay event (`EventBufferCompressionWorker.ts:69`);
  - htmlTreeAsString for breadcrumbs and INP targets;
  - all instrumentation wrappers;
  - building envelopes for errors and spans.
- **Worker:** replay zlib compression (fflate) and canvas WebP encoding (fork `rrweb-worker`).
- Things that are deferred: the first session envelope (`whenIdleOrHidden`), the replay worker load (recording starts into an array first), and lazy-loaded integrations.
- Things that are skipped: tracing for bots, LoAF and long-task spans when no span is active, mousemove sampling on iOS.

## 8. Blog-to-code grounding

| Claim (docs or blog) | Grounded in code? |
|---|---|
| "Compression of DOM content runs in a Web Worker so the UI thread is unaffected" | Partly. Compression is in the worker (`replay-worker/src/Compressor.ts`), but serialization and `JSON.stringify` stay on the main thread (`EventBufferCompressionWorker.ts:69`). Under a CSP without `blob:` it silently falls back to no compression (`eventBuffer/index.ts:39-54`). |
| "750 nodes → warning breadcrumb, 10,000+ → replay ends" | Yes: `integration.ts:123-124`, `replay.ts:1362-1405`. "Nodes" are mutation records per batch, through the fork's `onMutation` hook. |
| "Buffer mode keeps the last 60 seconds" | Approximately. A checkout every 60 s clears the buffer, so 0–60 s are kept (`addEvent.ts:62-71`). |
| "Session ends after 15 min inactivity / 60 min max" | Yes (`constants.ts:14-18,55-56`). There is also a 5 min pause that the docs page does not mention. |
| "Dead click = no DOM update or scroll within 7 s on button/input/a; rage = 3+ clicks" | The SDK emits `ui.slowClickDetected` and `ui.multiClick` with the data (`handleClick.ts:219-266,283-312`). The "3 clicks" rule is not in the SDK, so it is server-side. |
| "Masking and blocking enabled by default" | Yes (`integration.ts:119-121`), plus `title`, `placeholder` and `aria-label` attributes (`:136`). |
| "Replay plugin ≈ 36 KB gzipped" | Outdated. CI says ≈ 40 kB incremental on top of tracing (7.1). |
| TBT +415 ms / upload 272 KB with Replay (2023) | Not reproducible from the repo. The harness was removed in 2024 and today's nightly Lighthouse results are off-repo (7.2). |
| v11 "span streaming bypasses size and volume limits of transactions" | Yes: a per-trace buffer with 5 s / 1,000 spans / 5 MB flushes (`spanBuffer.ts:12-123`). |
| "Sending the session in `init` measurably hurts LCP" (code comment) | Implemented as deferral (`browsersession.ts:43-57`). No measurement in the repo. |

## 9. Questions asked and answers

1. **How do Sentry web sessions work?** There are two models. Release health is one in-memory session per page load (or per route), never persisted, duration ignored, status `ok` → errored (`errors: 1`) → `unhandled`; there are no browser aggregates (`browsersession.ts`; `core/client.ts:1374-1405`). The replay session is `sessionStorage`, per tab, with a 5 min pause, 15 min expiry and 60 min max (`replay-internal/src/constants.ts`).
2. **Which error handlers?** `window.onerror` / `onunhandledrejection` by assignment, plus try/catch wrapping of timers, rAF, XHR callbacks and `addEventListener` on 30 prototypes (3.3).
3. **Stack parsing?** Chrome and Gecko regex parsers, 50 frames, 1,024-char lines (`stack-parsers.ts:183`; `stacktrace.ts:6`).
4. **Dedupe?** Only the immediately previous event (`dedupe.ts:12-31`).
5. **Client-side grouping or fingerprints?** None automatic. The transaction name stays the URL path for grouping (3.3).
6. **Breadcrumbs?** 100 max: ui.click/input, xhr, fetch, navigation, sentry events, console (all levels) (3.3).
7. **Context lines?** Only for inline HTML scripts, 5 lines. File sources are resolved server-side (`contextlines.ts`).
8. **Debug ids?** A runtime map built from injected `Error().stack` keys → `debug_meta` (3.3).
9. **SPA navigations?** `pushState`/`replaceState` wrapping plus `popstate`; a 1.5 s redirect heuristic; bfcache via `pageshow.persisted`. Framework routers call the API directly (3.4).
10. **Idle span logic?** 1 s idle, 30 s final, 15 s child heartbeat, end trimmed to the last child (`idleSpan.ts`).
11. **Web vitals library?** npm `web-vitals` ^6.2.3, no longer vendored and no fork. It uses the standard build and adds Sentry's own attribution (3.5).
12. **INP?** web-vitals `onINP`, an Event Timing observer with threshold 0, and its own target capture; sent as a `ui.interaction.*` span; > 60 s dropped (3.5).
13. **LoAF?** Yes, preferred over long tasks, but only as children of an active span, with first-script attribution (`entries.ts:139-200`).
14. **Resources?** `resource.<initiatorType>` spans at the end of the route span, excluding fetch/XHR (`entries.ts:426-520`).
15. **Propagation?** `sentry-trace` + `baggage` always; `traceparent` opt-in; same-origin only unless `tracePropagationTargets` is set (3.6).
16. **Span streaming?** The v11 default (`traceLifecycle: 'stream'`, `core/client.ts:259-264`); `span` v2 items every 5 s (5).
17. **Replay defaults?** Mask all text and inputs, block all media, 5–5.5 s flush, 5 s minimum, 60 min maximum (4.1).
18. **Buffer mode?** A 60 s checkout cycle, so 0–60 s are kept; a second draw per error; switches to session mode after the error is sent (4.2).
19. **Replay compression?** fflate zlib in a Blob-URL worker; falls back to uncompressed JSON on CSP or worker failure; `workerUrl` to self-host (4.3).
20. **Slow, rage and dead clicks?** The SDK emits slow-click and multi-click breadcrumbs (3 s threshold, 7 s timeout, 300 ms scroll window, A/BUTTON/submit INPUT only). Rage and dead classification happens on the server (4.4).
21. **Network bodies?** Only for `networkDetailAllowUrls`, 150 k chars, default headers `content-type`, `content-length`, `accept` (4.5).
22. **Replay ↔ errors ↔ traces?** `tags.replayId`, `error_ids`, `trace_ids`, DSC `replay_id`, segment span attribute (4.6).
23. **Payload?** An envelope with `replay_event` JSON plus `replay_recording` = `{"segment_id":n}\n` + zlib JSON (4.7).
24. **Tunnel?** A string URL or the v11 `tunnel: true` managed DSN-hash path; framework helpers for Next and Astro (5).
25. **Offline?** Opt-in IndexedDB queue of 30, exponential retry 5 s → 1 h (5).
26. **Keepalive?** Yes, while in-flight bytes are ≤ 60,000 and requests < 15 (`fetch.ts:40`).
27. **OTel in the browser?** No. Semconv-like attribute names and an OTel-shaped span JSON only (5).
28. **Bundle sizes?** Errors 30.4 kB, +tracing 52.7, +replay 93.0, +feedback 110.7 kB gzip (CI, 2026-10-29). CDN bundle 32.4 KB served gzip (7.1).
29. **CI performance gating?** A +500 B gzip budget per PR per preset (merge-blocking). Nightly Lighthouse is non-blocking. The overhead harness was removed in 2024 (7.1, 7.2).
30. **Feedback screenshot?** `getDisplayMedia` with `preferCurrentTab` → canvas → PNG attachment; desktop and secure contexts only (6).
31. **Profiling?** JS Self-Profiling, 10 ms interval, needs `Document-Policy: js-profiling`, session-sampled, 60 s `profile_chunk`s (6).
32. **Feature flags?** Boolean evaluations only: LRU 100 on error events, 10 per span as `flag.evaluation.<key>` (3.9).
33. **What did the rrweb fork change?** Hooks and plugins removed, build flags to drop iframe/shadow/canvas, opt-in canvas manager with a worker, an `onMutation` filter hook, `maskAllText`/unmask/unblock selectors, `maskAttributeFn`, sandbox-iframe timers, plus bug fixes (4.8).

## 10. Takeaways for ouo

ouo's browser SDK already uses upstream `rrweb` and the same `web-vitals ^6.2.3` and is built on the OTel web SDK ([ouo-web-today.md](ouo-web-today.md), `sdk/browser/package.json`). Sentry's browser SDK has no OTel to reuse, so what follows is about mechanisms, not code paths. sentry-javascript and the rrweb fork are MIT: adapting ideas is fine, and copied code keeps Sentry's notice. The player and issue detection are FSL: ideas only.

**Worth copying:**

- **Bundle-size budget as a merge gate.** Use one size-limit entry per preset (errors only, +tracing, +replay, +feedback, each framework) and fail a PR on more than N bytes gzip growth vs `main`. Measure with tree-shaking flags too. This is the only performance gate Sentry enforces, and it is cheap. Sentry's numbers are a reference point for ouo's Appendix M benchmark: 30 / 53 / 93 kB.
- **Build-time flags to compile out heavy paths:** debug logging, iframe and shadow-DOM recording, the inlined worker and tracing. They save about 11 kB on the replay preset.
- **Replay worker with a graceful fallback:** start recording into memory at once, switch to the worker when it is ready, and offer a `workerUrl` for strict CSP. Prefer a static worker file or `CompressionStream` over a Blob URL, so `worker-src blob:` is not needed.
- **Replay guards:**
  - a mutation-batch limit that breadcrumbs at 750 and stops at 10k;
  - a 300 events / 5 s throttle on custom events;
  - a 20 MB segment cap;
  - a minimum duration of 5 s;
  - iOS mousemove sampling off;
  - mask text and inputs and block media by default.
  These are limits from real incidents. ouo should adopt them as named constants with the same meaning.
- **Frustration signals in the recording:** slow click (a mutation or scroll expected within 3 s, timeout 7 s, interactive elements only, ignore `download` and `target=_blank`) and multi-click counts. ouo can emit them as OTel span events or log records and classify rage and dead clicks in rum-api, as Sentry does on its server.
- **Deferring non-critical sends:** send the first session ping on idle or page hide, and keep keepalive within the budget (≤ 60 kB in flight, < 15 requests).
- **Linking:** put the replay id on every error, span and log, and the trace ids on the replay. Sentry's `error_ids`/`trace_ids` lists per segment give the player cheap indexes. In ouo these are OTel attributes (`session.id`, `ouo.replay.id`) on all signals.
- **Web-vitals usage:**
  - `durationThreshold: 0`;
  - its own INP target capture, which is cheaper than the attribution build;
  - per-soft-navigation and per-bfcache vitals;
  - pageload `startTime = timeOrigin`;
  - LoAF preferred over long tasks, with first-script attribution;
  - the 1.5 s redirect heuristic for SPA navigations;
  - the idle-span rules (1 s / 30 s / 15 s) for when a route span ends.
- **Debug-id source maps** (`//# debugId=` plus a runtime map) instead of release+filename matching. It is a TC39-track format, and ouo's collector-side symbolication can read the same ids.
- **`Server-Timing` and `<meta>` trace continuation** for the pageload. For ouo: read `traceparent` from `Server-Timing`.

**Do not copy, or do differently:**

- **A Sentry-only wire format.** Envelopes, `sentry-trace`/`baggage` DSC and `traceparent` off by default. ouo stays OTLP, W3C `traceparent` first, collector as the edge.
- **No transport compression for non-replay data.** ouo already gzips. Keep it.
- **Per-tab replay sessions** (`sessionStorage`) and **no persisted release-health session.** ouo's cross-tab localStorage session (30 min idle / 4 h max) is a different, deliberate choice. Keep one session id across tabs, and record the tab as an attribute.
- **Buffer-mode semantics:** "last 60 s" really means 0–60 s. If ouo builds on-error replay, keep two checkouts (previous plus current), so there are always ≥ 60 s before the error.
- **LoAF and long tasks only under an active span:** this loses jank outside page loads and interactions. ouo should export them as standalone events tied to the session.
- **Rely on users to allow-list URLs for network bodies:** fine as a default. But Sentry v11's permissive `dataCollection` default (bodies, cookies and user info on) is the opposite of what an OSS RUM should ship. Keep privacy-restrictive defaults.
- **Feedback screenshots via `getDisplayMedia`:** this needs a share prompt and is desktop only. If ouo adds feedback, attach the replay instead. The replay already shows the screen.
- **Profiling:** the JS Self-Profiling API needs a `Document-Policy` header and works in Chromium only. Low priority. If done, size the buffer to the chunk length (Sentry's 30 s buffer vs 60 s chunks).
- **Overhead claims without a harness in CI.** Sentry's published table dates from 2023 and its harness was deleted. ouo's benchmark (Appendix M) should live in the repo and run on PRs that touch `sdk/browser`.
