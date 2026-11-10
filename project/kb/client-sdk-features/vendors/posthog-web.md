# PostHog: web SDK feature research

- **Vendor:** PostHog
- **Platform:** web (`posthog-js`, browser package, plus `@posthog/react`, `@posthog/next`, `@posthog/core`, `@posthog/types`)
- **SDK version checked:** `posthog-js@1.447.6` (GitHub release 2026-11-09T23:21Z). Also present: `@posthog/browser@0.1.1` (an experimental rewrite in `packages/browser-next`) and `posthog-js-lite@4.13.3`. Neither was researched in depth.
- **Research date:** 2026-11-10
- **Source key.** `src:` = `https://github.com/PostHog/posthog-js/blob/posthog-js@1.447.6/packages/` + path. Rows that cite `src:` are dated "1.447.6 (2026-11-09)". The docs pages (posthog.com/docs/...) showed no last-updated date, so they are dated "accessed 2026-11-10".
- **Remote config.** There are two remote fetches. Config comes from `GET /array/{token}/config(.js)` on the asset host, and flags from `/flags/?v=2` (`src:browser/src/remote-config.ts`). These remote keys toggle features (`src:browser-common/src/types/remote-config.ts`): `autocapture_opt_out`, `capturePerformance` (web vitals, network timing), `autocaptureExceptions`/`errorTracking` (incl. `suppressionRules`, `captureExtensionExceptions`), `sessionRecording` (sampleRate, minimumDuration, linkedFlag, url/event triggers, triggerGroups, urlBlocklist, masking, networkPayloadCapture, consoleLogRecordingEnabled, canvas fps/quality, recorder script name), `heatmaps`, `captureDeadClicks`, `logs.captureConsoleLogs`, `surveys`, `productTours`, `conversations`, `siteApps`, `supportedCompression`, `analytics.endpoint`, `elementsChainAsString`, `defaultIdentifiedOnly`. In most cases an explicit client option overrides the remote value. Where the client option is unset, the remote value decides.
- **`defaults` date snapshots** (`'2025-05-24'` … `'2026-08-30'`, `'latest'`, `'unset'`) change defaults. Examples: `capture_pageview: 'history_change'` from 2025-05-24 and `rageclick.content_ignorelist` from 2025-11-30 (`src:browser/src/posthog-core.ts` `defaultsThatVaryByConfig`). Defaults listed below are for `unset` unless stated.

## SES sessions

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| SES-a | yes | Automatic. `$session_id` (UUIDv7) plus a per-tab `$window_id` on every event | on | Not used in `cookieless_mode`, where the server assigns the session | src:browser/src/sessionid.ts; https://posthog.com/docs/data/sessions | 1.447.6 (2026-11-09) |
| SES-b | yes | `session_idle_timeout_seconds` | 30 min idle, 24 h max length. No separate "background" timeout | Idle setting clamped to 60 s–10 h. The 24 h max is hard-coded (`SESSION_LENGTH_LIMIT_MILLISECONDS`) | src:browser/src/sessionid.ts L17-20 | 1.447.6 (2026-11-09) |
| SES-c | yes | `persistence` (`localStorage+cookie` default), `cross_subdomain_cookie` (auto: true unless the host is on a public-suffix-like list) | One session shared across tabs in the same browser. window_id lives in sessionStorage | Cross-tab activity sync goes through persisted storage. Opt-in `cookieWinsOnConflict` (defaults ≥2026-08-29) fixes stale-localStorage conflicts across subdomains | src:browser/src/posthog-core.ts defaultConfig; docs/data/sessions | 1.447.6 (2026-11-09) |
| SES-d | partial | `get_session_id()`, `onSessionId(cb)`, `reset()` (new session plus new distinct id), `bootstrap.sessionID`, internal `sessionManager.resetSessionId()` | — | No public "start session" or "end session" without `reset()` | src:browser/src/posthog-core.ts L4183, L3860; sessionid.ts L320-330 | 1.447.6 (2026-11-09) |

