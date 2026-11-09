# Appendix B: Datadog browser SDK (DataDog/browser-sdk) and the RUM event schema

Written 2026-10-29 by the `datadog-browser-sdk` research session. Everything below was read in the source unless it is marked `[docs only]` or `[blog only]`. CDN sizes were measured here with `curl` (transfer bytes only, nothing executed).

**Citation key.** `dd:<path>:<line>` means `github.com/DataDog/browser-sdk` at tag **v7.16.2**, commit `2ee6f07f364ded3863bdb8174bcf7e5e3bc86ef0` (2026-10-27). Paths under `packages/` are shortened: `core/` = `packages/browser-core/src/`, `rumcore/` = `packages/browser-rum-core/src/`, `rum/` = `packages/browser-rum/src/`, `logs/` = `packages/browser-logs/src/`, `worker/` = `packages/browser-worker/src/`, `js-core/` = `packages/js-core/src/`. `ref:<path>:<line>` means `github.com/DataDog/rum-events-format` at `main`, commit `e56d61f0016c507091c8093befa9e73c42037c70` (2026-10-22); the SDK pins that repo at `099b70ec` (`dd:package.json:49`).

## 1. Sources

| Source | Version studied | Licence | Notes |
|---|---|---|---|
| `github.com/DataDog/browser-sdk` | tag v7.16.2, `2ee6f07f` | Apache-2.0 (`dd:LICENSE`) | Cloned `--filter=blob:none`, nothing installed or built. v7.0.0 was tagged 2026-04-29. |
| `github.com/DataDog/rum-events-format` | `main`, `e56d61f0` | Apache-2.0 | JSON schemas for RUM, session replay, telemetry and profiling events. The SDK generates its TypeScript types from them (`ref:README.md`, `dd:rum/src/types/sessionReplay.ts:1-3`). |
| CDN bundles `https://www.datadoghq-browser-agent.com/us1/v7/*.js` | 7.16.2 (version string inside the file) | | Measured here, section 7. |
| Docs: Browser Session Replay | fetched 2026-10-29 | | https://docs.datadoghq.com/real_user_monitoring/session_replay/browser/ |
| Docs: Frustration signals | fetched 2026-10-29 | | https://docs.datadoghq.com/real_user_monitoring/browser/frustration_signals/ |
| Docs: Monitoring page performance | fetched 2026-10-29 | | https://docs.datadoghq.com/real_user_monitoring/browser/monitoring_page_performance/ |
| Docs: CSP | fetched 2026-10-29 | | https://docs.datadoghq.com/integrations/content_security_policy_logs/ |
| Docs: Error tracking default grouping | fetched 2026-10-29 | | https://docs.datadoghq.com/error_tracking/default_grouping/ |
| Docs: Heatmaps | search result only | | https://docs.datadoghq.com/session_replay/heatmaps |

Open source: every SDK package, the developer extension (`dd:developer-extension/`), the deflate worker, the replay recorder and the event schemas. Closed: the intake, the replay player, issue grouping, heatmaps, funnels, the remote-configuration service (only its schema is mirrored, `dd:remote-configuration/README.md:1-3`). No Datadog engineering blog on browser SDK performance was found (two searches); performance claims come from the docs page above.

## 2. Packages and frameworks

| npm package | Role | Code |
|---|---|---|
| `@datadog/browser-rum` | RUM + session replay + JS self-profiling; recorder and profiler are lazy chunks | `dd:rum/entries/main.ts:13-16,83-95`; `dd:rum/boot/lazyLoadRecorder.ts:17-19` |
| `@datadog/browser-rum-slim` | Same RUM core, recorder and profiler replaced by stubs, no deflate worker | `dd:packages/browser-rum-slim/src/entries/main.ts` (`makeRecorderApiStub`, `makeProfilerApiStub`, no `startDeflateWorker`) |
| `@datadog/browser-rum-core` | Views, actions, errors, resources, vitals, tracing, assembly | `dd:rumcore/` |
| `@datadog/browser-core` | Session store, transport, error parsing, telemetry, configuration validation | `dd:core/` |
| `@datadog/js-core` (0.0.19) | Extracted pure utilities, timers, DOM helpers, endpoint builder (moved there in 7.15-7.16) | `dd:js-core/`; `dd:CHANGELOG.md:47-48` |
| `@datadog/browser-logs` | Logger, console forwarding, network errors, reports | `dd:logs/domain/configuration.ts:95-111` |
| `@datadog/browser-worker` | The deflate Web Worker, for self-hosting through `workerUrl` | `dd:worker/boot/startWorker.ts` |
| `@datadog/browser-rum-react` | Plugin, error boundary, React Router v6/v7/v8 and TanStack Router view naming, component render vitals | `dd:packages/browser-rum-react/src/domain/` |
| `-angular`, `-vue`, `-nuxt`, `-nextjs` | Router view naming and framework error handlers | `.../domain/{angularRouter,router,nextJSRouter,error}/` |
| `-shopify`, Salesforce build, `browser-plugin-wasm`, `browser-debugger` (private, Live Debugger) | Platform-specific bundles | `dd:packages/` listing |

- **Router integration.** Framework plugins set `trackViewsManually = true` and call `startView(<route pattern>)` on navigation (`dd:packages/browser-rum-react/src/domain/reactPlugin.ts:63-70`; `.../reactRouter/startReactRouterView.ts:5-43`). View names are route templates such as `/users/:id`, with splats substituted by the matched path (`startReactRouterView.ts:45-60`).
- **Module format and floor.** Build target ES2020 (`dd:webpack.base.ts:38`, `dd:tsconfig.base.json:10`); unit tests run on Chrome/Edge 80, Firefox 78, Safari 14 (`dd:test/unit/browsers.conf.ts:5-48`). v7 dropped old-browser shims and moved CDN async chunks to ESM dynamic imports (`dd:CHANGELOG.md:577,573`).
- **CDN.** One file per product per site and major (`/us1/v7/datadog-rum.js`). The async chunk URL is resolved relative to the main script (`n.u=t=>"chunks/"+t+"-"+{datadogRecorder:"531f…",datadogProfiler:"3cbd…"}[t]+"-datadog-rum.js"`, read from the CDN file). The async loader snippet with `DD_RUM.onReady` queueing is documented `[docs only]`; calls before init are buffered by `preStartRum` (`dd:rumcore/boot/preStartRum.ts`).

## 3. RUM

### 3.1 Sessions

