# Datadog mobile SDK features: research

- **Vendor:** Datadog
- **Platforms:** iOS (dd-sdk-ios), Android (dd-sdk-android), React Native (dd-sdk-reactnative, including Expo via `expo-datadog`)
- **SDK versions checked (latest release on 2026-11-10):**
  - iOS **3.21.0** (tag date 2026-10-29)
  - Android **3.16.0** (2026-10-29)
  - React Native **3.11.0** (2026-10-20). It bundles iOS 3.16.1 and Android 3.15.0, per `NATIVE_SDK_VERSIONS.md`.
- **Research date:** 2026-11-10
- **Method:** I shallow-cloned each repo at its tag and read defaults from the source. Docs fill the gaps. The docs pages show no last-updated date, so docs sources are dated "acc. 2026-11-10".

**Abbreviations used in the Sources column**
- `iOS@` = https://github.com/DataDog/dd-sdk-ios/blob/3.21.0/ (2026-10-29)
- `AND@` = https://github.com/DataDog/dd-sdk-android/blob/3.16.0/ (2026-10-29)
- `RN@` = https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/ (2026-10-20)
- `D/` = https://docs.datadoghq.com/ (acc. 2026-11-10)
- `iRC` = `iOS@DatadogRUM/Sources/RUMConfiguration.swift`
- `aRF` = `AND@features/dd-sdk-android-rum/src/main/kotlin/com/datadog/android/rum/internal/RumFeature.kt` (`DEFAULT_RUM_CONFIG`)
- `rRC` = `RN@packages/core/src/config/features/RumConfiguration.ts` (`DEFAULTS`)
- `rCC` = `RN@packages/core/src/config/features/CoreConfiguration.ts` (`DEFAULTS`)
- `iSR` = `iOS@DatadogSessionReplay/Sources/SessionReplayConfiguration.swift`
- `aSR` = `AND@features/dd-sdk-android-session-replay/src/main/kotlin/com/datadog/android/sessionreplay/SessionReplayConfiguration.kt`
- `rSR` = `RN@packages/react-native-session-replay/src/SessionReplay.ts`

## SES sessions

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| SES-a | yes | yes | yes (native) | Automatic once RUM is enabled. A session starts on the first event. The first view is `ApplicationLaunch`. | iOS@DatadogRUM/Sources/RUMMonitor/Scopes/RUMSessionScope.swift; D/real_user_monitoring/application_monitoring/ios/application_launch_monitoring/ |
| SES-b | yes | yes | yes (native) | 15 min inactivity, 4 h max, hard-coded (not configurable). Background: events are dropped unless `trackBackgroundEvents` is set (default false), in which case they go to a "Background" view. iOS 3.20 fixed clock-change expiry by using a monotonic clock. | iOS@…/RUMSessionScope.swift L13-15; AND@…/rum/internal/domain/scope/RumSessionScope.kt L338-339; iRC; aRF; iOS CHANGELOG 3.20.0 |
| SES-c | uncertain | uncertain | uncertain | No session-resume-across-process logic found. The iOS session clock is per-process monotonic, and each launch emits a new `ApplicationLaunch` view. Anonymous user id persists (USR-d). | iOS@…/RUMSessionScope.swift |
| SES-d | partial | partial | partial | `stopSession()` (next event starts a new session), `currentSessionID(completion:)` / `getCurrentSessionId()`, `onSessionStart` listener (iOS) / `RumSessionListener` (Android). No explicit start-session API. | iRC L329; D/…/ios/advanced_configuration/; RN@packages/core/src/rum/DdRum.ts L440,461 |

