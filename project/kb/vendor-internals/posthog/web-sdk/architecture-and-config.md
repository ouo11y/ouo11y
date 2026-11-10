# PostHog web SDK (posthog-js): architecture, configuration, sampling

- **SDK:** `posthog-js@1.447.6` (npm, published 2026-11-09). Source at tag `posthog-js@1.447.6`.
- **Research date:** 2026-11-10.
- **Builds on:** [Step 4 posthog-web.md](../../../client-sdk-features/vendors/posthog-web.md), which lists features per catalog row. This file goes deeper: how the SDK is put together, every RUM-relevant option, and how sampling decides.
- **Source key:** `pj:` = `https://github.com/PostHog/posthog-js/blob/posthog-js@1.447.6/packages/` + path. "observed" = seen in our capture (`examples/posthog-capture`, fixtures in [../wire-format/fixtures/](../wire-format/fixtures/)).

## 1. Architecture

### Core plus lazy extensions

The core bundle (`array.js` from the CDN snippet, or `module.js` from npm) holds capture, persistence, sessions, the request queue, autocapture, heatmaps, rage clicks and pageviews. Heavier features load later as separate scripts.

- **Loader:** `__PosthogExtensions__.loadExternalDependency(posthog, kind, cb)` injects a `<script>` tag (pj:browser/src/entrypoints/external-scripts-loader.ts L141-175).
- **URL:** `{asset_host or api_host}/static/{version}/{kind}.js` when `strict_script_versioning` is on (the default is `'fallback'`, pj:browser/src/posthog-core.ts L352). Otherwise `/static/{kind}.js?v={version}` (external-scripts-loader.ts L127, L158).
- **Kinds** (pj:browser/src/utils/globals.ts L206-222): `recorder`, `lazy-recorder`, `exception-autocapture`, `web-vitals`, `web-vitals-with-attribution`, `web-vitals-soft-navs`, `web-vitals-with-attribution-soft-navs`, `dead-clicks-autocapture`, `tracing-headers`, `surveys`, `logs`, `conversations`, `product-tours`, `toolbar`, `remote-config`.
- **Observed load order** in our demo, with every RUM feature on:
  1. `web-vitals-with-attribution.js`, `exception-autocapture.js` and `dead-clicks-autocapture.js` load at init, before remote config arrives, because the client config asked for them.
  2. `surveys.js`, `logs.js` and `lazy-recorder.js` load after remote config.
  3. `surveys.js` loaded even though our mock config said `surveys: false`. `disable_surveys` defaults to false.
- **No-CDN option:** the `*.no-external` bundles and `disable_external_dependency_loading: true` let a site avoid runtime script loading. Features then need the full bundle (`module.full.no-external.js`, 233 KB gzip; see [observed-capture.md](observed-capture.md)).

### Remote config and flags (two separate fetches)

The SDK has no single `/decide` call any more.

| Fetch | When | Shape | Source |
|---|---|---|---|
| `GET {asset}/array/{token}/config.js` | First. A script that sets `window._POSTHOG_REMOTE_CONFIG[token]` (it can also carry site apps) | JS | pj:browser/src/remote-config.ts L17-24, L49-62 |
| `GET {asset}/array/{token}/config` | Fallback when the JS variant fails. Observed: our server 404'd `config.js` and the SDK then fetched the JSON | JSON `RemoteConfig` | remote-config.ts L26-33, L52-57 |
| `POST {flags_api_host or api_host}/flags/?v=2` | After config, unless `hasFeatureFlags === false` or `advanced_disable_feature_flags_on_first_load`. Again after `identify()` (observed: 2 calls) | gzip JSON `{token, distinct_id, groups, person_properties, timezone, $device_id, $anon_distinct_id?}` | remote-config.ts L95-101; fixture `web-flags-v2.json` |

The `RemoteConfig` type (pj:browser-common/src/types/remote-config.ts L136-211) holds the server-side switches. The ones relevant to RUM:

