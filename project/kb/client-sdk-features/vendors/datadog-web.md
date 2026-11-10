# Datadog — Web (Browser SDK) feature research

- **Vendor:** Datadog
- **Platform:** web (`@datadog/browser-rum`, `-rum-slim`, `-logs`, `-rum-react`, `-rum-nextjs`, `-rum-vue`, `-rum-nuxt`, `-rum-angular`, `-rum-shopify`, `-plugin-wasm`, `-worker`; `browser-debugger` is private in repo)
- **SDK version checked:** v7.17.0 (GitHub release 2026-11-05, latest on 2026-11-10)
- **Research date:** 2026-11-10
- **Shorthands:** `src:` = `https://github.com/DataDog/browser-sdk/blob/v7.17.0/packages/` ; `DD:` = `https://docs.datadoghq.com/` ; `CL` = `CHANGELOG.md` at tag v7.17.0. Source-code cells are dated "v7.17.0 / 2026-11-05". Datadog doc pages show no last-updated date, so they are dated "accessed 2026-11-10".
- **Common doc pages:** `DD:real_user_monitoring/browser/advanced_configuration/` (= ADV), `DD:real_user_monitoring/browser/setup/client/` (= SETUP), `DD:session_replay/browser/privacy_options/` (= PRIV).

## SES sessions

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| SES-a | yes | Automatic on `init`. The session is stored in the `_dd_s_v2` key. | on | A view with `loading_type: session_renewal` is created when the session renews (v7). | src:browser-core/src/domain/session/sessionManager.ts; CL v7.0.0 | v7.17.0 / 2026-11-05 |
| SES-b | yes | Not configurable | 15 min inactivity (`SESSION_EXPIRATION_DELAY`); 4 h max (`SESSION_TIME_OUT_DELAY`) | Expanded on user activity (throttled to 1 s). A visible tab is re-checked every 1 min (`VISIBILITY_CHECK_DELAY`). There is no separate background timeout. | src:browser-core/src/domain/session/sessionConstants.ts, sessionManager.ts | v7.17.0 / 2026-11-05 |
| SES-c | yes | `sessionPersistence` ('cookie' / 'local-storage' / 'memory', or an ordered array); `trackSessionAcrossSubdomains`; `usePartitionedCrossSiteSessionCookie`; `useSecureSessionCookie` | cookie (shared across same-site tabs); subdomains off | The `memory` option gives a new session on every page load. RUM and Logs must use identical values. Cookie lifetime is 1 year. | src:browser-core/src/domain/configuration/configuration.ts | v7.17.0 / 2026-11-05 |
| SES-d | partial | `stopSession()`, `getInternalContext()` (returns `session_id`). A new session starts on the next user activity. | — | There is no explicit start/restart API. `expandOrRenew` was exposed on the internal session manager in 7.16. | src:browser-rum-core/src/boot/rumPublicApi.ts; ADV | v7.17.0 / 2026-11-05 |

## ERR errors and crashes

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| ERR-a | yes | Instruments `window.onerror`, recorded as `error.source: source` | always on (no toggle) | Cross-origin "Script error." needs `crossorigin` plus CORS headers | src:browser-core/src/domain/error/trackRuntimeError.ts; DD:real_user_monitoring/browser/collecting_browser_errors/ | v7.17.0 / 2026-11-05 |
| ERR-b | yes | `onunhandledrejection` | always on | Not available in Salesforce LWS (code comment) | src:browser-core/src/domain/error/trackRuntimeError.ts | v7.17.0 / 2026-11-05 |
| ERR-c | yes | `addError(error, context?)`. A `dd_context` property on the Error object is merged into the event. `error.causes` follows the `cause` chain. | — | — | DD:…/collecting_browser_errors/; ADV | accessed 2026-11-10 |
| ERR-d | n/a | — | — | Web only | — | — |
| ERR-e | n/a | — | — | — | — | — |
| ERR-f | n/a | — | — | — | — | — |
| ERR-g | partial | No breadcrumb list. Instead, every RUM event (view, action, resource, long task) carries session and view ids, so the session timeline acts as the trail. | — | Not a per-error breadcrumb array | inferred from event model (DD:real_user_monitoring/browser/data_collected/) | accessed 2026-11-10 |
| ERR-h | yes | Event field `error.fingerprint` (set via `beforeSend` or on the error object) | unset | — | src:browser-rum-core/src/domain/error/errorCollection.ts (`fingerprint: error.fingerprint`) | v7.17.0 / 2026-11-05 |
| ERR-i | no | — | — | No screenshot or attachment API. Replay is the visual context. | not found in source or docs | accessed 2026-11-10 |
| ERR-j | yes | RUM turns `console.error` into an error with `source: console`. Logs SDK: `forwardConsoleLogs`. | RUM: on; Logs: `[]` | — | src:browser-rum-core/src/domain/error/errorCollection.ts | v7.17.0 / 2026-11-05 |
| ERR-k | partial | Rate limiter: 3000 errors per minute (also applies to actions and logs). Repeated clicks are merged. | on | No content-based dedup found | src:browser-core/src/domain/eventRateLimiter/createEventRateLimiter.ts | v7.17.0 / 2026-11-05 |
| ERR-x1 | yes | Reporting API: CSP violations and interventions become RUM errors (`source: report`). Logs SDK: `forwardReports`. | RUM: CSP + intervention on | — | src:browser-rum-core/src/domain/error/trackReportError.ts | v7.17.0 / 2026-11-05 |
| ERR-x2 | yes | WASM errors: `makeWasmPlugin()` (`@datadog/browser-plugin-wasm`), with build_ids on errors | off | Plugin version must match the SDK | DD:…/collecting_browser_errors/; CL 7.13.0 | accessed 2026-11-10 |

