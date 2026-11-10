# Sentry mobile SDK feature research

- **Vendor:** Sentry
- **Platforms:** iOS (sentry-cocoa), Android (sentry-java / sentry-android), React Native (sentry-react-native, incl. Expo)
- **SDK versions checked (source read at tag):**
  - sentry-cocoa **9.33.0** (released 2026-11-04)
  - sentry-java **8.63.0** (released 2026-11-05)
  - sentry-react-native **8.34.0** (released 2026-11-05). It depends on @sentry/core, @sentry/browser and @sentry/react 10.78.0, pins sentry-cocoa 9.33.0 (`RNSentry.podspec`) and pins sentry-android **8.62.0** (`android/build.gradle`).
- **Research date:** 2026-11-10
- **Method:** Defaults come from source code at the release tag. Behaviour comes from docs.sentry.io; none of the docs pages fetched showed a last-updated date, so they are dated "accessed 2026-11-10". Cells marked *uncertain* were not confirmed from a primary source.

## Source key

Cells cite these short keys. Code links point at the release tag; the tag date is the source date.

| Key | URL | Date |
|---|---|---|
| C-opt | https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift | tag 9.33.0, 2026-11-04 |
| C-rpl | https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift | 2026-11-04 |
| C-odr | https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryOnDemandReplay.swift (AVAssetWriter .mp4, H.264) | 2026-11-04 |
| C-fm | https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Sentry/SentryFileManagerHelper.m (maxEnvelopes, 90-day purge) | 2026-11-04 |
| C-req | https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Tools/SentryURLRequestFactory.swift (gzip, 15 s timeout) | 2026-11-04 |
| C-sess | https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/Session/SessionTracker.swift | 2026-11-04 |
| C-wv | https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/WebView/SentryWebViewTracing.swift | 2026-11-04 |
| C-tree | https://github.com/getsentry/sentry-cocoa/tree/9.33.0/Sources/Swift (FeatureFlags/, UserFeedback/, AppHangTracking/, MetricKit/, SentrySwiftUI/, Breadcrumbs/SentryHinge*) | 2026-11-04 |
| C-cl | https://github.com/getsentry/sentry-cocoa/blob/main/CHANGELOG.md (9.31.0 to 9.33.0 and Unreleased) | accessed 2026-11-10 |
| J-opt | https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryOptions.java | tag 8.63.0, 2026-11-05 |
| J-and | https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-core/src/main/java/io/sentry/android/core/SentryAndroidOptions.java | 2026-11-05 |
| J-rpl | https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryReplayOptions.java | 2026-11-05 |
| J-enc | https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-replay/src/main/java/io/sentry/android/replay/video/SimpleVideoEncoder.kt (`c2.android.avc.encoder`, MP4 muxer) | 2026-11-05 |
| J-mod | https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-replay/src/main/java/io/sentry/android/replay/ModifierExtensions.kt | 2026-11-05 |
| J-http | https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/transport/HttpConnection.java (gzip) | 2026-11-05 |
| J-okh | https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt | 2026-11-05 |
| J-dc | https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/DataCollection.java | 2026-11-05 |
| J-tree | https://github.com/getsentry/sentry-java/tree/8.63.0 (module list: android-core, -ndk, -replay, -fragment, -navigation, -sqlite, -timber, compose, okhttp, apollo, openfeature, launchdarkly-android, opentelemetry, android-distribution) | 2026-11-05 |
| J-cl | https://github.com/getsentry/sentry-java/blob/main/CHANGELOG.md (8.61.1 to 8.63.0 and Unreleased) | accessed 2026-11-10 |
| R-opt | https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts | tag 8.34.0, 2026-11-05 |
| R-rpl | https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts | 2026-11-05 |
| R-def | https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/default.ts | 2026-11-05 |
| R-touch | https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/touchevents.tsx and .../ragetap.ts | 2026-11-05 |
| R-app | https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/integrations/appStart.ts | 2026-11-05 |
| R-nav | https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnavigation.ts (+ expoRouter*.ts, reactnativenavigation.ts) | 2026-11-05 |
| R-ttd | https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/timetodisplay.tsx | 2026-11-05 |
| R-err | https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/reactnativeerrorhandlers.ts | 2026-11-05 |
| R-stall | https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/integrations/stalltracking.ts | 2026-11-05 |
| R-tree | https://github.com/getsentry/sentry-react-native/tree/8.34.0/packages/core/src/js (feedback/, replay/, profiling/, tools/, integrations/) | 2026-11-05 |
| R-pkg | https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/package.json, RNSentry.podspec, android/build.gradle | 2026-11-05 |
| R-cl | https://github.com/getsentry/sentry-react-native/blob/main/CHANGELOG.md (8.32.0 to 8.34.0) | accessed 2026-11-10 |
| D-ios-sr | https://docs.sentry.io/platforms/apple/guides/ios/session-replay/ | accessed 2026-11-10 |
| D-and-sr | https://docs.sentry.io/platforms/android/session-replay/ | accessed 2026-11-10 |
| D-rn-sr | https://docs.sentry.io/platforms/react-native/session-replay/ | accessed 2026-11-10 |
| D-ios-fb | https://docs.sentry.io/platforms/apple/guides/ios/user-feedback/ | accessed 2026-11-10 |
| D-and-fb | https://docs.sentry.io/platforms/android/user-feedback/ | accessed 2026-11-10 |
| D-rn-fb | https://docs.sentry.io/platforms/react-native/user-feedback/ | accessed 2026-11-10 |
| D-ios-auto | https://docs.sentry.io/platforms/apple/guides/ios/tracing/instrumentation/automatic-instrumentation/ | accessed 2026-11-10 |
| D-and-auto | https://docs.sentry.io/platforms/android/tracing/instrumentation/automatic-instrumentation/ | accessed 2026-11-10 |
| D-ios-wt | https://docs.sentry.io/platforms/apple/guides/ios/configuration/watchdog-terminations/ | accessed 2026-11-10 |
| D-and-anr | https://docs.sentry.io/platforms/android/configuration/app-not-respond/ | accessed 2026-11-10 |
| D-and-gp | https://docs.sentry.io/platforms/android/configuration/gradle/ | accessed 2026-11-10 |
| D-rn-sm | https://docs.sentry.io/platforms/react-native/sourcemaps/ | accessed 2026-11-10 |
| D-ios-dsym | https://docs.sentry.io/platforms/apple/guides/ios/dsym/ | accessed 2026-11-10 |