## ERR errors and crashes

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| ERR-a | yes (needs CrashReporting) | yes | yes | iOS: uncaught NSException via `DatadogCrashReporting` (KSCrash since 3.x). Android: JVM uncaught handler, `setCrashReportsEnabled` default true. RN: JS `ErrorUtils.setGlobalHandler`, `trackErrors` default **false**. | iOS CHANGELOG ("Replace PLCrashReporter by KSCrash"); AND@dd-sdk-android-core/…/core/configuration/Configuration.kt L77; RN@packages/core/src/rum/instrumentation/DdRumErrorTracking.tsx L50-55; rRC |
| ERR-b | n/a | n/a | no | No unhandled-promise-rejection hook found in RN core source (grep "rejection" returns nothing). | RN@packages/core/src (grep, 3.11.0) |
| ERR-c | yes | yes | yes | `addError(message:/error:)`, `addError(message, source, throwable)`, `DdRum.addError(msg, source, stack, ctx, ts, fingerprint)`. Error-level logs and errored spans also become RUM errors. | D/…/ios/advanced_configuration/; RN@…/DdRum.ts L326 |
| ERR-d | yes | yes | yes (opt-in) | iOS: KSCrash signals and Mach exceptions, uploaded on next launch. Android: JVM by default, plus NDK via the `dd-sdk-android-ndk` module. RN: `nativeCrashReportEnabled` default false. | D/real_user_monitoring/error_tracking/mobile/ios/; AND@features/dd-sdk-android-ndk; rRC |
| ERR-e | yes (opt-in) | yes | yes (via native) | iOS: `appHangThreshold`, default `nil` (off), min 0.1 s. Docs suggest 0.25 s as a start, 2–3 s to cut noise. Hangs are watched from a background thread with 2.5% tolerance. Fatal hangs show as crashes. Android: 5 s watchdog (`ANR_THRESHOLD_MS=5000`). Non-fatal ANR tracking defaults on only for API <30. Fatal ANRs come from `ApplicationExitInfo.REASON_ANR` on API 30+. RN passes `appHangThreshold` and `trackNonFatalAnrs` through. | iRC L226-239; D/…/error_tracking/mobile/ios/; AND@…/rum/internal/anr/ANRDetectorRunnable.kt L154; aRF L1115-1119 |
| ERR-f | partial | partial | partial | iOS: watchdog terminations, `trackWatchdogTerminations` default false. Heuristic on next launch: excludes upgrade, exit/abort, crash, force-quit and reboot. No stack trace. Memory warnings become RUM errors (`trackMemoryWarnings` default true). Android: only fatal ANR exit reasons from ApplicationExitInfo. No OOM or low-memory exit reporting found in main source. RN: same options passed to native. | iRC L215,351; D/…/error_tracking/mobile/ios/; aRF L637 |
| ERR-g | partial | partial | partial | No breadcrumb buffer. Errors sit inside the session event timeline (views, actions, resources) and are linked to the active view and action. Feature-flag evaluations are attached to errors. | D/real_user_monitoring/ (concept); iOS CHANGELOG ("Propagate feature flags to … crashes") |
| ERR-h | yes | yes | yes | Custom fingerprint attribute `_dd.error.fingerprint`. RN `addError` has a `fingerprint` argument. | AND@…/rum/RumAttributes.kt L209-211; iOS@DatadogRUM/Sources/RUMMonitor/Scopes/RUMViewScope.swift; RN@…/DdRum.ts |
| ERR-i | partial | partial | partial | No screenshot or view-hierarchy attachments. Crash reports carry all-thread stacks (iOS binary images via KSCrash; Android `getAllStackTraces` in the exception handler and ANR detector). | iOS@DatadogInternal/Sources/Models/CrashReporting/DDCrashReport.swift; AND@dd-sdk-android-core/…/error/internal/DatadogExceptionHandler.kt |
| ERR-j | n/a | n/a | yes | RN wraps `console.error`, which becomes a RUM error when `trackErrors` is true. Native: Logger error and critical logs become RUM errors (`bundleWithRumEnabled`). | DdRumErrorTracking.tsx L52-55; D/…/ios/advanced_configuration/ |
| ERR-k | uncertain | uncertain | uncertain | No client-side error dedup or rate limiting found. Android has generic back-pressure (queue threshold 1024, IGNORE_NEWEST). | AND@dd-sdk-android-core/…/configuration/Configuration.kt L332-339 |
| ERR-x1 | yes | yes | yes | "Error taps" (an error following a tap) are the only mobile frustration signal. | iRC L193-198; AND@…/rum/RumConfiguration.kt L278-286 |