| Topic | How it works | Code |
|---|---|---|
| Timeouts | 15 min inactivity (`SESSION_EXPIRATION_DELAY`), 4 h maximum (`SESSION_TIME_OUT_DELAY`). Effective expiry = `min(expire, created + 4h)`. | `dd:core/domain/session/sessionConstants.ts:3-4`; `sessionState.ts:25-31` |
| What extends it | `click`, `touchstart`, `keydown`, `scroll` (capture, passive), throttled to once per second: expand or renew. `visibilitychange` to visible and a 1-minute interval while visible: expand only (never renews). `resume`: re-initialise. | `sessionManager.ts:107-112,199-223,356-385`; `VISIBILITY_CHECK_DELAY` `:64` |
| Store key and format | Key **`_dd_s_v2`** since v7.0.0; the legacy `_dd_s` is read once on the first write and migrated (`#4459`). Value is `key=value` pairs joined by `&`, values `[a-z0-9-]`: `id=<uuid>&created=<ms>&expire=<ms>&aid=<uuid>&c=<hex>`, plus `isExpired=1` for an expired session and `forcedReplay=1` after a forced replay start. `c` encodes the cookie options in one byte (version, domain depth, cross-site flag) so two SDK instances with different cookie options do not read each other's cookie. | `storeStrategies/sessionStoreStrategy.ts:6-7`; `sessionState.ts:9-19,69-95`; `sessionStateValidation.ts:1-9`; `sessionInCookie.ts:70-85,133-167`; `dd:rum/boot/postStartStrategy.ts:129`; `dd:CHANGELOG.md:600` |
| Persistence | `sessionPersistence` is an ordered list of `'cookie' \| 'local-storage' \| 'memory'`; the first that initialises wins. Default `['cookie']`, `['memory']` in a Worker. Cookie probing prefers the **Cookie Store API**, then `document.cookie`. localStorage is probed with a write-read-delete of `_dd_test_<uuid>`. No storage at all: the SDK warns and sends nothing. | `dd:core/domain/session/sessionStore.ts:15-63`; `sessionInCookie.ts:28-45`; `sessionInLocalStorage.ts:11-22`; `sessionManager.ts:92-96`; config `dd:core/domain/configuration/configuration.ts:313-318` |
| Cookie lifetime | 1 year when `trackAnonymousUser` (default **true**) so the anonymous id survives, else 4 h. | `sessionInCookie.ts:81`; `sessionConstants.ts:5`; `configuration.ts:297` |
| Cross-subdomain | `trackSessionAcrossSubdomains` sets the cookie `domain` to the registrable domain, found by writing `dd_site_test_<uuid>` on `com`, `example.com`, … until a write sticks. `usePartitionedCrossSiteSessionCookie` adds `Secure; SameSite=None; Partitioned` for third-party iframes. | `dd:core/browser/cookie.ts:72-136` |
| Multi-tab locking | Cookie writes run inside **`navigator.locks.request('_dd_s_v2', …)`** (read-modify-write under a Web Lock); without Web Locks, a per-tab promise chain serialises writes. Teardown errors from the lock are swallowed. localStorage writes are not locked; other tabs learn through the `storage` event. | `sessionInCookie.ts:47-125`; `sessionInLocalStorage.ts:24-52` |
| Cross-tab rules | A tab whose session expired does **not adopt** a new session id written by another tab; it waits for its own user activity (`#4475`, `#4537`). A context history (max 1000 entries) maps event times to the session they belonged to. Events of a session created > **12 h** ago are dropped, because the backend recreates sessions older than 24 h. | `sessionManager.ts:66-81,252-279`; `dd:CHANGELOG.md:613-616` |
| Anonymous id | `aid=<uuid>` created with the first session when `trackAnonymousUser`; kept across session renewals, deleted when consent is revoked. | `sessionState.ts:33-45,97-131`; `sessionManager.ts:184-190,287-304` |
| Consent | `trackingConsent` (`granted` default); revoking expires the session in storage; granting renews it. | `sessionManager.ts:130-144,199-209` |
| Session sampling | **Deterministic from the session id** since v7 (`#4194`): `isSampled(id, rate)` multiplies the last UUID group (48 bits) by the Knuth factor `1111111111111111111n` mod 2^64 and compares with `rate% × 2^64`, the same formula as dd-trace. No sampling flag is stored. | `dd:core/domain/sampler.ts:7-66`; `sessionManager.ts:229-241` |
| Replay sampling | `SAMPLED` when `isSampled(id, sessionSampleRate × sessionReplaySampleRate / 100)`; `FORCED` when `forcedReplay=1`; else `OFF`. Same id-based draw, so the replay subset is nested in the session subset. Trace and profiling use the same pattern. | `dd:rumcore/domain/sessionReplayState.ts:17-35`; `dd:core/domain/sampler.ts:1-3`; `dd:rumcore/domain/tracing/tracer.ts:139-142` |

### 3.2 Views

- **Creation.** One view at init (`initial_load`). Automatic mode subscribes to a location observable built from wrapped `history.pushState` / `replaceState` (instance method if the framework overrode it, as Next.js does), `popstate` and `hashchange`; a new view (`route_change`) starts only when the **pathname changes or the hash path changes** and the hash is not an in-page anchor. Query-string-only changes do not create views. Restores from bfcache start a `bf_cache` view; session renewal starts a `session_renewal` view with the previous name and context (`dd:rumcore/browser/locationChangeObservable.ts:10-73`; `dd:rumcore/domain/view/trackViews.ts:120-175,417-434`).
- **Manual mode.** `trackViewsManually: true` disables the location subscription; `startView(nameOrOptions)` ends the current view and starts a `route_change` view (`trackViews.ts:126-133,182-185`; config `dd:rumcore/domain/configuration/configuration.ts:504`).
- **Updates and `_dd.document_version`.** A view is one evolving document. Each `triggerViewUpdate` increments `documentVersion` and emits the full view (`trackViews.ts:329-354`). Updates are throttled to **3 s** (trailing), forced every **5 min** as a session keep-alive, on `before_unload`, and at view end; after the end, metrics keep being tracked for **5 min** (`trackViews.ts:90-99,251-312,364-383`). Schema: `_dd.document_version` integer ≥ 0, `_dd.format_version` const 2 (`ref:schemas/rum/_view-properties-schema.json:467-478`; `ref:schemas/rum/_common-schema.json:422-428`).
- **Partial view updates (`view_update`).** On by default since 7.15.0 unless a `proxy` is set (`dd:rumcore/domain/configuration/configuration.ts:594-618`; `dd:CHANGELOG.md:88`). In the batch, a new view is upserted in full; later updates either replace the full view still in the batch, or become **one aggregate diff** (`type: "view_update"`) against what the backend last received, keyed by view id, with a full view every **100** updates as a checkpoint and always at view end. Context, user, device and custom timings are replaced as wholes; `_dd.page_states` is appended (`dd:rumcore/transport/startRumBatch.ts:14-58,65-172`; `dd:rumcore/domain/view/viewDiff.ts`). `view_update` bypasses `beforeSend` (`startRumBatch.ts:148-150`). Schema `ref:schemas/rum/view_update-schema.json`.
- **Loading time.** Candidates: the `load` event (initial view only) and the end of page activity; the reported value is the **max** of the candidates, and is dropped if the page was hidden before it (`dd:rumcore/domain/view/viewMetrics/trackLoadingTime.ts:17-55`). Page activity = DOM mutations (except under `data-dd-excluded-activity-mutations`), `window.open`, PerformanceResourceTiming entries, and fetch/XHR start/complete with a pending-request counter, minus `excludedActivityUrls` (`dd:rumcore/domain/waitPageActivityEnd.ts:117-186`). Activity must appear within **100 ms** of the start (`PAGE_ACTIVITY_VALIDATION_DELAY`) or there is no activity candidate; it ends **100 ms** after the last change with no request pending (`PAGE_ACTIVITY_END_DELAY`, `:14-17,75-97`). So a route change with no activity in its first 100 ms has no loading time (`trackLoadingTime.ts:11-15`). `setViewLoadingTime()` overrides and stops the automatic value (`trackCommonViewMetrics.ts:86-97`). The docs describe the same algorithm `[docs]`.
- **Other view metrics.** Custom timings (`addTiming`, names sanitised to `[a-zA-Z0-9-_.@$]`, `trackViews.ts:390-415`); scroll depth (`maxDepth`, `maxDepthScrollTop`, throttled 1 s, `trackScrollMetrics.ts:10-15`) that feeds scroll maps `[docs only]`; navigation timings, FCP, LCP on the initial view only (`trackViews.ts:273-276`); experimental soft-navigation LCP on route changes behind `soft_navigation` and the browser's `soft-navigation` entry (`trackViews.ts:278-284`; `dd:CHANGELOG.md:111`); event counts.

