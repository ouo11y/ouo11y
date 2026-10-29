# Appendix C: posthog-js (browser SDK) and the replay path behind it

Studied 2026-10-29. Every code fact cites `repo/path:line @ shortsha`, with the commits given in section 1. Facts that come only from posthog.com docs are marked `[docs only]`. Sizes marked "measured here" come from the published npm tarball, measured in a scratch directory (method in section 7).

**Short answer.** posthog-js is a product-analytics SDK that also records sessions. Everything it sends is a PostHog event (`capture(name, properties)`) carrying `$session_id` and `$window_id`. Analytics events go to `/e/`. Replay goes to `/s/` as `$snapshot` events. Logs and metrics are the only OTLP traffic. Replay runs on **PostHog's own fork of rrweb**, `@posthog/rrweb*`, forked from upstream `2.0.0-alpha.18` and vendored in the monorepo since May 2026. The fork carries its own fixes for main-thread cost. Replay compression has two layers. First, the large rrweb fields are gzipped one event at a time with the native `CompressionStream`, falling back to synchronous `fflate`, and marked `cv: "2024-10"`. Second, the whole request body is gzipped. Nothing runs in a Web Worker except canvas frame encoding. The server stores replay as snappy-compressed JSONL blocks `[windowId, event]` on S3. The player un-snappies the blocks in a worker (snappy-wasm) and un-gzips the `cv` fields in the browser. The CDN core `array.js` measures about **107 KB gzip**. The recorder is lazy-loaded and adds about **67 KB gzip**.

## 1. Sources

| Repo | Ref | Commit | Licence |
|---|---|---|---|
| https://github.com/PostHog/posthog-js (monorepo: `packages/browser` = npm `posthog-js`, plus `core`, `browser-common`, `rrweb/*`, `react`, `next`, `nuxt`, `node`, `web`) | tag `posthog-js@1.442.1` (2026-10-29) | `dfb2e002db81eee1889841d272b54e04f4c722f5` | `(Apache-2.0 AND MIT)` (`posthog-js/packages/browser/package.json:10 @dfb2e00`) |
| https://github.com/PostHog/posthog (sparse: `nodejs/src/ingestion/pipelines/sessionreplay/`, `rust/capture/src/events/recordings.rs`, `common/replay-shared/src/snapshot-processing/`, `frontend/.../player/snapshot-processing/`, `rust/cymbal/.../fingerprint.rs`) | `master` (2026-10-29) | `db59f2c9bcf5743299cf0ec17b171441e999cb8b` | MIT outside `ee/` |
| npm `posthog-js@1.442.1` tarball (built `dist/`) | 1.442.1 | n/a | same |

Docs read: https://posthog.com/docs/error-tracking/fingerprints, https://posthog.com/docs/error-tracking/upload-source-maps/web, https://posthog.com/docs/advanced/proxy.

Open-source status: everything studied is source. The browser package depends on `fflate` 0.4.8, `web-vitals` 6.2.1 (twice, the second copy aliased as `web-vitals-soft-navs`), `preact` (surveys and tours UI), `dompurify`, `core-js` and `query-selector-shadow-dom` (`posthog-js/packages/browser/package.json:80-91 @dfb2e00`). The stack parser is derived from sentry-javascript (`posthog-js/packages/core/src/error-tracking/chunk-ids.ts:1-3 @dfb2e00`).

## 2. Packages and frameworks

| Package (version at the tag) | What it is | Source |
|---|---|---|
| `posthog-js` 1.442.1 | The browser SDK. Entries: `dist/array.js` (CDN snippet, IIFE), `module.js`/`module.mjs` (ESM, all extensions), `module.slim.js` (core only, extensions opt-in through `__extensionClasses`), `*.full.*` (lazy scripts bundled in), `*.no-external.*` (never loads remote scripts), `array.full.es5.js` | `posthog-js/packages/browser/src/entrypoints/*.ts @dfb2e00`; slim usage `posthog-js/packages/browser/src/extensions/extension-bundles.ts:1-22 @dfb2e00` |
| `posthog-js/react` → `@posthog/react` 1.11.3 | `PostHogProvider`, `PostHogErrorBoundary`, `PostHogFeature`, `PostHogCaptureOnViewed`, hooks `usePostHog`, `useFeatureFlagEnabled`, `useFeatureFlagPayload`, `useFeatureFlagVariantKey`, `useActiveFeatureFlags`, `useThumbSurvey` | `posthog-js/packages/react/src/{components,hooks,context} @dfb2e00` |
| `@posthog/next` 0.10.0 | App Router provider, `PostHogPageView`, middleware, `onRequestError` capture. `otel.ts` adds a server-side `PostHogContextSpanProcessor` that sets `sessionId` / `posthogDistinctId` attributes on the app's own Node OTel spans | `posthog-js/packages/next/src/otel.ts:1-45 @dfb2e00`, `posthog-js/packages/node/src/entrypoints/otel.ts:30-39 @dfb2e00` |
| `@posthog/nextjs-config` 1.12.0 | Build plugin for source-map upload | `posthog-js/packages/nextjs-config/package.json @dfb2e00` |
| `@posthog/nuxt` 1.9.0 | Nuxt module | `posthog-js/packages/nuxt/package.json @dfb2e00` |
| `posthog-js-lite` 4.13.2 | Minimal client on `@posthog/core`, with no autocapture and no replay | `posthog-js/packages/web/package.json:2 @dfb2e00` |
| `@posthog/browser` 0.1.0 | "Experimental" new modern-browser client built from lazily loaded extensions | `posthog-js/packages/browser-next/README.md:1-10 @dfb2e00` |
| `@posthog/rrweb`, `-record`, `-snapshot`, `-types`, `-plugin-console-record` | The rrweb fork | `posthog-js/packages/rrweb/README.md:1-13 @dfb2e00` |

Vue, Angular, Svelte and Remix have no package in the monorepo (`ls posthog-js/packages @dfb2e00`). They use the plain `posthog-js` init.

