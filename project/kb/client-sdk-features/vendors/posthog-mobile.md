# PostHog mobile SDKs: feature research

- **Vendor:** PostHog
- **Platforms:** iOS (`posthog-ios`), Android (`posthog-android`), React Native (`posthog-react-native`, which lives in the **posthog-js monorepo** at `packages/react-native`. Native features such as replay and native crashes come from `@posthog/react-native-plugin` in `packages/react-native-plugin`, which replaced the separate `posthog-react-native-session-replay` package.)
- **SDK versions checked:**
  - iOS **3.94.3** (tag 3.94.3, 2026-11-10)
  - Android **3.76.1** (tag android-v3.76.1, 2026-11-06; core `com.posthog:posthog` 6.48.0; Gradle plugin androidPlugin-v1.8.0, 2026-11-09)
  - RN **posthog-react-native 4.85.4** (2026-11-09) with **@posthog/react-native-plugin 2.13.0**. The plugin pins posthog-ios 3.92.7 and posthog-android 3.74.2.
- **Date:** 2026-11-10. I cloned each default branch on 2026-11-10 and confirmed the version strings: `PostHogVersion.swift` = 3.94.3, `gradle.properties` androidVersion = 3.76.1, RN `package.json` = 4.85.4.
- **Source path shorthand:**
  - `ios:` = github.com/PostHog/posthog-ios/blob/3.94.3/
  - `and:` = github.com/PostHog/posthog-android/blob/android-v3.76.1/
  - `rn:` = github.com/PostHog/posthog-js/blob/posthog-react-native@4.85.4/packages/
- **Docs:** posthog.com pages show no last-updated date, so docs are cited as "accessed 2026-11-10".
- **Data model:** PostHog is a product-analytics vendor. Everything is a `$event` sent to `/batch`. Replay goes to `/s/`. Logs are the exception: they go as OTLP-JSON to `/i/v1/logs`.

## SES sessions

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| SES-a | yes | yes | yes | Automatic `$session_id` (UUIDv7). The session rotates on activity and app open. | ios:PostHog/PostHogSessionManager.swift; and:posthog/src/main/java/com/posthog/internal/PostHogSessionManager.kt; rn:core/src/posthog-core.ts (tags above) |
| SES-b | yes | yes | yes | Native: rotate after 30 min of inactivity (cleared when backgrounded); hard cap 24 h; neither configurable. RN: `sessionExpirationTimeSeconds` default 1800; max 24 h in core. | ios PostHogSessionManager.swift L68-96; and PostHogSessionManager.kt L121-122; rn core/src/types.ts, posthog-core.ts L69 |
| SES-c | partial | partial | partial | Native: I found no session-id persistence in the session manager, so a cold start likely means a new session (**uncertain**). RN: `enablePersistSessionIdAcrossRestart` default false. Identity and queue do persist (see TRN-b). | same files; rn react-native/src/posthog-rn.ts |
| SES-d | yes | yes | yes | iOS `startSession()`/`endSession()`/`getSessionId()`. Android `startSession`/`endSession`/`isSessionActive`/`getSessionId`. RN `getSessionId()`/`resetSessionId()`. | ios PostHogSDK.swift L463-479; and PostHogInterface.kt L283-331; rn posthog-rn.ts L2053-2085 |

