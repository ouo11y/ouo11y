# sentry-cocoa configuration (every public option)

sentry-cocoa 9.33.0 (tag, 2026-11-04). Research date 2026-11-10. Method: source read at the tag; docs accessed 2026-11-10.

Main defaults at feature level: [sentry-mobile.md](../../../../client-sdk-features/vendors/sentry-mobile.md). Internals: [architecture.md](architecture.md). Disk and network behaviour: [reliability.md](reliability.md).

All defaults below are **read** from source at the tag unless marked. "v9" = the shipped 9.33.0 build (`SDK_V10` off). Rows marked *(v10 only)* exist in the tree behind `#if SDK_V10` and are **not** in the 9.33.0 public API.

Link shorthand: every "L<n>" in the Source column links to the file named in the group heading at tag 9.33.0.

## 1. `Options` (`SentryOptions` in ObjC)

File: [Sources/Swift/Options.swift](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift).

### Core

| Option | Default | Effect | Source |
|---|---|---|---|
| `dsn` | nil | Where to send. Invalid DSN → `dsn` and `parsedDsn` set to nil, error logged, nothing sent | [L23](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L23) |
| `parsedDsn` | nil | Parsed form, set by `dsn` | [L36](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L36) |
| `debug` | false | SDK console logging | [L41](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L41) |
| `diagnosticLevel` | `.debug` (v10: `.warning`) | Minimum SDK log level when `debug` | [L43-L51](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L43-L51) |
| `releaseName` | `<CFBundleIdentifier>@<CFBundleShortVersionString>+<CFBundleVersion>` | Event `release` | [L54](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L54), [SentryReleaseName.swift#L5-L17](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentryReleaseName.swift#L5-L17) |
| `dist` | nil (client fills `CFBundleVersion` if the event has none) | Event `dist` | [L59](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L59), [SentryClient.m#L331-L334](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Sentry/SentryClient.m#L331-L334) |
| `environment` | `"production"` | Used when the scope has none | [L63](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L63), [L865](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L865) |
| `enabled` | true | false → events dropped in the client | [L67](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L67) |
| `shutdownTimeInterval` | 2.0 s | Flush budget in `close()` | [L70](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L70) |
| `maxBreadcrumbs` | 100 | Scope breadcrumbs; also crash-sync ring and watchdog breadcrumb file size | [L152](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L152) |
| `maxFeatureFlags` | 100 | Flag evaluations kept on scope (0 = off); spans keep first 10 regardless | [L162](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L162) |
| `maxCacheItems` | 30 | Max envelopes on disk, oldest deleted | [L173](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L173) |
| `maxAttachmentSize` | 200 MiB | Per-attachment cap | [L336](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L336) |
| `initialScope` | identity closure | Configure the scope at start | [L367](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L367) |
| `inAppIncludes` (read-only) + `add(inAppInclude:)` | `[CFBundleExecutable]` | In-app frames; also which images get UIViewController swizzling | [L555-L566](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L555-L566) |
| `urlSessionDelegate` | nil (weak) | Delegate of the SDK's own URLSession; ignored if `urlSession` set | [L570](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L570) |
| `urlSession` | nil → new `ephemeral` session | Transport URLSession | [L575](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L575) |
| `sendClientReports` | true | Send discard statistics | [L631](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L631) |
| `cacheDirectoryPath` | user Caches directory | Root for `io.sentry/` and `SentryCrash/` | [L787](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L787) |
| `enableSpotlight` | false | Adds a Spotlight transport (warns in release builds) | [L793](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L793) |
| `spotlightUrl` | `http://localhost:8969/stream` | Spotlight target | [L805](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L805) |
| `orgId` | nil (DSN org used) | Org id for `strictTraceContinuation` | [L824](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L824) |
| `experimental` | `SentryExperimentalOptions()` | See §6 | [L837](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L837) |
| `sendDefaultPii` (v9 only) | false | User IP/identity. Note: Cocoa still sets `infer_ip=auto` by default per the doc comment | [L338-L347](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L338-L347) |
| `dataCollection` *(v10 only)* | `SentryDataCollection.Options()` | Granular replacement for `sendDefaultPii` | [L867-L875](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L867-L875) |
| `privacy` *(v10 only)* | `SentryPrivacyOptions()` | Shared masking for replay and screenshots | [L385-L389](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L385-L389) |

### Callbacks

| Option | Default | Effect | Source |
|---|---|---|---|
| `beforeSend` | nil | Modify or drop (nil) events | [L176](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L176) |
| `beforeSendWithHint` | nil | Takes precedence over `beforeSend`; setter deprecated | [L183-L188](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L183-L188) |
| `beforeSendTransaction` *(v10 only)* | nil | Modify/drop transactions with hint | [L190-L198](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L190-L198) |
| `beforeSendSpan` | nil | Modify or drop spans | [L202](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L202) |
| `beforeSendLog` | nil | Modify or drop logs | [L219](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L219) |
| `beforeSendMetric` | nil | Modify or drop metrics | [L892](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L892) |
| `beforeBreadcrumb` | nil | Modify or drop breadcrumbs | [L222](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L222) |
| `beforeBreadcrumbWithHint` | nil | Takes precedence; setter deprecated | [L229-L236](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L229-L236) |
| `beforeCaptureScreenshot` | nil | Veto screenshot per event (not for crashes) | [L239](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L239) |
| `beforeCaptureViewHierarchy` | nil | Veto view hierarchy per event (not for crashes) | [L244](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L244) |
| `onCrashedLastRun` (deprecated) | nil | Called once if last run crashed | [L246-L257](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L246-L257) |
| `onLastRunStatusDetermined` | nil | Called once per start with `didCrash` + event or `didNotCrash` | [L274](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L274) |

### Crashes, hangs, terminations

| Option | Default | Effect | Source |
|---|---|---|---|
| `enableCrashHandler` | true | Install SentryCrash; off also disables watchdog tracking. Disabled while a debugger is attached | [L72-L91](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L72-L91) |
| `enableUncaughtNSExceptionReporting` (macOS only) | false | Swizzle NSApplication exception reporting | [L93-L108](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L93-L108) |
| `enableSigtermReporting` (deprecated) | false | Report SIGTERM as crash | [L110-L128](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L110-L128) |
| `enableUnhandledCPPExceptionsV2` *(v10 only top-level; v9 under `experimental`)* | false | Hook `__cxa_throw` for throw-site stacks | [L130-L138](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L130-L138) |
| `enableMemoryIntrospection` | false | Record memory near stack/registers in crash report (may hold PII) | [L148](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L148) |
| `attachStacktrace` | true | Stack trace on messages (current thread) | [L322](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L322) |
| `attachAllThreads` | false | All threads on every event (suspends threads) | [L329](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L329) |
| `enableWatchdogTerminationTracking` | true | Next-launch watchdog/OOM heuristic | [L312](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L312) |
| `enableAppHangTracking` (v9; deprecated in docs) | true | Hang tracker | [L633-L656](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L633-L656) |
| `enableReportNonFullyBlockingAppHangs` (setter deprecated) | true | Report non-fully-blocking hangs | [L448-L467](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L448-L467) |
| `appHangTimeoutInterval` | 2.0 s | Hang threshold; also used for watchdog classification. ≤ 0 → 2 s | [L668](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L668) |
| `enablePersistingTracesWhenCrashing` | false | Finish and save the scope transaction in the crash handler | [L361](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L361) |
| `swiftAsyncStacktraces` | false (v10: true) | Stitch Swift async frames | [L772-L780](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L772-L780) |
| `enableMetricKit` (v9) | false | MetricKit: CPU, disk-write, hang diagnostics (iOS 15+, macOS 12+) | [L740-L752](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L740-L752) |
| `enableMetricKitRawPayload` | false | Attach raw `MXDiagnosticPayload` | [L759](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L759) |

### Sessions, breadcrumbs, attachments

| Option | Default | Effect | Source |
|---|---|---|---|
| `enableAutoSessionTracking` | true | Release-health sessions | [L302](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L302) |
| `sessionTrackingIntervalMillis` | 30 000 | Background time that ends a session (checked on return) | [L316](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L316) |
| `enableAutoBreadcrumbTracking` | true | System, navigation, touch breadcrumbs | [L680](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L680) |
| `enableNetworkBreadcrumbs` | true | `http` breadcrumbs (needs swizzling) | [L169](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L169) |
| `enableGraphQLOperationTracking` | false | Add `operationName` to HTTP breadcrumbs | [L306](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L306) |
| `attachScreenshot` | false | Screenshot on error events | [L383](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L383) |
| `screenshot` | `SentryViewScreenshotOptions()` | Masking/rendering for screenshots (§3) | [L392](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L392) |
| `attachViewHierarchy` | false | View hierarchy JSON on error events | [L401](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L401) |
| `reportAccessibilityIdentifier` | true | Include `accessibilityIdentifier` in view hierarchy | [L408](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L408) |
| `enableLogs` (deprecated legacy) | false | Does **not** gate `SentrySDK.logger`; removed in v10 | [L204-L214](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L204-L214) |
| `enableMetrics` (deprecated legacy) | true | Does **not** gate `SentrySDK.metrics`; removed in v10 | [L879-L887](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L879-L887) |
| `configureUserFeedback` | nil | Setting it creates the feedback config and installs `UserFeedbackIntegration` (§5) | [L839-L856](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L839-L856) |
| `sessionReplay` | `SentryReplayOptions()` | §2 | [L482](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L482) |

### Tracing and performance

| Option | Default | Effect | Source |
|---|---|---|---|
| `tracesSampleRate` | **nil** (doc comment says 0; same effect: tracing off). Out of range → 0 | Root trace sample rate | [L521-L537](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L521-L537) |
| `tracesSampler` | nil | Per-transaction rate; wins over parent decision and `tracesSampleRate` | [L544](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L544) |
| `isTracingEnabled` (read-only) | false | `tracesSampleRate` in (0,1] or sampler set | [L549](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L549) |
| `enableAutoPerformanceTracing` | true | Master switch for auto instrumentation | [L354](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L354) |
| `enableUIViewControllerTracing` | true | `ui.load` transactions | [L375](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L375) |
| `enableUserInteractionTracing` | true | `ui.action` idle transactions (UIKit) | [L415](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L415) |
| `idleTimeout` | 3.0 s | Idle wait for UI-event transactions | [L422](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L422) |
| `enablePreWarmedAppStartTracing` | true | Report prewarmed starts (trimmed) | [L438](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L438) |
| `enableStandaloneAppStartTracing` (v9 only) | false | Separate `app.start` transaction | [L440-L446](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L440-L446) |
| `enableTimeToFullDisplayTracing` | false | TTFD span, waits for `reportFullyDisplayed()` up to 30 s | [L770](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L770) |
| `enableNetworkTracking` | true | `http.client` spans | [L491](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L491) |
| `enableFileIOTracing` | true | File I/O spans | [L496](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L496) |
| `enableDataSwizzling` | true | `NSData` I/O swizzling | [L501](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L501) |
| `enableFileManagerSwizzling` | false (v10: true) | `NSFileManager` I/O swizzling | [L503-L513](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L503-L513) |
| `enableCoreDataTracing` | true | Core Data spans | [L595](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L595) |
| `enableSwizzling` | true | Off disables touch/nav crumbs, VC + HTTP + file I/O instrumentation, trace headers | [L583](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L583) |
| `swizzleClassNameExcludes` | `[]` | Skip classes whose name contains an entry | [L590](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L590) |
| `tracePropagationTargets` | `[".*"]` (all) | Hosts/regex that get `sentry-trace` + `baggage` | [L701](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L701) |
| `enablePropagateTraceparent` | false | Also send W3C `traceparent` to targets | [L690](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L690) |
| `strictTraceContinuation` | false | Continue incoming trace only if org id matches | [L817](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L817) |
| `enableCaptureFailedRequests` | true | HTTP client error events | [L714](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L714) |
| `failedRequestStatusCodes` | `[500-599]` | Status ranges that create events | [L720](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L720) |
| `failedRequestTargets` | `[".*"]` | URLs eligible for failed-request events | [L728](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L728) |
| `configureProfiling` (not watchOS/tvOS/visionOS) | nil (profiling off) | Setting it creates `SentryProfileOptions` (§4) | [L597-L626](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L597-L626) |
| `sampleRate` | 1 (out of range → 1) | Error-event sampling (not transactions, replays, feedback) | [L282-L298](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L282-L298) |

Not public on `Options`: `profilesSampleRate` and `profilesSampler` (removed; only referenced in doc comments, [SentryProfileOptions.swift#L4-L7](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/Integrations/Performance/SentryProfileOptions.swift#L4-L7)).

## 2. `SentryReplayOptions` (`options.sessionReplay`)

File: [Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift). Defaults at [L11-L45](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L11-L45).

| Option | Default | Effect | Source |
|---|---|---|---|
| `sessionSampleRate` | 0 | Per-session chance of full recording | [L123](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L123) |
| `onErrorSampleRate` | 0 | Per-error chance to send the 30 s buffer | [L133](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L133) |
| `maskAllText` (v9) | true | Mask text views | [L142](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L142) |
| `maskAllImages` (v9) | true | Mask non-bundled images | [L150](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L150) |
| `quality` | `.medium` | Bitrate 20/40/60 kbps for low/medium/high; low also scales 0.8 | [L159](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L159), [L106-L112](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L106-L112) |
| `maskedViewClasses` (v9) | `[]` | Extra classes to mask | [L170](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L170) |
| `unmaskedViewClasses` (v9) | `[]` | Classes never masked | [L180](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L180) |
| `excludedViewClasses` (v9) | `[]` (+ built-in defaults, e.g. `CameraUI.ChromeSwiftUIView` on iOS 26) | Skip subtree traversal (substring match) | [L199](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L199) |
| `includedViewClasses` (v9) | `[]` | Re-include (exact match) | [L222](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L222) |
| `excludeViewTypeFromSubtreeTraversal(_:)` / `includeViewTypeInSubtreeTraversal(_:)` | — | Helpers for the two sets | [L236](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L236), [L252](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L252) |
| `enableExperimentalViewRenderer` (deprecated) | alias | Renamed to `enableViewRendererV2` | [L264-L271](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L264-L271) |
| `enableViewRendererV2` | true | Faster renderer and mask renderer | [L287](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L287) |
| `enableFastViewRendering` | false | `layer.render` instead of `drawHierarchy` (misses some effects) | [L310](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L310) |
| `networkDetailAllowUrls` | `[]` | URLs whose request/response details go into replay | [L348](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L348) |
| `networkDetailDenyUrls` | `[]` | Exclusions | [L369](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L369) |
| `networkCaptureBodies` | true | Bodies for allowed URLs | [L384](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L384) |
| `networkRequestHeaders` / `networkResponseHeaders` | `Content-Type`, `Content-Length`, `Accept` (always merged in) | Headers captured for allowed URLs | [L406](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L406), [L432](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L432), [L787-L813](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L787-L813) |
| `replayBitRate`, `sizeScale` (`@_spi(Private)`) | from `quality` | Not settable | [L445](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L445), [L454](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L454) |
| `frameRate` (`@_spi(Private)`) | 1 (min 1) | Capture fps | [L465](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L465) |
| `errorReplayDuration` (`@_spi(Private)`) | 30 s | Buffer length | [L476](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L476) |
| `sessionSegmentDuration` (`@_spi(Private)`) | 5 s | Segment length | [L481](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L481) |
| `maximumDuration` (`@_spi(Private)`) | 3600 s | Max replay length | [L488](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L488) |

The `@_spi(Private)` values can be set by hybrid SDKs through `init(dictionary:)` (keys `frameRate`, `errorReplayDuration`, `sessionSegmentDuration`, `maximumDuration`, and `errorSampleRate` for `onErrorSampleRate`) ([L589-L620](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L589-L620)). The doc comments say out-of-range sample rates are reset to the default, but no setter clamping was found (*uncertain*; read: plain stored properties).

## 3. `SentryViewScreenshotOptions` (`options.screenshot`)

File: [Sources/Swift/Integrations/Screenshot/SentryScreenshotOptions.swift](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Screenshot/SentryScreenshotOptions.swift). Defaults [L11-L22](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Screenshot/SentryScreenshotOptions.swift#L11-L22).

| Option | Default | Source |
|---|---|---|
| `enableViewRendererV2` | true | [L39](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Screenshot/SentryScreenshotOptions.swift#L39) |
| `enableFastViewRendering` | false | [L62](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Screenshot/SentryScreenshotOptions.swift#L62) |
| `maskAllImages` | true | [L73](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Screenshot/SentryScreenshotOptions.swift#L73) |
| `maskAllText` | true | [L81](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Screenshot/SentryScreenshotOptions.swift#L81) |
| `maskedViewClasses` / `unmaskedViewClasses` | `[]` | [L91](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Screenshot/SentryScreenshotOptions.swift#L91), [L101](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Screenshot/SentryScreenshotOptions.swift#L101) |
| `excludedViewClasses` / `includedViewClasses` (read-only, via helpers) | `[]` | [L120](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Screenshot/SentryScreenshotOptions.swift#L120), [L143](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Screenshot/SentryScreenshotOptions.swift#L143) |

## 4. `SentryProfileOptions` (`configureProfiling`)

File: [Sources/Swift/Core/Integrations/Performance/SentryProfileOptions.swift](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/Integrations/Performance/SentryProfileOptions.swift). iOS and macOS only.

| Option | Default | Effect | Source |
|---|---|---|---|
| `lifecycle` | `.manual` | `.manual`: `SentrySDK.startProfiler()/stopProfiler()`. `.trace`: runs while ≥ 1 sampled root span is active (needs tracing) | [L14-L49](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/Integrations/Performance/SentryProfileOptions.swift#L14-L49) |
| `sessionSampleRate` | 0 | Sampled at SDK start; re-evaluated on each foreground | [L65](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/Integrations/Performance/SentryProfileOptions.swift#L65) |
| `profileAppStarts` | false | Start profiler at launch; decision from previous launch | [L77](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/Integrations/Performance/SentryProfileOptions.swift#L77) |

## 5. `SentryUserFeedbackConfiguration` (top-level fields)

File: [Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift). iOS only.

| Field | Default | Effect | Source |
|---|---|---|---|
| `animations` | true | Form/widget animations | [L21](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L21) |
| `configureWidget` (deprecated) | nil | Managed floating widget, removed in v10 | [L30-L34](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L30-L34) |
| `useShakeGesture` | false | Open form on shake | [L49](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L49) |
| `showFormForScreenshots` | false | Open form when the user takes a screenshot | [L56](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L56) |
| `customButton` (deprecated) | nil | Own button for the widget | [L65-L72](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L65-L72) |
| `configureForm` | nil | Form texts/fields (`SentryUserFeedbackFormConfiguration`, e.g. `enableScreenshot` false, `isEmailRequired` false, `useSentryUser` true) | [L82](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L82), [SentryUserFeedbackFormConfiguration.swift#L19-L234](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackFormConfiguration.swift#L19-L234) |
| `tags` | nil | Tags on feedback | [L91](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L91) |
| `onFormOpen` / `onFormClose` | nil | Callbacks | [L97](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L97), [L103](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L103) |
| `onSubmitSuccess` / `onSubmitError` | nil | Callbacks | [L110](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L110), [L117](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L117) |
| `configureTheme` | nil | Colours/fonts | [L125](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L125) |
| `configureDarkTheme` (deprecated) | nil | Use dynamic `UIColor` instead | [L136-L140](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L136-L140) |

## 6. Experimental (`options.experimental`)

File: [Sources/Swift/SentryExperimentalOptions.swift](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/SentryExperimentalOptions.swift) and [SentryMetricKitOptions.swift](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/MetricKit/SentryMetricKitOptions.swift).

| Option | Default | Effect | Source |
|---|---|---|---|
| `enableUnhandledCPPExceptionsV2` (v9) | false | Hook `__cxa_throw` for C++ throw-site stacks | [SentryExperimentalOptions.swift#L18](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/SentryExperimentalOptions.swift#L18) |
| `enableNewURLLoaderSwizzling` | false | Instrument the new URLSession HTTP loader | [SentryExperimentalOptions.swift#L28](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/SentryExperimentalOptions.swift#L28) |
| `enableWatchdogTerminationsV2` (setter deprecated; default in v10) | false | Run-loop hang source for watchdog classification | [SentryExperimentalOptions.swift#L31-L44](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/SentryExperimentalOptions.swift#L31-L44) |
| `enableUIViewControllerInitSwizzling` | false | Lazy per-class VC swizzling at first init | [SentryExperimentalOptions.swift#L65](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/SentryExperimentalOptions.swift#L65) |
| `metrickit.enabledDiagnosticReports` | `[]` in v9 (v10: cpu, disk, hang, appLaunch) | Non-empty enables MetricKit regardless of `enableMetricKit` | [SentryMetricKitOptions.swift#L24-L43](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/MetricKit/SentryMetricKitOptions.swift#L24-L43) |
| `metrickit.enabledMetricReports` | `[]` | Daily metric reports as Sentry metrics; `.all` supported | [SentryMetricKitOptions.swift#L45-L57](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/MetricKit/SentryMetricKitOptions.swift#L45-L57) |
| `metrickit.hangReportingMode` | `.legacy` | `.flamegraphAttachment` alternative | [SentryMetricKitOptions.swift#L60-L62](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/MetricKit/SentryMetricKitOptions.swift#L60-L62) |

## 7. Environment, Info.plist and dictionary inputs

| Input | Effect | Source |
|---|---|---|
| env `SENTRY_DSN` | Read in `Options.init` **on macOS only** (`#if os(macOS)`); not on iOS | [Options.swift#L5-L18](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L5-L18) |
| env `XCODE_RUNNING_FOR_PREVIEWS=1` | SDK does not start | [SentrySDK.swift#L107-L115](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L107-L115) |
| env `XCTestConfigurationFilePath` | Watchdog termination tracking off | [SentryWatchdogTerminationTrackingIntegration.swift#L38](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/WatchdogTerminations/SentryWatchdogTerminationTrackingIntegration.swift#L38) |
| Info.plist `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion` | Default `releaseName`; `CFBundleVersion` default `dist` | [SentryReleaseName.swift#L9-L17](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentryReleaseName.swift#L9-L17), [SentryClient.m#L331-L334](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Sentry/SentryClient.m#L331-L334) |
| Info.plist `CFBundleExecutable` | Default `inAppIncludes` | [Options.swift#L555-L560](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L555-L560) |
| Info.plist `NSExtension` / `NSExtensionPointIdentifier` | Some extension types disable hang tracking | [SentryInfoPlistKey.swift#L5-L12](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/InfoPlist/SentryInfoPlistKey.swift#L5-L12), [SentryHangTrackingIntegration.swift#L33-L36](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/AppHangTracking/SentryHangTrackingIntegration.swift#L33-L36) |
| `Options(dictionary:)` | Hybrid SDK path (RN, Flutter) mapping string keys to options | [Options+Dictionary.swift](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift) |

No SDK-specific Info.plist keys (e.g. a DSN key) were found (read: only `NSExtension` keys in `SentryInfoPlistKey`).

## 8. Manual API (`SentrySDK` static members)

File: [Sources/Swift/Helper/SentrySDK.swift](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift).

| Member | Notes | Source |
|---|---|---|
| `start(options:)`, `start(configureOptions:)` | Init; see [architecture.md](architecture.md) §2 | [L106](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L106), [L128](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L128) |
| `isEnabled`, `span` | State | [L23](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L23), [L31](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L31) |
| `capture(event:…)`, `capture(error:…)`, `capture(exception:…)`, `capture(message:…)` | Variants with `scope`, `block`, `hint`, `attachAllThreads`; return `SentryId` | [L142-L573](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L142-L573) |
| `startTransaction(…)` | name/operation or context, `bindToScope`, `customSamplingContext` | [L238-L294](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L238-L294) |
| `capture(feedback:)`, `feedback` (`.show()`) | User feedback | [L590](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L590), [L610](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L610) |
| `addBreadcrumb`, `configureScope`, `setUser`, `addFeatureFlag` | Scope | [L621](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L621), [L631](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L631), [L690](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L690), [L639](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L639) |
| `crashedLastRun` (deprecated), `lastRunStatus`, `detectedStartUpCrash` | Last-run state | [L653-L678](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L653-L678) |
| `startSession()`, `endSession()` | Manual sessions | [L703](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L703), [L713](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L713) |
| `crash()` | Test crash (null write, SIGSEGV) | [L725](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L725) |
| `reportFullyDisplayed()` | TTFD end | [L738](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L738) |
| `extendAppStart()`, `getExtendedAppStartSpan()`, `finishExtendedAppStart()` | Extend the app start span | [L771-L826](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L771-L826) |
| `pauseAppHangTracking()`, `resumeAppHangTracking()` (deprecated) | | [L841-L851](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L841-L851) |
| `flush(timeout:)`, `close()` | | [L864](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L864), [L873](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L873) |
| `startProfiler()`, `stopProfiler()` | Manual profiling | [L899](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L899), [L916](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L916) |
| `replay` (`SentryReplayApi`: pause, resume, start, stop, mask preview) | iOS/tvOS/visionOS | [L40](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L40), [SentrySessionReplayIntegration.swift#L437-L494](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentrySessionReplayIntegration.swift#L437-L494) |
| `logger` | Structured logs | [L51](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L51) |
| `metrics` | count / gauge / distribution | [L95](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L95) |

## 9. Sampling

- **Errors.** `sampleRate` (default 1). Applied in the client to all events except transactions, replay and feedback: `random <= sampleRate` keeps; drops are counted as client report `sample_rate` ([SentryClient.m#L317-L329](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Sentry/SentryClient.m#L317-L329), [SentryClient+EventPreparation.m#L93-L99](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Sentry/SentryClient+EventPreparation.m#L93-L99)).
- **Traces.** Order in `SentrySampling.sampleTrace`: (1) decision already on the transaction context; (2) `tracesSampler(SamplingContext)` if it returns a rate; (3) parent's decision; (4) `tracesSampleRate` ([SentrySampling.swift#L8-L34](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/SentrySampling.swift#L8-L34)). `SamplingContext` carries `transactionContext` and `customSamplingContext` ([SentrySamplingContext.swift#L8-L34](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/SentrySamplingContext.swift#L8-L34)). Note: the sampler wins over the parent decision here.
- **Profiles.** `SentryProfileOptions.sessionSampleRate`, decided per "profile session" (start → background), re-rolled on foreground ([SentrySampling.swift#L37-L41](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/SentrySampling.swift#L37-L41), [SentryProfileOptions.swift#L51-L65](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Core/Integrations/Performance/SentryProfileOptions.swift#L51-L65), [SessionTracker.swift#L220](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Session/SessionTracker.swift#L220)). In `.trace` lifecycle the trace decision also applies.
- **Replay.** Decided once per **release-health session** on `sentrySessionStarted`: `random < sessionSampleRate` → session mode; else if `onErrorSampleRate > 0` → buffer mode; else off ([SentrySessionReplayIntegration.swift#L249-L261](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentrySessionReplayIntegration.swift#L249-L261)). In buffer mode each error/exception event rolls `random <= onErrorSampleRate` ([SentrySessionReplayIntegration.swift#L553](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentrySessionReplayIntegration.swift#L553)); the first hit sends the buffer and turns the replay into session mode for the rest of the session ([SentrySessionReplay.swift#L387-L438](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentrySessionReplay.swift#L387-L438)). A recovered buffer replay after a crash rolls `errorSampleRate` again ([SessionReplayRecovery.swift#L138-L145](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SessionReplayRecovery.swift#L138-L145)). Replay has no link to trace sampling.
- **Sessions** are not sampled (read: no rate option for them).

## 10. Deprecated or changed for v10

Read from `@available(*, deprecated…)`, doc comments and `#if !SDK_V10` guards.

| Option / API | v10 fate | Source |
|---|---|---|
| `enableSigtermReporting` | removed (KSCrash records SIGTERM as clean exit) | [Options.swift#L122](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L122) |
| `beforeSendWithHint`, `beforeBreadcrumbWithHint` | removed; hint moves into `beforeSend` / `beforeBreadcrumb` | [Options.swift#L185](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L185), [Options.swift#L231](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L231) |
| `onCrashedLastRun`, `SentrySDK.crashedLastRun` | removed; use `onLastRunStatusDetermined` / `lastRunStatus` | [Options.swift#L255](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L255), [SentrySDK.swift#L653](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Helper/SentrySDK.swift#L653) |
| `enableAppHangTracking`, `enableReportNonFullyBlockingAppHangs`, `pause/resumeAppHangTracking` | removed with app hang tracking; MetricKit instead | [Options.swift#L462](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L462), [Options.swift#L652-L656](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L652-L656) |
| `enableMetricKit` | removed; `experimental.metrickit.enabledDiagnosticReports` (non-empty default in v10) | [Options.swift#L740-L753](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L740-L753) |
| `enableLogs`, `enableMetrics` | removed; always on | [Options.swift#L204-L215](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L204-L215), [Options.swift#L879-L888](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L879-L888) |
| `sendDefaultPii` | replaced by `dataCollection` | [Options.swift#L338-L347](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L338-L347), [Options.swift#L867-L875](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L867-L875) |
| `enableStandaloneAppStartTracing` | removed | [Options.swift#L440-L446](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L440-L446) |
| `experimental.enableWatchdogTerminationsV2` | removed; V2 is default | [SentryExperimentalOptions.swift#L40](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/SentryExperimentalOptions.swift#L40) |
| `experimental.enableUnhandledCPPExceptionsV2` | moves to top level | [SentryExperimentalOptions.swift#L9-L19](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/SentryExperimentalOptions.swift#L9-L19) |
| Replay `maskAllText`, `maskAllImages`, `masked/unmaskedViewClasses`, `excluded/includedViewClasses` | move to `options.privacy` | [SentryReplayOptions.swift#L135-L256](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L135-L256) |
| Replay `enableExperimentalViewRenderer` | deprecated alias | [SentryReplayOptions.swift#L264](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L264) |
| Feedback `configureWidget`, `customButton`, `configureDarkTheme` | widget removed in v10 | [SentryUserFeedbackConfiguration.swift#L31](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L31), [SentryUserFeedbackConfiguration.swift#L69](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L69), [SentryUserFeedbackConfiguration.swift#L137](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/UserFeedback/Configuration/SentryUserFeedbackConfiguration.swift#L137) |
| Default changes | `diagnosticLevel` → `.warning`; `swiftAsyncStacktraces` → true; `enableFileManagerSwizzling` → true | [Options.swift#L43-L51](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L43-L51), [Options.swift#L772-L780](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L772-L780), [Options.swift#L503-L513](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L503-L513) |

Full v10 notes: [CHANGELOG_V10.md](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/CHANGELOG_V10.md) and [MIGRATION.md](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/MIGRATION.md) (not read line by line; *uncertain* whether they list more).