**Browser floor.** `browserslist` is `"> 0.5%, last 2 versions, Firefox ESR, not dead"` (`posthog-js/packages/browser/package.json:162-164 @dfb2e00`). The ES5 build adds `chrome > 62`, `firefox > 59`, `ios_saf >= 6.1`, `safari > 12` (`posthog-js/packages/browser/rollup.config.mjs:112-125 @dfb2e00`).

**Lazy loading.** Optional features are separate scripts, fetched on demand by `loadExternalDependency` from `{asset_host}/static/{kind}.js?v={version}`, or from the versioned `/static/{version}/{kind}.js` (`posthog-js/packages/browser/src/entrypoints/external-scripts-loader.ts:62-64,108,139 @dfb2e00`). The scripts are created with `crossOrigin = 'anonymous'`, and the `prepare_external_dependency_script` hook can add a nonce. Lazy kinds:
- `posthog-recorder` (the default replay script is `lazy-recorder`, and remote config can name another: `posthog-js/packages/browser/src/extensions/replay/session-recording.ts:353-357 @dfb2e00`);
- `dead-clicks-autocapture`;
- `exception-autocapture`;
- `web-vitals`, `web-vitals-with-attribution`, and their soft-navigation variants;
- `surveys`, `product-tours`, `conversations`, `toolbar`, `tracing-headers`, `logs`.

The lazy script publishes itself on `window.__PosthogExtensions__` (`posthog-js/packages/browser/src/entrypoints/posthog-recorder.ts:17-33 @dfb2e00`).

## 3. RUM

The SDK is product analytics first. There is **no** resource timing, no long tasks or LoAF, no navigation timing event and no spans. Performance data is limited to web vitals and to network timing inside the replay.

### 3.1 Sessions

| Item | Behaviour | Source |
|---|---|---|
| Ids | `$session_id` and `$window_id` are both UUIDv7 | `posthog-js/packages/browser/src/sessionid.ts:93-94 @dfb2e00` |
| Idle timeout | 30 min by default (`session_idle_timeout_seconds`), clamped to 1 min..10 h | `sessionid.ts:17-19,98-106 @dfb2e00` |
| Max length | 24 h (`SESSION_LENGTH_LIMIT_MILLISECONDS`) | `sessionid.ts:20 @dfb2e00` |
| Rotation | A new session id **and** a new window id when there is no id, the session went idle (only non-read-only calls count as activity), or the session passed the max length | `sessionid.ts:470-486 @dfb2e00` |
| Proactive idle end | A `setTimeout(timeout × 1.1)` timer resets the session and emits `forcedIdleReset`, unless a sibling tab kept it alive | `sessionid.ts:538-564 @dfb2e00` |
| Cross-tab | Every tab shares one session id (it lives in persistence). Before an idle rotation, the SDK re-reads storage and adopts a sibling tab's newer id or activity, then fires `onSessionId` handlers so replay and `$pageview` state follow | `sessionid.ts:440-468,487-513 @dfb2e00` |
| Window id | Kept in `sessionStorage` (`ph_<name>_window_id`). A `primary_window_exists` flag, cleared on `beforeunload`, tells a reload (keep the id) from a duplicated tab or `window.open` (new id) | `sessionid.ts:111-129,366-381 @dfb2e00` |
| Storage | `persistence` is `localStorage+cookie` by default; other options are `localStorage`, `cookie`, `sessionStorage`, `memory`. In the default mode, only the identity keys stay in the cookie, the session among them (`$sesid` = `[lastActivity, sessionId, startTs]`); everything else goes to localStorage | `posthog-js/packages/browser/src/posthog-core.ts:323 @dfb2e00`; `posthog-js/packages/browser/src/posthog-persistence.ts:979-1001 @dfb2e00`; `posthog-js/packages/browser/src/storage.ts:290-314 @dfb2e00`; `posthog-js/packages/browser/src/constants.ts:51 @dfb2e00`; `sessionid.ts:278 @dfb2e00` |
| Cookie name | `ph_<token>_posthog` | `posthog-persistence.ts:106-108 @dfb2e00` |
| Cross-subdomain | `cross_subdomain_cookie` is on except on `herokuapp.com`, `vercel.app` and `netlify.app`. The cookie domain is found **by probing**: the SDK sets a test cookie on ever-shorter suffixes until the browser accepts one, which finds the first non-public suffix without a PSL list | `posthog-js/packages/browser-common/src/utils/general-utils.ts:171-190 @dfb2e00`; `storage.ts:54-108 @dfb2e00` |
| On every event | `capture()` calls `checkAndGetSessionAndWindowId(readOnly)` and stamps `$session_id` and `$window_id` | `posthog-core.ts:2227-2235 @dfb2e00` |
| Cookieless | `cookieless_mode: 'always' \| 'on_reject'`; in `always` the session manager must not run | `constants.ts:120-121 @dfb2e00`, `sessionid.ts:410-412 @dfb2e00` |

### 3.2 Autocapture, pageviews, frustration signals

- **Events.** `$autocapture` fires on `click`, `change` and `submit`, with capture-phase listeners on `document` (`posthog-js/packages/browser-common/src/autocapture.ts:566-571 @dfb2e00`). `$copy_autocapture` fires on copy/cut/paste when `capture_copied_text` is set (`:574-586`). `autocapture: true` by default (`posthog-core.ts:321 @dfb2e00`).
- **Element chain.** The SDK walks ancestors up to `MAX_DOM_ANCESTOR_DEPTH = 1000` (`posthog-js/packages/browser-common/src/utils/autocapture-utils.ts:11 @dfb2e00`). Each element keeps:
  - `tag_name` and `classes`;
  - `attr__*`, each value capped at 1024 chars;
  - `nth_child` and `nth_of_type`;
  - `$el_text` (1024 chars), only for `a, button, form, input, select, textarea, label` (`autocapture.ts:127-184 @dfb2e00`, `autocapture-utils.ts:102`).

  The chain is serialised into `$elements_chain`, a string such as `a.cls1.cls2:text="…"nth-child="2"nth-of-type="1"href="…"attr_id="…"`, with classes sorted (`autocapture-utils.ts:775-830 @dfb2e00`). It is "always" sent, because server-side filters match on it (`autocapture.ts:332-333`). `$element_selectors` is added too (`:776-779`).
