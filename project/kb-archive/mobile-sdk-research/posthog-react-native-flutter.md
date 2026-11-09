# Appendix E: PostHog for React Native and Flutter

Written 2026-10-29. Scope: what the React Native and Flutter layers add or change on top of posthog-ios and posthog-android. The native internals (wireframe serialisation, the screenshot pipeline inside the native SDK, the `/s/` snapshot endpoint and the server-side transformer) are covered in [posthog-ios-android.md](posthog-ios-android.md). Every claim cites `repo/path:line @ sha`. `[docs only]` marks facts not grounded in code.

**Short answer to the central question.** PostHog does **not** use its native default (wireframe) in either framework. Both always use **screenshot** mode, and the user cannot change that. They get there in two different ways:

- **React Native** keeps capture **native**. A thin native module starts a second, native PostHog SDK instance with `screenshotMode = true` (iOS) or `screenshot = true` (Android) hard-coded. The native SDK then captures, masks, encodes and uploads exactly as it would in a native app. JS only passes config and keeps the session id in sync.
- **Flutter** moves capture into **Dart**. It renders the app's root `RepaintBoundary` to an image, paints the masks in Dart, dedupes by hash, and encodes PNG. It sends the bytes over a method channel. The native SDK then re-encodes them to WebP, wraps them as a `type: "screenshot"` wireframe, and batches and uploads them. The native SDKs switch their own capture loop off when the host is `posthog-flutter`.

Why the split: React Native renders real `UIView` / `android.view.View` objects, so native screenshot-plus-view-masking works unchanged. Flutter draws everything into one engine surface, so native view-hierarchy masking sees one opaque view; only Dart can see the widget and `RenderObject` tree needed to mask. Wireframes are ruled out in both. In React Native they would turn every `RCTView` / `ReactViewGroup` into generic boxes. In Flutter there is no native hierarchy to serialise at all (see §9 Q1 for the evidence and the parts that are my reading).

## 1. Sources

| Repo | Ref studied | Commit | Notes |
|---|---|---|---|
| `PostHog/posthog-js` (monorepo; `packages/react-native`, `packages/react-native-plugin`, `packages/core`) | tag `posthog-react-native@4.84.3` (2026-10-28), contains `@posthog/react-native-plugin` 2.12.7 | `a3e9ec3d274e64f8cdfbb29e99c1ee385d34cf8f` | The RN SDK moved here. `posthog-js-lite` is archived: "Code from this repository has been moved to posthog-js" (`posthog-js-lite/README.md:3 @ 1e2e226c`) |
| `PostHog/posthog-react-native-session-replay` | tag `1.6.0` (2026-05-26) | `df68892ed991aa0ebd5700de1c7802effa0f54d4` | Legacy replay-only plugin, still used as a fallback |
| `PostHog/posthog-flutter` (`posthog_flutter/`) | tag `5.58.0` (2026-10-28) | `0b4207390bde1b691680c3508f81d21a085bad5d` | |
| `PostHog/posthog-ios` | tag `3.92.7` | `2b6b6b4301c14c3b51cb1a7827c954bb17d1b083` | Only the host-specific branches were read |
| `PostHog/posthog-android` | tag `android-v3.73.1` | `d91b3bc7a0a4421d5cb0bf8ca848e23f838808cf` | Only the host-specific branches were read |
| `PostHog/posthog-unity` | tag `v1.1.1` | `79b930c851b0acc9a04ae2262745fc8402f71a58` | §9 Q9 only |

Docs read on 2026-10-29: https://posthog.com/docs/session-replay/mobile, https://posthog.com/docs/session-replay/installation/react-native, https://posthog.com/docs/session-replay/installation/flutter, https://posthog.com/docs/libraries/kmp.md, https://posthog.com/docs/libraries/unity, https://posthog.com/docs/libraries/capacitor, https://posthog.com/docs/libraries/dotnet.

Everything studied is MIT and fully open; no binaries are involved.

## 2. Platforms and languages

| Host | Analytics transport | Replay capture | Replay encode | Replay upload | Pinned native SDK |
|---|---|---|---|---|---|
| RN iOS | JS (`fetch` to `/batch/`) | native posthog-ios, screenshot mode | native (WebP q0.3, JPEG fallback) | native | plugin: `PostHog ~> 3.88.2` (`posthog-js/packages/react-native-plugin/posthog-react-native-plugin.podspec:9 @ a3e9ec3d`); legacy: `3.58.1` (`posthog-react-native-session-replay/posthog-react-native-session-replay.podspec:9 @ df68892e`) |
| RN Android | JS (`fetch` to `/batch/`) | native posthog-android, screenshot mode | native (WebP q30) | native | plugin: `3.72.9` (`posthog-js/packages/react-native-plugin/android/build.gradle:94 @ a3e9ec3d`); legacy: `3.40.2` (`posthog-react-native-session-replay/android/build.gradle:88 @ df68892e`) |
| RN web / macOS | JS | none (plugin not loaded on web; legacy is skipped on macOS) | n/a | n/a | `posthog-js/packages/react-native/src/optional/OptionalPlugin.ts:48-60 @ a3e9ec3d` |
| Flutter iOS / Android | native SDK via method channel | **Dart** (`PostHogWidget`) | Dart PNG, then native WebP | native | `posthog-ios >= 3.84.0 < 4.0.0` (`posthog-flutter/posthog_flutter/darwin/posthog_flutter.podspec:25 @ 0b420739`); `posthog-android [3.72.9,4.0.0)` (`posthog-flutter/posthog_flutter/android/build.gradle:70 @ 0b420739`) |
| Flutter macOS | native via channel | none: the native `sendFullSnapshot` is `#if os(iOS)` only | n/a | n/a | `posthog-flutter/posthog_flutter/darwin/posthog_flutter/Sources/posthog_flutter/PosthogFlutterPlugin.swift:1218,1272-1274 @ 0b420739` |
| Flutter Windows / Linux | pure-Dart client | none | n/a | n/a | `posthog-flutter/posthog_flutter/lib/src/posthog_widget.dart:199-202 @ 0b420739` |
| Flutter web | posthog-js through JS interop | posthog-js rrweb with canvas capture `[docs only]` | n/a | n/a | `posthog-flutter/posthog_flutter/lib/src/replay/native_communicator.dart:61-63 @ 0b420739` |