## ERR errors and crashes

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| ERR-a | yes (opt-in) | yes (opt-in) | yes (opt-in) | iOS `errorTrackingConfig.autoCapture` default false; covers uncaught NSException and signals. Android same flag, default false; installs `Thread.UncaughtExceptionHandler`. RN `errorTracking.autocapture.uncaughtExceptions` default false; fatal JS errors are handed to the native SDK so they survive the crash. All three can also be enabled remotely. | ios ErrorTracking/PostHogErrorTrackingConfig.swift; and posthog/.../errortracking/PostHogErrorTrackingConfig.kt; rn react-native/src/error-tracking/index.ts L46-60, L390-401; posthog.com/docs/error-tracking/installation/ios (accessed 2026-11-10) |
| ERR-b | n/a | n/a | yes (opt-in) | `autocapture.unhandledRejections`, default false. | rn error-tracking/index.ts |
| ERR-c | yes | yes | yes | `captureException(...)` on all three. Android also has `ignoredExceptionTypes` (Class), iOS has `ignoredExceptionTypes` (type string). | ios PostHogSDK.swift L3182+; and PostHogInterface.kt L94; rn core |
| ERR-d | yes (opt-in) | yes (opt-in) | yes (opt-in) | **iOS:** PLCrashReporter fork (`PHPLCrashReporter`) catches Mach exceptions, POSIX signals and NSException. Reports are sent as a fatal `$exception` on the **next launch**. Disabled when a debugger is attached. Swift crashes show as SIGTRAP with no message. **Android:** JVM handler, plus NDK via `captureNativeCrashes` (default false, since 3.60.0). NDK capture works by reading `ApplicationExitInfo` `REASON_CRASH_NATIVE` tombstones on the next start, Android 12+ only. **RN:** `autocapture.nativeCrashes` and `androidNdkCrashes`, both default false; need the native plugin (≥2.12.0 for NDK). | ios ErrorTracking/PostHogCrashReportProcessor.swift; and posthog-android/.../errortracking/PostHogNativeCrashIntegration.kt L268-272; and posthog-android/CHANGELOG.md 3.60.0; rn error-tracking/index.ts L52-75 |
| ERR-e | no | no | no | I found no hang or ANR detection in source. The Android exit-info reader filters only native crashes. | grep of all three repos for hang/ANR/watchdog, 2026-11-10 |
| ERR-f | partial (iOS 27+) | no | no | iOS `PostHogMemoryExceptionReporter` turns MetricKit `MemoryExceptionDiagnostic` (iOS 27+, Swift 6.4 compiler) into an `$exception` on a later launch. No watchdog support. Android reads exit reasons only for native crashes. | ios ErrorTracking/PostHogMemoryExceptionReporter.swift |
| ERR-g | yes (manual) | yes (manual) | yes (manual) | "Exception steps": `addExceptionStep(msg, props)`. Steps sit in a FIFO buffer bounded by bytes, `maxBytes` default 32768, `enabled` default true. They are attached as `$exception_steps` and persisted with crash context on iOS. Nothing is auto-collected. | ios PostHogErrorTrackingConfig.swift (PostHogExceptionStepsConfig); and errortracking/PostHogExceptionStepsConfig.kt; rn error-tracking/index.ts L77-90 |
| ERR-h | partial | partial | partial | No client fingerprint API found. The client controls in-app frames (`inAppIncludes`/`inAppExcludes`/`inAppByDefault` on iOS) and ignored types. Grouping happens server-side. | ios PostHogErrorTrackingConfig.swift; and PostHogErrorTrackingConfig.kt |
| ERR-i | partial | partial | no | Debug images (`$debug_images`) are sent for symbolication. No screenshot or view-hierarchy attachments. | ios ErrorTracking/Utils/PostHogDebugImageProvider.swift; and CHANGELOG 3.60.0 |
| ERR-j | no | no | yes (opt-in) | RN `autocapture.console: LogLevel[]` (default none) captures console calls as exceptions. | rn error-tracking/index.ts L49, L395 |
| ERR-k | partial | partial | partial | No dedup found. RN applies server-sent suppression rules (`$exception_types`/`$exception_values`). Logs have a rate cap; exceptions do not. | rn error-tracking/index.ts L108-135 |

## PERF performance and vitals

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| PERF-a | n/a | n/a | n/a | Web only. | — |
| PERF-b | n/a | n/a | n/a | Web only. | — |
| PERF-c | n/a | n/a | n/a | Web only. | — |
| PERF-d | n/a | n/a | n/a | Web only. | — |
| PERF-e | n/a | n/a | n/a | Web only. Mobile network timing is in NET-a. | — |
| PERF-f | no | no | no | Lifecycle events (`Application Opened`) only. No measured start time found. | ios PostHogConfig.swift L140-147; and PostHogAndroidConfig.kt |
| PERF-g | no | no | no | Not found. | grep 2026-11-10 |
| PERF-h | no | no | no | Not found. | — |
| PERF-i | no | no | no | Not found. | — |
| PERF-j | no | no | no | Only static device properties (model, OS). No CPU, memory or battery vitals. | rn react-native/src/types.ts L130-158 |
| PERF-k | no | no | no | No span or timing API. PostHog has no client tracing. | — |

## NET network

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| NET-a | partial | partial | partial (iOS only) | **For replay only.** iOS swizzles URLSession via `sessionReplayConfig.captureNetworkTelemetry` (default true). Android needs `PostHogOkHttpInterceptor` added manually to each OkHttpClient. RN: iOS only. Captured fields: URL, method, status, duration, decoded body size. Remotely switchable. | ios Replay/Plugins/Network/URLSessionSwizzler.swift, Replay/NetworkSample.swift; and posthog/.../PostHogOkHttpInterceptor.kt; posthog.com/docs/session-replay/installation/react-native (accessed 2026-11-10) |
| NET-b | partial | partial | partial | iOS `tracingHeaders: [hostnames]`, Android `tracingHeaders`, RN `addTracingHeaders`. Injects `X-POSTHOG-DISTINCT-ID` and `X-POSTHOG-SESSION-ID`. Exact host match, default nil/off. **Not W3C traceparent.** iOS needs swizzling; Android needs the interceptor. | ios PostHogConfig.swift L440-450, Tracing/PostHogTracingHeadersIntegration.swift; and PostHogOkHttpInterceptor.kt L110-135; rn core/src/types.ts |
| NET-c | no | no | no | Docs: "does not record request or response body"; headers are not captured either. | posthog.com/docs/session-replay/installation/ios (accessed 2026-11-10) |
| NET-d | no | no | no | Not found. | — |
| NET-e | no | no | no | Not found. | — |
| NET-f | no | no | no | Not found. | — |