- **Privacy.**
  - `.ph-no-capture` or `.ph-sensitive` on any ancestor drops the event.
  - `type=password` and `type=hidden` inputs are never captured.
  - Names or ids matching `/^cc|cardnum|…|pass|pwd|…|ssn/i` are dropped (`autocapture-utils.ts:523-571 @dfb2e00`).
  - On inputs, selects, textareas and contenteditable, only `name`, `id`, `class` and `aria-label` are kept (`autocapture-utils.ts:578-590`, `autocapture.ts:155`).
  - Attribute values that look like card numbers or SSNs are dropped (`autocapture-utils.ts:688-720`).
  - **Input values are never sent**, unless `capture_value_css_selector_allowlist` matches the element and `maskAllText` is off (`autocapture.ts:797-820 @dfb2e00`).
  - `mask_all_text` and `mask_all_element_attributes` are both off by default (`posthog-core.ts:366-368`).
- **Pageviews.** `capture_pageview` is `true` (only the initial load) by default, and `'history_change'` with `defaults >= '2025-05-24'` (`posthog-core.ts:301 @dfb2e00`). `HistoryAutocapture` patches `pushState` and `replaceState` and listens to `popstate`, capturing `$pageview` with `navigation_type` when the path changes (`posthog-js/packages/browser/src/extensions/history-autocapture.ts:72-81,128-130,151-168 @dfb2e00`).
- **Page leave.** `$pageleave` is captured **only on `pagehide`/`unload`** (`posthog-core.ts:1092-1095,1458-1478 @dfb2e00`); grep finds no other capture site. In an SPA, each new `$pageview` carries the previous view instead: `$prev_pageview_id`, `_pathname`, `_duration`, and `_last_scroll` / `_max_scroll` / `_max_content` with percentages (`posthog-js/packages/browser/src/page-view.ts:100-160 @dfb2e00`). Scroll depth lives there.
- **Rage clicks.** 3 clicks within 1000 ms, each within 30 px (Manhattan distance) of the previous one (`posthog-js/packages/browser-common/src/rageclick.ts:8-49 @dfb2e00`). They are captured as `$rageclick` from the autocapture click path (`autocapture.ts:730-739`). The default ignore list covers `.ph-no-rageclick` and `.ph-no-capture`, and newer `defaults` add a content ignore list ("next", "prev", steppers) (`autocapture-utils.ts:174-192,313`).
- **Dead clicks** (`$dead_click`, `$dead_swipe`). Lazy script `dead-clicks-autocapture` (`posthog-js/packages/browser/src/extensions/dead-clicks-autocapture.ts:71-88 @dfb2e00`). A click becomes a candidate unless it hit the toolbar, repeated the same node within 1 s, carried a modifier key, or hit an anchor. Each candidate is re-checked about 1 s later. It is **alive** if any of these happened:
  - a DOM mutation within 2500 ms;
  - a scroll within 100 ms;
  - a selection change within 100 ms;
  - a visibility or focus change within 1 s.

  It is **dead** only if a timeout signal fired, or if nothing happened within 2750 ms (`posthog-js/packages/browser/src/entrypoints/dead-clicks-autocapture.ts:97-133,157-163 @dfb2e00`). Dead clicks are on when `capture_dead_clicks` is set or when remote config enables them (`dead-clicks-autocapture.ts:15-25`).
- **Heatmaps.** Click, rage-click and dead-click points, plus mousemove debounced to 500 ms. Each point is `{x, y, target_fixed, type}`, page-absolute unless the target is fixed or sticky. Points are grouped by URL (query parameters masked) and flushed every 5 s as a `$$heatmap` event with `$heatmap_data` (`posthog-js/packages/browser/src/heatmaps.ts:22,235-321 @dfb2e00`). Heatmaps are on when `capture_heatmaps` is set or remote config enables them (`heatmaps.ts:103-111`).

### 3.3 Web vitals

- **Library.** Google `web-vitals` 6.2.1, loaded lazily (`posthog-js/packages/browser/src/entrypoints/web-vitals.ts:22 @dfb2e00`).
- **Metrics.** LCP, CLS, FCP and INP. **No TTFB** (`posthog-js/packages/browser/src/extensions/web-vitals/index.ts:30 @dfb2e00`).
- **Attribution.** On by default for INP and LCP only. CLS is left out because "onCLS with attribution holds detached DOM nodes and leaks in single-page apps" (`index.ts:26-31`). Attribution is cut to a scalar allowlist: `interactionTarget`, `inputDelay`, `processingDuration`, `presentationDelay`, `target`, `url`, `resourceLoadDelay`, `elementRenderDelay`, `largestShift*`, `firstByteToFCP` and similar (`index.ts:36-56`). The `entries` array is always dropped.
- **Event.** One `$web_vitals` event per navigation, with `$web_vitals_<M>_value` and `$web_vitals_<M>_event`. It is sent when all allowed metrics have arrived, or 5 s after the first one, or on `pagehide` via `sendBeacon` (`index.ts:23,246-266,300-358`).
- **Filters.** Values at or above 15 min are discarded (`index.ts:128-135,295`). The `__preview_web_vitals_soft_navs` option selects the soft-navigation build of web-vitals (`index.ts:120-125,195-201`).
- **Enablement.** `capture_performance: undefined` falls back to remote config (`posthog-core.ts:387`).

### 3.4 Errors