Minimum versions: iOS 13 for the legacy RN module (`posthog-react-native-session-replay.podspec:42 @ df68892e`) and Android minSdk 23 (`posthog-react-native-session-replay/android/gradle.properties:2 @ df68892e`). The docs say Android API 26+ for RN `[docs only]`. Flutter needs SDK `>=3.6.0`, Flutter `>=3.27.0` (`posthog-flutter/posthog_flutter/pubspec.yaml:12-13 @ 0b420739`), and plugin 4.7.0+ for replay `[docs only]`.

## 3. RUM

### React Native (JS SDK `posthog-react-native` 4.84.3)

| Signal | How | Code |
|---|---|---|
| Sessions | `uuidv7` session id persisted in storage. It rotates after 30 min idle (`sessionExpirationTimeSeconds` default 1800) or 24 h max length. Checked lazily on every `getSessionId()` | `posthog-js/packages/core/src/posthog-core.ts:68,92,260-283 @ a3e9ec3d` |
| Screens | `PostHogProvider` mounts `PostHogNavigationHook` when `autocapture.captureScreens` is on (default true). It reads `useNavigationState` / `getCurrentRoute()` from `@react-navigation` and calls `posthog.screen(routeName)`. Wix navigation is handled separately (`src/frameworks/wix-navigation.ts`) | `posthog-js/packages/react-native/src/PostHogProvider.tsx:175,269`, `src/hooks/useNavigationTracker.ts:30,77,89-93 @ a3e9ec3d` |
| Touches | `captureTouches` (default **false**) puts `onTouchEndCapture` on a root `View`. The handler walks the **React fiber** from `e._targetInst` up through `.return`, reading `memoizedProps`. Any ancestor with `ph-no-capture` aborts the event; `ph-label` names an element; only `style`, `testID`, `accessibilityLabel`, `ph-label` and `children` props are kept. It emits `$autocapture` with `$touch_x/y` | `posthog-js/packages/react-native/src/PostHogProvider.tsx:39,174,259`, `src/autocapture.tsx:151-155,164,175-190,266-277 @ a3e9ec3d` |
| Lifecycle | `captureAppLifecycleEvents` (default on) emits `Application Installed` / `Updated` (by comparing the stored build/version) and `Opened`. An `AppState` listener emits `Became Active` / `Backgrounded` | `posthog-js/packages/react-native/src/posthog-rn.ts:187-192,703-705,3837-3890 @ a3e9ec3d` |
| JS errors | `ErrorUtils.setGlobalHandler` for uncaught errors, plus Hermes `HermesInternal.enablePromiseRejectionTracker` for unhandled rejections. Optional `console` capture. `PostHogErrorBoundary` component | `posthog-js/packages/react-native/src/error-tracking/utils.ts:10-36`, `src/error-tracking/index.ts:46-73,552-616 @ a3e9ec3d` |
| Native crashes | **Yes, since the plugin.** `errorTracking.autocapture.nativeCrashes` sets posthog-ios `errorTrackingConfig.autoCapture` (which on Apple also covers signals) or posthog-android `autoCapture`. `androidNdkCrashes` sets `captureNativeCrashes` (tombstone scan on next launch, API 31+). A fatal-JS marker drops the native duplicate of a crash JS already captured. The legacy plugin has no native crash capture | `posthog-js/packages/react-native-plugin/ios/PosthogReactNativePlugin.swift:326,359-390`, `.../android/.../PosthogReactNativePluginModule.kt:175-184,895-903`, `posthog-js/packages/react-native/src/posthog-rn.ts:3373-3379,3400-3406 @ a3e9ec3d` |
| Network | Only inside replay, iOS only: native `captureNetworkTelemetry` (default true). Android does not pass it | `.../PosthogReactNativePlugin.swift:431-432`, `posthog-js/packages/react-native/src/types.ts:229-235 @ a3e9ec3d` |
| Rage clicks | Forwarded to native `rageClickConfig` (iOS) | `.../PosthogReactNativePlugin.swift:336-349 @ a3e9ec3d` |
| Feature flags, surveys | JS core `/flags`; hooks `useFeatureFlag*`; `PostHogSurveyProvider` renders surveys in React (native surveys are forced off) | `posthog-js/packages/react-native/src/surveys/PostHogSurveyProvider.tsx:108`, `.../PosthogReactNativePlugin.swift:402-404 @ a3e9ec3d` |
| Persistence | `persistence: 'file'` (default) or `'memory'`. Storage tries `expo-file-system` (new or legacy API) first, then `@react-native-async-storage/async-storage`, then a custom `PostHogCustomStorage`. Files are `.posthog-rn.json` and `.posthog-rn-logs.json` | `posthog-js/packages/react-native/src/native-deps.tsx:185-243`, `src/storage.ts:7-8`, `src/posthog-rn.ts:169,487 @ a3e9ec3d` |

The native SDK instance inside an RN app runs with `captureApplicationLifecycleEvents = false` and `captureScreenViews = false`, plus `captureDeepLinks = false` on Android, because JS owns those signals (`.../PosthogReactNativePlugin.swift:323-324`, `.../PosthogReactNativePluginModule.kt:161-163 @ a3e9ec3d`).

### Flutter (posthog_flutter 5.58.0)