## INT interactions

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| INT-a | yes (opt-in) | yes (opt-in) | yes (opt-in) | iOS `captureElementInteractions` (UIKit) and `captureSwiftUIElementInteractions`, both default false, need swizzling. Android `captureElementInteractions` default false, covers View and Compose taps. RN `<PostHogProvider autocapture={{captureTouches}}>` default false. | ios PostHogConfig.swift L234-262; and PostHogAndroidConfig.kt L79-86; rn react-native/src/PostHogProvider.tsx L38-39, L174 |
| INT-b | yes | partial | yes | iOS reads control text, accessibility identifier and `postHogLabel`; `captureAutocaptureElementText` default true. Android sends type and resource ID / test tag only, **never text**. RN uses `ph-label` prop, `propsToCapture` default ['style','testID','accessibilityLabel','ph-label','children'], `maxElementsCaptured` 20. | ios PostHogConfig.swift L255-260, Autocapture/UIView+PostHogLabel.swift; and PostHogAndroidConfig.kt L79-83; rn types.ts L54-86 |
| INT-c | yes | yes (opt-in) | yes | iOS `rageClickConfig.enabled` default true, 30 pt Manhattan distance. Android `captureRageClicks` default false. RN `rageClickConfig` default enabled, 3 taps, 30 pt, 1.0 s. Event: `$rageclick`. | ios Autocapture/PostHogRageClickConfig.swift; and PostHogAndroidConfig.kt L91; rn types.ts L20-43 |
| INT-d | no | yes (opt-in) | no | Android `captureDeadClicks` default false. Uses local View/Compose change detection; text is not sent. | and PostHogAndroidConfig.kt L94-98 |
| INT-e | no | no | no | Not found. | — |
| INT-f | no | no | no | Touches are recorded in replay only (`captureTouches`). | ios Replay/PostHogSessionReplayConfig.swift L36-39 |
| INT-g | partial | partial | no | iOS autocapture includes control value changes (e.g. picker). Android: input values never sent. | ios Autocapture/ForwardingPickerViewDelegate.swift; and PostHogAndroidConfig.kt |
| INT-h | uncertain | uncertain | uncertain | Mobile autocapture sends coordinates (Android "window-local touch coordinates in dp"). I could not confirm a mobile heatmap UI. | and PostHogAndroidConfig.kt L79-83 |

## NAV navigation

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| NAV-a | n/a | n/a | n/a | — | — |
| NAV-b | n/a | n/a | n/a | — | — |
| NAV-c | yes | partial | n/a | iOS `captureScreenViews` default true (swizzles `viewDidAppear`). A split view counts as one screen. SwiftUI uses the `.postHogScreenView(name)` modifier. Android `captureScreenViews` default true, **Activity only**; Fragments and Compose need manual `screen()`. The last screen name is stamped as `$screen_name` on later events. | ios PostHogConfig.swift L149-164, SwiftUI/PostHogSwiftUIViewModifiers.swift L21; and PostHogAndroidConfig.kt L26-30 |
| NAV-d | n/a | n/a | partial | `autocapture.captureScreens` default true, for @react-navigation/native (inside NavigationContainer) and react-native-navigation (`initReactNativeNavigation`). **Expo Router needs manual `screen()`.** | rn react-native/src/types.ts L88-127, src/hooks/useNavigationTracker.ts |
| NAV-e | yes | yes | yes | `screen(name, properties)`. | ios PostHogSDK.swift L1710; and PostHogInterface.kt L221; rn posthog-rn.ts L2009 |
| NAV-f | yes | yes | yes | Lifecycle events Installed / Updated / Opened / Backgrounded. iOS `captureApplicationLifecycleEvents` default true; Android same; RN `captureAppLifecycleEvents` default true. Deep links: Android `captureDeepLinks` default true; iOS uses `captureDeepLink(...)` API or a SwiftUI listener. | ios PostHogConfig.swift L140-147, PostHogSDK.swift L515+; and PostHogAndroidConfig.kt L18-25 |