---

## SES sessions

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| SES-a | yes, auto | yes, auto | yes (native sessions) | `enableAutoSessionTracking` defaults to true on all three. These are release-health sessions (status ok/crashed/abnormal/errored), not RUM view sessions. | C-opt, J-opt, R-opt |
| SES-b | yes, 30 s background | yes, 30 s background | yes, 30 s | `sessionTrackingIntervalMillis` = 30 000. The session ends after 30 s in the background. There is no inactivity timeout while in the foreground and no max duration for health sessions. A replay session is capped at 60 min. | C-opt, J-opt, R-opt, D-ios-sr, D-and-sr |
| SES-c | partial | partial | partial | A session does not survive a restart: it is cached on disk and closed (crashed/abnormal) on the next launch. iOS "Unreleased" adds opt-in `enableScopePersistence` for user info; Android has `enableScopePersistence` = true (scope cache for crash events). | C-sess, J-opt, C-cl |
| SES-d | partial | partial | partial | `SentrySDK.startSession()` / `endSession()` (iOS), `Sentry.startSession()` / `endSession()` (Android), `Sentry.startSession`/`endSession` from @sentry/core in RN. No public "get session id" for health sessions; the replay id is available (`SentrySDK.replay`, `Sentry.getReplay()`). *Exact RN wiring to native: uncertain.* | C-tree, J-opt, R-tree |

## ERR errors and crashes

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| ERR-a | yes | yes | yes | iOS: `enableCrashHandler` = true (SentryCrash, a KSCrash fork); `enableUncaughtNSExceptionReporting` = false (macOS only). Android: `enableUncaughtExceptionHandler` = true. RN: `reactNativeErrorHandlersIntegration` has `onerror` = true (ErrorUtils global handler). | C-opt, J-opt, R-err |
| ERR-b | n/a | n/a | yes | RN: `onunhandledrejection` = true and `patchGlobalPromise` = true. | R-err, R-opt |
| ERR-c | yes | yes | yes | `capture(error:)`, `capture(exception:)`, `capture(message:)` / `Sentry.captureException` / `Sentry.captureException`. iOS 9.32 adds scope-block and `attachAllThreads` overloads. | C-cl, J-opt, R-tree |
| ERR-d | yes | yes | yes | iOS: Mach exceptions, signals, C++ exceptions (`enableUnhandledCPPExceptionsV2` = false); `enableSigtermReporting` = false (deprecated). Android: NDK via sentry-native, `enableNdk` = true; `enableTombstone` = false (ApplicationExitInfo tombstones). RN: native crashes come from the native SDKs; `enableNativeCrashHandling` option. | C-opt, J-and, R-opt |
| ERR-e | yes | yes | yes | iOS: `enableAppHangTracking` = true, `appHangTimeoutInterval` = 2 s, non-fully-blocking hangs reported by default, off when a debugger is attached. **Deprecated in 9.x, to be removed in v10** in favour of MetricKit `MXHangDiagnostic` (`enableMetricKit` = false). Android: ANR v1 watchdog (<11) + v2 ApplicationExitInfo (11+), `anrEnabled` = true, `anrTimeoutIntervalMillis` = 5000, `anrReportInDebug` = false, `enableAnrFingerprinting` = true, `anrProfilingSampleRate` = null. RN adds `enableJsHangTracking` (iOS only, experimental, default false, 2 s, min 0.25 s, not in `__DEV__`) and `enableNdkAppHangTracking` (default false, 5000 ms). | C-opt, J-and, D-and-anr, R-opt, R-cl |
| ERR-f | yes | yes | yes | iOS: `enableWatchdogTerminationTracking` = true. A heuristic on the next launch infers a foreground OS kill (needs the crash handler); hangs are excluded. MetricKit diagnostics are opt-in (CPU, disk-write, hang, app launch; memory exception on iOS 27). Android: ApplicationExitInfo ANRs, tombstones and MemoryLimiter exits (`memoryLimiterEnabled` = false); `reportHistoricalAnrs` = false. RN inherits both. | C-opt, D-ios-wt, J-and, C-cl |
| ERR-g | yes, max 100 | yes, max 100 | yes, max 100 | `maxBreadcrumbs` = 100. Auto-collected: iOS UIViewController, touches, network, system events (battery, keyboard, orientation), hinge; Android Activity lifecycle, app lifecycle, system events, network events, user interactions, Logcat via the Gradle plugin (min level WARNING); RN touch, console, fetch/XHR, navigation. `beforeBreadcrumb` hook. | C-opt, J-and, J-opt, R-def, D-and-gp |
| ERR-h | yes | yes | yes | `event.fingerprint` / `scope.setFingerprint`. Android also applies a static fingerprint to system-frame-only ANRs. | J-and, D-and-anr |
| ERR-i | yes | yes | yes | `attachScreenshot` = false and `attachViewHierarchy` = false on all three, with `beforeCaptureScreenshot` / `beforeCaptureViewHierarchy` hooks. Screenshot masking options (`screenshot.maskAllText`, `maskAllImages`) exist on iOS, Android (needs the replay module) and RN. `maxAttachmentSize`: iOS 200 MiB, Android 20 MiB. Android can attach an ANR thread dump (off by default). | C-opt, J-and, J-opt, R-opt |
| ERR-j | n/a | partial | yes | Android: Logcat calls become breadcrumbs through the Gradle plugin, and Timber integration. RN: @sentry/core `captureConsoleIntegration` is available but not in the defaults; *on by default: no (not in R-def)*. | D-and-gp, R-def |
| ERR-k | partial | yes | yes | Android: `enableDeduplication` = true. RN: `dedupeIntegration` is in the defaults. iOS: *a dedicated dedupe option was not found in Options.swift; uncertain.* All three honour server rate limits (TRN-f). | J-opt, R-def |
| ERR-x1 | yes | yes | n/a | MetricKit (iOS) and ApplicationExitInfo (Android) are OS-reported diagnostics surfaced as events. iOS 9.31 adds experimental hang flame-graph attachments. | C-opt, C-cl, J-and |