## ERR errors and crashes

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| ERR-a | yes | Remote project toggle "exception autocapture", or `capture_exceptions: true\|{capture_unhandled_errors}`. Code is lazy-loaded (`exception-autocapture.js`) | Off unless enabled remotely. Client config overrides remote | Wraps `window.onerror`. Drops exceptions thrown by browser extensions and by the PostHog SDK itself | src:browser/src/extensions/exception-autocapture/index.ts L43-55; https://posthog.com/docs/error-tracking/installation/web | 1.447.6 (2026-11-09) |
| ERR-b | yes | `capture_unhandled_rejections` (same switch as ERR-a) | Same as ERR-a | — | same | 1.447.6 (2026-11-09) |
| ERR-c | yes | `posthog.captureException(error, props)` sends a `$exception` event with `$exception_list` | — | Separate batch key `exceptionEvent`, not truncated | src:browser/src/posthog-core.ts L4532; posthog-exceptions.ts | 1.447.6 (2026-11-09) |
| ERR-d | n/a | mobile only | — | — | — | — |
| ERR-e | n/a | mobile only | — | — | — | — |
| ERR-f | n/a | mobile only | — | — | — | — |
| ERR-g | partial | "Exception steps": manual `posthog.addExceptionStep(msg, props)`, attached as `$exception_steps`. `error_tracking.exception_steps` | enabled, max 32 KB (oldest evicted) | Not auto-collected clicks/nav/console. The surrounding context comes from the event stream and replay instead | src:core/src/error-tracking/exception-steps.ts L30-32; browser/src/posthog-core.ts L4569 | 1.447.6 (2026-11-09) |
| ERR-h | yes | Set `$exception_fingerprint` property at capture. `$issue_name`/`$issue_description` also settable. Server-side grouping rules exist | Server fingerprint from type, message and frames | — | https://posthog.com/docs/error-tracking/fingerprints | accessed 2026-11-10 |
| ERR-i | no | — | — | Linked replay instead (`get_session_replay_url`) | src:browser/src/posthog-core.ts L4220 (no attachment API found) | 1.447.6 (2026-11-09) |
| ERR-j | yes | `capture_exceptions.capture_console_errors` | false | Re-entrancy guarded | src:exception-autocapture/index.ts L47, L113 | 1.447.6 (2026-11-09) |
| ERR-k | yes | Per-exception-type token bucket. `error_tracking.exceptionRateLimiterBucketSize/RefillRate`. Remote `suppressionRules` (type/value matchers) | Burst 10, then 1 per 10 s per type | Also the global event limiter (TRN-f) | src:exception-autocapture/index.ts L27-35; posthog-exceptions.ts L57-94 | 1.447.6 (2026-11-09) |

## PERF performance and vitals

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| PERF-a | partial | Remote toggle "Web vitals autocapture", tuned by `capture_performance.web_vitals*`. Uses Google `web-vitals` (5.x, or 6.x with soft-navs). Event `$web_vitals` | Off until enabled remotely. Metrics LCP, CLS, FCP, INP | **No TTFB** (`SupportedWebVitalsMetrics`). Values >15 min dropped. Batched with a 5 s delayed flush. Sampling only via `before_send` (`sampleByEvent`) | src:types/src/posthog-config.ts L225-300; browser/src/extensions/web-vitals/index.ts; https://posthog.com/docs/web-analytics/web-vitals | 1.447.6 (2026-11-09) |
| PERF-b | yes | `capture_performance.web_vitals_attribution` | INP and LCP attributed. CLS off (memory leak risk) | Attribution bounded to a field subset | CHANGELOG #4598; posthog-config.ts | 1.447.6 (2026-11-09) |
| PERF-c | no | — | — | `longtask` appears only in tests and benchmarks, not in src | gh code search (repo) | accessed 2026-11-10 |
| PERF-d | partial | `capture_performance.network_timing` / remote `capturePerformance`. `navigation` PerformanceEntry recorded **inside replay only** | Follows remote | Not a standalone page-load event or span. Pageleave carries `$prev_pageview_duration` | src:browser/src/extensions/replay/external/config.ts L20-45; page-view.ts | 1.447.6 (2026-11-09) |
| PERF-e | partial | Same as PERF-d. Resource timing for initiatorTypes (img, script, css, fetch, xhr…) in the replay network plugin | Follows remote | Replay only. Unavailable on localhost | src:replay/external/config.ts | 1.447.6 (2026-11-09) |
| PERF-f | n/a | mobile only | — | — | — | — |
| PERF-g | n/a | mobile only | — | — | — | — |
| PERF-h | n/a | mobile only | — | — | — | — |
| PERF-i | no | — | — | No JS self-profiling found in src | src tree at tag | 1.447.6 (2026-11-09) |
| PERF-j | no | — | — | Only `$device_model` (UA-CH) and screen/viewport props | src:browser/src/posthog-core.ts (`disableDeviceModel`) | 1.447.6 (2026-11-09) |
| PERF-k | partial | `posthog.metrics.histogram/count/gauge` (OTLP metrics). No browser span API | — | `core/src/traces` (OTLP spans) exists but the browser core does not expose it | src:browser/src/posthog-metrics.ts; core/src/traces/index.ts | 1.447.6 (2026-11-09) |

