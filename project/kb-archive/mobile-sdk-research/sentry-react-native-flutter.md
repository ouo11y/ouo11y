# Appendix C: Sentry for React Native (`@sentry/react-native`) and Flutter (`sentry_flutter`)

Written 2026-10-29. Question: do Sentry's cross-platform SDKs reuse the native replay technique, or change it?

**Short answer.**
- **React Native does not change the technique.** Replay is 100 % sentry-cocoa / sentry-android. The RN layer only passes options, adds mask classes and two marker views, converts JS breadcrumbs to rrweb events, and links replay ids to JS events.
- **Flutter changes the capture half.** Flutter draws everything into one surface, so a native view walk cannot find text or images. The Dart SDK takes the screenshot itself (`RenderRepaintBoundary.toImage`), masks it by walking the Flutter `Element` tree, and hands raw RGBA bytes to the native SDK. The native SDK still schedules (iOS), segments, encodes the mp4 and uploads. On Android the Dart side also schedules.

Other appendices go deeper on the native internals: [sentry-ios.md](sentry-ios.md) (A) and [sentry-android.md](sentry-android.md) (B). This file cites them rather than repeating them.

## 1. Sources

| Repo | Tag | Commit | Date |
|---|---|---|---|
| `getsentry/sentry-react-native` | `8.33.0` | `87468d75b86f58613fefb554926d0fc72b34f7cc` | 2026-10-29 |
| `getsentry/sentry-dart` | `10.2.0` | `0cae2754e301e09c781b5abbbfe3518d2215ef7b` | 2026-10-22 |

Both were cloned blob-less with history into the session scratchpad. Both are MIT and fully open: the JS, Dart, ObjC, Swift, Kotlin and Java glue all ship as source. The native SDKs come in as dependencies (section 2).

**Citation shorthand.** Every file reference carries the tag's commit:
- `rn:` = `sentry-react-native/packages/core/` @ `87468d7`
- `rnroot:` = `sentry-react-native/` @ `87468d7`
- `fl:` = `sentry-dart/packages/flutter/` @ `0cae275`
- `dart:` = `sentry-dart/packages/dart/` @ `0cae275`
- `dartroot:` = `sentry-dart/` @ `0cae275`
- `golden:` = this repo's `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/`. This is a real capture from `@sentry/react-native` 8.30.0 on sentry-cocoa 9.30.1 (`project/kb-archive/sentry-react-native-demo.md`).

**Docs used:**
- `docs.sentry.io/platforms/react-native/session-replay/performance-overhead/` (fetched 2026-10-29)
- `docs.sentry.io/platforms/dart/guides/flutter/session-replay/performance-overhead/` (fetched 2026-10-29)

## 2. Platforms and languages

| Layer | RN 8.33.0 | Flutter 10.2.0 |
|---|---|---|
| App-facing language | JS/TS (`@sentry/core` 10.77.1, `rn:package.json:91-96`) | Dart (`sentry` 10.2.0, `fl:pubspec.yaml:26`) |
| iOS native | sentry-cocoa **9.32.0**, prebuilt `Sentry.xcframework` downloaded from the GitHub release and SHA-256-checked (`rn:RNSentry.podspec:71-80`). SwiftPM manifest for RN ≥ 0.87 (`rn:Package.swift:1-6`). | sentry-cocoa **9.31.0** via SwiftPM `exact:` (`fl:darwin/sentry_flutter/Package.swift:19`) |
| Android native | `io.sentry:sentry-android:8.62.0` (`rn:android/build.gradle:188-193`) | `io.sentry:sentry-android:8.61.1` (`fl:android/build.gradle:65`) |
| Glue: iOS | ObjC++ `RNSentry.mm` plus Swift `RNSentryInternal.swift` (SPI access to the cocoa internals) | Swift `SentryFlutterPlugin.swift` plus ObjC `SentryFlutterReplayScreenshotProvider.m`, method channel |
| Glue: Android | Java `RNSentryModuleImpl.java` / `RNSentryStart.java` (TurboModule) | Kotlin `SentryFlutterPlugin.kt`, called from Dart through **JNI (jnigen)**, not a method channel (`fl:pubspec.yaml:31,50`, `fl:lib/src/native/java/binding.dart`) |
| Other targets | web (`@sentry/react` + rrweb `replayIntegration`), macOS, tvOS, visionOS samples (`rnroot:samples/`) | web (sentry-javascript via JS interop), macOS, Linux and Windows (sentry-native via FFI, `fl:lib/src/native/c/`) |
| Replay supported on | iOS and Android only. A no-op on web and in Expo Go (`rn:src/js/replay/mobilereplay.ts:366-378`). | iOS and Android only. `supportsReplay` is false on web, the C SDK and macOS (`fl:lib/src/web/sentry_web.dart:329`, `fl:lib/src/native/c/sentry_native.dart:305`, `fl:lib/src/native/cocoa/sentry_native_cocoa.dart:20`). |

The RN version → native versions table is kept up to date in `rnroot:SDK-VERSIONS.md:14-18`. For example, 8.30.0 maps to cocoa 9.30.1 and android 8.60.0, which matches the golden capture.

## 3. RUM: what each JS or Dart layer adds on top of native

### React Native

The default integration list is `rn:src/js/integrations/default.ts:60-199`. JS-side RUM pieces:

| Feature | Where | How |
|---|---|---|
| JS errors | `reactNativeErrorHandlersIntegration` (`default.ts:64-68`) | Wraps `ErrorUtils` and the Hermes promise rejection tracker. The Hermes single-tracker gotcha is in `project/kb-archive/ouo-next-to-sentry.md`. |
| Native crashes, ANR, app hangs | sentry-cocoa / sentry-android | Untouched. The JS side only pauses or resumes app-hang tracking (`rn:src/js/NativeRNSentry.ts:76-77`). |
| Sessions / release health | Native SDK | The JS `browserSessionIntegration` is web-only (`default.ts:75-77`). Session envelopes carry the `sentry.cocoa.react-native` SDK name (golden 000001). |
| App start | `appStartIntegration` (`default.ts:127-128`) | Calls `RNSentry.fetchNativeAppStart` (`rn:ios/RNSentry.mm:552`, which uses cocoa's `appStartMeasurementWithSpans`). It turns that into `app_start_cold` / `app_start_warm` on the first `ui.load` transaction and drops starts longer than 60 s (`rn:src/js/tracing/integrations/appStart.ts:73`). |
| Slow / frozen frames | `nativeFramesIntegration` | Calls `RNSentry.fetchNativeFrames` at span start and end with a 2 s timeout (`rn:src/js/tracing/integrations/nativeFrames.ts:14,103`). iOS reads cocoa's frames tracker (`rn:ios/RNSentry.mm:578-591`). **Android does not use sentry-android's tracker.** The RN module runs its own androidx `FrameMetricsAggregator` with hard-coded thresholds of > 16 ms slow and > 700 ms frozen (`rn:android/.../RNSentryModuleImpl.java:125-128,419-453,1012`). |
| JS stalls | `stallTrackingIntegration` | A 50 ms `setTimeout` loop. An iteration that takes ≥ 50 ms + 50 ms counts as a stall, recorded in `stall_count`, `stall_total_time` and `stall_longest_time` (`rn:src/js/tracing/integrations/stalltracking.ts:22,34,94-112`). |
| Navigation | `reactNavigationIntegration`, `reactNativeNavigationIntegration`, `expoRouterIntegration` (`rn:src/js/tracing/`) | Creates `ui.load` / `navigation` transactions. |
| TTID / TTFD | `<TimeToInitialDisplay>` / `<TimeToFullDisplay>` (`rn:src/js/tracing/timetodisplay.tsx:79,102`) | Renders a native `RNSentryOnDrawReporter` view, which reports the first native draw. The spans are `ui.load.initial_display` / `ui.load.full_display` (`timetodisplay.tsx:197-236`). |
| User interactions | `touchEventBoundary` (`rn:src/js/touchevents.tsx`) | `onTouchStart` builds a component path of at most 20 entries using the `sentry-label` prop, with category `touch` (`touchevents.tsx:93-97,183,204-210,240-256`). Also detects rage taps (`rn:src/js/ragetap.ts`). `userInteractionIntegration` adds `ui.action` spans. |
| Network | `fetch` / XHR instrumentation from `@sentry/core` | Creates `http.client` spans only inside an active span (`project/kb-archive/ouo-next-to-sentry.md`). |
| Profiling | `hermesProfilingIntegration` | Hermes sampling profiler started natively (`rn:ios/RNSentry.mm:1081-1087`). Profiles are capped at 30 s (`rn:src/js/profiling/constants.ts:1`). |
| Feedback | `rn:src/js/feedback/` | Form widget, screenshot button, shake-to-report (`NativeRNSentry.ts:74-75`). |

The `RNSentry` native module surface is about 60 methods (`rn:src/js/NativeRNSentry.ts:13-77`):
- envelope: `captureEnvelope`
- scope sync: `addBreadcrumb`, `setUser`, `setTag`, `setContext`, …
- app start and frames: `fetchNativeAppStart`, `fetchNativeFrames`, `fetchNativeFramesDelay`
- replay control: `captureReplay`, `getCurrentReplayId` (a **synchronous** bridge call, `rn:ios/RNSentry.mm:1063`), `startReplay`, `stopReplay`, `pauseReplay`, `resumeReplay`, `flushReplay`, `registerReplayTraceId`
- profiling, view hierarchy, screenshots, TTID (`popTimeToDisplayFor`).

### Flutter

The default integration list is `fl:lib/src/sentry_flutter.dart:187-273`.

| Feature | Where | How |
|---|---|---|
| Dart errors | `FlutterErrorIntegration` wraps `FlutterError.onError` (`fl:lib/src/exception/flutter_error_integration.dart:29,104`). `OnErrorIntegration` wraps `PlatformDispatcher.onError` (`fl:lib/src/exception/on_error_integration.dart:43,66`). | `IsolateErrorIntegration` is added first for the root isolate (`dart:lib/src/sentry.dart:107`). Other isolates opt in with `Isolate.addSentryErrorListener()` (`dart:lib/src/isolate/sentry_isolate_extension.dart:18-20`). `RunZonedGuardedIntegration` wraps `appRunner` (`dart:lib/src/sentry.dart:187-199`). |
| Native crashes, ANR, sessions | sentry-cocoa / sentry-android | `NativeSessionIntegration` on Android, iOS and macOS (`sentry_flutter.dart:212-214`). |
| Dart symbolication | Server-side | `enableDartSymbolication = false` whenever a native SDK is present (`sentry_flutter.dart:244`). Stack frames are symbolicated by Sentry with debug images that `createLoadDebugImagesIntegration` loads from native (`sentry_flutter.dart:218`). |
| App start | `StandaloneAppStartIntegration` on iOS and Android (`sentry_flutter.dart:224-233`) | Calls `native.fetchNativeAppStart()` (`fl:lib/src/app_start/standalone/standalone_app_start_handler.dart:89`). Drops starts older than 60 s (`fl:lib/src/app_start/app_start_timing.dart:13,40`). `GenericAppStartIntegration` (desktop and web) only records TTID on the first post-frame callback (`fl:lib/src/app_start/generic_app_start_integration.dart:39`). There is no class called `NativeAppStartIntegration` in 10.2.0. |
| Routes | `SentryNavigatorObserver` (`fl:lib/src/navigation/sentry_navigator_observer.dart:77`) | Navigation breadcrumbs plus `ui.load` transactions that auto-finish after 3 s (`:82`). TTID / TTFD via `SentryDisplayWidget` (`fl:lib/src/navigation/sentry_display_widget.dart:68`) and the `time_to_*_display_tracker.dart` files. |
| Frames | `FramesTrackingIntegration` (`sentry_flutter.dart:223`) | Needs `SentryWidgetsFlutterBinding` (`fl:lib/src/bindings/binding_wrapper.dart:48`). A `Stopwatch` times `handleBeginFrame` → `handleDrawFrame`, which is **UI-thread build time only, not raster time** (`binding_wrapper.dart:160-193`). The expected frame time comes from the native display refresh rate (`fl:lib/src/frames_tracking/frames_tracking_integration.dart:135-140`). Slow means longer than the expected duration; frozen means ≥ 700 ms (`fl:lib/src/frames_tracking/sentry_delayed_frames_tracker.dart:20,195-202`). At most 3600 delayed frames are buffered (`:17`). |
| User interaction | `SentryUserInteractionWidget`, wrapped by `SentryWidget` (`fl:lib/src/sentry_widget.dart:42-43`) | Adds a `ui.click` breadcrumb with `path` and `label` (`fl:lib/src/user_interaction/sentry_user_interaction_widget.dart:355-371`). |
| Screenshot on error | `ScreenshotIntegration` (`sentry_flutter.dart:255`) | Uses the same Dart `ScreenshotRecorder` and masking as replay, encodes **PNG** (`fl:lib/src/screenshot/screenshot_event_processor.dart:110`). Target resolution: full = device pixel ratio, high 1920, medium 1280, low 854 (`fl:lib/src/screenshot/sentry_screenshot_quality.dart:8-20`). |
| Packages | `dartroot:packages/` | `dio`, `drift`, `file`, `firebase_remote_config`, `grpc`, `hive`, `isar`, `link`, `logging`, `sqflite`, `supabase`. Each one wraps the library and creates spans and breadcrumbs. |

## 4. Session replay

### 4.1 React Native: the native SDK does everything

**Configuration only.** `mobileReplayIntegration` is added automatically when `replaysSessionSampleRate` or `replaysOnErrorSampleRate` is set (`rn:src/js/integrations/default.ts:184-187`). Its options are serialised into `initNativeSdk` as `mobileReplayOptions` (`rn:src/js/client.ts:264`).

JS options and defaults (`rn:src/js/replay/mobilereplay.ts:47-318`):
- masking: `maskAllText`, `maskAllImages`, `maskAllVectors` (all `true`), `maskedViewClasses`, `unmaskedViewClasses`
- iOS renderer: `enableViewRendererV2` (`true`), `enableFastViewRendering` (`false`), `includedViewClasses`, `excludedViewClasses`
- Android: `screenshotStrategy` (`pixelCopy`), `captureSurfaceViews`
- network detail: `networkDetailAllowUrls`, …
- error sampling: `beforeErrorSampling`
- `avoidForegroundResumeHang` (iOS stopgap)

`replaysSessionQuality` (`rn:src/js/options.ts:570`) has default `medium`.

**What native receives.** iOS (`rn:ios/RNSentryReplay.mm:14-56`) builds the `sessionReplay` dictionary that cocoa's `SentryReplayOptions(dictionary:)` parses. It contains the sample rates, the quality enum, the mask flags, the class lists, and **`sdkInfo = sentry.javascript.react-native`**. That is why the envelope header `sdk.name` of almost every `replay_video` item in the golden capture is the JS name, not cocoa's (golden journey 000004…000036; `project/kb-archive/sentry-react-native-demo.md`). Android does the same with `new SentryReplayOptions(false, replaySdkVersion)` (`rn:android/.../RNSentryStart.java:441-547`).

**RN class names to mask** (question 2). The list lives **in the RN SDK**, not in sentry-cocoa or sentry-java:

```objc
// rn:ios/RNSentryReplay.mm:62-76 @ 87468d7
if ([replayOptions[@"maskAllVectors"] boolValue] == YES) {
    [classesToRedact addObject:@"RNSVGSvgView"];
}
if ([replayOptions[@"maskAllImages"] boolValue] == YES) {
    [classesToRedact addObject:@"RCTImageView"];
    // New Architecture (Fabric) renders <Image> as RCTImageComponentView ...
    [classesToRedact addObject:@"RCTImageComponentView"];
}
if ([replayOptions[@"maskAllText"] boolValue] == YES) {
    [classesToRedact addObject:@"RCTTextView"];
    [classesToRedact addObject:@"RCTParagraphComponentView"];
}
```

| What | Old architecture (iOS) | Fabric (iOS) | Android (both) |
|---|---|---|---|
| Text | `RCTTextView` | `RCTParagraphComponentView` | Nothing RN-specific. sentry-android's `maskAllText` masks `TextView` subclasses, and RN's text view is one ([sentry-android.md](sentry-android.md)). |
| Image | `RCTImageView` | `RCTImageComponentView` (neither a `UIImageView` subclass nor named `RCTImageView`, per the comment in `RNSentryReplay.mm:67-70`) | sentry-android's `maskAllImages` |
| Vector | `RNSVGSvgView` | `RNSVGSvgView` | `com.horcrux.svg.SvgView` (`RNSentryStart.java:479-484`) |
| User | `maskedViewClasses` / `unmaskedViewClasses`, appended (`RNSentryReplay.mm:81-88`; `RNSentryStart.java:486-503`) | same | same |

Both class names are always sent on iOS. Cocoa resolves them with `NSClassFromString`, so the one that does not exist in the running architecture is silently dropped (`RNSentryReplay.mm:67-71,79-80`).

**`<Mask>` / `<Unmask>`.** These are JS components backed by the native views `RNSentryReplayMask` / `RNSentryReplayUnmask`. They fall back to a plain `<View>` with a `console.warn` in Expo Go or when the view manager is missing (`rn:src/js/replay/CustomMask.tsx:13-65`). Natively they are empty container views: `ReactViewGroup` on Android (`rn:android/.../replay/RNSentryReplayMask.java:6`), a Fabric or Paper `UIView` on iOS (`rn:ios/Replay/RNSentryReplayMask.mm:15-40`).

They are **not** wired through `sentryReplayMask` or `sentry-mask` tags, contrary to the brief's assumption. They are registered as **container classes**:
- iOS: `RNSentryInternalWrapper setReplayRedactContainerClass:` / `setReplayIgnoreContainerClass:`, which calls `SentrySDK.internal.replay.setRedactContainerClass` (`rn:ios/RNSentryReplay.mm:93-100`, `rn:ios/Swift/RNSentryInternal.swift:183-189`).
- Android: `setMaskViewContainerClass(RNSentryReplayMask.class.getName())` (`RNSentryStart.java:543-544`).

So "everything inside this view is masked or unmasked" is decided by the native view walk.

**Replay quality.** iOS maps `low|medium|high` to `SentryReplayQuality` (`rn:ios/RNSentryReplayQuality.m:6-23`). **Android ignores `replaysSessionQuality`.** There is no `quality` key anywhere under `rn:android/src/main` (grep), so Android RN replays always use sentry-android's default (medium).

**Touches and breadcrumbs into the replay** (question 3).
1. Native touch events (rrweb `type 3`, `source 2` / `6`) are recorded by the native SDK, because RN views are real `UIView`s and `View`s (`project/kb-archive/sentry-replay-taps.md`).
2. JS breadcrumbs (`touch`, `navigation`, `xhr`, `console`, …) are copied to the native scope on every `scope.addBreadcrumb` (`rn:src/js/scopeSync.ts:98-113`).
3. The native replay converts scope breadcrumbs to rrweb events through an RN-specific converter, installed in `postInit` on iOS (`RNSentryReplay.mm:99`) and with `setBreadcrumbConverter` on Android (`RNSentryStart.java:227`).

What the converter does (`rn:ios/RNSentryReplayBreadcrumbConverter.m:19-84`):

| JS breadcrumb | rrweb result |
|---|---|
| `touch` | `ui.tap`, message from the first four path entries |
| `ui.multiClick` | kept |
| `navigation` | kept |
| `xhr` | `resource.http` span event with sizes, status and sanitised bodies (`:160-207`) |
| native `http` | dropped (avoids duplicates) |
| `sentry.event`, `sentry.transaction` | dropped |
| native navigation | dropped |

Network bodies are read in JS, so the sync to native is deferred until the body is resolved (`mobilereplay.ts:676-709`).

**Replay id into JS events** (question 3):
- **Errors:** a wrapped `beforeSend` reads `NATIVE.getCurrentReplayId()` (fresh, not cached) and sets `contexts.replay.replay_id` (`mobilereplay.ts:447-493,711-726`). The buffered replay is flushed with `NATIVE.captureReplay(isHardCrash)` only in `afterSendEvent`, so errors dropped by `sampleRate` never upload a replay (`mobilereplay.ts:429-445,495-524,731-735`).
- **Transactions:** they never get `contexts.replay`, because `beforeSend` only handles exceptions (`:448-452`). They get the id through the DSC hook: `client.on('createDsc')` writes `dsc.replay_id` from a **JS-side cache** (`mobilereplay.ts:643-653`). That cache becomes the envelope `trace.replay_id`.
- **Metrics:** get `attributes.replay_id` (`:655-662`).
- **Trace search:** trace ids of sent events are forwarded so the segment's `trace_ids` covers them (`rn:src/js/replay/replayTraceIds.ts:16-21`).

**Cause of the stale `trace.replay_id` after background rotation** (`project/kb-archive/sentry-react-native-demo.md`, golden journey n=27 and n=29):

```ts
// rn:src/js/replay/mobilereplay.ts:405-414 @ 87468d7
function getCachedReplayId(): string | null {
  if (cachedReplayId !== null) {
    return cachedReplayId;
  }
  const nativeReplayId = NATIVE.getCurrentReplayId();
  if (nativeReplayId) {
    cachedReplayId = nativeReplayId;
  }
  return nativeReplayId;
}
```

The cache is filled at `setup` (`:637`) and invalidated only by JS-initiated controls: `start`, `startBuffering`, `stop`, `flush`, the feedback flush, and the foreground guard (`:397-427,553-556,751-765`). When the native SDK rotates the session and replay after more than 30 s in the background, nothing tells JS. Every later DSC, and so every later transaction, keeps the old id until something invalidates the cache. Error events are correct because they call `NATIVE.getCurrentReplayId()` directly (`:475`).

The bug is present in 8.30.0 (`git show 8.30.0:packages/core/src/js/replay/mobilereplay.ts`, lines 382-402 and 536) and still in 8.33.0. A fix would invalidate the cache on an `AppState` change to `active`. The existing `foregroundReplayGuard.ts` already listens to `AppState`, but only when `avoidForegroundResumeHang` is set (`rn:src/js/replay/foregroundReplayGuard.ts:187-196`).

### 4.2 Flutter: Dart captures and masks, native encodes

Why Flutter cannot use the native path: a Flutter screen is a single `FlutterView` (a Metal or GL surface on iOS; a `SurfaceView` or `TextureView` on Android). There are no `UILabel`, `UIImageView` or `TextView` objects to find. A native screenshot would show the pixels, but the native view walk cannot tell where text or images are, so it could not mask. Sentry therefore keeps the native video pipeline and swaps the capture step.

**Capture** (`fl:lib/src/screen_capture/recorder.dart:57-157`):
- `SentryWidget` wraps the app in `SentryScreenshotWidget`, which is a `RepaintBoundary` with a global key (`fl:lib/src/sentry_widget.dart:41-44`, `fl:lib/src/screen_capture/sentry_screenshot_widget.dart:7,134`). It is disabled in multi-view apps (`sentry_widget.dart:35`).
- `capture()` is deliberately synchronous until both the image future and the mask list exist, so the mask coordinates match the frame (`recorder.dart:51-57`). It calls `RenderRepaintBoundary.toImage(pixelRatio)` (`:140-143`), then `WidgetFilter.obscure` (`:145-157`).
- Asynchronously, it draws the image into a `PictureRecorder` canvas, paints opaque rectangles over the masked bounds (`:229-297`) and makes a second `Image` (`picture.toImage(width, height)`, `:267`).

So each frame is **two GPU readbacks plus one `toByteData`**. There is also an extra `toByteData()` before the draw, kept as a workaround for corrupted frames (`:240-249`).

**Masking in Dart** (`fl:lib/src/screen_capture/sentry_privacy_options.dart:31-133`, `widget_filter.dart:26-186`). Rules are checked first match wins (`masking_config.dart:16-52`, `widget is T`):
1. user rules (`privacy.mask<T>()`, `unmask<T>()`, `maskCallback<T>()`)
2. `SentryMask` → mask, `SentryUnmask` → unmask (`fl:lib/src/screen_capture/sentry_mask_widget.dart`, `sentry_unmask_widget.dart`)
3. `Image`: mask, except built-in asset images unless `maskAssetImages` is set. `isBuiltInAssetImage` checks that the provider is an `AssetImage` or `ExactAssetImage` from the root bundle (`sentry_privacy_options.dart:50-63,202-210`, `widget_filter.dart:205-220`).
4. `Text`, `EditableText`, `RichText` → mask when `maskAllText` (`:71-84`)
5. Flutter's `SensitiveContent` widget → mask unless `notSensitive` (`:86-92,212-227`)
6. Debug builds only: a warning for widget type names matching `video|webview|password|pinput|camera|chart`. It only warns: there is no masking by name, because release builds are obfuscated (`:96-129`).

The walk is breadth-first over the `Element` tree. It skips invisible `Visibility`, `Opacity(0)` and `Offstage` subtrees and stops descending at the first decision (`widget_filter.dart:45-88,190-200`). The mask rectangle is `paintBounds` transformed to the root and clipped by a clipping `RenderStack` parent. Its colour is **the text's own colour**, or the theme's primary colour, made opaque (`:124-185`). Masks therefore look like coloured bars, not black boxes. If a widget cannot be measured, the parent is masked instead (`:95-117`).

**Hand-off to native**, which differs per OS:

| | iOS | Android |
|---|---|---|
| Who schedules | **sentry-cocoa.** Its replay timer calls the provider's `imageWithView:onComplete:`. | **Dart.** `ScheduledScreenshotRecorder` with `Scheduler`: next capture `interval` after the previous one finishes, on a post-frame callback. It never overlaps captures, so the rate drops under load (`fl:lib/src/replay/scheduler.dart:7-89`). Captures only while `AppLifecycleState.resumed` (`scheduled_recorder.dart:83-123`). |
| Native hook | `SentryFlutterReplayScreenshotProvider` implements cocoa's screenshot provider. It is installed with `SentrySDK.internal.replay.configure(breadcrumbConverter:screenshotProvider:)` (`fl:darwin/.../SentryFlutterPlugin.swift:396-406`). | The default `ReplayIntegration` is removed and rebuilt with `recorderProvider = SentryFlutterReplayRecorder`, an implementation of sentry-android's `Recorder` interface whose `start`, `pause`, `stop` and `onConfigurationChanged` forward to Dart (`fl:android/.../SentryFlutterPlugin.kt:274-305`, `SentryFlutterReplayRecorder.kt:12-89`). |
| Transport of pixels | The method channel call `captureReplayScreenshot` goes native → Dart. Dart copies the RGBA bytes into `malloc` memory and returns only `{address, length, width, height}`. Native wraps the memory with `dataWithBytesNoCopy … freeWhenDone:TRUE` and builds a `CGImage` with premultiplied RGBA (`fl:darwin/.../SentryFlutterReplayScreenshotProvider.m:24-103`, `fl:lib/src/native/cocoa/cocoa_replay_recorder.dart:24-38`, `fl:lib/src/native/native_memory.dart:17,51`). | A Dart worker isolate gets the bytes as `TransferableTypedData` (no copy through the port). Over JNI it copies them into a reused `ARGB_8888` `Bitmap` with `copyPixelsFromBuffer` and calls `ReplayIntegration.onScreenshotRecorded(bitmap)` (`fl:lib/src/native/java/android_replay_recorder.dart:71-196`). |
| Size | `pixelRatio = quality.resolutionScalingFactor`, i.e. **logical points × 1.0** (medium and high) or × 0.8 (low) (`cocoa_replay_recorder.dart:17-21`, `fl:lib/src/replay/replay_quality.dart:4-7`). | `width = factor × logical width`, both sides rounded to the nearest multiple of 16 for the codec (`fl:lib/src/replay/replay_integration.dart:57-68`, `fl:lib/src/native/java/sentry_native_java.dart:336-372,481-484`). |
| Cadence | cocoa's 1 fps ([sentry-ios.md](sentry-ios.md)) | `frameRate` from `ReplayConfig`, default 1 (`fl:lib/src/replay/replay_config.dart:23`). It goes into the native `ScreenshotRecorderConfig` and comes back to Dart (`sentry_native_java.dart:363-372`). |
| Pixel format | raw RGBA, premultiplied (`ImageByteFormat.rawRgba`, `fl:lib/src/screen_capture/screenshot.dart:30-32`) | same |
| Encoder and segments | sentry-cocoa (mp4, h264) | sentry-android (`MediaCodec`) |
| Breadcrumb converter | `SentryFlutterReplayBreadcrumbConverter.m` | `SentryFlutterReplayBreadcrumbConverter.kt`: `ui.click` → `ui.tap`, `http` → `resource.http`, navigation only with a `to` (`:25-45`) |

Sentry's `quality` maps to native `SentryReplayQuality` LOW, MEDIUM and HIGH on Android (`fl:lib/src/native/java/sentry_native_java_init.dart:305-320`) and is passed through the init dictionary on iOS (`fl:lib/src/native/sentry_native_channel.dart:88-89`). In Flutter, medium and high therefore differ only in the native encoder bitrate, not in the captured resolution.

**No dedupe in Dart.** `Screenshot.hasSameImageAs` exists (`screenshot.dart:49-54`) but nothing in replay calls it. Every scheduled capture is transferred. The idle-frame filler is commented out (`scheduled_recorder.dart:179-244`).

**Replay ids in Flutter.** On iOS, every screenshot request carries `replayId` and `replayIsBuffering`, and Dart updates `scope.replayId` on each frame (`fl:lib/src/native/cocoa/sentry_native_cocoa.dart:31-52`). So Flutter cannot have RN's stale-cache bug on iOS: the id is refreshed at the replay's own 1 fps. Errors and feedback trigger `captureReplay()` from an `OnBeforeSendEvent` lifecycle hook, after sampling (`fl:lib/src/replay/replay_integration.dart:37-44,89-113`).

## 5. Transport and OpenTelemetry

| | RN | Flutter |
|---|---|---|
| Who sends JS / Dart events | Native. `NativeTransport` (buffer of 30, `rn:src/js/transports/native.ts:13-35`) serialises the envelope in JS, **base64-encodes it** and calls `RNSentry.captureEnvelope` (`rn:src/js/wrapper.ts:240-279`). Native `capture`s it, or `store`s it to disk for a hard crash (`rn:ios/RNSentry.mm:629-647`). | Native. `FileSystemTransport` serialises in Dart and calls `native.captureEnvelope(bytes)` (`fl:lib/src/transport/file_system_transport.dart:14-20`). This is the default whenever a native binding exists (`sentry_flutter.dart:150-154`). iOS uses a method channel (`fl:lib/src/native/sentry_native_channel.dart:134-143`); Android uses JNI on a worker isolate (`sentry_native_java.dart:100-102`). Web uses `JavascriptTransport`. Dart-only apps use `dart:`'s `HttpTransport`. |
| Who sends replay, sessions, native crashes | The native SDK, gzip, `X-Sentry-Auth` header (`project/kb-archive/sentry-react-native-demo.md`) | The native SDK |
| Offline cache and retries | The native SDK's envelope cache | The native SDK's envelope cache |
| OTLP / OpenTelemetry export | **None.** `git grep -i 'otlp\|opentelemetry'` finds only a base64 GIF. | **None.** It finds only semconv doc comments (`dart:lib/src/constants.dart:428-448`, `dart:lib/src/protocol/sentry_runtime.dart:69`) and the generated JNI binding for sentry-java's `setOpenTelemetryMode` (`fl:lib/src/native/java/binding.dart:23156`). |

Trace propagation from Dart into native goes through `NativeTraceSyncIntegration` → `InternalSentrySdk.setTrace` (`sentry_native_java.dart:378-392`), so native spans and crashes share the Dart trace id. RN does the same with `setCurrentScopePropagationContext` (`NativeRNSentry.ts:72`).

## 6. Other features

- **Replay ↔ errors and feedback.**
  - RN uploads the buffer when the feedback widget opens and links the id at submit (`mobilereplay.ts:526-622`).
  - Flutter flushes on error events and on non-widget feedback (`replay_integration.dart:89-101`).
- **Network detail in replay.**
  - RN captures headers and bodies in JS (bodies up to about 150 KB) for allow-listed URLs. Native only gets the URL lists so it emits the rrweb `options` event (`mobilereplay.ts:202-274`, `RNSentryReplay.mm:44-51`).
  - Flutter has `network_details_capture.dart` (`fl:lib/src/replay/`).
- **Expo.**
  - The config plugin `@sentry/react-native/app.plugin.js` (`rn:plugin/src/withSentry.ts`) adds the sentry-cli source-map phase and the "Upload Debug Symbols to Sentry" phase, honours `disableAutoUpload`, and has an optional Android Gradle plugin (`rn:plugin/src/withSentryIOS.ts:13-44`, `withSentry.ts:20-23,71-82`).
  - In **Expo Go**, replay and the Mask components degrade to no-ops, because no custom native code can load (`mobilereplay.ts:367-378`, `CustomMask.tsx:42,55`).
- **Metro.** `sentryMetroSerializer` injects a debug id into each bundle and its source map (`//# debugId=`, `rn:src/js/tools/sentryMetroSerializer.ts:19-35`). Hermes bytecode stack traces are symbolicated against that.
- **New architecture.** Fabric class names in the mask list (section 4.1). Codegen native components for Mask and Unmask (`rn:src/js/RNSentryReplayMaskNativeComponent.ts`). A TurboModule perf logger (`rn:cpp/SentryTurboModulePerfLogger.cpp`). SwiftPM autolinking for RN ≥ 0.87 (`rn:Package.swift`).
- **Profiling.** Hermes sampling profiler (RN). UI profiling through the native SDKs (`rn:src/js/profiling/uiProfilingIntegration.ts`).

## 7. Performance footprint

### Vendor numbers

**`[docs only]`, React Native page.** The devices are an iPhone 14 Pro and a Pixel 2 XL. The app is **Pocket Casts native iOS and Android**, not an RN app. Full masking, release builds, the same flow run 10 times.

| | iOS without → with replay | Android without → with replay |
|---|---|---|
| FPS | 55 → 53 | 55 → 54 |
| Memory | 102 → 121 MB | 255 → 265 MB |
| CPU | 4 → 13 % | 36 → 42 % |
| Cold start | 1264.80 → 1265 ms | 1533.35 → 1539.55 ms |
| Main thread time | 43 ms | 20 ms |
| Network | 10 KB/s | 7 KB/s |

These are the native SDK numbers re-published on the RN page. They do not measure the RN layer (JS breadcrumb sync, base64 bridge).

**`[docs only]`, Flutter page.** The app is Open Food Facts (smooth-app). Default masking, release builds, 10 runs.

| | iPhone X, iOS 16.7.10 (`py-ios-device`) | Pixel Fold 2023, Android 15 |
|---|---|---|
| CPU | 30.04 → 31.92 % | total 93.2 → 105.5 % (UI thread 30.7 → 30.7 %) |
| FPS | not reported | 42.6 → 42.6 |
| Memory | 193 → 193 MiB | 372.5 → 391.6 MB |

Neither page names the SDK versions.

### How Sentry measures in CI

- **RN `performance-tests/`.** It existed until 2026-10-16. Commit `52ff298c` "Remove app metrics job and performance-tests (#6896)" deleted it; the last tree is `34c69ac8`.
  - Harness: `TestAppPlain` against `TestAppSentry`. The Sentry app is `Sentry.init({dsn})` plus `Sentry.wrap(App)` around an empty `<View/>`, **with no replay and no tracing** (`performance-tests/TestAppSentry/App.tsx @ 34c69ac8`).
  - Runner: `getsentry/action-app-sdk-overhead-metrics` on Sauce Labs devices.
  - Thresholds, iOS: 50 runs, startup diff −3000…150 ms, binary diff 600 KiB…1875 KiB (`performance-tests/metrics-ios.yml @ 34c69ac8`).
  - Thresholds, Android: 50 runs, startup diff −20…150 ms, binary diff 1 MiB…6.1 MiB (`metrics-android.yml`).
  - Replacement: size gating moved to Sentry Size Analysis (`rnroot:.github/workflows/size-analysis.yml`). The startup gate was dropped, "as in sentry-cocoa and sentry-dart" (commit message).
- **sentry-dart `metrics/`.**
  - Same design: `flutter create` a plain app and a with-Sentry app, where the Sentry app only calls `SentryFlutter.init(dsn)` (`dartroot:metrics/prepare.sh:10-45`). Thresholds: 50 runs, startup diff −25…150 ms, binary diff 900–1450 KiB on Android and 350–800 KiB on iOS (`dartroot:metrics/metrics-android.yml`, `metrics-ios.yml`).
  - The only workflow still running is the Dart console executable size check, threshold 13.1 MB (`dartroot:.github/workflows/metrics.yml:20-40`). `git grep` found no workflow that uses `metrics-ios.yml` or `metrics-android.yml`. The mobile jobs were removed in `e77adf4e` "ci: Remove Collect App Metrics jobs (#4091)"; they had been added in `3e5ee375` (#1034).
  - `fl:microbenchmarks/` has on-device benchmarks run with `flutter run --profile`: `toImage`, `toByteData` per format, image→picture, picture→image, canvas obscure, JNI, envelope building, memory (`fl:microbenchmarks/lib/src/image_bench.dart:14-52`). No results are checked in.
- **Replay overhead is not gated in CI in either repo.** It only appears in the docs tables above.

### Estimates from the code (Flutter)

Per replay frame at 1 fps, medium quality:

| Device (logical size) | Captured size | Raw RGBA per frame |
|---|---|---|
| iPhone 18 Pro, 402 × 874 pt | 402 × 874 | 1,405,392 B ≈ **1.34 MiB** |
| Same, low quality (× 0.8) | 322 × 699 | ≈ 0.86 MiB |
| Android, 412 × 915 dp | 416 × 928 after block rounding | ≈ **1.47 MiB** |

Each frame costs:
- two `toImage` GPU readbacks (raw boundary, then the masked picture), one extra `toByteData` (workaround) and one `rawRgba` `toByteData`, all in the UI isolate;
- an Element-tree walk on the UI thread inside the frame.

On iOS one `malloc` copy crosses to native with zero further copies. On Android a worker isolate does one JNI copy into a reused Bitmap. In both cases the native encoder then compresses to the same mp4 sizes as native apps. Before encoding, that is about 1.4 MB/s of memory traffic per second of recording, compared with a few KB/s on the wire.

PNG is used only for error screenshots (`screenshot_event_processor.dart:110`), never for replay. Raw RGBA avoids a CPU PNG encode and decode on every frame, at the price of a much larger buffer.

## 8. Blog and docs claims, and the code behind them

| Claim | Grounding |
|---|---|
| "RN Session Replay uses the native SDKs" `[docs only]` | `mobilereplay.ts` has no capture code. All controls are `NATIVE.*` (`:746-765`). Options are forwarded (`RNSentryReplay.mm:14-56`, `RNSentryStart.java:441-547`). |
| "View renderer V2 is up to 4–5× faster, ~160 ms → ~36 ms per frame" | Only restated in the RN option doc (`mobilereplay.ts:84-96`), which links to sentry-cocoa PR #4940. Grounded in [sentry-ios.md](sentry-ios.md). Default `true` (`:310`). |
| "Flutter masks text and images by default; asset images can stay visible" `[docs only]` | `sentry_privacy_options.dart:15-23,50-84` |
| "Replay is not supported in Expo Go" `[docs only]` | `mobilereplay.ts:367-378` |
| Overhead tables (section 7) | No code or harness in either repo: manual runs per the docs. The RN table is a native app. |

## 9. Questions asked and answers

1. **Does any RN JS code take screenshots for replay?** No. `src/js/replay/` holds only options, id linking, network enrichment and Mask components (`rn:src/js/replay/*`). Web uses rrweb through `browserReplay.ts`.
2. **Where is the RN mask class list?** In the RN SDK: `RNSentryReplay.mm:58-91` (iOS) and `RNSentryStart.java:472-503` (Android, vectors only plus user classes).
3. **Are `<Mask>` / `<Unmask>` tags or classes?** Container classes registered with the native SDK (`RNSentryReplay.mm:93-100`, `RNSentryStart.java:543-544`), not `sentryReplayMask` or `sentry-mask` tags.
4. **Does `replaysSessionQuality` apply on Android RN?** No. Only iOS reads it (`RNSentryReplay.mm:27,35`). There is no key under `rn:android/src/main`.
5. **Why do `replay_video` envelopes from RN carry `sdk.name = sentry.javascript.react-native`?** RN passes its own `sdkInfo` into the native replay options (`RNSentryReplay.mm:52-53`, `RNSentryStart.java:442-448`). The one segment flushed natively after a crash, before JS started, has `sentry.cocoa.react-native` (golden journey 000032). It also contains `navigation` and `sentry.transaction` breadcrumbs that the RN converter would drop. That fits the RN converter not being installed yet: it is installed in `postInit`, `RNSentryReplay.mm:99`.
6. **Why the stale `trace.replay_id` on transactions?** The JS `cachedReplayId` is not invalidated on native session rotation (`mobilereplay.ts:405-414,643-653`). Section 4.1 has the detail.
7. **Do transactions carry `contexts.replay`?** No, only errors (`mobilereplay.ts:448-452`). This matches the golden capture.
8. **Does an error dropped by sampling still upload a replay?** Not since the split between `beforeSend` and `afterSendEvent` (`mobilereplay.ts:429-445,731-735`). The tradeoff: the event may link to a replay that the native on-error roll never uploads (`:441-445`).
9. **How do JS breadcrumbs reach the replay?** Scope sync → native scope → RN converter (`scopeSync.ts:98-113`, `RNSentryReplayBreadcrumbConverter.m:19-64`).
10. **What does the RN layer add per segment on the wire?** Measured over 77 segments in `golden:`, compact JSON sizes:
    - Per segment: rrweb `meta` 80 B and `video` 279 B (native); `replay_event` median 1701 B.
    - Breadcrumbs from JS: `fetch` 271 B each, `console` 293 B median (max 622), `ui.tap` 731 B median (component path, max 837), app action breadcrumbs 185 B.
    - Native touch events: 118 B (start or end), 167 B (move).
    - `options` event: 346 B on segment 0.
    - A busy segment carries about 1–5.5 KB of recording JSON next to a 5.8–50 KB mp4 (golden journey 000023 to realtap 000011). A quiet segment carries about 380 B. The video bytes are left to the native appendices.
11. **Is the Flutter replay image PNG or raw?** Raw premultiplied RGBA (`screenshot.dart:30-32`, `SentryFlutterReplayScreenshotProvider.m:57-80`).
12. **Who schedules Flutter captures?** sentry-cocoa on iOS (pull through the method channel), Dart on Android (push through JNI) (section 4.2).
13. **Does Flutter go through method channels for pixels?** On iOS only the call and a pointer cross the channel. The pixels go through `malloc` memory that native frees (`native_memory.dart:17,51`). On Android JNI is used, not channels.
14. **Does Flutter dedupe identical frames?** Not in Dart (section 4.2). Whatever the native encoder does applies.
15. **Do Flutter frame metrics include raster time?** No. They measure only `handleBeginFrame`→`handleDrawFrame` on the UI thread (`binding_wrapper.dart:160-193`).
16. **OTLP anywhere?** No (section 5).
17. **Is replay overhead measured in Sentry's CI?** No. CI only checks startup and size for init-only apps, and the RN mobile gate was deleted in October 2026 (section 7).
18. **Open, not verified here:** does sentry-android's `maskAllText` cover RN's newer Android text views that do not extend `TextView` (for example a prepared-layout text view)? RN adds no Android text class (`RNSentryStart.java:472-503`), so this depends on sentry-java. Left to [sentry-android.md](sentry-android.md).

## 10. Takeaways for ouo

1. **ADR-0006 is confirmed for React Native.** Sentry's RN replay is the native SDK plus a thin options and class-name layer. ouo's `@ouo/react-native` should keep the same shape: the native `OuoReplay` does capture and masking, and JS only passes options and the Fabric and old-arch class names.
   - Copy the dual list: `RCTTextView` + `RCTParagraphComponentView`, `RCTImageView` + `RCTImageComponentView`, `RNSVGSvgView` / `com.horcrux.svg.SvgView`, resolved with `NSClassFromString` so that a missing class is harmless.
   - Implement `ouo-mask` / `ouo-unmask` as **container views**, like `RNSentryReplayMask`, as well as the accessibility-id marker.
2. **Do not cache the replay or session id in JS without a lifecycle hook.** Sentry's stale `trace.replay_id` comes from a JS cache that native rotation never invalidates. ouo should either ask native synchronously, or push id changes from native to JS (an event on session rotation). The bridge rule "accept a replay match only inside the session window" (`project/kb-archive/sentry-react-native-demo.md`) stays necessary for Sentry-sourced data.
3. **Flutter needs a different capture path,** and Sentry's design is a good template:
   - Capture `RenderRepaintBoundary.toImage` at **logical resolution** (pixelRatio 1.0, not the device pixel ratio). That is about 1.3–1.5 MiB of RGBA per frame, which is already the right size for a 1 fps video.
   - Mask by walking the `Element` tree **synchronously in the same frame** as the capture.
   - Hand pixels over without copies: a `malloc` pointer on iOS, `TransferableTypedData` to a worker isolate plus a reused Bitmap on Android.
   - Let the native ouo SDK own encoding, chunking and upload, so frame chunks look the same whichever framework made them.
   - Masks in the text colour look better than black boxes but leak text length and layout. ouo should pick one policy across platforms.
4. **Send JS and Dart telemetry through one native transport,** as both Sentry SDKs do (`captureEnvelope`). Offline cache, retry and rate limits then live in one place. For ouo this means the native SDK's OTLP exporter. Avoid RN's base64 hop for large payloads: a JSI or TurboModule `ArrayBuffer` avoids the 33 % expansion and the copy.
5. **Measure replay overhead in CI.** Sentry only gates startup and binary size of init-only apps, and has just removed the RN startup gate. Its replay overhead numbers are manual runs, and the RN page reuses a native app. ouo's harness should run a replay-on app against a replay-off app (same RN or Flutter app) and record frame time, CPU, memory and bytes per minute. That would give ouo numbers Sentry does not publish.
6. **Gaps to avoid:**
   - Quality options that silently do nothing on one platform (RN Android `replaysSessionQuality`).
   - Frame metrics that miss raster time (Flutter).
   - `http.client` spans only inside an active transaction (`project/kb-archive/ouo-next-to-sentry.md`).
   - No frame dedupe before transfer in Flutter. ouo can hash the masked RGBA (or a downsampled copy) in Dart before handing it to native.