## PERF performance and vitals

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| PERF-a | n/a | n/a | n/a | Web only. | — |
| PERF-b | n/a | n/a | n/a | Web only. | — |
| PERF-c | partial | n/a | yes | RN: `longTaskIntegration` reports JS-thread long tasks as the `react_native.long_task.duration` metric (8.34.0). Stall tracking measures JS event-loop stalls on transactions (50 ms loop, 20 ms margin). iOS: hang tracking (ERR-e). | R-cl, R-stall |
| PERF-d | n/a | n/a | n/a | Web only. | — |
| PERF-e | n/a | n/a | partial | RN: expo-asset and expo-image tracing (`tracing/expoAsset.ts`, `expoImage.ts`). | R-tree |
| PERF-f | yes | yes | yes | iOS: cold/warm, prewarm (`enablePreWarmedAppStartTracing` = true), spans for Pre-Runtime Init, UIKit Init, App Init, Initial Frame Render. Attached to the first `ui.load` transaction only if the gap is ≤5 s; `enableStandaloneAppStartTracing` = false. Android: cold/warm, `enablePerformanceV2` = true, standalone = false. RN: `enableAppStartTracking` = true, max start 60 s, gap to first display 5 s, extended app start deadline 30 s. | C-opt, D-ios-auto, J-and, D-and-auto, R-app |
| PERF-g | yes | yes (API 24+) | yes | iOS: frames tracker on by default. Android: `enableFramesTracking` = true, Android 7.0+. RN: `enableNativeFramesTracking` = true. Thresholds are not stated in the docs read: *uncertain*. | C-tree, J-and, D-and-auto, R-opt |
| PERF-h | yes | yes | yes | TTID is automatic (`ui.load.initial-display`). TTFD: `enableTimeToFullDisplayTracing` = false, then `reportFullyDisplayed()`. Deadline: iOS 30 s, Android 25 s (`DEADLINE_EXCEEDED`). RN: `<TimeToInitialDisplay>` / `<TimeToFullDisplay>` components or `Sentry.reportFullyDisplayed()`; React Navigation `enableTimeToInitialDisplay` = false. | C-opt, D-ios-auto, D-and-auto, R-ttd, R-nav |
| PERF-i | yes, paid | yes, paid | yes | iOS: UI/continuous profiling through `configureProfiling`. Android: `profileSessionSampleRate`, lifecycle `MANUAL` by default, 101 Hz legacy profiler; ANR profiling is billed as UI Profile Hours. RN: Hermes JS profiler and native UI profiling; JS samples in Android 15+ UI profiles (8.34.0). | C-opt, J-opt, D-and-anr, R-def, R-cl |
| PERF-j | partial | partial | partial | Android: `AndroidCpuCollector` and `AndroidMemoryCollector` attach to transactions/profiles. iOS: the profiler records CPU, memory and energy; experimental MetricKit metric reports send CPU, memory, network, hitches and exits as metrics (9.32/9.33). Thermal state: *uncertain*. | J-tree, C-cl |
| PERF-k | yes | yes | yes | `startTransaction` / `startChild`, idle transactions (`idleTimeout` = 3 s), `deadlineTimeout` 30 s on Android. RN uses @sentry/core `startSpan` APIs. | C-opt, J-opt, J-cl |
| PERF-x1 | yes | yes | — | File I/O and DB auto-spans. iOS: NSData = on, NSFileManager = off, Core Data = on. Android: SQLite/Room and File I/O through Gradle plugin bytecode instrumentation. | C-opt, D-and-gp |
| PERF-x2 | — | — | yes | RN: TurboModule call tracking (`enableTurboModuleTracking` = false). | R-opt |