## RPL replay

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| RPL-a | n/a | n/a | n/a | Web uses rrweb. Mobile emits rrweb-format wireframes (`RRWireframe`). | ios Replay/RRWireframe.swift |
| RPL-b | yes | yes | yes | Off by default (`sessionReplay = false`; RN `enableSessionReplay` false). **Wireframe** is the default on native: the view tree is rendered as HTML. **Screenshot** mode: iOS `screenshotMode`, Android `screenshot`, both default false. **RN always uses screenshot mode** (the plugin forces it on both platforms). Android screenshots are WebP quality 30 at 1 px per dp. iOS screenshots are 1 px per point. | ios Replay/PostHogSessionReplayConfig.swift L47-75; and posthog-android/.../replay/PostHogSessionReplayConfig.kt L43-127; rn react-native-plugin/ios/PosthogReactNativePlugin.swift L409, android/.../PosthogReactNativePluginModule.kt L205; posthog.com/docs/session-replay/mobile (accessed 2026-11-10) |
| RPL-c | partial | partial | partial | Whole session only. `sampleRate` (native) default nil, meaning the remote value or 100%. Sampling is deterministic per session id. Remote triggers (linked flag, event triggers, minimum duration) combine with AND. Before the minimum duration is met, data waits in a disk buffer queue. **No on-error buffer mode.** | ios Replay/PostHogSessionReplayConfig.swift L123-135, PostHogRemoteConfig.swift L351-409, Replay/PostHogReplayBufferQueue.swift; and replay/PostHogReplayBufferQueue.kt |
| RPL-d | partial | partial | partial | WebViews and custom views need screenshot mode (iOS docs). | posthog.com/docs/session-replay/installation/ios (accessed 2026-11-10) |
| RPL-e | yes | yes | partial (iOS only) | Timing, status and size only. No bodies. See NET-a. | as NET-a |
| RPL-f | yes (opt-in) | yes | partial (Android only) | iOS `captureLogs` default false (stdout, stderr, OSLog, NSLog; formatter hook). Android `captureLogcat` default true. RN `captureLog` default true but Android-only. Remotely switchable. | ios PostHogSessionReplayConfig.swift L104-121; and replay config L30; rn types.ts L196-198 |
| RPL-g | yes | yes | yes | `maskAllTextInputs` true and `maskAllImages` true by default; iOS also `maskAllSandboxedViews` true. Passwords are always masked. Per-view: `ph-no-capture` / `ph-no-mask` tokens (iOS accessibilityIdentifier, Android tag/label). SwiftUI `.postHogMask()` / `.postHogNoMask()`; Compose `Modifier.postHogMask()` / `postHogUnmask()`; RN `<PostHogMaskView>`. | ios Replay/UIView+Util.swift L77-85, SwiftUI/PostHogMaskViewModifier.swift; and replay/PostHogMaskModifier.kt, PostHogReplayIntegration.kt L3892-3893; rn react-native/src/PostHogMaskView.tsx |
| RPL-h | n/a | n/a | yes | Needs `@posthog/react-native-plugin` (≥2.0.1). Wraps the native SDKs; screenshot only. **Expo Go not supported.** No RN-web replay. Android API 26+, iOS 13+. | posthog.com/docs/session-replay/installation/react-native (accessed 2026-11-10) |
| RPL-i | partial | partial | n/a | Docs: "SwiftUI is only supported if the `screenshotMode` option is enabled"; "Jetpack Compose is only supported if `screenshot` is enabled". The Android source walks Compose semantics nodes for masking. | posthog.com/docs/session-replay/installation/ios and /android (accessed 2026-11-10); and PostHogReplayIntegration.kt L1609-1659 |
| RPL-j | partial | partial | partial | Snapshots: `throttleDelay` 1 s on iOS and RN; Android `throttleDelayMs` and `debouncerDelayMs` 1000 (debouncer was 500 ms before 3.8.2). Replay ends with the session (24 h max). I found no segment-size limit in config. | ios PostHogSessionReplayConfig.swift L86-102; and replay config L45-59; rn types.ts L200-228 |

## USR user and attributes

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| USR-a | yes | yes | yes | `identify(distinctId, userProperties, userPropertiesSetOnce)`. | ios PostHogSDK.swift L1007-1030; rn posthog-rn.ts L2451 |
| USR-b | yes | yes | yes | `setPersonProperties`; `personProfiles` default `identifiedOnly`; `setDefaultPersonProperties` default true. | ios PostHogConfig.swift L363-381; and PostHogConfig.kt L110, L217 |
| USR-c | yes | yes | yes | `register(props)` / `unregister(key)` (super properties). `group(type, key, props)`. | ios PostHogSDK.swift L960-984, L2048 |
| USR-d | yes | yes | yes | Anonymous id (UUIDv7), `getAnonymousId` transform hook, `reuseAnonymousId` default false, `getDeviceId()`. iOS `appGroupIdentifier` shares storage with app extensions. | ios PostHogConfig.swift L313-348, L424; and PostHogConfig.kt L186-210 |
| USR-e | yes | yes | yes | `identify` merges anon into known; `alias(alias)`; `reset()`. | ios PostHogSDK.swift L884, L1861 |

