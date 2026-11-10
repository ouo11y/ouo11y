# Sentry, web (browser JavaScript)

- Vendor: Sentry
- Platform: web (`@sentry/browser` 11.x plus framework packages)
- SDK version checked: **11.11.0** (released 2026-11-05). 11.0.0 shipped 2026-09-23. A 10.x line is still maintained (10.78.0, 2026-10-28).
- Research date: 2026-11-10
- Code links point to tag `11.11.0`. `B` = `https://github.com/getsentry/sentry-javascript/blob/11.11.0`. `MIG` = `B/MIGRATION.md` (v10 to v11 section). `D` = `https://docs.sentry.io/platforms/javascript`.
- Docs pages showed no last-updated date, so docs rows use "accessed 2026-11-10".
- Default integrations (code, `B/packages/browser/src/sdk.ts`): eventFilters, functionToString, conversationId, browserApiErrors, breadcrumbs, console, globalHandlers, linkedErrors, dedupe, httpContext, cultureContext, browserSession. Tracing, replay, feedback, profiling, and httpClient are **opt-in** integrations.

## SES sessions

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| SES-a | yes | `browserSessionIntegration` (default integration). Release-health sessions. | on. Lifecycle `'page'`: one session per page load. | Duration is discarded (`ignoreDuration`). The initial send waits until idle or hidden. | B/packages/browser/src/integrations/browsersession.ts | 11.11.0, 2026-11-05 |
| SES-b | partial | Release-health sessions have no inactivity timeout. Replay session uses constants. | Replay: pauses after 5 min idle, expires after 15 min idle, max 60 min. | Docs only mention the 5-min idle end and 60-min max. | B/packages/replay-internal/src/constants.ts; D/session-replay/ | 11.11.0 / accessed 2026-11-10 |
| SES-c | partial | Replay session kept in `sessionStorage` (`sentryReplaySession`, `stickySession: true`). | Lasts across reloads in the same tab. Not shared across tabs. | Release-health session is per page load, not persisted. | B/packages/replay-internal/src/session/saveSession.ts | 11.11.0, 2026-11-05 |
| SES-d | yes | `startSession`, `endSession`, `captureSession`. Replay: `replay.start/stop/flush/getReplayId`. | n/a | `lifecycle:'route'` brings back a new session per navigation (v10 behaviour). | B/packages/browser/src/exports.ts; MIG | 11.11.0, 2026-11-05 |

## ERR errors and crashes

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| ERR-a | yes | `globalHandlersIntegration({onerror})` | on | Cross-origin "Script error." is dropped by default ignoreErrors. | B/packages/browser/src/integrations/globalhandlers.ts | 11.11.0, 2026-11-05 |
| ERR-b | yes | `globalHandlersIntegration({onunhandledrejection})` | on | none noted | same | 11.11.0, 2026-11-05 |
| ERR-c | yes | `captureException`, `captureMessage`, `captureEvent` | `attachStacktrace: true` (new in v11: adds a synthetic stack to messages) | v11: `captureMessage` now marks the session as errored. | MIG; B/packages/core/src/types/options.ts | 11.0.0, 2026-09-23 |
| ERR-d | n/a | Native crashes do not apply to the web. | | | | |
| ERR-e | n/a | ANR and app hang do not apply. Long tasks are covered under PERF-c. | | | | |
| ERR-f | n/a | | | | | |
| ERR-g | yes | `breadcrumbsIntegration({dom,fetch,history,sentry,xhr})` and `consoleIntegration({levels})`. `maxBreadcrumbs`, `beforeBreadcrumb`. | All on. Max 100. | v11 moved console crumbs from `breadcrumbs` to `consoleIntegration`. | B/packages/browser/src/integrations/breadcrumbs.ts; options.ts | 11.11.0, 2026-11-05 |
| ERR-h | yes | `scope.setFingerprint()` or `event.fingerprint` in `beforeSend` | server grouping | v11 stack-on-message change can create new groups. | MIG; D/usage/sdk-fingerprinting/ | accessed 2026-11-10 |
| ERR-i | partial | `scope.addAttachment()`. `viewHierarchyIntegration` (DOM tree JSON, opt-in). | none attached | No automatic screenshot on errors. Feedback has its own screenshots. | B/packages/browser/src/integrations/view-hierarchy.ts | 11.11.0, 2026-11-05 |
| ERR-j | yes | `captureConsoleIntegration({levels, handled})` (opt-in) | all console levels; `handled: true` | Counts against error quota and release health. | B/packages/core/src/integrations/captureconsole.ts | 11.11.0, 2026-11-05 |
| ERR-k | partial | `dedupeIntegration` (drops consecutive duplicates). eventFilters `ignoreErrors`/`denyUrls`. `sampleRate`. | dedupe on. 12 built-in ignore regexes (Script error, ResizeObserver, ...). | No client-side per-error rate limiter. Server rate limits are honoured (TRN-f). | B/packages/core/src/integrations/eventFilters.ts | 11.11.0, 2026-11-05 |
| ERR-x1 | yes | `browserApiErrorsIntegration` wraps timers, rAF, XHR, and EventTarget to catch errors with stacks. | on | Patches global APIs. | B/packages/browser/src/integrations/browserapierrors.ts | 11.11.0, 2026-11-05 |
| ERR-x2 | yes | `linkedErrorsIntegration({key,limit})` (error `cause` chains) | key `cause`, limit 5 | none | B/packages/browser/src/integrations/linkederrors.ts | 11.11.0, 2026-11-05 |
| ERR-x3 | yes | `enhanceFetchErrorMessages` appends the hostname to "Failed to fetch". | `'always'` (changes the real message) | Can break libraries that match exact message text. Use `'report-only'`. | B/packages/core/src/types/options.ts | 11.11.0, 2026-11-05 |
| ERR-x4 | yes | Opt-in: `reportingObserverIntegration`, `contextLinesIntegration`, `extraErrorDataIntegration`, `thirdPartyErrorFilterIntegration`, `zodErrorsIntegration` | off | thirdPartyErrorFilter needs the bundler plugin to inject module metadata. | B/packages/browser/src/index.ts | 11.11.0, 2026-11-05 |