### 3.3 Web vitals: their own implementation

No `web-vitals` dependency (`rumcore` depends only on `browser-core` and `js-core`); each file cites web-vitals as the reference implementation.

| Vital | Rules | Attribution | Code |
|---|---|---|---|
| LCP | Initial view only. Entries ignored after the first `pointerdown`/`keydown`, after first hidden, after 10 min, or not larger than the previous entry. | `targetSelector`, `resourceUrl`, sub-parts `loadDelay`, `loadTime`, `renderDelay` from TTFB and the matching resource entry | `trackLargestContentfulPaint.ts:14,33-131` |
| CLS | Per view (entries before view start ignored). Session windows: gap < 1 s, length ≤ 5 s; value = max window, rounded to 4 decimals; reported 0 when nothing shifts. | Largest-area source node of the biggest shift: selector, `previousRect`, `currentRect`, `devicePixelRatio`, time | `trackCumulativeLayoutShift.ts:54-183`; `getClsAttributionImpactedArea.ts` |
| INP | **Per view**, not per page. `event` observer with `durationThreshold: 40`, plus `first-input`; keeps the 10 longest interactions and reports the p98 estimate; capped at 60 s; 0 when there were interactions but none ≥ 40 ms. | `targetSelector` (from the click-action selector cache first), `time`, sub-parts `inputDelay`, `processingDuration`, `presentationDelay` grouped by 8 ms render time | `trackInteractionToNextPaint.ts:17-23,49-141,163-185` |
| FID | Removed in v7 (`#4223`) | | `dd:CHANGELOG.md:584` |

### 3.4 Actions and frustration signals

- **Click lifecycle.** On `pointerdown` the target's privacy level is computed (`hidden` → no action), the action base (name, selector, composed-path selector for shadow DOM, size, position) is captured, and a 100 ms activity probe starts. On `click`, the action starts and waits for page activity end with a **10 s** cap (`CLICK_ACTION_MAX_DURATION`); duration = activity end − click; it is cut at view end or page exit (`dd:rumcore/domain/action/trackClickActions.ts:133-245`; `interactionSelectorCache.ts:5`).
- **Naming algorithm** (`getActionNameFromElement.ts:14-309`):
  1. `data-dd-action-name`, then the user's `actionNameAttribute`, on the element or **any** ancestor (shadow-aware) → `custom_attribute`.
  2. If the node privacy level is `mask` → the placeholder **"Masked Element"** (`mask_placeholder`).
  3. Priority strategies on the element and up to 10 ancestors, stopping at `FORM`, `BODY`: first `<label>` text, `input[type=button|submit|reset]` value, text of `BUTTON`/`LABEL`/`A`/`role=button|link`, `aria-label`, `aria-labelledby` targets, `alt`, `name`, `title`, `placeholder`, first `<option>`.
  4. Fallback: the element's rendered text through a **TreeWalker** that skips invisible nodes (`visibility`, `display:none`, `content-visibility`), masked nodes and nodes carrying a name attribute, inserting spaces for block-level elements (v7, `#3972`).
  5. Whitespace normalised, truncated to 100 chars + ` [...]`; empty → `blank`.
- **Privacy of names.** `enablePrivacyForActionName` (default **true** in v7) applies the replay privacy level: masked text nodes are rejected, masked attributes are replaced, and under `mask-unless-allowlisted` only strings in `window.$DD_ALLOW` survive (`getActionNameFromElement.ts:207-228,284-308`; `dd:rumcore/domain/privacy.ts:333-351`; config `configuration.ts:507`). `$DD_ALLOW` is filled outside the SDK, by Datadog's build plugin `[docs only]`.
- **Frustration rules** (`computeFrustration.ts`, `clickChain.ts`):
  - A **click chain** collects clicks on the **same target**, within **100 px** and **1 s** of the previous one (`clickChain.ts:12-13,69-84`).
  - **Rage**: any 3 consecutive clicks of the chain within 1 s (`MIN_CLICKS_PER_SECOND_TO_CONSIDER_RAGE = 3`), unless a click changed the text selection or scrolled. The chain collapses into one rage action carrying all click events; dead and error flags are added to it if any click qualifies (`computeFrustration.ts:6-19,37-57`; `trackClickActions.ts:395-405`). The docs say "more than three times" (≥ 4); the code fires at 3 `[docs differ]`.
  - **Dead**: the click had no page activity (no mutation, request or resource within 100 ms), no input and no scroll, and its target (or the `for` target of a label) is not a text input, textarea, select, `[contenteditable]`, canvas or `a[href]`. Not reported when the selection changed (double/triple-click) (`computeFrustration.ts:21-33,59-91`; `listenActionEvents.ts`).
  - **Error**: at least one RUM error was counted while the action was open (`trackClickActions.ts:346-349`).
  - Opt-out per element and ancestors: `data-dd-ignore-frustration="rage-click dead-click error-click"` or empty / `all` (`frustrationIgnore.ts:1-54`).