- **Handlers.** The lazy script `exception-autocapture` wraps `window.onerror` and `window.onunhandledrejection` (property assignment, not `addEventListener`), and optionally `console.error` (`posthog-js/packages/browser/src/entrypoints/exception-autocapture.ts:49-120 @dfb2e00`). The defaults are all false. `capture_exceptions: true`, or remote enablement, turns on errors and rejections, but not console (`posthog-js/packages/browser/src/extensions/exception-autocapture/index.ts:42-56 @dfb2e00`).
- **Rate limit.** Per exception type, a bucket of 10 refilled at 1 per 10 s (`index.ts:27-36`).
- **Parsing.** `ErrorPropertiesBuilder` has coercers for DOMException, PromiseRejectionEvent, ErrorEvent, Error, Event, Object, string and primitive values (`posthog-js/packages/browser/src/posthog-exceptions.ts:40-54 @dfb2e00`). Stack parsers for chrome, gecko, safari, opera and winjs are derived from Sentry, capped at 50 frames (`posthog-js/packages/core/src/error-tracking/parsers/index.ts:43 @dfb2e00`). Output is `$exception_list` with a `mechanism` (`handled`, `synthetic`).
- **Source-map linkage.** Frames get a `chunk_id` from the global `_posthogChunkIds` (injected by `posthog-cli sourcemap inject`) or from the standard `_debugIds` (`posthog-js/packages/core/src/error-tracking/chunk-ids.ts:17-21`, `error-properties-builder.ts:96 @dfb2e00`). Upload uses `posthog-cli sourcemap upload --release-name --release-version` `[docs only]`.
- **Breadcrumbs.** Manual only: `posthog.addExceptionStep(message, props)` fills `$exception_steps`, capped at 32 KB (`posthog-core.ts:4556 @dfb2e00`, `posthog-js/packages/core/src/error-tracking/exception-steps.ts:30-33 @dfb2e00`). Client-side suppression rules come from remote config (`posthog-exceptions.ts:85-93,277`).
- **Grouping is server-side.** The `cymbal` Rust service picks the fingerprint in this order (`posthog/rust/cymbal/src/modes/processing/stages/grouping/fingerprint.rs:43-62 @db59f2c`):
  1. a client-supplied `$exception_fingerprint`;
  2. a matching grouping rule;
  3. an automatic fingerprint.

  The automatic fingerprint is the exception type, plus the first in-app resolved frame or the message when no stack resolves `[docs only]`.

### 3.5 Network, console, backend correlation, custom data

- **Network outside replay.** There is none, apart from an opt-in `network-metrics` extension that records `http.client.request.duration` with templated paths (`posthog-js/packages/browser/src/extensions/network-metrics.ts:13-26 @dfb2e00`). Request detail lives only in the replay plugin (section 4).
- **Backend correlation.** The `tracing_headers: [hosts]` option adds `X-POSTHOG-SESSION-ID`, `X-POSTHOG-WINDOW-ID` and `X-POSTHOG-DISTINCT-ID` to fetch and XHR calls to the listed hosts (`posthog-js/packages/browser/src/entrypoints/tracing-headers.ts:9-11,128-192 @dfb2e00`, `posthog-js/packages/browser/src/extensions/tracing-headers.ts:36-40 @dfb2e00`). **No `traceparent` from the browser.** `@posthog/core` has an OTLP traces module with traceparent support (`posthog-js/packages/core/src/traces/{otlp,traceparent}.ts @dfb2e00`), but only the Node client imports it.
- **Console.** `logs.captureConsoleLogs` patches `console` and ships records as OTLP logs to `/i/v1/logs` (`posthog-js/packages/browser-common/src/logs.ts:31-33,125,638-643 @dfb2e00`). Console capture into the replay is a separate rrweb plugin (section 4).
- **Custom data.** `capture()`, `posthog.metrics.counter/gauge/histogram` (pre-aggregated, OTLP to `/i/v1/metrics`: `posthog-js/packages/browser/src/posthog-metrics.ts:10-84 @dfb2e00`) and `captureLog`. Feature flags come from `/flags/?v=2`, remote config from `/array/<token>/config` (`posthog-js/packages/browser/src/remote-config.ts:30,80-81 @dfb2e00`).

## 4. Session replay

### 4.1 Recorder and options

- **Fork.** `@posthog/rrweb` 0.1.9, `@posthog/rrweb-record` 0.0.89, `@posthog/rrweb-snapshot` 0.0.68 (`posthog-js/packages/rrweb/*/package.json:2-3 @dfb2e00`). The fork changelog continues after upstream `2.0.0-alpha.18` (`posthog-js/packages/rrweb/rrweb/CHANGELOG.md:281 @dfb2e00`), and the sources moved into the monorepo in PR #3510 on 2026-05-05 (`:267-273`). Fork-only work, all from the same changelog:
  - an O(n) mutation drain for large sibling inserts, fixing a "9–10 s … main-thread freeze" (`:7`);
  - a cap on stylesheet inlining in the full snapshot (`:27`);
  - canvas pixel fingerprinting before encoding (`:82`);
  - a canvas worker terminated on stop (`:51`);
  - canvas at reduced resolution (`:150`);
  - bounded wrapper chains for `patch()` (`:107`).
- **Start.** The recorder starts at `DOMContentLoaded` (`recordAfter`), not at window `load` (`posthog-js/packages/browser/src/extensions/replay/external/lazy-loaded-session-recorder.ts:2998-3004 @dfb2e00`).
- **Fixed options** (`lazy-loaded-session-recorder.ts:2810-2836 @dfb2e00`):
  - `blockClass: 'ph-no-capture'`, `ignoreClass: 'ph-ignore-input'`, `maskTextClass: 'ph-mask'`;
  - **`maskAllInputs: true`**, `maskInputOptions: {password: true}` (password always forced on, `:2845-2847`);
  - `maskAllElementAttributes: false`, `inlineStylesheet: true`, `collectFonts: false`, `recordCrossOriginIframes: false`;
  - `inlineStylesheetBudgetRules: 10_000` (rules beyond the budget are inlined across idle callbacks).

  Users may override only allowlisted keys, and `sampling` accepts only `mousemove` and `mouseInteraction` (`:2840-2867`). Remote "privacy and masking" settings feed `maskAllInputs`, `maskTextSelector`, `blockSelector` and `maskAllElementAttributes`, and the client config wins (`:682-705,2917-2922`). **Text is not masked by default**; only inputs are.