## PERF performance and vitals

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| PERF-a | yes | `webVitalsIntegration` (auto-added by `browserTracingIntegration`). Uses the `web-vitals` ^6.2.3 library. LCP, CLS, INP, FCP, TTFB. | on when tracing is on. `webVitals.ignore: []`. | v11: vitals reported per soft navigation (Chromium 151+). Page-load CLS and INP drop. | B/packages/browser/src/integrations/webVitals.ts; MIG | 11.0.0, 2026-09-23 |
| PERF-b | yes | Span attributes `browser.web_vital.inp.target`, `browser.web_vital.lcp.element`, `cls.source.1`, `ui.component_name` | on | Component names need the build-time annotation plugin. | MIG (span name changes) | 11.0.0, 2026-09-23 |
| PERF-c | yes | `enableLongTask`, `enableLongAnimationFrame` | **both true** in code (JSDoc wrongly says LoAF defaults to false) | Span name "Main UI thread blocked". | B/packages/browser/src/tracing/browserTracingIntegration.ts | 11.11.0, 2026-11-05 |
| PERF-d | yes | Pageload span (`instrumentPageLoad`) with navigation-timing child spans (DNS, Connect, TLS, Request, ...) | on | v11 uses static span names. The URL moves to `url.full`. | MIG; browserTracingIntegration.ts | 11.0.0, 2026-09-23 |
| PERF-e | yes | Resource spans. `ignoreResourceSpans`. `enableHTTPTimings` for fetch/XHR. | on, ignore `[]` | v11: resource span names hold only the domain. | MIG; browserTracingIntegration.ts | 11.0.0, 2026-09-23 |
| PERF-f | n/a | | | | | |
| PERF-g | n/a | | | | | |
| PERF-h | n/a | Nearest web equivalent is PERF-x1. | | | | |
| PERF-i | yes | `browserProfilingIntegration`, `profileSessionSampleRate`, `profileLifecycle` (`manual` or `trace`) | rate 0, `manual` | JS Self-Profiling API, Chromium only. Needs `Document-Policy: js-profiling`. Samples at 100 Hz. Beta. | B/packages/browser/src/client.ts; D/profiling/ | accessed 2026-11-10 |
| PERF-j | no | No CPU, memory, battery, or thermal integration among the browser exports. | n/a | | B/packages/browser/src/index.ts | 11.11.0, 2026-11-05 |
| PERF-k | yes | `startSpan`, `startInactiveSpan`, `startSpanManual`, `ignoreSpans`, `beforeSendSpan` | `traceLifecycle: 'stream'` | Streamed spans carry attributes, not tags. `beforeSendSpan` cannot drop spans. | MIG; options.ts | 11.0.0, 2026-09-23 |
| PERF-x1 | yes | `enableReportPageLoaded` plus `Sentry.reportPageLoaded()` ends the pageload span yourself (similar to TTFD). | false | none noted | browserTracingIntegration.ts | 11.11.0, 2026-11-05 |
| PERF-x2 | yes | Idle-span timing: `idleTimeout` / `finalTimeout` / `childSpanTimeout` | 1000 / 30000 / 15000 ms | Background tabs end spans as "cancelled" (`markBackgroundSpan: true`). | B/packages/core/src/tracing/idleSpan.ts | 11.11.0, 2026-11-05 |
| PERF-x3 | yes | Opt-in: `userTimingIntegration` (marks/measures), `elementTimingIntegration`, `fetchStreamPerformanceIntegration`, `bfcacheMetricsIntegration` | off | v11 moved user timing out of browserTracing. | MIG; index.ts | 11.0.0, 2026-09-23 |
| PERF-x4 | yes | bfcache restores get their own navigation span and vitals (`instrumentBfcacheRestore`, `webVitals.bfcacheNavigations`) | true | Tagged `browser.navigation.type`. Keep these out of page-load aggregates. | MIG; webVitals.ts | 11.0.0, 2026-09-23 |

