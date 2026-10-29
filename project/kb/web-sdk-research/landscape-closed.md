# Appendix F: the rest of the web RUM field and the web feature matrix

Written 2026-10-29. This appendix covers the browser agents that Appendices A–E do not:
- **Code read:** New Relic, Bugsnag (Insight Hub), Rollbar, Raygun, Akamai boomerang (mPulse), Azure Application Insights, Instana weasel, SpeedCurve LUX and Vercel Speed Insights.
- **Docs only:** Dynatrace, AppDynamics / Splunk, Catchpoint, Cloudflare Web Analytics, Google Analytics 4, TrackJS, Amplitude, Mixpanel, Heap and Pendo.

It also holds the cross-vendor **web feature matrix** (§6.1): 25 vendors including ouo. Sentry, Datadog, PostHog, Faro, Splunk, Honeycomb, Embrace, LaunchDarkly, OpenReplay, Clarity, LogRocket and Fullstory have code-grounded detail in Appendices A–E. Their rows here come from those vendors' docs and from spot checks in the clones listed in §1.1.

Breadth over depth: each vendor gets a short section. Each section covers technique, signals, replay, OTel, frameworks, self-hosting and size where known.

Provenance labels:
- `[code]`: read in a clone, cited as `repo/path:line @ tag`.
- `[docs only]`: vendor documentation or changelog, with the URL given.
- `[blog only]`: vendor blog, press release or marketing page.
- `[recall]`: from the author's prior reading of the vendor's docs, not re-fetched in this run. Provisional, and the first thing to recheck.

---

## 1. Sources

### 1.1 Repositories read

Blobless clones in the session scratchpad (`.../scratchpad/web/clones/`). Each was checked out at its latest release tag; nothing was installed, built or run.

| Repo | Tag (commit, date) | Licence | What it is |
|---|---|---|---|
| newrelic/newrelic-browser-agent | v1.324.1 (`d2945e63`, 2026-10-26) | Apache-2.0 | Full browser agent: errors, ajax, soft navigations, session trace, session replay, logs, user actions |
| bugsnag/bugsnag-js | v9.1.0 (`575e7017`, 2026-10-09) | MIT | Error notifier for browser, Node, Electron and RN |
| bugsnag/bugsnag-js-performance | v3.4.1 (`24b03e94`, 2026-02-18) | MIT | Performance SDK: page loads, route changes, network spans, sent as OTLP JSON |
| rollbar/rollbar.js | v4.2.0 (`0fec02f`, 2026-10-27) | MIT | Error notifier, telemetry, tracing and rrweb session replay |
| MindscapeHQ/raygun4js | v3.1.4 (`364c6ef`, 2025-07-17) | MIT (LICENSE file; `package.json:22` says "SEE LICENSE IN") | Crash reporting and RUM |
| akamai/boomerang | 1.815.1 (`7e5feb29`, 2025-08-15) | BSD-3-Clause (Yahoo 2011, Akamai) | The RUM beacon library behind mPulse |
| microsoft/ApplicationInsights-JS | v3.4.5 (`9f3440d9`, 2026-10-05) | MIT | Azure Monitor browser SDK and its extensions |
| instana/weasel | 1.8.1 (`a345c9e`, 2025-09-26) | MIT | IBM Instana website monitoring agent (EUM) |
| SpeedCurve-Metrics/lux.js | v4.5.3 (`c218a16`, 2026-09-25) | BSD-3-Clause | SpeedCurve RUM script |
| vercel/speed-insights | v2.0.0 (`828d10c`, 2026-03-10) | Apache-2.0 | npm loader and framework adapters only; the measuring script is served by Vercel |

These clones already existed in the scratchpad from sibling appendices. They were used only for matrix spot checks:
- DataDog/browser-sdk v7.16.2 (`2ee6f07f3`)
- posthog-js (`dfb2e002`)

### 1.2 Not open source, or no browser agent source found

| Vendor | Status |
|---|---|
| Dynatrace RUM JavaScript | Closed; served from the tenant |
| AppDynamics browser agent (`adrum`) | Closed |
| Catchpoint RUM | Closed |
| Cloudflare `beacon.min.js` | Closed |
| GA4 `gtag.js` | Closed |
| TrackJS | `trackjs` on npm, "SEE LICENSE IN LICENSE.md": proprietary [docs only] https://classic.yarnpkg.com/en/package/trackjs |
| Heap | No public repository (GitHub 404) |
| Pendo | Agent closed; the `pendo-io/rrweb` fork is public |
| Fullstory | `@fullstory/browser` is an MIT snippet loader; `fs.js` is closed |
| LogRocket | npm `logrocket` is labelled MIT, but no source repository is published |
| Vercel | The measuring script `/_vercel/speed-insights/script.js` is not in the repo [code: speed-insights/packages/web/src/utils.ts:76-90 @ v2.0.0] |

### 1.3 Main documentation entry points

- New Relic:
  - https://docs.newrelic.com/docs/browser/browser-monitoring/browser-pro-features/session-replay/
  - https://docs.newrelic.com/docs/browser/browser-monitoring/browser-pro-features/user-journeys/
  - https://docs.newrelic.com/docs/opentelemetry/best-practices/opentelemetry-otlp/
- Dynatrace:
  - https://docs.dynatrace.com/docs/observe/digital-experience/session-replay-latest
  - https://docs.dynatrace.com/docs/observe/digital-experience/new-rum-experience/concepts/frontend-backend-linking
  - https://docs.dynatrace.com/docs/ingest-from/opentelemetry
- AppDynamics: https://help.splunk.com/en/appdynamics-on-premises/end-user-monitoring/25.4.0/end-user-monitoring/browser-monitoring/browser-real-user-monitoring/overview-of-the-controller-ui-for-browser-rum/session-replay-for-browser-rum
- Splunk RUM:
  - https://docs.splunk.com/observability/rum/rum-session-replay.html
  - https://github.com/signalfx/splunk-otel-js-web
- Instana:
  - https://www.ibm.com/docs/SSE1JP5_current/src/pages/website_monitoring/backend_correlation.html
  - https://github.com/instana/weasel
- Bugsnag:
  - https://docs.bugsnag.com/performance/browser-js/
  - https://docs.bugsnag.com/performance/open-telemetry/
- Rollbar: https://docs.rollbar.com/docs/session-replay
- Raygun:
  - https://raygun.com/documentation/product-guides/real-user-monitoring/for-web/web-vitals/
  - https://raygun.com/documentation/language-guides/javascript/crash-reporting/source-maps/
- Application Insights:
  - https://learn.microsoft.com/en-us/azure/azure-monitor/app/javascript-sdk-configuration
  - https://learn.microsoft.com/en-us/azure/azure-monitor/app/javascript-feature-extensions
- mPulse / boomerang:
  - https://techdocs.akamai.com/mpulse-boomerang/docs/boomerang-flavors
  - https://akamai.github.io/boomerang/
- SpeedCurve: https://www.speedcurve.com/blog/long-animation-frames-support/
- Catchpoint: https://www.catchpoint.com/press-releases/catchpoint-launches-session-replay-to-put-the-users-view-directly-in-its-hands [blog only]
- Cloudflare:
  - https://developers.cloudflare.com/web-analytics/data-metrics/core-web-vitals/
  - https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/
- GA4:
  - https://web.dev/articles/vitals-ga4
  - https://codelabs.developers.google.com/codelabs/web-vitals-google-analytics-bigquery
- Amplitude:
  - https://amplitude.com/docs/en/sdks/analytics/browser/browser-sdk-2
  - https://amplitude.com/docs/en/sdks/session-replay/session-replay-plugin
  - https://amplitude.com/docs/session-replay/targeted-replay-capture