- `supportedCompression` and `analytics.endpoint` (observed `/i/v0/e/`)
- `autocapture_opt_out`
- `capturePerformance` (`{network_timing, web_vitals, web_vitals_allowed_metrics}`)
- `autocaptureExceptions` and `errorTracking.{autocaptureExceptions, suppressionRules}`
- `logs.captureConsoleLogs`
- `heatmaps`, `captureDeadClicks`
- `sessionRecording` (or `false`), with `endpoint`, `sampleRate` (a string), `minimumDurationMilliseconds`, `linkedFlag`, `urlTriggers`, `urlBlocklist`, `eventTriggers`, `triggerMatchType`, `triggerGroups` (v2), `networkPayloadCapture`, `masking`, `consoleLogRecordingEnabled`, and canvas settings
- `quotaLimited`

The server builds this object in PostHog's `posthog/models/remote_config.py` (see [../storage/storage-and-ingestion.md](../storage/storage-and-ingestion.md#remote-config-built-server-side)).

**Client overrides remote.** Most features take the client value when it is set and fall back to remote when it is `undefined`. For example, `enable_recording_console_log: undefined` means "use the server setting" (posthog-core.ts L353). Before remote config arrives, the first `$pageview` went to `/e/`. After it arrived, events went to `/i/v0/e/` (observed: fixtures `web-e-pageview.json` and `web-i-v0-e-batch.json`).

### Request path

`capture()` → `before_send` → client rate limiter → `RequestQueue` (batched per URL and `batchKey`, flushed every 3 s) → `request()` (gzip, then fetch, XHR or sendBeacon) → on failure, `RetryQueue`. Details are in [../reliability/delivery-and-retries.md](../reliability/delivery-and-retries.md). Replay chunks use `batchKey: 'recordings'` and the `/s/` endpoint, skip client rate limiting, and are never truncated (pj:browser/src/extensions/replay/external/lazy-loaded-session-recorder.ts L2544-2552).

## 2. Init options relevant to RUM

Defaults are for `defaults: 'unset'` unless a row says otherwise (pj:browser/src/posthog-core.ts `defaultConfig` L317-404 and `defaultsThatVaryByConfig` L282-312). Option types are in pj:types/src/posthog-config.ts.

### Transport and identity

| Option | Default | Effect | Source |
|---|---|---|---|
| `api_host` | `https://us.i.posthog.com` | Ingestion host. Our demo uses the page origin. `app.posthog.com` is rewritten to `us.i.posthog.com` | posthog-core.ts L318; utils/request-router.ts L37-43 |
| `flags_api_host`, `ui_host`, `asset_host` | null | Separate hosts for flags, the toolbar UI and extension scripts | L319-321 |
| `defaults` | `'unset'` | Date snapshot that changes several defaults (rows below) | L334 |
| `request_batching` | true | Queue and batch. `false` sends each event immediately | L367 |
| `request_queue_config.flush_interval_ms` | 3000 | Batch flush interval, clamped to 250–5000 ms | L397; request-queue.ts L7, L24-30 |
| `disable_compression` | false | Without it the SDK sends gzip once the server lists `gzip-js` | L392, L913, L1379-1391 |
| `rate_limiting.{events_per_second, events_burst_limit}` | 10/s, burst 100 | Client token bucket. Drops send `$$client_ingestion_warning` | rate-limiter.ts L10-13 |
| `request_headers` | `{}` | Extra headers on SDK requests | L366 |
| `persistence` | `'localStorage+cookie'` | Where distinct id, super properties and session live. Options: `cookie`, `localStorage`, `sessionStorage`, `memory` | L325 |
| `cookie_expiration` | 365 (days) | Lifetime of the persistence cookie | L340 |
| `cross_subdomain_cookie` | auto | Share one identity across subdomains | L324 |
| `person_profiles` | `'identified_only'` | Anonymous events get `$process_person_profile: false` | L394 |
| `session_idle_timeout_seconds` | 1800 | Session ends after this much idle time, clamped 60 s–10 h. Sessions have a hard 24 h maximum | L393; sessionid.ts L18-20 |
| `opt_out_useragent_filter` | false | false means bot user agents are dropped. **"HeadlessChrome" is on the list.** Our headless demo got no events until the driver overrode the UA (observed) | L358 |
| `before_send` | undefined | A function or array of functions. Return null to drop the event | L395 |

