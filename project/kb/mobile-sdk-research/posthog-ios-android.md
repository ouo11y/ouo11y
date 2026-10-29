# Appendix D: PostHog on native iOS (posthog-ios) and native Android (posthog-android)

Studied 2026-10-29. Every fact cites `repo/path:line @ shortsha` (the sha is the commit given in section 1). Facts that come only from posthog.com docs are marked `[docs only]`. Sizes marked "measured here" come from scripts run in a scratch directory against the fixtures named.

**Short answer to the central question.** Both native SDKs have two replay modes, and **wireframe is the default on both platforms** (`screenshotMode = false` on iOS, `screenshot = false` on Android). Wireframe mode walks the native view tree and serialises each view as a JSON "wireframe" (position, size, type, text, style, optional base64 bitmap). Screenshot mode renders the window to a bitmap, paints opaque rectangles over the masked views, and sends one `type: "screenshot"` wireframe that holds a base64 WebP image. SwiftUI (iOS) and Jetpack Compose (Android) **only work in screenshot mode**. React Native and Flutter always use screenshot mode `[docs only]`. Both modes produce rrweb-shaped events (`type` 2/3/4/5/6), but the nodes inside them are not DOM nodes. The PostHog web player converts them to rrweb DOM snapshots **in the browser at play time**.

## 1. Sources

| Repo | Tag | Commit (`git rev-parse HEAD`) | Licence |
|---|---|---|---|
| https://github.com/PostHog/posthog-ios | `3.92.7` (2026-10-28) | `2b6b6b4301c14c3b51cb1a7827c954bb17d1b083` | MIT |
| https://github.com/PostHog/posthog-android | `android-v3.73.1` (2026-10-27) | `d91b3bc7a0a4421d5cb0bf8ca848e23f838808cf` | MIT |
| https://github.com/PostHog/posthog (sparse: `common/replay-shared/`, `frontend/src/scenes/session-recordings/{player,mobile-replay}/`, `docs/internal/mobile-replay-capture-mode.md`) | `master` | `ea413ff3bcbf8b3fac139fcdab981a1196709352` | MIT outside `ee/` |

Docs read: https://posthog.com/docs/session-replay/mobile, https://posthog.com/docs/session-replay/ios, https://posthog.com/docs/session-replay/android, https://posthog.com/docs/session-replay/installation.

The transformer no longer lives in `ee/frontend/mobile-replay/`. It moved to the shared package `common/replay-shared/src/mobile/` (`posthog/common/replay-shared/package.json:2 @ea413ff`, name `@posthog/replay-shared`). Its tests and fixtures stayed in `posthog/frontend/src/scenes/session-recordings/mobile-replay/` @ea413ff.

Open-source status: everything in both SDKs is source. posthog-ios vendors two C libraries as source: PLCrashReporter 1.12.2 and libwebp v1.5.0 (`posthog-ios/vendor/UPSTREAM.md:9-11 @2b6b6b4`). posthog-android depends on `com.squareup.curtains` for window hooks (`posthog-android/posthog-android/build.gradle.kts:116 @d91b3bc`), plus OkHttp and Gson in the core module (`posthog-android/posthog/build.gradle.kts:106-111 @d91b3bc`).

## 2. Platforms and languages

| Platform | SDK doing the work | Minimum OS | Replay minimum | Notes |
|---|---|---|---|---|
| iOS (Swift) | posthog-ios | iOS 13 (`posthog-ios/Package.swift:8 @2b6b6b4`, `posthog-ios/PostHog.podspec:19 @2b6b6b4`) | Replay code is `#if os(iOS)` only (`posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:9 @2b6b6b4`); SDK ≥ 3.6.0 `[docs only]` | Also builds for macOS 10.15, tvOS 13, watchOS 6, visionOS 1 with no replay |
| iOS (Objective-C) | posthog-ios | same | same | Public API is `@objc`: `PostHogSDK.shared` (`posthog-ios/PostHog/PostHogSDK.swift:33,150 @2b6b6b4`), every config field (for example `posthog-ios/PostHog/Replay/PostHogSessionReplayConfig.swift:13-51 @2b6b6b4`). Swift-only: SwiftUI modifiers `postHogMask()`, `postHogNoMask()`, `postHogScreenView()`, `postHogLabel()` (`posthog-ios/PostHog/SwiftUI/PostHogMaskViewModifier.swift:44`, `PostHogNoMaskViewModifier.swift:44`, `PostHogSwiftUIViewModifiers.swift:21`, `posthog-ios/PostHog/Autocapture/SwiftUI/View+PostHogLabel.swift:33 @2b6b6b4`) |
| Android (Kotlin) | posthog-android (+ core JVM module `posthog`) | minSdk 23 (`posthog-android/buildSrc/src/main/java/PosthogBuildConfig.kt:39 @d91b3bc`) | API 26: `isSupported()` returns `SDK_INT >= O` (`posthog-android/posthog-android/src/main/java/com/posthog/android/replay/PostHogReplayIntegration.kt:2509-2511 @d91b3bc`) | Compose masking via `Modifier.postHogMask()` / `postHogUnmask()` (`posthog-android/posthog-android/src/main/java/com/posthog/android/replay/PostHogMaskModifier.kt:25,46 @d91b3bc`) |
| Android (Java) | same | same | same | Config uses `@JvmOverloads` constructors (`.../replay/PostHogSessionReplayConfig.kt:12 @d91b3bc`) and `@JvmStatic` factories (`posthog-android/posthog/src/main/java/com/posthog/internal/EndpointSpec.kt:61 @d91b3bc`) |
| React Native, Flutter | their own JS / Dart SDKs (Appendix E) | n/a | n/a | The native iOS integration checks `postHogSdkName != "posthog-flutter"` and skips its own layout-driven capture for Flutter (`posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:169-172,324-331 @2b6b6b4`). Android equivalent: `isNativeSdk` gates the draw-driven capture (`.../replay/PostHogReplayIntegration.kt:205,347 @d91b3bc`). The iOS masker knows RN classes `RCTTextView`, `RCTParagraphComponentView`, `RCTImageComponentView`, `RNSVGSvgView` (`posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:147-158 @2b6b6b4`) |