| Signal | How | Code |
|---|---|---|
| Sessions | Owned by the **native** SDK on mobile; Dart asks native for the id (`getSessionId`, `getSessionReplayState`) | `posthog-flutter/posthog_flutter/lib/src/posthog_flutter_io.dart:915`, `.../PosthogFlutterPlugin.swift:1285-1296 @ 0b420739` |
| Screens | `PosthogObserver extends RouteObserver<ModalRoute>`. `didPush` / `didReplace` / `didPop` take a name from `RouteSettings` through `nameExtractor`, filtered by `routeFilter`, and call `Posthog().screen()`. Native `captureScreenViews` is forced off | `posthog-flutter/posthog_flutter/lib/src/posthog_observer.dart:35-50,120-136`, `.../PosthogFlutterPlugin.swift:200`, `.../PosthogFlutterPlugin.kt:592 @ 0b420739` |
| Touches | **No `$autocapture` in Dart.** Replay touch positions come from the native SDK (`captureTouches`). posthog-ios subscribes to `UIApplication.sendEvent` even when the host is Flutter | grep of `lib/` finds no `$autocapture`; `posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:324-336 @ 2b6b6b43` |
| Lifecycle | Native `captureApplicationLifecycleEvents` (default true in Dart config) | `posthog-flutter/posthog_flutter/lib/src/posthog_config.dart:195`, `.../PosthogFlutterPlugin.swift:202-203 @ 0b420739` |
| Errors | `FlutterError.onError` (optionally including silent errors), `PlatformDispatcher.instance.onError`, and `Isolate.current.addErrorListener`. Native exceptions via `captureNativeExceptions` mapped to posthog-ios `autoCapture` | `posthog-flutter/posthog_flutter/lib/src/error_tracking/posthog_error_tracking_autocapture_integration.dart:60-62,84-95,127-143,189-200`, `.../PosthogFlutterPlugin.swift:325-330 @ 0b420739` |
| Network | Replay network telemetry is **forced off** on iOS, because Dart `http` / `dio` bypass `URLSession`; logcat is forced off on Android | `.../PosthogFlutterPlugin.swift:285-286`, `.../PosthogFlutterPlugin.kt:641 @ 0b420739` |
| Flags, surveys | Over the method channel to native (`isFeatureEnabled`). Native surveys are delegated back to Dart for rendering (`surveysDelegate = instance`, `showSurvey`) | `posthog-flutter/posthog_flutter/lib/src/posthog_flutter_io.dart:68,569-576`, `.../PosthogFlutterPlugin.swift:313-321 @ 0b420739` |

## 4. Session replay

### 4.1 React Native: a thin wrapper that forces screenshot mode

There are two native modules with the same surface. The JS SDK loads `@posthog/react-native-plugin` first and falls back to the legacy `posthog-react-native-session-replay` (`posthog-js/packages/react-native/src/optional/OptionalPlugin.ts:7-11,41-60 @ a3e9ec3d`). The docs say the plugin is the renamed package for `posthog-react-native` 4.47.0+ `[docs only]`. Both are old-architecture bridge modules: `RCT_EXTERN_MODULE` on iOS and `ReactContextBaseJavaModule` on Android. They run under the new architecture through the interop layer; there is no TurboModule spec or Fabric component (`posthog-react-native-session-replay/ios/PosthogReactNativeSessionReplay.mm:3`, `.../PosthogReactNativeSessionReplayModule.kt:20-22 @ df68892e`; `posthog-js/packages/react-native-plugin/src/index.tsx:1,10 @ a3e9ec3d`). Expo needs a development build; Expo Go cannot load it (`posthog-react-native-session-replay/src/index.tsx:3-7 @ df68892e`). The `posthog-react-native/expo` config plugin only handles source-map and symbol upload, not replay (`posthog-js/packages/react-native/src/tooling/expoconfig.ts:9-14,109 @ a3e9ec3d`).

**Native config: screenshot is hard-coded.** The legacy iOS module:

```swift
// posthog-react-native-session-replay/ios/PosthogReactNativeSessionReplay.swift:32-39 @ df68892e
PostHogSessionManager.shared.setSessionId(sessionIdStr)
let config = PostHogConfig(projectToken: projectToken, host: host)
config.sessionReplay = true
config.captureApplicationLifecycleEvents = false
config.captureScreenViews = false
config.debug = debug
config.sessionReplayConfig.screenshotMode = true
```

The Android equivalent is `sessionReplayConfig.screenshot = true` (`posthog-react-native-session-replay/android/.../PosthogReactNativeSessionReplayModule.kt:80-93 @ df68892e`). Both lines were there from the first commits in September 2024 (`ba07b2e` "android plugin", `3024f4e` "ios plugin"), found with `git log -S`. The current plugin does the same (`posthog-js/packages/react-native-plugin/ios/PosthogReactNativePlugin.swift:409-410`, `.../android/.../PosthogReactNativePluginModule.kt:204-205 @ a3e9ec3d`). The JS SDK even stamps `$sdk_debug_replay_capture_mode: 'screenshot'` whenever native replay is present (`posthog-js/packages/react-native/src/posthog-rn.ts:945 @ a3e9ec3d`). No RN option can switch to wireframe.

**Option mapping JS to native** (`posthog-js/packages/react-native/src/types.ts:161-297`, `src/posthog-rn.ts:3178-3193`; `.../PosthogReactNativePlugin.swift:411-445`; `.../PosthogReactNativePluginModule.kt:189-216,905-921 @ a3e9ec3d`):