## NET network

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| NET-a | yes | yes | yes | iOS: URLSession swizzling, `enableNetworkTracking` = true, `enableNetworkBreadcrumbs` = true. Android: OkHttp (`SentryOkHttpInterceptor`, auto-added by the Gradle plugin), Apollo, Ktor client. RN: fetch/XHR (incl. `expo/fetch`); native requests are also traced by the native SDKs. | C-opt, J-tree, D-and-gp, R-cl |
| NET-b | yes | yes | yes | `sentry-trace` + `baggage` headers. `tracePropagationTargets` defaults to `.*` (all hosts) on iOS and Android. W3C `traceparent` is opt-in: `enablePropagateTraceparent` / `propagateTraceparent` = false. `strictTraceContinuation` = false. | C-opt, J-opt, R-opt |
| NET-c | partial | partial | partial | Only in Session Replay network details: `networkDetailAllowUrls` = [] (off), bodies on once a URL is allow-listed, default headers Content-Type, Content-Length, Accept. Android body cap 150 KB. RN supports XHR only. Android has a new `DataCollection` (headers, cookies, query, bodies, GraphQL) as a granular replacement for `sendDefaultPii`; iOS has it behind `SDK_V10`. | C-rpl, J-rpl, J-dc, D-rn-sr |
| NET-d | partial | yes | yes | iOS: `enableGraphQLOperationTracking` = false (adds the operation name to breadcrumbs). Android: sentry-apollo / apollo3 / graphql modules. RN: `integrations/graphql.ts`. | C-opt, J-tree, R-tree |
| NET-e | yes | yes | opt-in | iOS: `enableCaptureFailedRequests` = true, `failedRequestStatusCodes` 500–599, targets `.*`. Android OkHttp: `captureFailedRequests` = true, 500–599. RN: `enableCaptureFailedRequests` = **false**; Android needs the Gradle-plugin OkHttp instrumentation. | C-opt, J-okh, R-opt |
| NET-f | no | no | no | No WebSocket instrumentation found in option lists or module trees. | C-opt, J-tree, R-tree |

## INT interactions

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| INT-a | yes | yes | yes | iOS: `enableUserInteractionTracing` = true (UIKit only, not SwiftUI) plus touch breadcrumbs. Android: `enableUserInteractionBreadcrumbs` = true; `enableUserInteractionTracing` = false. RN: `TouchEventBoundary` breadcrumbs; `enableUserInteractionTracing` = false. | C-opt, D-ios-auto, J-opt, R-opt, R-touch |
| INT-b | yes | yes | yes | iOS: selector + `accessibilityIdentifier` (`reportAccessibilityIdentifier` = true). Android: `Activity.viewId` (needs an ID); Compose needs a `sentryTag` modifier or the compiler plugin. RN: `sentry-label`, then `data-sentry-component` (Babel annotation), then `accessibilityLabel` / `aria-label` / `testID`; text up to 64 chars. | C-opt, D-and-auto, R-touch |
| INT-c | no | no | yes | RN: rage-tap detection `enableRageTapDetection` = true, 3 taps within 1000 ms, emits a `ui.multiClick` breadcrumb. None found in iOS/Android sources. | R-touch |
| INT-d | no | no | no | Not found. | — |
| INT-e | no | no | no | Not found as a distinct feature. | — |
| INT-f | partial | yes | partial | Android user-interaction spans cover click, scroll and swipe. Replay records touches on iOS (`SentryTouchTracker`) and gestures on Android (`GestureRecorder`). RN: `tracing/gesturetracing.ts` (react-native-gesture-handler). | D-and-auto, C-tree, J-tree, R-tree |
| INT-g | no | no | no | No form/input autocapture (inputs are masked in replay). | — |
| INT-h | no | no | no | Not found. | — |
| INT-x1 | yes | — | — | iOS: hinge/foldable breadcrumbs (9.32.0). | C-cl |