- **Custom actions.** `addAction`, plus `startAction` / `stopAction` (`dd:rumcore/boot/rumPublicApi.ts:169-200`).

### 3.5 Resources, network and long tasks

- **Resources.** `PerformanceObserver('resource', buffered)`. Fetch/XHR entries are matched, after **50 ms**, to the closest earlier request with the same URL in a registry of up to 1000 completed requests; others go through an idle task queue. The navigation entry is emitted at `interactive` (`dd:rumcore/domain/resource/resourceCollection.ts:39-75`; `requestRegistry.ts:13-44`). Tracing ids are copied to `_dd.trace_id` / `_dd.span_id` (`resourceCollection.ts:204-237`). Headers: an allowlist (`cache-control`, `etag`, `age`, `expires`, `content-type`, `content-encoding`, `vary`, `content-length`, …) when configured, max 100 headers, 128 chars each (`configuration.ts:32-40`; `resourceCollection.ts:316-359`). GraphQL payload and errors on opt-in (`allowedGraphQlUrls`, `resource/graphql.ts`). `startResource` / `stopResource` for manual resources.
- **Failed requests** are resources with their status code; RUM creates no error event for them. The **logs** SDK creates network errors for status 0 (non-opaque) and 5xx, excluding aborted and intake requests, when `forwardErrorsToLogs` (`dd:logs/domain/networkError/networkErrorCollection.ts:32-50,90-91`).
- **Long tasks / LoAF.** `trackLongTasks` (default true). Uses `long-animation-frame` when supported, else `longtask`; LoAF events carry blocking duration, render and style/layout starts, first UI event, and per script: duration, pause, forced layout, source URL / function / char position, invoker, invoker type, window attribution, plus `_dd.debug_ids` (`dd:rumcore/domain/longTask/longTaskCollection.ts:21-105`).
- **`performance.measure` / user timing.** **Not collected**: no `measure` or `mark` observer in the RUM packages (`grep` for `'measure'` / `USER_TIMING` finds nothing). Custom durations go through `addDurationVital` / `startDurationVital` and `startOperation` / `succeedOperation` / `failOperation` (`rumPublicApi.ts:480-584`; `vital/vitalCollection.ts`). WebSocket vitals are experimental (`dd:CHANGELOG.md:58`).

### 3.6 Errors

- **Sources** (`error.source`): `source` (uncaught), `console`, `custom` (`addError`), `network`, `report`, `logger`, `agent` (`dd:core/domain/error/error.types.ts:46-54`).
- **Capture.** `window.onerror` and `window.onunhandledrejection` are wrapped with `instrumentMethod` (not `addEventListener`); a non-Error `onerror` gets a stack synthesised from message/URL/line/column (`dd:core/domain/error/trackRuntimeError.ts:13-55`). `console.error` becomes a RUM error (`dd:rumcore/domain/error/errorCollection.ts:24-29`). CSP violations and browser interventions come from `ReportingObserver` / `securitypolicyviolation` (`trackReportError.ts:5`). Error `cause` chains are flattened into `error.causes`; `componentStack` is kept for React (`errorCollection.ts:62-82`; `dd:core/domain/error/error.ts:60-112`).
- **Stack parsing.** A trimmed TraceKit port, run in the browser (`dd:core/tools/stackTrace/computeStackTrace.ts:1-5`). `handling_stack` records where `addError` / logger was called (`handlingStack.ts`).
- **Grouping hints.** `error.dd_fingerprint` on the thrown object → `error.fingerprint` (`error.ts:135`), also settable in `beforeSend`. Default grouping is server-side: service, error type, message and the top meaningful frame, with numbers, quoted and parenthesised text stripped `[docs only]`.
- **Source maps.** Uploaded out of band (datadog-ci or build plugins) `[docs only]`. In the SDK, a build plugin may inject `window.DD_SOURCE_CODE_CONTEXT` mapping a stack to `{service, version, ddDebugId}`; the SDK resolves the first frame URL and sends `_dd.debug_ids: [{url, id}]` on errors and LoAF events, and uses service/version for micro-frontend attribution (`dd:core/domain/sourceCodeContext.ts:1-89`).
- **`beforeSend(event, domainContext)`** may return `false` to drop, and may only change an allowlist of fields per event type (e.g. `view.name`, `view.url`, `context`, `error.message`, `error.stack`, `error.fingerprint`, `resource.url`, request/response headers, `action.target.name`); other edits are reverted. Views and some vitals cannot be dropped. Errors, actions and vitals are rate-limited to **3000 per minute** each (`dd:rumcore/domain/assembly.ts:15-60,71-74,113-138`; `dd:core/domain/eventRateLimiter/createEventRateLimiter.ts:7`).

### 3.7 Distributed tracing

- **Where.** Only URLs matching `allowedTracingUrls` (string, RegExp or function, each with its own `propagatorTypes`); `service` is required when tracing is on (`configuration.ts:534-556,636-639`; `tracer.ts:132-137`).
- **Propagators** (`tracer.ts:186-223`): `datadog` (`x-datadog-trace-id`, `-parent-id`, `-sampling-priority`, `x-datadog-origin: rum`), `tracecontext` (`traceparent` + `tracestate: dd=s:<0|1>;o:rum`), `b3`, `b3multi`. **Default `['tracecontext', 'datadog']`** (`configuration.ts:26`).
- **Ids.** Trace id is **64-bit** random; span id 63-bit. In `traceparent` the trace id is left-padded with 16 zeros, so the W3C trace id has an all-zero upper half (`identifier.ts:15-38`; `tracer.ts:200-203`).
- **Sampling decision.** `traceSampled = isSampled(session.id, sessionSampleRate × traceSampleRate / 100)` (default 100), deterministic per session (v7 warning on retention volume, `dd:CHANGELOG.md:566-569`). With `traceContextInjection: 'sampled'` (default) nothing is injected for unsampled traces; with `'all'` headers carry flag `00` / priority `0` so the backend can decide (`tracer.ts:139-152,170-173`; `configuration.ts:525-530`).
- **Baggage.** `propagateTraceBaggage` default true in v7: `baggage: session.id=…,user.id=…,account.id=…` (`tracer.ts:225-246`; `dd:CHANGELOG.md:586`).
- **Initial document.** The server can embed `<meta name="dd-trace-id">` + `dd-trace-time` (or an HTML comment); used if less than 2 min old, to link the navigation resource to the backend trace (`dd:rumcore/domain/tracing/getDocumentTraceId.ts:11-60`).
- **No browser spans.** The SDK never creates spans; the backend derives the browser part of the trace from resource events' `_dd.trace_id` / `_dd.span_id` `[docs only]`.