## NET network

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| NET-a | yes | `traceFetch`, `traceXHR` in `browserTracingIntegration`. Breadcrumbs for fetch and XHR. | true (needs tracing integration). Breadcrumbs on by default. | `shouldCreateSpanForRequest` filter. | B/packages/browser/src/tracing/request.ts | 11.11.0, 2026-11-05 |
| NET-b | yes | `sentry-trace` + `baggage`. `propagateTraceparent` adds W3C `traceparent`. `tracePropagationTargets`. | Same origin only. traceparent false. | v11 matching is case-insensitive; `g`/`y` regex flags ignored. | request.ts; options.ts; MIG | 11.11.0, 2026-11-05 |
| NET-c | partial | Replay: `networkDetailAllowUrls`, `networkCaptureBodies`, `networkRequestHeaders`, `networkResponseHeaders` | allowlist `[]` means no headers or bodies. Bodies on once a URL is allowlisted. | Body capped at 150 kB. Spans: no browser body capture found. | B/packages/replay-internal/src/integration.ts, constants.ts | 11.11.0, 2026-11-05 |
| NET-d | yes | `graphqlClientIntegration` (opt-in) | off | `dataCollection.graphQL` document and variables default true. | index.ts; resolveDataCollectionOptions.ts | 11.11.0, 2026-11-05 |
| NET-e | yes | `httpClientIntegration({failedRequestStatusCodes, failedRequestTargets})` (opt-in) | `[[500,599]]`, targets `/.*/` | Off unless added. | B/packages/browser/src/integrations/httpclient.ts | 11.11.0, 2026-11-05 |
| NET-f | no | No WebSocket or SSE integration among the browser exports. | n/a | | index.ts | 11.11.0, 2026-11-05 |

## INT interactions

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| INT-a | yes | `ui.click` breadcrumbs (`breadcrumbs.dom`). `interactionsIntegration` makes `ui.action.click` idle spans. Replay records clicks. | Breadcrumbs on. Interaction spans off. | interactionsIntegration is marked experimental and "might lead to noisy spans". | B/packages/browser-utils/src/performance/interactions.ts | 11.11.0, 2026-11-05 |
| INT-b | yes | CSS-like selector path. `data-sentry-component` / `data-sentry-element` from the bundler annotation plugin. | Up to 5 ancestors, 80 chars | No text or aria naming found in the selector code. | B/packages/browser-utils/src/htmlTreeAsString.ts, component-name.ts | 11.11.0, 2026-11-05 |
| INT-c | yes (replay) | Replay click detector, multi-click frames, shown as Replay rage clicks | needs replay | Exact click-count threshold not confirmed in the code read. | B/packages/replay-internal/src/coreHandlers/handleClick.ts | 11.11.0, 2026-11-05 |
| INT-d | yes (replay) | Slow-click detection: `slowClickTimeout`, `slowClickIgnoreSelectors` | timeout 7000 ms, threshold 3000 ms | Needs replay. Ignores scroll within 300 ms. | integration.ts; constants.ts | 11.11.0, 2026-11-05 |
| INT-e | uncertain | No "error click" detector found in the SDK. Replay links errors to the timeline. | | | handleClick.ts | 11.11.0, 2026-11-05 |
| INT-f | partial | Scroll recorded only inside the replay (rrweb). No scroll events otherwise. | | | D/session-replay/ | accessed 2026-11-10 |
| INT-g | partial | `ui.input` breadcrumbs from `breadcrumbs.dom`. Replay records inputs, masked. | on | No form-submit autocapture events. | breadcrumbs.ts | 11.11.0, 2026-11-05 |
| INT-h | no | No heatmap feature found in the SDK or docs. | | | | accessed 2026-11-10 |