## LOG logs

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| LOG-a | yes | yes | yes | `captureLog(body, level, attributes)`. Config `config.logs`: `flushAt` 20, `maxBatchSize` 50, `maxBufferSize` 1000 (RN 100), flush every 30 s (RN 10 s), rate cap 500 logs per 10 s, `beforeSend` chain. | ios Logs/PostHogLogsConfig.swift L22-27; and posthog/.../logs/PostHogLogsConfig.kt L129-193; rn react-native/src/logs-defaults.ts |
| LOG-b | partial | partial | partial | Console capture goes to **replay** only (RPL-f), not to logs. RN console capture is the error variant (ERR-j). | — |
| LOG-c | yes | yes | yes | Logs are sent as **OTLP-JSON** `LogsService` requests to `/i/v1/logs?token=`. Resource attrs `service.name` (default bundle id on iOS), `service.version`, `deployment.environment`, custom `resourceAttributes`. **This is the only OTLP signal.** | ios Logs/PostHogLogsOTLP.swift, PostHogApi.swift L227-235 |

## SMP sampling

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| SMP-a | partial | partial | partial | Replay `sampleRate` only (0–1, deterministic). **No event or session sampling for analytics.** | ios PostHogSessionReplayConfig.swift L123-135 |
| SMP-b | n/a | n/a | n/a | No tracing. | — |
| SMP-c | no | no | no | Not found. RN has server suppression rules only. | — |
| SMP-d | no | no | no | No buffer-on-error mode. | — |
| SMP-e | yes | yes | yes | Errors are ordinary events, sent no matter what replay sampling decides. | — |
| SMP-f | yes | yes | yes | Remote config is always loaded (the iOS `remoteConfig` flag is a no-op). It drives replay on/off, sample rate, linked flag, triggers, network/log capture, error autocapture and surveys. RN: `disableRemoteConfig` default false. | ios PostHogConfig.swift L126-138, PostHogRemoteConfig.swift; rn core/src/types.ts |

## PRV privacy

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| PRV-a | partial | partial | partial | Binary only: `optOut` default false plus `optIn()`/`optOut()`/`isOptOut()`; the state is persisted (`persistOptOut` default true). RN `defaultOptIn` default true. No "pending" state, and capture calls are dropped while opted out. RN 4.85.3: flags read before opt-in send `$feature_flag_called` on opt-in. | ios PostHogConfig.swift L270-300, PostHogSDK.swift L2784-2887; and PostHogConfig.kt L64, L369; rn core/src/types.ts, CHANGELOG 4.85.3 |
| PRV-b | partial | yes | partial | Android autocapture never sends text or input values. iOS sends control text unless `captureAutocaptureElementText = false`. | ios PostHogConfig.swift L255-260; and PostHogAndroidConfig.kt L79-83 |
| PRV-c | yes | yes | yes | `ph-no-capture` excludes from replay and autocapture; Android `posthog_autocapture_no_capture` id and Compose `postHogAutocaptureNoCapture()`; RN `noCaptureProp` default `ph-no-capture`. | and PostHogAutocaptureModifier.kt L15; rn types.ts L66-68 |
| PRV-d | n/a | n/a | n/a | — | — |
| PRV-e | partial | partial | partial | `disableGeoIp` (iOS) / `disableGeoip` (RN), default false: IP-based geo is on by default. Default device/app person properties are on. | ios PostHogConfig.swift L381-388; rn core/src/types.ts |
| PRV-f | yes | yes | yes | Event `beforeSend` chain (iOS `setBeforeSend([...])`, Android `beforeSendList`); returning nil drops the event. Older `propertiesSanitizer` still available. Separate logs `beforeSend`. | ios PostHogConfig.swift L16, L680-688; and PostHogConfig.kt L181, L544 |
| PRV-g | yes | yes | yes | Opt-out as in PRV-a. No OS-level DNT on mobile. | — |