| JS `sessionReplayConfig` | Default | iOS native | Android native |
|---|---|---|---|
| `maskAllTextInputs` | true | `maskAllTextInputs` | `maskAllTextInputs` |
| `maskAllImages` | true | `maskAllImages` | `maskAllImages` |
| `maskAllSandboxedViews` | true | `maskAllSandboxedViews` | not passed |
| `captureTouches` | true | `captureTouches` (plugin 2.9+) | `captureTouches` |
| `captureLog` | true | `captureLogs` | `captureLogcat` |
| `captureNetworkTelemetry` | true | `captureNetworkTelemetry` | not passed |
| `throttleDelayMs` (falls back to `iOSdebouncerDelayMs` / `androidDebouncerDelayMs`) | 1000 | `throttleDelay` (s) | `throttleDelayMs` |
| `sampleRate` | remote | `sampleRate` | `sampleRate` |
| `screenshotScale`, `screenshotCompressionQuality` (30), `screenshotColorMode` | 1.0 / 30 / ARGB_8888 | n/a | passed (plugin 2.8+) |
| `screenshotModeBackgroundCapture` | false | `screenshotModeBackgroundCapture` | n/a |
| `verifyScreenshotMaskAlignment` | false | n/a | passed |
| (flags response) `endpoint` | n/a | `snapshotEndpoint` | `snapshotEndpoint` |

`sdkOptions` passed to `setup()` are `apiKey`, `host`, `debug`, `distinctId`, `anonymousId`, `sdkVersion`, `flushAt`, `optOut`, `preloadFeatureFlags` and `requestHeaders` (`posthog-js/packages/react-native/src/posthog-rn.ts:3315-3330 @ a3e9ec3d`). Native sets `postHogSdkName = "posthog-react-native"`, which switches posthog-ios and posthog-android into "RN owns the session" mode (below).

**Masking in RN** happens entirely in the native SDK's screenshot masker. JS only adds `PostHogMaskView`, a `View` with `accessibilityLabel="ph-no-capture"`, `importantForAccessibility="no"` and `collapsable={false}`. The last prop stops Fabric/Paper view flattening from removing the wrapper before native can see it (`posthog-js/packages/react-native/src/PostHogMaskView.tsx:41-45 @ a3e9ec3d`). The `ph-no-capture` prop that `autocapture.tsx` checks is a separate JS-only mechanism that blocks `$autocapture` (`autocapture.tsx:182-185`).

**Session id sync (JS is the source of truth).**

1. At setup, JS calls `plugin.setup(sessionId, sdkOptions, pluginConfig)`, or legacy `start(sessionId, ...)`. Native calls `PostHogSessionManager.setSessionId(id)` before `setup` (`posthog-js/packages/react-native/src/posthog-rn.ts:3390,3422-3427`; `.../PosthogReactNativePlugin.swift:320 @ a3e9ec3d`).
2. Every JS `getSessionId()` compares the new id with `_currentSessionId`. When they differ (30-min idle or 24 h rotation in core), it calls `_resetSessionId`, which is `endSession()` then `startSession(newId)` on native (`posthog-rn.ts:2003-2041 @ a3e9ec3d`). Rotation is therefore **lazy**: native learns about a new session the next time JS reads the id, usually on the next captured event.
3. `resetSessionId()` (for example on `reset()`) calls native `endSession()` (`posthog-rn.ts:2043-2057`).
4. `identify` pushes `distinctId` and `anonymousId` into native storage (`posthog-rn.ts:2460`; `posthog-react-native-session-replay/ios/PosthogReactNativeSessionReplay.swift:134-168 @ df68892e`).
5. Native refuses to rotate on its own when the host is RN. posthog-ios `getSessionId` returns `currentSessionId` as-is, and `startSession` / `endSession` are no-ops for RN (`posthog-ios/PostHog/PostHogSessionManager.swift:83-86,116-118,164-176 @ 2b6b6b43`). posthog-android has the same `isReactNative` short-circuits (`posthog-android/posthog/src/main/java/com/posthog/internal/PostHogSessionManager.kt:41,75,90,116,150,182`; set in `posthog-android/posthog-android/src/main/java/com/posthog/android/PostHogAndroid.kt:222 @ d91b3bc7`). So the native `endSession(); startSession(id)` pair from JS works through `setSessionId` (the plugin calls it first), not through native rotation.

Event-trigger and linked-flag gating for replay are also decided in JS (`posthog-rn.ts:405-407,1041-1076`). posthog-ios skips its own trigger evaluation for RN (`posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:174-177 @ 2b6b6b43`).

### 4.2 Flutter: Dart captures, native ships

**Setup.** The app wraps its root in `PostHogWidget`, which builds `RepaintBoundary(key: PostHogMaskController.instance.containerKey, ...)` (`posthog-flutter/posthog_flutter/lib/src/posthog_widget.dart:355-360 @ 0b420739`). Recording starts when the native side reports replay as active (`PostHogInternalEvents.sessionRecordingActive`, `posthog_widget.dart:73-80,220-243`; set in `lib/src/posthog.dart:94,407`).

**Who schedules: Dart.** `ChangeDetector` is a `Timer.periodic(throttleDelay)` (default 1 s, `posthog_config.dart:919`). Each tick registers `WidgetsBinding.instance.addPostFrameCallback`. It only forces a frame with `scheduleFrame()` on a forced tick (start, session boundary) or when native platform views are being composited (`posthog-flutter/posthog_flutter/lib/src/replay/change_detector.dart:49-71,109-122 @ 0b420739`). So if the app does not repaint, no frame is drawn, no callback fires, and nothing is captured. That is the first level of change detection, and it costs nothing.

```dart
// posthog-flutter/posthog_flutter/lib/src/replay/change_detector.dart:109-122 @ 0b420739
void _scheduleFrameCallback({bool forceFrame = false}) {
  if (!_isRunning) return;
  if ((forceFrame || hasCapturedPlatformViews) && !suppressForcedFrames) {
    WidgetsBinding.instance.scheduleFrame();
  }
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (_isRunning) onChange();
  });
}
```