### 3.8 Feature flags, context, logs

- `addFeatureFlagEvaluation(key, value)` writes into a per-view context (history kept 4 h); attached as `feature_flags` to **view and error** events, and to `vital`, `action`, `long_task`, `resource` only when listed in `trackFeatureFlagsForEvents` (`dd:rumcore/domain/contexts/featureFlagContext.ts:27-71`; `configuration.ts:572-578`). The public API recommends `compressIntakeRequests` with feature flags (`rumPublicApi.ts:435`).
- Global, user and account contexts with optional cross-page persistence in localStorage (`storeContextsAcrossPages`, `dd:core/domain/configuration/configuration.ts:296`).
- Logs SDK: `forwardErrorsToLogs` (default true), `forwardConsoleLogs` and `forwardReports` (lists or `'all'`), named loggers with handlers (`dd:logs/domain/configuration.ts:95-111`). Logs join the RUM session through RUM's internal context (`logs/domain/contexts/rumInternalContext.ts`).

## 4. Session replay

### 4.1 Recorder lineage and format

- **Own recorder, derived from rrweb.** `LICENSE-3rdparty.csv:3-4` credits rrweb and rrweb-snapshot; record type ids follow rrweb (FullSnapshot 2, IncrementalSnapshot 3, Meta 4) and some attributes keep rrweb names (`rr_scrollLeft`, `rr_mediaState`, `serialization.types.ts:14-26`). Datadog-only record types: Focus 6, ViewEnd 7, VisualViewport 8, Frustration 9 (schema only, not emitted by the browser SDK) and **Change 12** (`dd:rum/types/sessionReplayConstants.ts:3-21`). rrweb is not a dependency.
- **The "Change" serialization (default since v7.0.0, `#4507`).** Each serialization transaction (a full snapshot, or one batch of mutations) is emitted as **one record whose `data` is a list of compact tuples** `[ChangeType, …args]`: AddString, AddNode, RemoveNode, Attribute, Text, Size, ScrollPosition, AddStyleSheet, AttachedStyleSheets, MediaPlaybackState, VisualViewport, AddRoleAnnotatedStrings, InputValue, InputSelection, ClearStrings, ImageContent (`sessionReplayConstants.ts:49-79`; `serialization/serializationTransaction.ts:44-53,228-245`). Full snapshots are `type: 2, format: Change`; incrementals are `type: 12` (`serializationTransaction.ts:231-243`). The encoder (`encoding/changeEncoder.ts:20-35`):
  - replaces every string with an id in a **string table** shared across the segment, grouped by role, busiest groups first so frequent strings get short ids;
  - groups changes by type inside a transaction;
  - clears the table at a soft maximum of 1,000,000 entries (`encoding/stringIds.ts:16-17`; `#4544`).
  Node positions use insertion cursors and numeric node ids reset on each full snapshot (`serializeFullSnapshot.ts:17`). The schema calls the change record "Experimental; subject to change" (`ref:schemas/session-replay/browser/change-record-schema.json:5`). The older rrweb-like v1 full snapshot schema still exists (`full-snapshot-v1-record-schema.json`).
- **Differences from rrweb in practice.** No rrweb `Mutation` JSON with repeated tag and attribute strings; a string table instead. Full snapshots are taken at **every view start**, not only at load (`startFullSnapshots.ts:19-30`). Mutations are batched with `requestIdleCallback` (timeout 100 ms) and a 16 ms trailing throttle (`mutationBatch.ts:11-40`); mouse moves are throttled to 50 ms and scrolls to 100 ms (`trackers/trackMove.ts:12`, `trackScroll.ts:12`).
- **Trackers.** Mutations, mouse move, mouse interaction, scroll, viewport and visual-viewport resize, input, media, stylesheet (CSSOM rule insert/delete, `adoptedStyleSheets`), focus, view end, canvas content and capture (`dd:rum/domain/record/record.ts:80-95`).

### 4.2 Privacy

- `defaultPrivacyLevel`: `allow`, `mask`, `mask-user-input` (**default**), `mask-unless-allowlisted` (`dd:core/domain/configuration/configuration.ts:13-18`; `dd:rumcore/domain/configuration/configuration.ts:519-523`). v7 made defaults stricter (`#4279`, `dd:CHANGELOG.md:583`).
- Per element: `data-dd-privacy="allow|mask|mask-user-input|mask-unless-allowlisted|hidden"` or class `dd-privacy-<level>`, inherited by descendants (`privacyConstants.ts:13-23`; `privacy.ts:21-68`).
- Forced overrides: `input[type=password|email|tel|hidden]` and `autocomplete=cc-*|*-password` are always masked (`privacy.ts:82-94`). `hidden` nodes become a placeholder with size only. Scripts, preload/prefetch links and many `<meta>` tags are ignored (`privacy.ts:236,267-300`).
- Masking: text → `x` per character, images → a 1×1 grey GIF, `***` for censored values (`privacyConstants.ts:25-39`); `mask-unless-allowlisted` keeps text only if it is in `$DD_ALLOW` and masks form fields and canvas (`privacy.ts:138-155,338-351`).

### 4.3 Canvas, shadow DOM, iframes

- **Canvas**: experimental (`session_replay_record_canvas` flag plus `sessionReplayCanvasRecording: {enable, quality}`), presets low/medium/high = 1/4/8 fps, max dimension 600/1000/1280, encode quality 0.3/0.5/0.75; WebP images, deduplicated by a downscaled hash, uploaded as separate replay **resources** and referenced by `ImageContent` changes; WebGL updates tracked (`dd:rumcore/domain/configuration/configuration.ts:426-457`; `dd:rum/domain/record/canvas/`; `dd:rum/boot/datadogRecorder.ts:51-53`; `dd:CHANGELOG.md:91-92,107-110`).
- **Shadow DOM**: open shadow roots are serialized as `#shadow-root` nodes and get their own mutation, input and scroll trackers (`shadowRootsController.ts:27-62`; `serializeNode.ts:107,123-124`).
- **Iframes**: no iframe traversal in the recorder (no `iframe` / `contentDocument` handling in `rum/domain/record`). An iframe is recorded only when the SDK runs inside it and shares the session `[docs only]`.

### 4.4 Lifecycle, sampling and manual mode

- Recording starts at init when the replay state is not `OFF` and `startSessionReplayRecordingManually` is false (`dd:rum/boot/preStartStrategy.ts:30`). `startSessionReplayRecording({force: true})` records an unsampled session and writes `forcedReplay=1` into the session store so other tabs follow (`postStartStrategy.ts:108-130,159-161`). Session expiry stops recording and session renewal restarts it (`postStartStrategy.ts:53-64`).
- Start sequence: lazy-import the recorder chunk and wait for `readyState === 'interactive'` in parallel, then start the deflate worker (`postStartStrategy.ts:69-106`).
- **No on-error buffer mode**: the only states are OFF, SAMPLED and FORCED (`sessionReplayState.ts:11-35`).