- **Canvas.** Off unless enabled. Defaults: 4 fps (max 12), WebP quality 0.4, `canvasResolutionScale` (0.6 with newer `defaults`), and an optional `maskRegionsFn` (`:101-108,777-801,2879-2915`; `posthog-core.ts:269-271`).
- **Large DOMs and mutation storms** (`MutationThrottler`). Attribute mutations are rate-limited **per node** with a bucket of 100 and a refill of 10/s (`posthog-js/packages/browser/src/extensions/replay/external/mutation-throttler.ts:39-46 @dfb2e00`). A throttled node is logged as "Too many mutations … SVG animations" (`lazy-loaded-session-recorder.ts:2950-2958`). An optional byte budget is off by default (`bytesBucketSize = 0`, `mutation-throttler.ts:48`). When it is on and drops a mutation, a resync full snapshot follows, at most one per interval (`:157-181`). Full snapshots slower than 500 ms log a warning (`lazy-loaded-session-recorder.ts:118-120`). A periodic full snapshot runs every 5 min, and every 1 min while waiting for a trigger (`:1012-1041`).
- **Idle.** Recording goes idle after 5 min without user interaction (`RECORDING_IDLE_THRESHOLD_MS`; `session_idle_threshold_ms` overrides). While idle, rrweb keeps running but events are dropped (except allowed markers), the full-snapshot timer stops, and a `sessionIdle` custom event is added (`:134,2667-2705,2050-2055`). The first interaction after a drop triggers a healing full snapshot (`:2755-2763`).
- **Session rotation.** When `checkAndGetSessionAndWindowId` returns a new id, the recorder stops and restarts (`start('session_id_changed')`). That means a new Meta and full snapshot under the new id, and `$session_ending` / `$session_starting` markers routed to the old and new session (`:1614-1636,2004-2046`). An epoch that began with an idle rotation is **held, not flushed, until the user interacts** (`Replay.spec.md:13-16`, `lazy-loaded-session-recorder.ts:2329-2332`).

### 4.2 Gating: sampling, minimum duration, triggers

- Sampling is deterministic per session: `simpleHash(sessionId) % 100 < rate × 100` (`posthog-js/packages/browser/src/extensions/sampling.ts:12-25 @dfb2e00`). The decision is persisted (`posthog-js/packages/browser/src/extensions/replay/external/recording-strategies.ts:276 @dfb2e00`). Trigger groups (V2) sample on `sessionId + groupId` (`recording-strategies.ts:564`).
- The minimum duration comes from remote config. In strict mode the buffer itself must span the minimum before anything ships. Below the minimum, an unloading page parks its buffer in `sessionStorage` for the next page in the same tab (`lazy-loaded-session-recorder.ts:136-141,2357-2373,2451-2482`).
- **Triggers.** URL triggers and a URL blocklist (pause/resume), event triggers (start when a named event is captured), and a linked feature flag (optionally a variant), combined with `any` or `all` (`posthog-js/packages/browser/src/extensions/replay/external/triggerMatching.ts:16-29,154-218,407,487,564 @dfb2e00`). While a trigger is pending the status is `buffering`. The SDK keeps only the data since the latest full snapshot, takes a full snapshot every minute, and ships the buffer when the trigger fires. That is a "record the last minute before the event" mode (`lazy-loaded-session-recorder.ts:1012-1022,1986-1992`).

### 4.3 Network and console data in the replay

- **Plugin.** `rrweb/network@1` (`posthog-js/packages/browser/src/extensions/replay/external/network-plugin.ts:1205 @dfb2e00`). It works in two modes:
  - *Timing only*: a `PerformanceObserver` on resource and navigation entries, enabled by `capture_performance` / `network_timing` (`network-plugin.ts:109-170`).
  - *Headers or bodies*: patches `fetch` and XHR (`:334-473,817-1017`), switched on when `recordHeaders` or `recordBody` is set (`:1174`). Both default to false, or to remote config (`posthog-js/packages/browser/src/extensions/replay/external/config.ts:45-48,274-292 @dfb2e00`).
- **Body limits.** At most 1 MB per body (`config.ts:13-18`), a 500 ms body-read timeout (`network-plugin.ts:608`), and binary or asset content types are never recorded (`:196-205`).
- **Redaction.** `Authorization` and `proxy-authorization` headers are removed, password-like bodies are redacted by default (`config.ts:88-152`, `Replay.spec.md:25-28`), and PostHog's own ingestion calls are ignored (`config.ts:297`). Bodies to other analytics vendors are denied (Sentry, Datadog, LogRocket, Clarity, GA, Segment and others: `config.ts:59-80`). Nothing is captured on localhost (`lazy-loaded-session-recorder.ts:845-871`, the check at line 848).
- **Console.** `@posthog/rrweb-plugin-console-record` when `enable_recording_console_log` is set or remote config enables it (`:803-807,841-844`). Each log is truncated to 10 strings of 2000 chars (`posthog-js/packages/browser/src/extensions/replay/external/sessionrecording-utils.ts:147-171 @dfb2e00`).

### 4.4 Compression, buffering, wire format

1. **Per event.** Full snapshots (`data`), mutations (`texts`, `attributes`, `removes`, `adds`) and stylesheet-rule events (`adds`, `removes`) are JSON-stringified and **gzipped field by field**. Each field is encoded as a latin1 string and the event is marked `cv: '2024-10'` (`lazy-loaded-session-recorder.ts:209-251,316-331,382-437`). Other event types stay plain JSON. Native `CompressionStream` is used when present, as an async ordered queue; otherwise `fflate.gzipSync` runs on the main thread (`:283,2091-2101,1871-1922`). `compress_events: false` disables this (`:2079`).
2. **Buffer.** Events accumulate in memory and flush every **2 s**, or sooner when the buffer would pass **~0.9 MB** (`RECORDING_MAX_EVENT_SIZE`), or when the session id changes (`:135-136,2203-2214,2484-2541`). On flush the buffer is split recursively into chunks of at most ~6.3 MB (`sessionrecording-utils.ts:183-210`). Each chunk becomes one `$snapshot` event carrying `$snapshot_data` (an array of events), `$snapshot_bytes`, `$session_id`, `$window_id` and `$snapshot_host` (`lazy-loaded-session-recorder.ts:2383-2412`).
3. **Request.** The `$snapshot` event goes through the normal request queue with `_batchKey: 'recordings'`, sent to `/s/` with `_noTruncate` and without client rate limiting (`:2544-2551`). The batch body is gzipped **again** as a whole (section 5).