## NAV navigation

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| NAV-a | yes | `instrumentPageLoad` creates a pageload span. | true | Needs tracing. | browserTracingIntegration.ts | 11.11.0, 2026-11-05 |
| NAV-b | yes | `instrumentNavigation` (History API). Framework routers: React Router, Vue, Angular, TanStack, and others. | true | Low-cardinality names need a router integration or `routeProvider`. | browserTracingIntegration.ts; MIG | 11.11.0, 2026-11-05 |
| NAV-c | n/a | | | | | |
| NAV-d | n/a | | | | | |
| NAV-e | yes | `startBrowserTracingPageLoadSpan`, `startBrowserTracingNavigationSpan`, `beforeStartSpan`, `routeProvider` / `setRouteProvider` (added 11.3) | n/a | none noted | B/packages/browser/src/client.ts; CHANGELOG 11.3.0 | 11.11.0, 2026-11-05 |
| NAV-f | partial | Reacts to `visibilitychange`: flushes buffers and marks background spans. pagehide/pageshow/freeze are used for clock-drift checks. | on | No foreground/background events are emitted to users. | B/packages/browser/src/client.ts | 11.11.0, 2026-11-05 |
| NAV-x1 | yes | `linkPreviousTrace` links a new trace to the previous one. `consistentTraceSampling`. | `'in-memory'`, false | `'session-storage'` keeps the link across reloads (max age 1 h). | B/packages/browser/src/tracing/linkedTraces.ts | 11.11.0, 2026-11-05 |
| NAV-x2 | yes | `detectRedirects` treats a fast navigation as a redirect, not a new navigation. | true | none noted | browserTracingIntegration.ts | 11.11.0, 2026-11-05 |

