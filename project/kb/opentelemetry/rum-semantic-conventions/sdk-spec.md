# ouo11y client SDK specification

| | |
|---|---|
| Spec version | `0.1.0-draft` |
| Status | **Draft.** Step 3 of the post-MVP plan. Moves to `docs/specs/` after Step 7 |
| Date | 2026-11-09 |
| Covers | Web, iOS, Android, React Native |
| Built on | OTel semantic conventions v1.45.0, client-side registry v0.1.0-dev, OTLP v1.11.1, and the [Step 2 entries](index.md) |
| Not derived from | Any vendor SDK, the MVP SDKs, `project/kb-archive/` or `docs/adr-archive/`. Step 5 measures our SDKs against this; Step 6 researches vendors; Step 7 reviews this text with both |

## 0. How to read this spec

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY and OPTIONAL are used as described in RFC 2119 and RFC 8174.

Every normative statement has an id such as **SES-4**. [Section 14](#14-conformance) says how each is tested.

| Marker | Meaning |
|---|---|
| `[OPEN Dn]` | Rests on a founder decision that is not yet made. The text applies the recommendation. [Section 17](#17-open-decisions) says what changes under the other answer |
| `[Pn]` | Rests on a prediction, not a published Stable convention. [Section 16](#16-prediction-register) gives its confidence and fallback |
| *Default* | A value an SDK ships and an app can change. Numeric defaults are starting points for Step 5 to confirm |

Platform words: **web** is a browser page. **mobile** is iOS, Android and React Native. **RN** is React Native alone.

## 1. Scope and relation to OpenTelemetry

The SDK observes one running client application and sends what it observes as OTLP to an OpenTelemetry Collector. It does not query, aggregate or store on behalf of a backend.

| OTel part | Web | iOS | Android | RN |
|---|---|---|---|---|
| Wire protocol | OTLP/HTTP (used as is) | same | same | same |
| Semantic conventions | Used as written where they exist, by the Step 2 [naming rule](rules.md) | same | same | same |
| API and SDK | Use where Step 5 shows the bundle budget allows; otherwise an equivalent internal implementation | Wrap `opentelemetry-swift` | Wrap `opentelemetry-android` | No OTel RN SDK exists. JS bridges to the native SDK ([section 6.8](#68-react-native-boundaries)) |
| What we add | Sessions with user-activity semantics, session sampling, view id, privacy defaults, delivery rules, replay | same | same | same plus the JS/native split |

- **REL-1** An SDK MUST be judged by its behaviour and its wire output. This spec does not require any particular library internally.
- **REL-2** All telemetry MUST leave the device as OTLP sent to a configured Collector endpoint. An SDK MUST NOT send telemetry to any other destination or use a non-OTLP format.
- **REL-3** Attributes and events we define MUST be prefixed `ouo.`. Names that OTel defines, or that an official OTel SDK already emits, are used unprefixed. `[OPEN D1]`
- **REL-4** An SDK MUST NOT replace a tracer, logger or meter provider that the host has already registered globally, and it MUST NOT register its provider globally unless configured to.
- **REL-5** The SDK MUST expose its OTel tracer and logger providers, so host instrumentation can emit through the same pipeline and receive the same session and view attributes.
- **REL-6** The SDK MUST NOT export client OTel metrics for RUM signals. Aggregates are derived at the edge from events. Short-lived clients do not fit the single-writer metric model ([Step 2](performance.md)).
- **REL-7** Span events MUST NOT be used. Events go through the Logs API with a non-empty `EventName` (OTEP 4430).

## 2. Terms

| Term | Definition |
|---|---|
| Record | One OTLP log record or span |
| Event | A log record with a non-empty `EventName` |
| Session | A time-boxed correlation id for one period of user presence. Not a user identity |
| View | One visit to one page or screen |
| Activity | A signal of user presence, listed in **SES-5**. Telemetry is not activity |
| Durably accepted | The receiver answered per **TRN-12**. The sender may then forget the data |
| Bypass set | The events sent from an unsampled session (**SMP-5**) |
| Replay, stream, segment, chunk | [Section 11](#11-replay-contract) |

## 3. Public API and configuration

### 3.1 API

Names show the concept. Each platform uses its idiom. RN exposes the same surface as web.

| Function | Effect |
|---|---|
| `init(config)` | Start the SDK |
| `shutdown()` | Stop capture, flush, release resources |
| `flush()` | Export what is queued. Resolves when done or on deadline |
| `getSessionId()` | Current id, or none |
| `restartSession()` | End this session and start a new one |
| `setUser(id \| null)` | Set or clear `enduser.id` |
| `setConsent({telemetry, replay})` | Update consent ([section 10.1](#101-consent)) |
| `setGlobalAttributes(map)` | Attributes for every later record |
| `recordEvent(name, attributes?, body?)` | Custom event |
| `recordException(error, attributes?)` | Handled error. Attributes may include `ouo.exception.fingerprint` |
| `trackNavigation(name, {url?, id?})` | Declare a soft navigation (web) or screen view (mobile), for routers that automatic capture cannot see |
| `getTracerProvider()`, `getLoggerProvider()` | OTel access (**REL-5**) |
| `replay.start()`, `replay.stop()`, `replay.capture()` | Start, stop, or trigger a buffered replay |
| `replay.mask(target)`, `replay.unmask(target)` | Mobile view-level masking. Web uses attributes (**PRV-6**) |

- **API-1** Every public function MUST be safe to call before `init`, after `shutdown`, and on an unsupported platform. It MUST then be a no-op that does not throw.
- **API-2** A public function MUST NOT block the calling thread on I/O or network, and any waiting API MUST be asynchronous.
- **API-3** `recordEvent` and attribute setters MUST reject app-supplied names in the reserved prefixes `session.` and `ouo.`, except attributes this spec lists as app-settable. A rejected name MUST be dropped, counted (**ERR-7**) and MUST NOT throw.
- **API-4** Per-platform APIs SHOULD be named the same, apart from language casing.
- **API-5** `trackNavigation` MUST behave exactly like the equivalent automatic navigation, including new `ouo.view.id` assignment. If both report the same navigation, one signal MUST be emitted.
- **API-6** `recordException` MUST set `ouo.exception.source=manual` and `ouo.exception.handled=true`, unless the caller set `handled`.

### 3.2 Configuration

| Key | Default | Platforms |
|---|---|---|
| `endpoint` | required | all |
| `headers` | none | all |
| `serviceName`, `serviceVersion`, `environment` | `serviceName` required | all |
| `session.inactivityTimeoutMs` | 1 800 000 (30 min) | web |
| `session.backgroundTimeoutMs` | 900 000 (15 min) | mobile |
| `session.maxDurationMs` | 14 400 000 (4 h) | all |
| `sampling.sessionRate` | 1.0 | all |
| `sampling.bypass.perSessionCap` | 10 | all |
| `replay.mode` | `off` | all |
| `replay.sessionRate`, `replay.bufferRate` | 0.0, 0.0 | all |
| `replay.format` | Platform default ([section 11.6](#116-format-is-pluggable)) | all |
| `consent.required` | false | all |
| `privacy.urlQueryAllow` | empty | web, mobile |
| `privacy.keepUrlFragment` | false | web |
| `privacy.captureWidgetName` | false | mobile |
| `sanitizeUrl`, `beforeSend` | none | all |
| `propagation.urls` | same origin only on web; none on mobile | all |
| `propagation.sessionBaggage` | false `[OPEN D4]` | all |
| `transport.*` | [section 8](#8-transport) | all |
| `debug` | false | all |
| `diagnostics.selfDisableThreshold` | 20 | all |
| `instrumentations.<signal>` | on, except as noted in [section 6](#6-signals) | all |

- **CFG-1** Invalid configuration MUST NOT throw. An invalid value MUST fall back to its default with a diagnostic. If `endpoint` or `serviceName` is missing or invalid, the SDK MUST act as a no-op.
- **CFG-2** Out-of-range values MUST be clamped: inactivity and background timeouts to at least 1 minute, maximum duration to at most 24 hours, rates to [0, 1].
- **CFG-3** `headers` values may be public ingest keys, and MUST NOT appear in URLs, records or diagnostics.
- **CFG-4** A `beforeSend` hook MUST run before persistence and export. It MAY return a modified record or drop it, a hook that throws MUST be treated as returning the unmodified record, and it MUST NOT receive replay chunks.

## 4. Lifecycle

### 4.1 All platforms

- **LIF-1** A second `init` MUST be ignored with a diagnostic.
- **LIF-2** `init` MUST return without waiting for network, storage or a native bridge. Slow work continues asynchronously.
- **LIF-3** Records created between `init` and storage readiness MUST be held in a bounded memory buffer, then processed normally.
- **LIF-4** `shutdown` MUST stop all capture, remove every hook it installed, emit `session.end` if a session is active, close open replay streams (**RPL-20**), and attempt a flush bounded by `transport.shutdownDeadlineMs` (*default* 2 s).
- **LIF-5** After `shutdown`, `init` MAY be called again and MUST behave as a new start.

### 4.2 Web

| Event | Required behaviour |
|---|---|
| `visibilitychange` to hidden | Finalise vitals (**SIG-01**). Flush telemetry. Close the current replay chunk. Hidden is the last event mobile browsers reliably fire |
| `pagehide` | Run **LIF-7**. End the stream |
| `pageshow` with `persisted=true` | Treat as a bfcache restore (**LIF-8**) |
| `visibilitychange` to visible | Counts as activity (**SES-5**) |
| `freeze` / `resume` | Flush on freeze. On resume, re-evaluate the session |

- **LIF-6** An SDK MUST NOT register `unload` or `beforeunload` handlers, since they can disable the back/forward cache.
- **LIF-7** At `pagehide`, in this order, the SDK MUST: end in-flight fetch and XHR spans with `ouo.span.abandoned=true` `[P18]`; emit remaining final vitals; close the current replay chunk and emit `ouo.replay.ended`; flush telemetry; then flush replay chunks with the remaining budget (**TRN-16**).
- **LIF-8** On bfcache restore, the SDK MUST re-evaluate the session, assign a new `ouo.view.id`, restart vitals with new ids, and open a new replay stream starting with a keyframe.
- **LIF-9** On a server-side or non-DOM runtime, the web SDK MUST be a no-op. Importing it MUST NOT throw or touch DOM globals at module load.
- **LIF-10** A prerendered page MUST NOT start a session or send telemetry until it activates.

### 4.3 Mobile

- **LIF-11** On a move to background, the SDK MUST emit `device.app.lifecycle`, close the current replay chunk, and flush within the OS allowance (iOS `beginBackgroundTask`, ended before expiry). It MUST NOT keep the app running beyond that.
- **LIF-12** On a move to foreground, the SDK MUST emit `device.app.lifecycle` and re-evaluate the session.
- **LIF-13** A background launch with no foreground (push, background fetch) MUST NOT start a session or replay.
- **LIF-14** Android SDKs MUST NOT start a foreground service for telemetry. They MAY schedule deferred upload through WorkManager.

## 5. Sessions

- **SES-1** `session.id` MUST be 128 bits from a cryptographically secure generator, written as 32 lowercase hex characters. Consumers MUST treat it as opaque.
- **SES-2** `session.id` MUST be a record attribute on every log record and span, stamped when the record is created, not at export. It MUST NOT be a resource attribute.

### 5.1 Start and activity

- **SES-3** A session MUST start on the first activity with no valid session. `init` in a visible page or foregrounded app counts as activity.
- **SES-4** In a sampled session (**SMP-3**), `session.start` MUST be emitted exactly once, as the session's first record, with `session.id`, and with `session.previous_id` whenever a prior session id is known, except after consent withdrawal (**PRV-4**). `session.previous_id` MUST differ from `session.id` and MUST NOT appear on other records.
- **SES-5** Only these count as activity. Web: pointer down, key down, wheel or touch scroll, hard or soft navigation, and a page becoming visible. Mobile: touch, a screen navigation, and a move to foreground. Telemetry, timers and network activity MUST NOT count.
- **SES-6** The last-activity time SHOULD be written to storage at most once per 5 s per context.

### 5.2 End

| Platform | Session ends when |
|---|---|
| Web | No activity for `inactivityTimeoutMs`, or age reaches `maxDurationMs`, or `restartSession`, or `shutdown` in the last open context |
| Mobile | Continuously in background for `backgroundTimeoutMs`, or age reaches `maxDurationMs`, or `restartSession`, or a crash (**SES-13**) |

- **SES-7** `session.end` SHOULD be emitted, before the following `session.start`, with the timestamp of the last activity and with `ouo.session.end_reason` (`timeout`, `max_duration`, `manual`, `shutdown`, `consent`).
- **SES-8** Consumers MUST treat `session.end` as a hint, since it can be lost. A session has ended at the earliest of `session.end`, a `session.start` that names it as `session.previous_id`, or last record plus the inactivity timeout.
- **SES-9** Reaching `maxDurationMs` with the user present MUST roll to a new session at once, with `session.previous_id` linking them.
- **SES-10** While no valid session exists, records outside the bypass set MUST be dropped and counted with reason `no_session`. A polling tab MUST NOT create sessions. Bypass-set records MUST be sent with the last session id and `ouo.session.expired=true`. If no session id is known, for example a crash during a background launch, the SDK MUST generate one for those records, also marked, without emitting `session.start`.

### 5.3 Tabs and windows (web)

- **SES-11** One session MUST be shared by all same-origin tabs in a browser profile, stored in `localStorage`. Starting, ending and rolling MUST be serialised with Web Locks where available. Otherwise a tab MUST write, re-read and adopt the stored value. Exactly one context MUST emit each `session.start` and `session.end`.
- **SES-12** Where `localStorage` is unavailable, the session lives in memory and is limited to the page. The SDK MUST NOT fall back to cookies.

No per-tab id is added to ordinary records, because `ouo.view.id` already separates tabs. Replay uses a stream id (**RPL-5**).

### 5.4 App restarts and crashes (mobile)

- **SES-13** A crash MUST end the session. The next launch MUST start a new session with `session.previous_id` set to the crashed id, and no `session.end` for the crashed session.
- **SES-14** A clean process exit followed by a relaunch within the timeout MUST continue the same session without a new `session.start`, with a new replay stream.
- **SES-15** The session id, its sampling decision and last activity MUST be persisted before the first record of the session. The id MUST be readable by the crash handler without allocating or locking.
- **SES-16** `app.crash` MUST carry the crashed session's id, not the current one.

## 6. Signals

Names, types and confidence come from the [signal table](signals-table.html). Attribute requirement levels are from the YAML models. "OTel" in a required column means the convention itself requires it. Every Development name depends on `[P1]`.

### 6.1 Rules for every record

- **SIG-00** A signal in these tables MUST be emitted with its type, name, required attributes and firing rule whenever the platform supports it, the instrumentation is enabled and the session is sampled.
- **REC-1** Every event MUST set `EventName`. It MUST NOT set the deprecated `event.name` attribute.
- **REC-2** Every record MUST carry `session.id` (**SES-2**), and `ouo.view.id` once a view exists. `ouo.view.id` is a new random id for every hard or soft navigation and screen view. `[OPEN D5]` `[P13]`
- **REC-3** Every web record except those in the `ouo.replay` scope MUST carry sanitised `browser.document.url.full`. Mobile records SHOULD carry `app.screen.name` when known.
- **REC-4** `Timestamp` MUST be when the thing occurred, and `ObservedTimestamp` when the SDK recorded it.
- **REC-5** Telemetry MUST use instrumentation scope `ouo.rum`. Replay records MUST use scope `ouo.replay` (**RPL-3**). Both MUST set `schema_url` (**VER-3**) `[P19]`. Host-provided OTel instrumentations keep their own scope.
- **REC-6** Spans MUST be used only for network calls, `documentLoad` and `AppStart`. The two load spans MUST be created after the fact with explicit times, so they are never open.
- **REC-7** Every event defaults to severity INFO unless its table says otherwise.
- **REC-8** Attribute values MUST be truncated at source: `exception.stacktrace` to 25 KiB keeping the top frames, other strings to 4 KiB. Total attributes on a record SHOULD stay under 64 KB, the Loki metadata limit.
- **REC-9** The SDK MUST NOT estimate clock offset. Records carry the device clock, and edge validation handles skew ([rules](rules.md)).

### 6.2 Performance

| Id | Signal | Platform | Type, name | Required | Optional | Fires | Status, confidence |
|---|---|---|---|---|---|---|---|
| **SIG-01** | LCP, INP, CLS, FCP, TTFB | Web | Event `browser.web_vital` | OTel: `browser.web_vital.name`, `.value`, `.delta`, `.id` | `.rating`, `.navigation_type` | Once per vital per hard page load, when final: first hidden or `pagehide`; FCP and TTFB when known. `delta` equals `value` | Dev core, High |
| **SIG-02** | INP attribution | Web | Attributes on the INP event | none | `browser.web_vital.attribution.interaction_target`, `.interaction_type`, `.input_delay`, `.processing_duration`, `.presentation_delay`; full object in the body when `instrumentations.vitalAttributionBody` is on (*default* off) | With the INP event | Draft #35 `[P3]` |
| **SIG-03** | Long animation frame | Web | Event `browser.long_animation_frame` | Per convention once merged | Per convention | Gated (**SIG-30**) | Draft PR #429 `[P4]` |
| **SIG-04** | App start | Mobile | Span `AppStart`, after the fact | `start.type` (`cold`, `warm`, `hot`) | `ouo.app.start.prewarmed` (iOS) | When first frame draws, with start at process start. Lost if killed during launch | SDK only `[P5]` |
| **SIG-05** | Jank | Mobile | Event `app.jank` | `app.jank.frame_count`, `.threshold`, `.period` (OTel: recommended) | | Per polling window, slow (over 16 ms) and frozen (over 700 ms) frames, only when count is above 0 | Dev core, High |
| **SIG-06** | ANR | Android, RN | Event `device.anr`, severity ERROR | `exception.stacktrace` | | After 5 failed 1-second main-thread checks. If killed first, on next launch (**SIG-31**) | SDK only `[P6]` |
| **SIG-07** | Hang | iOS, RN | Event `ouo.app.hang`, severity ERROR | `ouo.app.hang.duration` (seconds), `exception.stacktrace` | | When the main thread recovers. If killed first, on next launch (**SIG-31**) | None `[P7]` |

- **SIG-30** `browser.long_animation_frame` MUST NOT be emitted until PR #429 merges, or the founder accepts its draft names.
- **SIG-31** An ANR or hang in progress when the process is killed MUST be persisted and sent on next launch with its original time and session id.
- **SIG-32** Web vitals MUST carry the `ouo.view.id` of the hard page load they measure, even when emitted after a soft navigation.

### 6.3 Errors and crashes

| Id | Signal | Platform | Type, name | Required | Optional | Fires | Status, confidence |
|---|---|---|---|---|---|---|---|
| **SIG-08** | JS error, unhandled rejection | Web, RN | Event `exception`, severity ERROR; RN JS fatal FATAL | `exception.type` or `.message`, `.stacktrace` when present, `ouo.exception.source` (`error`, `unhandledrejection`, `manual`), `ouo.exception.handled` | `code.file.path`, `code.line.number`, `code.column.number` `[P20]`, `ouo.exception.fingerprint` `[P21]` | Global handler, or `recordException` | Stable, High |
| **SIG-09** | Native crash | Mobile | Event `app.crash`, severity FATAL | `app.build_id`, `service.version`, `os.name`, `os.version`, `session.id` of the crashed session, `app.crash.id`, `exception.stacktrace` | `exception.type`, `.message` | Next launch, with original crash time | Dev core, High |

- **SIG-33** An exception emitted while a span is active MUST carry that span's trace and span ids.
- **SIG-34** The SDK MUST NOT compute a fingerprint. Only the server or an app-supplied value sets `ouo.exception.fingerprint`, since minified frames change per build.
- **SIG-35** Swift-based SDKs MUST emit `app.crash`, not `device.crash`.

### 6.4 Interactions

| Id | Signal | Platform | Type, name | Required | Optional | Fires | Status, confidence |
|---|---|---|---|---|---|---|---|
| **SIG-10** | Click | Web | Event `browser.user_action.click` | `browser.page.x`, `.y`, `browser.tag_name`, `ouo.viewport.width`, `.height` | `browser.css_selector`, `browser.mouse_event.button`, `browser.element.attributes` (only `data-otel-*`) | On click | SDK only `[P8]` |
| **SIG-11** | Tap on known widget | Mobile, RN | Event `app.widget.click` | `app.widget.id`, `app.screen.coordinate.x`, `.y`, `ouo.viewport.width`, `.height` | `app.screen.id`, `app.screen.name`, `app.widget.name` (**PRV-9**) | On tap | Dev core `[P9]` |
| **SIG-12** | Tap, no known widget | Mobile, RN | Event `app.screen.click` | `app.screen.coordinate.x`, `.y`, `ouo.viewport.width`, `.height` | `app.screen.id`, `app.screen.name` | On tap | Dev core `[P9]` |
| **SIG-13** | Rage, dead, error click | All | Event `ouo.user_action.frustration` | `ouo.user_action.frustration.type`; `.click_count` for rage; target attributes of the click | | Rage: 4+ clicks within 1000 ms on one element. Dead: no DOM change, navigation or network within 2000 ms. Error: click followed by an error within 2000 ms. In addition to the clicks | Draft #510 `[P10]` |

- **SIG-36** One tap MUST produce one event: `app.widget.click` when the target is known, otherwise `app.screen.click`.
- **SIG-37** Mobile coordinates MUST be absolute screen pixels. RN MUST scale density-independent points to pixels.
- **SIG-38** A click or tap MUST NOT start a trace. Joins use `session.id` and time.
- **SIG-39** Element text MUST NOT be captured.

`ouo.viewport.*` is on the click, not the view, because it stays correct through resize and rotation and costs little in a batch.

### 6.5 Navigation and network

| Id | Signal | Platform | Type, name | Required | Optional | Fires | Status, confidence |
|---|---|---|---|---|---|---|---|
| **SIG-14** | Page load count | Web | Event `browser.navigation` | OTel: `url.full`, `browser.navigation.same_document`, `.hash_change`; `.type` as the convention requires | | As early as possible at document start | Dev client, High |
| **SIG-15** | Page load span | Web | Span `documentLoad`, after the fact | `url.full` | Server trace link (**PRP-5**) | After `load`, from `fetchStart` to `loadEventEnd`. No children, no span events. None if the user leaves first | Draft PR #504 `[P2]` `[OPEN D2]` |
| **SIG-16** | Navigation timing | Web | Event `browser.navigation_timing` | OTel: `url.full` and the `browser.navigation_timing.*` milestones | | After `load` | Dev client, High |
| **SIG-17** | Resource timing | Web | Event `browser.resource_timing` | OTel: `browser.resource_timing.*` timings | | One per resource. Timestamp MUST be resource start. *Default* off until Step 5 prices it | Dev client, High |
| **SIG-18** | Soft navigation | Web | Event `browser.navigation` with `same_document=true`, `hash_change=false` | As SIG-14 | | On History API navigation. Hash-only changes off by default | Dev client `[P11]` |
| **SIG-19** | Screen view | Mobile, RN | Event `app.navigation.complete` | `app.navigation.destination.name` (route pattern, never filled arguments), `app.screen.name` | `app.screen.id` | When a screen becomes current | SDK only `[P12]` |
| **SIG-20** | Foreground and background | Mobile | Event `device.app.lifecycle` | OTel: `ios.app.state` or `android.app.state` | | On each transition | Dev core, High |
| **SIG-21** | Fetch, XHR, native HTTP | All | Span, kind CLIENT, named by method | Stable HTTP client attributes | `ouo.span.abandoned` `[P18]` | Per request, one trace each | Stable, High |

- **SIG-40** The SDK's own export requests MUST NOT be instrumented.
- **SIG-41** No trace may span a session or multiple page views. The `documentLoad` span is the only record joined to the server trace of the page load.

### 6.6 Sessions and identity

| Id | Signal | Platform | Type, name | Required | Optional | Fires | Status, confidence |
|---|---|---|---|---|---|---|---|
| **SIG-22** | Session start | All | Event `session.start` | `session.id`; `session.previous_id` per **SES-4**; `ouo.session.sample_rate` | | **SES-4** | Dev core, High |
| **SIG-23** | Session end | All | Event `session.end` | `session.id` | `ouo.session.end_reason` | **SES-7** | Dev core, High |
| **SIG-24** | Session id | All | Attribute `session.id` | | | Every record | Dev core, High |
| **SIG-25** | View id | All | Attribute `ouo.view.id` | | | Every record | Draft #84 `[P13]` `[OPEN D5]` |

### 6.7 Replay

| Id | Signal | Platform | Type, name | Required | Fires | Status, confidence |
|---|---|---|---|---|---|---|
| **SIG-26** | Replay chunk | All | Event `ouo.replay.chunk` | [Section 11.3](#113-chunk-record) | **RPL-10** | None `[P16]` |
| **SIG-27** | Replay ended | All | Event `ouo.replay.ended` | [Section 11.5](#115-end-of-stream) | **RPL-20** | None `[P16]` |

### 6.8 React Native boundaries

| Native layer | JS layer |
|---|---|
| Session state, sampling, consent state, transport, persistence | `exception` from JS |
| `AppStart`, `app.crash`, `device.anr`, `ouo.app.hang`, `app.jank`, `device.app.lifecycle` | `app.widget.click`, `app.screen.click`, `ouo.user_action.frustration` |
| Replay capture | `app.navigation.complete` |
| HTTP spans from native-only code | `fetch` and XHR spans |

- **SIG-42** RN MUST have one session, one queue and one exporter, owned by native. JS records MUST cross the bridge rather than export on their own.
- **SIG-43** A request carrying a `traceparent` set by JS MUST NOT produce a second span from native HTTP instrumentation.
- **SIG-44** A JS fatal MUST be emitted as `exception` at FATAL. A native crash below it is a separate `app.crash`.
- **SIG-45** Bridge failure MUST NOT crash either side. If native is missing, the JS layer MUST be a no-op.

## 7. Resource and propagation

### 7.1 Resource

| Attribute | Web | Mobile | Rule |
|---|---|---|---|
| `service.name`, `service.version` | MUST | MUST | |
| `deployment.environment.name` | SHOULD | SHOULD | |
| `telemetry.sdk.name`, `.language`, `.version` | MUST | MUST | |
| `browser.brands`, `.platform`, `.mobile`, `.language` | SHOULD, where available | | |
| `user_agent.original` | MUST when `browser.brands` is unavailable | | Otherwise OMIT |
| `app.build_id` | | MUST | Needed for symbolication |
| `device.model.identifier`, `.manufacturer`, `.model.name` | | SHOULD | |
| `os.name`, `os.version` | SHOULD | MUST | |
| `android.os.api_level` | | MUST on Android | |

- **RES-0** The resource MUST carry the attributes marked MUST in this table, for that platform.
- **RES-1** The resource MUST contain only low-cardinality identity fixed for the SDK's lifetime.
- **RES-2** `service.instance.id`, `app.installation.id` and `device.id` MUST NOT be on the resource. `device.id` MUST NOT be sent at all unless configured. `[OPEN D4]`
- **RES-3** `session.id`, `ouo.view.id`, `app.screen.name`, `browser.document.url.full` and `enduser.*` MUST NOT be on the resource.
- **RES-4** The SDK MUST NOT depend on OTel entities until the entity spec is stable. `[P17]`

### 7.2 `traceparent`

- **PRP-1** The SDK MUST use W3C Trace Context on instrumented requests whose URL matches `propagation.urls`. Trace ids MUST be random.
- **PRP-2** Web MUST inject cross-origin only on an explicit match, since the server must allow the header in CORS.
- **PRP-3** The SDK MUST NOT inject if the request already has `traceparent`.
- **PRP-4** The sampled flag MUST reflect the session's decision (**SMP-4**).
- **PRP-5** Web SHOULD read `<meta name="traceparent">` and use it as the parent of `documentLoad` only. It MUST NOT apply it to any other record. `[OPEN D2]`

### 7.3 `session.id` to backends

- **PRP-6** When `propagation.sessionBaggage` is true, the SDK MUST send W3C `baggage: session.id=<id>`, only to URLs that receive trace headers, with the same value as the record attribute. It MUST be off by default. `[OPEN D4]` `[P14]`

## 8. Transport

### 8.1 Encoding and batching

| | Telemetry | Replay |
|---|---|---|
| Queue | Own | Own, so a replay backlog cannot delay errors |
| Paths | `/v1/traces`, `/v1/logs` | `/v1/logs` |
| Encoding | Web: JSON or protobuf (Step 5 chooses). Mobile: protobuf | Protobuf on all platforms |
| Compression | `Content-Encoding: gzip` | Body compressed by the format layer (`ouo.replay.encoding`). No second gzip |
| Per request | Batched | One chunk per request (**TRN-5**) |

| Setting | *Default* |
|---|---|
| `transport.flushIntervalMs` | 5000 |
| `transport.maxBatchRecords` | 512 |
| `transport.maxRequestBytes` | 1 MiB compressed |
| `transport.maxQueueRecords` | 2048 |
| `transport.shutdownDeadlineMs` | 2000 |
| `transport.retry.initialMs`, `.maxMs` | 1000, 300 000 |
| `transport.persist.ttlHours` | 72; crash and hang records 144 |
| `transport.persist.maxBytes` | Step 5 |

- **TRN-1** Export MUST be OTLP/HTTP as defined by OTLP v1.11.1. Replay chunks MUST use binary protobuf, to avoid the 4/3 base64 cost.
- **TRN-2** Non-replay requests SHOULD be gzipped. Where compression is asynchronous and cannot finish during page teardown, the unload flush MAY be uncompressed and counts uncompressed against **TRN-16**.
- **TRN-3** Telemetry and replay MUST have separate queues and separate export tasks. Replay failure, backlog or size MUST NOT delay telemetry.
- **TRN-4** A request MUST NOT exceed `maxRequestBytes` or `maxBatchRecords`. An empty request MUST NOT be sent.
- **TRN-5** Each replay chunk MUST be sent as its own request, so a partial-success count identifies the chunk without ambiguity.

### 8.2 Responses and retries

| Response | Action |
|---|---|
| Any 2xx, `partial_success` unset or rejected = 0 (**204 with no body counts**) | Accepted. Delete |
| 2xx with rejected > 0 | Do not retry. Delete, count `partial_rejected` |
| `429`, `503` | Retry, honour `Retry-After` |
| `502`, `504`, network failure, no response | Retry with backoff |
| `400`, `413`, any other 4xx or 5xx | Do not retry. Delete, count `rejected_status` |

- **TRN-6** Retries MUST follow that table.
- **TRN-7** Backoff MUST be exponential with full jitter, from `retry.initialMs` to `retry.maxMs`.
- **TRN-8** `Retry-After` MUST be honoured, capped at `retry.maxMs`.
- **TRN-9** An in-memory batch MUST be retried until the queue limit forces eviction, then dropped and counted.
- **TRN-10** Retries MUST reuse the original payload. Delivery is at-least-once, so duplicates are expected. Identity for de-duplication is `(ouo.replay.id, ouo.replay.stream.id, ouo.replay.sequence)` for chunks, `span_id` for spans, `app.crash.id` for crashes, `browser.web_vital.id` for vitals.
- **TRN-11** When the export queue is full, the SDK MUST evict the oldest non-bypass records first and count each.

### 8.3 Durable acceptance and deletion

- **TRN-12** Data is **durably accepted** only when the configured endpoint answers 2xx with no rejected records. A persisted record MUST NOT be deleted before then, except for the reasons in **TRN-13**.
- **TRN-13** A persisted record MAY be deleted early only for: a non-retryable response; expiry of `persist.ttlHours`; storage cap reached; consent withdrawal; an app-initiated clear; or corrupt data. Each except consent and clear MUST be counted.
- **TRN-14** Under the storage cap, eviction MUST run oldest-first in this order: replay chunks, then ordinary telemetry, then bypass-set records.

**Requirement on the Collector, outside the SDK.** TRN-12 is only true if the Collector's replay pipeline answers 2xx after the chunk reaches its fsync-backed disk queue. That is the plan of record; it is not verified, and Step 8 owns it. For non-replay pipelines a 2xx means accepted by that hop.

### 8.4 Offline persistence

| Data | Web | Mobile |
|---|---|---|
| Replay chunks | IndexedDB, written before send, where available | Disk, written before send |
| Crash, ANR, hang | n/a | Disk, MUST |
| Other telemetry | MAY be memory only | SHOULD be disk |

- **TRN-20** Data MUST be persisted as this table requires.
- **TRN-15** Persistence MUST NOT run on the main thread on mobile. On the web it MUST be asynchronous. Persistence failure MUST degrade to memory-only and be counted.

### 8.5 Page-unload budget (web)

- **TRN-16** Unload flushes MUST use `fetch` with `keepalive` and keep all in-flight keepalive bytes at or under 60 KiB (the platform limit is 64 KiB across all requests). Telemetry goes first. A replay chunk is sent only if it fits in what remains. Chunks that do not fit stay persisted.
- **TRN-17** `sendBeacon` MAY be used as a fallback, and MUST NOT carry credentials in the URL.
- **TRN-18** A persisted replay chunk from a closed page MUST be sent by a later page of the same origin. A page claims a closed stream through a Web Lock, so only one page drains it.
- **TRN-19** Because a keepalive response may never be observed, a chunk sent at unload MUST stay persisted until a later page confirms acceptance by resend. Muninn de-duplicates by chunk identity.

## 9. Sampling

- **SMP-1** Sampling MUST be decided once per session, at session start, and persisted with the session. `[P15]`
- **SMP-2** The decision MUST be deterministic from `session.id`: sampled when the first 8 hex characters, read as an unsigned 32-bit integer, divided by 2^32, is below `sampling.sessionRate`. All tabs, and JS and native in RN, then agree.
- **SMP-3** An unsampled session MUST emit only the bypass set. `session.start` itself MUST NOT be emitted. `ouo.session.sample_rate` on `session.start` lets consumers scale counts.
- **SMP-4** Spans in a sampled session MUST have the sampled flag set. Requests in an unsampled session MUST still propagate `traceparent`, with the flag clear.
- **SMP-5** The bypass set MUST be: `app.crash`, `device.anr`, `ouo.app.hang`, and `exception` with `ouo.exception.handled=false`.
- **SMP-6** Bypass records from an unsampled session MUST carry `ouo.sampling.bypass=true`, and consumers MUST exclude them from rates and session health, whose denominator is sampled sessions only. Without this exclusion, those rates would be biased upward.
- **SMP-7** At most `sampling.bypass.perSessionCap` bypass records MUST be sent per unsampled session. Crashes MUST NOT be capped, as there is at most one per session.

### 9.1 Replay sampling and buffer-on-error

| `replay.mode` | Behaviour |
|---|---|
| `off` | No replay |
| `session` | Records for the whole session if sampled by `replay.sessionRate` |
| `buffer` | Keeps a recent ring. Sends only when triggered, if sampled by `replay.bufferRate` |

- **SMP-8** Replay sampling MUST use the second 8 hex characters of `session.id`, by the same method as **SMP-2**, so it is independent of the session decision.
- **SMP-9** Replay MUST run only in sampled sessions. To keep replays for rare errors, set `sessionRate` to 1.0 and use a low replay rate.
- **SMP-10** In `buffer` mode, the SDK MUST hold at least the last `replay.bufferSeconds` (*default* 60) in a ring that always retains the keyframe needed to decode it. Evicting whole segments is the only permitted eviction.
- **SMP-11** Web MUST keep the ring in memory only, so nothing that was never triggered reaches disk. Mobile MAY persist the ring so a crash can trigger upload on next launch, and if it does it MUST discard unused rings at next launch.
- **SMP-12** A trigger is any bypass-set record or `replay.capture()`. The buffer MUST then be flushed and recording MUST continue as in `session` mode until the session ends, with `ouo.replay.mode=buffer` and `ouo.replay.trigger` set.

## 10. Privacy

### 10.1 Consent

- **PRV-1** When `consent.required` is true, the SDK MUST start with consent pending. While pending it MUST NOT send anything, MUST NOT write to persistent storage, and MUST NOT start replay.
- **PRV-2** Records created while pending MAY be held in a bounded memory buffer. On grant they MUST be processed normally. On denial they MUST be discarded.
- **PRV-3** Telemetry and replay consent MUST be separate. Replay MUST require replay consent.
- **PRV-4** On withdrawal, the SDK MUST stop capture of that category, emit nothing further for it, delete unsent persisted data for it, and clear the persisted session. A later grant MUST start a new session without `session.previous_id`.

### 10.2 Masking

- **PRV-5** Replay MUST mask by default. Web: all text and all input values masked; images, video and canvas blocked. Mobile: all text and images masked. Masking MUST happen on the device, before any persistence or export.
- **PRV-6** Web apps unmask or mask through `data-ouo-unmask` and `data-ouo-mask`. Mask MUST win when both apply. Password, payment and one-time-code fields MUST always be masked and MUST NOT be unmaskable.
- **PRV-7** Mobile secure text fields MUST always be masked and MUST NOT be unmaskable.
- **PRV-8** If masking fails or the masked state of a frame cannot be established, the frame MUST be dropped, not sent.

### 10.3 Attributes and URLs

- **PRV-9** Defaults: `browser.tag_name`, sanitised `browser.css_selector` and the sanitised INP target are on. `app.widget.id` is on. `app.widget.name` and the web-vital attribution body are off. Selectors MUST be built from tag names, `nth-of-type`, and ids only, MUST NOT contain attribute values, and MUST omit any id containing a run of 6 or more digits, since such ids are often generated or user-specific.
- **PRV-10** URLs on `url.full`, `browser.document.url.full`, stack frames and replay MUST be sanitised before persistence: credentials become `REDACTED:REDACTED`; every query value becomes `REDACTED` unless its key is in `privacy.urlQueryAllow`; the fragment is removed unless `privacy.keepUrlFragment`. A `sanitizeUrl` hook then runs. This is stricter than the OTel default, which redacts only listed keys.
- **PRV-11** Sanitising MUST also cover a query-shaped fragment if fragments are kept.
- **PRV-12** The SDK MUST NOT capture request or response bodies or headers, apart from those required by the HTTP conventions.
- **PRV-13** `enduser.id` MUST be sent only after `setUser`. `enduser.pseudo.id` MUST NOT be sent unless the app opts in (`session.anonymousId`, USR-d); then it is a random visitor id on every record (never on the resource), kept in the SDK's storage so it lasts across visits only where storage is allowed, and forgotten when consent is withdrawn. The SDK MUST NOT collect IP address, location, advertising id or contacts; a collector MAY add them server-side for a project that enables it.
- **PRV-14** `exception.message` and `.stacktrace` pass through `beforeSend`. Apps with sensitive messages are expected to use it.

## 11. Replay contract

### 11.1 Hierarchy

```text
session  1 ── 0..n  replay  1 ── 1..n  stream  1 ── 1..n  segment  1 ── 1..n  chunk
```

| Level | Identity | Meaning |
|---|---|---|
| Replay | `ouo.replay.id`, 128-bit random | One recording. Normally one per session. A second is possible after consent is regranted or after `replay.stop()` and `replay.start()` |
| Stream | `ouo.replay.stream.id`, 128-bit random | One source of frames: a tab, window or scene, or a process. A bfcache restore or relaunch starts a new one |
| Segment | `ouo.replay.segment.index`, from 0 in a stream | Starts at a keyframe. Decodable alone |
| Chunk | `ouo.replay.sequence`, from 0 in a stream | One bounded record |

This adds a replay id that the Step 2 entry did not have. It follows the contract in the Step 3 brief: the replay level gives deletion and access control an object of their own, and `session.id` remains the join key.

- **RPL-1** Every chunk MUST carry all identity attributes in [section 11.3](#113-chunk-record).
- **RPL-2** A chunk is an OTLP log record, with bytes as its body when sent to the Collector. `[OPEN D3]` `[P16]`
- **RPL-3** Chunks and end records MUST use scope `ouo.replay`, so the Collector can route them to a separate pipeline.

### 11.2 Segments and chunks

- **RPL-4** `ouo.replay.sequence` MUST start at 0 in each stream and rise by exactly 1 per chunk. It MUST NOT reset at a segment boundary, and retransmission MUST reuse the same value and the same bytes.
- **RPL-5** A stream MUST map to exactly one tab, window, scene or process lifetime.
- **RPL-6** The first chunk of a segment MUST have `ouo.replay.keyframe=true`, and it MUST start with a keyframe that makes the segment decodable with no earlier data. A keyframe MAY span chunks.
- **RPL-7** The concatenation of a segment's decompressed chunk bodies, in sequence order, MUST be a valid payload of `ouo.replay.format`. Each chunk body MUST be independently decompressible.
- **RPL-8** After any gap in capture or local loss, the SDK MUST start a new segment with a keyframe before sending more.
- **RPL-9** A new keyframe and segment SHOULD begin at least every `replay.keyframeIntervalMs` (*default* 300 000), and on a change of tab visibility or foreground.
- **RPL-10** A chunk MUST be closed at the earliest of: `replay.chunkMaxBytes` (*default* 256 KiB compressed; hard limit 1 MiB), `replay.chunkMaxMs` (*default* 5000), stream end, or page hide or background.
- **RPL-11** Chunk bodies MUST NOT exceed the hard limit, and a larger chunk MUST be split, never truncated.
- **RPL-12** `ouo.replay.sha256` MUST be the lowercase hex SHA-256 of the exact body bytes as sent, after compression.

### 11.3 Chunk record

Event `ouo.replay.chunk`. `Timestamp` is the chunk start.

| Attribute | Type | Req. | Meaning |
|---|---|---|---|
| `session.id` | string | MUST | Join key |
| `ouo.replay.id` | string | MUST | |
| `ouo.replay.stream.id` | string | MUST | |
| `ouo.replay.segment.index` | int | MUST | |
| `ouo.replay.sequence` | int | MUST | |
| `ouo.replay.keyframe` | bool | MUST | |
| `ouo.replay.start_time`, `ouo.replay.end_time` | int (ms since epoch) | MUST | Time range |
| `ouo.replay.format` | string | MUST | Format and version, for example `rrweb/2` |
| `ouo.replay.encoding` | string | MUST | Body compression, for example `gzip` |
| `ouo.replay.sha256` | string | MUST | **RPL-12** |
| `ouo.replay.byte_size` | int | MUST | Body bytes as sent |
| `ouo.replay.masked` | bool | MUST | Masking ran on this content |
| `ouo.replay.mode` | string | MUST | `session` or `buffer` |
| `ouo.replay.trigger` | string | When `buffer` | `error`, `crash`, `anr`, `hang`, `manual` |
| `ouo.view.id` | string | SHOULD | Jump to a page or screen |
| `ouo.replay.ref` | string | Set by the Collector | Replaces the body after the store hop `[OPEN D3]` |

- **RPL-13** Attributes marked MUST in that table MUST be present on every chunk.
- **RPL-14** An SDK MUST NOT set `ouo.replay.ref`.

### 11.4 Delivery

- **RPL-15** A chunk MUST be persisted before its first send where storage is available (web: IndexedDB; mobile: disk).
- **RPL-16** Chunks of one stream SHOULD be sent in sequence order. Receivers MUST NOT assume arrival order.
- **RPL-17** A backlog MUST drop or evict whole chunks from the oldest segment. It MUST mark the stream partial (**RPL-21**) and MUST NOT silently renumber.
- **RPL-18** Replay capture MUST stop, and the stream MUST be marked partial, if the replay queue and store are full and cannot accept more.
- **RPL-19** Replay capture MUST NOT run in a session where replay was not sampled or consented.

### 11.5 End of stream

Event `ouo.replay.ended`, one per stream, same scope. The Step 3 brief calls this `replay.ended`. By the [naming rule](rules.md), a name OTel does not define takes the `ouo.` prefix.

| Attribute | Req. | Meaning |
|---|---|---|
| `session.id`, `ouo.replay.id`, `ouo.replay.stream.id` | MUST | |
| `ouo.replay.end_state` | MUST | `complete` or `partial` |
| `ouo.replay.last_sequence` | MUST, if any chunk exists | Highest sequence produced |
| `ouo.replay.end_reason` | MUST | `session_end`, `stop`, `consent`, `pagehide`, `background_kill`, `crash`, `max_size`, `error` |

- **RPL-26** Every `ouo.replay.ended` record MUST carry the attributes marked MUST in this table.
- **RPL-20** An SDK MUST emit `ouo.replay.ended` when a stream ends normally. A killed process cannot emit it, so on next launch the SDK MUST emit it for streams left open, with `end_state=partial`.
- **RPL-21** `end_state=complete` MUST mean only that chunks 0 to `last_sequence` were all produced and none is known to have been lost or rejected. The SDK cannot see the whole path, so this is a claim about the client.
- **RPL-22** The store MUST compute final completeness by comparing the chunks it holds with `last_sequence`. A stream with no end record MUST be treated as partial after an idle period.

### 11.6 Format is pluggable

**The mobile format is undecided (wireframe or video first), and this spec does not choose it.** Web uses `rrweb` unless Step 4 or 7 changes it.

| A format adapter MUST provide | |
|---|---|
| Format id and version | `ouo.replay.format` |
| Keyframe production | On request, so **RPL-6** and **RPL-8** can be met |
| Encoding and compression | `ouo.replay.encoding` |
| Masking | Satisfying **PRV-5** to **PRV-8** before any byte leaves the adapter |
| Bounded output | Can be split into chunks under **RPL-11** |

- **RPL-27** Every format adapter MUST provide the capabilities in this table.
- **RPL-23** The hierarchy, identity, chunk attributes, delivery and end rules MUST NOT depend on the format.
- **RPL-24** Readers MUST choose a decoder by `ouo.replay.format`, and MUST treat an unknown format as stored-but-undecodable, not as an error.
- **RPL-25** A video format MAY make each chunk a self-contained segment. Its rules are the same.

## 12. Error handling

- **ERR-1** The SDK MUST NOT crash, hang or throw into the host app. Every callback, patched function, observer and handler MUST catch its own errors.
- **ERR-2** Patched platform functions (`fetch`, `XMLHttpRequest`, history methods, delegates, interceptors) MUST preserve the original's behaviour, return values, errors and timing semantics.
- **ERR-3** Global error and crash handlers MUST chain to any previous handler and MUST NOT swallow the error.
- **ERR-4** The SDK MUST NOT do synchronous disk or network I/O on the UI thread. Web MUST NOT use synchronous XHR.
- **ERR-5** Instrumentation and exporters MUST NOT re-enter themselves.
- **ERR-6** After `diagnostics.selfDisableThreshold` (*default* 20) internal errors in one process lifetime, the SDK MUST stop capture and act as a no-op. Crash reporting MAY continue.
- **ERR-7** The SDK MUST count every record it drops, by signal and reason. It MUST report counts as event `ouo.sdk.dropped` with `ouo.sdk.drop.reason`, `ouo.sdk.drop.signal` and `ouo.sdk.drop.count`, at most once per flush interval. Drop events MUST NOT count as drops themselves or cause more drop events.
- **ERR-8** Diagnostics MUST go to the platform console only when `debug` is on. They MUST NOT include record payloads.
- **ERR-9** All internal buffers MUST be bounded.

## 13. Overhead budgets

Step 5 fills these in by measurement. Until then there is no pass or fail against them.

| Budget | Web | iOS | Android | RN | Method |
|---|---|---|---|---|---|
| Bundle or binary size (compressed), core | TBD | TBD | TBD | TBD | Build output |
| Same, with replay | TBD | TBD | TBD | TBD | Build output |
| Init time on main thread | TBD | TBD | TBD | TBD | Trace |
| CPU, idle and active | TBD | TBD | TBD | TBD | Reference app |
| CPU, replay on | TBD | TBD | TBD | TBD | Reference app |
| Memory, steady and peak | TBD | TBD | TBD | TBD | Reference app |
| Bytes per minute, telemetry | TBD | TBD | TBD | TBD | Fake collector |
| Bytes per minute, replay | TBD | TBD | TBD | TBD | Fake collector |
| Persisted storage cap | TBD | TBD | TBD | TBD | Config |
| Main-thread blocking per interaction | TBD | n/a | n/a | n/a | Trace |

- **OVH-1** Once filled in, each budget MUST be measured on the reference app in CI, and an exceeded budget MUST fail conformance.

## 14. Conformance

A shared suite runs on every platform against a **fake Collector** that records requests and can inject any response, delay or disconnect.

| Code | Method |
|---|---|
| W | Wire: drive a scenario, assert on captured OTLP |
| H | Harness: real browser (Chromium, Firefox, WebKit) or simulator, exercising real lifecycle |
| F | Fault injection through the fake Collector, or a broken storage or bridge |
| U | Unit test of the rule in isolation |
| S | Static: check on source, bundle or public types |
| D | Real device, only where a simulator cannot show it. Counted against the founder's device budget |

| Requirements | Method | Test |
|---|---|---|
| REL-1 | S | The suite itself tests only output |
| REL-2 | W | All captured traffic goes to the endpoint and parses as OTLP |
| REL-3 | W | Attribute names match the allowed registry list or start with `ouo.` |
| REL-4, REL-5 | U | Pre-registered provider is unchanged. A host-emitted record gets session attributes |
| REL-6, REL-7 | W | No `/v1/metrics` traffic. No span has events |
| API-1, API-3, API-5, API-6 | U | Call matrix before init, after shutdown, with reserved names, duplicates, and `recordException` |
| API-2 | H | Call under a slow-network and slow-storage stub, and assert the main thread is not blocked |
| CFG-1, CFG-2, CFG-3, CFG-4 | U | Table of bad configs. Secret never in URLs, records or logs. Throwing hook. Hook order |
| LIF-1, LIF-2, LIF-3, LIF-4, LIF-5 | H | Double init, init under slow storage, early records, shutdown removes hooks and flushes, re-init |
| LIF-6, LIF-9 | S, U | No `unload` registration. Import in Node without DOM |
| LIF-7, LIF-8, LIF-10 | H | Page close ordering, bfcache round trip, prerender |
| LIF-11, LIF-12, LIF-13, LIF-14 | H | Simulator transitions, background launch, no foreground service in merged manifest |
| SES-1, SES-2 | W, U | Format and randomness. Attribute on every record, not on resource. Stamped at creation across a rollover |
| SES-3, SES-4, SES-5 | H | Each activity type starts or extends. Telemetry alone does not extend. One start; previous id rules |
| SES-8 | S | Consumer rule, tested in Step 8 and on the query layer |
| SES-9, SES-10 | H | Fake clock past max and inactivity. Polling tab makes no session. Bypass after expiry |
| SES-11, SES-12 | H | Two tabs racing. One start and end. Blocked storage |
| SES-13, SES-14, SES-15, SES-16 | H, F | Force crash and relaunch, clean relaunch inside timeout. Crash carries the old id |
| SIG-00, SIG-01 to SIG-27 | W | One scenario per signal per platform, asserting type, name, required attributes and firing rule. Exact table generated from this section |
| SIG-30 | S | Name absent until gate opens |
| SIG-31 | F | Kill during hang. Sent on next launch with original time |
| SIG-32, SIG-33, SIG-34, SIG-35, SIG-36, SIG-37, SIG-38, SIG-39, SIG-40, SIG-41 | W | Scenario assertions, including a soft navigation before page hide, an error inside a span, a tap on a widget, and a click followed by a fetch |
| SIG-42, SIG-43, SIG-44, SIG-45 | H, F | RN app: one exporter, one span per request, JS fatal, missing native module |
| REC-1 to REC-9 | W | Applied to all captured records in every scenario |
| RES-0, RES-1, RES-2, RES-3, RES-4 | W | Forbidden-attribute list on every resource. Resource unchanged across rollover |
| PRP-1, PRP-2, PRP-3, PRP-4, PRP-5, PRP-6 | W, H | Header matrix by origin, allowlist, existing header, sampled flag, meta tag, baggage on and off |
| TRN-1, TRN-2, TRN-4, TRN-5 | W | Content type, encoding, limits, one chunk per request |
| TRN-3 | F | Replay endpoint stalled, assert telemetry still flows |
| TRN-6, TRN-7, TRN-8, TRN-9, TRN-10, TRN-11 | F | Each status in the table, backoff distribution, `Retry-After`, full queue, identical retry bytes |
| TRN-12, TRN-13, TRN-14 | F | Kill before and after each response code, inspect the store. TTL and cap with fake clock |
| TRN-15, TRN-20 | F, H | Storage failure. What is on disk at each step. Main-thread I/O detection |
| TRN-16, TRN-17, TRN-18, TRN-19 | H | Unload with a large backlog, byte accounting. Second page drains under a lock |
| SMP-1, SMP-2, SMP-3, SMP-4 | W, U | Golden vectors for the decision. Unsampled session output. Flags |
| SMP-5, SMP-6, SMP-7 | W | Bypass set, marker, cap |
| SMP-8, SMP-9, SMP-10, SMP-11, SMP-12 | W, H | Independence over a large id set. Ring keeps a keyframe. No disk writes on web. Trigger flush |
| PRV-1, PRV-2, PRV-3, PRV-4 | H | No traffic or storage while pending. Grant, deny, withdraw |
| PRV-5, PRV-6, PRV-7, PRV-8 | H | Fixture page or screen with marked secrets, decode output, search for the secrets |
| PRV-9, PRV-10, PRV-11, PRV-12, PRV-13 | W, U | Selector and URL vectors, forbidden fields |
| RPL-1 to RPL-14 | W, U | Decode a recorded stream. Identity, sequence, keyframes, bounds, hash recomputed |
| RPL-15, RPL-16, RPL-17, RPL-18, RPL-19 | F, H | Kill before send, full store, no capture when unsampled |
| RPL-20, RPL-21, RPL-26 | H, F | Normal end, kill then relaunch, loss marks partial |
| RPL-22, RPL-24 | S | Consumer rules, tested in Step 8 |
| RPL-23, RPL-25, RPL-27 | U | Run identical contract tests with a stub format adapter |
| ERR-1, ERR-2, ERR-3, ERR-5 | F, U | Throw from every internal callback. Patched-function parity. Prior handler still runs |
| ERR-4 | H | Main-thread I/O detection in debug builds. Static check for synchronous XHR |
| ERR-6, ERR-7, ERR-8, ERR-9 | F, W | Inject errors past the threshold. Drop count equals drops. Bounded under flood |
| OVH-1 | H | Once Step 5 fills [section 13](#13-overhead-budgets) |
| VER-1, VER-2, VER-3, VER-4, VER-5 | S, W | Spec version in release metadata. `schema_url` present. Golden wire snapshots per version |

An SDK is **conformant at spec version X** when every MUST applicable to its platform passes. Signals may be disabled by configuration, but the conformance run uses all of them on.

## 15. Versioning and absorbing change

- **VER-1** This spec MUST use semantic versioning. MAJOR: a change incompatible with deployed SDKs or consumers. MINOR: a new signal or capability. PATCH: clarification.
- **VER-2** Each SDK release MUST state the spec version it implements.

### 15.1 When OTel changes a name

```text
SDK emits current name + schema_url  →  Collector rename table  →  backends see one name
```

- **VER-3** Every scope MUST set `schema_url` to the version whose names it emits. For this draft, `https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev`, which is pinned to core 1.45.0. `[P19]`
- **VER-4** An SDK release MUST NOT be needed to absorb a rename. The Collector maps old names to new by `schema_url`, for as long as the old SDK versions are in the field. SDKs adopt the new name at their next regular release, with a new `schema_url`.
- **VER-5** A rename MUST NOT change a signal's type in the Collector table. An event becoming a span, or the reverse, is a MAJOR spec change.

### 15.2 When OTel publishes a replay convention

`ouo.replay.*` is written to be mapped. When a convention exists:

1. The Collector maps `ouo.replay.*` to the new names with a `transform` rule, and Muninn keeps accepting both.
2. The spec gets a MINOR version that names the new attributes.
3. If the new convention has concepts ours lacks, or a different hierarchy, it is a MAJOR version, and old recordings stay readable under their `schema_url`.

The prediction of what will change is in **P16**.

## 16. Prediction register

Items that rest on a prediction, not a published Stable convention. Unless stated, the fallback is a Collector rename (**VER-4**).

| Id | Prediction | Used by | Confidence | Fallback |
|---|---|---|---|---|
| P1 | All Development names used here persist or rename mechanically | All signal tables | High | Rename table |
| P2 | `documentLoad` lands as one span with no children | SIG-15 | High | Rename, or drop the span. `browser.navigation` still counts loads |
| P3 | #35 attribution names land | SIG-02 | Grouping names High, durations Medium | Rename table |
| P4 | `browser.long_animation_frame` merges as an event | SIG-03, SIG-30 | High | Stay gated |
| P5 | OTel standardises app start as a span with cold or warm types | SIG-04 | Span Medium, name Low | Rename table |
| P6 | `device.anr` remains the name | SIG-06 | Medium | Rename table; may merge with hang |
| P7 | A hang event appears as `app.hang` or merges with ANR | SIG-07 | Low | Rename table |
| P8 | `browser.user_action.click` joins a shared click family | SIG-10 | Medium existence, Low name | Rename table |
| P9 | `app.*click` stays; one event per tap remains allowed | SIG-11, SIG-12, SIG-36 | Medium | Emit both for a tap, if OTel requires it |
| P10 | Frustration moves to `browser.user_action.*` | SIG-13 | Low | Rename table, split per type if needed |
| P11 | Soft navigation stays `browser.navigation` with a flag | SIG-18 | Medium | Rename table, or a new event |
| P12 | `app.navigation.complete` stays an event | SIG-19 | Medium | Rename table |
| P13 | OTel adopts a view or navigation id | REC-2, SIG-25 | Medium, name Low | Rename when #84 lands |
| P14 | Baggage is the mechanism for `session.id` | PRP-6 | High | Off by default, so low impact |
| P15 | Session-level sampling reaches the other OTel SDKs | SMP-1 to SMP-4 | Medium | Ours stays valid. It needs no OTel feature |
| P16 | OTel replay is event-shaped with ordering attributes | Section 11 | Event High, bytes or reference Medium, name Low | Section 15.2 |
| P17 | `session` and `browser.document` become entities | RES-3, RES-4 | Medium, not soon | Stay on record attributes until the entity spec is stable |
| P18 | No OTel marker appears for abandoned spans | LIF-7, SIG-21 | Low | Rename table |
| P19 | The client-side `schema_url` suits all our scopes while it federates core | REC-5, VER-3 | Medium | Split scopes by registry |
| P20 | `code.*` on exceptions lands from draft #551 | SIG-08 | Medium | Rename table |
| P21 | No OTel fingerprint attribute appears | SIG-08, SIG-34 | Low on any name | Rename table |

## 17. Open decisions

Checked on 2026-11-09: PR #172 has no comments or reviews, and the Step 2 tracker still lists all five as waiting. **The text applies each recommendation. None is decided.**

| Id | Decision | Recommended, applied here | If the founder chooses otherwise |
|---|---|---|---|
| D1 | OTel SDK names with no registry entry stay unprefixed | Yes | Prefix `browser.user_action.click`, `device.anr`, `app.navigation.complete`, `AppStart`, `start.type` with `ouo.`. Change REL-3, section 6, and the fallbacks for P5, P6, P8 and P12 |
| D2 | Page load as both `browser.navigation` and `documentLoad`, with the server link | Yes | Remove SIG-15 and PRP-5. `browser.navigation_timing` still has the duration |
| D3 | Replay: bytes to the Collector, reference onward | Yes | The SDK needs a second upload path: rewrite RPL-2, TRN-1, TRN-5, TRN-12 |
| D4 | Keep `service.instance.id`, `app.installation.id`, `device.id` off the resource; `session.id` baggage off by default | Yes | Change RES-2 and the default in section 3.2. Loki gets one stream per device unless relabelled |
| D5 | `ouo.view.id` on every record | Yes | Remove from REC-2 and SIG-25. Views must be inferred from navigation order, and SIG-32 goes |

**Open and not a founder decision yet:** the mobile replay format ([section 11.6](#116-format-is-pluggable)).

## 18. Step 2 questions, and what passes to Step 4

| Step 2 question | Answered in |
|---|---|
| 1 Timeouts and activity | SES-5, section 5.2 |
| 2 Tabs and per-tab id | SES-11; no per-tab id on ordinary records |
| 3 Errors bypassing sampling | SMP-5 to SMP-7 |
| 4 Opt-in attributes, sanitising | PRV-9 to PRV-11 |
| 5 Chunk size, flush, unload budget | RPL-10, TRN-16 |
| 6 Clock offset | REC-9; edge only |
| 7 First-display signal | Not in this version. See below |
| 8 Viewport location | On the click, SIG-10 to SIG-12 |
| 9 Encoding per signal | Section 8.1 |
| 10 Manual API | Section 3.1 |
| 11 RN boundaries | Section 6.8 |
| 12 Session after a crash | SES-13, SES-15, SES-16 |

Questions for Step 4 (target features against other SDKs):

1. Do we need a first-display or time-to-full-display signal on mobile?
2. Should an unsampled session send recent breadcrumbs with its bypass errors? This version sends the bypass record alone.
3. Is query-value redaction by default (PRV-10) too strict for analytics? Which keys belong on a recommended allowlist?
4. Should a session span subdomains? This version is per origin.
5. Should the SDK offer per-signal rates, such as a trace ratio, or remote configuration and a remote kill switch? This version has one session decision and local configuration.
6. Which replay format should mobile ship first, wireframe or video?
7. Should `browser.resource_timing` default on? It is the main volume risk.
8. Should console logs, network bodies, feature flags or user feedback be in scope? Our Step 2 table has none of them.
9. Should heatmaps need document size as well as viewport size?