### Autocapture, navigation and interactions

| Option | Default | Effect | Source |
|---|---|---|---|
| `autocapture` | true | Click, change and submit become `$autocapture` with `$elements_chain`. Can also be an object with allowlists | L323 |
| `capture_pageview` | true; `'history_change'` with defaults ≥ 2025-05-24 | Sends `$pageview`. `history_change` also patches pushState and replaceState | L303 |
| `capture_pageleave` | `'if_capture_pageview'` | Sends `$pageleave` on pagehide | L333, L4765-4770 |
| `rageclick` | true; adds a content ignorelist from 2025-11-30 | Sends `$rageclick` | L297-302 |
| `capture_dead_clicks` | remote | Sends `$dead_click` (lazy extension) | Step 4 INT-d |
| `capture_heatmaps` | remote | Sends `$$heatmap` with `$heatmap_data` click, mousemove and rageclick coordinates per URL (observed) | fixture `web-i-v0-e-batch.json` |
| `mask_all_text`, `mask_all_element_attributes` | false, false | Mask autocapture text and attributes | L369-370 |
| `properties_string_max_length` | 65535 | Truncates string properties. Replay is exempt | L368 |

### Performance, errors and logs

| Option | Default | Effect | Source |
|---|---|---|---|
| `capture_performance` | undefined (remote decides) | `{web_vitals, network_timing, web_vitals_allowed_metrics, web_vitals_attribution, web_vitals_delayed_flush_ms}` | L389; extensions/web-vitals/index.ts L23-32 |
| web vitals metrics | CLS, FCP, INP, LCP. Attribution for INP and LCP | One `$web_vitals` event per flush, with `$web_vitals_<M>_value` and `$web_vitals_<M>_event`. Flushed after 5 s. Values over 15 min are dropped. **No TTFB metric**, but LCP attribution carries `timeToFirstByte` (observed) | web-vitals/index.ts L23-32; fixture `web-i-v0-e-batch.json` |
| `capture_exceptions` | undefined (remote) | `{capture_unhandled_errors, capture_unhandled_rejections, capture_console_errors}`. Lazy `exception-autocapture.js` | Step 4 ERR-a/b/j |
| `error_tracking` | `{}` | Rate limiter (`exceptionRateLimiterBucketSize` / `RefillRate`), `exception_steps` | L398 |
| `logs` | — | `captureConsoleLogs` (remote or client) sends OTLP/JSON to `/i/v1/logs`. Observed with `service.name` `posthog-browser-logs` | fixture `web-i-v1-logs-otlp.json` |

### Session replay (`session_recording.*` plus top-level flags)

| Option | Default | Effect | Source |
|---|---|---|---|
| `disable_session_recording` | false | Client kill switch. Recording also needs remote `sessionRecording` to be an object | L342 |
| `enable_recording_console_log` | undefined | Overrides remote `consoleLogRecordingEnabled` | L353 |
| `session_recording.maskAllInputs` | true | All input values are masked. Observed: typed text and password never left the browser | posthog-config.ts L632-700 |
| `maskTextSelector`, `blockSelector`, `maskTextFn`, `maskInputFn`, `maskAttributeFn`, `maskAllElementAttributes` | null / false | Finer masking | same |
| `blockClass`, `ignoreClass`, `maskTextClass` | `ph-no-capture`, `ph-ignore-input`, `ph-mask` | Class hooks | same |
| `recordHeaders`, `recordBody` | false, false | Network payload capture in the replay network plugin (remote `networkPayloadCapture` also enables it). Observed request headers in the replay. Response headers are filtered by a denylist (`access-control-allow-credentials` showed `redacted`) | posthog-config.ts L816-826; fixture `web-s-snapshot-decoded.json` |
| `streamNetworkBody` | false; true from defaults 2026-06-25 | Streams bodies so the size limit can be enforced | L273-275 |
| `captureCanvas` / `canvasCapture` | off; `resolutionScale` 0.6 from 2026-05-30 | Canvas recording, 4 fps and quality 0.4 when on | lazy-loaded-session-recorder.ts L100-108 |
| `captureJsonLd` | false; true from defaults 2026-08-30 | Records JSON-LD blocks | L276-278 |
| `full_snapshot_interval_millis` | 300000 | A new FullSnapshot every 5 min | posthog-config.ts L924-926 |
| `session_idle_threshold_ms` | 300000 | Replay pauses after 5 min without user activity | L960-962 |
| `trigger_pending_buffer_interval_millis` | 60000 | While a trigger is pending, the SDK keeps only the latest ~1 min (one FullSnapshot) | L936-938 |
| `compress_events` | true | Per-event gzip of FullSnapshot and Mutation fields (cv `2024-10`) | L945-947 |
| `__mutationThrottlerRefillRate` / `BucketSize` | 10 / 100 | Per-node mutation rate limit | L969-980 |
| `strictMinimumDuration` | false; true from 2025-11-30 | Minimum duration measured on buffered data, not session age | L1009; posthog-core.ts L267-269 |
| `sampleRate` | undefined | A client value overrides the remote `sampleRate` | posthog-config.ts L1037 |
| `sampling` | undefined | rrweb sampling (for example `{mousemove: false}`). Unrelated to session sampling | L1026 |