**Capture flow** (`posthog-flutter/posthog_flutter/lib/src/replay/screenshot/screenshot_capturer.dart @ 0b420739`):

1. A method-channel round trip, `getSessionReplayState`, returns `{isActive, sessionId}` from native. If the session id changed, Dart resets its dedupe and meta state (`:645-666`).
2. `await SchedulerBinding.instance.endOfFrame`, then a **synchronous mask walk** with no `await` before `toImage`, so the rects match the pixels (`:700-717`).
3. `renderObject.toImage(pixelRatio: _screenshotScale)`. On iOS the scale is always 1.0; on Android it is `screenshotScale`, default 1.0 and clamped to 0.1–1.0. So frames are captured at **one pixel per logical pixel** (points or dp), not at device resolution (`:243-249,719`; `posthog_config.dart:936-941`).
4. `toByteData(rawRgba)`, then a **32-bit FNV-1a hash over every byte** in Dart, and the raw buffer is dropped. If the hash equals the last delivered frame's hash and no meta event is due, the frame is discarded (`:490-519,747-772,798-810`). This is the second level of change detection.
5. Masks are painted onto a `PictureRecorder` canvas, black by default (`lib/src/replay/mask/image_mask_painter.dart:11-13`). Platform views marked `mask` are painted over too. With `captureNativeScreens`, platform views marked `capture` are composited from native screenshots fetched over the channel (`:826-859`; `native_communicator.dart:79-98`).
6. `picture.toImage(w, h)`, then **PNG** with `toByteData(format: png)` (`:251-258,871,891`).
7. `sendMetaEvent(width, height, screen)` when needed, then `sendFullSnapshot(imageBytes, id, x, y, width, height)` over `MethodChannel('posthog_flutter')` (`posthog_widget.dart:316-337`; `native_communicator.dart:10-32`).

**Masking in Dart.** Each capture walks the whole `Element` tree under the container with `element.debugVisitOnstageChildren`. It tracks `PostHogUnmaskWidget` subtrees and sensitive text inputs (`lib/src/replay/mask/widget_elements_decipher.dart:41-57`). Rects come from `RenderObject.paintBounds` and `getTransformTo(ancestor)` (`lib/src/replay/element_parsers/element_data_factory.dart:11-20`). Which render objects are masked depends on config: `RenderParagraph`, `RenderEditable` and `RenderTransform` when `maskAllTexts`; `RenderImage` when `maskAllImages`; `RenderCustomPaint` when `maskCustomPaint` (`lib/src/replay/element_parsers/element_parsers_const.dart:10-22`). `PostHogMaskWidget` wraps a child in a keyed `Container` and registers it; its rects are always masked (`lib/src/replay/mask/posthog_mask_widget.dart:7-34`; `posthog_mask_controller.dart:81-107`). Config knobs are `maskAllTexts`, `maskAllImages`, `maskCustomPaint`, `textMaskPolicy`, `maskAllPlatformViews` and `captureNativeScreens` (`posthog_config.dart:783-1010`).

**Native side: wrap, re-encode, batch, upload.** iOS decodes the PNG into a `UIImage`. It re-encodes on a background queue with `imageToBase64`, which is WebP at quality 0.3 with a JPEG fallback as a `data:image/...;base64` URL. It builds an rrweb full snapshot (`type: 2`) holding one wireframe `{type: "screenshot", base64, x, y, width, height}`, and calls `PostHogSDK.shared.capture("$snapshot", ["$snapshot_source": "mobile", "$snapshot_data": ...])`:

```swift
// posthog-flutter/posthog_flutter/darwin/posthog_flutter/Sources/posthog_flutter/PosthogFlutterPlugin.swift:1249-1266 @ 0b420739
let wireframe: [String: Any] = [
    "id": id, "x": x, "y": y,
    "width": Int(image.size.width), "height": Int(image.size.height),
    "type": "screenshot", "base64": base64, "style": [:],
]
...
let snapshotData: [String: Any] = ["type": 2, "data": data, "timestamp": timestamp]
PostHogSDK.shared.capture("$snapshot", properties: ["$snapshot_source": "mobile", "$snapshot_data": snapshotsData], timestamp: date)
```

`imageToBase64` is a public posthog-ios helper exported for this purpose (`posthog-ios/PostHog/Replay/UIImage+Util.swift:13-28,41-43 @ 2b6b6b43`). Android uses `BitmapFactory.decodeByteArray` and `bitmap.base64(quality = screenshotCompressionQuality)`, default 30 (WebP). It builds `RRFullSnapshotEvent(listOf(RRWireframe(type = "screenshot", ...)))` and calls `.capture()` on posthog-android's replay helpers (`posthog-flutter/posthog_flutter/android/src/main/kotlin/com/posthog/flutter/SnapshotSender.kt:12,30-58`; `PosthogFlutterPlugin.kt:1310-1327 @ 0b420739`). Batching, gzip and upload to the snapshot endpoint are posthog-ios / posthog-android code.

**What the native replay integration does when hosting Flutter.** It is installed (touches, logs, sampling and meta still work), but its own capture loop is turned off by a check on the SDK name:

```swift
// posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:169-172,324-331 @ 2b6b6b43
private func isNotFlutter() -> Bool {
    // for the Flutter SDK, screen recordings are managed by Flutter SDK itself
    postHogSdkName != "posthog-flutter"
}
...
// flutter captures snapshots, so we don't need to capture them here
if isNotFlutter() { viewLayoutToken = ...onViewLayout.subscribe(throttle: interval, ...) { self?.snapshot() } }
```

