# Appendix F: Luciq (formerly Instabug) mobile SDKs

Researched 2026-10-29. Luciq is the 2025 rebrand of Instabug. Its native iOS and Android SDKs are **closed binaries**, so this appendix only says what can be known from three places, and labels every fact with where it came from:

- `[docs only]`: docs.luciq.ai (the whole GitBook site was pulled as markdown on 2026-10-29: 656 pages). A docs claim is what Luciq says, not something verified here.
- `[wrapper code]`: the open-source React Native and Flutter SDKs, cited as `path:line @ sha`.
- `[binary headers]`: public text files inside the published artifacts (iOS `Headers/*.h`, `.swiftinterface`, plists; Android POMs and the `classes.jar` entry list). Nothing from the binaries was run.

Abbreviations: **RN** = `luciqai/luciq-reactnative-sdk @ 5a75a73`, **FL** = `luciqai/luciq-flutter-sdk @ 79556a7` (paths under `packages/luciq_flutter/` unless stated), **iOS-H** = `LuciqSDK.xcframework/ios-arm64/LuciqSDK.framework/` from `Luciq-XCFramework.zip` 19.13.0, **AAR** = Maven Central `ai.luciq.library:*:19.15.0`.

## 1. Sources

| What | Where, version, status |
|---|---|
| RN SDK (MIT) | `https://github.com/luciqai/luciq-reactnative-sdk`, HEAD **`5a75a737db0b06ebf84ccdd6d5a778b724485957`** = tag `v19.10.1` (2026-08-19), npm `@luciq/react-native`. History restarts at the rebrand (149 commits, first is "initial commit", then "Release: v18.0.0"). Pins native iOS `Luciq 19.9.3` (`ios/native.rb:1`) and Android `ai.luciq.library:luciq:19.10.1` (`android/native.gradle:2`) |
| Flutter SDK (MIT) | `https://github.com/luciqai/luciq-flutter-sdk`, HEAD **`79556a72fea03aea15a6ee135358109a8aa76364`** = tag `v19.9.4` (2026-09-20). Melos monorepo: `luciq_flutter`, `luciq_dio_interceptor`, `luciq_http_client`, `luciq_gql_link`, `luciq_flutter_modular`, `luciq_flutter_ndk`, `luciq_cli`. Pins iOS `Luciq 19.9.3` (`ios/luciq_flutter.podspec:23`), Android `luciq:19.10.0` (`android/build.gradle:48`) |
| Legacy wrappers | `Instabug/Instabug-React-Native`, `Instabug/Instabug-Flutter`, `Instabug-iOS`, `Instabug-Cordova`: all **archived** in October 2026, descriptions "Instabug (Now Luciq) …". Not studied further: the Luciq repos supersede them |
| iOS binary | `luciqai/luciq-ios-sdk @ 58026bf` (tag `19.13.0`) holds only `Package.swift` (a `binaryTarget` pointing at the release zip), `Luciq.json` (Carthage) and a sample. Zip downloaded to scratch, 137.8 MB, sha256 `ba7cb599…ddd08` = the checksum in `Package.swift`. Licence: "Permission is hereby granted to use this framework as is, modification are not allowed" (`LICENSE.md`) |
| Android binary | `luciqai/luciq-android-sdk @ d21c74c` (tag `v19.15.0`) holds a sample app, `CHANGELOG.md` and a migrator; the SDK itself is on Maven Central as `ai.luciq.library:*` (AARs listed, not run) |
| Docs | https://docs.luciq.ai (index `llms.txt`), notably `/product-guides-and-integrations/product-guides/session-replay`, `…/session-replay/video-like-replay`, `/organization-settings/others/sdk-performance-and-footprint`, `…/device-performance-classification`, `…/luciq-pii-masking/screen-and-screenshot-masking`, per-platform `setup-session-replay` pages |
| Blog | Only marketing material was found. "Session Replay product tour" now redirects to a Luciq landing page ("100% of sessions, no blind spots") `[blog only]`. "How we implemented View Hierarchy at Instabug" (2017) describes screenshot capture freezing the UI and being split into async main-queue tasks `[blog only, via a third-party summary]`. No engineering post on the replay pipeline was found |
| Other luciqai repos | `luciq-masking-linter` (Python + Android Lint static PII linter, no licence file), `agent-skills` (Apache-2.0, Claude Code skills + Luciq MCP server wiring), `luciq-cli`, `luciq-swatpack` (diagnostics CLI, MIT), fastlane plugins, and a **fork of `hyperdxio/hyperdx`** (OTel + ClickHouse observability, MIT, forked 2026-07-30, active RBAC/MCP commits on 2026-10-25). What Luciq uses the fork for is not public |

## 2. Platforms and languages

| Platform | Package | Language of the open part | Who does the work | Replay |
|---|---|---|---|---|
| iOS | `Luciq` (CocoaPods, SPM, Carthage), module `LuciqSDK` | closed; public API is Objective-C headers with `NS_SWIFT_NAME` (e.g. `LCQSessionReplay` → `SessionReplay`) plus a 39-line `.swiftinterface` that only adds SwiftUI modifiers `[binary headers]` | native | yes |
| Android | `ai.luciq.library:luciq` (+ `-ndk-crash`, `-compose`, Gradle plugin `luciq-apm`) | closed; Java/Kotlin, `kotlin-stdlib` dependency, ProGuard-obfuscated internals | native | yes |
| React Native | `@luciq/react-native` | TypeScript + ObjC/Java bridges (TurboModule codegen spec `RNLuciqSpec`) | native SDK for capture; JS for navigation, XHR, JS errors | yes, native screenshots |
| Flutter | `luciq_flutter` | Dart + ObjC/Java plugin (Pigeon) | native SDK for upload/storage; **Dart** for user steps, private-view geometry, frame timing | yes, plugin-side screenshot |
| KMP | `ai.luciq.library:luciq-kmp*` (Maven lists `-android`, `-iosarm64`, `-iossimulatorarm64`, `-iosx64`) | closed | native | docs have a KMP session replay page `[docs only]` |
| Cordova, Xamarin, Unity | none under the Luciq name; the iOS `LCQPlatform` enum still lists `Cordova`, `Xamarin`, `Unity` next to `ReactNative` and `Flutter` (`iOS-H/Headers/LCQTypes.h:509-516`) `[binary headers]` | n/a | n/a | no Luciq docs |
| Web | no browser SDK; the native SDKs track WebViews (`Luciq.webViewMonitoringEnabled`, `APM.webViewTrackingEnabled`) `[binary headers]` | | | |

- iOS binary: `MinimumOSVersion` **15.0** (`iOS-H/Info.plist`), slices `ios-arm64`, `ios-arm64_x86_64-simulator`, `tvos-arm64`, `tvos-arm64_x86_64-simulator`. The ios-arm64 Mach-O is 12,845,072 bytes uncompressed. `CFBundleIdentifier` is still `com.Instabug.Instabug` and headers import `<InstabugUtilities/…>` / `<InstabugCoreInternal/…>`: the rebrand renamed the API (`IBG*` → `LCQ*`, `Instabug` → `Luciq`), not the internal modules `[binary headers]`.
- RN wrapper: iOS `platform :ios, "15.0"` (`RNLuciq.podspec`), peer `react-native >=0.60.0` (`package.json:42`) `[wrapper code]`.
- Flutter wrapper: Android `minSdkVersion 16` (`android/build.gradle:37`), Dart `>=2.14.0 <4.0.0` (`pubspec.yaml:42`) `[wrapper code]`.
- Android modules and size (AAR on Maven, 19.15.0) `[binary headers]`: `luciq-core` 5.9 MB, 4,676 classes, ships `libluciq-native.so` for 4 ABIs (173–309 KB each); `luciq-ndk-crash` 1.8 MB with `libluciq-ndk-crash-lib.so` (0.9–1.5 MB per ABI); `luciq-crash` 859 KB (716 classes); `luciq-bug` 1.0 MB; `luciq-apm` 753 KB (609 classes); `luciq-survey` 483 KB; `luciq-features-request` 246 KB; `luciq-compose(-core,-apm)` 36–204 KB. Core depends on `legacy-support-v4`, `material`, `vectordrawable-animated`, `multidex`.