## 3. RUM

PostHog mobile is a product-analytics SDK with replay and error tracking. It is **not** a performance-monitoring SDK. Every signal is a PostHog event (`capture(...)`) sent to `/batch`, apart from snapshots (`/s/`) and logs (`/i/v1/logs`).

| Signal | iOS | Android |
|---|---|---|
| Sessions | `$session_id` (UUIDv7), rotated after 30 min of inactivity or 24 h total (`posthog-ios/PostHog/PostHogSessionManager.swift:67,69,127-134 @2b6b6b4`) | Same thresholds (`posthog-android/posthog/src/main/java/com/posthog/internal/PostHogSessionManager.kt:121-131 @d91b3bc`) |
| Screen views `$screen` | Swizzles `UIViewController.viewDidAppear` (`posthog-ios/PostHog/ScreenViews/ApplicationScreenViewPublisher.swift:67-73 @2b6b6b4`); `captureScreenViews = true` by default (`posthog-ios/PostHog/PostHogConfig.swift:164 @2b6b6b4`); SwiftUI needs `.postHogScreenView()` | `ActivityLifecycleCallbacks` calls `postHog.screen(screenName)` (`posthog-android/posthog-android/src/main/java/com/posthog/android/internal/PostHogActivityLifecycleCallbackIntegration.kt:199 @d91b3bc`); default on (`.../android/PostHogAndroidConfig.kt:52 @d91b3bc`) |
| App lifecycle | `Application Installed/Updated/Opened/Backgrounded` (`posthog-ios/PostHog/AppLifeCycle/PostHogAppLifeCycleIntegration.swift:139,203,221 @2b6b6b4`); default on (`PostHogConfig.swift:147`) | `Application Opened/Backgrounded` from `ProcessLifecycleOwner` (`.../android/internal/PostHogLifecycleObserverIntegration.kt:79,118 @d91b3bc`); install/update in `PostHogAppInstallIntegration.kt` |
| Element autocapture `$autocapture` | Swizzles `UIApplication.sendAction` and gesture paths (`posthog-ios/PostHog/Autocapture/PostHogAutocaptureEventTracker.swift:89-92,143 @2b6b6b4`); off by default (`PostHogConfig.swift:241`) | Curtains window hooks (`.../android/internal/PostHogElementInteractionIntegration.kt:107-108 @d91b3bc`); `captureElementInteractions`, `captureRageClicks`, `captureDeadClicks` all default false (`.../android/PostHogAndroidConfig.kt:84,89,96 @d91b3bc`) |
| Errors `$exception` | Handled exceptions via `captureException`; crashes via **vendored PLCrashReporter**, Mach handlers (BSD on tvOS), no local symbolication, report sent next launch (`posthog-ios/PostHog/ErrorTracking/PostHogErrorTrackingAutoCaptureIntegration.swift:142-155 @2b6b6b4`); `autoCapture` default false (`posthog-ios/PostHog/ErrorTracking/PostHogErrorTrackingConfig.swift:29-38 @2b6b6b4`) | JVM `Thread.UncaughtExceptionHandler` (`posthog-android/posthog/src/main/java/com/posthog/internal/errortracking/UncaughtExceptionHandlerAdapter.kt`); **NDK crashes** read on next start from `ApplicationExitInfo.REASON_CRASH_NATIVE` tombstones, with `$debug_images` for server symbolication (`.../android/errortracking/PostHogNativeCrashIntegration.kt:31-40,270 @d91b3bc`); `autoCapture` default false (`posthog-android/posthog/src/main/java/com/posthog/errortracking/PostHogErrorTrackingConfig.kt:22 @d91b3bc`) |
| ANR / hangs | None found (grep for `REASON_ANR`, `hang`, `watchdog` found nothing in either SDK's sources) | None (same grep) |
| App start, frames, screen-load time | Not captured | Not captured |
| Network | Only as replay plugin events `rrweb/network@1` (URL, method, status, duration, size; no bodies) via `URLSession` swizzling (`posthog-ios/PostHog/Replay/Plugins/Network/PostHogSessionReplayNetworkPlugin.swift:204-207`, `URLSessionInterceptor.swift:109-125 @2b6b6b4`) | Only when the app adds `PostHogOkHttpInterceptor` (`posthog-android/posthog/src/main/java/com/posthog/PostHogOkHttpInterceptor.kt:20-25,85-103 @d91b3bc`) |
| Backend correlation | `tracingHeaders` host list adds `X-POSTHOG-SESSION-ID` and `X-POSTHOG-DISTINCT-ID` to first-party requests (`posthog-ios/PostHog/Tracing/PostHogTracingHeadersIntegration.swift:4-29 @2b6b6b4`, `PostHogConfig.swift:450`). **Not** W3C `traceparent` | Same headers from the OkHttp interceptor (`PostHogOkHttpInterceptor.kt:109-110 @d91b3bc`) |
| Custom spans / traces | None. There is no span API | None |
| Console logs into replay | `captureLogs` (stdout, stderr, OSLog, NSLog) default false (`posthog-ios/PostHog/Replay/PostHogSessionReplayConfig.swift:95 @2b6b6b4`) | `captureLogcat` default **true** (`.../replay/PostHogSessionReplayConfig.kt:28 @d91b3bc`) |

Also present but outside RUM: feature flags (`/flags`, `posthog-ios/PostHog/PostHogApi.swift:342 @2b6b6b4`), remote config (`/array/<token>/config`, `PostHogApi.swift:169`), surveys, push subscriptions, `personProfiles = identifiedOnly` by default (`PostHogConfig.swift:363`, `posthog-android/posthog/src/main/java/com/posthog/PostHogConfig.kt:217 @d91b3bc`).

## 4. Session replay

### 4.1 Configuration (defaults)

| Knob | iOS (`PostHogSessionReplayConfig.swift @2b6b6b4`) | Android (`PostHogSessionReplayConfig.kt @d91b3bc`) |
|---|---|---|
| Master switch | `config.sessionReplay = false` (`PostHogConfig.swift:458`) | `sessionReplay = false` (`posthog/.../PostHogConfig.kt:175`) |
| Mode | `screenshotMode = false` → wireframe (:51) | `screenshot = false` → wireframe (:40) |
| Cadence | `throttleDelay = 1` s (:79); `debouncerDelay` deprecated alias (:67-71) | `throttleDelayMs = 1000` (:56); `debouncerDelayMs` deprecated, "was 500ms by default until version 3.8.2" (:41-49) |
| Text | `maskAllTextInputs = true` (:16) | `maskAllTextInputs = true` (:18) |
| Images | `maskAllImages = true` (:20) | `maskAllImages = true` (:23) |
| System views | `maskAllSandboxedViews = true` (`_UIRemoteView`, pickers) (:25) | n/a |
| Photo library | `maskPhotoLibraryImages` deprecated, "has no effect" (:27-34) | n/a |
| Touches | `captureTouches = true` (:39) | `captureTouches = true` (:71) |
| Network | `captureNetworkTelemetry = true` (:45) | interceptor argument `captureNetworkTelemetry = true` |
| Screenshot quality | hard-coded `compressionQuality = 0.3` (`posthog-ios/PostHog/Replay/UIImage+Util.swift:13 @2b6b6b4`) | `screenshotCompressionQuality = 30` (:92), experimental |
| Screenshot scale | hard-coded 1 pixel per point (`RRWireframe.swift:64-69`) | `screenshotScale = 1.0`, clamp 0.1..1 (:106) |
| Pixel format | n/a | `screenshotColorMode = ARGB_8888`, or `RGB_565` (:120) |
| Off-main render | `screenshotModeBackgroundCapture = false`, experimental (:61) | capture work already runs on an executor thread |
| Local sampling | `sampleRate: NSNumber?` (:112) | `sampleRate: Double?` (:63) |

Remote config (`sessionRecording` object): `endpoint` overrides `snapshotEndpoint`, `sampleRate`, `minimumDurationMilliseconds`, `linkedFlag` (string or `{flag, variant}`), event triggers, and a quota-limited flag (`posthog-ios/PostHog/PostHogRemoteConfig.swift:324-345,353-390 @2b6b6b4`). Sampling is deterministic on the session id (`posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:460-469 @2b6b6b4`). Until the first live `/config` resolves, and until the minimum duration passes, snapshots go to a disk **buffer queue** rather than the send queue (`PostHogReplayIntegration.swift:60-73`, `posthog-ios/PostHog/Replay/PostHogReplayBufferQueue.swift @2b6b6b4`).

### 4.2 iOS capture flow

1. **Trigger.** posthog-ios swizzles `UIView.layoutSublayers(of:)` for all views (`posthog-ios/PostHog/ApplicationViewLayoutPublisher.swift:65 @2b6b6b4`). Each layout pass fires `onViewLayout`, which is throttled with a trailing call at `throttleDelay` (`PostHogReplayIntegration.swift:325-331`). No timer runs. If nothing lays out, nothing is captured.
2. **Touches.** posthog-ios swizzles `UIApplication.sendEvent` (`posthog-ios/PostHog/Replay/ApplicationEventPublisher.swift:33-40 @2b6b6b4`). Only `.began` and `.ended` are kept, as rrweb `MouseInteraction` `TouchStart = 7` and `TouchEnd = 9` (`PostHogReplayIntegration.swift:731-738`). Each touch batch becomes its own `$snapshot` event with `type: 3` (`:749-763`).
3. **Snapshot tick** (`snapshot()`, `PostHogReplayIntegration.swift:1690-1729`):
   - In wireframe mode, if the root controller is a SwiftUI hosting controller, the tick **returns without capturing**: `hedgeLog("SwiftUI snapshot not supported, enable screenshotMode.")` (`:1701-1705`).
   - In wireframe mode the walk stays on the main thread (`:1727-1728`).
   - In screenshot mode the tick either schedules a "settled" capture (default) or a bracketed off-main capture (`:1712-1724`).
4. **Wireframe walk** (`toWireframe`, `:1439-1574`). Each visible view becomes an `RRWireframe` with absolute window coordinates and `id = view.hash` (`:901-916`). The type mapping is in the table below. `RRStyle` carries `color`, `backgroundColor`, `backgroundImage`, `borderWidth`, `borderRadius`, `borderColor`, `fontSize`, `fontFamily`, alignment, padding and `bar` (`posthog-ios/PostHog/Replay/RRStyle.swift:11-25 @2b6b6b4`). Masked text is replaced with `*` repeated to the same length (`posthog-ios/PostHog/Replay/String+Util.swift:11-13 @2b6b6b4`). An unmasked `UIImageView` image is base64-encoded into the wireframe (`RRWireframe.swift:120-121`). The code marks `UITabBar`, `UINavigationBar`, `UISlider`, `UIStepper` and `UIDatePicker` as TODO (`:1552-1553`).

| UIKit class | `type` / `inputType` | Source line |
|---|---|---|
| `UITextView` | `text` | :1448 |
| `UITextField` | `input` / `text_area` (value or placeholder) | :1461 |
| `UIPickerView` | `input` / `select` (no value yet) | :1481 |
| `UISwitch` | `input` / `toggle`, `checked` | :1487 |
| `UIImageView` | `image` (+ `base64` if not masked) | :1498 |
| `UIButton` | `input` / `button`, `value` = title | :1507 |
| `UILabel` | `text` | :1519 |
| `WKWebView` | `web_view` (placeholder) | :1533 |
| `UIProgressView` | `input` / `progress`, `bar: horizontal` | :1537 |
| `UIActivityIndicatorView` | `input` / `progress`, `bar: circular` | :1546 |
| anything else | no type → `div` on the player | :1555-1571 |

5. **Screenshot capture.** First the masker walks the view tree and collects `MaskedRegion`s (`findMaskableWidgets`, `:943-1114`) plus the live rects of `postHogMask()` reporters (`:1198-1223`). If a reporter has not laid out yet, the frame is skipped ("fail closed") (`:1177-1184`). Frames are also skipped while a view controller transition animates or a camera is on screen (`:1173`).
   - **Rendering.** The window is rendered at the native screen scale on the main thread, with `drawHierarchy(in:afterScreenUpdates:false)` by default. During motion it falls back to `layer.presentation().render(in:)` (`posthog-ios/PostHog/Replay/UIView+Util.swift:113-153 @2b6b6b4`).
   - **Settle check.** The default path samples mask geometry, waits `settleWindowSeconds = 0.025` s, samples again, and picks a renderer according to how far the masks drifted (`PostHogReplayIntegration.swift:1664-1688`, `posthog-ios/PostHog/Replay/PostHogMaskSettleAnalysis.swift:41 @2b6b6b4`).
   - **Encoding.** Off the main thread, the image is redrawn at **1 pixel per point** and the masks are filled black (`posthog-ios/PostHog/Replay/RRWireframe.swift:64-79 @2b6b6b4`). It is then encoded as **WebP q0.3 through the vendored libwebp, falling back to JPEG q0.3**, into a `data:image/webp;base64,…` URL (`posthog-ios/PostHog/Replay/UIImage+Util.swift:13-29 @2b6b6b4`).
   - **Failure.** If the masked render fails, the frame is dropped and the raw image is never sent (`RRWireframe.swift:108-116`, `PostHogReplayIntegration.swift:825-828`).
6. **Masking switches.** `ph-no-capture` in `accessibilityIdentifier` or `accessibilityLabel` forces masking (`posthog-ios/PostHog/Replay/UIView+Util.swift:72-73 @2b6b6b4`). `ph-no-mask` or `.postHogNoMask()` unmasks and wins over everything (`UIView+Util.swift:80-81`, `PostHogReplayIntegration.swift:944-948`). Asset-catalog images and SF Symbols are never masked (`:1361-1365,1434-1436`). `WKWebView` is masked whole when text or image masking is on (`:1021-1028`). On iOS 26, SwiftUI primitives become `CALayer`s with no backing view, so the masker also walks sublayers (`:1085-1096,1133-1169`).
7. **Emit.** Each tick produces one `$snapshot` event. Its data holds a `type: 4` Meta event (width, height, `href` = view controller name) only on the first frame or after a size change, then **always a `type: 2` full snapshot** whose `wireframes` array holds the whole tree (`PostHogReplayIntegration.swift:833-874`). **iOS never sends incremental mutations.** The only de-duplication is that screenshot frames whose base64 `hashValue` equals the previous one are skipped (`:849-857,878-881`). Wireframe frames are never de-duplicated.
8. **Background.** On `didEnterBackground` plugins pause and resume on `didBecomeActive` (`:360-369`). Snapshot capture stops implicitly because no layout happens.

### 4.3 Android capture flow

1. **Window discovery.** Curtains' `onRootViewsChangedListeners` catches every root view, including dialogs and popups (`posthog-android/posthog-android/src/main/java/com/posthog/android/replay/PostHogReplayIntegration.kt:586-594 @d91b3bc`). On each decor view the SDK installs:
   - a `ViewTreeObserver.OnDrawListener` wrapped in a `Throttler` (`.../replay/PostHogReplayIntegration.kt:341-361`, `.../replay/internal/NextDrawListener.kt:20-25 @d91b3bc`);
   - an `OnGlobalLayoutListener` that records layout state (`:363-365`);
   - a touch interceptor on the window callback (`:374`).
2. **Throttling.** The first draw after the delay runs at once. Later draws schedule one `postDelayed`, and a draw that lands inside the window re-arms one more capture, so the final state is never lost (`.../replay/internal/Throttler.kt:25-54 @d91b3bc`). Captures run on a single-thread executor named `PostHogReplayThread` (`:150-151`), and a capture still in flight drops new ones (`:393-414`).
3. **Wireframe walk** (`View.toWireframe`, `:1988-2286`). It runs **on the executor thread**, reading `View` state off the main thread, with only a guard that view state is stable for matrix maths (`:2001-2008`). Mapping:

| Android class | Wireframe | Line |
|---|---|---|
| `statusBarBackground` / `navigationBarBackground` ids | `status_bar` / `navigation_bar` | :2015-2020 |
| background `Drawable` | `style.backgroundColor` or `style.backgroundImage` (WebP base64) | :2023-2030, 2337-2384 |
| `TextView` (incl. `Button`) | `text` (masked to `*`; hint if empty) | :2038-2062 |
| `CheckBox`, `RadioButton`, `Switch` | `input` `checkbox` / `radio` / `toggle` + `checked` | :2149, 2159, 2243 |
| `EditText` | `input` `text_area` | :2167 |
| `Spinner` | `input` `select` + `options` | :2174 |
| `ImageView` | `image` + base64 unless masked | :2206 |
| `ProgressBar` | `input` `progress` (bar/circular, `max`) | :2221 |
| `WebView` | `web_view` | :2252 |

   Coordinates are converted from pixels to dp (`densityValue(screenDensity)`, `:2009-2012`). `id = System.identityHashCode(view)` (`:1999`).
4. **Jetpack Compose.** `toWireframe` has no Compose branch, so an `AndroidComposeView` becomes one opaque `div` in wireframe mode. Compose is only read through `SemanticsOwner.getAllSemanticsNodes`, and only to compute **mask rects** for screenshots: text, editable text and password nodes are masked when `maskAllTextInputs` is on, images with `contentDescription` when `maskAllImages` is on, and `postHogMask` / `postHogUnmask` semantics keys override both (`:1289-1366`, `.../replay/PostHogMaskModifier.kt:13-14 @d91b3bc`). The docs agree: "Jetpack Compose is only supported if `screenshot` is enabled" `[docs only]`.
5. **Screenshot mode** (`toScreenshotWireframe`, `:1776-1978`):
   - Geometry is read on main through `runOnMainThreadBlocking`, which has a 1 s timeout (`:1242-1287`).
   - Then `PixelCopy.request(window, …)` copies into a pooled bitmap at `screenshotScale` and `screenshotColorMode` (`:1805-1811,1863`). The executor waits up to 1000 ms for it (`:1919`).
   - Masks are painted onto the bitmap (`paintScreenshotMasks`, `:1615`), which is then encoded as lossy **WebP, quality 30** (`:1937`, `posthog-android/posthog-android/src/main/java/com/posthog/android/internal/PostHogAndroidUtils.kt:206-236 @d91b3bc`).
   - A capture that fails or races is dropped, never sent half-masked (`:1956-1966`).
   - With `verifyScreenshotMaskAlignment`, which is always on for Compose roots, the mask walk is repeated on every draw while a capture is armed. A frame whose mask geometry moved is discarded (`:259-290,1395-1417`).
6. **Masking switches.** `ph-no-capture` in the view `tag` (String) or `contentDescription` masks a view and its subtree; `ph-no-mask` unmasks (`:2490-2498,3097`). `WebView` is masked whole if either masking switch is on (`:1157-1161`).
7. **Diffing (Android only).** The first frame for a window emits Meta (`type 4`, `href` = window title, `width` and `height` in dp) and a `type 2` full snapshot. **Every later frame is diffed** against `status.lastSnapshot`: both trees are flattened, nodes are matched by `id`, and the SDK emits a `type 3` incremental event (`source 0`, mutation) with `adds`, `removes` and `updates`. An update carries the whole node without its children, and any field change counts as an update (`:836-924,2400-2452`). Nothing is emitted when nothing changed. Screenshot mode goes through the same diff: the single `screenshot` node keeps the decor view id, so each new image arrives as an `updates` entry holding the full new base64, and an identical image produces no event.
8. **Keyboard.** IME visibility is read from `WindowInsetsCompat` and emitted as a `type 5` custom event `{tag: "keyboard", payload: {open, height}}` (`:421-448,915-920`). iOS has no equivalent (`keyboard` does not appear in `PostHogReplayIntegration.swift`).
9. **Touches.** Only `ACTION_DOWN` and `ACTION_UP` are kept, as `TouchStart` / `TouchEnd` with the pointer id, in dp, one `$snapshot` event per batch (`:450-526`).

### 4.4 Wire format

```json
{"event":"$snapshot","properties":{
  "$snapshot_source":"mobile","$session_id":"<uuidv7>","$window_id":"<same uuid>",
  "$snapshot_data":[
    {"type":4,"timestamp":1700000000123,"data":{"href":"MainActivity","width":411,"height":914}},
    {"type":2,"timestamp":1700000000123,"data":{"initialOffset":{"top":0,"left":0},
      "wireframes":[{"id":1,"x":0,"y":0,"width":411,"height":914,"type":"screenshot",
                     "base64":"data:image/webp;base64,UklGR…","style":{}}]}}]}}
```
Assembled from `.../replay/PostHogReplayIntegration.kt:821-830,850-868 @d91b3bc`. iOS adds `$window_id = $session_id` to events while replay is active (`posthog-ios/PostHog/PostHogSDK.swift:766-770 @2b6b6b4`). Event types follow the rrweb enum: 2 Full, 3 Incremental, 4 Meta, 5 Custom, 6 Plugin (`posthog-android/posthog/src/main/java/com/posthog/internal/replay/RREventType.kt:6-13 @d91b3bc`). The JSON schema of the mobile dialect is `posthog/frontend/src/scenes/session-recordings/mobile-replay/schema/mobile/rr-mobile-schema.json @ea413ff`.

### 4.5 Reconstruction and player (posthog repo)

- **Where:** in the browser, at play time. `sessionRecordingDataCoordinatorLogic` calls `processAllSnapshots` (`posthog/frontend/src/scenes/session-recordings/player/sessionRecordingDataCoordinatorLogic.ts:765 @ea413ff`), which runs each event through `transformEventToWeb` (`posthog/common/replay-shared/src/snapshot-processing/process-all-snapshots.ts:435-438 @ea413ff`). Ingest stores mobile events as they arrived. The ingest side only classifies the recording as `screenshot` or `wireframe` from the first visual wireframe, for analytics (`posthog/docs/internal/mobile-replay-capture-mode.md:10-21 @ea413ff`).
- **Dispatch:** event types 2, 3, 4 and 5 map to `makeFullEvent`, `makeIncrementalEvent`, `makeMetaEvent` and `makeCustomEvent`. On error the original event is returned so playback never breaks (`posthog/common/replay-shared/src/mobile/index.ts:11-33 @ea413ff`).
- **Full snapshot:** the id sequence restarts. Status and navigation bars are split out, and the rest becomes a synthetic `html > head(style reset) > body` document with fixed ids 1-5 (`posthog/common/replay-shared/src/mobile/transformer/transformers.ts:86-92,1246-1330 @ea413ff`). Each wireframe becomes a `position: fixed` element with inline CSS (`posthog/common/replay-shared/src/mobile/transformer/wireframeStyle.ts:91-96 @ea413ff`):
  - `div` / rectangle → `<div>` (`transformers.ts:187-206`);
  - `text` → `<div>` wrapping a text node (`:208-245`);
  - `image` and `screenshot` → `<img src=data-uri>`, and screenshots also get the attribute `data-posthog-screenshot` (`:95,260-287,899`);
  - `web_view` → a labelled placeholder (`:247-258`);
  - inputs → `<input>`, `<select>`, `<progress>`, toggles (`:289-850`).
- **Incremental:** `adds` → rrweb `addedNodeMutation`. Each `update` becomes a remove plus an add, de-duplicated (`:1085-1142`). Screenshot nodes are always re-parented to `<body>` (`:951-953`). Android keyboard events become add/remove of a keyboard placeholder node (`:100-145`).
- **Player fallback:** if playback starts on an incremental event that carries a screenshot `<img>`, the player synthesises a minimal full snapshot around it (`process-all-snapshots.ts:40-108`).
- **Player:** the standard rrweb replayer on the converted DOM events, through `posthog-js/rrweb-types` (`posthog/common/replay-shared/src/mobile/index.ts:1 @ea413ff`).

## 5. Transport and OpenTelemetry

| Item | iOS | Android |
|---|---|---|
| Analytics endpoint | `POST {host}/batch` | `POST {host}/batch` (`posthog-android/posthog/src/main/java/com/posthog/internal/PostHogApi.kt:74-77 @d91b3bc`) |
| Snapshot endpoint | `POST {host}/s/`, overridable by remote `sessionRecording.endpoint` (`posthog-ios/PostHog/PostHogConfig.swift:430`, `PostHogApi.swift:203-204 @2b6b6b4`) | `/s/`, body is a bare JSON array of events, no `sent_at` (`PostHogApi.kt:91-106`, `posthog-android/posthog/src/main/java/com/posthog/PostHogConfig.kt:511 @d91b3bc`) |
| Logs endpoint | `POST /i/v1/logs?token=…`, **OTLP/JSON** (`posthog-ios/PostHog/PostHogApi.swift:227-235 @2b6b6b4`) | same (`PostHogApi.kt:108-116 @d91b3bc`) |
| Compression | gzip with `Content-Encoding: gzip` on `/batch`, `/s/` and logs (`posthog-ios/PostHog/PostHogApi.swift:99-105`, `PostHogConfig.swift:518 @2b6b6b4`) | OkHttp `GzipRequestInterceptor` (`posthog-android/posthog/src/main/java/com/posthog/internal/GzipRequestInterceptor.kt:44-59 @d91b3bc`); `compression = GZIP` (`PostHogConfig.kt:434`) |
| Queues | Separate disk-backed queues for events, replay and logs; `$snapshot` goes to `replayQueue` (`posthog-ios/PostHog/PostHogSDK.swift:1691-1693 @2b6b6b4`) | Generic `PostHogQueue<Record>`, one instance per `EndpointSpec`, **one file per event** `<uuid>.event` (`posthog-android/posthog/src/main/java/com/posthog/internal/PostHogQueue.kt:69 @d91b3bc`); replay queue built at `posthog-android/posthog/src/main/java/com/posthog/PostHog.kt:236-243 @d91b3bc` |
| Batching | `flushAt 20`, `maxQueueSize 1000` (tvOS 5 and 100), `maxBatchSize 50`, `flushIntervalSeconds 30`, `maxRetries 3` (`posthog-ios/PostHog/PostHogConfig.swift:25-37 @2b6b6b4`) | `flushAt 20`, `maxBatchSize 50`, `maxQueueSize 1000`, `flushIntervalSeconds 30` (`PostHogConfig.kt:621-630`); snapshots are batched only while `distinct_id` and `$session_id` match (`EndpointSpec.kt:82-85`) |
| Retries | Retry-After honoured for logs (`posthog-ios/PostHog/QueueEndpoint+Factories.swift:15,73 @2b6b6b4`) | Back-off counter plus `Retry-After` (`PostHogQueue.kt:202-215`) |

**OpenTelemetry: no traces, no metrics, and replay and analytics events are not OTLP.** The single OTel touch point is the **logs API**: `captureLog(...)` builds `resourceLogs[].scopeLogs[].logRecords[]` with `service.name`, `service.version` and `telemetry.sdk.*` resource attributes. Each record carries `sessionId`, `posthogDistinctId`, `screen.name`, `app.state` and `feature_flags` attributes, plus optional caller-supplied `traceId`/`spanId` (`posthog-ios/PostHog/Logs/PostHogLogsOTLP.swift:107-123,144-178 @2b6b6b4`, `posthog-ios/PostHog/PostHogSDK.swift:1438-1497 @2b6b6b4`; Android `posthog-android/posthog/src/main/java/com/posthog/internal/logs/PostHogLogsOTLP.kt @d91b3bc`). The SDK uses no OTel library and has no OTLP exporter for anything else. Backend correlation uses custom `X-POSTHOG-*` headers, not `traceparent` (section 3).

## 6. Other features

- **Replay next to analytics and errors.** `$snapshot` events carry the same `$session_id` as every analytics event and every `$exception` (`posthog-ios/PostHog/PostHogSDK.swift:762-770 @2b6b6b4`, `.../replay/PostHogReplayIntegration.kt:775,827 @d91b3bc`). The product joins on that id to show replays from funnels, paths and issues `[docs only]`. Log records also carry `sessionId` (section 5).
- **Event triggers and linked flags** start recording only after a named event or flag (`posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:234-252,1731-1805 @2b6b6b4`; Android `.../replay/PostHogReplayIntegration.kt:2670-2790 @d91b3bc`).
- **Minimum duration:** short sessions are buffered on disk and dropped if they never reach `minimumDurationMilliseconds` (`posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:636-659 @2b6b6b4`).
- **Rage and dead clicks:** Android options off by default (`.../android/PostHogAndroidConfig.kt:89,96 @d91b3bc`); iOS `PostHogRageClickIntegration.swift`.
- Feature flags, surveys (native UI), person profiles, groups, push subscriptions. **No in-app bug reporting or profiling.**

## 7. Performance footprint

**Vendor claims.** None quantified. The docs say only that lower throttle values cost "more capture work on the device", that the iOS background-capture option "reduces jank on high refresh rate (120Hz ProMotion) displays" but "may … briefly freeze the app on the first capture", and that Android's scale 0.5 and RGB_565 settings "reduce capture time and memory use" `[docs only]`.

**Benchmark code.** The only benchmark is Android's manual mask-walk benchmark. It is gated by `POSTHOG_BENCHMARK=1`, is "Not a CI test", and runs on Robolectric/JVM, so absolute times "differ from ART on a device" (`posthog-android/posthog-android/src/test/java/com/posthog/android/replay/PostHogReplayMaskWalkBenchmark.kt:5-14 @d91b3bc`). No CI perf workflow exists (`.github/workflows` in both repos: build, test, lint, release, compliance only). posthog-ios has no benchmarks.

**Reading of the code:**
- **iOS wireframe mode runs entirely on the main thread**: a recursive walk over every visible view, string building, and base64 encoding of every unmasked `UIImageView` image (`PostHogReplayIntegration.swift:1727-1728`, `RRWireframe.swift:120-121`), once per throttle window after any layout. The cost scales with the number of views. The output is a **full tree every second**, because iOS does not diff.
- **iOS screenshot mode** does two main-thread hierarchy walks 25 ms apart (the settle check) plus a `drawHierarchy` at native scale (3× on Pro iPhones: 1206×2622 px, about 12.6 MB RGBA) on main. The downscale, masking and WebP encoding happen on a utility queue (`PostHogReplayIntegration.swift:166-167,1664-1688`, `RRWireframe.swift:64-69`). The experimental flag moves `drawHierarchy` off main because "drawHierarchy on main was too slow to keep up" (`PostHogReplayIntegration.swift:1629-1633`).
- **Android** moves the walk and encoding to `PostHogReplayThread`. The main thread pays the throttled `OnDrawListener`, geometry hops, Compose semantics reads and, with verification on, a mask walk on **every draw** while a capture is armed (`.../replay/PostHogReplayIntegration.kt:259-290`). `PixelCopy` bitmaps are pooled (`PixelCopyBitmapBuffer`, `:160`).
- **The main knob is `throttleDelay` / `throttleDelayMs`** (1 s by default). Overlapping captures are dropped, not queued, on both platforms (`posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:439-455 @2b6b6b4`, `.../replay/PostHogReplayIntegration.kt:393-399 @d91b3bc`).

**Wire size (measured here):**

| Payload | Raw JSON | gzip -6 | Method |
|---|---|---|---|
| Real Android incremental fixture (11 wireframes, one with a background bitmap) | 4,798 B | 1,151 B | `posthog/frontend/src/scenes/session-recordings/mobile-replay/__mocks__/increment-with-child-duplication.json @ea413ff`, re-serialised compact |
| Single wireframe, real fixture | median 295 B (text with full style), 32-82 B (bare div), 2,188 B (with `backgroundImage`) | n/a | same fixture |
| Synthetic 50-view screen (20 text, 25 styled divs, 5 masked images, no bitmaps) | 10.1 KB | 1.6 KB | fields copied from the fixture |
| iOS: 20 such full snapshots in one `/s/` request (flushAt 20), 3 nodes moved per frame | 207 KB | **3.9 KB** | synthetic; gzip removes the repetition across the batch |
| Android: incremental event with 3 updated nodes | 897 B | 379 B | synthetic |
| Screenshot at 1 pt/px (402×874, iPhone 18 Pro simulator), JPEG q30 via macOS ImageIO | 27 KB binary, 36 KB base64 | ~27.5 KB (base64 of JPEG compresses back to about binary size) | `sips`; WebP q30 could not be encoded locally, and WebP is usually smaller than JPEG at the same nominal quality (estimate) |

Per minute at the 1 s default while the screen changes:

| Mode | iOS | Android |
|---|---|---|
| Wireframe | ≈ 60 full trees ≈ 600 KB raw, ≈ 12 KB gzipped thanks to cross-snapshot redundancy | Small incrementals, a few KB/min gzipped |
| Screenshot | Up to 60 × ~20-27 KB ≈ 1.2-1.6 MB/min (estimate), near zero when the screen is static (hash dedupe) | Same order, minus Android's `screenshotScale` and quality knobs |

That is the same order as ADR-0006's estimate of 20-40 KB per frame. Unmasked image views in wireframe mode embed WebP/JPEG base64 bitmaps on every iOS frame (no diff), so a feed of photos with `maskAllImages = false` costs about as much as screenshot mode.

## 8. Blog-to-code grounding

| Docs claim | Code |
|---|---|
| "SwiftUI is only supported if the `screenshotMode` option is enabled" | `PostHogReplayIntegration.swift:1701-1705 @2b6b6b4` returns early for `AnyObjectUIHostingViewController` when not in screenshot mode. The comment block at `:75-128` explains why: SwiftUI draws text in `CGDrawingView` / `CGDrawingLayer` with no readable string |
| "Jetpack Compose is only supported if `screenshot` is enabled" | `toWireframe` has no Compose branch (`.../replay/PostHogReplayIntegration.kt:1988-2286 @d91b3bc`); Compose is read only by `findMaskableComposeWidgets` for screenshot masks (`:1289-1366`) |
| "Requires Android API 26 or higher" | `isSupported()` checks `SDK_INT >= O` (`:2509-2511`) |
| `throttleDelay` defaults to 1 s, formerly `debouncerDelay` | `PostHogSessionReplayConfig.swift:67-79 @2b6b6b4`; `.../replay/PostHogSessionReplayConfig.kt:48-56 @d91b3bc` |
| Network telemetry records only metrics, not bodies | Payload fields name, method, status, duration, sizes (`posthog-android/posthog/src/main/java/com/posthog/PostHogOkHttpInterceptor.kt:85-100 @d91b3bc`, `posthog-ios/PostHog/Replay/Plugins/Network/URLSessionExtension.swift:263-281 @2b6b6b4`) |
| Password inputs are always masked | `isSensitiveText()` on `UITextField` / `UITextView` (`posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:1383-1398 @2b6b6b4`); Compose `Password` semantics (`.../replay/PostHogReplayIntegration.kt:1310,1333 @d91b3bc`) and `UITextInputTraits.isSensitiveText()` (`posthog-ios/PostHog/Replay/UITextInputTraits+Util.swift:24 @2b6b6b4`) |
| RN and Flutter are always screenshot | Native layers defer to the wrapper SDKs (`posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:169-172 @2b6b6b4`; Android `isScreenshotCapable = screenshot || !isNativeSdk`, `.../replay/PostHogReplayIntegration.kt:209 @d91b3bc`) |

## 9. Questions asked and answers

| # | Question | Answer |
|---|---|---|
| 1 | Default mode per platform? | Wireframe on both (`PostHogSessionReplayConfig.swift:51 @2b6b6b4`, `PostHogSessionReplayConfig.kt:40 @d91b3bc`). RN and Flutter use screenshots `[docs only]` |
| 2 | How does iOS know when to capture? | It swizzles `UIView.layoutSublayers(of:)`, with a throttle and trailing call (`ApplicationViewLayoutPublisher.swift:65`, `PostHogReplayIntegration.swift:325-331 @2b6b6b4`). No timer, no `CADisplayLink` |
| 3 | And Android? | A per-window `OnDrawListener` with a throttle, windows found through Curtains (`PostHogReplayIntegration.kt:341-361,586-594 @d91b3bc`) |
| 4 | Does iOS diff wireframes? | No: every frame is a `type 2` full snapshot (`PostHogReplayIntegration.swift:859-874 @2b6b6b4`). Only screenshots are deduplicated, by hash |
| 5 | Does Android diff? | Yes: flatten, match by id, emit adds/removes/updates (`PostHogReplayIntegration.kt:871-913,2414-2452 @d91b3bc`) |
| 6 | Screenshot encoding? | WebP q30 at 1 pixel per point on iOS (libwebp, JPEG fallback); WebP q30 at configurable scale on Android (`UIImage+Util.swift:13-29`, `RRWireframe.swift:64-79 @2b6b6b4`; `PostHogReplayIntegration.kt:1805-1811,1937 @d91b3bc`) |
| 7 | When are masks applied? | On device before encoding, as black rectangles on iOS (`RRWireframe.swift:73-76`); painted onto the bitmap on Android (`:1615`). Wireframe text is replaced with `*` |
| 8 | What happens when masking cannot be guaranteed? | The frame is dropped (fail closed) on both platforms: unsettled reporters, transitions, a camera on screen, mask render failure, misaligned draws (`PostHogReplayIntegration.swift:1173-1184,825-828 @2b6b6b4`; `PostHogReplayIntegration.kt:1824-1828,1956-1966 @d91b3bc`) |
| 9 | Where does reconstruction happen? | In the browser at play time (`sessionRecordingDataCoordinatorLogic.ts:765`, `process-all-snapshots.ts:435-438 @ea413ff`) |
| 10 | Are keyboard events captured? | Android emits show/hide plus height as a custom event (`:421-448 @d91b3bc`). Keystrokes are never captured. iOS sends nothing |
| 11 | Does replay pause in background? | iOS pauses plugins on background (`PostHogReplayIntegration.swift:360-369 @2b6b6b4`); capture stops naturally because no layout or draw happens |
| 12 | Are snapshots sent to a separate endpoint? | Yes, `/s/` with a separate disk queue; the server can redirect it through remote config (`PostHogRemoteConfig.swift:332-333 @2b6b6b4`) |
| 13 | Any OTel? | Only OTLP/JSON logs to `/i/v1/logs`. No traces or metrics, and replay and events are not OTLP (section 5) |
| 14 | Native crash reporting? | iOS: vendored PLCrashReporter (Mach), server-side symbolication. Android: JVM handler plus NDK tombstones via `ApplicationExitInfo`. Both off by default. No ANR or hang detection |
| 15 | Performance data? | No vendor numbers. One manual JVM micro-benchmark for the Android mask walk; no CI perf jobs |
| 16 | Are wireframe ids stable? | iOS uses `view.hash`, i.e. the object address (`:909`); Android uses `System.identityHashCode` (`:1999`). Stable while the view object lives, which is what makes Android's diff work |
| 17 | Is web-view content captured? | No. A `web_view` placeholder in wireframe mode; masked whole when masking is on |

## 10. Takeaways for ouo (both SDKs MIT, code reuse allowed with attribution)

1. **Wireframe mode is weaker than it looks.** It cannot see SwiftUI or Compose, which is where new native apps are written, and PostHog's own docs steer those apps to screenshot mode. ADR-0006's choice of screenshots plus on-device masking matches where PostHog has ended up for modern UI. Keep it.
2. **Copy the fail-closed masking rules.** Skip the frame when a mask reporter has not laid out, during a view-controller transition, when a camera is on screen, or when the masked render fails. Never fall back to the raw image (`PostHogReplayIntegration.swift:1171-1190`, `RRWireframe.swift:108-116 @2b6b6b4`). The settle-then-shoot check (two mask samples 25 ms apart, then pick the renderer) is a cheap answer to masks drifting during scroll.
3. **Encode as WebP rather than JPEG.** Downscale to 1 pixel per point off the main thread, and dedupe identical frames by hash. PostHog vendors libwebp on iOS because ImageIO cannot write WebP (confirmed locally: `sips` lists WebP read-only). ouo's JPEG q0.5 at half resolution is in the same size class. Moving to WebP is an easy later win.
4. **Diff if we ever serialise trees.** iOS's "full tree every second" works only because gzip over a batch of 20 hides the repetition (207 KB → 3.9 KB measured). Android's flatten-and-match-by-id diff is simple and is what to copy if ouo adds a wireframe fallback.
5. **Throttle on layout or draw, not on a timer.** PostHog captures at most once per `throttleDelay`, with a trailing capture, and drops overlapping captures instead of queueing them. Use the same pattern.
6. **Reconstruct in the player, not at ingest.** PostHog stores mobile events as sent and converts them to rrweb DOM in the browser. That keeps ingest dumb and lets the transformer evolve. For ouo's Grafana plugin, a frame `kind` with a dedicated renderer (ADR-0006) is simpler than emulating rrweb DOM for screenshots: PostHog wraps each screenshot in `<img>` nodes and then needs special cases (`process-all-snapshots.ts:40-108 @ea413ff`).
7. **One session id everywhere is the whole linkage.** PostHog has no traces. ouo can beat it by carrying `session.id` on OTel spans and putting W3C `traceparent` on outgoing requests, where PostHog only sends `X-POSTHOG-SESSION-ID`.
8. **PostHog's OTLP logs are a hint.** PostHog already speaks OTLP/JSON for mobile logs, with `sessionId`, `screen.name` and `app.state` as attributes. ouo's mobile SDK can use OTLP for every signal without being unusual.
9. **Gaps worth filling:** ANR and hang detection, app start, slow and frozen frames, and screen-load spans. PostHog has none of them, and they are cheap for an OTel-native RUM SDK.
10. **Lifecycle details to copy:** buffer snapshots on disk until remote config and minimum duration resolve, sample deterministically on the session id, rotate sessions after 30 min idle or 24 h, and pause plugins in background.