## NET network

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| NET-a | partial | (1) Replay network plugin (fetch/XHR plus PerformanceObserver). (2) `metrics.network: true` records fetch/XHR durations as OTel histogram `http.client.request.duration` (semconv attrs, `url.template` with ids → `:id`) | (1) follows remote. (2) off | No per-request analytics events | src:browser/src/extensions/network-metrics.ts; CHANGELOG #4918, #5014 | 1.447.6 (2026-11-09) |
| NET-b | partial | `tracing_headers: ['api.example.com']` patches fetch/XHR to add `X-POSTHOG-DISTINCT-ID` and `X-POSTHOG-SESSION-ID` | off. Exact-hostname allowlist | **No W3C traceparent** from the browser. Correlation goes by session/distinct id. traceparent code exists in core for server SDKs | src:core/src/tracing-headers.ts; browser/src/extensions/tracing-headers.ts | 1.447.6 (2026-11-09) |
| NET-c | yes (opt-in) | Remote `networkPayloadCapture` or `session_recording.recordHeaders/recordBody`. `maskCapturedNetworkRequestFn`. `payloadSizeLimitBytes` | off. Header denylist (authorization, cookie, set-cookie…). Bodies with "password" redacted | 1 MB per payload. Client `false` overrides remote. Disabled on localhost | src:replay/external/config.ts L13-160 | 1.447.6 (2026-11-09) |
| NET-d | no | — | — | No GraphQL handling in browser src | gh code search | accessed 2026-11-10 |
| NET-e | no | — | — | Failed requests appear in replay and network metrics (`error.type`), not as errors | src:network-metrics.ts | 1.447.6 (2026-11-09) |
| NET-f | no | — | — | No WebSocket capture in browser src | gh code search | accessed 2026-11-10 |

## INT interactions

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| INT-a | yes | `autocapture: true\|{dom_event_allowlist, element_allowlist, css_selector_allowlist/ignorelist, url_allowlist/ignorelist}`. Remote `autocapture_opt_out` | on. Event `$autocapture` | `ph-no-capture` class excludes. Clicks on cursor:pointer elements captured | src:browser-common/src/utils/autocapture-utils.ts L445-560 | 1.447.6 (2026-11-09) |
| INT-b | yes | `$el_text`, `elements_chain` (tag, classes, id, attrs, nth-child), aria-label fallback, `data-ph-capture-attribute-*` custom props | — | Text scrubbed if it looks like a card number or SSN. `mask_all_text`, `mask_all_element_attributes` | src:autocapture-utils.ts L72-79, L278-295 | 1.447.6 (2026-11-09) |
| INT-c | yes | `rageclick: true\|{threshold_px, click_count, timeout_ms, css_selector_ignorelist, content_ignorelist}`. Event `$rageclick` | 3 clicks within 30 px, each within 1000 ms of the previous (found in review: the window is per gap, not total). Ignores `.ph-no-rageclick` | Defaults ≥2025-11-30 ignore content keywords | src:browser-common/src/rageclick.ts L8-10; posthog-config.ts L150-185 | 1.447.6 (2026-11-09) |
| INT-d | yes | Remote `captureDeadClicks` or `capture_dead_clicks: {scroll_threshold_ms, mutation_threshold_ms, selection_change_threshold_ms, capture_dead_swipes…}`. Lazy-loaded. Events `$dead_click`, `$dead_swipe` | Off unless remote. Mutation 2500 ms, scroll 100 ms, selection 100 ms. Dead swipes on, 30 px, max 10 per page load | Anchors are not dead clicks | src:browser/src/entrypoints/dead-clicks-autocapture.ts L99-175 | 1.447.6 (2026-11-09) |
| INT-e | no | — | — | No "error click" event found. Errors and clicks are linked only via the session | src tree at tag | 1.447.6 (2026-11-09) |
| INT-f | partial | Scroll depth on pageview/pageleave (`$prev_pageview_max_scroll(_percentage)`, content %). `scroll_root_selector`. Dead swipes. Heatmap scroll | on with pageleave | No generic gesture events | src:browser/src/page-view.ts L10-19 | 1.447.6 (2026-11-09) |
| INT-g | yes | Autocapture `change` and `submit`. Values only from fields matching `capture_value_css_selector_allowlist` | `['[data-ph-capture-value]']`. Password/hidden/sensitive-name fields never captured | `capture_copied_text` for copy/cut/paste (off) | src:types/src/posthog-config.ts L98-112; autocapture-utils.ts L509-590 | 1.447.6 (2026-11-09) |
| INT-h | yes | Remote `heatmaps` or `capture_heatmaps: true\|{flush_interval_milliseconds}`. Event `$$heatmap` | Off unless remote. 5 s flush | Click coordinates plus scroll. Viewer in toolbar/app | src:browser/src/heatmaps.ts L22, L96-142 | 1.447.6 (2026-11-09) |

## NAV navigation

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| NAV-a | yes | `capture_pageview`. Events `$pageview` and `$pageleave` (`capture_pageleave: 'if_capture_pageview'`) | true | `$pageview_id`, `$prev_pageview_*` duration/scroll | src:posthog-core.ts defaultConfig; page-view.ts | 1.447.6 (2026-11-09) |
| NAV-b | yes | `capture_pageview: 'history_change'` patches pushState/replaceState plus popstate | `'history_change'` only with `defaults ≥ 2025-05-24`. Otherwise manual | `disable_capture_url_hashes` (≥2026-06-25) | src:browser/src/extensions/history-autocapture.ts L72-106 | 1.447.6 (2026-11-09) |
| NAV-c | n/a | mobile only | — | — | — | — |
| NAV-d | n/a | RN only | — | — | — | — |
| NAV-e | yes | `posthog.capture('$pageview', {...})`. `get_current_url` override hook | — | No separate "view name" concept beyond URL/props | src:types/src/posthog-config.ts (`get_current_url`) | 1.447.6 (2026-11-09) |
| NAV-f | n/a | mobile concept. Web uses visibilitychange/pagehide for unload flush | — | — | src:posthog-core.ts L5194 | 1.447.6 (2026-11-09) |