### 4.5 Compression in a worker

- Deflate is **pako's deflate, vendored and trimmed** (`dd:worker/domain/deflate.js:1-2`), 4256 lines. The worker keeps one deflate stream per stream id (replay, RUM, logs, …), pushes each write with `Z_SYNC_FLUSH`, and returns the new bytes plus a 6-byte trailer (empty block + adler32) so the main thread can close the stream synchronously at any time, and so the backend can concatenate segments (`worker/boot/startWorker.ts:48-113`).
- Worker source: by default a **Blob URL** from the worker code inlined into `datadog-rum.js` (`new Worker(workerUrl || URL.createObjectURL(new Blob([WORKER_STRING])))`, `dd:rum/domain/deflate/deflateWorker.ts:47-48`). CSP needs `worker-src blob:`, or a same-origin `workerUrl` pointing at `@datadog/browser-worker` of the same major `[docs]`. Init timeout 30 s; failure reports a CSP hint and replay stays off (`deflateWorker.ts:9,122-155`; `rum/domain/scriptLoadingError.ts:19-24`). `has_replay` is set only once the worker answered `initialized` (`dd:rum/boot/recorderApi.ts:40-63`).
- Main-thread side: serialization, `JSON.stringify` of records and `TextEncoder` happen in the page; only deflate is in the worker. Size before compression is estimated as `length / 8` (`dd:rum/domain/deflate/deflateEncoder.ts:128-134`).

### 4.6 Segments and linking

- A segment = records of **one view**, flushed on: view change, **5 s** after its first record, encoded size > **60,000 B**, page hidden / frozen / before-unload, or stop (`dd:rum/domain/segmentCollection/segmentCollection.ts:15-20,99-168`). Creation reasons are sent (`init`, `segment_duration_limit`, `segment_bytes_limit`, `view_change`, `visibility_hidden`, …).
- Upload: `multipart/form-data` with `segment` (deflate bytes, filename `<session>-<start>`) and `event` (JSON metadata: application, session, view ids, `start`, `end`, `records_count`, `index_in_view`, `has_full_snapshot`, `creation_reason`, raw and compressed sizes) to `/api/v2/replay` (`buildReplayPayload.ts:19-53`; `segment.ts:36-54`). On hidden it uses `send` (with retry); on real exit `sendOnExit` (beacon) (`segmentCollection.ts:115-125`).
- Linking: every RUM event of a recording session carries `session.has_replay: true`; view events carry `_dd.replay_stats` and `session.sampled_for_replay` (`dd:rumcore/domain/contexts/sessionContext.ts:34-55`; `viewCollection.ts:83`). Replay ↔ errors/actions/resources is by session id, view id and timestamp; no network bodies or console lines are stored in the replay itself (the player overlays RUM events) `[docs only]`. `getSessionReplayLink()` builds a player URL (`rum/domain/getSessionReplayLink.ts`).

## 5. Transport and OpenTelemetry

| Topic | Value | Code |
|---|---|---|
| Endpoints | `https://browser-intake-<site>/api/v2/{rum,logs,replay,profile,…}` with `ddsource`, `dd-api-key` (client token), `dd-evp-origin`, `dd-evp-origin-version`, `dd-request-id`; RUM adds `batch_time`, `_dd.api=fetch|beacon`, `_dd.retry_count`, `_dd.retry_after` | `dd:js-core/transport/endpointBuilder.ts:75-91,157-198` |
| Format | NDJSON, `POST` **without Content-Type** (no CORS preflight, beacon-compatible) | `dd:core/transport/httpRequest.ts:14-21` |
| Batching | Flush at **50 messages**, **16 KiB** (`RECOMMENDED_REQUEST_BYTES_LIMIT`), **30 s** (not configurable; there is no `flushTimeout` option in v7), session expiry, or page exit. One message > 256 KiB is dropped. Views are upserted by id | `flushController.ts:15-21,109-138`; `batch.ts:14,60-73`; `startRumBatch.ts:192` |
| Page exit | `visibilitychange→hidden`, `freeze`, `beforeunload`, `pagehide` (not persisted). On these, the batch uses `sendBeacon` if the payload < bytes limit and the URL is http(s), else `fetch` | `dd:core/browser/pageMayExitObservable.ts:5-70`; `batch.ts:75-110`; `httpRequest.ts:94-125` |
| fetch | Plain `fetch(url, {method: 'POST', body, mode: 'cors'})`, **no `keepalive`** (comment: keepalive behaves like normal fetch on Firefox) | `httpRequest.ts:90-146` |
| Retry and queue | Retry on status 0 while offline, 408, 429, 5xx; exponential backoff 1 s → 60 s; in flight ≤ 32 requests and ≤ 80 KiB; queue ≤ 20 MiB, then drop with an error | `sendWithRetryStrategy.ts:8-12,65-145,189-197` |
| Offline storage | None (in-memory queue only) | — |
| Compression | `compressIntakeRequests` (default false) deflates RUM and logs batches through the same worker, `dd-evp-encoding=deflate`; replay is always deflated | `dd:rumcore/boot/preStartRum.ts:160`; `endpointBuilder.ts:186-188` |
| Ad blockers | `proxy`: a string (`<proxy>?ddforward=<encoded path+query>`) or a function building the URL; partial view updates are off by default behind a proxy | `endpointBuilder.ts:145-155`; `configuration.ts:594-618` |
| Dual shipping | `replica: {clientToken, applicationId}` sends a copy to US1 | `endpointBuilder.ts:93-116` |
| Remote configuration | `remoteConfigurationId` loads part of the init config (sample rates, privacy, …) from a Datadog service | `dd:rumcore/domain/configuration/remoteConfiguration.ts:24`; `dd:remote-configuration/rum-sdk-config.json` |
| WebView bridge | In Datadog mobile WebViews, events go through `DatadogEventBridge` instead of HTTP; replay records too | `dd:rumcore/transport/startRumEventBridge.ts`; `dd:rum/domain/startRecordBridge.ts` |
| **OpenTelemetry** | **None.** No OTLP, no OTel API, no bridge; the only "OpenTelemetry" string is a telemetry enum describing the backend tracer used by the customer. Interop is limited to W3C `traceparent` / `baggage` on outgoing requests | `grep -rn opentelemetry\|otlp packages/*/src` → `dd:core/domain/telemetry/telemetryEvent.types.ts:409` only |

## 6. Other features