On Android, `isNativeSdk = config.sdkName != "posthog-flutter"` makes the draw listener return early (`posthog-android/posthog-android/src/main/java/com/posthog/android/replay/PostHogReplayIntegration.kt:204-209,347-349 @ d91b3bc7`). posthog-ios reports `captureMode = "screenshot"` whenever the host is Flutter (`PostHogReplayIntegration.swift:1865-1867`). There is one exception, `captureNativeScreens`. When a native screen covers the Flutter view, native "occlusion" detection tells Dart, and Dart can ask native to capture for that episode through `enableNativeBridge`; otherwise it sends a placeholder frame (`posthog_widget.dart:126-184`; `.../PosthogFlutterPlugin.swift:296-310 @ 0b420739`).

**Division of labour:**

| Step | RN | Flutter |
|---|---|---|
| Schedule capture | native (view-layout or draw throttle) | Dart (`Timer` + post-frame callback) |
| Find mask rects | native view hierarchy | Dart Element/RenderObject walk |
| Rasterise | native | Dart `toImage` (engine raster thread) |
| Dedupe | native | Dart FNV hash of raw RGBA |
| Encode | native WebP/JPEG | Dart PNG, then native decode and WebP/JPEG re-encode |
| Batch + upload | native | native |
| Session id | JS owns, pushed to native | native owns, Dart polls |

## 5. Transport and OpenTelemetry

**RN analytics.** The JS core queues events and flushes at `flushAt` (20), every `flushInterval` (10 s), with `maxBatchSize` 100 and `maxQueueSize` 1000. It posts to `/batch/` and halves the batch on HTTP 413 (`posthog-js/packages/core/src/posthog-core-stateless.ts:437-440,1298-1314,1578,1683,1732 @ a3e9ec3d`). **No gzip on React Native in practice.** Compression requires `CompressionStream`, which the code notes "is not available on React Native", so `disableCompression` resolves to true (`posthog-js/packages/core/src/gzip.ts:4-15`, `posthog-core-stateless.ts:468,1619-1627 @ a3e9ec3d`). The events queue is persisted to `.posthog-rn.json`. Replay `$snapshot` events never pass through JS: the native instance batches them (with native gzip; see Appendix D) and uses the `flushAt` value JS passed down.

**Flutter analytics** on mobile go through the method channel (`capture`, `screen`, `identify`, `flush`) into the native SDK's queue and transport (`posthog-flutter/posthog_flutter/lib/src/posthog_flutter_io.dart:208,250,337,399,809 @ 0b420739`). The Dart config `flushAt` 20, `maxQueueSize` 1000, `maxBatchSize` 50 and `flushInterval` 30 s is forwarded to native (`posthog_config.dart:123-139,466-469`), as is `compression` `gzip|none` on Android (`PosthogFlutterPlugin.kt:631-636`). Desktop uses a pure-Dart client and web uses posthog-js.

**OpenTelemetry.** Neither SDK depends on any `@opentelemetry` / `opentelemetry` package, and replay and analytics are not OTel. PostHog does emit **OTLP/JSON** for its logs product, which neither the task brief nor the mobile replay docs mention:

- RN: `posthog.captureLog()` / `posthog.logger.*` build OTLP log records (severity numbers, nanosecond timestamps, `resourceLogs` envelope with `service.name` and similar) and POST them to `${host}/i/v1/logs?token=...` (`posthog-js/packages/react-native/src/posthog-rn.ts:262-294`; `posthog-js/packages/core/src/logs/logs-utils.ts:21-37,80-150,193-209`; `posthog-core-stateless.ts:1767-1827,1863 @ a3e9ec3d`). The 10 MB body cap is checked before compression (`:239,1800-1808`). AppState is mapped to OTLP `app.state` (`posthog-rn.ts:76-82`).
- Core also has OTLP `traces` (`/i/v1/traces`, bearer auth) and `metrics` (`/i/v1/metrics`) builders (`posthog-core-stateless.ts:1867,1879`; `core/src/traces/otlp.ts:17-68`). RN 4.84.3 does **not** call them: there is no span or metric API in `posthog-rn.ts`.
- Flutter forwards `captureLog` to posthog-ios / posthog-android, which ship to `/i/v1/logs` (`posthog-flutter/posthog_flutter/lib/src/posthog_flutter_io.dart:409-437`, `.../PosthogFlutterPlugin.swift:1527-1543 @ 0b420739`; `posthog-android/posthog/src/main/java/com/posthog/internal/PostHogApi.kt:110-129 @ d91b3bc7`; `posthog-ios/PostHog/PostHogApi.swift:11,99 @ 2b6b6b43`). Its config exposes OTLP resource attributes (`posthog_config.dart:601-618`).
- RN `addTracingHeaders: [hostnames]` patches `fetch` to add `X-POSTHOG-DISTINCT-ID` / `X-POSTHOG-SESSION-ID`. These are proprietary headers, **not** W3C `traceparent` (`posthog-js/packages/core/src/tracing-headers.ts:3-4`; `posthog-rn.ts:722-724 @ a3e9ec3d`).

## 6. Other features

| Feature | RN | Flutter |
|---|---|---|
| Replay linked to errors | `$exception` is captured by JS (or native for native crashes) with `$session_id`; exception steps (breadcrumbs) are shared with native as one buffer (`.../PosthogReactNativePlugin.swift:328-334 @ a3e9ec3d`) | `$exception` through native `captureException` (`posthog_flutter_io.dart:864 @ 0b420739`) |
| Feature flags | JS (`/flags`); native also preloads unless push-only (`posthog-rn.ts:3313,3326`) | native |
| Surveys | React components (`PostHogSurveyProvider`) | rendered in Flutter, triggered by native |
| Push notifications | plugin only (`registerPushNotificationToken`, `OptionalPlugin.ts:22-26`) | yes (`pushIdentityProvider`, `posthog_flutter_io.dart:77`) |
| Rage clicks | native iOS config | native config (`.../PosthogFlutterPlugin.swift:276-277`) |
| Profiling, bug report | none found | none found |