- Mixpanel:
  - https://docs.mixpanel.com/docs/session-replay
  - https://docs.mixpanel.com/docs/tracking-methods/autocapture
- Pendo: https://support.pendo.io/hc/en-us/articles/360034911511-Glossary
- Heap: https://developers.heap.io/docs/web
- Elastic: https://www.elastic.co/docs/solutions/observability/get-started/opentelemetry/switch-to-otel

---

## 2. Packages and frameworks

| Vendor | Delivery | Framework packages or guides | Source |
|---|---|---|---|
| New Relic | CDN loader snippet in four builds plus npm `@newrelic/browser-agent`. The builds are `lite` (page view, timings, metrics), `pro` (+ errors, ajax, trace, replay), `spa` (+ soft navigations) and `experimental`. | Framework-agnostic; SPA via the soft-navigation heuristic | [code: newrelic-browser-agent/src/cdn/lite.js, src/cdn/spa.js:12-21 @ v1.324.1] |
| Bugsnag | `@bugsnag/js` (errors) and `@bugsnag/browser-performance` | Errors: `plugin-react`, `plugin-vue`, `plugin-angular`. Performance: `react-router`, `vue-router`, `angular`, `svelte-kit`, `plugin-react-performance` | [code: bugsnag-js/packages, bugsnag-js-performance/packages @ tags] |
| Rollbar | `rollbar` npm and snippet. Replay is a separate import (`rollbar/replay`, `rollbar.replay.min.js`) | React (`@rollbar/react`) [recall] | [code: rollbar.js/src/browser/rollbarReplay.js @ v4.2.0] |
| Raygun | `raygun4js` snippet or npm; RUM and crash in one script | Guides for React, Angular, Vue [recall] | [code: raygun4js/src @ v3.1.4] |
| boomerang / mPulse | `boomerang.js` plus a set of plugins built into "flavors" (full to minimal), loaded in an iframe by the mPulse snippet | SPA plugins: `history.js`, `spa.js` (Angular, Ember, Backbone, React via History) | [code: boomerang/plugins @ 1.815.1]; [docs only] https://techdocs.akamai.com/mpulse-boomerang/docs/boomerang-flavors |
| App Insights | `@microsoft/applicationinsights-web` (AISKU), a "Light" SKU, CDN snippet loader | `applicationinsights-react-js`, `-angularplugin-js`, `-react-native`; Click Analytics, Debug, PerfMarkMeasure, OS plugins | [code: ApplicationInsights-JS/extensions @ v3.4.5] |
| Instana | `eum.min.js` snippet with an `ineum(...)` command queue; npm not primary | SPA page transitions automatic | [code: weasel/lib/commands.ts @ 1.8.1]; [docs only] https://www.ibm.com/docs/en/SSE1JP5/src/pages/website_monitoring/auto_instrument.html |
| SpeedCurve LUX | `lux.js` script (also `@speedcurve/lux` on npm). SPAs call `LUX.init()` / `LUX.send()` | none | [code: lux.js/src @ v4.5.3] |
| Vercel Speed Insights | `@vercel/speed-insights` injects `/_vercel/speed-insights/script.js` | Adapters for Astro, Next.js, Nuxt, React, Remix, SvelteKit and Vue | [code: speed-insights/packages/web/src @ v2.0.0] |
| Cloudflare Web Analytics | `beacon.min.js` tag, or auto-injected on proxied sites | none | [docs only] |
| Dynatrace | RUM JavaScript injected by OneAgent on the server, or agentless tag from the tenant | Auto-detects frameworks (Angular, React, Vue) for "user actions" [recall] | [docs only] |
| AppDynamics | `adrum.js` injected or tag | SPA2 monitoring [recall] | [docs only] |

---

## 3. RUM per vendor

### 3.1 New Relic Browser [code]

**Errors**
- The `jserrors` feature captures uncaught errors, unhandled rejections and `noticeError`.
- Grouping happens server-side in Errors Inbox [recall].