## TRN offline and transport

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| TRN-a | yes | yes | yes | Native: `flushAt` 20 (iOS watchOS/tvOS 5), `maxBatchSize` 50, `flushIntervalSeconds` 30. RN: `flushAt` 20, `flushInterval` 10000 ms, `maxBatchSize` 100. All: `flush()`, plus a flush on background. | ios PostHogConfig.swift L27-36; and PostHogConfig.kt L621-630; rn core/src/types.ts |
| TRN-b | yes | yes | yes | Disk queue: iOS Application Support (file per event, UUIDv7 names); Android `cacheDir/posthog-disk-queue` (separate replay and logs queues). `maxQueueSize` 1000 (iOS watch/tv 100), FIFO drop. `maxRetries` 3. iOS `dataMode` sets wifi/cellular/any. RN `persistence: 'file'` (expo-file-system or AsyncStorage) or `'memory'`; `fetchRetryCount` 3, `fetchRetryDelay` 3000 ms. | ios PostHogStorage.swift L20-26, PostHogFileBackedQueue.swift; and PostHogAndroid.kt L192-197; rn posthog-rn.ts, core/src/types.ts |
| TRN-c | n/a | n/a | n/a | Mobile equivalent: flush on background. RN logs: background flush budget 25 s, termination budget 2 s. | rn logs-defaults.ts |
| TRN-d | yes | yes | yes | gzip by default (`compression = .gzip` / `GZIP`; RN `disableCompression` false). | ios PostHogConfig.swift L518; and PostHogConfig.kt L434 |
| TRN-e | yes | yes | yes | `host` (default `https://us.i.posthog.com`; EU host available), `requestHeaders`, iOS `urlSessionConfiguration`, Android `httpClient` / `proxy`, `snapshotEndpoint` default `/s/`. | ios PostHogConfig.swift L430-435, L505-510; and PostHogConfig.kt L242, L409-421, L632-639 |
| TRN-f | yes | yes | yes | Retries on 408, 429, 500, 502, 503, 504 and 3xx with linear backoff; honours `Retry-After` (logs clamped to 5 min). Logs batch size shrinks under backpressure. | ios QueueEndpoint+Factories.swift L8-18, PostHogQueue.swift L158-165; and internal/PostHogQueue.kt L203-215 |
| TRN-g | vendor | vendor | vendor | PostHog JSON events to `/batch`; replay as rrweb-style snapshots to `/s/`; **logs are OTLP-JSON** to `/i/v1/logs`. | ios PostHogApi.swift L10-235 |

## CFG configuration

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| CFG-a | yes | yes | yes | Config object: `PostHogConfig(projectToken:host:)` then `PostHogSDK.shared.setup(config)`; `PostHogAndroidConfig(projectToken)` then `PostHogAndroid.setup(ctx, config)`; `new PostHog(token, options)` or `<PostHogProvider apiKey options>`. Token starts `phc_`; `apiKey` deprecated. Multiple instances supported. | ios PostHogConfig.swift L53-65; and PostHogAndroidConfig.kt L11-17 |
| CFG-b | yes | yes | yes | Per-feature flags (replay, autocapture, screen views, lifecycle, error autocapture, surveys, push). iOS `enableSwizzling` default true: turning it off disables autocapture, screen views and replay. | ios PostHogConfig.swift L166-174 |
| CFG-c | partial | partial | partial | `debug` default false; Android has a pluggable `logger`. No client reports of dropped data. | ios PostHogConfig.swift L269; and PostHogConfig.kt L57, L471 |
| CFG-d | partial | yes | partial | App version and build are auto-collected as properties. Android `releaseIdentifier` (default `applicationId@versionName+versionCode`) for mapping lookup. Logs `deployment.environment`. No general env option. | and PostHogConfig.kt L285-302; ios Logs/PostHogLogsConfig.swift L47-61 |
| CFG-e | n/a | n/a | partial | Distribution: SPM/CocoaPods, Maven, npm. RN native plugin is an optional peer dependency. | rn react-native/package.json |
| CFG-f | n/a | n/a | n/a | — | — |

## API manual instrumentation

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| API-a | yes | yes | yes | `capture(event, properties, userProperties, groups)`. | ios PostHogSDK.swift L1317-1419 |
| API-b | no | no | no | No metrics or timing API. | — |
| API-c | no | no | no | No spans. | — |
| API-d | partial | partial | partial | `register` super properties; `$screen_name` stamped automatically. | — |
| API-e | partial | partial | partial | Only logs are OTLP. No OTel API bridge, no traceparent (NET-b uses custom headers). | ios Logs/PostHogLogsOTLP.swift |