## RPL replay

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| RPL-a | yes | rrweb (PostHog fork vendored in `packages/rrweb`). Recorder lazy-loaded. Starts only after remote config arrives | Off unless enabled in project. `disable_session_recording` client kill | Waits for local plus remote config | src:browser/src/extensions/replay/session-recording.ts L141-206 | 1.447.6 (2026-11-09) |
| RPL-b | n/a | mobile only | — | — | — | — |
| RPL-c | yes | Remote sampleRate, minimumDuration, linkedFlag, URL/event triggers (incl. `$exception`), triggerGroups (any/all), urlBlocklist. `startSessionRecording({sampling,linked_flag,url_trigger,event_trigger})` overrides | Whole session if enabled. While a trigger is pending, a full snapshot is taken every 1 min and only the latest is kept | Pre-trigger buffer ≈1 min, lost on full page refresh. Sampling decision is stored per session | src:replay/external/recording-strategies.ts; lazy-loaded-session-recorder.ts L1015-1018; https://posthog.com/docs/session-replay/how-to-control-which-sessions-you-record | 1.447.6 (2026-11-09) |
| RPL-d | partial | Canvas: remote toggle or `session_recording.captureCanvas`/`canvasCapture` (fps 0-12, quality 0-1, `maskRegionsFn`). 2D and WebGL. `recordCrossOriginIframes` | Canvas off (4 fps / 0.4 when on). Cross-origin iframes off | Shadow DOM: uncertain. Not stated in PostHog docs (rrweb records open shadow roots by default) | src:lazy-loaded-session-recorder.ts L103, L2836; https://posthog.com/docs/session-replay/canvas-recording | 1.447.6 (2026-11-09) |
| RPL-e | yes | See NET-c. Timing via `capturePerformance`/`network_timing`. Bodies opt-in | Timing per remote. Headers/bodies off | 1 MB per body. PostHog's own `/e/ /s/ /i/` excluded. Off on localhost | src:replay/external/config.ts | 1.447.6 (2026-11-09) |
| RPL-f | yes | Remote `consoleLogRecordingEnabled` or `enable_recording_console_log`. rrweb console plugin | Follows remote (client undefined) | — | src:lazy-loaded-session-recorder.ts L806-843 | 1.447.6 (2026-11-09) |
| RPL-g | yes | Classes `ph-no-capture` (block), `ph-mask` (mask text), `ph-ignore-input`. `maskTextSelector`, `blockSelector`, `maskTextFn`, `maskInputFn`, `maskAllElementAttributes`. Remote masking settings | `maskAllInputs: true`. Text not masked. Images not masked | A client value that disagrees with the remote value shadows it (warns) | src:lazy-loaded-session-recorder.ts L2810-2836, L680-760; https://posthog.com/docs/session-replay/privacy | 1.447.6 (2026-11-09) |
| RPL-h | n/a | RN only | — | — | — | — |
| RPL-i | n/a | mobile only | — | — | — | — |
| RPL-j | yes | `session_idle_threshold_ms`, `full_snapshot_interval_millis`. Mutation throttler | Idle after 5 min (pauses). Full snapshot every 5 min. Flush buffer every 2 s. Max ~0.9 MB per batch. Mutation bucket 100, refill 10 | Recording ends with the session (24 h max). Idle rotation holds the upload until interaction | src:lazy-loaded-session-recorder.ts L112-136, L1021; mutation-throttler.ts L41-42; Replay.spec.md | 1.447.6 (2026-11-09) |

## USR user and attributes

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| USR-a | yes | `identify(distinctId, $set, $set_once)` | anonymous UUIDv7 distinct id | — | src:posthog-core.ts L3340 | 1.447.6 (2026-11-09) |
| USR-b | yes | `setPersonProperties`, `unsetPersonProperties`, `group()` for group analytics | `person_profiles: 'identified_only'` | Anonymous events create no person profile by default | src:posthog-core.ts L3526-3697 | 1.447.6 (2026-11-09) |
| USR-c | yes | `register`, `register_once`, `register_for_session`, `unregister` (super properties) | — | Persisted in cookie/localStorage | src:posthog-core.ts L2456-2579 | 1.447.6 (2026-11-09) |
| USR-d | yes | Anonymous distinct id plus `$device_id`. `get_device_id` hook. `bootstrap`. `cookieless_mode` (server-side hash) | Persisted 365 days (`cookie_expiration`) | — | src:posthog-core.ts defaultConfig | 1.447.6 (2026-11-09) |
| USR-e | yes | `identify` merges anon → known via `$anon_distinct_id`. `alias()`. `reuseAnonymousId` disables the merge. `reset()` on logout | merge on | — | src:types/src/posthog-config.ts (reuseAnonymousId); posthog-core.ts L4269 | 1.447.6 (2026-11-09) |