## NAV navigation

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| NAV-a | n/a | n/a | n/a | Web only. | — |
| NAV-b | n/a | n/a | n/a | Web only (RN covered in NAV-d). | — |
| NAV-c | yes | yes | via native | iOS: `enableUIViewControllerTracing` = true (in-app VCs only; SwiftUI via `SentryTracedView`). Android: Activity `ui.load` (`enableAutoActivityLifecycleTracing` = true), Fragment (sentry-android-fragment), Navigation/Navigation 3 (sentry-android-navigation, multi-Activity support in 8.62), Compose navigation (sentry-compose). | C-opt, D-ios-auto, J-and, J-tree, J-cl |
| NAV-d | n/a | n/a | yes | React Navigation (`reactNavigationIntegration`, `routeChangeTimeoutMs` = 1000), Expo Router (`expoRouterIntegration`, Expo Router 58 support in 8.33), Wix react-native-navigation. | R-nav, R-cl |
| NAV-e | yes | yes | yes | Manual `ui.load` transactions; scope `transaction` name; RN `Sentry.startSpan`. | J-opt, R-tree |
| NAV-f | yes | yes | yes | iOS system-event breadcrumbs; Android `enableAppLifecycleBreadcrumbs` = true; RN `appRegistryIntegration` + native. | C-opt, J-and, R-def |
| NAV-x1 | — | — | yes | RN deep-link breadcrumbs (`integrations/deeplink.ts`). | R-tree |

## RPL replay

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| RPL-a | n/a | n/a | n/a | Web replay uses rrweb (@sentry/browser). RN on web uses `browserReplay.ts`. | R-tree |
| RPL-b | yes, screenshot video | yes, screenshot video | yes (native) | **Screenshots, not wireframes.** iOS: the view hierarchy is drawn to an image (`enableViewRendererV2` = true, `enableFastViewRendering` = false), encoded to **H.264 MP4** with AVAssetWriter. Android: `PixelCopy` (default) or experimental `CANVAS`, encoded to **AVC/H.264 MP4** with MediaCodec. **1 fps.** Quality is `medium` by default: iOS 40 kbps, 100 % scale; Android 75 kbps, JPEG q30, 100 % scale; low uses 80 % scale. Events use the rrweb envelope format (video event + breadcrumbs + touches). | C-rpl, C-odr, J-rpl, J-enc, D-and-sr |
| RPL-c | yes | yes | yes | `sessionSampleRate` = 0 and `onErrorSampleRate` = 0 (off by default). On-error buffer: **30 s** in iOS and Android source (`errorReplayDuration`); the RN docs say "up to one minute" (mismatch with the native code). Android `beforeErrorSampling` hook. Opening the feedback form also buffers up to 30 s. | C-rpl, J-rpl, D-rn-sr, D-ios-fb |
| RPL-d | partial | partial | partial | iOS: WebViews and PDFs masked; `excludedViewClasses`. Android: SurfaceView capture opt-in (`captureSurfaceViews` = false; masking only whole-surface). WebView, VideoView, ExoPlayer and CameraX are masked by default. | D-ios-sr, J-rpl |
| RPL-e | yes | yes | yes | Network breadcrumbs by default; headers/bodies opt-in (NET-c). | C-rpl, J-rpl, D-rn-sr |
| RPL-f | partial | partial | yes | RN replay shows console entries. Native: logs/breadcrumbs. *Native console mapping: uncertain.* | D-rn-sr |
| RPL-g | yes | yes | yes | Default: mask all text, images, user input and webviews (`maskAllText` = true, `maskAllImages` = true; RN also `maskAllVectors` = true). APIs: iOS `maskedViewClasses` / `unmaskedViewClasses`, `view.sentryReplayMask()`, SwiftUI `.sentryReplayMask()` / `.sentryReplayUnmask()`, and a masking preview view. Android `addMaskViewClass`, view tags, Compose `Modifier.sentryReplayMask()` / `sentryReplayUnmask()`. RN `<Sentry.Mask>` / `<Sentry.Unmask>` native components. | C-rpl, C-tree, J-rpl, J-mod, R-rpl, R-tree |
| RPL-h | n/a | n/a | yes | `mobileReplayIntegration()` forwards to native replay (min RN SDK 6.5.0). Expo supported. | R-rpl, D-rn-sr |
| RPL-i | yes | yes | — | SwiftUI masking modifiers (`SentryReplayView.swift`). Compose: `ComposeViewHierarchyNode` + modifiers. | C-tree, J-mod, J-tree |
| RPL-j | yes | yes | yes | Max 60 min per session, 5 s segments, session ends after 30 s in the background. iOS `maximumDuration` 3600 s and Android `sessionDuration` 1 h are not user-settable on iOS (`@_spi(Private)`). Rate-limited replays may be missing. | C-rpl, J-rpl, D-ios-sr |
| RPL-x1 | yes | yes | yes | Manual control: `SentrySDK.replay.pause()/resume()/start()/stop()`, Android `Sentry.replay()` pause/resume (persists across background). RN `avoidForegroundResumeHang` option (default false). | C-tree, D-and-sr, R-rpl |

## USR user and attributes

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| USR-a | yes | yes | yes | `SentrySDK.setUser` / `Sentry.setUser` / `Sentry.setUser`. | C-tree, J-opt, R-tree |
| USR-b | yes | yes | yes | `User` fields (id, email, username, ip, geo, data). | — (SDK API surface; *field list not re-read: uncertain*) |
| USR-c | yes | yes | yes | Tags, contexts and extras on the scope; `initialScope`; Android `tags` option and `contextTags`. | C-opt, J-opt, R-opt |
| USR-d | yes | yes | yes | An installation id is generated and used as the default user id for sessions. Android `distinctId` option. *iOS installation id file name not re-read: partial confirmation.* | J-opt |
| USR-e | no | no | no | No alias/merge API found. | — |

