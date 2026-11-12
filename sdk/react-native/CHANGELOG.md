# Changelog

## Unreleased

Implements the ouo SDK spec **0.1.0-draft** (`SPEC_VERSION`); not yet conformant (ADR-0021 step
A: the names, scope, session id and sampling rules, protobuf and replay over OTLP are step B).

### Changed

- `initRUM` no longer throws on a missing or invalid `endpoint`, `projectId`, `projectToken` or
  `service.name`: it returns a no-op instance and says why when `debug` is on.
- `session.inactivityTimeoutMs` and `session.backgroundTimeoutMs` below one minute are raised to
  one minute, `session.maxDurationMs` above 24 hours is lowered to 24 hours.
- App-supplied event names and attribute keys starting with `session.` or `ouo.` are dropped and
  counted (except `ouo.exception.fingerprint`).
- The SDK no longer registers its providers, propagator and context manager as OpenTelemetry
  globals; `otel.registerGlobal: true` restores that.
- `withSpan` reports an error as an `exception` log record with the span's ids, not as a span
  event. String attributes are truncated (stack 25 KiB, others 4 KiB, 64 KB per record).
- Next to Sentry, ouo hands unhandled rejections to Sentry itself when
  `errors.onUnhandledRejection` is not set.
- Debug output no longer prints event attributes, the user id or the first characters of the
  project token; the double-init warning is printed only with `debug`.

- Sessions start only on activity (touch, navigation, foreground): requests, timers and
  telemetry no longer extend or start one, and while none is valid records are dropped
  (`no_session`). A background launch starts no session. At the maximum duration in the
  foreground the next session starts at once. The last activity is persisted every 5 s at most.
- An unsampled session now sends its bypass set (unhandled exceptions, crashes, hangs, marked
  `ouo.sampling.bypass`), capped per session (only a native crash and a termination are exempt); the sampling decision is persisted with the
  session; unsampled requests propagate `traceparent` with the sampled flag clear.
- No `baggage` header unless `propagation.sessionBaggage` is set, and then only `session.id`;
  a request that already has a `traceparent` is never changed.
- No anonymous `user.id`: records carry `user.id` only after `setUser`; `session.userId()` is
  `""` until then.
- Recorded URLs are sanitised where they are captured (request URLs, the `trackNavigation`
  path, URLs inside `exception.stacktrace` and `exception.message`): credentials, query values
  and query parts without `=` become `REDACTED`, fragments are removed.
- A fatal error reaches the previous global handler after at most `errors.fatalFlushTimeoutMs`,
  also when storage does not answer.
- Uninstalling (shutdown, self-disable) no longer removes a `fetch`, `XMLHttpRequest`,
  `console.error` or global-handler patch that another SDK installed after ouo's.
- Delivery: backoff with full jitter up to 300 s (was a fixed doubling up to 30 s),
  `Retry-After` capped at 300 s.

### Added

- Consent: `consent.required`, `setConsent({ telemetry, replay })`.
- `privacy.urlQueryAllow`, `privacy.keepUrlFragment`, `sanitizeUrl`.
- `sampling.sessionRate`, `sampling.bypass.perSessionCap`, `ouo.session.sample_rate` on
  `session.start`, `propagation.sessionBaggage`, `transport.maxRequestBytes`.
- Failure isolation: one guard around every entry point, a fault-injection suite, self-disable
  after `diagnostics.selfDisableThreshold` internal errors.
- Spec API: `init`, `shutdown`, `flush`, `getSessionId`, `restartSession`, `setUser(id | null)`,
  `setGlobalAttributes`, `recordEvent`, `recordException`, `trackNavigation`,
  `getTracerProvider`, `getLoggerProvider`, `replay.start/stop/capture/mask/unmask`.
- `beforeSend`, drop counting with the `ouo.sdk.dropped` event, `transport.shutdownDeadlineMs`.

## [0.3.0](https://github.com/ouo11y/ouo11y/compare/react-native-v0.2.1...react-native-v0.3.0) (2026-11-01)

### Breaking

- On iOS, replay chunks are `frames` **schema 2** (replay tiles, below): they need rum-api >= 0.6.0
  and collector >= 0.5.0, and plugin 0.10 to play them. Upgrade the server side first
  (`docs/operations/upgrade.md` section 4); an older collector or rum-api refuses the chunks.