## RPL replay

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| RPL-a | yes | `replayIntegration()` using `@sentry/rrweb` 2.45.0 (Sentry's fork of rrweb) | off | Lazy-loadable. | B/packages/replay-internal/package.json | 11.11.0, 2026-11-05 |
| RPL-b | n/a | | | | | |
| RPL-c | yes | `replaysSessionSampleRate`, `replaysOnErrorSampleRate` | undefined in code. Docs examples use 0.1 / 1.0. | On-error mode keeps a 60 s in-memory buffer. | constants.ts; D/session-replay/ | accessed 2026-11-10 |
| RPL-d | partial | Canvas via `replayCanvasIntegration` (opt-in). Same-origin `srcdoc` iframes blocked by default. | canvas off | Canvas content is not scrubbed. WebGL needs `preserveDrawingBuffer` or manual `snapshot()`. Shadow DOM not covered in the docs read. | D/session-replay/troubleshooting/ | accessed 2026-11-10 |
| RPL-e | yes | Network requests appear in the timeline. Details via allowlist (NET-c). | URL, timing, size only | Bodies capped at 150k chars. | constants.ts; troubleshooting | 11.11.0 |
| RPL-f | yes | Console entries appear in the replay. | on | Each argument truncated at 5000 chars. | constants.ts | 11.11.0, 2026-11-05 |
| RPL-g | yes | `maskAllText`, `maskAllInputs`, `blockAllMedia`, `mask`, `unmask`, `block`, `unblock`, `ignore`, `maskFn`, `maskAttributes` | all three true. Masks the title, placeholder, and aria-label attributes. | none noted | integration.ts | 11.11.0, 2026-11-05 |
| RPL-h | n/a | | | | | |
| RPL-i | n/a | | | | | |
| RPL-j | yes | `maxReplayDuration`, `minReplayDuration`, `flushMinDelay` / `flushMaxDelay`, `mutationLimit`, `mutationBreadcrumbLimit` | 60 min, 5 s, 5–5.5 s, 10000, 750 | Stops above about 20 MB of uncompressed events. `minReplayDuration` max is 50 s. | constants.ts; integration.ts | 11.11.0, 2026-11-05 |

## USR user and attributes

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| USR-a | yes | `setUser({id, email, username, ip_address})` | none | The session `did` updates when the user changes. | browsersession.ts | 11.11.0, 2026-11-05 |
| USR-b | yes | Extra keys on the user object. `setContext`. | none | none noted | exports.ts | 11.11.0, 2026-11-05 |
| USR-c | yes | `setTag(s)`, `setContext`, `setExtra`, and `setAttribute(s)` (attributes go to spans, logs, and metrics) | none | v11: tags and extra **no longer reach spans**. | MIG | 11.0.0, 2026-09-23 |
| USR-d | uncertain | No anonymous or device id generator found in the browser SDK code. IP inferred server-side when `userInfo` is on. | `infer_ip: 'auto'` | | client.ts | 11.11.0, 2026-11-05 |
| USR-e | no | No identify or alias API found. | | | exports.ts | 11.11.0, 2026-11-05 |
| USR-x1 | yes | `setConversationId` (`conversationIdIntegration`, default) for AI conversation correlation | on | none noted | sdk.ts | 11.11.0, 2026-11-05 |

## LOG logs

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| LOG-a | yes | `Sentry.logger.trace…fatal`, `logger.fmt`, `beforeSendLog` | On by usage (v11 removed `enableLogs`). | Buffer of 100 logs. Flushed every 5 s and on page hide. Needs a logs CDN bundle. | MIG; B/packages/core/src/logs/internal.ts | 11.0.0, 2026-09-23 |
| LOG-b | yes | `consoleLoggingIntegration({levels})` | off | Extra arguments become attributes. | D/logs/ | accessed 2026-11-10 |
| LOG-c | no | Sentry log envelope (OTel-like severity numbers 1–21). Browser has no OTLP log export. | n/a | v11 `openTelemetryIntegration` is server-only. | B/packages/core/src/logs/constants.ts; MIG | 11.0.0, 2026-09-23 |

## SMP sampling

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| SMP-a | partial | Replay session rate only. Release-health sessions are not sampled. | n/a | none noted | D/session-replay/; D/product/releases/health/ | accessed 2026-11-10 |
| SMP-b | yes | `tracesSampleRate`, `tracesSampler`, `profileSessionSampleRate` | undefined (tracing off) | none noted | options.ts | 11.11.0, 2026-11-05 |
| SMP-c | yes | `sampleRate` | 1.0 | none noted | options.ts | 11.11.0, 2026-11-05 |
| SMP-d | yes | `replaysOnErrorSampleRate` | see RPL-c | 60 s buffer. `beforeErrorSampling` hook. | constants.ts; integration.ts | 11.11.0, 2026-11-05 |
| SMP-e | yes | Errors are sampled independently of traces and replay. | errors 100% | none noted | options.ts | 11.11.0, 2026-11-05 |
| SMP-f | partial | No remote config in the npm SDK. The Loader Script takes settings from project config. Server-side dynamic sampling. | n/a | | D/install/loader/ | accessed 2026-11-10 |

## PRV privacy

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| PRV-a | no | No consent API. Use delayed `init`, `enabled: false`, or `close()`. | n/a | | exports.ts | 11.11.0, 2026-11-05 |
| PRV-b | partial | `dataCollection` (v11) for non-replay data. Replay masks by default. | **Permissive**: userInfo, cookies, headers, bodies, query params all true. | Server-side scrubbing still applies. | B/packages/core/src/utils/data-collection/resolveDataCollectionOptions.ts | 11.11.0, 2026-11-05 |
| PRV-c | yes (replay) | Replay `mask`, `unmask`, `block`, `unblock`, `ignore` selectors | text masked | Only in replay. | integration.ts | 11.11.0, 2026-11-05 |
| PRV-d | partial | `dataCollection.urlQueryParams` (true, false, or allow/deny lists) | true (kept) | none noted | resolveDataCollectionOptions.ts | 11.11.0, 2026-11-05 |
| PRV-e | yes | `dataCollection.userInfo` replaces `sendDefaultPii` | **true**, so IP is inferred | v11 flipped the default to collect. Set `false` to restore v10 behaviour. | MIG; client.ts | 11.0.0, 2026-09-23 |
| PRV-f | yes | `beforeSend`, `beforeSendSpan`, `beforeBreadcrumb`, `beforeSendLog`, `beforeSendMetric`, replay `beforeAddRecordingEvent` | none | `beforeSendSpan` cannot drop spans. `beforeSendTransaction` is a no-op in v11. | options.ts; MIG | 11.0.0, 2026-09-23 |
| PRV-g | no | No Do Not Track or GPC check found in the browser SDK. | n/a | | | 11.11.0 |

## TRN offline and transport

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| TRN-a | yes | Errors sent right away. Spans buffered per trace. Logs and metrics buffered. Transport `bufferSize`. | Spans: 1000 / 5 s / 5 MB. Logs: 100 / 5 s. Metrics: 1000. Transport: 64 in flight. | Replay segments every 5–5.5 s. | B/packages/core/src/tracing/spans/spanBuffer.ts; transports/base.ts | 11.11.0, 2026-11-05 |
| TRN-b | yes | `makeBrowserOfflineTransport(makeFetchTransport)` | off. IndexedDB `sentry-offline`, max queue 30. | Retry starts at 5 s, backs off to 1 h. No TTL found. | B/packages/browser/src/transports/offline.ts; core/src/transports/offline.ts | 11.11.0, 2026-11-05 |
| TRN-c | yes | fetch `keepalive`. `flush()` on visibilitychange→hidden. | keepalive while <60 KB pending and <15 requests | No `sendBeacon`. | B/packages/browser/src/transports/fetch.ts; client.ts | 11.11.0, 2026-11-05 |
| TRN-d | partial | Replay `useCompression` (deflate in a web worker; `workerUrl` option) | true | No compression found for other envelopes. | integration.ts | 11.11.0, 2026-11-05 |
| TRN-e | yes | `tunnel: '<url>'`, or `tunnel: true` / `{path, basePath}` for a managed tunnel derived from the DSN | undefined | Managed tunnel added in 11.10.0. Tunnel request body size limited (11.9). | B/packages/browser/src/utils/managedTunnel.ts; CHANGELOG | 11.10.0, 2026-10-28 |
| TRN-f | yes | Honours `X-Sentry-Rate-Limits` and `Retry-After` | 60 s fallback | Handles 413. | B/packages/core/src/utils/ratelimit.ts | 11.11.0, 2026-11-05 |
| TRN-g | yes | Sentry envelope format (span v2 envelopes for streamed spans). Not OTLP from the browser. | n/a | `getOtlpTracesEndpoint` is server-only. | MIG; spans/envelope.ts | 11.0.0, 2026-09-23 |
| TRN-x1 | yes | Span streaming: `traceLifecycle: 'stream'` or `'static'` | `'stream'` (new in v11) | Removes the 1000-span transaction cap. `ignoreTransactions` is a no-op. | MIG | 11.0.0, 2026-09-23 |

## CFG configuration

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| CFG-a | yes | `Sentry.init({dsn, ...})`, single options object | none | none noted | sdk.ts | 11.11.0, 2026-11-05 |
| CFG-b | yes | `integrations` (array or function), `defaultIntegrations: false`, `addIntegration()` | 12 defaults | none noted | sdk.ts | 11.11.0, 2026-11-05 |
| CFG-c | yes | `debug`, `sendClientReports` (dropped-data outcomes), `diagnoseSdkConnectivity()`, `spotlight` | debug false. Client reports true, flushed every 60 s and on hide. | Debug logs only in debug builds. | client.ts; options.ts | 11.11.0, 2026-11-05 |
| CFG-d | yes | `release`, `environment`, `dist` | release from `__SENTRY_RELEASE__` or `window.SENTRY_RELEASE`. env `production`. | none noted | client.ts; options.ts | 11.11.0, 2026-11-05 |
| CFG-e | yes | npm, CDN bundles (per-feature), Loader Script, `lazyLoadIntegration`, `feedbackAsyncIntegration` | n/a | Before the Loader finishes loading: only errors are buffered, no breadcrumbs. | D/install/loader/ | accessed 2026-11-10 |
| CFG-f | yes | Browser-extension check (`skipBrowserExtensionCheck`), `webWorkerIntegration`, `moduleMetadataIntegration` for micro-frontends, SSR via meta-framework SDKs | The SDK disables itself inside extensions. | Shared-environment setups need a manual client. | client.ts; sdk.ts | 11.11.0, 2026-11-05 |
| CFG-x1 | yes | `isBotUserAgent()` export (Googlebot, Bingbot, ...) to avoid idle timers and observers for crawlers | used in tracing code | Fixed regex. | B/packages/browser-utils/src/isBotUserAgent.ts | 11.11.0, 2026-11-05 |

## API manual instrumentation

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| API-a | partial | `captureMessage`, `captureEvent`. No product-analytics event API. | n/a | Messages count toward errors and session health. | MIG | 11.0.0 |
| API-b | yes | `Sentry.metrics.count`, `gauge`, `distribution` with attributes and units. `beforeSendMetric`. | On by usage (v11 removed `enableMetrics`). | 2 KB per metric. Needs a metrics CDN bundle. | D/metrics/; MIG | accessed 2026-11-10 |
| API-c | yes | `startSpan`, `startInactiveSpan`, `startSpanManual`, `withActiveSpan` | n/a | none noted | exports.ts | 11.11.0, 2026-11-05 |
| API-d | yes | `span.setAttribute(s)`, `getActiveSpan()`, scope `setAttribute(s)` | n/a | none noted | MIG | 11.0.0 |
| API-e | partial | Browser: W3C `traceparent` opt-in only. v11 OTel interop (`enableOpenTelemetrySetup`, `openTelemetryIntegration`) is server-only. | traceparent off | No OTel API ingestion in the browser was found. | MIG; options.ts | 11.0.0, 2026-09-23 |

## SYM source maps and symbolication

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| SYM-a | yes | Debug IDs injected at build time, then uploaded | Debug IDs are the default linking method | Upload must happen before errors arrive. | D/sourcemaps/ | accessed 2026-11-10 |
| SYM-b | n/a | | | | | |
| SYM-c | n/a | | | | | |
| SYM-d | n/a | | | | | |
| SYM-e | yes | `sentry-cli`, `@sentry/wizard`, Vite/webpack/Rollup/esbuild plugins (also add component annotation and module metadata) | n/a | v11 dropped webpack 5.0.x. | D/sourcemaps/; MIG | accessed 2026-11-10 |

## FWK framework integrations

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| FWK-a | yes | `@sentry/react`: ErrorBoundary, Profiler, `reactRouterBrowserTracingIntegration` (new `@sentry/react/react-router` entry) | n/a | React 17+ (v11 dropped 16). | MIG | 11.0.0, 2026-09-23 |
| FWK-b | yes | `@sentry/nextjs`, nuxt, sveltekit, remix, react-router, astro, solidstart, tanstack | n/a | Next 14+. Next and SvelteKit still register an OTel tracer provider. | MIG | 11.0.0, 2026-09-23 |
| FWK-c | yes | `@sentry/vue`, `angular`, `svelte`, `ember` (now a v2 addon), `solid` | n/a | none noted | MIG | 11.0.0, 2026-09-23 |
| FWK-d | n/a | | | | | |
| FWK-e | n/a | | | | | |
| FWK-f | n/a | Separate SDK. | | | | |
| FWK-g | n/a | | | | | |

## REL release and versioning

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| REL-a | yes | `release` option or bundler-injected release | auto when the plugin is used | none noted | client.ts | 11.11.0 |
| REL-b | yes | Crash-free sessions and users from browserSession | on | v11 browser uncaught errors count as `unhandled`, not `crashed`, so rates shift. | MIG; D/product/releases/health/ | 11.0.0, 2026-09-23 |
| REL-c | yes (product) | Commits, suspect commits, and deploys via CLI or VCS integration | n/a | Not done in the SDK. | D/product/releases/health/ | accessed 2026-11-10 |
| REL-d | yes (product) | Adoption: share of sessions in the last 24 h | n/a | Stage labels only for mobile projects. | D/product/releases/health/ | accessed 2026-11-10 |

## FF feature flags

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| FF-a | yes | `featureFlagsIntegration` (manual) or a provider integration. Flags attached to errors and spans. | off | 100 flags per error buffer, 10 per span. | B/packages/core/src/utils/featureFlags.ts | 11.11.0, 2026-11-05 |
| FF-b | no | No Sentry flag service. Change tracking uses provider webhooks. | | | D/feature-flags/ | accessed 2026-11-10 |
| FF-c | yes | `openFeatureIntegration`, `launchDarklyIntegration`, `statsigIntegration`, `unleashIntegration`, `growthbookIntegration` | off | GrowthBook is in the code but not on the docs page read. | index.ts | 11.11.0, 2026-11-05 |

## FB user feedback

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| FB-a | yes | `feedbackIntegration` / `feedbackAsyncIntegration`. Crash dialog via `showReportDialog` (`onError` callback added 11.1). | off. Widget sits bottom right. | Needs Shadow DOM and `<dialog>`. Buffers 30 s of replay when opened. | D/user-feedback/ | accessed 2026-11-10 |
| FB-b | yes | `captureFeedback`, `sendFeedback` (v11 always rejects with an `Error`) | n/a | none noted | MIG; D/user-feedback/ | 11.0.0, 2026-09-23 |
| FB-c | partial | Widget screenshot: `enableScreenshot` | true | Hidden on mobile devices. Counts against the attachment quota. | D/user-feedback/ | accessed 2026-11-10 |

## OTH other

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| OTH-a | no | No pageview or funnel analytics. | | | | accessed 2026-11-10 |
| OTH-b | no | No experiments feature found. | | | | accessed 2026-11-10 |
| OTH-c | no | No surveys found. Feedback widget only. | | | | accessed 2026-11-10 |
| OTH-d | n/a | No hybrid bridge in the browser SDK. | | | | |
| OTH-e | uncertain | No SDK-side synthetic or uptime link found. Not researched in the product docs. | | | | |
| OTH-f | partial | `supabaseIntegration`, `graphqlClientIntegration`, flag providers, Spotlight. No Segment-style CDP integration. | off | none noted | index.ts | 11.11.0, 2026-11-05 |
| OTH-g | yes | `cultureContextIntegration` and `httpContextIntegration` (locale, timezone, URL, user agent) are on by default. | on | none noted | sdk.ts | 11.11.0, 2026-11-05 |

## Notable

1. **v11 (2026-09-23) flipped privacy defaults.** `sendDefaultPii` is gone. When `dataCollection` is unset, the SDK collects user info and IP, cookies, headers, bodies, and query params. A new SDK should decide its own defaults on purpose and not copy these.
2. **Span streaming is the default** (`traceLifecycle: 'stream'`). Spans are batched per trace (1000 spans, 5 s, or 5 MB). `beforeSendTransaction` and `ignoreTransactions` no longer do anything. Tags and extra no longer reach spans; only attributes do.
3. **Browser release-health sessions are page views with no duration.** v11 defaults to one per page load (`lifecycle: 'page'`), and uncaught browser errors count as `unhandled`, not `crashed`. Replay has its own separate session: per tab in `sessionStorage`, 5 min idle pause, 15 min expiry, 60 min max.
4. **Web vitals are reported per soft navigation by default** (Soft Navigations API, Chromium 151+), and bfcache restores get their own vitals. Page-load CLS and INP values drop when you upgrade. The SDK uses `web-vitals` ^6.2.3.
5. **Trace propagation is same-origin only by default.** It sends `sentry-trace` and `baggage`. The W3C `traceparent` header is opt-in (`propagateTraceparent: false`). Target matching became case-insensitive in v11.
6. **Many RUM features are opt-in integrations**: tracing, replay, interactions (marked experimental), httpClient (5xx as errors), offline transport, profiling, user timing. The default set is error-focused.
7. **There is no `sendBeacon`.** The fetch transport uses `keepalive` only while under 60 KB pending and 15 requests, and calls `flush()` on `visibilitychange: hidden`. The offline queue (IndexedDB, max 30) is opt-in.
8. **Managed tunnel** (11.10, 2026-10-28): `tunnel: true` builds a same-origin path from the DSN and sends `Content-Type: application/x-sentry-envelope` to get past CSRF guards.
9. **Code and JSDoc disagree on one default.** `enableLongAnimationFrame` is `true` in code, but its JSDoc says `false`. Read defaults from code.
10. **Replay limits:** `@sentry/rrweb` 2.45.0 fork, 60 s on-error buffer, network details only for allowlisted URLs, bodies capped at 150 kB, about 20 MB event cap, and `mutationLimit` 10000 stops very busy pages.