**Web vitals with attribution**
- All five metrics are imported from `web-vitals/attribution`, using bundled `web-vitals` 6.2.1 [code: newrelic-browser-agent/src/common/vitals/*.js:5; package.json:232 @ v1.324.1].
- INP sends `interactionTarget`, `interactionType`, `inputDelay`, `processingDuration` and `presentationDelay`.
- LCP sends `timeToFirstByte`, `resourceLoadDelay` and `resourceLoadDuration` [code: src/common/vitals/interaction-to-next-paint.js:15-31, largest-contentful-paint.js:15-22].

**Soft navigations**
- An interaction opens on `click`, `keydown` or `submit`, or on `popstate` [code: src/features/soft_navigations/constants.js:7-12].
- It ends 5 s after the last long task (`NO_LONG_TASK_WINDOW = 5000`) [code: constants.js:17; aggregate/index.js:73-77].
- This replaced the older "SPA" (BrowserInteraction) feature in the `spa` build.

**Network and propagation** [code: src/features/ajax/instrument/distributed-tracing.js:100-149]
- Same-origin requests get the proprietary `newrelic` header plus `traceparent` / `tracestate`.
- Cross-origin requests are traced only for `distributed_tracing.allowed_origins`.
  - The `newrelic` header is on by default (`cors_use_newrelic_header !== false`).
  - W3C headers need opt-in (`cors_use_tracecontext_headers`).

**Long tasks / LoAF**
- No `longtask` or `long-animation-frame` observer exists at this tag. Long tasks appear only as the soft-navigation end heuristic.
- The opt-in long-task feature described in the v1227 release notes is no longer in the source.

**Frustration signals** [code: src/features/generic_events/aggregate/index.js:88-139; constants.js:13-16; user-actions/user-actions-aggregator.js:88-105]
- `UserAction` events carry `rageClick` (4 clicks within 1000 ms), `deadClick` (no reaction within `FRUSTRATION_TIMEOUT_MS = 2000`) and `errorClick` (an error during the action).

**Console and logs**
- The `logging` feature wraps native `console.*` methods into Logs [code: src/features/logging/instrument/index.js:29-30].

**Session trace**
- A resource and event waterfall per page (`session_trace`).
- In error mode it keeps a sliding 30 s window and harvests only after an error [code: src/features/session_trace/constants.js:16].

**OTel**
- The agent is not OTel-based. The backend ingests OTLP.
- New Relic advises against sending browser data straight to its OTLP endpoint, and calls browser OTel RUM "limited and under active development" [docs only] https://docs.newrelic.com/docs/opentelemetry/best-practices/opentelemetry-otlp/.

### 3.2 Bugsnag / SmartBear Insight Hub [code]

**Errors**
- `@bugsnag/js`: `window.onerror` and unhandled rejection plugins, and breadcrumbs (console, interaction, navigation, network).
- Grouping is server-side, with client hints `groupingHash` and `groupingDiscriminator` [code: bugsnag-js/packages/core/event.d.ts:30,47-48 @ v9.1.0].
- Feature flags via `addFeatureFlag(name, variant)` [code: packages/core/client.js:97-101].

**Performance (`@bugsnag/browser-performance`)**
- Page-load, route-change, network and custom spans.
- It uses its own `PerformanceObserver` code for LCP, CLS and FID, not the `web-vitals` library [code: bugsnag-js-performance/packages/platforms/browser/lib/web-vitals.ts:23-149 @ v3.4.1].
- Delivery is **OTLP JSON** (`resourceSpans`) to `https://otlp.bugsnag.com/v1/traces` by default, with an API-key subdomain [code: packages/core/lib/config.ts:100; core.ts:66,95; delivery.ts:35,90].
  - The endpoint is configurable, so spans can go to any OTLP/HTTP JSON receiver.
  - Sampling uses a proprietary response header, `Bugsnag-Sampling-Probability` [code: packages/delivery-fetch/lib/delivery-fetch.ts:9-10].
- Propagation is experimental: `propagateTraceContext` adds `traceparent` [code: platforms/browser/lib/auto-instrumentation/network-request-plugin.ts:14,122].
- Page-load linking reads `<meta name="traceparent">`, the same pattern as ouo's [code: full-page-load-plugin.ts:71].

**Replay:** none.

### 3.3 Rollbar [code]

**Errors**
- Error notifier with telemetry breadcrumbs: network, log, dom, navigation, connectivity.
- Network request and response bodies are off by default [code: rollbar.js/src/browser/telemetry.js:14-25 @ v4.2.0].

**Tracing**
- An internal tracer emits OTLP-shaped spans (`resourceSpans`) to `api.rollbar.com/api/1/session/`; it is off by default [code: src/tracing/defaults.js:5-6; exporter.js:35,62].

**Session replay** (GA October 2025 [docs only] https://docs.rollbar.com/docs/session-replay)
- Built on upstream `@rrweb/record` ^2.0.0-alpha.18 [code: package.json:85].
- Off by default.
- Triggered by an `occurrence` of level `error` or `critical`, keeping `preDuration: 300` s before and `postDuration: 5` s after [code: src/browser/replay/defaults.js:6-20]. **It is an on-error buffer.**
- Masking defaults: only password inputs (`maskAllInputs: false`); classes `rb-block`, `rb-mask` and `rb-ignore` [code: defaults.js:30-58].
- **Transport is notable.** Each rrweb event becomes an OTLP *span event* `rrweb-replay-events` (`eventType`, `json`) on a span named `rrweb-replay-recording`, which the tracer exports [code: src/browser/replay/recorder.js:145-165].
  - This is the only studied vendor that ships replay inside an OTLP-shaped span payload, though to its own endpoint.

### 3.4 Raygun [code]

**Crash reporting:** `raygun4js` with TraceKit stack parsing and breadcrumbs.

**RUM**
- Page and "virtual page" timings: `trackEvent('pageView')` / `virtualPageLoaded(path)` [code: raygun4js/src/raygun.rum/index.js:180-190 @ v3.1.4].
- Web vitals come from the plain `web-vitals` build (no attribution): LCP, FID, CLS, INP, FCP and TTFB [code: src/raygun.rum/core-web-vitals.js:13,36-41].

**Not found:** replay, frustration signals, OTel.

### 3.5 Akamai boomerang / mPulse [code]

boomerang is the oldest open RUM beacon (Yahoo, 2011). It is a core plus a plugin set: `auto-xhr`, `bfcache`, `bw`, `clicks`, `compression`, `continuity`, `errors`, `eventtiming`, `history`, `memory`, `navtiming`, `painttiming`, `restiming`, `rt`, `spa`, `usertiming` and others [code: boomerang/plugins @ 1.815.1].

**Beacon format**
- A flat key/value set using short dotted keys:
  - `t_done`, `rt.start` / `rt.end` [code: plugins/rt.js:10,40]
  - `nt_*` navigation timing
  - `pt.lcp.*` with `pt.lcp.src`, `pt.lcp.el` and `pt.lcp.e` (a pseudo-CSS selector) as LCP attribution [code: plugins/painttiming.js:29-33]
  - `c.cls` with `c.cls.d` sources and `c.cls.tops` (top shift selector) [code: plugins/continuity.js:266-271]
  - `c.c.r` rage-click count (3 or more clicks on the same spot) [code: continuity.js:729, 3182-3227]
  - `c.lt` (compressed long-task log), `c.f.*` frame rate [code: continuity.js:61-153, 737-741]
  - a compressed resource-timing trie (`restiming`), with Server-Timing values [code: plugins/restiming.js:273,660-745]
- `beacon_type: "AUTO"` uses GET when the URL is under `MAX_GET_LENGTH = 2000`, and POST or `sendBeacon` otherwise [code: boomerang.js:415-444, 1252-1259, 4699].
- `beacon_url` can be any URL, so boomerang can be self-hosted with any collector that parses the format.

**Vitals and SPA**
- `eventtiming.js` computes FID, INP, and an "Incremental INP" per SPA navigation [code: plugins/eventtiming.js:6-18].
- `spa.js` labels hard and soft navigations (`http.initiator` `spa_hard` / `spa`) [code: plugins/spa.js:67-101].

**Gaps**
- No LoAF observer at this tag; the Long Tasks API only.
- No trace header injection; backend linkage is via Server-Timing.
- No replay.

**mPulse:** adds collectors, dashboards, session aggregation and alerting on top. No replay [docs only] https://techdocs.akamai.com/mpulse/docs/manage-visitor-requests.

### 3.6 Azure Application Insights JS [code]

**Signals**
- Page views (navigation timing, no Core Web Vitals in the SDK: no `largest-contentful-paint` or `web-vitals` reference in `extensions/` or `shared/`).
- Dependencies (fetch / XHR), exceptions, custom events.
- `enableAutoRouteTracking` for SPAs [code: ApplicationInsights-JS/extensions/applicationinsights-analytics-js/src/JavaScriptSDK/AnalyticsPlugin.ts:65,118 @ v3.4.5].

**Propagation**
- `distributedTracingMode` defaults to `AI_AND_W3C`: `Request-Id` / `Request-Context` plus `traceparent` [code: extensions/applicationinsights-dependencies-js/src/ajax.ts:525,761-762].
- CORS correlation is off by default [docs only].

**Clicks**
- The Click Analytics plugin collects clicks from `data-*` tags as custom events. It is not frustration detection [docs only] https://learn.microsoft.com/en-us/azure/azure-monitor/app/javascript-feature-extensions.

**OTel**
- **3.4.0 (2026) added an OTel-shaped trace API** (`startSpan`, `startActiveSpan`, `IOTelSpanContext`) inside the SDK core [code: shared/AppInsightsCore/src/otel/api/OTelApi.ts; RELEASES.md:38,135-139,214].
- Export is still the Application Insights ingestion format, not OTLP. The Azure Monitor OTel distro covers servers only [docs only] https://learn.microsoft.com/ja-jp/Azure/azure-monitor/app/opentelemetry-faq.

**Not found:** replay.

### 3.7 IBM Instana weasel [code]

**Signals**
- Page loads, resources, XHR / fetch, errors, custom events, SPA page transitions.
- Web vitals from `web-vitals` 3.5.2 (CLS, LCP, FID, INP), no attribution [code: weasel/lib/webVitals.ts:1; package.json:89 @ 1.8.1].

**Propagation**
- Proprietary `X-INSTANA-T`, `X-INSTANA-S` and `X-INSTANA-L` headers by default [code: lib/hooks/xhrHelpers.ts:44-46].
- Optional W3C headers (`enableW3CHeaders`). The 64-bit Instana id is zero-padded into a 128-bit trace id and reused as the parent span id, with flags `03` [code: xhrHelpers.ts:50-58].
- Backend ids also come back via Server-Timing [docs only].

**Other:** no replay; no OTel export.

### 3.8 SpeedCurve LUX [code]

**Focus:** performance only.
- Observes `layout-shift` and **`long-animation-frame`**, with script attribution for INP [code: lux.js/src/lux.ts:173,182 @ v4.5.3].
- Sends with `navigator.sendBeacon` [code: src/transport.ts:10-14].
- Design target: "under 10 KB when minified and compressed" [code: README.md:29].

**Not found:** replay, propagation.

**Ownership:** SpeedCurve was acquired by Embrace in November 2025 [blog only].

### 3.9 Vercel Speed Insights [code]

**What the open package does**
- The npm package only injects the hosted script and passes `sampleRate`, `route` (the dynamic route template) and `beforeSend` [code: speed-insights/packages/web/src/types.ts:3-5; utils.ts:76-90 @ v2.0.0].
- Data goes to `${basePath}/speed-insights/vitals` [code: utils.ts:136].

**Coverage:** web vitals per route only. No errors, tracing or replay.

### 3.10 Cloudflare Web Analytics [docs only]

**Beacon**
- `beacon.min.js` measures LCP, INP and CLS, plus page views.
- Debug View lists the top 5 elements per metric by CSS selector, with LCP and INP sub-parts. That is attribution, done server-side from the beacon.
- No cookies, no localStorage, no fingerprinting.
- Data goes to `/cdn-cgi/rum` on proxied sites, otherwise to `cloudflareinsights.com`, when the page is hidden.
- URLs:
  - https://developers.cloudflare.com/web-analytics/data-metrics/core-web-vitals/
  - https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/

**Not found:** errors, tracing, replay. Beacon size unknown.

### 3.11 Google Analytics 4 [docs only]

- No native Core Web Vitals.
- Google's recipe: the `web-vitals` attribution build sends events to GA4, then BigQuery export and SQL https://web.dev/articles/vitals-ga4.
- GA4 has funnel and path explorations [recall].

### 3.12 Dynatrace [docs only]

**RUM JavaScript**
- Captures user actions, XHR / fetch, errors, CWV and rage clicks (3 or more rapid clicks in one area, counted in a UX score) https://docs.dynatrace.com/docs/observe/digital-experience/rum-concepts/user-and-error-events.

**Propagation**
- `traceparent` plus `tracestate` (with a `dtr` entry), same-origin by default. Server-Timing for documents and resources https://docs.dynatrace.com/docs/observe/digital-experience/new-rum-experience/concepts/frontend-backend-linking.

**Replay**
- Own DOM-mutation recorder ("not video"), beacons `srTe` and `srBm` https://docs.dynatrace.com/docs/observe/digital-experience/session-replay-latest.

**OTel**
- The backend ingests OTLP.
- Dynatrace states OTel has "no stable specification" for RUM, and browser OTel data gets no sessions, user actions, CWV or replay https://docs.dynatrace.com/docs/ingest-from/opentelemetry.

### 3.13 AppDynamics and Splunk [docs only]

**AppDynamics Browser RUM**
- Session replay for browser became available with JS agent 25.9+ and Controller 25.7+ (beta in 25.4). The recording technique is not documented.
- An on-premises Controller exists.

**Splunk RUM**
- `@splunk/otel-web` is built on OTel JS.
- Exports OTLP to a configurable `beaconEndpoint`.
- Rage, dead, error and thrashed-cursor detection.
- `longtask` (deprecated) and LoAF.
- Replay via `@splunk/otel-web-session-recorder` ("rr-web plus OTel JS"), text and inputs masked by default https://docs.splunk.com/observability/rum/rum-session-replay.html.

### 3.14 Catchpoint, TrackJS, Elastic [docs / blog]

- **Catchpoint**: launched web session replay in September 2025. It records DOM changes, clicks, scrolls and form entries, and flags rage clicks, dead clicks, quick backs and bounces [blog only, press release URL in §1.3].
- **TrackJS**: an error agent with a "Telemetry Timeline" (network, console, navigation, interactions) and optional network payloads; proprietary licence https://docs.trackjs.com/browser-agent/.
- **Elastic** (Appendix D): Elastic still tells production users to stay on the classic `elastic-apm-rum`. EDOT Browser is a technical preview and needs a reverse proxy in front of OTLP https://www.elastic.co/docs/solutions/observability/get-started/opentelemetry/switch-to-otel.

### 3.15 Product-analytics vendors with replay [docs only]

**Amplitude**
- Browser SDK 2 autocapture includes `frustrationInteractions`: rage clicks (4 in 1 s) and dead clicks (3 s), with error clicks and thrashed cursor since 2.40.0 https://amplitude.com/docs/en/sdks/analytics/browser/browser-sdk-2.
- Web vitals as values only.
- Network tracking captures headers and bodies but propagates no trace header.
- Replay plugin on an rrweb fork (`amplitude/rrweb`, lazily loaded `@amplitude/rrweb-record`) with an opt-in console plugin.
- "Targeted Replay Capture" starts on an event or URL, forward only, no lookback https://amplitude.com/docs/session-replay/targeted-replay-capture.
- MIT.

**Mixpanel**
- rrweb fork (`@mixpanel/rrweb`) with console on by default and network headers and bodies opt-in.
- Rage clicks (4 in 1 s within 30 px) and dead clicks.
- Conditional sampling per event, forward only.
- Heatmaps from replay data.
- Apache-2.0 https://docs.mixpanel.com/docs/session-replay.

**Heap (Contentsquare)**
- Autocapture, replay add-on, rage clicks; replays also sync into Contentsquare https://developers.heap.io/docs/syncing-heap-data-to-contentsquare.
- Technique unknown; no public agent source.

**Pendo**
- Session replay (GitHub keeps a `pendo-io/rrweb` fork; the docs do not name a library) with opt-in console and network logs.
- Rage, dead and error clicks (an error within 100 ms), and U-turns (back within 7 s).
- Guides, polls / NPS, Feedback, Paths, Funnels https://support.pendo.io/hc/en-us/articles/360034911511-Glossary.

---

## 4. Session replay

### 4.1 Technique per vendor

| Vendor | Recorder | On-error buffer | Source |
|---|---|---|---|
| New Relic | `@newrelic/rrweb` fork. `MODE.ERROR` checks out every 15 s and keeps the buffer until an error; `MODE.FULL` checks out every 5 min. gzip via lazily imported `fflate`. | yes | [code: newrelic-browser-agent/package.json:230; src/features/session_replay/constants.js:22; src/common/session/constants.js:22-25; aggregate/index.js:213] |
| Rollbar | upstream `@rrweb/record`; events as OTLP span events | yes (pre 300 s, post 5 s) | [code: §3.3] |
| Splunk | rrweb-based recorder plus OTel JS; a newer "Splunk recorder" option | unknown | [docs only] |
| Dynatrace | own DOM-mutation recorder | unknown | [docs only] |
| AppDynamics | undocumented | unknown | [docs only] |
| Catchpoint | DOM recording (2025) | unknown | [blog only] |
| Amplitude | `amplitude/rrweb` fork | forward-only trigger | [docs only] |
| Mixpanel | `mixpanel/rrweb` fork | forward-only trigger | [docs only] |
| Pendo | likely `pendo-io/rrweb` fork | unknown | [docs only] |
| Heap / Contentsquare | unknown | unknown | [docs only] |
| Bugsnag, Raygun, App Insights, Instana, mPulse, SpeedCurve, Vercel, Cloudflare, GA4, TrackJS | no replay | n/a | §3 |

### 4.2 Takeaway on recorders

rrweb or an rrweb fork is used by New Relic, Rollbar, Splunk, Amplitude, Mixpanel, Pendo (probably), Sentry, PostHog, LaunchDarkly / Highlight and Faro, as well as ouo.

Own recorders: Datadog, Dynatrace, Fullstory, LogRocket, Clarity and OpenReplay.

---

## 5. Transport and OpenTelemetry

| Vendor | Wire format | OTel position | Source |
|---|---|---|---|
| New Relic | Proprietary harvests (`/events`, `/jserrors`, `/blobs` for replay) | Not OTel. Backend ingests OTLP; browser-to-OTLP discouraged | [code: src/common/harvest/send.js:54-58]; [docs only] |
| Bugsnag performance | **OTLP JSON** `resourceSpans` | OTLP spans to a configurable endpoint; not built on the OTel SDK | [code: §3.2] |
| Rollbar | Proprietary items; OTLP-shaped spans for tracing and replay to `/api/1/session/` | OTLP shape, Rollbar endpoint only | [code: §3.3] |
| App Insights | AI ingestion envelope | OTel trace API shape since 3.4; no OTLP | [code: §3.6] |
| boomerang | Query-string or form beacon, short keys | none | [code: §3.5] |
| Instana | Proprietary beacons | none; optional `traceparent` | [code: §3.7] |
| Dynatrace | Proprietary beacons | Backend OTLP; browser OTel discouraged | [docs only] |
| Splunk | OTLP (or Zipkin) | Built on OTel JS; own-collector export | [docs only] |
| Raygun, LUX, Vercel, Cloudflare | Proprietary beacons | none | §3 |

---

## 6. Other features: the web feature matrix

### 6.1 Feature matrix (25 vendors)

**Cell values**
- `yes` / `partial` / `no` / `unknown`.
- `no` means the vendor's docs or code show no such feature after a search.
- `unknown` means not determinable in this run.
- A superscript number points to a footnote in §6.2.

**Sources**
- The ouo row was verified in this repository at `a283b5b` (§6.2, notes o1–o9).
- Rows marked † rely partly on `[recall]` cells. See the footnotes before quoting them.

**Replay technique codes**
- **RW**: upstream rrweb.
- **RF**: rrweb fork.
- **OWN**: the vendor's own DOM recorder.

#### 6.1a RUM signals

| Vendor | Errors with issue grouping | Source maps | Web vitals with attribution | Soft navigations | Network tracing with backend propagation | Long tasks / LoAF | Frustration (rage / dead / error clicks) |
|---|---|---|---|---|---|---|---|
| **ouo** | partial ᵒ¹ | yes ᵒ² | partial ᵒ³ | yes | yes (traceparent + baggage) | yes (LoAF with script attribution, longtask fallback) | partial (rage, dead) ᵒ⁴ |
| Sentry | yes | yes | yes | yes | yes (`sentry-trace` + `baggage`; `traceparent` opt-in) ¹ | yes (LoAF) | partial (rage, dead) |
| Datadog | yes | yes | yes | yes | yes (datadog, tracecontext, b3) ² | yes (LoAF) ² | yes ² |
| PostHog | yes | yes | yes (INP, LCP) ³ | yes | partial (session-id header, no traceparent) ³ | no ³ | partial (rage, dead) |
| Grafana Faro | partial | yes | yes (v2) | yes (experimental) | yes | unknown | unknown |
| Splunk RUM | yes | yes † | partial | yes | yes | yes (LoAF) | yes (rage, dead, error, thrash) |
| Honeycomb web | partial (no grouping in SDK) | unknown | yes (`lcp.element`, `inp.element`) | partial (`page.route`) | yes | yes (LoAF spans via INP) | no |
| Embrace web | partial | yes | partial | unknown | yes | unknown | unknown |
| LaunchDarkly (Highlight) | yes | yes | partial | unknown | partial (`tracingOrigins`) | unknown | partial (rage) |
| OpenReplay | partial | yes † | partial | yes † | partial (session-token header) | unknown | partial (rage, dead) † |
| Microsoft Clarity | partial (error counts) | no | unknown | unknown | no | unknown | yes (rage, dead, error clicks, quick back) |
| LogRocket | yes | yes | unknown | yes † | partial (`X-LogRocket-URL`) | unknown | yes † |
| Fullstory | unknown | unknown | unknown | unknown | unknown | unknown | yes (rage, dead, error, thrash) |
| New Relic | yes | yes † | yes ⁴ | yes ⁴ | yes (`newrelic` + traceparent) ⁴ | no ⁴ | yes (rage, dead, error) ⁴ |
| Dynatrace | yes † | yes † | partial | yes † | yes (traceparent + `dtr` tracestate) | unknown | partial (rage) |
| AppDynamics | yes † | yes † | unknown | yes † | partial † (ADRUM correlation) | unknown | unknown |
| Elastic (classic RUM) | yes † | yes † | partial † | yes † (framework route integrations) | yes † (traceparent) | yes † (longtask spans) | no † |
| Bugsnag | yes | yes † | partial (own observers, no attribution) ⁵ | yes | partial (experimental traceparent) ⁵ | unknown | no |
| Rollbar | yes | yes † | no | unknown | partial (tracing off by default) ⁶ | no | no |
| Raygun | yes † | yes | partial (no attribution, still FID) ⁷ | yes ⁷ | unknown | unknown | unknown |
| App Insights | yes † | yes | no ⁸ | yes ⁸ | yes (`Request-Id` + traceparent) ⁸ | unknown | no ⁸ |
| Akamai mPulse | partial † | unknown | yes (LCP element, CLS sources) ⁹ | yes ⁹ | no (Server-Timing only) ⁹ | partial (Long Tasks API, no LoAF) ⁹ | partial (rage) ⁹ |
| SpeedCurve LUX | partial (error beacon) | no | yes (LoAF script attribution) ¹⁰ | partial (`LUX.init`) | no | yes (LoAF) ¹⁰ | no |
| Amplitude | no | unknown | partial (values) | yes | no | unknown | yes (rage, dead, error, thrash) |
| Mixpanel | no | no | unknown | unknown | no | unknown | partial (rage, dead) |

#### 6.1b Session replay

| Vendor | Session replay (technique) | Replay on-error buffer | Network bodies in replay | Console in replay |
|---|---|---|---|---|
| **ouo** | yes (RW 2.1.7, patched) ᵒ⁵ | yes (30 to 60 s) ᵒ⁵ | no | partial ᵒ⁶ |
| Sentry | yes (RF) | yes (60 s) | yes (allowlisted URLs) | yes |
| Datadog | yes (OWN) | no † | no | partial (logs beside replay) |
| PostHog | yes (RF) | partial (trigger with pending buffer) ³ | yes (opt-in) | yes |
| Grafana Faro | yes (RF, Cloud preview) | no | no (beside replay) | no (beside replay) |
| Splunk RUM | yes (rrweb-based) | unknown | unknown | unknown |
| Honeycomb web | no | no | no | no |
| Embrace web | unknown | unknown | unknown | unknown |
| LaunchDarkly (Highlight) | yes (RF) | partial (manual start, server filters) | yes | yes |
| OpenReplay | yes (OWN) | partial (`coldStart` buffer, manual trigger) | yes (opt-in, sanitizer) | yes |
| Microsoft Clarity | yes (OWN) | no | no | unknown |
| LogRocket | yes (OWN) | yes (conditional recording, 10 MB lookback) | yes (sanitizers) | yes |
| Fullstory | yes (OWN) | unknown | partial (allowlist) | yes |
| New Relic | yes (RF `@newrelic/rrweb`) ⁴ | yes (error mode) ⁴ | unknown | unknown |
| Dynatrace | yes (OWN) | unknown | unknown | unknown |
| AppDynamics | yes (25.9+, technique unknown) | unknown | unknown | unknown |
| Elastic (classic RUM) | no | no | no | no |
| Bugsnag | no | no | no | no |
| Rollbar | yes (RW `@rrweb/record`) ⁶ | yes (pre 300 s, post 5 s) ⁶ | no ⁶ | partial ⁶ |
| Raygun | no | no | no | no |
| App Insights | no | no | no | no |
| Akamai mPulse | no | no | no | no |
| SpeedCurve LUX | no | no | no | no |
| Amplitude | yes (RF) | partial (forward-only trigger) | no (failed requests only) | yes (opt-in) |
| Mixpanel | yes (RF) | partial (forward-only trigger) | yes (opt-in) | yes |

#### 6.1c Product features

| Vendor | Heatmaps | Funnels | User journeys / paths | Feedback widget | Surveys | Profiling | Feature flag tracking | Alerting on RUM | Release health |
|---|---|---|---|---|---|---|---|---|---|
| **ouo** | no | yes ᵒ⁷ | no | no | no | no | no | partial ᵒ⁸ | yes ᵒ⁹ |
| Sentry | no | no | no | yes | no | yes (JS Self-Profiling) | yes | yes | yes |
| Datadog | yes | yes | yes | unknown | unknown | yes (JS Self-Profiling) ² | yes ² | yes | partial (deployment tracking) |
| PostHog | yes | yes | yes | partial (survey-based) | yes | no | yes | yes | partial (release filter, no crash-free %) |
| Grafana Faro | no | no | no | no | no | no | no | partial (Grafana Alerting) | unknown |
| Splunk RUM | no † | partial (DXA) | unknown | no | no | no | unknown | yes † | unknown |
| Honeycomb web | no | no | no | no | no | no | no | yes (triggers) | no |
| Embrace web | no | no | no | no | no | no | no | unknown | unknown |
| LaunchDarkly (Highlight) | unknown | unknown | unknown | unknown | unknown | unknown | yes (flag evaluations in sessions) | yes | unknown |
| OpenReplay | yes | yes | yes | unknown | unknown | unknown | unknown | unknown | unknown |
| Microsoft Clarity | yes | yes [blog only] | unknown | no | no | no | no | unknown | no |
| LogRocket | yes | yes | yes | unknown | unknown | unknown | unknown | unknown | unknown |
| Fullstory | yes † | yes | yes † | unknown | unknown | no | unknown | unknown | no |
| New Relic | unknown | partial (NRQL `funnel()`) | yes (User Journeys Sankey) | unknown | unknown | unknown | unknown | yes † | partial † |
| Dynatrace | unknown | yes † (USQL `FUNNEL`) | partial † | unknown | unknown | unknown | unknown | yes † | partial † |
| AppDynamics | unknown | unknown | unknown | unknown | unknown | unknown | unknown | yes † | unknown |
| Elastic (classic RUM) | no | no | no | no | no | no | no | yes † (Kibana rules) | partial † (service.version) |
| Bugsnag | no | no | no | unknown | no | no | yes ⁵ | yes † | yes † (stability score) |
| Rollbar | no | no | no | no | no | no | unknown | yes † | partial † (versions / deploys) |
| Raygun | no | no | no | no | no | no | no | yes (P75 vitals alerts) | unknown |
| App Insights | no | yes † | yes † (User Flows) | no | no | no | no | yes † | no |
| Akamai mPulse | no (geographic "heat map" only) | unknown | unknown | no | no | no | no | partial | no |
| SpeedCurve LUX | no | no | no | no | no | no | no | yes † | no |
| Amplitude | yes | yes | yes | partial (via surveys) | yes | no | yes (Experiment) | yes | no |
| Mixpanel | yes (web, recorded sessions) | yes | yes (Flows) | unknown | unknown | no | yes | yes | no |

#### 6.1d Openness

| Vendor | OTel / OTLP export to the customer's collector | Self-hostable | Open-source browser SDK (licence) |
|---|---|---|---|
| **ouo** | yes (spans and logs as OTLP/HTTP; replay on the collector's own receiver) | yes | yes (Apache-2.0) |
| Sentry | partial (backend ingests OTLP; browser sends envelopes) | yes (self-hosted Sentry) | yes (MIT) |
| Datadog | partial (traceparent only; no OTLP of RUM) | no | yes (Apache-2.0) |
| PostHog | no (batch exports to warehouses; OTLP ingest only) | yes (hobby deploy) | yes (MIT) |
| Grafana Faro | partial (Faro protocol; Alloy `otelcol.receiver.faro` converts) | partial (Alloy + LGTM; Cloud app and replay are not) | yes (Apache-2.0) |
| Splunk RUM | yes (OTel JS, configurable endpoint) | no | yes (Apache-2.0) |
| Honeycomb web | yes | no (backend) | yes (Apache-2.0) |
| Embrace web | yes (spans and logs to any CORS-enabled OTLP endpoint) | no | yes (Apache-2.0) |
| LaunchDarkly (Highlight) | partial (built on OTel JS, exports to LaunchDarkly) | partial (the Highlight repo still exists; hosted Highlight ended 2026-02-28) | yes (Apache-2.0) |
| OpenReplay | no | yes | yes (tracker MIT; backend AGPL-3.0, `ee/` separate) |
| Microsoft Clarity | no | partial (recorder and player open; no backend) | yes (MIT) |
| LogRocket | unknown | yes (enterprise deploy) [blog only] | partial (npm MIT label, no source) |
| Fullstory | unknown | no | partial (MIT loader; recorder closed) |
| New Relic | no (backend ingests OTLP) | no | yes (Apache-2.0) |
| Dynatrace | no (backend ingests OTLP) | yes † (Managed) | no |
| AppDynamics | no | yes (on-prem Controller) | no |
| Elastic (classic RUM) | partial (EDOT Browser preview) | yes | yes (MIT) |
| Bugsnag | partial (performance spans are OTLP JSON to a configurable endpoint) ⁵ | partial † (on-prem) | yes (MIT) |
| Rollbar | no (OTLP-shaped, Rollbar endpoint only) ⁶ | no | yes (MIT) |
| Raygun | no | no | yes (MIT) |
| App Insights | no (OTel API shape, AI wire format) ⁸ | no | yes (MIT) |
| Akamai mPulse | no | partial (boomerang beacons to any URL; mPulse is SaaS) | yes (boomerang, BSD-3) |
| SpeedCurve LUX | no | no | yes (BSD-3) |
| Amplitude | no | no | yes (MIT) |
| Mixpanel | no | no | yes (Apache-2.0) |

### 6.2 Footnotes

**ouo row** (repository at `a283b5b`)
- ᵒ¹ Exceptions are OTel log records with source-mapped stacks, shown per session and in the replay activity panel. There is no issue page and no fingerprinting: no `fingerprint` or `grouping` code in `services/`, `collector/` or `plugins/ouo11y-rum-app/src`. The plugin pages are `Overview`, `Sessions`, `SessionDetail` and `Funnels` only.
- ᵒ² rum-api `PUT /v1/sourcemaps`, `GET /v1/sourcemaps` and `POST /v1/symbolicate` [code: services/rum-api/internal/httpapi/server.go:112-114]. Stack parsing covers V8, SpiderMonkey and JavaScriptCore [code: services/rum-api/internal/sourcemap/stack.go]. The plugin renders `symbolicated` stacks [code: plugins/ouo11y-rum-app/src/components/ReplayActivity.tsx:164].
- ᵒ³ `sdk/browser/src/vitals.ts:1` imports `web-vitals`, not `web-vitals/attribution`. Events carry value, rating, delta, navigation type and `url.path`, but no LCP element, INP target or phase breakdown.
- ᵒ⁴ `ouo.rage_click` and `ouo.dead_click` [code: sdk/browser/src/interactions/clicks.ts:8-17]. There is no error-click class.
- ᵒ⁵ rrweb `record` with `maskAllInputs`, no canvas or fonts [code: sdk/browser/src/replay/recorder.ts:304-318]. The buffer mode is selected by `onErrorSampleRate` [code: recorder.ts:65,214].
- ᵒ⁶ `console.error` becomes an `exception` event, shown on the replay activity panel. `console.log` / `warn` are not captured, and no rrweb console plugin is used.
- ᵒ⁷ `Funnels.tsx` page; rum-api `POST /v1/funnels/query`, `GET /v1/funnels/dropped` and `GET /v1/funnels/steps` [code: server.go:115-117].
- ᵒ⁸ The stack runs Mimir with an Alertmanager [code: deploy/compose/quickstart.yaml:699-700], so Grafana Alerting works on the RUM data in Loki, Tempo and Mimir. No RUM alert rules are shipped.
- ᵒ⁹ The Overview shows session health tiles per platform and a per-`service.version` table [code: plugins/ouo11y-rum-app/src/pages/Overview.tsx:80-110; components/VersionTable.tsx:34-42]. It is session health per release, not crash-free users.

**Other vendors**
1. Sentry: Appendix A has the code detail.
2. Datadog [code: browser-sdk]:
   - Frustration types `rage_click`, `error_click` and `dead_click` [packages/browser-rum-core/src/rawRumEvent.types.ts:376-378 @ v7.16.2].
   - LoAF `entry_type` [packages/browser-rum-core/src/rumEvent.types.ts:580].
   - Propagators `datadog`, `tracecontext` and `b3` [packages/browser-rum-core/src/domain/tracing/tracer.ts:188-208].
   - JS Self-Profiling schema [packages/browser-rum/src/types/profiling.ts:189-210].
   - `addFeatureFlagEvaluation` [packages/browser-rum-core/src/boot/rumPublicApi.ts:443].
3. PostHog [code: posthog-js/packages/browser/src @ dfb2e002]:
   - INP and LCP attribution on by default, CLS excluded for leaks [extensions/web-vitals/index.ts:27-30].
   - `X-POSTHOG-SESSION-ID` header, no `traceparent` [entrypoints/tracing-headers.ts:9].
   - No `long-animation-frame` or `longtask` reference.
   - Trigger-pending buffer of 1 s to 1 h [extensions/replay/external/lazy-loaded-session-recorder.ts:115-116].
4. New Relic: §3.1 and §4.1. The `no` for long tasks is the code at v1.324.1. Docs for v1227 describe an opt-in long-task feature that is no longer in the source.
5. Bugsnag: §3.2.
6. Rollbar: §3.3. Telemetry can capture network bodies (off by default), but they go into telemetry, not into the rrweb stream. The press release says console and network are linked to each replay [blog only].
7. Raygun: §3.4.
8. App Insights: §3.6.
9. boomerang / mPulse: §3.5.
10. SpeedCurve LUX: §3.8.
- † At least one cell in the row is `[recall]`. Those cells are listed in §9 Q10 as the recheck list.

### 6.3 Coverage counts (25 vendors)

Counted from the tables in §6.1. `unknown` counts as absent, so every figure is a floor. `[recall]` cells are included.

| Column | yes | partial | Read |
|---|---|---|---|
| Errors (grouped or not) | 14 | 8 | table stakes; **grouping** is the split |
| Web vitals | 8 | 10 | table stakes; **attribution** is the split (8 yes) |
| Network tracing with propagation | 11 | 7 | table stakes for APM-born vendors; absent at analytics vendors |
| Source maps | 18 | 0 | table stakes for anyone with errors |
| Soft navigations | 17 | 2 | table stakes |
| Session replay | 17 | 0 | table stakes |
| Alerting on RUM | 17 | 3 | table stakes |
| Frustration signals | 7 | 8 | common; error clicks are rarer (Datadog, New Relic, Splunk, Amplitude, Clarity, Fullstory) |
| Funnels | 11 | 2 | split: analytics vendors, PostHog, Datadog, OpenReplay, LogRocket, Clarity, Dynatrace, App Insights, ouo |
| Console in replay | 8 | 3 | common among replay vendors |
| Paths / journeys | 9 | 1 | analytics vendors plus New Relic, App Insights, Datadog |
| Heatmaps | 8 | 0 | analytics and replay vendors only |
| Long tasks / LoAF | 7 | 1 | under a third |
| Feature flags | 7 | 0 | minority |
| Network bodies in replay | 6 | 1 | replay specialists, Sentry, Mixpanel, PostHog |
| Replay on-error buffer | 5 | 5 | **true lookback buffers are rare**: ouo, Sentry, LogRocket, New Relic, Rollbar |
| Release health | 3 | 6 | rare as a first-class view: Sentry, Bugsnag, ouo |
| OTLP to the customer's collector | 4 | 6 | **rare**: ouo, Splunk, Honeycomb, Embrace |
| Self-hostable | 8 | 5 | minority |
| Open-source browser SDK | 21 | 2 | table stakes; only Dynatrace and AppDynamics are fully closed |
| Surveys | 2 | 0 | analytics vendors only |
| Profiling | 2 | 0 | Sentry, Datadog only |
| Feedback widget | 1 | 2 | rare |

---

## 7. Performance footprint

| Vendor | Published or code-stated size | Source |
|---|---|---|
| SpeedCurve LUX | target "under 10 KB minified and compressed" | [code: lux.js/README.md:29] |
| New Relic | four CDN builds (`lite`, `pro`, `spa`, `experimental`); sizes not stated in the repo | [code: src/cdn/*.js] |
| New Relic replay | rrweb and `fflate` are lazily imported chunks; `AVG_COMPRESSION = 0.12` is assumed for payload sizing | [code: src/features/session_replay/constants.js:12; aggregate/index.js:213] |
| Rollbar replay | separate bundle `rollbar.replay.min.js`, so the error notifier does not carry rrweb | [docs only] |
| Vercel | npm part is a loader only; the hosted script size is not published | [code: utils.ts:76-90] |
| boomerang | flavors from full to minimal, chosen to trade plugins for size | [docs only] |
| Cloudflare, Dynatrace, AppDynamics, Instana, Raygun, App Insights | not published in what was read | - |

Appendix M measures ouo, Sentry, Datadog, PostHog, Faro and Splunk on one page. None of the vendors in this appendix publishes a measurement method.

---

## 8. Blog-to-code grounding

| Claim | Where it is published | Code |
|---|---|---|
| New Relic session replay uses rrweb | docs | yes: `@newrelic/rrweb` [package.json:230] |
| New Relic replay can keep a buffer until an error | docs ("error sample rate") | yes: `MODE.ERROR`, 15 s checkouts [constants.js:22] |
| New Relic rage clicks = 4 clicks within 1 s | docs | yes [generic_events/constants.js:13-14] |
| New Relic long tasks (v1227 release notes) | release notes | **not found** at v1.324.1 |
| Rollbar replay captures time before an error | docs (60 or 300 s, inconsistent) | 300 s default [replay/defaults.js:12] |
| Rollbar replay is rrweb | inferred from span name in docs | yes: `@rrweb/record` [package.json:85] |
| Bugsnag performance is "OpenTelemetry compatible" | docs | OTLP JSON wire format [core/lib/delivery.ts:35,90]; not built on the OTel SDK |
| Instana supports W3C trace context | docs | yes, opt-in; zero-padded 64-bit id, span id = trace id [xhrHelpers.ts:50-58] |
| SpeedCurve uses LoAF for INP attribution | blog | yes [lux.ts:182] |
| App Insights "OpenTelemetry-based APIs" in v3.x | RELEASES.md | an OTel-shaped trace API in core; exporter unchanged [shared/AppInsightsCore/src/otel] |
| Raygun captures INP | docs | yes, beside FID, without attribution [core-web-vitals.js:36-41] |

---

## 9. Questions asked and answers

1. **Is New Relic's browser replay rrweb-based?**
   - Yes. It uses the fork `@newrelic/rrweb` with `inlineStylesheet: true` and gzip via `fflate` in a lazily loaded chunk.
   - It has three modes (off, full, error).
   - [code: package.json:230; session_replay/shared/recorder.js:115-124; aggregate/index.js:213]
2. **What are New Relic "session traces"?**
   - A per-page waterfall of resources, events and ajax.
   - In error mode it keeps a 30 s sliding window and harvests only if an error occurs [code: session_trace/constants.js:16].
   - ouo's equivalent is the `documentLoad` span plus fetch spans in Tempo.
3. **How does New Relic detect soft navigations?**
   - An interaction opens on `click`, `keydown`, `submit` or `popstate`, and includes URL and DOM changes.
   - It ends after 5 s without a long task [code: soft_navigations/constants.js:7-18].
   - ouo ends its `soft-navigation` span after 1 s idle with no request and no mutation (`tracing.idleTimeoutMs`).
4. **Does any vendor here ship replay over OTLP?**
   - Rollbar, in shape only: rrweb events as span events on `rrweb-replay-recording`, sent to Rollbar's own endpoint [code: rollbar.js recorder.js:145-165].
   - Nobody exports replay to the customer's collector.
5. **Does App Insights do OTel now?**
   - It has an OTel-shaped *API* (spans, span context, trace state) since 3.4, beta February 2026 [code: RELEASES.md:135-139].
   - The wire format is still Application Insights.
   - No replay, no web vitals.
6. **Is Instana weasel open source?** Yes, MIT, and it is the full in-browser agent [code: weasel/LICENSE].
7. **What is boomerang's beacon format?**
   - URL-encoded key/value pairs, sent by GET under 2000 characters and otherwise by POST or `sendBeacon` [code: boomerang.js:425-444,1259,4699].
   - Plugin-namespaced keys (`rt.*`, `nt_*`, `pt.lcp.*`, `c.*`, `restiming`).
   - It has LCP and CLS attribution and an Incremental INP per SPA navigation.
8. **Which vendors propagate `traceparent` by default?**
   - Datadog (`tracecontext` among its propagators), App Insights (`AI_AND_W3C`), Dynatrace, Splunk, Honeycomb, Embrace and ouo.
   - New Relic does same-origin only, cross-origin W3C is opt-in.
   - Bugsnag is experimental.
   - Instana is opt-in.
   - Sentry defaults to `sentry-trace` + `baggage`.
   - PostHog sends its own session header.
9. **How do the analytics vendors' "on-error" replays differ from Sentry's?**
   - Amplitude and Mixpanel trigger forward only, so nothing before the trigger is kept.
   - True lookback buffers: Sentry (60 s), ouo (30 to 60 s), New Relic (error mode), Rollbar (300 s) and LogRocket (10 MB).
10. **Which cells are `[recall]` and must be rechecked before quoting?**
    - Splunk source maps; Splunk heatmaps and alerting.
    - OpenReplay source maps, soft navigations and frustration.
    - LogRocket soft navigations and frustration.
    - Fullstory heatmaps and paths.
    - New Relic source maps, alerting and release health.
    - Dynatrace errors, source maps, soft navigations, funnels, paths, alerting, release health and Managed.
    - AppDynamics errors, source maps, soft navigations, propagation and alerting.
    - Every Elastic cell.
    - Bugsnag source maps, alerting, release health and on-prem.
    - Rollbar source maps, alerting and release health.
    - Raygun error grouping.
    - App Insights errors, funnels, paths and alerting.
    - mPulse errors.
    - SpeedCurve alerting.
    - Datadog on-error buffer.

---

## 10. Takeaways for ouo

### 10.1 Table stakes

These columns are present (yes or partial) at 17 or more of the 25 vendors (§6.3). ouo has to have them:
- errors
- source maps
- web vitals
- soft navigations
- network tracing with backend propagation
- session replay
- alerting
- an open-source browser SDK

ouo has each of them, with three gaps:
- **errors are not grouped into issues**. Every APM-born vendor (Sentry, Datadog, New Relic, Dynatrace, Bugsnag, Rollbar, Raygun, LogRocket, LaunchDarkly) groups them.
- **web vitals have no attribution**. Eight vendors send the LCP element or INP target. Cloudflare, boomerang and LUX (a sub-10 KB script) show it fits in a small beacon.
- **alerting is generic Grafana**, with no shipped RUM rules.

### 10.2 Common but not universal

Frustration signals, heatmaps, funnels, paths and feature flags.
- **Frustration:** ouo has rage and dead clicks. Error clicks (Datadog, New Relic, Splunk, Amplitude, Clarity, Fullstory, Pendo) are cheap to add: a click followed by an `exception` in the same interaction span.
- **Funnels:** ouo has them, which puts it with the analytics vendors and Datadog. Sentry, Faro, Honeycomb and Elastic do not have funnels.
- **Paths / journeys:** ouo is absent. New Relic builds its User Journeys Sankey from interaction events, which ouo already emits as `navigation` and `soft-navigation`.

### 10.3 Differentiators ouo already holds

- **OTLP to the customer's own collector:** 4 yes in 25 (ouo, Splunk, Honeycomb, Embrace).
  - Only ouo pairs it with replay, an on-error lookback buffer, funnels and self-hosting.
  - Splunk has replay but is not self-hostable.
  - Honeycomb and Embrace have no replay.
- **A true replay lookback buffer:** 5 vendors (ouo, Sentry, New Relic, Rollbar, LogRocket).
- **LoAF with script attribution:** ouo, Datadog, Splunk, SpeedCurve, Sentry and Honeycomb (via INP). Missing at New Relic, PostHog and boomerang at the tags read.

### 10.4 Where ouo is absent

- issue grouping
- vitals attribution
- error clicks
- network bodies in replay
- `console.log` / `console.warn` in replay
- heatmaps
- paths / journeys
- feedback widget
- surveys
- profiling
- feature flag tracking
- shipped RUM alert rules

Of these, three are cheap and OTel-shaped:
- **vitals attribution:** switch to `web-vitals/attribution` and add attributes.
- **feature flags:** the OTel semconv `feature_flag.evaluation` event already exists.
- **error clicks:** described in §10.2.

Two need product work:
- **issue grouping:** a fingerprint over symbolicated frames in rum-api.
- **paths:** a Sankey over `navigation` events in the plugin.

Heatmaps, surveys and profiling are analytics- or vendor-specific. Only Sentry and Datadog ship profiling.

### 10.5 Prior art to copy

- **Rollbar's replay-as-span-events.** It is a working example of rrweb inside an OTLP-shaped payload (`rrweb-replay-recording` span, one event per rrweb event). That is useful input if ouo ever wants replay on the plain OTLP path instead of its own `/v1/replay/chunks` receiver.
  - Cost: per-event JSON-in-attribute overhead.
  - ouo's chunked gzip is the cheaper wire.
- **Bugsnag's `<meta name="traceparent">` page-load link** matches ouo's. Bugsnag also chose OTLP JSON as its wire format without the OTel SDK. Two independent vendors reached the same design.