## PERF performance and vitals

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| PERF-a | yes | Automatic on view events: LCP, INP, CLS, FCP, TTFB (`first_byte`) | on | LCP/FCP only on the initial view; LCP capped at 10 min; FID removed in v7 | DD:real_user_monitoring/browser/monitoring_page_performance/; CL v7.0.0 | accessed 2026-11-10 |
| PERF-b | yes | Target selectors for LCP, INP and CLS, plus LCP subparts (6.32+) and INP subparts (6.33+) | on | — | DD:…/monitoring_page_performance/ | accessed 2026-11-10 |
| PERF-c | yes | `trackLongTasks`. Uses Long Animation Frame entries when supported, else `longtask`. | true | — | src:browser-rum-core/src/domain/longTask/longTaskCollection.ts; src:browser-rum-core/src/domain/configuration/configuration.ts | v7.17.0 / 2026-11-05 |
| PERF-d | yes | DOM timings plus `loading_time` (load or first 100 ms of no activity); `excludedActivityUrls`; `setViewLoadingTime()` | on | — | DD:…/monitoring_page_performance/ | accessed 2026-11-10 |
| PERF-e | yes | `trackResources` creates resource events; `trackResourceHeaders` (GA in 7.1) | true | — | src:browser-rum-core/src/domain/configuration/configuration.ts | v7.17.0 / 2026-11-05 |
| PERF-f | n/a | — | — | — | — | — |
| PERF-g | n/a | — | — | Web: no FPS metric found | — | — |
| PERF-h | n/a | — | — | — | — | — |
| PERF-i | yes | `profilingSampleRate` (JS Self-Profiling API; lazy-loaded chunk). Samples every 10 ms, collects every 60 s, minimum 5 s of profile. Server-side quota check. | 0 | Chromium only (needs `Profiler`); needs the `Document-Policy: js-profiling` response header | src:browser-rum/src/domain/profiling/datadogProfiler.ts, profilingSupported.ts; DD:real_user_monitoring/correlate_with_other_telemetry/profiling | v7.17.0 / 2026-11-05 |
| PERF-j | n/a | — | — | — | — | — |
| PERF-k | yes | `addTiming(name)`; `start/stopDurationVital`, `addDurationVital`; `startOperation`/`succeedOperation`/`failOperation` (operation vitals, public since 7.3) | — | Vital names limited to letters, digits and `-_.@$` | src:browser-rum-core/src/boot/rumPublicApi.ts; DD:…/monitoring_page_performance/ | v7.17.0 / 2026-11-05 |