## SYM source maps and symbolication

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| SYM-a | n/a | n/a | n/a | — | — |
| SYM-b | yes | n/a | yes | dSYM upload with `posthog-cli` (docs link). System frames are not symbolicated. | posthog.com/docs/error-tracking/installation/ios (accessed 2026-11-10) |
| SYM-c | n/a | yes | yes | ProGuard/R8 via Gradle plugin `com.posthog.android` (androidPlugin-v1.8.0, wraps `posthog-cli`, `skipOnConflict`/`force`). NDK `.so` via `posthog-cli symbol-sets upload`. | and posthog-android-gradle-plugin/CHANGELOG.md 1.6.0-1.8.0; posthog-android/CHANGELOG.md 3.60.0 |
| SYM-d | n/a | n/a | yes | Metro serializer injects debug IDs; `posthog-xcode.sh` build phase; Hermes composed maps. | rn react-native/src/tooling/posthogMetroSerializer.ts, metroconfig.ts; CHANGELOG 4.85.2 |
| SYM-e | partial | yes | yes | iOS: CLI. Android: Gradle plugin. RN: Expo config plugin (`posthog-react-native/expo`, `uploadNativeSymbols`), Metro config, Xcode script. | rn tooling/expoconfig.ts; CHANGELOG 4.85.4 |

## FWK framework integrations

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| FWK-a | n/a | n/a | yes | `PostHogErrorBoundary`, `PostHogProvider`, hooks (`usePostHog`, `useFeatureFlag(s)`, `useFeatureFlagResult`). | rn react-native/src/index.ts, src/hooks/ |
| FWK-b | n/a | n/a | n/a | — | — |
| FWK-c | n/a | n/a | n/a | — | — |
| FWK-d | yes | n/a | n/a | SwiftUI modifiers: `postHogScreenView`, `postHogViewSeen`, `postHogMask`, `postHogNoMask`, `postHogDeepLinkListener`, tag; SwiftUI tap autocapture. | ios PostHog/SwiftUI/ |
| FWK-e | n/a | yes | n/a | Compose: mask/unmask/no-capture modifiers, tap autocapture; `PostHogOkHttpInterceptor`; Compose surveys module `posthog-android-surveys-compose`. | and posthog-android/.../replay/PostHogMaskModifier.kt; repo root |
| FWK-f | n/a | n/a | yes | Expo supported (dev build, not Expo Go for replay); React Navigation and Wix react-native-navigation. | rn src/frameworks/wix-navigation.ts |
| FWK-g | n/a | n/a | n/a | Flutter SDK exists (replay docs list Flutter); not researched here. | posthog.com/docs/session-replay/mobile (accessed 2026-11-10) |

## REL release and versioning

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| REL-a | partial | partial | partial | `$app_version` / `$app_build` auto properties; Android `releaseIdentifier`. | and PostHogConfig.kt L285-302 |
| REL-b | no | no | no | No crash-free sessions/users in SDK. Server-side not checked. | — |
| REL-c | no | no | no | Not found. | — |
| REL-d | uncertain | uncertain | uncertain | `Application Updated` events carry version and previous version; I did not confirm an adoption dashboard. | ios PostHogConfig.swift L140-147 |

## FF feature flags

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| FF-a | yes | yes | yes | Active flags are attached to events (`$active_feature_flags`, `$feature/<key>`), including `$exception`. `$feature_flag_called` is sent (`sendFeatureFlagEvent` default true). Replay can be gated by a linked flag. | ios PostHogSDK.swift; and PostHog.kt; rn core/src/posthog-core.ts |
| FF-b | yes | yes | yes | `isFeatureEnabled`, `getFeatureFlag`, `getFeatureFlagPayload`, `getFeatureFlagResult`, `reloadFeatureFlags`, `onFeatureFlags`. `preloadFeatureFlags` default true. Bootstrap, `evaluationContexts`, person/group properties for flags. | ios PostHogSDK.swift L2361-2629; and PostHogInterface.kt L129-198 |
| FF-c | no | no | no | OpenFeature providers exist for node, web and server-java only (`openfeature-node-provider`, `openfeature-web-provider`, `posthog-server-openfeature`), not for mobile. | posthog-js/packages/; posthog-android repo root |

## FB user feedback

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| FB-a | partial | partial | partial | Done through surveys (OTH-c). No dedicated feedback widget. | — |
| FB-b | partial | partial | partial | Survey events (`survey sent`); custom survey UI possible. | — |
| FB-c | no | no | no | Not found. | — |

## OTH other