## 7. Performance footprint

**Vendor claims.** None with numbers. The mobile replay page says only that capture uses native APIs "so as not to affect performance in any way a user may notice" `[docs only]`. The RN page says lower `screenshotScale` and `RGB_565` "reduce capture time and memory use" `[docs only]`. The Flutter page gives no benchmarks `[docs only]`. I found no benchmark code in posthog-js `packages/react-native*` or posthog-flutter (searched for `benchmark`, `perf`, `Stopwatch`; only unit tests exist).

**My reading of the code** (estimates, not measured):

- **RN.** The per-frame cost is the native screenshot cost from Appendix D and is unchanged by RN. JS cost is a few bridge calls per session change (`endSession` + `startSession`), one per `identify`, and a debug-properties refresh at most every 5 s while replay is on (`posthog-rn.ts:102,1016-1025 @ a3e9ec3d`). RN does add a **second full SDK instance**: a second queue, a second storage, and a second `/flags` and remote-config fetch.
- **Flutter, per tick with a changed frame, on a 393×852 pt iPhone screen:**
  - `toImage` at 1× is about 335 k pixels. `toByteData(rawRgba)` copies **≈1.34 MB** from the GPU into the Dart heap.
  - The FNV hash loops over every byte **on the UI isolate**; in plain Dart that is 1.34 M multiply/xor steps per tick. The code processes 4-byte words where it can (`screenshot_capturer.dart:493-519`).
  - The full Element-tree walk is also synchronous on the UI isolate, and it runs even when the hash later says "unchanged" (`:706`).
  - A second `toImage` and a PNG encode follow (engine side, async). Then ≈100–400 KB of PNG crosses the platform channel. Native decodes and re-encodes to WebP on a utility queue.
  - Peak transient memory is about 3–5 MB per frame: raw RGBA, two `ui.Image`s, the PNG and the decoded `UIImage` / `Bitmap`.
  - At 1 s throttle this runs at most once per second, and only when the app repainted.
  - No isolate or `compute()` is used.

## 8. Docs-to-code grounding

| Docs claim | Code |
|---|---|
| "React Native and Flutter always use screenshot mode; not configurable" `[docs]` | RN: `screenshotMode = true` / `screenshot = true` hard-coded (§4.1). Flutter: native capture disabled for `posthog-flutter`, Dart sends `type: "screenshot"` (§4.2) |
| RN plugin renamed from `posthog-react-native-session-replay` | `OptionalPlugin.ts:7-11,41-60 @ a3e9ec3d` |
| Expo Go not supported | linking error text, `posthog-react-native-session-replay/src/index.tsx:3-7 @ df68892e` |
| `screenshotScale` / `screenshotCompressionQuality` / `screenshotColorMode` are Android-only for RN | only the Android module applies them, `PosthogReactNativePluginModule.kt:905-921 @ a3e9ec3d`. Flutter also ignores `screenshotScale` on iOS (`screenshot_capturer.dart:243-245 @ 0b420739`) |
| Flutter `throttleDelay` default 1 s | `posthog_config.dart:919`, `change_detector.dart:43 @ 0b420739` |
| Flutter web replay needs "Canvas capture" | Dart skips capture on web, `posthog_widget.dart:199-202`, `native_communicator.dart:61-63 @ 0b420739` (canvas recording itself is posthog-js) |
| `captureLog` Android-only (RN docs) | **Contradicted by code**: iOS also sets `captureLogs` (`PosthogReactNativePlugin.swift:434-435 @ a3e9ec3d`) |

## 9. Questions asked and answers

1. **Is RN iOS forced to screenshot mode, and why?** Yes; Android too (§4.1). The repos contain no written rationale (no comment, ADR or changelog entry). My reading, labelled as such: posthog-ios wireframes come from typed UIKit views (`UILabel`, `UITextField`, `UIImageView`), but RN text is drawn by `RCTParagraphComponentView` / `ReactTextView` and most containers are `RCTViewComponentView` / `ReactViewGroup`. Wireframes would lose the text and images. The docs confirm only the outcome `[docs only]`.
2. **What happens when the JS session rotates?** On the next `getSessionId()`, native gets `endSession()` + `startSession(newId)`; native never rotates by itself for RN (§4.1). Frames captured by native between the JS rotation and that next read keep the old id.
3. **Is there any wireframe path for RN or Flutter?** No. The only "wireframe" in Flutter is the rrweb container for a screenshot (`type: "screenshot"`).
4. **Who encodes in Flutter?** Both. Dart encodes PNG and native **decodes and re-encodes** it to WebP (iOS q0.3 with JPEG fallback, Android q30). One lossless encode and one decode per frame are spent only to cross the channel (`SnapshotSender.kt:40-50`, `PosthogFlutterPlugin.swift:1235-1236 @ 0b420739`).
5. **Does the native replay integration run at all under Flutter?** Yes, minus its capture loop: touches (`UIApplication.sendEvent`), sampling, `$snapshot` batching and meta still come from it (`posthog-ios/PostHog/Replay/PostHogReplayIntegration.swift:324-336 @ 2b6b6b43`).
6. **Does RN gzip?** Not under Hermes / JSC (no `CompressionStream`), so `/batch/` and `/i/v1/logs` from JS go uncompressed. Native-sent replay is gzipped by the native SDK (§5).
7. **Native crashes in RN?** Yes, with `@posthog/react-native-plugin` and `errorTracking.autocapture.nativeCrashes` (plus `androidNdkCrashes`); no with the legacy plugin (§3).
8. **Any OTLP / OTel?** No OTel SDK dependency. Logs are OTLP/JSON to `/i/v1/logs` in both. Core has OTLP traces and metrics that RN does not use yet (§5).
9. **Lesser-known SDKs.**

   | SDK | Replay? | Technique |
   |---|---|---|
   | **Kotlin Multiplatform** (`PostHog/posthog-kmp`, 0.x) | Android and iOS only; web and JVM ignore it `[docs only]` | Thin layer over the native SDKs; **wireframe by default**, `screenshot = true` opt-in `[docs only]`. My reading: on iOS, Compose Multiplatform draws into one Skia/Metal view, so wireframe would be as empty there as it is for Flutter. posthog-android has `posthog-kmp` in its wrapper-SDK allow-list (`posthog-android/posthog-android/src/main/java/com/posthog/android/PostHogAndroid.kt:212-216 @ d91b3bc7`) |
   | **Unity** (`PostHog/posthog-unity`, official, v1.1.1) | Windows, Mac, Linux, iOS, Android; not WebGL `[docs]` | **Code-grounded:** pure C#. `ScreenCapture.CaptureScreenshotIntoRenderTexture` + `AsyncGPUReadback`, `EncodeToJPG(80)`, scale 0.75, throttle 1 s, **no masking** (`com.posthog.unity/Runtime/SessionReplay/ScreenshotCapture.cs:73,76,189,193`; `PostHogSessionReplayConfig.cs:16,23,51 @ 79b930c8`) |
   | **.NET** (`PostHog/posthog-dotnet`) | No `[docs only]` | Server/client analytics; MAUI is mentioned as a target, no replay |
   | **Capacitor** (Capawesome community plugin) | Not mentioned `[docs only]` | Not PostHog-maintained; flags unsupported |
   | Ionic / Cordova / Xamarin / Electron | No PostHog SDK listed `[docs only]` | n/a |

