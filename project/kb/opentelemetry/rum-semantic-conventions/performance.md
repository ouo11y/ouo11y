# RUM conventions: web vitals and mobile performance

Rules, status words and sources are in [rules.md](rules.md). Choices here are **Proposed**.

## Web vitals: LCP, INP, CLS, FCP, TTFB

**What OTel defines.** Event `browser.web_vital`, Dev core (v1.45.0, `model/browser/events.yaml`). Attributes: `browser.web_vital.name` (`cls`, `lcp`, `fcp`, `inp`, `ttfb`, plus a legacy `fid`), `.value`, `.delta`, `.id` (all required), `.rating` and `.navigation_type` (recommended). It was left out of the client-side migration so far (client-side #35 asks where it should live).

The OTel browser instrumentation also emits `browser.web_vital.navigation_id` and `.navigation_url`, which are SDK only. Its `reportAllChanges` defaults to false, so it emits a final value once, and `delta` equals `value`. It has a `reportSoftNavs` option.

**Attribution (INP).** Draft. Client-side #35, Nov 3 Client SIG: define a small set of attributes and keep the full attribution object in the body. Names under discussion, `browser.web_vital.attribution.`: `interaction_target`, `interaction_type`, `input_delay`, `processing_duration`, `presentation_delay`. The durations were the proposer's addition, not agreed on the call. Browser PR #486 implements the longer list as opt-in. Open: URL and target may be opt-in since they can carry user data.

**Event or span: event.** The browser reports each vital after the fact as a number. It has no children, must survive tab death, and is the convention.

**Metric too?** Not from the client. The browser roadmap leans "events-first", and Step 1 showed short-lived clients do not fit the metric single-writer model. The percentiles come from a server-side derivation (Q6, Q7).

| Question | Answer |
|---|---|
| Q6 | One event per vital, no client metric |
| Q7, single writer | Derive at the edge Collector with `signaltometrics` (alpha in contrib) or by backend queries. Needs a test in Step 3 or later |
| Q8, CLS histogram | Exponential histogram, which needs no chosen buckets and becomes a Mimir native histogram. Whether `signaltometrics` emits one is from memory, so check it. Fallback: fixed buckets around the 0.1 and 0.25 thresholds |
| Q9, final or repeats | Emit once when the value is final (page hide), matching the OTel default. The consumer keeps the last value per `browser.web_vital.id` so a bfcache restore or repeat cannot double-count |

**Attribution prediction.** Names from #35 land, High for the three grouping attributes, Medium for durations. We emit #35's names. If they change, the Collector rename table handles it.

**Attributes we need beyond the convention:** `browser.document.url.full` (sanitised, see [propagation entry](propagation-and-resources.md)), `session.id`, `ouo.view.id`. Keep the full attribution object in the body.

**Long frames.** `browser.long_animation_frame` event, Draft (PR #429, log records, replacing the Long Tasks API). Adopt when it merges. This is the web's closest match to jank.

| | Sentry | Datadog | PostHog |
|---|---|---|---|
| Vitals | spans `ui.webvital.lcp`, `ui.webvital.cls` | fields on `view`: `largest_contentful_paint`, `interaction_to_next_paint`, `cumulative_layout_shift`, `first_byte` | `$web_vitals` event |
| Target of LCP or INP | | `largest_contentful_paint_target_selector`, `interaction_to_next_paint_target_selector` | |

The gap to note: Datadog folds all vitals into one updating view record. OTel and PostHog emit discrete events.

## App start

**What OTel defines.** Nothing in core. Android emits span `AppStart` with `start.type` (`cold`, `warm`, `hot`), SDK only. iOS: Swift has no per-launch signal, only MetricKit 24-hour averages such as `metrickit.app_launch.time_to_first_draw_average`. A 24-hour average cannot answer questions about one session.

**Event or span: span, created after the fact.** It is the mobile twin of `documentLoad`: a load phase with a known start and end, which may parent network calls. Create it when first frame is drawn, with the start time set to process start. It is therefore never open, and a process killed during launch loses only this one record.

**Prediction.** OTel standardises a span or event around "app start" with cold and warm types. Name unknown. Span: Medium. Name: Low.

**Ours.** Span `AppStart` with `start.type`, following Android (tier 2). Add `ouo.app.start.prewarmed` (boolean) on iOS, since OS prewarming distorts launch times. Fallback: rename table.

| | Sentry | Datadog | PostHog |
|---|---|---|---|
| App start | spans `app.start.cold`, `app.start.warm` | `application_start` | `Application Opened` event |
| First display | `ui.load.initial_display`, `ui.load.full_display` | `time_to_initial_display`, `time_to_full_display` | |

Gap: OTel has no first-display concept. Step 3 decides whether we need one; `ouo.` if so.

## Jank and hangs

**Jank.** Event `app.jank`, Dev core. Attributes `app.jank.frame_count`, `.threshold`, `.period`. Android emits it for slow (over 16 ms) and frozen (over 700 ms) frames per polling period. It is an aggregate per window, so it is cheap, and it is suitable for iOS and React Native as well. **Event.** Confidence High.

**ANR (Android).** Event `device.anr`, SDK only (Android registry), with `exception.stacktrace`. Android detects 5 failed 1-second checks. **Event**, tier 2. Name confidence Medium, because the `device` namespace does not fit well next to `app.crash`.

**iOS hang.** No convention. Swift only reports `metrickit.diagnostic.hang`, delayed and aggregated. **Event** `ouo.app.hang`, with `ouo.app.hang.duration` (seconds), `exception.stacktrace`, and `session.id`. Prediction: an `app.hang` or a merge with ANR into one event. Name confidence Low. Fallback: rename table. React Native uses the native signal of its platform.

A hang can be emitted only after the main thread recovers. If the app is killed while hanging, persist and send on next launch, the same as a crash.

| | Sentry | Datadog | PostHog |
|---|---|---|---|
| Hang | `App Hanging` | `App Hang`, also `long_task` | |