## PERF performance and vitals

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| PERF-a | n/a | n/a | n/a | Web only | — |
| PERF-b | n/a | n/a | n/a | Web only | — |
| PERF-c | yes | yes | yes | Main-thread long tasks. iOS `longTaskThreshold` default 0.1 s. Android `MainLooperLongTaskStrategy(100 ms)` on by default. RN: JS `longTaskThresholdMs` default 0 (off); `nativeLongTaskThresholdMs` default 200 (clamped 100–5000). | iRC L224,689; aRF L987,1000; rRC |
| PERF-d | n/a | n/a | n/a | Web only. The mobile analogue is per-view loading time: `addViewLoadingTime` (RN, native). | RN@…/DdRum.ts L418 |
| PERF-e | n/a | n/a | n/a | Web only | — |
| PERF-f | yes | yes | yes (3.11) | Since 3.5.0 an `app_launch` vital replaces the old `application_start` action. iOS cold/warm is heuristic (cold = new version, reboot, or >7 days since last process); prewarm is flagged `@vital.is_prewarmed`. Android tags `@vital.startup_type` cold/warm. | D/real_user_monitoring/application_monitoring/ios/application_launch_monitoring/; D/…/android/application_launch_monitoring/ |
| PERF-g | yes | yes | yes | Slow frames on by default (iOS `trackSlowFrames=true`; Android `SlowFramesConfiguration` 16.67 ms slow, 700 ms frozen, 5 s freeze, max 1000 records/view). Refresh rate is normalized to 0–60 fps. RN adds the JS refresh rate. | iRC L359,703; AND@…/rum/configuration/SlowFramesConfiguration.kt L57-61; D/real_user_monitoring/application_monitoring/mobile_vitals/ |
| PERF-h | yes | yes | yes (3.11.0) | TTID is automatic: process start (or SDK load if prewarmed) to first frame, at most once per process. TTFD is manual via `reportAppFullyDisplayed()`. iOS also has Time-to-Network-Settled (resources starting ≤100 ms after view start) and Interaction-to-Next-View. | D/…/ios/application_launch_monitoring/; iRC L248-271; RN release 3.11.0 (#1336) |
| PERF-i | yes | yes (API 35+) | no (not found) | iOS `DatadogProfiling` for app launch and continuous (3.14), correlated to hangs, long tasks and TTID. Android profiling module (stable 3.16) needs API 35 `ProfilingManager`, with app-launch, ANR and long-task triggers. | iOS CHANGELOG 3.14.0/3.18.0; AND CHANGELOG 3.16.0; AND@features/dd-sdk-android-profiling (`@RequiresApi(VANILLA_ICE_CREAM)`) |
| PERF-j | partial | partial | partial | CPU ticks/s and memory per view; `vitalsUpdateFrequency` default `.average` = 500 ms. Timeseries mode samples CPU and memory every 1 s; it is experimental (iOS SPI) or off by default (Android). Battery and display attributes on Android RUM. No thermal vital found. | iRC L246,380,476; aRF; AND CHANGELOG ("Add battery and display attributes") |
| PERF-k | yes | yes | yes | `addTiming`; Feature Operations (`startFeatureOperation`/`succeed`/`fail`); custom spans via Trace (see API-c). | RN@…/DdRum.ts L160-366; iOS CHANGELOG ("Feature Operations") |

## NET network

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| NET-a | yes (opt-in) | yes (opt-in) | yes (opt-in) | iOS: `urlSessionTracking` default nil. It swizzles URLSession; since 3.x no delegate registration is needed. `disallowList` supports `*` wildcards. Android: OkHttp `DatadogInterceptor` and `DatadogEventListener`, plus Cronet. RN: `trackResources` (XHR) default false; global fetch tracking since 3.6. `nativeIosResourceTracking` since 3.10. | iRC L186-191,445; AND@integrations/dd-sdk-android-okhttp; rRC; RN releases 3.6.0, 3.10.0 |
| NET-b | yes | yes | yes | First-party hosts (wildcards since 2026). Default headers are Datadog plus W3C `tracecontext`; B3 and B3-multi are also available. Trace sample rate defaults to 100% (iOS docs say 20%; source says 100). `TraceContextInjection.sampled`. Sampling is deterministic from the session id. | iOS@DatadogRUM/Sources/RUMConfiguration.swift L540-568; AND@dd-sdk-android-core/…/Configuration.kt L137-139; AND@dd-sdk-android-core/…/trace/TracingHeaderType.kt; rRC (`resourceTraceSampleRate:100`) |
| NET-c | partial | partial | uncertain | Headers: iOS `trackResourceHeaders` default `.disabled` (`.defaults`/`.custom`); Authorization and Cookie are never captured; 2 KB per-header cap. Android captures OkHttp headers (3.8). No automatic bodies: the iOS `resourceAttributesProvider` gets the body (≤512 KB, media excluded) and Android 3.16 exposes payloads to `HttpRequestInfo`. | iRC L421-434; iOS CHANGELOG 3.21.0; AND CHANGELOG 3.8.0, 3.16.0 |
| NET-d | yes | yes | yes | GraphQL operation data and GraphQL errors on resources. Android: Apollo integration. RN: `react-native-apollo-client` package. | iOS CHANGELOG ("Support errors for GraphQL requests"); AND@integrations/dd-sdk-android-apollo; RN@packages/react-native-apollo-client |
| NET-e | partial | partial | partial | Transport failures become RUM errors with source=network. Whether HTTP 4xx/5xx create error events (not only a resource status) is uncertain: iOS has an unused `asClientError()` for 4xx. | iOS@DatadogRUM/Sources/Instrumentation/Resources/URLSessionRUMResourcesHandler.swift L432 |
| NET-f | no (not found) | no (not found) | no (not found) | No WebSocket instrumentation found. Android also ships Cronet and SQLDelight integrations. | AND@integrations/ |

## INT interactions

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| INT-a | yes (opt-in) | yes (default on) | yes (opt-in) | iOS: `uiKitActionsPredicate`/`swiftUIActionsPredicate` default nil (off). Android: `userActionTracking=true` by default. RN: `trackInteractions` default false; Babel plugin recommended. | iRC L120-180; aRF; rRC |
| INT-b | yes | yes | yes | iOS: accessibility label or view class. Android: resource id name plus `touchTargetExtraAttributesProviders`; Compose `trackClick(name)`. RN: `accessibilityLabel` (`useAccessibilityLabel=true`) or `actionNameAttribute` (e.g. `dd-action-name`). | rRC; D/…/react_native/advanced_configuration/ |
| INT-c | no | no | no | Mobile frustrations cover only error taps (ERR-x1). | iRC L195 |
| INT-d | no | no | no | Same as INT-c | — |
| INT-e | yes | yes | yes | Error taps, `trackFrustrations` default true | iRC L198; aRF |
| INT-f | yes | yes | uncertain | iOS: out-of-the-box scroll and swipe actions (3.x), opt-out flag `trackScrollAndSwipeActions`. Android: scroll and swipe gestures. RN: not confirmed. | iOS CHANGELOG 3.11.1 ("trackScrollAndSwipeActions") |
| INT-g | no | no | no | No form or input-change autocapture | — |
| INT-h | yes (new) | yes (flag) | yes (opt-in) | Mobile heatmaps: iOS 3.x "Add Mobile Heatmaps support". Android behind a flag (`heatmapsEnabled=false`). RN `enableHeatmaps:false` (Android support in RN 3.6). Note: a docs page still labels Heatmaps "Browser only". | iOS CHANGELOG; aSR L87; rSR L141; D/real_user_monitoring/session_replay/mobile/ |

## NAV navigation

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| NAV-a | n/a | n/a | n/a | Web only | — |
| NAV-b | n/a | n/a | n/a | Web only. For RN see NAV-d. | — |
| NAV-c | yes (opt-in) | yes (default Activity) | via native (opt-in) | iOS: `uiKitViewsPredicate` default nil; `DefaultUIKitRUMViewsPredicate` names views by class; SwiftUI uses `swiftUIViewsPredicate` or the `.trackRUMView(name:)` modifier. Android default `ActivityViewTrackingStrategy(false)`; Fragment, Mixed and Navigation strategies; Compose `NavigationViewTrackingEffect`; Navigation 3 support. RN `nativeViewTracking` default false. | iRC L104-160; aRF L998; rRC; AND CHANGELOG ("Navigation 3") |
| NAV-d | n/a | n/a | yes | `@datadog/mobile-react-navigation` (`DdRumReactNavigationTracking.startTrackingViews`), `@datadog/mobile-react-native-navigation` (Wix). Expo Router: no package; docs say to track in `app/_layout` with `usePathname`. | RN@packages/react-navigation, packages/react-native-navigation; D/real_user_monitoring/application_monitoring/react_native/setup/expo/ |
| NAV-e | yes | yes | yes | `startView`/`stopView` with key, name and attributes | D/…/ios/advanced_configuration/; RN@…/DdRum.ts L89-109 |
| NAV-f | partial | partial | partial | No explicit lifecycle events. Launch is shown as the `ApplicationLaunch` view and background as the "Background" view (opt-in). App state is attached to errors. | iRC L200-207 |

## RPL replay

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| RPL-a | n/a | n/a | n/a | Web only. For WebViews inside apps, the Browser SDK records them (RPL-x2). | — |
| RPL-b | yes (paid add-on) | yes | yes | **Wireframe capture, not screenshots.** The screen is split into rectangles (text, image, shape), giving a full snapshot plus incremental wireframe diffs. iOS walks the UIKit view tree (per-class NodeRecorders) and snapshots only on screen change, at most every 100 ms. An experimental `compositionTreeRecording` flag records the CALayer tree instead. Android uses per-View mappers with a 64 ms debounce, a 50 ms/s capture budget and dynamic optimization on by default. Images are separate, deduplicated resources: iOS PNG ≤1000×1000 (WebP in the composition-tree path), Android WebP. | D/real_user_monitoring/session_replay/mobile/; iOS@DatadogSessionReplay/Sources/Feature/RecordingComponents.swift L89; iSR L117-123; AND@…/sessionreplay/internal/recorder/Debouncer.kt L110-111 |
| RPL-c | partial | partial | partial | `replaySampleRate` default 100, applied on top of the RUM session rate (deterministic). Whole-session only. Manual `startRecordingImmediately:false` with `startRecording()`/`stopRecording()`. **No on-error buffer mode.** | iSR L77-81; aSR L78; rSR L134-143; D/session_replay/mobile/setup_and_configuration/ |
| RPL-d | n/a | n/a | n/a | Web only. Mobile: WebViews are recorded via the Browser SDK bridge. Safari VC, activity VC and (without the flag) SwiftUI roots are shown as "unsupported" placeholders. | iOS@…/NodeRecorders/UnsupportedViewRecorder.swift |
| RPL-e | yes | yes | yes | Replays are linked to the RUM session timeline (resources). Bodies are not captured. | D/real_user_monitoring/session_replay/mobile/ |
| RPL-f | partial | partial | partial | Logs and errors appear via the session timeline. Uncertain whether they are shown inside the player. | — |
| RPL-g | yes | yes | yes | `textAndInputPrivacyLevel` default **maskAll** (`maskSensitiveInputs`, `maskAllInputs`). `imagePrivacyLevel` default **maskAll** (iOS `maskNonBundledOnly` (SwiftUI guesses >100×100 pt), Android `MASK_LARGE_ONLY` (>100×100 dp), `maskNone`). `touchPrivacyLevel` default **hide**. Per-view overrides: UIKit `dd.sessionReplayOverrides`, SwiftUI `SessionReplayPrivacyView`, Android `View.setSessionReplay*`/Compose `Modifier.sessionReplay*`, RN `SessionReplayView.Privacy/MaskAll/MaskNone/Hide`. | iSR L31-44; aSR L77-80; rSR L136-139; D/real_user_monitoring/session_replay/mobile/privacy_options/ |
| RPL-h | n/a | n/a | yes | `@datadog/mobile-react-native-session-replay`. Native SDKs record the RN native view tree. Composition-tree recording is opt-in (`enableCompositionTreeRecording:false`). WebView replay is not supported on Android New Architecture. | rSR; RN release 3.7.0; D/session_replay/mobile/setup_and_configuration/ |
| RPL-i | partial (experimental) | yes (extension) | n/a | SwiftUI needs `featureFlags: [.swiftui: true]` (default false); otherwise hosting roots become placeholders. Compose needs `dd-sdk-android-session-replay-compose` plus `addExtensionSupport(ComposeExtensionSupport())`. Material extension available. | iSR L108,129-132; UnsupportedViewRecorder.swift L28-33; D/session_replay/mobile/setup_and_configuration/ |
| RPL-j | partial | partial | partial | Bounded by the RUM session (4 h). Batch item and batch max 10 MB. Unsent SR batches expire after 12 h (image resources after 48 h on iOS). iOS SR upload is faster (initial 2 s, 0.6–6 s). Retention is 30 days (15-month extended option). | iOS@DatadogSessionReplay/Sources/Feature/SessionReplayFeature.swift L54-63; …/Feature/ResourcesFeature.swift L34-37; AND@…/sessionreplay/internal/SessionReplayFeature.kt L499-510 |
| RPL-x1 | yes | yes | yes | Replay is recorded only inside RUM-sampled sessions (the rate is relative). Not available for smart TVs or wearables. | D/real_user_monitoring/session_replay/mobile/ |
| RPL-x2 | yes | yes | yes (not Android New Arch) | WebView replay: the Browser SDK records inside the WebView and the native SDK uploads it. | D/session_replay/mobile/setup_and_configuration/ |

## USR user and attributes

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| USR-a | yes | yes | yes | `setUserInfo(id:name:email:extraInfo)`; `usr.id` required; `clearUserInfo` | D/…/ios/advanced_configuration/; RN@packages/core/src/DdSdkReactNative.tsx L272-296 |
| USR-b | yes | yes | yes | `addUserExtraInfo`; also `setAccountInfo`/`addAccountExtraInfo` (account = B2B tenant) | DdSdkReactNative.tsx L307-355 |
| USR-c | yes | yes | yes | Global `addAttribute(s)`/`removeAttribute(s)`. iOS 3.19 limit is 1900 attributes per event (context, usr, account separately). | iOS CHANGELOG 3.19.0; DdSdkReactNative.tsx L213-256 |
| USR-d | yes | yes | yes (native) | `trackAnonymousUser` default true: a random anonymous id persisted across launches, attached to sessions | iRC L336-343; aRF |
| USR-e | no | no | no | No alias or merge API. Linking is by setting a user id on later sessions. | — |

## LOG logs

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| LOG-a | yes | yes | yes | Separate Logs module (`Logger`/`DdLogs`) with levels and attributes; `bundleWithRum` default true | rCC; `RN@packages/core/src/config/features/LogsConfiguration.ts` |
| LOG-b | no | partial | no | No console or print capture. Android has a Timber integration (`dd-sdk-android-timber`). RN `console.error` goes to RUM errors, not logs. | AND@integrations/dd-sdk-android-timber |
| LOG-c | no | no | no | Logs use the Datadog intake format; no OTel Logs API | — |

## SMP sampling

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| SMP-a | yes | yes | yes | `sessionSampleRate` default 100. Knuth deterministic from the session UUID (iOS 3.x). | iRC L685; aRF L984; rRC; iOS CHANGELOG ("Knuth deterministic sampling") |
| SMP-b | yes | yes | yes | First-party trace sample rate default 100 (relative to the session); `replaySampleRate` separate; `telemetrySampleRate` 20 | iRC L554; rRC |
| SMP-c | no | no | no | No error-specific sample rate. Use event mappers to drop. | — |
| SMP-d | no | no | no | No buffer-on-error replay mode on mobile | iSR; aSR |
| SMP-e | no | no | no | Unsampled sessions send nothing. Server-side "RUM without Limits" retention filters are a separate backend feature. | D/real_user_monitoring/rum_without_limits/ (search result) |
| SMP-f | yes (new, 3.17) | yes (new, 3.14) | no (not in config) | Remote configuration: `Datadog.Configuration.remoteConfiguration = RemoteConfiguration(id:)` / `setRemoteConfigurationId()`. The document is fetched from the Datadog CDN and cached. It overrides sample rates, tracking flags and hang/long-task thresholds. iOS merges once at `RUM.enable`; Android refreshes on foreground. iOS `requireRemoteConfiguration` is not implemented. | iOS@DatadogRUM/Sources/RUMConfiguration+RemoteConfiguration.swift; iOS@DatadogCore/Sources/DatadogConfiguration.swift L140-159; AND CHANGELOG 3.14.0 |

## PRV privacy

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| PRV-a | yes | yes | yes | `granted` / `notGranted` / `pending`. **Required init argument on iOS and Android (no default); RN default `GRANTED`.** While pending, data is written to an intermediate directory; it is uploaded on granted and deleted on notGranted. `set(trackingConsent:)` changes it at runtime. | iOS@DatadogInternal/Sources/Context/TrackingConsent.swift; AND@dd-sdk-android-core/…/Datadog.kt L59-63; rCC |
| PRV-b | n/a | n/a | n/a | No text masking outside replay. Action names come from accessibility labels. | — |
| PRV-c | yes | yes | yes | Replay-only per-view overrides (see RPL-g) | D/…/session_replay/mobile/privacy_options/ |
| PRV-d | partial | partial | partial | No built-in URL scrubbing. Use `resourceEventMapper` / `viewEventMapper` to rewrite. `disallowList` (iOS) skips URLs. | iRC L283-319 |
| PRV-e | partial | partial | partial | IP and geolocation collection are toggled **server-side** per RUM app (the SDK still sends and the backend drops). The SDK collects device model, OS, carrier (Android API 24+; iOS returns nil on 16+), and locale. | D/real_user_monitoring/mobile_and_tv_monitoring/setup/reactnative (search); iOS CHANGELOG 3.17.0 |
| PRV-f | yes | yes | yes | Event mappers for view, resource, action, error, long task and vital. Returning nil drops the event; views can't be dropped. RN: error, action, resource and log mappers. | D/…/ios/advanced_configuration/; RN@…/DdRum.ts L508-530 |
| PRV-g | partial | partial | partial | No OS do-not-track signal exists. `clearAllData()` and `stopInstance()` are available. | D/…/ios/advanced_configuration/ |

## TRN offline and transport

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| TRN-a | yes | yes | yes (native) | `batchSize` default `.medium` (file write window: small 3 s, medium 10 s, large 35 s). `uploadFrequency` default `.average`: iOS base 2 s with initial 10 s and range 2–20 s, ±10% adaptive. Android base step 2000 ms. `batchProcessingLevel` medium: 20 batches per upload cycle (iOS 5/20/100; Android 1/20/100). Uploads are blocked when battery is ≤10% and not charging, or in low-power mode. | iOS@DatadogCore/Sources/PerformancePreset.swift L79-142; iOS@DatadogCore/Sources/Core/Upload/DataUploadConditions.swift L20; AND@dd-sdk-android-core/…/configuration/BatchSize.kt, UploadFrequency.kt, BatchProcessingLevel.kt; AND@…/data/upload/DataUploadTask.kt L118-156 |
| TRN-b | yes | yes | yes (native) | Disk-first. Each event ≤1 MB, ≤1000 events per batch, ≤5 MB per batch file, ≤512 MB per feature directory (oldest purged). Batches older than 18 h are dropped. Optional at-rest `encryption`. Retry on 408, 429, 500, 502, 503, 504 and 507 and on network errors. No retry on 400, 401, 403 or 413. | iOS PerformancePreset.swift L130-136; iOS@DatadogCore/Sources/Core/Upload/DataUploadStatus.swift L39-55; AND@dd-sdk-android-core/…/persistence/file/FilePersistenceConfig.kt L22-28 |
| TRN-c | n/a | n/a | n/a | Web only. Mobile data persists to disk. iOS `backgroundTasksEnabled` (default false) adds about 30 s of background upload. | iOS DatadogConfiguration.swift L225 |
| TRN-d | yes | yes | yes (native) | iOS `Content-Encoding: deflate`; Android gzip interceptor | iOS@DatadogInternal/Sources/Upload/URLRequestBuilder.swift L174; AND@…/data/upload/GzipRequestInterceptor.kt |
| TRN-e | yes | yes | yes | Per-feature `customEndpoint` (RUM, Logs, Trace, SR) plus `proxyConfiguration`. Several Datadog sites (US1, US3, US5, EU1, AP1, AP2, UK1, US1_FED). | iRC L334; iSR L54; rCC |
| TRN-f | partial | partial | partial | 429 and 5xx are retried with adaptive delay (delay grows on failure). No `Retry-After` parsing found. | DataUploadStatus.swift |
| TRN-g | Datadog | Datadog | Datadog | Datadog JSON event schema (rum-events-format) to the Datadog intake, not OTLP. Since 3.19 (iOS) and 3.15 (Android), partial view updates (deltas) are the default. | iOS CHANGELOG 3.19.0; AND CHANGELOG 3.15.0 |

## CFG configuration

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| CFG-a | yes | yes | yes | Core config (`clientToken`, `env`, `site`) plus per-feature `enable(with:)` (RUM `applicationID`, Logs, Trace, SR, Crash, WebView, Flags). RN: `DatadogProvider` / `DatadogProviderConfiguration`. | D/…/ios/advanced_configuration/; rCC |
| CFG-b | yes | yes | yes | Modular packages (SPM/Pods products, Gradle artifacts, npm packages); each instrumentation is toggled in config | — |
| CFG-c | yes | yes | yes | `Datadog.verbosityLevel` / `setVerbosity`; SDK telemetry to Datadog (sample 20%); Android RUM Debug Widget; iOS `DD_DEBUG_RUM` launch arg; batch-deleted metrics | iRC L366,522-523; AND CHANGELOG ("RUM Debug Widget") |
| CFG-d | yes | yes | yes | `env`, `service` (default bundle id), `version` override (iOS 3.x), Android `variant`, RN `versionSuffix` | iOS@DatadogCore/Sources/DatadogConfiguration.swift; rCC |
| CFG-e | n/a | n/a | n/a | Native: SPM, CocoaPods, Carthage, XCFramework / Maven. RN: npm and the `expo-datadog` config plugin. Async init (`InitializationMode.ASYNC`) buffers up to 100 events. | D/…/react_native/advanced_configuration/ |
| CFG-f | n/a | n/a | n/a | Web only. Mobile: app-extension preset (iOS); multiple named SDK instances. | iOS PerformancePreset.swift (iOSAppExtension) |

## API manual instrumentation

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| API-a | yes | yes | yes | `addAction(type:name:attributes)` (custom), `startAction`/`stopAction` | RN@…/DdRum.ts L120-216 |
| API-b | yes | yes | yes | `addTiming(name)` on the view; Feature Operations (start/succeed/fail, a duration vital) | DdRum.ts L160-192,366 |
| API-c | yes | yes | yes | DatadogTrace (OpenTracing-style plus OTel API); RN `DdTrace.startSpan/finishSpan`. Experimental client-side APM stats (iOS 3.21, Android 3.14). | iOS CHANGELOG 3.21.0 |
| API-d | yes | yes | yes | `addViewAttribute(s)`/`removeViewAttribute(s)`, view loading time, action attributes | DdRum.ts L374-418 |
| API-e | partial | partial | no | iOS DatadogTrace implements the OTel Swift API (opentelemetry-swift-core 2.5). Android `dd-sdk-android-trace-otel` and `okhttp-otel`. W3C tracecontext and `baggage` propagation. **Export is Datadog intake, not OTLP.** | iOS CHANGELOG 3.13.0; AND@features/dd-sdk-android-trace-otel; AND CHANGELOG ("baggage header") |

## SYM source maps and symbolication

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| SYM-a | n/a | n/a | n/a | Web only. For RN see SYM-d. | — |
| SYM-b | yes | n/a | yes | `datadog-ci dsyms upload` (macOS only), Fastlane plugin, GitHub Action. 2 GB per dSYM. Simulator crashes are not symbolicated. Matched by UUID. | D/real_user_monitoring/error_tracking/mobile/ios/ |
| SYM-c | n/a | yes | yes | `dd-sdk-android-gradle-plugin` uploads R8/ProGuard mappings and NDK symbols | AND CHANGELOG ("Datadog Gradle Plugin 1.31.0") |
| SYM-d | n/a | n/a | yes | `datadog-ci react-native upload` (Hermes supported); `datadog-sourcemaps.gradle`; Xcode build phase | RN@packages/core/datadog-sourcemaps.gradle |
| SYM-e | yes | yes | yes | datadog-ci CLI, Fastlane, Gradle plugin, `expo-datadog` (uploads dSYM, sourcemaps and mapping on EAS build) | D/…/react_native/setup/expo/ |

## FWK framework integrations

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| FWK-a | n/a | n/a | partial | `DatadogProvider` component; no dedicated error boundary found in core | RN@packages/core/src |
| FWK-b | n/a | n/a | n/a | — | — |
| FWK-c | n/a | n/a | n/a | — | — |
| FWK-d | yes | n/a | n/a | UIKit predicates; SwiftUI view and action predicates and modifiers; alerts, dialogs and action sheets are auto-instrumented; macOS AppKit (3.21); tvOS, watchOS, visionOS | iRC L79-180; iOS CHANGELOG 3.11.0, 3.21.0 |
| FWK-e | n/a | yes | n/a | Compose (view, action, SR), OkHttp, Cronet, Apollo, Coil/Coil3/Glide/Fresco, RxJava, Coroutines, SQLDelight, Timber, Android TV | AND@integrations/ |
| FWK-f | n/a | n/a | yes | RN 0.65+; New Architecture/TurboModules; RN 0.87 support (3.6); Expo and Expo Go claimed by docs; CodePush package | RN@packages/codepush; D/…/react_native/setup/expo/ |
| FWK-g | yes | yes | n/a | Vendor ships Flutter, Unity, KMP, .NET MAUI, Roku and Unreal sources | iOS CHANGELOG 3.21.0 ("unreal"); 3.11.0 ("maui") |

## REL release and versioning

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| REL-a | yes | yes | yes | App version (`CFBundleShortVersionString`, overridable) and build number on spans (iOS 3.20) | iOS CHANGELOG 3.20.0 |
| REL-b | yes | yes | yes | Crash-free sessions by version (backend) | D/real_user_monitoring/application_monitoring/mobile_vitals/ |
| REL-c | uncertain | uncertain | uncertain | Source-code integration via git metadata (Android `BuildConfig` git hash, CHANGELOG 3.15). No suspect-commits feature confirmed. | AND CHANGELOG 3.15.0 |
| REL-d | uncertain | uncertain | uncertain | Not confirmed from a primary source | — |

## FF feature flags

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| FF-a | yes | yes | yes | `addFeatureFlagEvaluation(name,value)` attaches to the view and to errors, including crashes, fatal hangs and watchdog terminations | RN@…/DdRum.ts L446; iOS CHANGELOG |
| FF-b | yes | yes | yes | `DatadogFlags` module: precomputed assignments, cache, exposures, evaluation logging, obfuscated keys | iOS@DatadogFlags; AND@features/dd-sdk-android-flags; RN@packages/core/src/flags |
| FF-c | yes (separate repo) | yes | yes | OpenFeature providers: `dd-openfeature-provider-swift`, `dd-sdk-android-flags-openfeature`, `react-native-openfeature` | github.com/DataDog/dd-openfeature-provider-swift (updated 2026-10-28); AND@features/dd-sdk-android-flags-openfeature; RN@packages/react-native-openfeature |

## FB user feedback

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| FB-a | no | no | no | No feedback UI found in SDK sources | grep "feedback" in sources (tags above) |
| FB-b | no | no | no | Same as FB-a | — |
| FB-c | no | no | no | Same as FB-a | — |

## OTH other

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| OTH-a | partial | partial | partial | RUM data feeds Datadog Product Analytics (backend); no separate SDK | D/real_user_monitoring/session_replay/mobile/ (links) |
| OTH-b | partial | partial | partial | Flags module allocations (FF-b); no experiment UI in SDK | — |
| OTH-c | no | no | no | — | — |
| OTH-d | yes | yes | yes | WebView tracking: the Browser SDK inside the WebView forwards events over a native bridge; host allowlist with wildcards (2026); shared session and anon id | iOS@DatadogWebViewTracking; AND@features/dd-sdk-android-webview; RN@packages/react-native-webview |
| OTH-e | yes | yes | uncertain | Synthetics mobile tests are tagged in RUM (`_dd.synthetics.test_id` env read) | iRC L525-527 |
| OTH-f | no | no | no | No Segment-style integrations found | — |
| OTH-g | yes | yes | partial | Accessibility settings capture (`collectAccessibility` default false); account info; macOS; `isLowRam`/total RAM device fields; CPU and memory timeseries | iRC L373; iOS CHANGELOG 3.11.0 |
| OTH-h | n/a | n/a | n/a | Web concern; added after the research | — |

## Notable

1. **Replay uses wireframes, not screenshots.** Datadog rebuilds each screen as typed rectangles (text, image, shape) from the native view tree and sends a full snapshot plus diffs. Images go up as separate, deduplicated resources (iOS PNG ≤1000 px; Android WebP). This saves bandwidth, but it needs one mapper per view class. SwiftUI is still **experimental and off by default** (`.swiftui: false`), so SwiftUI screens show placeholders by default. Compose needs an extra module. In 2026 iOS added an experimental CALayer "composition tree" recorder to raise fidelity for SwiftUI and RN.
2. **Replay masks everything by default:** text and inputs `maskAll`, images `maskAll`, touches `hide`. Overrides use one model on every platform: four keys (`textAndInput`, `image`, `touch`, `hide`), applied per view and inherited by children. This is a clean model to copy.
3. **Hangs and ANRs differ by platform.** iOS app hangs are **off by default** (threshold `nil`, min 0.1 s; docs suggest 0.25 s, or 2–3 s to cut noise). They are watched from a background thread with 2.5% tolerance, and a hang is fatal if the app never recovers. Android uses a fixed 5 s watchdog. Non-fatal ANRs are on only below API 30. Fatal ANRs come from `ApplicationExitInfo` on API 30+.
4. **Watchdog-termination detection is a next-launch heuristic** (iOS, opt-in). It rules out upgrade, exit/abort, crash, force-quit and reboot, and has no stack trace. Android reports no OOM or low-memory exits (only ANR exit reasons).
5. **App start:** a single `app_launch` vital from process start to first frame (TTID), with manual TTFD. Cold/warm on iOS is a heuristic, and prewarm is flagged. iOS also computes Time-to-Network-Settled (resources starting within 100 ms of view start) and Interaction-to-Next-View, both with pluggable predicates.
6. **The transport is disk-first and battery-aware.** Limits: 1 MB per event, 1000 events or 5 MB per batch, 512 MB per feature, 18 h max age. Upload delays adapt between about 2 s and 20 s. Uploads skip when battery is ≤10% (not charging) or in low-power mode. Client errors are not retried; 429 and 5xx are. Upload is deflate (iOS) or gzip (Android).
7. **Consent defaults differ.** Native requires an explicit `trackingConsent` at init, while RN defaults to `GRANTED`. `pending` buffers to a separate directory and then uploads or deletes the data. An SDK designer should make the default explicit and documented.
8. **Many features are opt-in on iOS and RN but on by default on Android** (view tracking, taps, resources, crashes in RN). Sessions are fixed at 15 min inactivity and 4 h max and are not configurable. Sampling is deterministic from the session UUID, so traces and replay stay aligned with the session.
9. **Remote configuration landed in 2026** (iOS 3.17, Android 3.14). A CDN-fetched, cached JSON overrides sample rates, tracking toggles and thresholds. It is applied at enable time on iOS and refreshed on foreground on Android. This works as a kill switch without an app release.
10. **There is no OTLP anywhere.** The OTel API is accepted for traces (iOS, Android), and W3C tracecontext and baggage are propagated. All export uses Datadog's own JSON schema, with partial view-update deltas on by default since 2026. Mobile frustration signals cover only error taps; there are no rage or dead taps. There is no buffer-on-error replay, no feedback widget, and no promise-rejection capture in RN.