### 4.5 Server side and the player (posthog repo)

- **Capture.** The Rust capture service validates the session id (at most 70 chars) and folds a request's events into one Kafka message `$snapshot_items` with `$session_id`, `$window_id`, `$snapshot_source` (default `web`) and `$lib`. The serialisation runs on a blocking thread pool (`posthog/rust/capture/src/events/recordings.rs:400-470,620-676 @db59f2c`).
- **Ingestion.** A Node consumer batches by session and writes "session batch files" to S3. Each file is a sequence of independently readable **blocks**. A block is JSONL, one line per event `[windowId, event]`, compressed with **snappy** by default or brotli as an option (`posthog/nodejs/src/ingestion/pipelines/sessionreplay/sessions/session-block-recorder.ts:75-96,176-181 @db59f2c`, `.../sessions/block-compression.ts:5-37 @db59f2c`). ClickHouse receives the metadata, console logs are extracted for search, and `$pageview` / `$url_changed` custom events feed the navigation URLs (`posthog/nodejs/src/ingestion/pipelines/sessionreplay/README.md:7-20 @db59f2c`).
- **Player.** Blocks are un-snappied in a Web Worker with `snappy-wasm` (`posthog/frontend/src/scenes/session-recordings/player/snapshot-processing/decompressionWorker.ts:1-9 @db59f2c`). The `cv: '2024-10'` fields are then gunzipped field by field in the browser (`posthog/common/replay-shared/src/snapshot-processing/decompress.ts:34-84 @db59f2c`). The rest of `process-all-snapshots.ts` patches meta events, strips Chrome-extension nodes and chunks large mutations before the standard rrweb Replayer (same folder). The server never inflates the per-event gzip.

## 5. Transport and OpenTelemetry

| Item | Behaviour | Source |
|---|---|---|
| Hosts | `api_host` defaults to `https://us.i.posthog.com`; assets come from `{region}-assets.i.posthog.com`; ingestion paths are `/e/`, `/s/`, `/i/` | `posthog-core.ts:316 @dfb2e00`; `posthog-js/packages/browser/src/utils/request-router.ts:20-22,73-78,174-178 @dfb2e00` |
| Batch format | `{api_key, batch:[events], sent_at}` | `posthog-js/packages/browser/src/request.ts:577-594 @dfb2e00` |
| Batching | Request queue flushes every **3 s** (clamped 250 ms..5 s), grouped by `batchKey` or URL | `posthog-js/packages/browser/src/request-queue.ts:7,24-30,103 @dfb2e00` |
| Compression | `gzip-js` by default (`disable_compression: false`), or what remote `supportedCompression` allows (gzip-js, then base64). Body is `text/plain` gzip bytes with `?compression=gzip-js`. **Async `CompressionStream`** is used off the beacon path "to avoid blocking the main thread with fflate's synchronous gzip (which can take 300ms+)"; fflate is the fallback. Base64 bodies are form-encoded | `posthog-core.ts:911,1377-1384`; `request.ts:120-150,219-240,676-692` |
| Transports | `fetch` first, then XHR, then `sendBeacon` | `request.ts:596-625` |
| `keepalive` | POST fetches use `keepalive` while the page's pending keepalive bytes stay under 80 % of 64 KiB | `request.ts:55-60,436-446` |
| Page hide | On `pagehide` (else `unload`): `$pageleave` is captured, logs and metrics are flushed via beacon, and the request queue and retry queue drain with **`sendBeacon`**, events (`/e`) before recordings. A rejected beacon is split in half recursively, then falls back to fetch without keepalive | `posthog-core.ts:1092-1095,1458-1484`; `request-queue.ts:42-56`; `retry-queue.ts:178-213`; `request.ts:517-556` |
| Retries | **In-memory** retry queue: up to 10 retries (3 when the status is 0), backoff `3 s × 2^n` capped at 30 min with ±50 % jitter, `Retry-After` honoured, `retry_count` query param, paused while `offline`. No offline persistence across page loads (only the replay pending buffer is parked in `sessionStorage`) | `posthog-js/packages/browser/src/retry-queue.ts:11-35,45,60-74,83-131 @dfb2e00` |
| Ad blockers | Reverse proxy on a first-party subdomain (managed CNAME or self-hosted), with `ui_host` set for the toolbar; quoted as "about 10-30%" more events `[docs only]`. `asset_host`, `rewriteRequestPath` and the `*.no-external` bundles support self-hosting the lazy scripts | `request-router.ts:119-146`; `posthog-core.ts:319` |
| CSP | Needs `script-src` for the asset host (lazy scripts) and `connect-src` for the api host. Canvas recording uses an inline `blob:` worker that "disables itself quietly" under a strict `worker-src` | `posthog-js/packages/rrweb/rrweb/CHANGELOG.md:143 @dfb2e00` |

**OpenTelemetry.** Analytics events, replay, web vitals, exceptions and heatmaps are **not** OTLP; they are PostHog JSON events. Two streams are OTLP/JSON over HTTP, built by hand without the OTel JS SDK:
- **logs** (`resourceLogs`) to `/i/v1/logs?token=…`, from `captureLog` and console capture (`posthog-js/packages/core/src/logs/logs-utils.ts:193-207 @dfb2e00`, `posthog-js/packages/browser-common/src/logs.ts:638-643 @dfb2e00`);
- **metrics** (`resourceMetrics`) to `/i/v1/metrics` (`posthog-js/packages/core/src/metrics/metrics-utils.ts:66-81 @dfb2e00`, `posthog-metrics.ts:10`).