| Feature | Facts | Grounding |
|---|---|---|
| Issue grouping | Server-side fingerprint from service, type, message and top frame; `dd_fingerprint` / `error.fingerprint` override | `[docs only]`; SDK side `error.ts:135` |
| Source maps | Uploaded with datadog-ci or build plugins; debug ids via `DD_SOURCE_CODE_CONTEXT` | `[docs only]`; `sourceCodeContext.ts` |
| Heatmaps, scroll maps, top elements | Backend on top of replay and click actions; scroll maps use `view.scroll` metrics | `[docs only]`; `trackScrollMetrics.ts` |
| Funnels, journeys, product analytics | Backend queries over view and action events | `[docs only]` |
| Profiling | JS Self-Profiling API, 10 ms sample interval, 60 s collection windows, `profilingSampleRate` (default 0), needs `Document-Policy: js-profiling`; lazy chunk | `dd:rum/domain/profiling/datadogProfiler.ts:33-34,216-227`; `configuration.ts:497` |
| Feature flags | Section 3.8 | |
| Consent / cookieless | `trackingConsent`, `setTrackingConsent`; `sessionPersistence: ['memory']` for no client storage | sections 3.1 |
| Telemetry about the SDK itself | Errors, configuration (5 %), usage (5 %) sent to Datadog's own org, `telemetrySampleRate` default 20 | `dd:core/domain/configuration/configuration.ts:289-292` |
| Developer extension | Chrome extension with Events, Replay, Flags, Infos and Settings tabs (inspect events live, override or inject the SDK) | `dd:developer-extension/src/panel/components/tabs/` |
| Live Debugger, WebSocket vitals, Salesforce/Shopify bundles | Newer surfaces in 7.14-7.16 | `dd:CHANGELOG.md:56-60,99` |

## 7. Performance footprint

### 7.1 Bundle size, measured here (CDN v7.16.2, 2026-10-29)

| File | Raw bytes | gzip | brotli | Loaded |
|---|---|---|---|---|
| `datadog-rum.js` | 192,694 | 66,988 | 62,713 | eagerly; includes the inlined worker source (23,512 chars) |
| `chunks/datadogRecorder-…-datadog-rum.js` | 32,807 | 11,731 | — | lazily, when recording starts |
| `chunks/datadogProfiler-…-datadog-rum.js` | 8,555 | 3,347 | — | lazily, when profiling is sampled |
| `datadog-rum-slim.js` | 149,292 | 51,572 | 48,696 | eagerly; no worker, no recorder, no profiler |
| `datadog-logs.js` | 60,731 | 22,225 | 21,529 | eagerly |

Method: `Content-Length` from `curl -sI` for raw, `curl -s -H 'Accept-Encoding: gzip|br' -o /dev/null -w '%{size_download}'` for compressed transfer; worker length read from the inline `new Blob(['…'])`. Replay therefore costs about 43 KB raw / 15 KB gzip in the eager bundle (rum − slim, mostly the worker string) plus 33 KB raw / 12 KB gzip lazily.

### 7.2 Size and performance tooling in the repo

- **Bundle size**: `scripts/bundle-size` computes raw and gzip size of every file in `browser-rum`, `browser-logs`, `browser-rum-slim`, `browser-worker`, `browser-rum-shopify` (including chunks), reports them as Datadog metrics, and comments on the PR with a ⚠️ above **+5 %** (`dd:scripts/lib/computeBundleSize.ts:5-60`; `dd:scripts/bundle-size/lib/bundleSizes.ts:8-9,73-78`). The CI job is `allow_failure: true` (`dd:.gitlab-ci.yml:191-203`): **a warning, not a gate**.
- **Benchmarks**: Playwright + CDP in `test/performance/`: scenarios `heavy`, `shopistLike` (React test apps) and `instrumentationOverhead`, each run with configurations `none`, `rum`, `rum_replay`, `rum_profiling`, `none_with_headers` and two debugger ones; network throttled; metrics: CPU time (V8 `Profiler` samples), heap (`HeapProfiler.startSampling` at 100 B, median after GC), upload and download bytes, LCP/CLS/FCP/TTFB/INP/TBT (`dd:test/performance/createBenchmarkTest.ts:15-80`; `profilers/startCpuProfiling.ts`; `profilers/startMemoryProfiling.ts`; `profiling.type.ts:24-38`). An API benchmark triggers a Datadog Synthetic test that measures CPU per public call (add action, add error, start view, start/stop replay, log) (`dd:scripts/api-performance/lib/constants.ts`, `cpuPerformance.ts`). Both run only on a **scheduled** pipeline (`$TARGET_TASK_NAME == "performance-benchmark-scheduled"`, `.gitlab-ci.yml:636-659`) and report to dashboards; **no threshold fails CI**. Results are not published in the repo.
- **What runs where.** Main thread: every collector, DOM serialization, the change encoder, `JSON.stringify`, `TextEncoder` of records before posting. Worker: deflate only. Idle-time work: mutation batches (`requestIdleCallback`), resource assembly (task queue).

## 8. Blog-to-code grounding

| Claim | Where | Code | Verdict |
|---|---|---|---|
| "uses the open source rrweb project" | Session Replay docs | Own recorder; rrweb credited in `LICENSE-3rdparty.csv:3-4`, record ids kept, but the default format since v7 is the Change encoding with a string table (`serializationTransaction.ts:228-245`) | **Outdated**: lineage only |
| Most CPU-intensive work, including compression, runs in a web worker | Session Replay docs | Only deflate is in the worker (`worker/boot/startWorker.ts:56-75`); serialization stays on the main thread | **Partly true** |
| Network impact "less than 100kB/min" | Session Replay docs | Segments ≤ 60 KB deflated, flushed every 5 s at most (`segmentCollection.ts:15-20`); no per-minute cap in code | **Not enforced in code**; plausible average |
| Rage click = "more than three times" in 1 s | Frustration signals docs | 3 clicks within 1 s (`computeFrustration.ts:6,48-55`) | **Docs differ from code** |
| Loading time = max(load event, first idle 100 ms), `excludedActivityUrls`, `data-dd-excluded-activity-mutations` | Page performance docs | `trackLoadingTime.ts:31-55`; `waitPageActivityEnd.ts:14-19,174-186` | **Matches**; code adds the "hidden before" and "activity within 100 ms" rules |
| INP and CLS reported per view, including route changes | Page performance docs | `trackCommonViewMetrics.ts:55-68` | **Matches** |
| Worker must be same-origin, `worker-src blob:` | CSP docs | Blob URL default, `workerUrl` override (`deflateWorker.ts:47-48`) | **Matches** |
| Recorder lazy-loaded only when recording | third-party mirror, docs | `lazyLoadRecorder.ts:17-19`; CDN chunk exists | **Matches**; the worker code is still eager |

## 9. Questions asked and answers