## NET network

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| NET-a | yes | fetch/XHR instrumented as resources (`trackResources`); manual `startResource`/`stopResource` | on | Early requests are always collected (v7) | src:browser-rum-core/src/boot/rumPublicApi.ts; CL v7.0.0 | v7.17.0 / 2026-11-05 |
| NET-b | yes | `allowedTracingUrls` (string, RegExp, function, or `{match, propagatorTypes}`); `traceSampleRate`; `traceContextInjection`; `propagateTraceBaggage` (user and account ids in `baggage`) | propagators `['tracecontext','datadog']`; traceSampleRate 100; injection `sampled`; baggage true; allowlist empty | Requires `service`. b3 and b3multi are opt-in. CORS must allow the headers. | src:browser-rum-core/src/domain/configuration/configuration.ts; DD:real_user_monitoring/correlate_with_other_telemetry/apm/ | v7.17.0 / 2026-11-05 |
| NET-c | partial | Headers: `trackResourceHeaders` (true = 12 default cache/content headers; or `MatchHeader[]` with url/name/extractor/location). Bodies: only GraphQL payloads (NET-d). | off | Sensitive header names are always dropped (token, cookie, authorization, api-key, …) | src:browser-rum-core/src/domain/configuration/configuration.ts | v7.17.0 / 2026-11-05 |
| NET-d | yes | `allowedGraphQlUrls` (match, `trackPayload`, `trackResponseErrors`). Extracts operationType, operationName and variables. | off; payload off | Payload limit 32 KiB | src:browser-rum-core/src/domain/resource/graphql.ts | v7.17.0 / 2026-11-05 |
| NET-e | partial | RUM: no; failures are resources with a status code. Logs SDK `forwardErrorsToLogs` logs status 0 (non-opaque) and 5xx. | Logs: true | Aborted requests are excluded (v7) | src:browser-logs/src/domain/networkError/networkErrorCollection.ts | v7.17.0 / 2026-11-05 |
| NET-f | partial (beta) | `betaTrackWebSockets` emits a vital per phase (connecting, open, closing, closed) plus periodic open | false | `beforeSend` can only edit url, protocols and close_reason; these events cannot be dropped | src:browser-rum-core/src/domain/configuration/configuration.ts | v7.17.0 / 2026-11-05 |

## INT interactions

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| INT-a | yes | `trackUserInteractions` (clicks only); `allowUntrustedEvents` | true | Shadow DOM tracked by default (v7) | src:browser-rum-core/src/domain/configuration/configuration.ts; CL v7.0.0 | v7.17.0 / 2026-11-05 |
| INT-b | yes | Priority: `data-dd-action-name` / `actionNameAttribute` → "Masked Element" if privacy applies → label/placeholder/aria-label → inner text (tree walker, v7) | `enablePrivacyForActionName` true (v7) | — | DD:real_user_monitoring/browser/tracking_user_actions/; CL v7.0.0 | accessed 2026-11-10 |
| INT-c | yes | Automatic with actions | on | Code: 3 clicks within 1 s, ≤100 px apart (docs say "more than three") | src:browser-rum-core/src/domain/action/computeFrustration.ts, clickChain.ts; DD:real_user_monitoring/browser/frustration_signals/ | v7.17.0 / 2026-11-05 |
| INT-d | yes | Automatic: a click with no page activity, input or scroll | on | Text inputs, select, labels with `for` excluded | src:…/computeFrustration.ts | v7.17.0 / 2026-11-05 |
| INT-e | yes | Automatic: a click followed by an error | on | — | DD:…/frustration_signals/ | accessed 2026-11-10 |
| INT-f | partial | No scroll RUM events. View events carry max scroll depth (`max_depth_scroll_top`). Replay records scroll. | on | — | src:browser-rum-core/src/domain/view/viewCollection.ts | v7.17.0 / 2026-11-05 |
| INT-g | no | Inputs are recorded only in replay (masked by default) | — | — | src:browser-rum/src/domain/record/trackers/trackInput.ts | v7.17.0 / 2026-11-05 |
| INT-h | yes | Server side: click maps, top elements, scroll maps built from actions plus a replay snapshot | — | Needs Session Replay and `trackUserInteractions`; not on gov sites | DD:product_analytics/heatmaps/ | accessed 2026-11-10 |
| INT-x1 | yes | Per-element frustration opt-out: `data-dd-ignore-frustration` (all, or a list of rage-click / dead-click / error-click) | — | Added in 7.13 | src:browser-rum-core/src/domain/configuration/configuration.ts; CL 7.13.0 | v7.17.0 / 2026-11-05 |
| INT-x2 | yes | Manual actions: `addAction`, timed `startAction`/`stopAction` | — | — | src:browser-rum-core/src/boot/rumPublicApi.ts | v7.17.0 / 2026-11-05 |