The browser emits no spans and no `traceparent`. On the server, `@posthog/next` and `posthog-node/otel` only **enrich** the app's existing OTel spans with `sessionId` and `posthogDistinctId` (`posthog-js/packages/node/src/entrypoints/otel.ts:30-39 @dfb2e00`). The browser-to-backend join is the `X-POSTHOG-SESSION-ID` header.

## 6. Other features (as they depend on SDK data)

- **Product analytics.** Funnels, paths, retention and trends are queries over the event stream: `$pageview`, `$autocapture` (matched by `$elements_chain` and selectors), custom events, `$session_id` for session-scoped metrics and `$pageview_id` linkage. Replays open from any of them because every event carries `$session_id` (`posthog-core.ts:2233`).
- **Heatmaps and scroll maps.** Built from `$$heatmap` points per URL, plus `$prev_pageview_max_scroll*` on pageviews (section 3.2).
- **Error tracking.** `$exception` events, server-side fingerprinting and grouping rules, issue workflow, `posthog-cli` source maps (section 3.4).
- **Surveys, product tours, conversations.** Lazy preact UIs (`surveys.js`, `product-tours.js`, `conversations.js`); targeting runs on flags and events.
- **Experiments and feature flags.** `/flags`, with React hooks.
- **Toolbar.** Loaded from `ui_host`; its state lives in `sessionStorage` (`posthog-js/packages/browser/src/extensions/toolbar.ts:32-48 @dfb2e00`).
- **Consent and identity.** `opt_out_capturing_by_default`, `cookieless_mode`, `respect_dnt` (false by default), `person_profiles: 'identified_only'` (`posthog-core.ts:362,392`).
- **Not present:** JS Self-Profiling and a user-feedback widget beyond surveys.

## 7. Performance footprint

**Bundle sizes, measured here.** Method: `npm pack posthog-js@1.442.1 --ignore-scripts`, then `gzip -9c` and Node `brotliCompressSync` at quality 11 on each `dist/*.js`.

| File | Role | Raw | gzip -9 | brotli 11 |
|---|---|---|---|---|
| `array.js` | CDN snippet core: all extension classes, lazy loader | 338,070 | 106,952 | 90,116 |
| `module.js` | npm ESM, default entry | 341,929 | 108,529 | 91,320 |
| `module.slim.js` | core without extensions | 154,433 | 52,272 | 45,323 |
| `array.full.js` | core plus every lazy script inlined | 680,836 | 209,288 | 174,205 |
| `posthog-recorder.js` / `lazy-recorder.js` | rrweb fork + recorder + network + console plugins | 215,344 | 66,849 | 57,884 |
| `recorder.js` | legacy: rrweb + plugins without the lazy recorder class | 134,995 | 41,319 | 35,929 |
| `surveys.js` | surveys UI (preact) | 112,153 | 36,488 | 31,991 |
| `product-tours.js` | | 122,473 | 40,829 | 36,066 |
| `conversations.js` | | 72,072 | 22,704 | 20,252 |
| `dead-clicks-autocapture.js` | | 24,085 | 8,550 | 7,750 |
| `exception-autocapture.js` | | 17,854 | 6,535 | 5,937 |
| `web-vitals.js` / `web-vitals-with-attribution.js` | | 11,042 / 27,027 | 3,955 / 7,019 | 3,594 / 6,130 |
| `rrweb-plugin-console-record.js` | | 7,938 | 3,145 | 2,828 |
| `logs.js` | | 7,206 | 2,764 | 2,543 |
| `tracing-headers.js` | | 4,713 | 1,975 | 1,791 |

A default page with replay, web vitals (attributed) and exception capture on loads about 107 + 67 + 7 + 6.5 ≈ **188 KB gzip** of PostHog JS. The slim build plus a hand-picked `__extensionClasses` set is the tree-shakable route.

**Size checks in CI.** `.github/workflows/bundled-size.yaml @dfb2e00` runs `preactjs/compressed-size-action` (raw sizes, `compression: "none"`) and posts the diff on the PR. `pnpm bundle-size` builds `array.ts` with esbuild against the base ref (`posthog-js/packages/browser/scripts/compare-array-bundle-size.mjs:1-30 @dfb2e00`). Neither check enforces a hard limit.

**Performance tests.** `pnpm benchmark:replay` is an **opt-in** Playwright and Chromium benchmark (not run in CI). It runs 10k, 50k and 100k-node DOMs in table, css, shadow, flat and deep shapes, with compression on and off, measures longest task and input delay, and checks privacy and replay correctness (`posthog-js/packages/browser/scripts/benchmark-replay.mjs:1-30`, `benchmark-replay.md:1-80 @dfb2e00`). The recorded local results (Apple M4 Pro, Chromium 136, about 50k nodes, `benchmark-replay-mutations.md:73-82 @dfb2e00`) are below.

| Workload | Longest task |
|---|---|
| Start recording | about 107-114 ms |
| Full snapshot | about 108 ms |
| Rebuild | about 242-247 ms |
| Five churn bursts | 268-304 ms |
| Move subtree | 187-260 ms |

Sampled CPU for 11 moves splits as preprocessing 200-224 ms, serialization about 95-101 ms and encoding about 46 ms (`benchmark-replay-hotspots.md:22-25`). The authors label these "descriptive medians, not … customer guarantees" (`benchmark-replay-connectivity.md:32`).

**Main thread and workers.**
- On the main thread: rrweb snapshot and mutation serialisation, autocapture element walks, and the synchronous `fflate` fallback.
- Not on the JS thread: replay field compression and request-body compression use native `CompressionStream` when available (`lazy-loaded-session-recorder.ts:283`, `request.ts:219-222`).
- In a worker: canvas frames are fingerprinted and encoded in a dedicated worker (`posthog-js/packages/rrweb/rrweb/src/record/workers/image-bitmap-data-url-worker.ts @dfb2e00`).
- No worker for DOM events.