## LOG logs

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| LOG-a | yes | `posthog.logger.info/warn/error…` and `posthog.captureLog({body, level, attributes, trace_id, span_id})`. `logs: {serviceName, environment, serviceVersion, resourceAttributes, beforeSend}` | flush 3 s, buffer 100, max 1000 per interval | Calls before logs setup are dropped. distinct_id and session_id attached | src:browser-common/src/logs-config.ts L16-20; https://posthog.com/docs/logs/installation/javascript | 1.447.6 (2026-11-09) |
| LOG-b | yes | `logs.captureConsoleLogs` or remote "Capture console logs". service.name `posthog-browser-logs`, scope `console` | off | Startup calls buffered up to 30 s. Queue 2048. No rate cap | src:browser-common/src/logs.ts L29-33; logs-config.ts | 1.447.6 (2026-11-09) |
| LOG-c | yes | Wire format is OTLP/JSON to `/i/v1/logs`, with OTel resource attributes (`service.name`, `telemetry.sdk.*`) | — | Whether the OTel JS SDK exporter can target PostHog is not stated on the logs page (uncertain) | src:browser-common/src/logs.ts L638 | 1.447.6 (2026-11-09) |

## SMP sampling

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| SMP-a | partial | Replay: remote sampleRate / triggerGroup sampleRate. Analytics events: none built-in, `before_send` + `sampleByEvent/sampleBySessionId` customizations | 100% | Replay sample is a session-id hash | src:browser/src/customizations/before-send.ts; docs (RPL-c) | 1.447.6 (2026-11-09) |
| SMP-b | no | — | — | No tracing in browser. Web vitals via `before_send` sampling | docs/web-analytics/web-vitals | accessed 2026-11-10 |
| SMP-c | partial | No sample rate. Rate limiter plus suppression rules (ERR-k) | — | — | src:posthog-exceptions.ts | 1.447.6 (2026-11-09) |
| SMP-d | partial | Event trigger on `$exception` with pre-trigger buffer | — | Buffer ≈1 min (one full snapshot) | RPL-c sources | accessed 2026-11-10 |
| SMP-e | yes | Errors are ordinary events and independent of replay sampling | — | — | src:posthog-exceptions.ts | 1.447.6 (2026-11-09) |
| SMP-f | yes | Remote config toggles most features (see header). Flags refresh `remote_config_refresh_interval_ms` | Flags every 5 min (backs off to 1 h when idle) | "Does not reload remote config" (config fetched per page load) | src:types/src/posthog-config.ts L2300-2321 | 1.447.6 (2026-11-09) |

## PRV privacy

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| PRV-a | yes | `opt_in_capturing()`, `opt_out_capturing()`, `get_explicit_consent_status()` → granted/denied/pending, `opt_out_capturing_by_default`, `cookieless_mode: 'always'\|'on_reject'`, `consent_persistence_name` | Captures while pending unless `opt_out_capturing_by_default` | Consent is synced across tabs. Cookieless requires a project setting | src:posthog-core.ts L4914-5168, L579; https://posthog.com/docs/libraries/js/config | 1.447.6 (2026-11-09) |
| PRV-b | yes | `mask_all_text`, `mask_all_element_attributes`. Sensitive-value regex for card numbers and SSNs | false / false | — | src:posthog-core.ts defaultConfig; autocapture-utils.ts | 1.447.6 (2026-11-09) |
| PRV-c | yes | `ph-no-capture`, `ph-sensitive`, `ph-mask`, `ph-ignore-input`, `ph-no-rageclick`, `ph-no-deadclick`, `data-ph-capture-value` | — | — | src:autocapture-utils.ts L300-319, L541 | 1.447.6 (2026-11-09) |
| PRV-d | yes | `mask_personal_data_properties` (gclid, fbclid… stripped from URL), `custom_personal_data_properties`, `property_denylist`, `disable_capture_url_hashes` | off | — | src:types/src/posthog-config.ts L2085-2110 | 1.447.6 (2026-11-09) |
| PRV-e | partial | IP via project setting "Discard IP data". `ip` option deprecated, no effect. GeoIP enrichment is server-side | Server keeps IP unless the setting is on | — | src:posthog-core.ts L1135-1139 | 1.447.6 (2026-11-09) |
| PRV-f | yes | `before_send` (fn or array, return null to drop). `sanitize_properties`. `logs.beforeSend`, `metrics.beforeSend` | none | — | src:types/src/posthog-config.ts | 1.447.6 (2026-11-09) |
| PRV-g | yes | `respect_dnt`, `opt_out_*`, bot UA filter (`opt_out_useragent_filter`, `custom_blocked_useragents`) | DNT ignored. Bots dropped | — | src:posthog-core.ts L1820, defaultConfig | 1.447.6 (2026-11-09) |