| Question | Answer | Code |
|---|---|---|
| Cookie or localStorage? | Cookie by default (Cookie Store API when available), ordered fallback list via `sessionPersistence` | `sessionStore.ts:15-63` |
| `_dd_s` format? | Now `_dd_s_v2`: `id`, `created`, `expire`, `aid`, `c`, optional `isExpired`, `forcedReplay`, `&`-joined | `sessionState.ts:69-95`; `sessionStoreStrategy.ts:6-7` |
| 15 min / 4 h? | Yes; extension needs click/touch/key/scroll, throttled 1 s; visibility only extends | `sessionConstants.ts:3-4`; `sessionManager.ts:356-385` |
| Cross-subdomain? | `trackSessionAcrossSubdomains` → cookie on the probed registrable domain | `cookie.ts:72-136` |
| Multi-tab locking? | Web Locks around cookie read-modify-write; promise chain fallback; no adoption of another tab's new session after expiry | `sessionInCookie.ts:88-108`; `sessionManager.ts:265-269` |
| Sampling? | Deterministic Knuth hash of the session id for session, replay, trace, profiling | `sampler.ts:7-66` |
| How is loading time computed? | Max of load event and the end of page activity (100 ms validation, 100 ms quiet, pending requests counted) | `trackLoadingTime.ts`; `waitPageActivityEnd.ts` |
| What is `_dd.document_version`? | Counter of updates of one view; backend keeps the highest; `view_update` diffs carry it | `trackViews.ts:333`; `startRumBatch.ts:21-58` |
| Router detection? | history patch + popstate + hashchange; path or hash-path change only; framework plugins switch to manual `startView` | `locationChangeObservable.ts`; `reactPlugin.ts:69-70` |
| Action naming? | data attribute → mask placeholder → 10 priority strategies over 10 ancestors → TreeWalker text → blank, 100 chars | `getActionNameFromElement.ts` |
| Frustration thresholds? | Rage 3 in 1 s, same target, ≤ 100 px; dead = no activity in 100 ms minus input-like targets; error = error during the action | `computeFrustration.ts`; `clickChain.ts` |
| web-vitals library? | No, own implementations modelled on it, with attribution | `trackInteractionToNextPaint.ts:43-48` |
| LoAF? | Yes, preferred over `longtask`, full script attribution | `longTaskCollection.ts:21-105` |
| `performance.measure`? | Not collected | grep, section 3.5 |
| Propagators? | datadog, tracecontext, b3, b3multi; default tracecontext + datadog | `tracer.ts:186-223`; `configuration.ts:26` |
| Recorder? | Own, rrweb-derived, Change encoding with string table | section 4.1 |
| Deflate library? | Trimmed pako in a Blob-URL worker | `deflate.js:1-2`; `deflateWorker.ts:47-48` |
| Segment rules? | per view, 5 s, 60 KB, page exit | `segmentCollection.ts:15-20` |
| Manual replay? | `startSessionReplayRecordingManually` + `startSessionReplayRecording({force})` | `preStartStrategy.ts:30`; `postStartStrategy.ts:108-130` |
| Transport? | NDJSON, 50 msgs / 16 KiB / 30 s, beacon on exit, retry with backoff, 20 MiB queue | section 5 |
| OTLP? | No | section 5 |
| Bundle budget in CI? | Reported, +5 % warning, non-blocking | `bundleSizes.ts:9`; `.gitlab-ci.yml:199` |
| Performance tests? | CPU, heap, bytes, vitals per configuration, scheduled, not gating | `test/performance/` |

## 10. Takeaways for ouo

Worth copying into an OTel-native SDK:

1. **Deterministic sampling from the session id**, nested rates (`session × replay`, `session × trace`), and the same hash as the backend tracer. ouo already hashes the id (`ouo-web-today.md` §3); align the trace decision with it and write the formula into a spec so collector-side tail rules can reproduce it.
2. **Web Locks around session read-modify-write**, plus the "do not adopt another tab's new session after my own expiry" rule and a hard maximum age for late events. These fix the classic multi-tab session-split bugs cheaply.
3. **A cookie option for cross-subdomain sessions** (registrable-domain probe) and an ordered `sessionPersistence` list with a memory fallback. ouo is localStorage-only today.
4. **Loading time from page activity** (requests, mutations, resource entries, 100 ms validation and quiet windows, opt-out URLs and DOM attribute). It gives SPA route changes a meaningful duration that web-vitals does not provide; ship it as a span on the navigation.
5. **Vitals attribution as part of the event**: INP sub-parts and target selector, LCP sub-parts and element, CLS source rects. Using `web-vitals/attribution` gets most of it; per-view INP/CLS (reset at each route change) is the part web-vitals does not give.
6. **The action naming chain with privacy applied to names**, the frustration rules (click chain by target + distance + time, dead-click exclusions for inputs and links, selection/scroll guards) and a `data-*-ignore-frustration` attribute. They are small, well-tested and independent of transport.
7. **Replay: a full snapshot per view and one segment per view**, segment metadata (`start`, `end`, `records_count`, `index_in_view`, `creation_reason`, raw and compressed sizes) for indexing and debugging, and a "replay is live only after the worker initialised" rule before advertising `has_replay`.
8. **Compression in a worker with a synchronous trailer** so the main thread can close the stream at page exit, served from a Blob URL with a same-origin `workerUrl` override for strict CSP. The size estimate (`length / 8`) avoids double stringifying, which ouo does today.
9. **A benchmark harness** that runs the same app with `none / rum / rum_replay` and records CPU, heap, bytes and vitals, plus per-PR bundle-size reporting. Datadog keeps both non-blocking; ouo already gates size and could gate a CPU delta too.

Not worth copying:

- **The proprietary formats.** NDJSON RUM events, `view` documents with `document_version` and server-side merge, `view_update` diffs, and the Change replay encoding all need a Datadog backend. OTLP logs/spans with resource attributes and a plain rrweb stream keep ouo readable by stock tooling. The string-table idea is still useful if replay bytes become the bottleneck; it can live inside an rrweb-compatible container.
- **64-bit trace ids padded into `traceparent`.** Use full 128-bit W3C ids.
- **Spanless tracing** (ids on resource events, spans synthesised in the backend). OTel-native means real CLIENT spans.
- **Client-side rate limits that silently drop** (3000/min per type) without surfacing it; if ouo limits, it should emit a counter.
- **No offline storage and no `keepalive`.** ouo already does better (IndexedDB parking, keepalive budget).
- **The eager inlined worker string** (23.5 KB raw in every page even when replay is not sampled). Lazy-load the worker with the recorder.
- **Docs that trail the code** (rrweb claim, rage threshold). ouo's appendix O shows the same risk; keep README numbers generated or tested.