## 8. Blog-to-code grounding

| Claim (source) | Where it lives |
|---|---|
| Async gzip avoids "300ms+" main-thread stalls on constrained devices (code comment, not a blog) | `request.ts:219-222,676-692 @dfb2e00` |
| Replay freeze of 9–10 s on large sibling inserts fixed by an O(n) drain (changelog) | `posthog-js/packages/rrweb/rrweb/CHANGELOG.md:7 @dfb2e00` (PR #5244, port of upstream rrweb #1652) |
| Static canvases "burned CPU continuously"; fixed by fingerprinting raw pixels before encoding (changelog) | `CHANGELOG.md:82` (PR #4073) |
| Full-snapshot CSS inlining capped at 10k rules (code comment) | `lazy-loaded-session-recorder.ts:2824-2835` |
| A reverse proxy brings "about 10-30%" more events `[docs only]` | not verifiable in code |
| Fingerprint = type + first in-app frame (or message) `[docs only]` | selection order in `posthog/rust/cymbal/.../fingerprint.rs:43-62 @db59f2c`; hashing inputs not read |

## 9. Questions asked and answers

- **Where is the session id stored, and how does replay follow it?** In the `ph_<token>_posthog` cookie (default `localStorage+cookie`), as `$sesid = [lastActivity, id, start]`. The window id is in `sessionStorage`. Rotation happens after 30 min idle or 24 h, or when a sibling tab's id is adopted. Replay restarts with a new full snapshot under the new id and holds the epoch until interaction (sections 3.1, 4.1).
- **Is `$pageleave` sent on SPA route changes?** No. Only on `pagehide`. SPA route changes put `$prev_pageview_*`, including scroll depth, on the next `$pageview` (`page-view.ts:100-160`).
- **Which rrweb?** The in-repo fork `@posthog/rrweb-record` 0.0.89, based on `2.0.0-alpha.18` (section 4.1).
- **Is replay compressed in a worker?** No. Per-field gzip uses `CompressionStream` when available, else `fflate.gzipSync` on the main thread. The request body is gzipped again (sections 4.4, 5).
- **Snapshot size limits?** Flush at 2 s or about 0.9 MB of buffer, split at about 6.3 MB. Network bodies are capped at 1 MB. Console strings are cut to 10 × 2000 chars (section 4).
- **Is there replay on error?** Yes, through event triggers. While pending, the SDK keeps the last minute (a full snapshot every 60 s) and ships it when `$exception` or another named event fires (section 4.2).
- **Is anything OTLP?** Logs (`/i/v1/logs`) and metrics (`/i/v1/metrics`) only. No browser traces (section 5).
- **Where do grouping and symbolication happen?** On the server (`cymbal`). The client only adds `chunk_id` and an optional `$exception_fingerprint` (section 3.4).

## 10. Takeaways for ouo

Worth copying into an OTel-native SDK:
1. **Lazy-loaded heavy parts.** Keep a small core and fetch the recorder, attributed vitals and error parsing only when enabled or sampled in. PostHog's core still weighs 107 KB gzip because every extension class ships in `array.js`. ouo should keep its core well under that and make replay a separate chunk.
2. **Compress on the native path.** Use `CompressionStream` first, with a synchronous fallback only where it is needed (beacons). PostHog's "300ms+" comment is the reason. Field-level gzip of `adds` and `texts` is a reasonable trick if ouo keeps rrweb JSON inside OTLP log bodies, since it keeps the envelope readable while shrinking the bulk. A versioned marker like `cv` lets the player decode both forms.
3. **Recorder hygiene:**
   - start at `DOMContentLoaded`;
   - cap stylesheet inlining;
   - throttle attribute mutations per node (100 burst, 10/s);
   - schedule periodic full snapshots (5 min) and a healing snapshot after idle drops;
   - go idle after 5 min of no interaction;
   - keep `maskAllInputs` on with password forced;
   - default network capture to timing only, with auth headers stripped, a 1 MB body cap and a vendor deny list.
4. **Trigger-buffered replay** (keep the last ~60 s, ship on `$exception` or a named event) and **deterministic sampling on the session id**. Both map directly onto ouo's error-linked replay.
5. **Cross-tab session adoption.** Re-read storage before an idle rotation, use `sessionStorage` window ids with a duplicate-tab check, probe the cookie domain without a PSL, and hold a rotation-born recording until the user interacts.
6. **Page-hide discipline.** Beacon events before recordings, split rejected beacons, and keep a keepalive byte budget under 64 KiB. This is directly reusable in ouo's transport.
7. **Dead-click rules** (mutation 2.5 s, scroll 100 ms, selection 100 ms, visibility and focus as liveness) and **web-vitals attribution trimmed to scalars**, with CLS attribution off to avoid detached-node leaks. These are precise, tested heuristics worth porting as OTel log events.
8. **An opt-in replay benchmark** with correctness and privacy assertions, and a PR size diff. ouo's Appendix M benchmark should take the same form.

Not worth copying:
- **A proprietary event envelope.** Vitals, exceptions, heatmaps and autocapture as untyped `$`-properties on one event stream do not fit OTel. ouo should emit them as OTLP logs and spans with `ouo.*` and semconv attributes.
- **Custom correlation headers** (`X-POSTHOG-SESSION-ID`) in place of W3C `traceparent` / `baggage`. ouo should propagate `traceparent` and put the session id in baggage.
- **Re-gzipping already gzipped replay fields** inside a gzipped request: it wastes CPU and buys little.
- **An in-memory-only retry queue.** ouo already has an offline store.
- **A forked rrweb.** Forking pays off only with a team to maintain it. ouo should track upstream rrweb and contribute fixes (PostHog's fork ports several upstream PRs).
- **Heavy defaults-by-date configuration** (`defaults: '2026-05-30'` flipping behaviour). Explicit, versioned config is simpler to review.