## LOG logs

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| LOG-a | yes | yes | yes | iOS `enableLogs` = false, `SentrySDK.logger`, `beforeSendLog`. Android `logs.enable` = false. RN `enableLogs`, `Sentry.logger.*`, `logsOrigin` = 'all'. Batched; client reports count each log (9.33). | C-opt, J-opt, R-opt, C-cl |
| LOG-b | partial | partial | yes | RN: `enableAutoConsoleLogs` = true when logs are enabled. Android: Timber and Logcat integrations, native logs when `enableLogs` (RN 8.34). iOS: *OSLog capture not found: uncertain*. | R-opt, R-cl, J-tree |
| LOG-c | no | partial | no | Android: sentry-opentelemetry modules (server-side focus). Logs are sent in the Sentry envelope, not OTLP. | J-tree |

## SMP sampling

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| SMP-a | no | no | no | Health sessions are not sampled. Replay sessions use `sessionSampleRate` (RPL-c). | C-rpl, J-rpl |
| SMP-b | yes | yes | yes | `tracesSampleRate` (unset = tracing off) and `tracesSampler`. Profiling has its own rate. | C-opt, J-opt |
| SMP-c | yes | yes | yes | `sampleRate` = 1 (errors). | C-opt, J-opt |
| SMP-d | yes | yes | yes | `onErrorSampleRate` (30 s buffer). | C-rpl, J-rpl |
| SMP-e | yes | yes | yes | Errors are independent of replay and trace sampling. | C-opt |
| SMP-f | no | partial | no | No remote config or kill switch in the SDK. Android `enableExternalConfiguration` reads local files/env only; `enableBackpressureHandling` = true downsamples under load. Server-side dynamic sampling is outside the SDK. | J-opt |

## PRV privacy

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| PRV-a | no | no | no | No consent API. `enabled` = true can be set false at init, and `close()` exists. | C-opt, J-opt |
| PRV-b | yes | yes | yes | Error screenshots and replay mask text and images by default (`screenshot` options). | C-opt, J-and, R-opt |
| PRV-c | yes | yes | yes | See RPL-g. | C-rpl, J-mod, R-rpl |
| PRV-d | partial | partial | partial | Android `DataCollection.urlQueryParams`; iOS `dataCollection` gated `SDK_V10`. Replay network details strip auth headers. | J-dc, C-opt, D-rn-sr |
| PRV-e | yes | yes | yes | `sendDefaultPii` = false on all three (no IP or user identity sent by default). Android `DataCollection` gives granular control; iOS v10 replaces `sendDefaultPii` with `dataCollection`. | C-opt, J-opt, J-dc, R-opt |
| PRV-f | yes | yes | yes | `beforeSend`, `beforeSendTransaction`, `beforeSendSpan` (iOS), `beforeSendLog`, `beforeSendMetric`, `beforeBreadcrumb`, `beforeCaptureScreenshot`. RN: the JS `beforeSend` does not apply to native-created events such as JS hang events. | C-opt, J-opt, R-opt |
| PRV-g | no | no | no | No DNT/opt-out API beyond `enabled` = false or `close()`. | C-opt |

## TRN offline and transport

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| TRN-a | partial | partial | partial | One envelope per event. Logs, metrics and spans are batched (*batch size/flush interval not read: uncertain*). `shutdownTimeInterval` 2 s; Android `flushTimeoutMillis` 15 s. | C-opt, J-opt |
| TRN-b | yes | yes | yes | Disk cache of envelopes. `maxCacheItems` = **30** (oldest rotated out); iOS deletes envelopes older than **90 days**; Android `maxQueueSize` = 30 (in-memory queue, `QUEUE_OVERFLOW` drop). RN JS envelopes go to the native transport; fatal JS errors are persisted on Android (8.33). | C-opt, C-fm, J-opt, R-cl |
| TRN-c | n/a | n/a | n/a | Web only. | — |
| TRN-d | yes | yes | yes | gzip `Content-Encoding` (iOS level -1 default; Android `GZIPOutputStream`). | C-req, J-http |
| TRN-e | yes | yes | yes | DSN points anywhere; iOS custom `urlSession`; Android `proxy`, `sslSocketFactory`, custom transport factory; Spotlight for local dev. No tunnel option documented for mobile. | C-opt, J-opt |
| TRN-f | yes | yes | yes | Honour `X-Sentry-Rate-Limits` / 429 `Retry-After` per category (`SentryEnvelopeRateLimit`, `DefaultRateLimits`). Android `enableBackpressureHandling`. | C-tree, J-opt |
| TRN-g | — | — | — | Sentry envelope format (newline-delimited JSON headers + items), not OTLP. | C-tree, J-http |