## TRN offline and transport

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| TRN-a | yes | `request_batching`, `request_queue_config.flush_interval_ms`. Batched per endpoint/batchKey | true, 3000 ms | Interval clamped 250–5000 ms. No size-based flush | src:browser/src/request-queue.ts L7-30 | 1.447.6 (2026-11-09) |
| TRN-b | partial | In-memory retry queue with online/offline listeners | 10 retries (3 for status 0), exponential backoff from 3 s with jitter, cap 30 min | **Not persisted**: lost on page close. Replay pending buffer has its own storage key | src:browser/src/retry-queue.ts L11-30 | 1.447.6 (2026-11-09) |
| TRN-c | yes | On unload, queue flushed via `sendBeacon` (events before recordings). fetch keepalive tracked against a 64 KiB budget | on | Beacon falls back to base64 form body | src:request-queue.ts L42-55; request.ts L55-58, L160-170 | 1.447.6 (2026-11-09) |
| TRN-d | yes | gzip (fflate sync or native CompressionStream), base64 fallback. Server advertises `supportedCompression`. `disable_compression` | gzip when supported | — | src:browser/src/request.ts L132-230 | 1.447.6 (2026-11-09) |
| TRN-e | yes | `api_host` (reverse proxy), `ui_host`, `flags_api_host`, `asset_host`, `rewriteRequestPath` (≥1.416.0), `request_headers` | `https://us.i.posthog.com` | PostHog docs recommend a proxy against ad blockers | https://posthog.com/docs/libraries/js/config; src:utils/request-router.ts | accessed 2026-11-10 |
| TRN-f | yes | Client token bucket `rate_limiting.{events_per_second, events_burst_limit}`. Server `quota_limited` per product. `Retry-After` honoured | 10/s, burst 100 | Sends `$$client_ingestion_warning` on drop | src:browser/src/rate-limiter.ts L10-165 | 1.447.6 (2026-11-09) |
| TRN-g | partial | Vendor JSON events to `/e/` (`/s/` replay). **Logs and metrics are OTLP/JSON** (`/i/v1/logs`, `/i/v1/metrics`) | — | — | src:request-router.ts L22; posthog-metrics.ts L10 | 1.447.6 (2026-11-09) |