### Added

- **Delivery and offline** (mobile SDK roadmap W3, spec C11): every OTLP batch is written to
  AsyncStorage before it is sent and removed once the collector accepts or finally rejects it; one
  sender, oldest first, backoff 1 s to 30 s with `Retry-After`, drained on the next launch, on
  foreground, on `rum.flush()` and after the backoff. Bounds 5 MB, 500 requests, 24 h (oldest
  dropped first); new option `transport.offline` (bounds, or `false`). With the native module the
  batches are gzipped and posted off the JS thread. iOS replay chunks wait in a folder queue until
  the receiver accepts them. `replay.keepAtNextLaunch(session)` holds a session's replay on the
  device and decides at the next launch whether to send or delete it
  ([8f65408](https://github.com/ouo11y/ouo11y/commit/8f6540800034e658317f61dbfb674cc72be2bc89)).
- **Readable user steps** (W5, spec C6): `ui.tap` carries `ouo.ui.view_type`, `ouo.ui.gesture`
  (`tap`, `long_press`, `swipe`) and `app.screen.name`, with the step as its body
  (`Tap add-to-cart (button) on Product`); a touch is recorded when it ends and stamped at its
  start; `navigation` carries `ouo.navigation.kind = screen`. New content kill switch
  `timeline.tapLabels: false`: no label leaves the device
  ([a50e3e6](https://github.com/ouo11y/ouo11y/commit/a50e3e6858c19f047febf6ccc915114131a17fe5)).
- **User feedback** (W6, spec C10): `rum.feedback({ message, contact?, screenshot? })` sends one
  `feedback` record on the current session (`ouo.feedback.message`, `ouo.feedback.contact`,
  `ouo.feedback.id`, returned, and the session's last 20 events in `ouo.last_events`); with replay
  recording, `screenshot` asks the recorder for a masked frame
  ([b94514f](https://github.com/ouo11y/ouo11y/commit/b94514f3448af04b71d41d53c3bf365df02177b3)).
- **Hangs, terminations, TTFD and error context** (W4, spec C2 to C4): iOS app hangs of 2 s or
  more (fully blocking or not, sentry-cocoa's rules) are one non-fatal `hang` exception each, with
  the duration and the main thread's stack; a kill in the foreground without a crash report (out of
  memory, the watchdog) is a fatal `termination` exception on the next launch
  (`ouo.termination.cause`), and its session is `crashed`; `rum.reportFullyDisplayed()` adds
  `ouo.screen.ttfd_ms` to the screen's `ouo.screen.display` (which now waits for it until the
  screen is left, the background or 30 s); every `exception` carries `ouo.last_events`,
  `app.screen.name`, `ouo.device.locale` and, on iOS, memory and `network.connection.type`, and a
  crash reported by the next launch the crashed run's screen and last events
  ([aa6da5a](https://github.com/ouo11y/ouo11y/commit/aa6da5aa7dd8275538ee13e7de9adc860ad69e03)).
- **Replay modes and production-safe capture** (W1): `replay.mode` (`auto` default, `session`,
  `navigation`); route changes reach the recorder for the navigation-mode frame; the iOS recorder
  captures after the run loop's UI work within a 100 ms/s main-thread budget, never on touches,
  drops frames whose masked views move, and sends the chunk a crash left open on the next launch,
  before the sampling decision (`sdk/ios` CHANGELOG,
  [986c37a](https://github.com/ouo11y/ouo11y/commit/986c37a2c175f85c922fdc383758d0066b84b012)).
- **Replay tiles** (W3, ADR-0014): the iOS recorder sends `frames` schema 2. A frame is a full
  image or only the 64 px tiles that changed since the last frame sent, and a static screen sends
  no image bytes (on the B3 simulator journey, 120 KiB/min masked, down from 235)
  ([bf5c22d](https://github.com/ouo11y/ouo11y/commit/bf5c22d47925656414f9877b6ba448a32185f942)).
- **Session start survives an early native crash** (N52): the crash report carries the session's
  start; a session the storage never saw is ended from it with reason `crash` on the next launch
  ([986c37a](https://github.com/ouo11y/ouo11y/commit/986c37a2c175f85c922fdc383758d0066b84b012),
  [aa6da5a](https://github.com/ouo11y/ouo11y/commit/aa6da5aa7dd8275538ee13e7de9adc860ad69e03)).

### Changed

- The OTLP HTTP exporters are replaced by the outbox's own exporter: dependency
  `@opentelemetry/otlp-transformer` instead of `@opentelemetry/exporter-{logs,trace}-otlp-http`.

### Fixed

- Uninstalling the SDK waits for the outbox drain (at most 2 s), so no request of the old instance
  is still in flight afterwards
  ([e84614c](https://github.com/ouo11y/ouo11y/commit/e84614cdb41cbdf026b0abd0a2828dff77e15df5)).
- `ouo.sdk.version` (and the OTel logger and tracer version) reports the package version (0.2.1
  reported 0.2.0). release-please now bumps `src/version.ts` with `package.json`
  ([cd65004](https://github.com/ouo11y/ouo11y/commit/cd650047d988ca57584eb5bea50ee2d72e807ca3)).
- iOS: the vendored replay chunk queue no longer ages entries by the wall clock. A device clock
  moved more than a day forward dropped every queued chunk, and one moved back put new chunks
  before old ones; chunks now leave only by the queue's bounds, a final status or when unreadable
  ([eda5e32](https://github.com/ouo11y/ouo11y/commit/eda5e3206601fc440a61a3dd96d442a92f005a3d)).
  The JS OTLP outbox still drops requests older than 24 h by `Date.now()` (checklist N83).

### Compatibility

- Needs collector >= 0.5.0 and rum-api >= 0.6.0 (iOS replay schema 2), and plugin >= 0.10.0 to play
  it; see [`docs/compatibility.md`](../../docs/compatibility.md). The iOS module vendors the
  `sdk/ios` sources of its release commit: ios 0.3.0 (its changelog lists the native changes, SwiftUI
  masking included) plus the queue fix above and the iOS feedback frame (`93bc1bd`, used by React
  Native only after checklist N82);
  run `pod install` after upgrading.

## 0.2.1 - 2026-10-24

### Changed

- Published publicly on npmjs.org (`npm install @ouo11y/react-native`), released from CI through npm trusted publishing. No code changes since 0.2.0.

## 0.2.0 - 2026-10-23

Bridge parity (checklist section 3: G2 to G6, Q1). Everything but the native vitals is in the JS
SDK; the native vitals are the iOS Expo module's `getAppStartInfo()` / `getFrameStats()`.

### Added

- **Sampling** (roadmap 8b, `docs/operations/data-lifecycle.md` section 5): `session.sampleRate`
  (sessions outside it send no spans, events, logs or replay), `replay.sampleRate` and
  `replay.onErrorSampleRate` (an unrecorded session starts recording at its first error). The
  decision is deterministic per session id (FNV-1a + fmix32, shared with rum-api's server-side
  per-project cap), exported as `sampled` / `samplingHash`. JS only: the native recorder is
  started, paused and resumed per session.
- **Span API** (G3): `rum.startSpan(name, { attributes, kind, startTime, parent })` and
  `rum.withSpan(name, fn, options)` on the SDK's tracer, with the session attributes. A
  synchronous context manager makes the `withSpan` span active while `fn` runs: requests,
  logs and errors inside join its trace.
- **Log API** (G3): `rum.log(level, message, attrs)` and `rum.log.trace|debug|info|warn|error|fatal`,
  OTel log records named `log` (as the Sentry bridge maps `Sentry.logger.*`), with severity,
  `message`, the session attributes and the active span's trace id.
- **Timeline** (G4), with the Sentry bridge's names and attributes (spec section 9a): `ui.tap`
  from `RUMProvider` touches (`ouo.ui.target`, `ouo.ui.path` from `ouo-label`, `sentry-label`,
  `accessibilityLabel`, `aria-label`, `testID` or display names) and `rum.trackTap(target, path)`;
  `app.lifecycle` (`ouo.app.state` `foreground`, `inactive`, `background`); `http.request` for
  answered requests below 500 with the request span's trace id. Option `timeline: { taps,
  appLifecycle, requests }` (all default true).
- **Vitals** (G2, `docs/specs/mobile-vitals.md`): `ouo.stall` (50 ms JS loop) and
  `ouo.screen.display` (TTID per screen) measured in JS; `ouo.app.start` and `app.jank` from the
  Expo module's `getAppStartInfo()` / `getFrameStats()` (iOS: the `OuoVitals` Swift target of
  `sdk/ios`, process start from `sysctl`, cold/warm, `CADisplayLink` slow and frozen frames).
  Option `vitals: { enabled, stalls }`. New pods `OuoVitals` and `OuoVitalsCore` (run
  `pod install` after upgrading).
- **Sentry forwarding** (G6, opt-in): `errors: { forwardSentryErrors: Sentry.getClient() }` turns
  every error event Sentry sends into an ouo `exception` (`ouo.exception.kind = sentry`,
  `ouo.sentry.event_id`, `ouo.sentry.mechanism`), skipping errors ouo captured itself and
  `captureMessage`.
- **Device model without app code** (G5): expo-device's native constants are read from the Expo
  module registry when the app has expo-device; `ouo.device.simulator = true` on the simulator.
- **Trace id on errors** (G5): `exception` records carry the trace id and span id of the span the
  error escaped from, the active span, or a request that failed less than 2 s before, and
  `ouo.exception.trace_link` (`span`, `active_span`, `failed_request`).
- `http.request.failed` carries its request span's trace id and span id.
- Exports: `normalizeStack`, `touchedComponent`.

### Changed

- **Stack paths** (G5): `exception.stacktrace` frames are rewritten to `app:///<bundle>:line:col`
  (no per-install container UUIDs, no Metro host or query), one `  at fn (file:line:col)` per
  frame, `[in app]` on the app's own frames.
- Records emitted for timeline events have readable bodies (`GET <url>`, `app background`) like
  the bridge's; vitals have an empty body (spec section 1).

### Fixed

- **Q1**: one fatal error is one `exception`. React Native's dev handler printing the fatal
  through `console.error` produced a second error after the crashed session's `session.end`, and
  React dev re-throwing a render error as a new object counted a second crash (`crash_count 2`).
  An Error object reported by one hook is no longer reported by another (rejection tracker,
  `console.error` of the same object, `captureError`, the Sentry forwarder).
- Dev builds no longer trace Metro's `/symbolicate` and `/__sentry/…` calls (LogBox and Sentry's
  middleware): they were spans and `http.request` events after a crashed session's `session.end`.

Phase 8a, ADR-0007 (the collector is the edge, project tokens as HTTP Basic). The SDK talks to
the `ouo-collector` OpenTelemetry Collector distribution only: OTLP/HTTP for traces and events,
its `ouoreplay` receiver for replay chunks. rum-api is internal and never addressed by the SDK.

### Breaking changes

- Package renamed `@ouo/react-native` -> `@ouo11y/react-native` (ADR-0009; never published under the old
  name). `ouo.sdk.name` and the OTel instrumentation scope name are `@ouo11y/react-native`; data stored
  before the rename keeps `@ouo/react-native`. The CocoaPods specs (`OuoReactNative`, `OuoReplay`,
  `OuoReplayCore`) keep their names and point at `github.com/ouo11y/ouo11y`.
- `initRUM({ endpoint })` is the **collector OTLP/HTTP base URL** (for example
  `https://otel.example.com` or `http://localhost:4318`). The SDK posts to `${endpoint}/v1/traces`
  and `${endpoint}/v1/logs`.
- `initRUM({ projectId, projectToken })` are **both required**. Every OTLP export and every replay
  chunk upload carries `Authorization: Basic base64("<projectId>:<projectToken>")`, which the
  collector's `basicauth` extension validates (user name = project id, password = token).
  `initRUM` throws a `TypeError` naming the option when either is missing or empty, or when
  `projectId` contains `:` (the collector would answer 401 on every request otherwise). The
  `X-Ouo-Project-Token` header of the first 0.2.0 draft is never sent.
- `initRUM({ replayEndpoint })` is back, optional: the base URL of the collector's replay receiver,
  chunks go to `${replayEndpoint}/v1/replay/chunks`. Default: `endpoint` with port 4318 replaced
  by 4319 (the receiver's default port), or `endpoint` itself for any other port or no port (a
  proxy such as `https://otel.example.com` routes `/v1/replay/*` to the receiver). The 0.1.0
  default (OTLP host on port 8080) is gone.
- `otlpEndpoint` (first 0.2.0 draft) is removed; `endpoint` is the collector.
- Exports: `resolveEndpoints({ endpoint, replayEndpoint })`, `defaultReplayEndpoint(endpoint)`,
  `basicAuthorization(projectId, projectToken)`, `base64Encode`, `AUTHORIZATION_HEADER`,
  `DEFAULT_OTLP_PORT` (4318), `DEFAULT_REPLAY_PORT` (4319). `PROJECT_TOKEN_HEADER` and the
  0.1.0 `defaultReplayEndpoint()` (port 8080) are gone.
- `NativeStartOptions` (the record the Expo module `start(endpoint, options)` receives) gains the
  required `projectId` and `projectToken`; the native uploader builds the Basic header itself.
  Swift: `OuoReplayConfig(endpoint:projectId:projectToken:sessionId:...)` (`projectId:` is new,
  `endpoint` is the replay receiver base URL), `OuoReplayConfig.authorization` (computed),
  `ChunkUploader.init(endpoint:projectId:projectToken:...)`,
  `ChunkUploader.makeRequest(url:authorization:sessionId:seq:gzipBody:)`,
  `ChunkUploader.basicAuthorization(projectId:projectToken:)`, `ChunkUploader.authorizationHeader`
  (`"Authorization"`); `projectTokenHeader` is gone. The Expo module throws
  `ERR_OUO_REPLAY_CREDENTIAL` when either id is empty (replaces `ERR_OUO_REPLAY_TOKEN`).

### Added

- `initRUM({ resource })`: extra resource attributes on every span and log record, for example
  the rollout cohort `{ "ouo.rum.mode": "parallel" }`. The SDK's own attributes win on a clash.
- `XMLHttpRequest` instrumentation: axios and other XHR clients get the same `CLIENT` spans,
  propagation and `http.request.failed` as `fetch`. The XHR that React Native's `fetch` opens is
  skipped (one span per fetch), and `traceparent` is never added twice.
- `errors.onUnhandledRejection(error)`: called with every unhandled promise rejection after ouo
  recorded it. Hermes keeps one rejection tracker (the SDK initialised last owns it) and
  `HermesInternal` is frozen, so next to Sentry the SDK is initialised after Sentry and forwards
  rejections to `Sentry.captureException`. Debug-mode warning when a Sentry client exists and
  nothing forwards. README "Next to Sentry".

- A small RFC 4648 base64 encoder (UTF-8 input) so the header value is built the same way on
  every React Native runtime; `btoa` is not guaranteed on Hermes and `Buffer` does not exist
  there.
- Package metadata for publishing: `exports`, `repository`, `homepage`, `bugs`, `keywords`,
  `publishConfig`, `prepack` (builds and vendors the Swift sources), `CHANGELOG.md` in `files`,
  `ios/.npmignore` so the vendored Swift copies ship in the tarball.

### Migration from 0.1.0

```diff
 initRUM({
-  endpoint: "http://localhost:4318",
-  replayEndpoint: "http://localhost:8080",
+  endpoint: "http://localhost:4318",          // collector OTLP/HTTP; replay defaults to :4319
+  projectId: "demo",
+  projectToken: "pt_dev_demo_0000000000000000",
   service: { name: "mobile-store", version: appVersion, environment: "local" },
   replay: { enabled: true },
 });
```

Behind a proxy that serves both receivers from one host nothing else is needed:
`endpoint: "https://otel.example.com"` sends replay chunks to
`https://otel.example.com/v1/replay/chunks`. Pass `replayEndpoint` only when the replay receiver
lives somewhere else.

Native hosts of the Swift package:
`OuoReplayConfig(endpoint: URL(string: "http://localhost:4319")!, projectId: "demo", projectToken: "pt_…", sessionId: …)`.

A stock OpenTelemetry SDK can post to the same collector without ouo code:
`OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com` and
`OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64>`.

## 0.1.0 (2026-10-08)

First version: sessions, errors and crashes, fetch tracing with W3C Trace Context and Baggage,
OTLP/HTTP export, native iOS session replay through the `OuoReplay` Expo module (ADR-0006),
masking opt-out (`maskText`, `maskInputs`, `maskImages`, `maskWebViews`).