From the docs `[docs only]` (paths are under `https://docs.luciq.ai`):

- "The Luciq SDK runs in your iOS, Android, React Native, Flutter, or KMP app" (`/getting-started/introduction`). Doc sections exist only for those five. Cordova appears only as a leftover code-tab title; Ionic, Xamarin, .NET MAUI, Unity and any browser SDK are absent. The 2026 marketing page lists "iOS, Android, React Native, and Flutter" `[blog only]`.
- Session Replay minimum SDK: iOS 12.0 and Android 12.0 (`/ios/setup-luciq-for-ios/setup-session-replay`, `/android/set-up-luciq-for-android/set-up-session-replay`), RN 12.1.0; the Flutter page repeats the RN sentence (copy-paste), and KMP has no version box. Video-like modes: Android 19.1.0, RN 19.1.0, iOS 19.2.0; no Flutter video-like page.
- RN supports React Native 0.60+; Expo needs a development build ("not supported in the Expo Go app"). Android NDK crashes need API 21+. No page states the iOS deployment target or Android minSdk (the binary says iOS 15.0, see above).
- Feature tables in the RN and Flutter readmes contradict deeper pages (they mark Screen Loading and Spans unsupported while dedicated pages exist), and the RN table says user steps work only for native components.

**Positioning** `[docs only]`: Luciq now describes itself as "The Agentic Observability Platform built for Mobile" (repo descriptions), with an MCP server, Claude Code agent skills and AI triage features layered on bug, crash, APM, replay, survey and feature-request products. Commercial terms are out of scope for this repository.

## 3. RUM / APM and crash reporting

### 3.1 What the native API exposes `[binary headers]`

From `iOS-H/Headers/LCQAPM.h`, `LCQCrashReporting.h`, `Luciq.h`, `LCQTypes.h` and Android package names in `luciq-*/classes.jar`:

| Signal | iOS public API | Android packages (AAR) |
|---|---|---|
| App launch | `APM.coldAppLaunchEnabled`, `hotAppLaunchEnabled`, `endAppLaunch` | `ai/luciq/apm/...` (launch handled inside APM) |
| Screen loading | `screenLoadingEnabled`, `trackScreenLoading(for:)`, `endScreenLoadingForViewController:` | `ai/luciq/apm/screenloading/handler`, `apm/fragment` |
| Screen rendering (slow/frozen frames) | `screenRenderingEnabled` (replaces deprecated `UIHangsEnabled`) | `ai/luciq/apm/screenrendering/*`, `apm/compose/compose_spans` |
| UI traces | `autoUITraceEnabled`, `startUITraceWithName:`, `endUITrace` | `ai/luciq/apm/uitrace/*` |
| Flows (ex "execution traces") | `startFlowWithName:`, `endFlowWithName:`, `setAttributeForFlowWithName:`; `startExecutionTraceWithName:` is `unavailable` | `ai/luciq/apm/appflow/*` |
| Custom spans | `startCustomSpanWithName:` → `CustomSpan.end()`, `addCompletedCustomSpanWithName:` | |
| Network | `NetworkLogger` (auto `NSURLSession` capture, body logging, obfuscation and filter handlers, `addGrpcNetworkLogWithUrl:`), `APM.addNetworkTraceAttributesForURLMatchingPredicate:` | `ai/luciq/library/networkinterception/{urlconnection,sanitization,externaltrace}`, Gradle plugin instrumentation for OkHttp (the sample app's `luciq-android-sdk/app/build.gradle:5`: "apply luciq APM plugin for capturing network requests"), `LuciqGrpcInterceptor` |
| WebViews | `webViewMonitoringEnabled`, `webViewUserInteractionsTrackingEnabled`, `webViewNetworkTrackingEnabled`, `APM.webViewTrackingEnabled` | `ai/luciq/apm/webview/webview_trace/*` |
| Core Data | `Luciq.coreDataInstrumentationEnabled` | |
| Crashes | `CrashReporting.enabled`, `OOMEnabled`, `appHangEnabled`, `forceRestartEnabled`, `unhandledEnabled`, non-fatals via `CrashReporting.exception:`/`error:`, launch crashes (`markLaunchCrashFree`, `enableSendingLaunchCrashesSynchronously`) | `ai/luciq/crashv2/{anr,liveanr,fatalhang,memorytermination}`, `ai/luciq/bganr`, `ai/luciq/terminations`, `ai/luciq/fatalhangs`, `luciq-ndk-crash` |
| Event types | `LCQEventType`: `FatalCrash`, `NonFatal`, `FatalUIHang`, `WatchdogTermination`, `OutOfMemory`, `ForceRestart` (`LCQTypes.h:495-503`) | Android 19.15.0 adds "Android Memory Limit Exceeded" (Android 17 memory limiter) (`luciq-android-sdk/CHANGELOG.md`, release notes, so `[docs only]`) |
| Session profiler | `Luciq.sessionProfilerEnabled`: "attaches to the bug and crash reports … during the last 60 seconds": CPU load, dispatch queue latency, memory, storage, connectivity, battery, orientation (`Luciq.h:90-102`) | `ai/luciq/core/sessionprofiler`, `ai/luciq/library/sessionprofiler/model/timeline` |
| Before-send hook | `onBeforeSendingEventHandler` with `LCQEvent` (`occurrenceID`, `occurredAtMicroseconds`, tags, attributes, file attachments) | `Luciq.setOnBeforeSendHandler` (19.14.0) |

iOS crash capture: `LCQCrashReporterState` reports the current and Luciq's **Mach exception port**, **signal handler** and **uncaught `NSException` handler** (`LCQCrashHandlersInfo.h`), and `LCQCrashAsyncFile.h` declares an async-signal-safe buffered writer `lcqcrash_async_file_t { int fd; off_t limit_bytes; off_t total_bytes; … }`. The struct and comment wording match PLCrashReporter's `plcrash_async_file_t`, which suggests a PLCrashReporter-derived reporter. That is an inference from names, not verified.

### 3.1b Definitions and thresholds `[docs only]`

Paths under `https://docs.luciq.ai`; `PG` = `/product-guides-and-integrations/product-guides`, `APMG` = `PG/application-performance-monitoring`.

| Signal | Definition and thresholds |
|---|---|
| Cold launch | iOS: "starts with the process start time and stops at the end of the first run loop", but since SDK 19.0.0 "until `UIApplication.didBecomeActiveNotification`" (both on `APMG/app-launch`). Android: "starts after Luciq's `ContentProvider` is created and ends when `onActivityResumed()` is called for the first time". RN: "until … responsive and accepting touch events". `endAppLaunch` overrides the end |
| Warm / hot launch | Android warm `onActivityCreate()` → `onActivityResumed()`, hot `onActivityStarted()` → `onActivityResumed()`; iOS hot = `WillEnterForeground` → `DidBecomeActive`; iOS warm undocumented |
| Screen loading | iOS `viewDidLoad` → `viewDidAppear` (SwiftUI from 14.0.0 via `LuciqTracedView`); Android `onCreate` → `onResume` (Compose composables as spans); Flutter `init()` → end of `build()`; RN TTID from 19.6.0 with React Navigation v6 |
| UI hang (APM) | "isn't responding to the user's input for more than **250 ms**"; per-screen hang % = hang time / visit (`viewDidAppear` → `viewWillDisappear`) |
| App hang (crash) | "main thread is blocked for more than **3 seconds**" (iOS since 10.13.0, Android since 11.5.0), with stack trace, grouped by first non-system frame |
| Screen rendering | slow / frozen frame thresholds not stated (the Flutter wrapper uses refresh interval and 700 ms); screen Apdex: satisfying = no frozen frames and ≤ 10% slow, tolerable ≤ 50% slow, frustrating = any frozen and > 50% slow. Since SDK 19.0 |
| Flows | up to 10,000 unique flows, names ≤ 150 chars, 5 attributes per instance (key ≤ 30, value ≤ 60), no parallel instances of the same flow; drop-offs: crash, user termination, fatal ANR, fatal app hang, force restart, abandoned after 60 s in background |
| Custom spans | max **100 per session**; Android 19.3.0, iOS 19.5.0 |
| Network (APM) | iOS: automatic for the shared `NSURLSession` ("Initialize Luciq first … before other SDKs such as Firebase"); Android: Gradle plugin instruments `OkHttpClient` and `HttpURLConnection` (19.0.0+ "unified network interception"; the docs mention an "ASM transform"); Flutter `http`/`dio`/`dart:io` adapters; RN XHR by default or native mode; KMP Ktor plugin. Latency breakdown (DNS, handshake, TLS, upload, download, server); URL templating replaces numbers and hex tokens with `*`; sensitive headers auto-masked on Android |
| Apdex | default targets: launch 0.5 s, screen loading 0.1 s, network 0.5 s, flows 0.5 s, traces 2 s; satisfying ≤ T, tolerable ≤ 4T; score bands ≥ 0.94 excellent … < 0.5 unacceptable (`APMG/metrics-and-dimensions`) |
| Crash types | fatal (signals, exceptions, ObjC runtime errors on iOS; Java and NDK/C++ on Android), non-fatal, ANR (no threshold stated), app hang (3 s), OOM on iOS ("will not contain a stack trace and will only be captured if they happen while the app is in the foreground"), force restart ("force terminates your application and re-launches it within 5 seconds", no stack), Android 17 memory terminations (19.15.0, off by default, detected next launch, not counted in stability). No "watchdog" page although the iOS enum has `WatchdogTermination` |
| RN / Flutter errors | "JavaScript exceptions" and "Dart exceptions" are crash types; Flutter only in release builds; the dashboard filters platforms `IOS`, `ANDROID`, `DART`, `JAVASCRIPT` |
| Symbolication | dSYMs, R8 `mapping.txt` + NDK `.so`, RN source maps auto-uploaded on release builds, Flutter `--obfuscate` symbols via `luciq-cli` |
| Session profiler | last **60 s** before a report; iOS: CPU, memory, storage every **0.5 s**; connectivity, battery, orientation every **2 s**; Android has no CPU; RN and Flutter: CPU and memory iOS only. Also attached to app hang and force restart occurrences |
| Crash-free metrics | crash-free sessions and users, OOM-, app-hang-, force-restart-free sessions; green ≥ 99.5, red < 98 |

### 3.2 How React Native feeds it `[wrapper code]`

- **Platform tag**: the bridge calls the hidden `+[Luciq setCurrentPlatform:]` with `LCQPlatformReactNative` via `NSSelectorFromString` (`ios/RNLuciq/LuciqReactBridge.mm:651-652`). The wrapper declares more hidden "CP" (cross-platform) APIs in its own headers: `ios/RNLuciq/Util/Luciq+CP.h`, `LCQCrashReporting+CP.h` (`cp_reportFatalCrashWithStackTrace:`), `LCQNetworkLogger+CP.h` (W3C flags, `forceStartNetworkLogging`, async obfuscation), `LCQAPM+PrivateAPIs.h` (`reportScreenLoadingCPWithStartTimestampMUS:`, `startObservingDisplayLinkWithCallback:`).
- **Screens**: `Luciq.onStateChange` (pass to React Navigation's `NavigationContainer`) computes the full route and calls `NativeLuciq.reportScreenChange` after a **1,000 ms settle timer** (`src/modules/Luciq.ts:1107-1141`). iOS forwards it to the hidden `+[Luciq logViewDidAppearEvent:]` (`ios/RNLuciq/LuciqReactBridge.mm:572-581`); Android calls the hidden `Luciq.reportScreenChange(Bitmap, String, Long)` by reflection with a **null bitmap** (`android/src/main/java/ai/luciq/reactlibrary/RNLuciqReactnativeModule.java:1210-1220`). The comment at `src/modules/Luciq.ts:72-79` says this call "handles taking a screenshot for reproduction steps": the screenshot is taken natively.
- **Screen loading (TTID)**: start = React Navigation `__unsafe_action__` dispatch, end = next native frame timestamp after the state settles, read from `CADisplayLink` (iOS) / `Choreographer` (Android) (`src/modules/apm/ScreenLoadingManager.ts` header comment, `ios/RNLuciq/LuciqScreenLoadingFrameTracker.m:43-54`, `android/.../LuciqScreenLoadingFrameTracker.java:44`), reported through `reportScreenLoadingCPWithStartTimestampMUS:durationMUS:stages:` (`ios/RNLuciq/LuciqAPMBridge.mm:251`). `LuciqCaptureScreenLoading` (`src/components/LuciqCaptureScreenLoading.tsx`) is the manual variant.
- **APM API in JS**: `endAppLaunch`, `startFlow`/`endFlow`/`setFlowAttribute`, `startUITrace`/`endUITrace`, `startCustomSpan`, `setScreenRenderingEnabled`, `endScreenLoading` (`src/modules/APM.ts:26-259`).
- **Network**: `XMLHttpRequest.prototype.open/send/setRequestHeader` are patched (`src/utils/XhrNetworkInterceptor.ts:40-42`); RN's `fetch` is built on XHR, so both are seen. `networkInterceptionMode` defaults to `javascript`; on Android JS interception stays on "in all scenarios for Bugs & Crashes network logs", and native interception is used for APM only when the Luciq Gradle plugin is present (`src/modules/Luciq.ts:256-300`).
- **JS crashes**: `ErrorUtils.getGlobalHandler()` is wrapped (`src/utils/LuciqUtils.ts:189-199`), the stack is parsed with RN's `parseErrorStack` and sent as a dictionary to `cp_reportFatalCrashWithStackTrace:` on a background queue (`ios/RNLuciq/LuciqCrashReportingBridge.mm:32-43`). Unhandled promise rejections (`src/utils/UnhandledRejectionTracking.ts`) and `LuciqErrorBoundary` cover the rest. Source maps are uploaded by `ios/sourcemaps.sh` / the `cli`.
- **User steps**: no JS gesture capture. Touches are captured by the native SDK; Android adds `utils/RNTouchedViewExtractor.java` to name the touched React view.

### 3.3 How Flutter feeds it `[wrapper code]`

- **Screens**: `LuciqNavigatorObserver` (`lib/src/utils/luciq_navigator_observer.dart:94-109`) waits a `screenReportDelay` (default **100 ms**, line 17) and calls `Luciq.reportScreenChange`, which on Android invokes the same hidden `Luciq.reportScreenChange(Bitmap=null, name, null)` and `reportCurrentViewChange` by reflection (`android/src/main/java/ai/luciq/flutter/modules/LuciqApi.java:546-555`).
- **User steps in Dart**: `LuciqWidget` wraps the app in a `Listener` (`lib/src/utils/user_steps/luciq_user_steps.dart:232-234`) and classifies pointer down/up into tap, double tap (≤300 ms), swipe/scroll (>50 px), pinch (>20 px) (lines 27-30, 84-124), hit-tests the `RenderBox` to name the widget, and sends `Luciq.logUserSteps(gesture, message, viewName)` (`lib/src/modules/luciq.dart:808-815`). Native user-step capture is **switched off** on Android by reflection on the hidden `shouldDisableNativeUserStepsCapturing(true)` (`android/.../LuciqApi.java:170-174`).
- **Screen rendering in Dart**: `WidgetsBinding.addTimingsCallback` (`lib/src/utils/screen_rendering/luciq_screen_render_manager.dart:309`) with slow frame > refresh interval (default 16.67 ms) and **frozen frame > 700 ms** (lines 41-45, 79-110).
- **Network**: separate packages. `luciq_dio_interceptor` (Dio `onRequest/onResponse/onError`, injects `traceparent` at `lib/luciq_dio_interceptor.dart:26`), `luciq_http_client` (`LuciqHttpClient implements http.Client`, `lib/luciq_http_client.dart:16-61`), `luciq_gql_link` (GraphQL).
- **Dart errors**: the README tells the app to wrap `runApp` in `runZonedGuarded` and set `FlutterError.onError`, both pointing at `CrashReporting.reportCrash` (`README.md:65-80`, `lib/src/modules/crash_reporting.dart:41`). NDK crashes via `luciq_flutter_ndk`.

## 4. Session replay

### 4.1 What is recorded

- **A series of still screenshots plus logs, not video.** "Screenshots taken throughout the session whenever there is a change in the UI (The SDK captures a screenshot with every screen transition)" and logs: Luciq logs, user steps, network logs, crashes (fatal, app hangs, ANRs, non-fatal) and APM metrics `[docs only]` (product guide).
- **Session = one foreground period**: starts on foreground, ends on background or termination; "We currently support session replay for foreground sessions only" `[docs only]`.
- **Capture triggers** (`LCQScreenshotCapturingMode`: `Navigation`, `Interaction`, `Frequency`, `iOS-H/Headers/LCQTypes.h:589-593`; Android `ai.luciq.library.sessionreplay.CapturingMode`) `[binary headers]`:

| Mode | Trigger `[docs only]` | Availability |
|---|---|---|
| Navigation (default) | screen transitions only | all |
| Interactions | navigation + tap, double tap, long press, force touch, swipe, pinch, scroll, "includes debouncing" (SwiftUI scroll needs manual integration) | iOS 19.2.0+, Android 19.1.0+ behind `@OptIn(ExperimentalVideoLikeReplay::class)` |
| Frequency | fixed timer, default **1,000 ms, minimum 500 ms** (lower values are clamped), plus navigation; the timer resets on navigation and on manual `captureScreenshot` | same; Android docs warn it "may capture sensitive UI unmasked in some cases" |

- **Encoding**: WebP. `High` = "50% quality", `Normal` (default) = "25% quality", `Greyscale` = 25% + grayscale `[docs only]`; enum `LCQScreenshotQualityMode {Normal, High, GreyScale}` `[binary headers]`.
- **Budget**: "Based on the default 1MB session screenshot limit": ~62 (High), ~104 (Normal), ~130 (Greyscale) screenshots per session, "at 1 FPS with Normal quality, you can capture approximately 1-2 minutes" `[docs only]`. That implies **~16 KB, ~10 KB and ~8 KB per frame**. The iOS setup page states a different limit: "up to 2MB of compressed logs and 2MB of compressed screenshots" per session, "up to 50MB worth of data (for multiple sessions)", "maximum of 1MB per request" `[docs only]`; the two pages disagree (1 MB vs 2 MB).
- **Upload timing** (iOS page): data is sent "in batches, at most, once every 6 hours", no network in background, so it goes "at the beginning of a session if the last server communication took place more than 6 hours ago" `[docs only]`. The replay of the current session is therefore not live; it arrives on a later launch.
- **Sampling = client-side keep/drop callback**, not a rate: `SessionReplay.syncCallbackWithHandler` is called "at the beginning of the next session" with `SessionMetadata` of the previous one (device, OS, app version, duration, launch type and duration, bug / fatal / OOM counts, `hasLinkToAppReview`, network logs with URL, duration, status) and the app returns keep/drop (`iOS-H/Headers/LCQSessionReplay.h`, `LCQSessionMetadata.h`) `[binary headers]`. Android `SessionReplay.setSyncCallback` exists (class strings) `[binary headers]`.
- **Low-end Android**: devices with Android < 5.1, ≤ 2 cores or ≤ 2 GB RAM are "Low-end" (~30% of data collected; replay forced to Navigation mode, session profiler ~18 s, network/console logs and repro steps 30% retained); mid-range ~60%. Classified once per SDK start; emulators with 2 GB RAM count as low-end `[docs only]`.
- **Toggles**: `SessionReplay.enabled`, `networkLogsEnabled`, `LCQLogsEnabled`, `userStepsEnabled`, read-only `sessionReplayLink` (`LCQSessionReplay.h`) `[binary headers]`; replay "is enabled by default" (header comment) but is plan-gated ("If … Session Replay isn't included in your current plan, please reach out") `[docs only]`.

### 4.2 Masking

- **On device, burned into the bitmap**: "Masking is applied on-device at screenshot-capture time, before the image is written to encrypted local storage or uploaded. Private regions are painted directly into the bitmap" `[docs only]`.
- **Private views → solid black rectangle, subtree included**, and private views take precedence over auto masking `[docs only]`. APIs: iOS `UIView.luciq_privateView` (`iOS-H/Headers/UIView+Luciq.h`: "exclude it from all screenshots and screen recordings"), SwiftUI `.luciq_privateView()` and `LuciqPrivateView` (`.swiftinterface`) `[binary headers]`; Android `Luciq.addPrivateViews/removePrivateViews/removeAllPrivateViews`, Compose `Modifier.luciqPrivate()` (`ai/luciq/compose/LuciqModifierExtensionsKt` in `luciq-compose-core`) `[binary headers]`.
- **Auto masking by type**: iOS `LCQAutoMaskScreenshotOption {MaskNothing, TextInputs, Labels, Media, WebViews}` (`LCQTypes.h:281-287`), Android `MaskingType {TEXT_INPUTS, LABELS, MEDIA, WEB_VIEWS, …}` `[binary headers]`. Defaults: iOS auto masking **off** except WebViews (masked by default since 19.2.0 / 19.3.0); Compose auto masking on; Flutter auto masking off; private views on `[docs only]`. `Luciq.autoMaskAllSwiftUIViews` applies the type rules to SwiftUI `[binary headers]`.
- **Android `FLAG_SECURE`** windows are not captured unless `ignoreFlagSecure(true)` `[docs only]`.
- **Text redaction in steps** is separate: `Luciq.viewsContentCaptureEnabled = false` keeps gesture, view class and screen name but replaces labels with "a button", "a text", "an image"; it "Does not affect Session Replay screenshots" (`Luciq.h:165-182`) `[binary headers]`.
- **Screen recordings** (bug reporting) are a different path: Android private views are "Not masked — use FLAG_SECURE", auto masking "Not applied" to recordings on either OS `[docs only]`.
- **Capture cost**: iOS "a single pass over the live view hierarchy", ~56–66 ms main thread per capture on iPhone 13 Pro Max; Android ~2.51 ms avg / 3.2 ms p90 on Samsung A72, "most of the work, including auto-masking, runs off the main thread" `[docs only]`. The Android AAR contains `ai/luciq/library/instacapture/screenshot/{ScreenshotTaker,RootViewInfo,FieldHelper}`, `ActivityReferenceManager` and an `instacapture/screenshot/pixelcopy` package (`luciq-core/classes.jar`) `[binary headers]`. Those class names match the open-source **Instacapture** Android library (root-view walking via reflection), which suggests Luciq's Android capture grew from it plus a `PixelCopy` path. This is a naming inference.

### 4.3 Is the technique the same on RN and Flutter?

| | Who takes the screenshot | Who decides what to mask | Who paints the mask |
|---|---|---|---|
| iOS / Android native | native SDK | native SDK (view walk) | native SDK |
| React Native | **native SDK**, triggered by `reportScreenChange` (null bitmap passed, `RNLuciqReactnativeModule.java:1217-1219`) | native: `Luciq.addPrivateView(ref)` resolves the React tag (`findNodeHandle`, `src/modules/Luciq.ts:846-858`) to a `UIView` and sets `view.Luciq_privateView = true` (`ios/RNLuciq/LuciqReactBridge.mm:547-555`) or calls `Luciq.addPrivateViews(view)` (`RNLuciqReactnativeModule.java:1135-1148`); auto masking forwarded to `setAutoMaskScreenshots` (`LuciqReactBridge.mm:682`) | native SDK |
| Flutter | **plugin code**, through a native hook | **Dart** computes rectangles | **plugin code** (Java / ObjC) |

Flutter detail `[wrapper code]`:

- Dart side: `LuciqWidget` puts the app under a `RepaintBoundary` with a global key (`lib/src/utils/luciq_widget.dart:43-48`). `PrivateViewsManager.getRectsOfPrivateViews()` walks the **element tree** from that key, matches `LuciqPrivateView` / `LuciqSliverPrivateView` widgets plus the auto-mask predicates (labels, text inputs, media, web views), keeps only attached render objects whose `ModalRoute` is current and that overlap the screen, and returns `[left, top, right, bottom]` doubles in global logical coordinates (`lib/src/utils/private_views/private_views_manager.dart`, `getPrivateViews` near the end of the file). The `RepaintBoundary` is not rasterised in Dart (no `toImage` call in `lib/`).
- Android: the plugin registers a `ScreenshotCaptor` with the hidden `ai.luciq.library.internal.crossplatform.InternalCore` (`android/.../modules/LuciqPrivateView.java:33-49`). On each native capture request it waits **300 ms**, then in parallel asks Dart for the rectangles over Pigeon and captures with `PixelCopy.request(window)` (API 26+), falling back to `PixelCopy` on the `FlutterSurfaceView`, then to `FlutterRenderer.getBitmap()` (`modules/PrivateViewManager.java:61-132`, `modules/capturing/*.java`). A single-thread executor awaits the Dart answer and paints black rectangles scaled by the pixel ratio onto the bitmap (`PrivateViewManager.java:152-186`).
- iOS: the plugin installs the hidden `+[LuciqApi setScreenshotMaskingHandler:]` (`ios/.../Modules/PrivateViewHostApi.m:22-36`, declared in `include/luciq_flutter/LuciqApi.h:9`). The handler waits **100 ms** ("Wait for the Cupertino animation"), asks Dart for rectangles, **recaptures** every `UIWindow` with `drawViewHierarchyInRect:afterScreenUpdates:YES`, then fills black rectangles with Core Graphics (`Modules/PrivateViewApi.m:29-66, 119-132`).
- So Flutter masking geometry is computed **in Dart**, but pixels are captured and painted natively. A frame captured while Dart is busy waits on the Pigeon round trip.

### 4.4 Replay UI `[docs only]`

Sessions list (user, session type "crashing" / "frustrating" / Apdex-style bucket, issues, duration, app version, OS, date); session details (user ID and name, device, OS, locale, bundle ID, device location, user attributes, feature flags); a timeline that "visually highlights performance and stability issues" and lets the user jump to that point; the screenshots; and the logs listed in 4.1. No player or wire format is public: the server, the upload format and the replay viewer are closed.

### 4.5 Retention, quota and support tools `[docs only]`

- **Session Replay entitlement** (`/organization-settings/billing/license-entitlements-and-restrictions`, "Effective for Enterprise deals starting July 28, 2026"): "Unlimited sessions, rate-limited at 6,000 requests/min/App", **retention 4 weeks**, "Session data is synced every 6 hours, but only after the user reopens the app". The same page's "standard data retention" table lists "User Sessions 365 days", bugs 365 days, crash reports 180 days (non-fatals 1 month), APM events 60–90 days (APM section: 8 weeks), logs 2 months; "Data retention can be extended by request". The 4-week and 365-day figures are not reconciled on the page.
- **Support tools**: `SessionReplay.sessionReplayLink` is meant to be attached to Zendesk (or similar) tickets as a tag or custom field so agents open the replay (`/ios/setup-luciq-for-ios/setup-session-replay/support-tools-integration`, same pages for Android, RN, Flutter, KMP).
- On Android, repro-step screenshot capture is paused under "High CPU throughput / High RAM utilization / Low-disk storage" (`/android/set-up-luciq-for-android/logs-and-profiling/repro-steps-for-android`).

## 5. Transport and OpenTelemetry

- **Transport is closed.** Known only from docs: "Uploads are compressed and retried later if offline. A Wi-Fi-only flag is available", bug and crash reports are split across several requests, crash reports are sent on the next launch, APM metrics "batched and sent periodically" `[docs only]`. `Luciq.appVariant` is added "to all network requests", and `Luciq.userDefaultsEncryptionEnabled` exists (`Luciq.h`) `[binary headers]`.
- **No OpenTelemetry anywhere.** Zero hits for `opentelemetry|otlp` in both wrapper repos and zero `opentelemetry`/`otlp` classes in the 19.15.0 AARs `[wrapper code]` `[binary headers]`. The downloaded docs mention neither OpenTelemetry nor OTLP `[docs only]`. Luciq does not export OTLP and cannot ingest it.
- **W3C trace context only, for backend correlation.** The SDKs inject or read a `traceparent` header on captured requests and store it with the network log. The RN generator is:

```ts
// src/utils/LuciqUtils.ts:256-272 @ 5a75a73
const TRACESTATE = '4942472d';  // ASCII "IBG-"
const VERSION = '00';
const TRACE_FLAG = '01';
const timestampInSeconds = Math.floor(networkStartTime.valueOf() / 1000);
const hexaDigitsTimestamp = timestampInSeconds.toString(16).toLowerCase();
const traceId = `${hexaDigitsTimestamp}${hexStringPartialId}${hexaDigitsTimestamp}${hexStringPartialId}`;
const parentId = `${TRACESTATE}${hexStringPartialId}`;
return { …, w3cHeader: `${VERSION}-${traceId}-${parentId}-${TRACE_FLAG}` };
```

  The trace ID is `epochSecondsHex + random32 + epochSecondsHex + random32`, so only **32 random bits** (`generateTracePartialId`, `LuciqUtils.ts:240-250`) and the span ID is the constant `IBG-` prefix plus the same 32 bits. It is valid W3C syntax and sampled (`01`), but it is a correlation key that encodes the request time, not an OTel span. If a `traceparent` is already present, the SDK records it instead ("caught header") (`src/utils/XhrNetworkInterceptor.ts:104-139`). Three server-driven flags gate this (`w3ExternalTraceIDEnabled`, `w3ExternalGeneratedHeaderEnabled`, `w3CaughtHeaderEnabled`, `ios/RNLuciq/Util/LCQNetworkLogger+CP.h:7-9`). Native equivalents: `NetworkLogger.newExternalTraceIDHeader` (`LCQNetworkLogger.h:131`), Android `ai/luciq/core/networklogs/w3c/W3cInfo` and `NetworkLogW3CExternalTraceIdInfo` `[binary headers]`; Flutter `lib/src/utils/w3c_header_utils.dart` `[wrapper code]`.

What the docs say about tracing `[docs only]` (`/product-guides-and-integrations/integrations/…`):

- Zero mentions of OpenTelemetry, OTLP or `tracestate` in all 656 pages. The `traceparent` format is not documented.
- The W3C header exists to deep-link a mobile network log into an APM backend: Grafana ("enables end-to-end tracing for network calls", needs a dashboard URL with `var-traceid=`, iOS and Android only, SDK 13.2.0+, "If you are masking the headers, make sure you don't remove the `traceparent` header"), New Relic and Dynatrace (both "W3C Context Propagation", SDK 13.2.0+), Instana (a button to the distributed trace). The trace ID is shown on the network occurrence page.
- The Datadog page is not tracing: it is an App Builder HTTP connection pulling Luciq metrics (crash-free sessions etc.) from `https://dashboard-api.luciq.ai`. A Grafana "App Health" plugin visualises Luciq metrics.
- KMP's Ktor plugin "injects W3C trace headers for distributed tracing".

## 6. Other features

### 6.1 User steps and repro steps

- **User steps** = automatic UI interaction log: `LCQUIEventType {Tap, DoubleTap, ForceTouch, LongPress, Pinch, Swipe, Scroll}` and `LCQInteractionViewType` (text, image, button, toggle, text field, secure field, picker, slider, stepper, list, scroll view, V/H/ZStack, tab view, sheet, alert) (`LCQTypes.h:521-552`); manual `UserStep(event:).setMessage().setViewType().logUserStep()` (`LCQUserStep.h`); `Luciq.logViewDidAppearEvent:`, `logTouchEvent:viewName:`, `logUserEventWithName:` (`Luciq.h:541-587`); SwiftUI via swizzling (`swizzleOnSwiftUIInteractions`) and `.luciqTracedView(name:)` / `.luciqNavigationExcluded()` (`.swiftinterface`) `[binary headers]`.
- **Repro steps** = user steps **grouped by screen, with a screenshot per screen**: "These steps are grouped by the app view, and you can view user steps alongside relevant screenshots", plus lifecycle events (background/foreground, memory warnings) `[docs only]`. Modes per issue type: `Enable` (with screenshots), `EnabledWithNoScreenshots`, `Disable` (`LCQUserStepsMode`); defaults: screenshots on for bugs and session replay, off for crashes `[docs only]`. Disk budget: `setReproStepsConfig(screenshotLimit 1–20, default 20; qualityPercentage 0.2–1.0, default 1.0)` (`Luciq.h:598-607`) `[binary headers]`.
- Step messages read like `Tapped on the button "Send"`, `Moved the slider "Text Size" to 10%`, `App went to the background` (Flutter docs) `[docs only]`; the Flutter wrapper builds them in Dart (`lib/src/utils/user_steps/`) `[wrapper code]`.

### 6.2 Bug reporting and feedback

- Invocation events, prompt options, report types (bug, feedback, question), attachment types (screenshot, extra screenshot, gallery image, screen recording), extended bug report modes, welcome message, theming (`LCQTypes.h:263-493`, `LCQBugReporting.h`) `[binary headers]`. `Luciq.captureScreenshot` has a one-second cooldown "to reduce the impact on the main thread as capturing screenshots is a heavy operation" (`Luciq.h:629-636`) `[binary headers]`.
- Feature requests (`LCQFeatureRequests.h`), surveys (`LCQSurveys.h`, Android adds `review` = Play in-app review dependency), in-app replies / chat (`LCQReplies.h`) `[binary headers]`.
- Android 19.14.0 deprecates "auto screen recording" in favour of Session Replay (`luciq-android-sdk/CHANGELOG.md`) `[docs only]`.

From the docs `[docs only]` (`PG/bug-reporting/*`, per-platform `showing-luciq` pages):

- **Invocation**: shake (default, with a shaking threshold), OS screenshot, floating button, edge pan (iOS), two-finger swipe left, or manual `show`. Android screenshot invocation watches the screenshots directory, which is why it asks for storage permission at launch (`luciq-android-sdk/README.md`).
- **Prompt**: "Report a bug", "Suggest an improvement", "Ask a question"; plus "Frustrating Experience" for proactive reports.
- **Attachments**: the current screen is captured automatically and users "annotate this screenshot by drawing on, magnifying, or blurring"; extra screenshots, gallery images, screen recording; "limit of 4 attachments in total"; up to three custom files of 5 MB each. Auto screen recording (last ≤ 30 s, off by default, "Used for Internal Testing") is deprecated (iOS 19.12.0, Android 19.14.0) in favour of Session Replay.
- **Attached data**: device and app attributes (app version, device, OS, current view, location, session duration, locale, screen size and density), custom user attributes, tags, feature flags, user data, console logs (iOS 500 statements; Android, RN and Flutter 1,000 statements of ≤ 5,000 chars), Luciq logs (1,000), user steps (max **100** per report), repro steps with screenshots, network logs (100 on iOS/Android, 1,000 on RN/Flutter), user events (1,000), session profiler (60 s). Email is required by default. Extended bug report adds steps to reproduce / actual / expected.
- **Proactive bug reporting**: off by default; triggered only by a **force restart**, shows a feedback modal 2 s after relaunch, at most once per 24 h.
- **Surveys**: Custom (text, multiple choice, stars), NPS, App Rating (default every 30 days), targeting and branching. **Feature requests** with voting and comments. **Replies / in-app chat** on reports, with push notifications.
- **Grouping**: duplicate bug detection and categories.
- Repro-step screenshot capture on Android is paused under "High CPU throughput / High RAM utilization / Low-disk storage", and iOS user steps rely on method swizzling ("we need to do method swizzling").

### 6.3 Correlation

- Crash and bug reports carry repro steps (user steps + screenshots per screen), network logs, Luciq logs, session profiler (last 60 s) and user/feature-flag data; the session replay of the same foreground session carries the same logs plus crash and APM markers on its timeline `[docs only]`. `SessionReplay.sessionReplayLink` returns "Current session Replay Link" for the app to pass to support tools (`LCQSessionReplay.h`) `[binary headers]`; `LCQEvent.occurrenceID` identifies a crash occurrence in the before-send hook `[binary headers]`.
- The sync callback can keep a session because it had a crash or a bug (`fatalCrashCount`, `bugsCount`, `oomCrashCount` in `LCQSessionMetadata.h`) `[binary headers]`.

- Docs `[docs only]`: crash occurrences carry the session profiler (60 s), default attributes (time, app version, device, OS, current view, location, session duration, locale, screen) and repro steps (without screenshots by default for crashes); crashes are attributed to the screen on top at crash time. The session list flags sessions with crashes or OOMs as "crashing" and those with app hangs or force restarts as "frustrating", and the timeline marks each issue so the viewer can jump to it. Crashes can be filtered by Flow (April 2026 changelog). Network occurrences carry the W3C trace ID that links to Grafana / New Relic / Dynatrace / Instana traces (Section 5).

### 6.4 Funnels and journeys `[docs only]`

**Yes, Luciq has funnels**, a 2026 dashboard feature (`/product-guides-and-integrations/product-guides/funnels`; OR-grouped steps and funnel alerts in the August 2026 changelog):

- Steps are custom user events, screen visits ("identified by screen/activity name") or network endpoints, mixed freely; "they work retroactively", computed from already-captured session data with no release.
- Per funnel: users entering, conversion, drop-off, p50 completion time, trends; drop-off sessions split into crashing / frustrating / tolerable / satisfying, and per step "the technical issues that affected users who dropped at that step … alongside session replays of the dropped users".
- Alerts on drop-off rate or volume. The MCP server can "manage APM funnels" (July 2026 changelog).
- **Flows** (APM) are the code-instrumented counterpart: `startFlow` / `endFlow` measure "key user journeys" with completion, drop-off reasons and latency.
- No retention cohorts, paths/journey maps or general event analytics are documented. This is reliability-centred funnel analysis, not a product-analytics suite.

## 7. Performance footprint

### 7.1 Luciq's published numbers `[docs only]` ("SDK Performance & Footprint" page)

| Metric | iOS | Android | Method stated |
|---|---|---|---|
| Extra cold launch | **+54 ms** (iPhone 14 Pro), **+64 ms** (iPhone 12 Pro) | **+38.9 ms** (Samsung S20 FE), **+50 ms** (Pixel 5A) | "additional time during app launch with Luciq integrated"; no tool, run count or percentile given |
| Headline launch claim | "roughly 10–40 milliseconds … around 10 ms" on high-end, "up to ~40 ms" on low-end | same | contradicted by its own table (all four results are 38.9–64 ms) |
| Main-thread time per screenshot | **~56–66 ms** (iPhone 13 Pro Max) | **~2.51 ms avg, 3.2 ms p90** (Samsung A72) | "when Repro Steps or Session Replay are enabled with screenshots"; iOS scales with view-hierarchy complexity |
| Download size | **+5.3 MB** | **+4.4 MB** | iOS: SDK 19.10.1, arm64 slice, app with minus app without. Android: SDK 19.12.0, empty app, unminified, 4 ABIs, all locales: "a ceiling" |
| Install size | **+13.4 MB** | **+11.3 MB** | Android install is "an estimate derived from the uncompressed contents of the APK" |
| RAM | **~7.3 MB** | **~28 MB** | "under typical conditions"; no device or tool named |
| Payloads | bug report 200–300 KB (text says up to ~1 MB in several requests), crash report 100–200 KB, APM metric 3–5 KB | same | "typical"; no measurement described |
| Disk | console logs kept for one launch; network logs kept "until limit reached"; crash traces, attachments, session and APM data transient; user attributes < 1 MB; "low-megabyte range" overall | same | |
| CPU, battery, thread count | **not published** | | |

How they say they keep it low: init on low-priority background threads, heavy work deferred until after first frame, screenshots and logs streamed to disk, leak tests, a CI size gate and a CI launch gate that "blocks any commit that regresses launch by > 10 % on Pixel 6". The page names devices but no tool (no Instruments / Android Profiler / Macrobenchmark mention), no run count, no "idle vs active" definition and no enabled-feature list.

### 7.2 What the artifacts and wrappers say

- The iOS arm64 binary is 12.8 MB uncompressed, consistent with the +13.4 MB install figure; it includes tvOS slices and Core Data models (`InstabugDataModel.momd`, `InstabugUserStepsDataModel.momd`, `InstabugDaignosticsDataModel.momd`, `UserAttributesDataModel.momd`), so persistence is **Core Data / SQLite** `[binary headers]`.
- On Android the default `luciq` dependency ships one native library, `libluciq-native.so` in `luciq-core` (≈ 0.17–0.31 MB per ABI); the optional `luciq-ndk-crash` adds `libluciq-ndk-crash-lib.so` (≈ 0.9–1.5 MB per ABI) `[binary headers]`.
- Derived replay wire cost: ~8–16 KB per WebP frame (Section 4.1), so 1 fps Frequency mode at Normal fills the documented 1 MB in ~100 s. Navigation mode on a typical app (say 20–40 screens per session) is ~200–400 KB per session before logs `[derived from docs]`.
- RN and Flutter add work on top of the native SDK: RN patches XHR in JS and waits 1 s before each screen report; Flutter does user steps, element-tree walks for masking and frame timing in Dart, plus a 100 ms (iOS) / 300 ms (Android) delay and a Pigeon round trip per masked screenshot `[wrapper code]`. None of this is in Luciq's footprint numbers, which are native only.

### 7.3 Other cost controls stated in the docs `[docs only]`

- Android device tiers (Section 4.1) cut replay to navigation mode, the session profiler to ~18 s and logs/repro steps to 30% on low-end devices.
- Repro-step screenshots are skipped on Android under high CPU, high RAM use or low disk.
- Per-report caps: 100 user steps, 500 (iOS) or 1,000 console statements, 1,000 Luciq logs, 100 or 1,000 network logs, 1,000 user events; per session 1–2 MB of screenshots (pages disagree), 2 MB of logs, 50 MB on disk across sessions, 1 MB per request.
- Replay upload at most every 6 hours and never in the background.
- `Luciq.captureScreenshot` is rate-limited to one call per second "as capturing screenshots is a heavy operation" `[binary headers]`.

## 8. Blog-to-code grounding

| Claim | Grounding |
|---|---|
| "Screenshots … with every screen transition" (docs) | Consistent with code: RN and Flutter both report screen changes to native, and the RN comment says that call takes the repro-step screenshot (`src/modules/Luciq.ts:72-79`). The native trigger itself is closed |
| "Masking is applied on-device … painted directly into the bitmap" (docs) | Verified for Flutter only (`PrivateViewManager.java:169-186`, `PrivateViewApi.m:119-132`). Native: closed |
| "Most of the work, including auto-masking, runs off the main thread" on Android (docs) | Not verifiable (obfuscated). Flutter's Android path does the masking on a background executor (`PrivateViewManager.java:31, 152-160`) |
| "100% of sessions" (marketing) | Partly: no sample-rate API exists; the only filter is the app's own `syncCallback`, low-end Android reduction, and plan limits |
| W3C "external trace ID" correlation | Verified in RN, Flutter wrapper code; format above |
| Any OpenTelemetry support | None found in docs, wrappers or binaries |

## 9. Questions asked and answers

| # | Question | Answer (provenance) |
|---|---|---|
| 1 | Is Luciq replay video? | No. Still WebP screenshots on screen change (default), on interactions, or on a ≥ 500 ms timer, played back as a sequence next to logs `[docs only]`; enums `LCQScreenshotCapturingMode` / `LCQScreenshotQualityMode` `[binary headers]` |
| 2 | Is the replay timeline "user steps + screenshots + logs"? | Yes. The session view is a timeline of screenshots with user steps, network logs, Luciq logs, crash and APM events; bug and crash reports carry the same data as "repro steps" grouped by screen `[docs only]` |
| 3 | Do RN apps get JS-rendered screenshots? | No. RN only tells native about screen changes; the native SDK captures the window, so RN views are captured as native views. Private views are set by resolving the React tag to the native view (`LuciqReactBridge.mm:547-555`) `[wrapper code]` |
| 4 | Is Flutter masking done in Dart? | Half. Dart computes the rectangles (element-tree walk, current route only); Java/ObjC plugin code captures the pixels (PixelCopy / `drawViewHierarchyInRect`) and paints black boxes (`PrivateViewManager.java`, `PrivateViewApi.m`) `[wrapper code]` |
| 5 | Does Flutter use `RenderRepaintBoundary.toImage`? | No. `LuciqWidget` adds a `RepaintBoundary` only as a coordinate root for the rectangles; no `toImage` call in `lib/` `[wrapper code]` |
| 6 | Sampling? | No rate. Per-session keep/drop in `syncCallbackWithHandler` on the next launch, plan entitlement, and Android device-tier reduction `[binary headers]` `[docs only]` |
| 7 | When is a replay uploaded? | iOS docs: in batches at most every 6 hours, never in background, so at the start of a later session `[docs only]` |
| 8 | Does Luciq export or ingest OTLP / OpenTelemetry? | No. Nothing in docs, wrappers or AAR class names. Only W3C `traceparent` injection or capture on network logs for backend correlation `[docs only]` `[wrapper code]` `[binary headers]` |
| 9 | How is a crash linked to replay and steps? | Same session: the replay timeline marks crashes, hangs and APM issues; crash reports carry repro steps; `sessionReplayLink` exposes the URL to the app `[docs only]` `[binary headers]` |
| 10 | How do RN JS crashes reach Luciq? | Global `ErrorUtils` handler → `parseErrorStack` → hidden `cp_reportFatalCrashWithStackTrace:` (`LuciqUtils.ts:189-199`, `LuciqCrashReportingBridge.mm:32-43`) `[wrapper code]` |
| 11 | How do Flutter Dart errors reach Luciq? | App code wires `FlutterError.onError` and `runZonedGuarded` to `CrashReporting.reportCrash` (`README.md:65-80`) `[wrapper code]` |
| 12 | Where do Flutter user steps come from? | Dart pointer `Listener` + hit test; native user steps are disabled on Android by reflection (`LuciqApi.java:170-174`) `[wrapper code]` |
| 13 | iOS crash reporter technique? | Mach exception port + signal handler + `NSException` handler, async-safe file writer whose names mirror PLCrashReporter `[binary headers]` (PLCrashReporter lineage is an inference) |
| 14 | What does the Android capture look like? | `instacapture` package (root-view walk) plus `pixelcopy` (`luciq-core/classes.jar`) `[binary headers]`; main-thread ~2.5 ms on Samsung A72 `[docs only]` |
| 15 | Does Luciq have funnels or product analytics? | **Yes, funnels** (2026): retroactive, built from user events, screens and network calls, with drop-off sessions linked to replays and issues, plus funnel alerts. Also code-instrumented Flows. No cohorts or general product analytics (Section 6.4) `[docs only]` |
| 16 | Is anything open source beyond wrappers? | RN and Flutter SDKs (MIT), a PII masking linter, agent skills, CLIs, fastlane plugins, and a HyperDX fork. The native iOS, Android and KMP SDKs, the backend and the replay viewer are closed (GitHub `luciqai` org listing, 2026-10-29; licences read from each repo) |
| 17 | Same capture technique on all platforms? | Native iOS/Android/RN: native capture and masking. Flutter: native capture through a hidden hook, Dart-computed masks, plugin-side painting. Video-like modes: iOS, Android, RN docs; Flutter has no video-like page `[docs only]` `[wrapper code]` |
| 18 | Kept how long? | Session Replay retention **4 weeks** on the July 2026 Enterprise terms, while the same page's standard table says user sessions 365 days (Section 4.5) `[docs only]` |
| 19 | Is there an ANR threshold, slow/frozen frame threshold or watchdog definition in the docs? | No. App hang = 3 s, UI hang = 250 ms, force restart = relaunch within 5 s are stated; ANR, slow and frozen frame thresholds and watchdog terminations are not (Section 3.1b) `[docs only]` |
| 20 | Do the docs say how the footprint numbers were measured? | Only devices and SDK versions. No tools, runs, percentiles, feature set, CPU or battery (Section 7.1) `[docs only]` |

## 10. Takeaways for ouo

Worth copying:

1. **Replay as a screen-by-screen timeline, not only a movie.** Luciq's default is one screenshot per screen transition, with user steps, network, logs, crashes and APM events on one timeline grouped by screen. For mobile this gives most of the debugging value for ~10 KB per screen. ouo's ADR-0006 captures ~1 fps plus on touch; a **navigation-only mode** (capture on screen change plus a cap) is a cheap default worth adding next to the 1 fps mode, especially for low-end devices.
2. **The repro-steps model**: human-readable steps (`Tapped on the button "Send"`, `Moved the slider "Text Size" to 10%`) grouped by screen, each group with its screenshot, attached to every crash and bug. This is the strongest part of the product. In ouo terms: interaction log records (OTel log events with `ouo.` attributes: gesture, view type, label, screen) plus a frame reference, rendered in the player and on the issue page. Include a **content-capture kill switch** like `viewsContentCaptureEnabled` that keeps gesture + view class + screen but drops the label text.
3. **Defer the keep/drop decision to the next launch.** The sync callback gets a summary of the previous session (duration, crash/OOM/bug counts, launch time, network errors) and decides whether to upload its replay. That is client-side tail sampling: buffer to disk, upload only interesting sessions. ouo could offer the same hook, plus default rules ("keep if crashed or had an error").
4. **Device tiers.** Classify once per start (cores, RAM, OS, memory class) and degrade: force navigation-only capture and trim logs on low-end devices, and show the tier on the session ("Low-end, 30% data collected"). Cheap to build, and it makes the overhead story honest.
5. **WebP quality profiles with a fixed per-session byte budget** (High 50, Normal 25, Greyscale 25 + grey; 1 MB per session) is a simple user-facing knob. ouo's JPEG 0.5 at half resolution (20–40 KB) is 2–4× larger per frame than Luciq's ~10 KB Normal WebP; WebP is worth measuring: Android encodes it natively; iOS decodes it natively but we know of no system WebP encoder, so Luciq's iOS SDK presumably bundles one (not verified; HEIC is the native alternative).
6. **Black-box masking burned in on device, private views stronger than type rules**, WebViews masked by default, `FLAG_SECURE` respected on Android. Same as ADR-0006; Luciq confirms the defaults are acceptable to customers.
7. **Flutter pattern**: keep capture and painting native, compute private-view rectangles in Dart by walking the element tree, and filter to the current route. ouo can copy this split for a future Flutter SDK.
8. **Publish a footprint page, but do better than Luciq's**: their page has numbers but no tool, run count, percentile or feature set, and the headline (10–40 ms) contradicts its own table (39–64 ms). ouo should publish the harness (Macrobenchmark / XCTest metrics), devices, runs and p50/p90, and CPU and battery, which Luciq omits.
9. **Retroactive funnels whose drop-offs open replays.** Luciq builds funnels after the fact from data the SDK already captures (screen visits, network endpoints, custom events), splits drop-offs by session health and links each drop-off to its replay. ouo already has screen, network and event telemetry in Loki/Tempo, so funnels over `session.id` (Loki/Tempo queries rendered in the Grafana plugin) would be the same idea without new SDK work.
10. **CI gates on size and launch time** (Luciq: fail if launch regresses > 10% on a Pixel 6). Cheap and worth having from the first native release.

Avoid:

- iOS screenshots cost Luciq 56–66 ms on the main thread per capture (their number). A "single pass over the live view hierarchy" at every interaction would drop frames; ouo's iOS capture should be measured against this and stay well under one frame where possible (Sentry's v2 renderer, Appendix A).
- A home-made `traceparent` with 32 random bits and the request time in the trace ID is not something to copy. ouo already has real OTel trace context; the takeaway is only that **backend correlation through `traceparent` on captured requests** is a feature mobile teams pay for.
- Private, reflection-only cross-platform hooks (`reportScreenChange(Bitmap, …)`, `setCurrentPlatform:`, `InternalCore`) make wrappers fragile. ouo's RN and Flutter layers should call public, versioned native APIs.
- Uploading replay only every 6 hours or at the next launch makes replays late. ouo's model (chunks uploaded during the session) is better for support use; Luciq's choice only makes sense for battery.

Cannot be learned (closed): the native capture code and its threading, the de-duplication (if any), the wire format and endpoints, compression, server-side storage and retention, how the player assembles screenshots and logs, how "frustrating session" scoring works, and the KMP SDK internals.