## NAV navigation

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| NAV-a | yes | Automatic view per page load; bfcache restores tracked (v7) | on | Default name replaces numeric path segments with `?` | ADV; CL v7.0.0 | accessed 2026-11-10 |
| NAV-b | yes | History API and hash changes create views automatically. Router plugins (React Router 6/7/8, TanStack, Vue Router, Angular, Next.js, Nuxt) produce route-template names. | on | — | src:browser-rum-react/src/entries/*; src:browser-rum-vue; src:browser-rum-angular | v7.17.0 / 2026-11-05 |
| NAV-c | n/a | — | — | — | — | — |
| NAV-d | n/a | — | — | — | — | — |
| NAV-e | yes | `trackViewsManually` + `startView(name \| {name, service, version, context})`; `setViewName`; `setViewContext`, `setViewContextProperty` | false | — | ADV | accessed 2026-11-10 |
| NAV-f | partial | Page visibility extends the session; bfcache restores create views. No explicit foreground/background events found. | — | — | src:browser-core/src/domain/session/sessionManager.ts | v7.17.0 / 2026-11-05 |

## RPL replay

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| RPL-a | yes (paid tier) | Own recorder; docs say it uses rrweb. v7 code is a custom serializer (string table, change encoder). Lazy-loaded chunk. | `sessionReplaySampleRate` 0 | Sample rate counts against "Browser RUM & Session Replay" pricing (per the config doc comment) | src:browser-rum/src/domain/record/; DD:session_replay/browser/; CL v7.0.0 | v7.17.0 / 2026-11-05 |
| RPL-b | n/a | — | — | — | — | — |
| RPL-c | partial | Whole-session sampling only. `startSessionReplayRecordingManually` + `startSessionReplayRecording({force})` can record an unsampled session from that point. | manual false | No client-side on-error ring buffer | src:browser-rum-core/src/domain/configuration/configuration.ts, sessionReplayState.ts | v7.17.0 / 2026-11-05 |
| RPL-d | partial | Shadow DOM: yes (shadowRootsController). Canvas: `sessionReplayCanvasRecording {enable, quality}` (low/medium/high = 1/4/8 fps), behind an experimental flag and hidden in docs. iframes: same-origin only, uncertain. | canvas off | WebGL: uncertain | src:browser-rum-core/src/domain/configuration/configuration.ts; src:browser-rum/src/domain/record/ | v7.17.0 / 2026-11-05 |
| RPL-e | partial | Player correlates RUM resource events on the timeline. No request or response bodies. | — | uncertain: player behaviour not confirmed in docs | DD:session_replay/browser/ (not stated) | accessed 2026-11-10 |
| RPL-f | uncertain | Docs do not mention console in replay. `console.error` appears as RUM errors. | — | — | DD:session_replay/browser/ | accessed 2026-11-10 |
| RPL-g | yes | `defaultPrivacyLevel` (allow / mask / mask-user-input / mask-unless-allowlisted); `data-dd-privacy` attribute or `dd-privacy-*` class (allow / mask / mask-user-input / hidden) | **code: `mask-user-input`** (changed in v7, PR #4279); docs page still says `mask` | password/email/tel and autocomplete inputs are always masked | src:browser-rum-core/src/domain/configuration/configuration.ts; PRIV | v7.17.0 / 2026-11-05 |
| RPL-h | n/a | — | — | — | — | — |
| RPL-i | n/a | — | — | — | — | — |
| RPL-j | yes | Segments flush at 5 s or 60 KB; compressed in a Web Worker | — | Docs: under 100 kB/min network; replay retention 30 days (Extended Retention up to 15 months) | src:browser-rum/src/domain/segmentCollection/segment.ts, segmentCollection.ts; DD:session_replay/browser/ | v7.17.0 / 2026-11-05 |
| RPL-x1 | yes | `getSessionReplayLink()`, `stopSessionReplayRecording()` | — | — | src:browser-rum-core/src/boot/rumPublicApi.ts | v7.17.0 / 2026-11-05 |

## USR user and attributes

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| USR-a | yes | `setUser({id,…})`; user can also be set in `init` (7.17) | — | `usr.id` required since 6.4 | ADV; CL 7.17.0 | accessed 2026-11-10 |
| USR-b | yes | `setUserProperty`, `removeUserProperty`, `getUser`, `clearUser`; account: `setAccount` / `setAccountProperty` / … | — | — | src:browser-rum-core/src/boot/rumPublicApi.ts | v7.17.0 / 2026-11-05 |
| USR-c | yes | `setGlobalContext`, `setGlobalContextProperty`, …; `storeContextsAcrossPages` (localStorage) | in memory per page; store false | storeContextsAcrossPages is incompatible with `trackSessionAcrossSubdomains`; 5 MiB localStorage limit | ADV; src:browser-core/src/domain/configuration/configuration.ts | v7.17.0 / 2026-11-05 |
| USR-d | yes | `trackAnonymousUser`: UUID v4 `usr.anonymous_id` in the session cookie; `tab.id` on events (6.33) | true | Up to 1 year; reset on `not-granted` | ADV; CL 6.33.0 | accessed 2026-11-10 |
| USR-e | no | No alias/merge API in the SDK | — | — | not found in source or docs | accessed 2026-11-10 |

## LOG logs

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| LOG-a | yes | `@datadog/browser-logs`: `logger.debug/info/warn/error`, `createLogger`, handlers http/console/silent, `setLevel` | — | 3000 logs per minute rate limit; 256 KiB maximum message | DD:logs/log_collection/javascript/; src:browser-core/src/transport/batch.ts | v7.17.0 / 2026-11-05 |
| LOG-b | yes | `forwardConsoleLogs` ('all' or a list of levels); `forwardErrorsToLogs`; `forwardReports` | `[]`; true; `[]` | forwardErrorsToLogs no longer includes console.error (v7) | src:browser-logs/src/domain/configuration.ts; CL v7.0.0 | v7.17.0 / 2026-11-05 |
| LOG-c | no | Proprietary log intake; no OTel logs API or OTLP | — | — | grep of repo for "opentelemetry": only telemetry enums | v7.17.0 / 2026-11-05 |

## SMP sampling

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| SMP-a | yes | `sessionSampleRate` (0–100) | 100 | Deterministic sampling by session id (v7) | src:browser-core/src/domain/configuration/configuration.ts; CL v7.0.0 | v7.17.0 / 2026-11-05 |
| SMP-b | yes | `traceSampleRate`; `profilingSampleRate`; `telemetrySampleRate` | 100; 0; 20 | Replay rate is a child rate of the session rate (`correctedChildSampleRate`) | src:browser-rum-core/src/domain/configuration/configuration.ts | v7.17.0 / 2026-11-05 |
| SMP-c | no | No per-error sample rate; use `beforeSend` to drop | — | — | not in config schema | v7.17.0 / 2026-11-05 |
| SMP-d | no | See RPL-c (manual or forced start only) | — | — | src:browser-rum-core/src/domain/sessionReplayState.ts | v7.17.0 / 2026-11-05 |
| SMP-e | no | An unsampled session sends nothing. Docs mention server-side Retention Filters as the alternative (sample client at 100, filter server side). | — | — | ADV; DD:…/collecting_browser_errors/ | accessed 2026-11-10 |
| SMP-f | yes (internal/undocumented) | `remoteConfiguration: {id, sync?, required?}`; cached and refreshed in the background. Supports sample rates, privacy, tracking flags, allowedTracingUrls, and values pulled dynamically from cookie/DOM/JS/localStorage. | off | Marked `@internal` in the types | src:browser-rum-core/src/domain/configuration/remoteConfiguration.ts; CL 7.2.0, 7.6.0 | v7.17.0 / 2026-11-05 |

## PRV privacy

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| PRV-a | yes | `trackingConsent` 'granted' / 'not-granted'; `setTrackingConsent()`. Calls before init are buffered (500-call buffer). | granted | not-granted collects nothing and stops the session. Not synced across tabs or persisted. | src:browser-core/src/domain/trackingConsent.ts; src:browser-rum-core/src/boot/preStartRum.ts; ADV | v7.17.0 / 2026-11-05 |
| PRV-b | yes | Action names follow the privacy level (`enablePrivacyForActionName`) | true (v7) | — | CL v7.0.0 (PR #4279) | v7.17.0 / 2026-11-05 |
| PRV-c | yes | `data-dd-privacy` / `dd-privacy-*` classes; `data-dd-action-name` | — | — | PRIV | accessed 2026-11-10 |
| PRV-d | partial | Through `beforeSend` (`view.url`, `resource.url`, `error.resource.url` editable). Default view names replace numeric segments with `?`. | no automatic query stripping | — | ADV | accessed 2026-11-10 |
| PRV-e | partial | IP stored in `session.ip` and geo derived server side; IP collection is turned off in the application settings in the UI | uncertain (docs do not state the default) | Proxy must send `X-Forwarded-For` for geo | DD:real_user_monitoring/browser/data_collected/; DD:real_user_monitoring/guide/proxy-rum-data/ | accessed 2026-11-10 |
| PRV-f | yes | `beforeSend(event, context)`; return false to drop | — | View events cannot be dropped; only listed fields are editable | ADV | accessed 2026-11-10 |
| PRV-g | no | No Do Not Track or GPC handling found | — | — | not found in source | v7.17.0 / 2026-11-05 |
| PRV-x1 | yes | `allowedTrackingOrigins`: the SDK refuses to run inside a browser extension unless the origin is allowed | — | — | src:browser-core/src/domain/configuration/configuration.ts | v7.17.0 / 2026-11-05 |

## TRN offline and transport

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| TRN-a | yes | Not configurable. Flush every 30 s, or at 50 messages, or 16 KiB, or on page exit or session expiry. | — | Single message limit 256 KiB | src:browser-core/src/transport/flushController.ts, httpRequest.ts, batch.ts | v7.17.0 / 2026-11-05 |
| TRN-b | partial | In-memory retry queue only (no IndexedDB). Backoff 1 s → 60 s. | — | Queue limit 20 MiB; 32 concurrent requests / 80 KiB in flight; lost on page close | src:browser-core/src/transport/sendWithRetryStrategy.ts | v7.17.0 / 2026-11-05 |
| TRN-c | yes | `fetch` with `keepalive`; `sendBeacon` on exit for Firefox and similar | — | Payloads over the limit are split | src:browser-core/src/transport/httpRequest.ts | v7.17.0 / 2026-11-05 |
| TRN-d | yes | `compressIntakeRequests` (deflate in a Worker, `workerUrl` for strict CSP). Replay is always compressed. | false | — | src:browser-rum-core/src/domain/configuration/configuration.ts | v7.17.0 / 2026-11-05 |
| TRN-e | yes | `proxy` (string, or function since 5.4) with a `ddforward` query parameter; `site` | site datadoghq.com | Proxy must forward the raw body and set XFF | DD:real_user_monitoring/guide/proxy-rum-data/ | accessed 2026-11-10 |
| TRN-f | yes | Retries on 408, 429, 5xx and offline status 0 | — | No Retry-After parsing seen | src:browser-core/src/transport/sendWithRetryStrategy.ts | v7.17.0 / 2026-11-05 |
| TRN-g | yes (vendor) | Datadog RUM event JSON schema (NDJSON) to `/api/v2/rum`; replay segments as multipart; `view_update` partial events (default since 7.15 unless a proxy is set) | — | Not OTLP | src:browser-rum-core/src/domain/configuration/configuration.ts; CL 7.15.0 | v7.17.0 / 2026-11-05 |

## CFG configuration

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| CFG-a | yes | One `init({applicationId, clientToken, site, …})` object, validated against a schema | — | `silentMultipleInit` false | src:browser-rum-core/src/domain/configuration/configuration.ts | v7.17.0 / 2026-11-05 |
| CFG-b | yes | Booleans `trackUserInteractions`, `trackResources`, `trackLongTasks`, `trackViewsManually`; `plugins: []` (unstable API) | true / true / true / false | No toggle for error tracking | same | v7.17.0 / 2026-11-05 |
| CFG-c | partial | SDK telemetry to Datadog (`telemetrySampleRate` 20); console warnings via `display`; Chrome developer extension | — | No client-side report of dropped data to the user | src:browser-core/src/domain/configuration/configuration.ts | v7.17.0 / 2026-11-05 |
| CFG-d | yes | `env`, `version`, `service` (defaults to applicationId since 7.13) | — | Tag syntax rules | src:browser-rum-core/src/domain/configuration/configuration.ts; CL 7.13.0 | v7.17.0 / 2026-11-05 |
| CFG-e | yes | npm, CDN async (`DD_RUM.onReady`), CDN sync. Replay and profiler are lazy-loaded chunks (ESM dynamic import, v7). `rum-slim` has no replay or profiler. | — | Async loading may miss early events | SETUP; CL v7.0.0 | accessed 2026-11-10 |
| CFG-f | partial | Micro-frontends: build plugin `sourceCodeContext` (6.30.1+) or `beforeSend`; `@datadog/browser-worker` package; extension gating (PRV-x1); Salesforce and Shopify bundles | — | SSR: init on the client only (uncertain for docs) | ADV; CL 7.6/7.7/7.14 | accessed 2026-11-10 |

## API manual instrumentation

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| API-a | yes | `addAction(name, context)`; `startAction`/`stopAction` | — | 3000 per minute rate limit | src:browser-rum-core/src/boot/rumPublicApi.ts | v7.17.0 / 2026-11-05 |
| API-b | yes | `addTiming`, duration vitals, operations (start/succeed/fail) | — | — | same | v7.17.0 / 2026-11-05 |
| API-c | partial | No span API. Duration vitals and operations are the nearest equivalent; manual `startResource`/`stopResource`. | — | — | same | v7.17.0 / 2026-11-05 |
| API-d | yes | `setViewContext`/`setViewContextProperty`/`getViewContext`; action context | — | — | same | v7.17.0 / 2026-11-05 |
| API-e | partial | Injects W3C `traceparent`/`tracestate` and `baggage`. No OTel API input and no OTLP output. | tracecontext on | — | NET-b sources | v7.17.0 / 2026-11-05 |

## SYM source maps and symbolication

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| SYM-a | yes | `datadog-ci sourcemaps upload` (service + release-version + minified-path-prefix) or debug IDs (RUM 7.6+, build plugins 3.3+) | — | Map plus minified file ≤ 500 MB | DD:real_user_monitoring/guide/upload-javascript-source-maps/ | accessed 2026-11-10 |
| SYM-b | n/a | — | — | — | — | — |
| SYM-c | n/a | — | — | — | — | — |
| SYM-d | n/a | — | — | — | — | — |
| SYM-e | yes | Build plugins for webpack, Vite, esbuild, Rollup and Rspack; datadog-ci CLI; WASM symbol upload | — | — | same | accessed 2026-11-10 |

## FWK framework integrations

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| FWK-a | yes | `@datadog/browser-rum-react`: `reactPlugin({router})`, `ErrorBoundary`, `addReactError`, `UNSTABLE_ReactComponentTracker`, React Router 6/7/8 and TanStack entries | — | Component tracker is UNSTABLE | src:browser-rum-react/src/entries/main.ts | v7.17.0 / 2026-11-05 |
| FWK-b | yes | `@datadog/browser-rum-nextjs` (`nextjsPlugin`, `DatadogAppRouter` / `DatadogPagesRouter`, ErrorBoundary, `addNextjsError`); `@datadog/browser-rum-nuxt` | — | — | src:browser-rum-nextjs/src/entries/main.ts; src:browser-rum-nuxt | v7.17.0 / 2026-11-05 |
| FWK-c | yes | Vue (`vuePlugin`, `addVueError`, router); Angular (`angularPlugin`, `provideDatadogRouter`, `provideDatadogErrorHandler`); Svelte: none found | — | — | src:browser-rum-vue, src:browser-rum-angular | v7.17.0 / 2026-11-05 |
| FWK-d | n/a | — | — | — | — | — |
| FWK-e | n/a | — | — | — | — | — |
| FWK-f | n/a | — | — | — | — | — |
| FWK-g | partial | The browser core is reused by the Flutter web and Unity web SDKs (`source` option); Electron is mentioned in the docs | — | — | src:browser-core/src/domain/configuration/configuration.ts; PRIV | v7.17.0 / 2026-11-05 |

## REL release and versioning

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| REL-a | yes | `version` in init | — | — | DD:real_user_monitoring/guide/setup-rum-deployment-tracking/ | accessed 2026-11-10 |
| REL-b | partial | Deployment tracking shows sessions, error rate, loading time and CWV per version. A crash-free % is not stated for web. | — | — | same | accessed 2026-11-10 |
| REL-c | uncertain | Not covered on the deployment tracking page. Source Code Integration exists for stack traces but was not verified. | — | — | same | accessed 2026-11-10 |
| REL-d | partial | Sessions by version (an indirect adoption measure) | — | — | same | accessed 2026-11-10 |

## FF feature flags

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| FF-a | yes | `addFeatureFlagEvaluation(key, value)`; attached to views and errors; `trackFeatureFlagsForEvents` adds vital/action/long_task/resource | views and errors | Restrictions on flag-name characters | DD:real_user_monitoring/feature_flag_tracking/setup/ | accessed 2026-11-10 |
| FF-b | yes (separate pkg) | Datadog Feature Flags through `@datadog/openfeature-browser` (`DatadogProvider`) | — | Not on all sites (search snippet; page not opened) | DD:feature_flags/client/javascript | accessed 2026-11-10 |
| FF-c | yes | OpenFeature provider (FF-b); documented integrations for Amplitude, ConfigCat, DevCycle, Eppo, Flagsmith, GrowthBook, Kameleoon, LaunchDarkly, Split, Statsig | — | — | DD:real_user_monitoring/feature_flag_tracking/setup/ | accessed 2026-11-10 |

## FB user feedback

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| FB-a | no | — | — | Nothing in the browser SDK packages | src: package list | v7.17.0 / 2026-11-05 |
| FB-b | no | — | — | — | same | v7.17.0 / 2026-11-05 |
| FB-c | no | — | — | — | same | v7.17.0 / 2026-11-05 |

## OTH other

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| OTH-a | yes | Product Analytics uses the same SDK (views and actions); heatmaps | — | Product Analytics click data kept 15 months vs RUM 30 days | SETUP; DD:product_analytics/heatmaps/ | accessed 2026-11-10 |
| OTH-b | uncertain | Not in the browser SDK; Eppo is among the flag integrations | — | — | — | accessed 2026-11-10 |
| OTH-c | no | — | — | — | not found | v7.17.0 / 2026-11-05 |
| OTH-d | yes | `window.DatadogEventBridge`: inside a mobile WebView the SDK sends events to the native SDK (host wildcard support 7.3); privacy level comes from the bridge; replay only if the bridge supports records | auto when a bridge exists | — | src:browser-core/src/transport/eventBridge.ts; src:browser-rum-core/src/domain/sessionReplayState.ts | v7.17.0 / 2026-11-05 |
| OTH-e | yes | Synthetic browser tests produce `session.type: synthetics` sessions (not billed) | — | — | DD:real_user_monitoring/browser/data_collected/ | accessed 2026-11-10 |
| OTH-f | partial | Shopify bundle (`@datadog/browser-rum-shopify`); Salesforce bundle; Segment: not found | — | — | CL 7.6/7.7/7.14 | v7.17.0 / 2026-11-05 |
| OTH-g | yes | Live Debugger (dynamic probes in the browser; `browser-debugger` is private in the repo); WASM plugin; `getSessionReplayLink`; `tab.id` | — | Debugger shipping status: uncertain | src:browser-debugger/; CL 7.3–7.17 | v7.17.0 / 2026-11-05 |
| OTH-h | uncertain | Not researched: the row was added after the research. No bot filter appears in this file | — | — | — | accessed 2026-11-10 |

## Notable

1. **Session model:** 15 min inactivity and 4 h maximum are hard-coded. State lives in one first-party cookie, `_dd_s_v2`, so tabs share a session for free. `memory` and `local-storage` are fallbacks. RUM and Logs must share identical persistence options.
2. **Privacy defaults changed in v7 (2026):** `defaultPrivacyLevel` is `mask-user-input` and action names are masked by privacy level. The public privacy docs still say `mask`, so read defaults from source, not docs.
3. **No client-side on-error replay buffer:** sampling is whole-session (replay rate is a child of the session rate), plus `force` manual start. Datadog moved the cost lever server side ("Retention Filters", sample at 100%).
4. **Transport is simple and in-memory:** flush at 30 s, 50 messages or 16 KiB; 256 KiB maximum per event; 20 MiB retry queue with 1–60 s backoff; keepalive fetch and sendBeacon on exit. There is no IndexedDB offline store.
5. **Partial view updates (`view_update`) are on by default since 7.15.** Views are long-lived, mutable events. Sending diffs instead of whole view snapshots saves bandwidth, and proxies must forward the new type.
6. **Rate limiter:** 3000 errors, actions or logs per minute per type is the only client-side flood guard. There is no content dedup.
7. **Trace propagation defaults to W3C `tracecontext` plus Datadog headers, and `baggage` carries user and account ids (v7).** It needs an explicit URL allowlist and a configured `service`.
8. **Frustration signals in code:** rage click is 3 clicks within 1 s and ≤100 px. Dead clicks exclude text inputs and selects and need no activity, input or scroll. Elements can opt out with `data-dd-ignore-frustration`. The docs say "more than three".
9. **Remote configuration exists but is `@internal`:** it is a cached, non-blocking fetch that can also pull values from cookie, DOM, JS or localStorage. Kill switches and sample rates live here.
10. **No OTel anywhere in the client:** a proprietary event schema, its own vitals/operations API instead of spans, and no OTLP. W3C trace context is the only OTel-compatible surface.