## CFG configuration

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| CFG-a | yes | `posthog.init(token, {…}, name?)`. Single config object. `defaults: '<date>'` snapshot. `set_config` at runtime. Named multi-instances | — | — | src:posthog-core.ts L817-907 | 1.447.6 (2026-11-09) |
| CFG-b | yes | `autocapture`, `capture_pageview`, `capture_exceptions`, `capture_performance`, `capture_heatmaps`, `capture_dead_clicks`, `disable_session_recording`, `disable_surveys`, `disable_product_tours`, `disable_conversations`, `disable_web_experiments`, `advanced_disable_flags`… | Many follow remote | — | src:posthog-core.ts defaultConfig | 1.447.6 (2026-11-09) |
| CFG-c | yes | `debug` or `?__posthog_debug=true`. `$$client_ingestion_warning` for rate-limit drops. Replay debug props | off | No general dropped-data client report | src:posthog-core.ts defaultConfig; rate-limiter.ts | 1.447.6 (2026-11-09) |
| CFG-d | partial | No init `release`/`environment` for events. `$release_id` injected by `posthog-cli sourcemap inject`. Logs/metrics take `environment`, `serviceVersion` | — | App version via `register()` | src:posthog-exceptions.ts (`getInjectedReleaseId`); logs-config | 1.447.6 (2026-11-09) |
| CFG-e | yes | npm `posthog-js` or HTML snippet (`array.js` from CDN). Bundles: full, slim, no-external. Lazy-loaded extensions from `asset_host` (recorder, surveys, exception-autocapture, web-vitals, dead-clicks, tracing-headers). `disable_external_dependency_loading`, `strict_script_versioning` | Lazy | Lazy loading requires CSP allowance for the asset host | src:browser/src/entrypoints/*; posthog-core.ts defaultConfig | 1.447.6 (2026-11-09) |
| CFG-f | partial | SSR: guarded globals (`assignableWindow`), `@posthog/next` providers. Extensions: no-external bundle plus `disable_external_dependency_loading`. Multiple named instances | — | Web workers: uncertain (no worker entrypoint seen) | src:browser/src/utils/globals.ts; packages/next | 1.447.6 (2026-11-09) |

## API manual instrumentation

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| API-a | yes | `posthog.capture(name, props, {$set, $set_once, send_instantly, timestamp})` | — | String props truncated at 65535 chars | src:posthog-core.ts L1790; defaultConfig | 1.447.6 (2026-11-09) |
| API-b | yes | `posthog.metrics.count/gauge/histogram(name, v, {unit, bounds, attributes})`, pre-aggregated statsd-style | flush per `metrics.flushIntervalMs` | `maxSeriesPerFlush`. Alpha | src:browser/src/posthog-metrics.ts; CHANGELOG #4115, #5580 | 1.447.6 (2026-11-09) |
| API-c | no | — | — | Browser exposes no span API (core traces used by server SDKs) | src:browser/src/posthog-core.ts (no traces ext) | 1.447.6 (2026-11-09) |
| API-d | partial | `register_for_session`, page-level props via `register`. No "current view" scope | — | — | src:posthog-core.ts L2529 | 1.447.6 (2026-11-09) |
| API-e | partial | OTLP out for logs and metrics. `captureLog` accepts trace_id/span_id. No OTel API in. No traceparent propagation. `@posthog/next` has an OTel span processor (server side) | — | — | src:next/src/otel.ts; logs | 1.447.6 (2026-11-09) |

## SYM source maps and symbolication

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| SYM-a | yes | `posthog-cli sourcemap inject` + `upload`. Chunk ids `globalThis._posthogChunkIds`. Also reads TC39-style `_debugIds` | — | Injected assets must be the ones served | src:core/src/error-tracking/chunk-ids.ts; https://posthog.com/docs/error-tracking/upload-source-maps/cli | 1.447.6 (2026-11-09) |
| SYM-b | n/a | iOS | — | — | — | — |
| SYM-c | n/a | Android | — | — | — | — |
| SYM-d | n/a | RN | — | — | — | — |
| SYM-e | yes | CLI, `@posthog/webpack-plugin`, `@posthog/rollup-plugin` (Vite), `@posthog/nextjs-config`, GitHub Action, `npx @posthog/wizard` | — | — | packages list at tag; https://posthog.com/docs/error-tracking/upload-source-maps | accessed 2026-11-10 |

## FWK framework integrations

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| FWK-a | yes | `@posthog/react`: `PostHogProvider`, `PostHogErrorBoundary` (with component stack), flag hooks, `PostHogFeature`, `PostHogCaptureOnViewed` | — | No router or profiler integration found | src:react/src/components/*, hooks/* | 1.447.6 (2026-11-09) |
| FWK-b | yes | `@posthog/next` (App and Pages providers, `PostHogPageView`, middleware, edge, OTel span context). `@posthog/nuxt` | — | — | src:next/src/* | 1.447.6 (2026-11-09) |
| FWK-c | partial | `@posthog/nuxt`. Vue, Angular and Svelte have doc guides only (no package in repo) | — | — | packages list at tag | 1.447.6 (2026-11-09) |
| FWK-d | n/a | mobile | — | — | — | — |
| FWK-e | n/a | mobile | — | — | — | — |
| FWK-f | n/a | separate `posthog-react-native` package | — | — | — | — |
| FWK-g | n/a | other SDKs exist (separate repos) | — | — | — | — |

## REL release and versioning

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| REL-a | partial | `$release_id` from CLI inject or GitHub Action. `$lib_version` auto | — | No init option | src:posthog-exceptions.ts; web search of posthog.com link-releases docs | accessed 2026-11-10 |
| REL-b | uncertain | No crash-free metric in SDK. Session health would be server-side | — | Not seen in docs fetched | — | accessed 2026-11-10 |
| REL-c | partial | CLI resolves repo and commit for the release | — | Suspect-commit feature not confirmed | posthog.com link-releases docs (search result) | accessed 2026-11-10 |
| REL-d | uncertain | Not seen | — | — | — | accessed 2026-11-10 |

## FF feature flags

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| FF-a | yes | Every event (incl. `$exception`) carries `$active_feature_flags` and `$feature/<key>`. `$feature_flag_called` on read. Replay can be gated by a linked flag | on | — | src:browser-common/src/feature-flags.ts L648-670 | 1.447.6 (2026-11-09) |
| FF-b | yes | `isFeatureEnabled`, `getFeatureFlag`, payloads, `onFeatureFlags`, `bootstrap`, person/group props for flags, `evaluation_contexts` | `/flags` on init. Timeout 3 s, 1 retry. Refresh every 5 min | — | src:posthog-core.ts defaultConfig, L2655-3006 | 1.447.6 (2026-11-09) |
| FF-c | yes | `@posthog/openfeature-web-provider` | — | — | packages list at tag | 1.447.6 (2026-11-09) |

## FB user feedback

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| FB-a | yes | Surveys (popover / feedback-button widget types) rendered by SDK. Also "Conversations" support chat widget | Surveys enabled (`disable_surveys: false`), served via remote config | Lazy-loaded `surveys.js` | src:browser-common/src/types/surveys.ts; posthog-conversations.ts | 1.447.6 (2026-11-09) |
| FB-b | yes | `getActiveMatchingSurveys`, `renderSurvey`, `displaySurvey`, API mode (capture `survey sent` yourself). `captureTraceFeedback` (LLM) | — | — | src:posthog-core.ts L3031-3271, L5355 | 1.447.6 (2026-11-09) |
| FB-c | no | — | — | No screenshot field found in survey types | src:browser-common/src/types/surveys.ts | 1.447.6 (2026-11-09) |

## OTH other

| ID | Has | How configured | Default | Limits | Source | Date |
|---|---|---|---|---|---|---|
| OTH-a | yes | Autocapture, pageview/pageleave, UTM/referrer (`save_campaign_params`, `save_referrer`), funnels server-side | on | — | src:posthog-core.ts defaultConfig | 1.447.6 (2026-11-09) |
| OTH-b | yes | Experiments via flags. No-code web experiments (`disable_web_experiments`) | Web experiments disabled (beta) | — | src:posthog-core.ts defaultConfig; web-experiments.ts | 1.447.6 (2026-11-09) |
| OTH-c | yes | Surveys (see FB-a) | on | — | src:browser-surveys.ts | 1.447.6 (2026-11-09) |
| OTH-d | partial | Detects in-app webviews (Instagram, FB, TikTok, WeChat…) from the UA | — | No native bridge for web→native session linking on web side (uncertain) | src:core/src/utils/webview-app-utils.ts | 1.447.6 (2026-11-09) |
| OTH-e | no | — | — | Not seen | — | accessed 2026-11-10 |
| OTH-f | yes | `segment` integration, Sentry integration (`$sentry_*` props), Intercom/Crisp `integrations`, site apps (`opt_in_site_apps`) | — | — | src:extensions/segment-integration.ts, sentry-integration.ts, entrypoints/*-integration.ts | 1.447.6 (2026-11-09) |
| OTH-g | yes | Toolbar, product tours, web MCP capture (`capture_webmcp`), LLM trace feedback/metrics | — | — | src:extensions/toolbar.ts, webmcp.ts, posthog-product-tours.ts | 1.447.6 (2026-11-09) |
| OTH-x1 | yes | `defaults: '<date>'` config snapshots: opt into new default behaviour without breaking old installs | `'unset'` | 7 dated snapshots plus `latest` | src:types/src/posthog-config.ts L489-503 | 1.447.6 (2026-11-09) |
| OTH-x2 | yes | Bot detection: `$browser_type: 'bot'`, bot events dropped by default | on | — | src:posthog-core.ts L1820, L2295 | 1.447.6 (2026-11-09) |
| OTH-x3 | yes | `get_session_replay_url()` to link a replay from other tools | — | — | src:posthog-core.ts L4220 | 1.447.6 (2026-11-09) |
| OTH-h | yes | Bot user agents detected (`$browser_type: 'bot'`); `opt_out_useragent_filter`, `custom_blocked_useragents` (see OTH-x2, PRV-g) | bot events dropped | Added in review from OTH-x2 | src:posthog-core.ts L1820, L2295 | 1.447.6 (2026-11-09) |

## Notable

1. **Server-side remote config controls most features.** Replay, exception autocapture, web vitals, heatmaps, dead clicks, console logs, masking, network payloads and sampling are all off in the SDK until the project config (`/array/{token}/config`) turns them on. Client options usually override the remote value. The replay recorder will not start before remote config arrives.
2. **`defaults: '<date>'` snapshots** let PostHog change defaults (SPA pageviews, rage-click ignore lists, canvas, network body streaming) without breaking existing installs. The pattern is worth copying for versioned defaults.
3. **Lazy-loaded extensions.** The core is small, and the recorder, error wrapping, web vitals, dead clicks and surveys load from the asset host on demand. That needs CSP and proxy care, so they also ship "no-external" bundles for extensions and strict CSP.
4. **Sessions:** 30 min idle (clamped 1 min–10 h) and a 24 h hard cap. Shared across tabs through localStorage+cookie, with a per-tab `$window_id`. An idle rotation holds replay upload until the visitor interacts.
5. **Web vitals cover only LCP, INP, CLS and FCP. There is no TTFB.** They are batched into one `$web_vitals` event after 5 s and dropped above 15 min. Attribution is on for INP and LCP and off for CLS because of memory leaks. A soft-navigation mode is in preview.
6. **No browser tracing.** There is no span API and no W3C traceparent. Backend correlation uses `X-POSTHOG-SESSION-ID`/`X-POSTHOG-DISTINCT-ID` headers on an exact-hostname allowlist. Logs and metrics, however, are already OTLP/JSON with OTel resource attributes and HTTP semconv.
7. **No offline persistence.** The retry queue is in-memory (10 retries, jittered backoff to 30 min). The unload path uses sendBeacon and puts events ahead of recordings, and the fetch keepalive is tracked against the 64 KiB budget.
8. **Errors:** per-type token bucket (10 burst, 1 per 10 s), remote suppression rules, and drops for extension and SDK-originated stacks. Breadcrumbs are manual (`addExceptionStep`, 32 KB ring). Grouping can be overridden with `$exception_fingerprint`. Symbolication uses CLI-injected chunk ids and also reads native `_debugIds`.
9. **Privacy defaults:** replay masks all inputs but not text. Autocapture never sends input values except fields opted in via `data-ph-capture-value`, and it scrubs card- and SSN-like text. The `ip` option is a no-op, because IP discard is a project setting. A consent API with pending/granted/denied and a cookieless mode exist.
10. **Interaction signals are explicit and tunable:** rage click (3 clicks / 1 s / 30 px), dead click (mutation 2.5 s, scroll and selection 100 ms) plus dead swipes on touch, and heatmaps. Each has opt-out CSS classes (`ph-no-rageclick`, `ph-no-deadclick`, `ph-no-capture`).