## CFG configuration

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| CFG-a | yes | yes | yes | Single options object + DSN (iOS also reads env `SENTRY_DSN`). Android `AndroidManifest.xml` meta-data (`io.sentry.*`) or `SentryAndroid.init`. RN `Sentry.init({...})`, plus optional native init from `sentry.options.json`. | C-opt, D-and-anr, R-cl |
| CFG-b | yes | yes | yes | Per-feature `enable*` flags; RN `integrations` array/function. | C-opt, J-and, R-def |
| CFG-c | yes | yes | yes | `debug` = false, `diagnosticLevel`; `sendClientReports` = true (dropped-data outcomes). RN `enableNativeNagger`. | C-opt, J-opt, R-opt |
| CFG-d | yes | yes | yes | `releaseName` defaults to bundle id@version+build (iOS); `dist`; `environment` = "production". Android 8.63 adds scope-level `Environment`. | C-opt, J-opt, J-cl |
| CFG-e | SPM/CocoaPods/Carthage, prebuilt xcframework | Maven + Gradle plugin auto-install | npm, Expo config plugin | RN `RNSentry.podspec` stages a prebuilt `Sentry` xcframework. No lazy-load of replay on mobile. | R-pkg, D-and-gp |
| CFG-f | n/a | n/a | partial | RN has a web fallback (`*.web.tsx`, `browserReplay.ts`). | R-tree |
| CFG-x1 | yes | yes | yes | Spotlight (local dev UI): `enableSpotlight` = false. | C-opt, J-opt, R-opt |

## API manual instrumentation

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| API-a | partial | partial | partial | No generic custom-event API; `captureMessage` + breadcrumbs + logs fill this role. | C-opt |
| API-b | yes | yes | yes | Metrics: iOS `SentrySDK.metrics.count/gauge/distribution` (aligned in 9.32), `enableMetrics` = true (deprecated flag); Android `metrics.enable` = true; RN via @sentry/core. Span measurements (`setMeasurement`). | C-opt, C-cl, J-opt |
| API-c | yes | yes | yes | See PERF-k. Android `SentryTraced` idle spans (8.63). | J-cl |
| API-d | yes | yes | yes | `span.setData` / scope tags; RN `sentry-span-attributes` prop on touchables. | R-touch |
| API-e | no | partial | partial | Android: `openTelemetryMode` = AUTO, sentry-opentelemetry bridge (JVM-focused). RN: @sentry/core v10 is OTel-based internally. W3C traceparent opt-in. No OTLP export. | J-opt, J-tree, R-opt |

## SYM source maps and symbolication

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| SYM-a | n/a | n/a | yes | See SYM-d. | D-rn-sm |
| SYM-b | yes | n/a | yes | sentry-cli `debug-files upload`, Xcode Run Script build phase, fastlane plugin; source context with `--include-sources`. | D-ios-dsym |
| SYM-c | n/a | yes | yes | Gradle plugin uploads ProGuard/R8 mappings, NDK symbols and source context. | D-and-gp |
| SYM-d | n/a | n/a | yes | Automatic in Xcode/Gradle builds (SDK ≥5.11.0), Hermes and JSC. Metro serializer for debug IDs (`tools/sentryMetroSerializer.ts`); Expo `withSentry` plugin; `@sentry/expo-upload-sourcemaps` and EAS build hooks. | D-rn-sm, R-tree |
| SYM-e | yes | yes | yes | sentry-cli 3.x, wizard (`@sentry/wizard`), Gradle plugin 6.26.0, Expo plugin. | R-pkg, D-and-gp |

## FWK framework integrations

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| FWK-a | n/a | n/a | yes | `ErrorBoundary`, `GlobalErrorBoundary`, `Sentry.wrap`, `reactNativeProfiler`. | R-tree |
| FWK-b | n/a | n/a | n/a | Not mobile. | — |
| FWK-c | n/a | n/a | n/a | Not mobile. | — |
| FWK-d | yes | n/a | — | SwiftUI `SentryTracedView`, replay modifiers, `sentryFeedback(isPresented:)`; UIKit swizzling. | C-tree, D-ios-fb |
| FWK-e | n/a | yes | — | Compose, OkHttp, Apollo, Ktor, SQLite/Room, Timber, Fragment, Navigation, LaunchDarkly, OpenFeature. | J-tree |
| FWK-f | — | — | yes | Expo: config plugin, `expoContext`, `expoConstants`, `expoUpdatesListener`, Expo Router, expo-image/asset. | R-def, R-tree |
| FWK-g | partial | partial | — | Separate SDKs exist (Flutter, Unity, KMP, .NET MAUI); out of scope. | — (*not checked this run*) |

## REL release and versioning

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| REL-a | yes | yes | yes | `release`, `dist`; Android avoids sending the whole release as dist (8.63). | C-opt, J-cl |
| REL-b | yes | yes | yes | Crash-free sessions/users from health sessions (SES-a); Android tracks ANR rate. | C-sess, D-and-anr |
| REL-c | partial | partial | partial | Commit association and deploys are done by sentry-cli/CI, not the SDK. | D-ios-dsym |
| REL-d | yes | yes | yes | Server-side from session `release`. | C-sess |

## FF feature flags

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| FF-a | yes | yes | yes | Flag evaluations buffered on the scope; `maxFeatureFlags` = 100. RN `featureFlags` integration. | C-opt, C-tree, J-opt, R-tree |
| FF-b | no | no | no | No vendor flag service. | — |
| FF-c | no (not found) | yes | partial | Android: sentry-openfeature, sentry-launchdarkly-android. RN: *JS OpenFeature/LaunchDarkly integrations from @sentry/core may apply: uncertain.* | J-tree |