| ID | iOS | Android | RN | Config / default / limits | Sources (URL, date) |
|---|---|---|---|---|---|
| OTH-a | yes | yes | yes | Product analytics core: screens, lifecycle, deep links, autocapture, funnels server-side. | — |
| OTH-b | yes | yes | yes | Experiments via flags: `captureFeatureView`, `captureFeatureInteraction`. | ios PostHogSDK.swift L2439-2454; and PostHogInterface.kt L399-410 |
| OTH-c | yes | yes (opt-in) | yes | iOS `surveys` default true (iOS 15+, built-in UI). Android `surveys` default false (Compose UI module). RN `PostHogSurveyProvider`, `disableSurveys` default false; delay and priority handling (4.85.0). | ios PostHogConfig.swift L472-497, L660; and PostHogConfig.kt L226-248; rn src/surveys/, CHANGELOG 4.85.0 |
| OTH-d | partial | partial | partial | WebViews appear in replay only in screenshot mode. No hybrid bridge found. | posthog.com/docs/session-replay/installation/ios (accessed 2026-11-10) |
| OTH-e | no | no | no | — | — |
| OTH-f | uncertain | uncertain | uncertain | Not checked in the SDKs. | — |
| OTH-g | yes | yes | yes | See the -x rows below. | — |
| OTH-x1 | yes | yes | yes | **Push notifications** for PostHog Workflows: `capturePushNotificationSubscriptions` and `capturePushNotificationOpened`, both default true; token registration (APNs / FCM); `pushIdentityProvider`. | ios PostHogConfig.swift L187-232, PostHog/PushNotifications/; and PostHogAndroidConfig.kt L32-45; rn posthog-rn.ts options |
| OTH-x2 | yes | yes | yes | **Groups** (B2B): `group(type, key, props)` and group properties for flags. | ios PostHogSDK.swift L2048-2062 |
| OTH-x3 | no | yes | no | **Android `encryption`** hook for the on-disk queue (`PostHogEncryption`, default null). | and PostHogConfig.kt L164 |
| OTH-x4 | yes | no | no | **iOS `appGroupIdentifier`** shares SDK storage between the app and its extensions. | ios PostHogConfig.swift L424 |
| OTH-h | n/a | n/a | n/a | Web concern; added after the research | — |

## Notable

1. **Wireframe vs screenshot is the key replay trade-off.**
   - Native defaults to a wireframe (the view tree rendered as rrweb-style HTML). It is cheap and private, but SwiftUI and Compose are **only supported in screenshot mode** (docs).
   - RN always forces screenshot mode.
   - Screenshot defaults: Android WebP quality 30 at 1 px per dp; iOS 1 px per point. Snapshots are throttled to 1 s.
2. **Masking is privacy-first by default.** All text inputs and images are masked; iOS also masks sandboxed pickers; passwords are always masked. Overrides use plain string tokens (`ph-no-capture`, `ph-no-mask`) on the accessibility id or tag, plus SwiftUI and Compose modifiers.
3. **Mobile network capture is minimal.** Replay gets URL, method, status, duration and size; no headers or bodies. iOS swizzles URLSession automatically. Android needs a manually installed OkHttp interceptor. RN gets it on iOS only.
4. **Trace propagation is not W3C.** Opt-in per host, it injects `X-POSTHOG-SESSION-ID` and `X-POSTHOG-DISTINCT-ID`. An OTel-native SDK can do better: real `traceparent` plus session baggage.
5. **Crashes are opt-in and sent on the next launch.**
   - iOS: PLCrashReporter fork; disabled when a debugger is attached; Swift crashes show only as SIGTRAP.
   - Android: JVM handler, plus NDK read from `ApplicationExitInfo` tombstones (API 31+, no in-process native handler).
   - **Gaps:** no ANR or app-hang detection, no watchdog detection. OOM only via MetricKit on iOS 27+.
6. **Breadcrumbs are manual only.** "Exception steps" sit in a 32 KB FIFO buffer, persisted with crash context. Screens, taps and network are not auto-added. This is a gap a RUM SDK can fill with its own event stream.
7. **No performance telemetry.** No app start, frames, TTID/TTFD, vitals or spans. PostHog mobile is analytics plus replay plus errors, not APM.
8. **Logs are the only OTLP path.** They go as OTLP-JSON to `/i/v1/logs` with `service.name` and `service.version` resource attributes, a 500-per-10 s client rate cap and a `beforeSend` hook. Everything else uses the vendor `/batch` format. Logs could be a good interop reference.
9. **Sessions:**
   - Native: 30 min inactivity, 24 h max, neither configurable. Session ids appear not to survive a cold start (my reading of source).
   - RN: timeout configurable (`sessionExpirationTimeSeconds`); `enablePersistSessionIdAcrossRestart` default false.
   - Replay sampling is deterministic on the session id. Remote config (always loaded) gates replay, triggers, linked flags, minimum duration, and log and network capture, all combined with AND. There is no buffer-on-error replay mode.
10. **Transport defaults:**
    - Batch: `flushAt` 20 (RN 20), flush every 30 s (RN 10 s), batch 50 (RN 100), disk queue 1000 with FIFO drop.
    - gzip is on by default. Retries cover 408, 429 and 5xx with backoff, and `Retry-After` is honoured.
    - Android stores its queue in `cacheDir`, which the OS may clear. iOS uses Application Support.