10. **Does masking in RN rely on `testID` or `nativeID`?** No. Only `accessibilityLabel="ph-no-capture"` (through `PostHogMaskView` or set by hand) is matched by the native maskers (Appendix D covers the matcher). `testID` is captured as an autocapture prop, not a mask marker (`autocapture.tsx:155`).

## 10. Takeaways for ouo (all sources MIT)

1. **Confirms ADR-0006 for React Native.** The vendor with the most to gain from wireframes still forces screenshots for RN. Wrapping the native SDK and handing it the session id is exactly PostHog's design. Copy the `collapsable={false}` trick for an `ouo-mask` wrapper view: without it, RN view flattening removes the marker view and masking silently fails.
2. **Make JS own the session id, and make the native SDK obey.** PostHog needed name-based special cases in both native SDKs (`postHogSdkName != "posthog-react-native"`) to stop native rotation. For ouo, put an explicit `externalSessionControl` mode in the native API from day one, rather than sniffing the host name. posthog-ios even has a "ponytail: host-name heuristic; replace with an explicit host mode" comment (`PostHogReplayIntegration.swift:1862 @ 2b6b6b43`). Also push rotation eagerly from JS instead of lazily on the next `getSessionId()`.
3. **Avoid PostHog's dual-SDK cost.** RN runs two full PostHog instances (two queues, two flag fetches). ouo's native module should be replay-only (plus crashes later). It should share the OTel resource and the `session.id` the JS SDK already sends, and should not start a second telemetry pipeline.
4. **Flutter needs Dart-side capture.** If ouo ever supports Flutter, capture and masking must live in Dart: `RepaintBoundary.toImage` at 1× logical pixels, a walk over `RenderParagraph` / `RenderEditable` / `RenderImage` for masks, painted before bytes leave Dart. Improve on PostHog in three ways:
   - Encode once: send raw RGBA or JPEG and skip PNG plus a native re-encode.
   - Hash a downsampled image or move hashing to a background isolate, instead of hashing 1.3 MB on the UI isolate every tick.
   - Skip the tree walk when the hash says the frame is unchanged.
5. **Wire size ballpark for planning** (derived, not measured).
   - One frame is 1 px per point, e.g. 393×852 on an iPhone 15, as WebP at quality 0.3. That is roughly **15–40 KB** per UI screen, or 20–55 KB as base64.
   - Gzip of base64 gives back about a quarter of that (estimate), so ≈ **15–40 KB on the wire per changed frame**.
   - Per minute: `changed_frames_per_min × bytes_per_frame`, capped at 60 frames/min at the 1 s throttle. A static screen sends ≈0 thanks to dedupe. Continuous change costs ≈1–2.4 MB/min, and a typical interactive session with 10–20 changed frames per minute costs ≈0.2–0.8 MB/min.
   - RN uses the same formula with native constants: iOS screenshot mode is also 1 px/pt WebP q0.3 (`posthog-ios/PostHog/Replay/RRWireframe.swift:66-71,116-119 @ 2b6b6b43`). Android uses **physical** pixels × `screenshotScale` (default 1.0) as WebP q30 (`posthog-android/.../PostHogSessionReplayConfig.kt:92,106 @ d91b3bc7`). At 1080×2400 that is about 7× the pixels of a dp-sized Flutter frame on the same phone, so it is worth matching ouo's half-resolution default.
   - The ADR-0006 estimate (20–40 KB per JPEG frame at half resolution) is in the same range.
6. **Logs over OTLP are a sign of convergence.** PostHog now emits OTLP/JSON logs (and core has OTLP traces and metrics) from these SDKs. ouo's "everything is OTLP" stance is where the market is moving. PostHog still keeps replay and analytics proprietary (`/batch/`, `$snapshot`), and ouo can stay OTLP for telemetry plus a replay-chunk side channel, as planned.
7. **Measure gzip availability on Hermes before relying on it.** PostHog's JS core silently sends uncompressed bodies on RN. ouo's RN telemetry path should compress natively (for example in the Expo module) or accept the bandwidth cost knowingly.