## FB user feedback

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| FB-a | yes | yes | yes | iOS: managed form `SentrySDK.feedback.show()` and SwiftUI `.sentryFeedback(isPresented:)` (9.17+); the floating widget is **deprecated** for v10. Android: `Sentry.feedback().show()`, `SentryUserFeedbackDialog`/`Form`, `SentryUserFeedbackButton` (View + Compose). RN: `Sentry.showFeedbackForm()`, `FeedbackForm`, `FeedbackButton`. Each sends up to 30 s of buffered replay with the feedback. | D-ios-fb, D-and-fb, J-tree, D-rn-fb, R-tree |
| FB-b | yes | yes | yes | `SentrySDK.capture(feedback:)`, `Sentry.feedback().capture(Feedback)`, `Sentry.captureFeedback(...)`, each with `associatedEventId` + attachments. | D-ios-fb, D-and-fb, D-rn-fb |
| FB-c | yes | yes | yes | Shake to report is off by default: iOS `useShakeGesture` + runtime `enableOnShake()` (9.25); Android `feedbackOptions.isUseShakeGesture`; RN `enableShakeToReport` / `Sentry.enableFeedbackOnShake()`. Screenshots: iOS `showFormForScreenshots`; Android screenshot picker; RN `ScreenshotButton`. | D-ios-fb, D-and-fb, D-rn-fb, R-tree |

## OTH other

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| OTH-a | no | no | no | No product analytics. | — |
| OTH-b | no | no | no | — | — |
| OTH-c | no | no | no | — | — |
| OTH-d | yes | no (not found) | yes | Trace propagation into a WKWebView: `SentryWebViewTracing.addTracePropagation(to:)` with `allowedHosts` (9.33). RN `sentryWebViewProps` (8.32). | C-wv, C-cl, R-cl |
| OTH-e | no | no | no | Sentry has uptime monitors, but no SDK-side synthetic link. | — |
| OTH-f | no | partial | partial | Android LaunchDarkly/OpenFeature; RN Supabase integration. | J-tree, R-tree |
| OTH-g | — | yes | — | Android `sentry-android-distribution` module (app build distribution). *Exact scope: uncertain.* | J-tree |
| OTH-x1 | yes | yes | yes | Crons/check-ins exist but are server-oriented. Root/jailbreak check: Android `enableRootCheck` = true. | J-and |

---

## Notable (for a new SDK designer)

1. **Mobile replay is screenshot video, not wireframe.** iOS and Android capture **1 fps** screenshots, mask them on device by drawing boxes from the view hierarchy, and encode **H.264 MP4** in **5 s segments**. Defaults are medium quality (iOS 40 kbps, Android 75 kbps), a 60 min cap, and 30 s for on-error buffer and feedback attachment. The rrweb envelope carries a video event plus breadcrumbs and touches. The capture loop runs on the main thread.
2. **Masking is deny-by-default:** all text, images, inputs, WebViews and video players. RN also masks vectors. Unmask APIs exist per view class, view, SwiftUI or Compose modifier, and RN `<Sentry.Unmask>`. Android offers an experimental Canvas strategy that redraws and always masks.
3. **The RN replay docs say the on-error buffer is "up to one minute",** but native source sets `errorReplayDuration` = 30 s. Treat the docs as stale.
4. **iOS JS-thread-blind hang detection is being deprecated.** App-hang tracking (2 s, on by default) will be removed in v10 in favour of MetricKit (`MXHangDiagnostic`, launch, CPU and disk diagnostics, and now metric reports as metrics). Android keeps a 5 s ANR watchdog on Android 10 and below and ApplicationExitInfo on 11+. RN adds a separate experimental JS-hang watchdog on iOS.
5. **Watchdog/OOM terminations are inferred on the next launch** from the persisted app state (foreground, no crash, no upgrade, no debugger). Android uses OS `ApplicationExitInfo` (ANR, tombstone, MemoryLimiter). These events are created late and get no live scope, so the design must persist enough context.
6. **Defaults differ across the RN bridge.** For example, `enableCaptureFailedRequests` is false in RN but true on native iOS, and Android user-interaction tracing is off while iOS is on. RN also pins an older sentry-android (8.62.0) than the latest release (8.63.0). A unified SDK should define one default table.
7. **The offline cache is small and simple:** 30 envelopes FIFO on disk (both platforms), a 90-day purge on iOS, and gzip on the wire. Server rate limits are honoured per category, and client reports count dropped items.
8. **Sentry is moving from `sendDefaultPii` to granular `dataCollection`** (headers, cookies, query params, bodies, GraphQL, user info). Android ships it now and iOS gates it to v10. This is a good model for privacy config.
9. **Trace propagation sends `sentry-trace` + `baggage` to all hosts by default (`.*`).** W3C `traceparent` is opt-in. An OTel-native SDK would invert this: W3C by default with an allowlist.
10. **Sentry ships features beyond core RUM:** RN rage taps (3 taps in 1 s), TurboModule tracing, WebView trace stitching on iOS and RN, shake-to-report feedback with an attached replay buffer, feature-flag buffers (100 entries), and TTFD (manual `reportFullyDisplayed`, with a 30 s deadline on iOS and 25 s on Android).