## 3. Manual API (RUM-relevant)

| Call | Effect |
|---|---|
| `posthog.capture(name, props, {send_instantly, timestamp, $set, $set_once})` | Any event. `send_instantly` skips the queue |
| `posthog.identify(id, $set, $set_once)` | Sends `$identify` with `$anon_distinct_id` (observed). Triggers a new `/flags` call |
| `posthog.captureException(err, props)` | `$exception`, `mechanism.handled: true` (observed) |
| `posthog.startSessionRecording(true \| {sampling, linked_flag, url_trigger, event_trigger})` / `stopSessionRecording()` | Overrides gates for this session |
| `posthog.sessionRecordingStarted()`, `get_session_id()`, `get_session_replay_url({withTimestamp})` | Replay status and linking |
| `posthog.onSessionId(cb)`, `posthog.reset()` | Session hooks. `reset` starts a new session and a new anonymous id |
| `posthog.logger.*`, `posthog.captureLog({...})` | OTLP logs |
| `posthog.register(...)`, `register_for_session(...)` | Super properties per device or per session |

## 4. Replay sampling and gating: how the decision is made

Recorder status values (pj:browser/src/extensions/replay/external/triggerMatching.ts L16-24): `disabled`, `sampled`, `active`, `buffering`, `paused`, `lazy_loading`, `awaiting_config`, `missing_config`, `rrweb_error`.

1. **Remote gate.** `sessionRecording` must be an object, and `disable_session_recording` must not be set. Observed: with `sessionRecording: false` plus `quotaLimited: ["recordings"]` in remote config, `lazy-recorder.js` still loaded, but `sessionRecordingStarted()` stayed false and no `/s/` request was sent.
2. **Sample rate.** `sampleOnProperty(sessionId, rate)` = `simpleHash(sessionId) % 100 < rate*100` (pj:browser/src/extensions/sampling.ts L24-26). The decision is deterministic per session id and is stored in persistence. It is recomputed if the rate changes (recording-strategies.ts L258-296). Trigger groups (v2) sample on `sessionId + groupId` (L564).
3. **Linked flag, URL triggers and event triggers** combine with `triggerMatchType` any/all. While a trigger is pending, status is `buffering`. The buffer holds the last ~1 min and is sent once the trigger fires.
4. **Minimum duration.** The buffer is held until the session (or, with strict mode, the buffered data) reaches `minimumDurationMilliseconds` (lazy-loaded-session-recorder.ts L2452-2475). At unload, a held buffer is parked in sessionStorage (`_replay_pending_buffer`) for the next page in the same tab (L137-141, L2370).
5. **Idle.** After 5 min without activity, recording pauses. Rotating to a new session holds the flush until there is an interaction (`FlushHoldReason`, L120-122).

Implication for ouo: PostHog has no "record only on error with N seconds before" mode like Sentry's `replaysOnErrorSampleRate`. An event trigger on `$exception` with the 1-min pending buffer is the closest equivalent.
