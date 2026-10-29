# Appendix B: Sentry on native Android (sentry-java)

Researched 2026-10-29 from the MIT `getsentry/sentry-java` sources. Everything below is read from code unless marked `[docs only]` or `[blog only]`. Known context that is not repeated here: the envelope and `replay_video` msgpack item format (`project/kb/sentry-envelope-format.md`) and ouo's own mobile replay decision (`docs/adr/0006-mobile-replay-native-screenshots.md`).

## 1. Sources

| What | Where |
|---|---|
| Repo studied | `https://github.com/getsentry/sentry-java`, `main` at **`bdfdc765715d95191d84cb8772fea9826f6e3196`** (2026-10-29), which is `8.62.0-16-gbdfdc7657`: 16 commits after release tag **`8.62.0`** (2026-10-27) |
| Blog | "The Sentry Android SDK is now 20-30% faster!", Nelson Osacky, 2026-10-20, https://blog.sentry.io/android-sdk-faster-startup/ |
| Docs | https://docs.sentry.io/platforms/android/session-replay/performance-overhead/ |
| Licence | MIT for the whole repo. `Windows.kt` is adapted from square/curtains (Apache 2.0, header kept), and #5516 attributes vendored AndroidX Compose UI code |
| Closed parts | None on the device. `sentry-android-ndk` pulls the prebuilt `io.sentry:sentry-native-ndk:0.17.5` (`gradle/libs.versions.toml:190`), whose source is the separate MIT `getsentry/sentry-native` repo. The Sentry Android Gradle Plugin (SAGP) is a separate repo. Relay and the server are FSL |

Citation format: every reference is `path:line` in `sentry-java @ bdfdc76`. Abbreviations used below:

- `R/` = `sentry-android-replay/src/main/java/io/sentry/android/replay/`
- `C/` = `sentry-android-core/src/main/java/io/sentry/android/core/`
- `S/` = `sentry/src/main/java/io/sentry/`

## 2. Platforms and languages

| Module | Language (main sources) | Role |
|---|---|---|
| `sentry` (core) | Java, 467 files, 1 `.kt` | Options, scopes, client, transport, envelope, rrweb model. Shared by all JVM and Android SDKs |
| `sentry-android-core` | Java, 130 files | Integrations: sessions, ANR, app start, frames, activity/TTID/TTFD, gestures, screenshots, profiling |
| `sentry-android-replay` | Kotlin, 39 files (+1 Java) | Session replay. Depends on `kotlin-stdlib`, Compose is `compileOnly` (`sentry-android-replay/build.gradle.kts:73-77`) |
| `sentry-android-ndk` | Java (4) + prebuilt `sentry-native-ndk` | Native (C/C++) crashes |
| `sentry-android` | (aggregate) | `api` of core + ndk + replay (`sentry-android/build.gradle.kts:30-32`) |
| `sentry-compose` | Kotlin (KMP `androidMain`) | Compose navigation, `SentryModifier`, tracing |
| `sentry-okhttp`, `sentry-android-fragment`, `-navigation`, `-navigation3`, `-timber`, `-sqlite` | Kotlin | Optional integrations |

- `minSdk = 21` for every Android module (`gradle/libs.versions.toml:59`). Replay refuses to start below API 26 (`R/ReplayIntegration.kt:151-154`).
- JVM target 1.8 (`sentry-android-replay/build.gradle.kts:43`, `sentry-android-core/build.gradle.kts:43`).
- The public API is Java-first: options, `Sentry`, `SentryAndroid` are Java. Replay has an explicit Java constructor "needed for the Java's call site" (`R/ReplayIntegration.kt:96-100`). A pure Java app loses nothing functional: Compose masking modifiers (`R/ModifierExtensions.kt:16-20`) only matter to Compose apps, which are Kotlin anyway. It does pay for `kotlin-stdlib` once replay is on the classpath.
- React Native and Flutter use this same native SDK (Appendix C).

## 3. RUM

| Signal | Mechanism (code) |
|---|---|
| **Sessions / release health** | `LifecycleWatcher` on `ProcessLifecycleOwner`: foreground starts a session if none or if the last update is older than `sessionTrackingIntervalMillis` = **30 000 ms** (`S/SentryOptions.java:306`, `C/LifecycleWatcher.java:63-88`). Background schedules `endSession` after the same interval on the shared timer executor (`C/LifecycleWatcher.java:104-121`, PR #5819). Replay follows the session: `onAppForegrounded(startNewSession)`, `onAppBackgrounded()`, `onAppSessionEnded()` (`C/LifecycleWatcher.java:87,98,112`) |
| **JVM crashes** | `UncaughtExceptionHandlerIntegration` (core). `SentryClient` calls `replayController.captureReplay(event.isCrashed())` (`S/SentryClient.java:250`) |
| **Native crashes** | `NdkIntegration` loads `sentry-native` before the outbox observer (`C/AndroidOptionsInitializer.java:436-439`). On API 31+ `TombstoneIntegration` additionally reads tombstones from `ApplicationExitInfo` (`:441-443`) |
| **ANR** | `AnrIntegrationFactory`: API ≥ 30 → `AnrV2Integration`, else v1 (`C/AnrIntegrationFactory.java:15-18`). v1 is `ANRWatchDog`, a thread posting a ticker to the main looper and sleeping, timeout `anrTimeoutIntervalMillis` = 5000 (`C/ANRWatchDog.java:44,122-161`, `C/SentryAndroidOptions.java:39`). v2 reads `ActivityManager.getHistoricalProcessExitReasons` on next launch, keeps `REASON_ANR`, parses `getTraceInputStream()` thread dumps, tags `anr_foreground` / `anr_background`, marked `AbnormalExit` (`C/AnrV2Integration.java:122,144-216,240-278`, `C/ApplicationExitInfoHistoryDispatcher.java:81`) |
| **App start** | Start = `Process.getStartUptimeMillis()` (`C/SentryPerformanceProvider.java:261-265`, `C/SentryAndroid.java:164`). `SentryPerformanceProvider` (`initOrder=200`) times every `ContentProvider.onCreate` (`C/performance/AppStartMetrics.java:760-774`). Cold/warm: API 35+ `ApplicationStartInfo.getStartType()`; otherwise warm if the process started >1 min before the first activity, if `savedInstanceState != null`, or after first idle (`:505-530, :665-700`). Spans `app.start.cold` / `app.start.warm`, "Process Initialization", content providers, `Application.onCreate`, activity lifecycles (`C/ActivityLifecycleIntegration.java:61-78`) |
| **Slow / frozen frames** | `SentryFrameMetricsCollector`: `Window.OnFrameMetricsAvailableListener` on a lazily started `HandlerThread` (`C/internal/util/SentryFrameMetricsCollector.java:119-120`). Slow = duration > 1 s / (refreshRate − 1); frozen = > **700 ms** (`:42,187-192,217-221`) |
| **Screen loads, TTID / TTFD** | `ActivityLifecycleIntegration` starts an idle transaction `ui.load` per activity, child spans `ui.load.initial_display` (first draw via `FirstDrawDoneListener`, a `ViewTreeObserver.OnDrawListener` that posts at front of queue) and `ui.load.full_display` (ends on `Sentry.reportFullyDisplayed()` or after **25 000 ms**) (`C/ActivityLifecycleIntegration.java:61-70,398,659`, `C/internal/util/FirstDrawDoneListener.java:39-121`) |
| **Navigation** | `sentry-android-navigation` (Jetpack Navigation), `sentry-android-navigation3`, `sentry-compose` `SentryNavigationIntegration` |
| **Network** | `sentry-okhttp` `SentryOkHttpInterceptor` (span `http.client`, breadcrumb with `http.request_content_length` / response length from body `contentLength()`, `http.start_timestamp` / `http.end_timestamp`, failed-request events) and `SentryOkHttpEventListener` (DNS/connect/TLS sub-spans) (`sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt:60,106,143,240-280`). `sentry-android-okhttp` was removed in #3510 (2024-07-01) |
| **User interactions** | `UserInteractionIntegration` wraps `Window.Callback` (`SentryWindowCallback`) and runs a `GestureDetector` → `SentryGestureListener`: `ui.click` breadcrumbs on tap, scroll/swipe detection, `ui.action` transactions (`C/internal/gestures/SentryGestureListener.java:42,100-140`). Compose targets via `sentry-compose/.../gestures` |
| **Screenshots / view hierarchy on error** | `ScreenshotEventProcessor` (PNG, debounced 2 s / max 3) and `ViewHierarchyEventProcessor` (`C/ScreenshotEventProcessor.java:36-37,130`). Since #5077 / #6281 screenshots can be masked with the replay `MaskRenderer` |
| **Profiling** | Legacy `AndroidProfiler` = `Debug.startMethodTracingSampling(file, 3 MB, intervalUs)` (`C/AndroidProfiler.java:79,215`). Continuous profiler in 60 s chunks (`C/AndroidContinuousProfiler.java:50,235`). API 35+ `PerfettoProfiler` / `PerfettoContinuousProfiler` via `ProfilingManager` (#5251) |
| **Logs** | `AndroidLoggerBatchProcessor`, `SentryLogcatAdapter`, `sentry-android-timber` |

## 4. Session replay

### 4.1 Pipeline overview

```
SentryAndroid.init → ReplayIntegration.register (API ≥ 26)
  LifecycleWatcher.onForeground → onAppForegrounded(true) → sample → Session|BufferCaptureStrategy
RootViewsSpy (swaps WindowManagerGlobal.mViews) → WindowRecorder.onRootViewsChanged → ScreenshotRecorder.bind(lastRoot)
main looper: Capturer.run every 1000/frameRate ms
   ├─ no onDraw since last tick → emitLastScreenshot (same bitmap again)
   └─ PixelCopy.request(window → RGB_565 bitmap at recording size) → callback on main:
        ViewHierarchyNode tree built on main → replay executor: MaskRenderer → JPEG to disk
replay executor: every 5 s (session) → ReplayCache.createVideoOf → MediaCodec H.264 → mp4
   → SentryReplayEvent + ReplayRecording (rrweb JSON) → envelope item replay_video (msgpack) → gzip HTTP
```

### 4.2 Window discovery

- `RootViewsSpy.install()` posts **at front of the main queue** and replaces the private `WindowManagerGlobal.mViews` `ArrayList` with a subclass whose `add` / `removeAt` notify listeners (`R/Windows.kt:153-168,171-207`). This sees every window: activities, dialogs, popups, toasts.
- `WindowRecorder` keeps every root, skips roots without a `PhoneWindow` (found by reflecting `DecorView.mWindow`, `R/Windows.kt:39-92`), and always records **only the last added root** (`R/WindowRecorder.kt:118-145`). So a dialog replaces the activity in the recording, which also means the activity behind a dialog is not captured.
- A layout listener re-detects size for activities that handle their own configuration changes (`R/WindowRecorder.kt:147-181`). A size change creates a new `ScreenshotRecorderConfig` and, in session mode, closes the current segment (`R/capture/SessionCaptureStrategy.kt:174-187`).
- `CurrentActivityHolder` is not used by replay. It is used by app start and screenshots (`C/performance/AppStartMetrics.java:668`).

### 4.3 Cadence and change detection

- The capture loop is a `Runnable` that re-posts itself on the **main looper** with `postDelayed(1000 / frameRate)` (`R/WindowRecorder.kt:84-115`). `frameRate` defaults to **1** (`S/SentryReplayOptions.java:135`). It is fixed-delay, not fixed-rate, so a slow main thread stretches the interval.
- Change detection is not pixel diffing. `ScreenshotRecorder` registers a `ViewTreeObserver.OnDrawListener` and sets `contentChanged` on every draw (`R/ScreenshotRecorder.kt:99-111`). Without a draw since the last tick it calls `emitLastScreenshot()`, which hands **the same bitmap** downstream again (`R/ScreenshotRecorder.kt:74-77`, `R/screenshot/PixelCopyStrategy.kt:371-394`). That bitmap is re-compressed to JPEG and written to disk every tick (`R/ReplayCache.kt:75-91`). The video stays constant-frame-rate and the encoder turns duplicates into near-empty P-frames.
- A `frameInFlight` CAS gate stops overlapping captures. If the hierarchy changed while `PixelCopy` was in flight, one capture is dropped (`MAX_UNSTABLE_CAPTURES_TO_SKIP = 1`) so a continuous animation cannot stall recording (`R/screenshot/PixelCopyStrategy.kt:43-49,89-125,187-194`).

### 4.4 How a frame is drawn

Two strategies (`R/ScreenshotRecorder.kt:39-52`), chosen by `screenshotStrategy`, default `PIXEL_COPY` (`S/SentryReplayOptions.java:175`):

| | `PIXEL_COPY` (default) | `CANVAS` (experimental) |
|---|---|---|
| Capture | `PixelCopy.request(window, bitmap, cb, mainHandler)`. The system scales the window into a pre-allocated bitmap of recording size (`R/screenshot/PixelCopyStrategy.kt:53-62,103-178`) | `root.draw()` into a `Picture` through `TextIgnoringDelegateCanvas` on the main thread, then replayed onto a `SurfaceTexture` hardware canvas on a `HandlerThread`, then `PixelCopy` from that surface (`R/screenshot/CanvasStrategy.kt:65-69,76-174`) |
| Bitmap | `RGB_565` (2 B/px), `ARGB_8888` only when `captureSurfaceViews` (#5821) | `RGB_565` |
| Masking | View-tree walk and rectangles (4.5), so mask and unmask classes apply | Every `drawText*` becomes a rectangle and every `drawBitmap` a rectangle of the bitmap's average colour (cached by `generationId`, hardware bitmaps via `asShared()` on API 31+). Always masks all text and images, so `addMaskViewClass` / `addUnmaskViewClass` are ignored (`S/SentryReplayOptions.java:166-175`, `R/screenshot/CanvasStrategy.kt:873-900,967-997`) |
| Threads | Main: `PixelCopy.request` + hierarchy walk in the callback. Replay executor: masking, JPEG | Main: `View.draw` into `Picture`. `SentryReplayBackgroundProcessing` HandlerThread: render + copy |

- **Resolution**: window px ÷ density (dp at mdpi) × `quality.sizeScale`, rounded to a multiple of 16 for the codec (`R/ScreenshotRecorder.kt:179-213`).
- **Quality presets** (`S/SentryReplayOptions.java:79-86`):

| Quality | `sizeScale` | `bitRate` (bit/s) | JPEG quality on disk |
|---|---|---|---|
| LOW | 0.8 | 50 000 | 10 |
| MEDIUM (default) | 1.0 | 75 000 | 30 |
| HIGH | 1.0 | 100 000 | 50 |

The KDoc on `ReplayCache.addFrame` says "quality 80", which is stale: the code uses `quality.screenshotQuality` (`R/ReplayCache.kt:67 vs :87`). The enum comment "defaults to 40kbps" is stale too (`S/SentryReplayOptions.java:91-94`).

- **SurfaceView**: a window `PixelCopy` leaves SurfaceView holes transparent. With `captureSurfaceViews` (experimental, off, #5333) each visible SurfaceView is copied separately and composited behind the window with `DST_OVER`. Masking is all or nothing per SurfaceView (`S/SentryReplayOptions.java:177-189`, `R/screenshot/PixelCopyStrategy.kt:225-353,455-478`).

**History of the capture path** (from `git log`, added after the first draft):

- Replay first landed in `e34c467f7` ("[SR] Session Replay", #3339, 2024-07-15) and was merged into the 8.x line in #3696 (2024-09-19). The 6-second key-frame interval was already in that first commit.
- The software H.264 encoder on Exynos devices came in `f6e97b16a` (#3628, 2024-08-12).
- The screenshot bitmap moved to `ARGB_8888` in `25217928a` (#4282, 2025-03-24) and back to `RGB_565` when no transparency is needed in `5cb2c360f` (#5821, 2026-07-30).
- SurfaceView capture was added as an experimental option in `7ce4e9116` (#5333, 2026-05-06).

### 4.5 Redaction

- **Tree**: in the `PixelCopy` callback on the main thread, `ViewHierarchyNode.fromView(root)` and `View.traverse` build a node per view with `x/y/width/height`, cumulative `elevation`, child index `distance`, `isVisible`, and `visibleRect` from `getGlobalVisibleRect`, which already clips by ancestors. Invisible means `windowVisibility`, `alpha` or `transitionAlpha` ≤ 0, or not `VISIBLE` up the parent chain (`R/util/Views.kt:37-106`, `R/viewhierarchy/ViewHierarchyNode.kt:365-445`).
- **Rule order** in `View.shouldMask` (`R/viewhierarchy/ViewHierarchyNode.kt:319-349`): tag containing `sentry-unmask` or `R.id.sentry_privacy == "unmask"` → no; `sentry-mask` / `"mask"` → yes; parent is the `unmaskViewContainerClass` → no; class (walking superclasses) in `unmaskViewClasses` → no; in `maskViewClasses` → yes.
- **Default masked classes** (`S/SentryReplayOptions.java:246-254`): `android.widget.TextView` (so `EditText` and `Button` too), `android.widget.ImageView`, `android.webkit.WebView`, `android.widget.VideoView`, `androidx.camera.view.PreviewView`, `androidx.media3.ui.PlayerView`, `com.google.android.exoplayer2.ui.PlayerView`, `...exoplayer2.ui.StyledPlayerView`.
- **Images** are masked only if the drawable looks like content: `BitmapDrawable` larger than 10×10, or an unknown drawable type. `ColorDrawable`, `VectorDrawable`, `GradientDrawable` and `InsetDrawable` stay visible (`R/util/Views.kt:108-126`).
- **Drawing** (`R/util/MaskRenderer.kt:43-110`): rounded rectangles with radius 10.
  - **Text**: one rectangle per **line** from `Layout.getLineLeft/Right/Top/Bottom` plus padding, so the replay keeps the shape of paragraphs. The colour is the text colour: the longest `ForegroundColorSpan`, else `currentTextColor` (`R/util/Views.kt:128-153,171-225`).
  - **Images**: the rectangle is filled with the **average colour** of the region, computed by drawing the region into a 1×1 bitmap.
  - **Everything else**: black.
- **Occlusion**: `ViewHierarchyNode.isObscured()` (elevation, then lowest common ancestor and sibling order) exists, but nothing in `main` calls it (`R/viewhierarchy/ViewHierarchyNode.kt:195-237`; grep finds no caller). Masks are drawn for every masked, visible node even when another view covers it. That over-masks, which is safe.
- **Compose**: `ComposeViewHierarchyNode.fromView` detects `AndroidComposeView`, walks `LayoutNode` children (vendored helper) and reads the `SemanticsConfiguration`. On Compose ≤ 1.8 it falls back to reflection on `getCollapsedSemantics$ui_release` (`R/viewhierarchy/ComposeViewHierarchyNode.kt:40-70,273-335`). A node with `Text`, `SetText` or `EditableText` maps to the proxy class `TextView`; a node with a `Painter` maps to `ImageView`. Masking decisions then reuse the View class lists (`:76-108`). Text colour comes from `TextLayoutResult` style or reflection, and editable fields are masked as a whole box (`:183-228`). `Modifier.sentryReplayMask()` / `sentryReplayUnmask()` set the `SentryPrivacy` semantics key (`R/ModifierExtensions.kt:8-20`). The supported range is Compose UI 1.5.0 to 1.10.2 (`:144`). R8 keep rules exist for `Painter`, `ColorProducer`, `FillElement` and `AndroidComposeView` (`sentry-android-replay/proguard-rules.pro`).
- **Failure modes**: if reading semantics throws for one node, that node is masked whole (`:158-175`, fail closed). If **traversing the whole Compose tree** throws, `fromView` returns `false`, the subtree is treated as a plain `ViewGroup` with no View children, and nothing in it is masked (`:296-309`). That is **fail open**, as the source comment itself admits.

### 4.6 Disk cache, encoding, segments

- Every frame becomes `<cacheDir>/replay_<id>/<timestampMs>.jpg` (`R/ReplayCache.kt:75-91,360-368`). Segment metadata is persisted as `key=value` lines in `.ongoing_segment`: size, frame rate, bit rate, segment id and timestamp, replay type, recording JSON, release, environment, SDK (`R/ReplayCache.kt:284-337`). The authors' comment on it is "TODO: it's awful".
- `createVideoOf(duration, from, ...)` walks the segment in steps of `1000 / frameRate` ms. Each step decodes the frame in that slot with `BitmapFactory.decodeFile`, or repeats the last one, and draws it onto the encoder's input `Surface` (`R/ReplayCache.kt:132-222`).
- Encoder (`R/video/SimpleVideoEncoder.kt`):
  - `MediaCodec` `video/avc`, `COLOR_FormatSurface`, `KEY_BIT_RATE` = preset (clamped to the codec range), `KEY_FRAME_RATE` = 1, **`KEY_I_FRAME_INTERVAL` = 6** ("every 6th second is a key frame, useful for buffer mode"), VBR (the CBR line is commented out) (`:136-160`).
  - Exynos devices are forced to `c2.android.avc.encoder` (`:66-81`).
  - A software canvas is used on Xiaomi, Motorola, Spreadtrum/Unisoc and emulators (`:342-349`).
  - `MediaMuxer` MPEG-4 with synthetic PTS = index × frame duration, so no B-frames are assumed (`R/video/SimpleMp4FrameMuxer.kt:38-62`).
- **Segments**:
  - Session mode cuts a segment when `frameTimestamp − segmentStart ≥ sessionSegmentDuration` = **5000 ms**. It also cuts on pause, stop and size change (`R/capture/SessionCaptureStrategy.kt:110-187`, `S/SentryReplayOptions.java:141`).
  - Segment duration is capped at 5 min (`R/capture/CaptureStrategy.kt:79-81`).
  - A replay stops after `sessionDuration` = **60 min** (`S/SentryReplayOptions.java:144`, `R/capture/BaseCaptureStrategy.kt:136`).
  - Video is read with a 10 MB cap (`S/SentryReplayEvent.java:39`).

### 4.7 Session vs buffer mode

- `sessionSampleRate` decides session mode; otherwise buffer mode runs if `onErrorSampleRate` is set (`R/ReplayIntegration.kt:181-205`).
- **Buffer mode** keeps JPEGs on disk only and **does not encode** until an error. Each frame rotates frames older than `errorReplayDuration` = **30 000 ms** (`R/capture/BufferCaptureStrategy.kt:132-149`, `S/SentryReplayOptions.java:138`).
- On a captured error, `SentryClient` runs the optional `beforeErrorSampling` callback, then `captureReplay`, which samples `onErrorSampleRate` (`R/ReplayIntegration.kt:298-330`, `S/SentryClient.java:235-256`). The buffer is encoded and sent, with a 100 ms sleep between buffered envelopes "to avoid bursting our server". The strategy then **converts** to `SessionCaptureStrategy` with the same replay id and `replay_type = buffer` (`R/capture/BufferCaptureStrategy.kt:94-128,162-195,221-231`).
- The replay id goes on the scope only in session mode, so buffered replays that are never sent do not tag events (`R/capture/SessionCaptureStrategy.kt:55-63`).
- **Offline or rate limited**: session mode pauses recording "to not overflow the envelope cache" (`R/ReplayIntegration.kt:575-633`). Buffer mode skips the flush and records a client report (`R/capture/BufferCaptureStrategy.kt:105-115`). The envelope cache holds `maxCacheItems` = 30 (`S/SentryOptions.java:206`), while one replay hour is 720 segments.

### 4.8 Crash, ANR, next launch

- On a crash, `captureReplay(isTerminating = true)` runs synchronously, because "a main-thread crash blocks the looper" (`R/ReplayIntegration.kt:319-321`). Session mode stops cutting segments, and buffer mode skips encoding because "the video will be malformed" (`R/capture/SessionCaptureStrategy.kt:130-135`, `R/capture/BufferCaptureStrategy.kt:94-103`).
- On the next `register()`, `finalizePreviousReplay()` runs on the SDK executor (`R/ReplayIntegration.kt:663-721`):
  1. Reads the previous replay id from the persisted scope.
  2. Rebuilds the last segment from `.ongoing_segment` and the leftover JPEGs (`R/ReplayCache.kt:371-495`).
  3. Encodes it and sends it with a `Backfillable` hint, using the release, environment and SDK persisted with the recording (`:795-820`).
  4. Deletes other `replay_*` folders.
- ANR v2 events are also reported on the next launch. `AnrIntegration` is registered before `ReplayIntegration` so the replay id can be set on the ANR (`C/AndroidOptionsInitializer.java:463-466`).

### 4.9 Recording JSON (rrweb) per segment

`buildReplay` (`R/capture/CaptureStrategy.kt:145-253`) emits:

- `RRWebMetaEvent` (width and height).
- `RRWebVideoEvent` (segmentId, duration, frameCount, size, frameRate, `left = top = 0`).
- Breadcrumbs inside `[segmentStart, segmentEnd)`, converted by `DefaultReplayBreadcrumbConverter` (`R/DefaultReplayBreadcrumbConverter.kt:95-205`):

| Sentry breadcrumb | rrweb event |
|---|---|
| `http` with url, `http.start_timestamp` and `http.end_timestamp` | `RRWebSpanEvent` op `resource.http`, plus network details (≤ 150 KiB bodies, `S/SentryReplayOptions.java:76`) for `networkDetailAllowUrls` |
| `navigation` / `app.lifecycle` | `app.<state>` |
| `device.orientation` | `device.orientation` |
| `navigation` | `navigation` with `to` = screen. Also fills `replay_event.urls` |
| `ui.click` | `ui.tap`, message = view id, tag or class |
| `network.event` | `device.connectivity` (debounced) |
| `BATTERY_CHANGED` | `device.battery` |
| anything else | passthrough |

- Touches: `GestureRecorder` wraps each window's `Window.Callback` (`FixedWindowCallback`), copies each `MotionEvent` with `obtainNoHistory` (`R/gestures/GestureRecorder.kt:47-107`). `ReplayGestureConverter` emits TouchStart, TouchEnd and TouchCancel, and batches moves (debounce 50 ms, flush every 500 ms) with coordinates scaled to the video (`R/gestures/ReplayGestureConverter.kt:22-147`).
- `RRWebOptionsEvent` on segment 0 carries `maskAllText`, `maskAllImages`, `quality` and others (`S/rrweb/RRWebOptionsEvent.java:48-53`).
- Envelope: one `replay_video` item, msgpack `{replay_event, replay_recording, replay_video}` in that order, written by hand (fixmap, str8 keys, bin32 values) (`S/SentryEnvelopeItem.java:559-619,712-733`). The JSON parts are not gzipped inside the item; the HTTP body is gzipped as a whole (`S/transport/HttpConnection.java:129,155`). Details in `project/kb/sentry-envelope-format.md`.

### 4.10 Threads and objects

| Thread | Work |
|---|---|
| main | `RootViewsSpy` callbacks, 1 fps capture loop, `PixelCopy.request` + callback, full view/Compose tree walk, all lifecycle commands (confined to main since #5965) |
| `SentryReplayIntegration-0` (single scheduled, daemon) | Masking, JPEG compress + write, frame rotation, H.264 encode at segment boundaries, segment creation (`R/ReplayIntegration.kt:124-128,774-782`) |
| `SentryReplayPersister-0` | `.ongoing_segment` writes (`:129-134,784-791`) |
| `SentryReplayBackgroundProcessing` | Canvas strategy only, lazy (`R/WindowRecorder.kt:297-310`) |
| `SentryAsyncConnection` / SDK executor | Envelope send; finalize previous replay |

## 5. Transport and OpenTelemetry

- `AsyncHttpTransport`: one worker thread, `QueuedThreadPoolExecutor` bounded by `maxQueueSize` = `maxCacheItems` = 30. Envelopes are stored to `EnvelopeCache` (`*.envelope` files) before sending and discarded on success or 4xx. They stay cached when the network is down (`transportGate`) and are marked `Retryable` (`S/transport/AsyncHttpTransport.java:89-151,274-355`, `S/cache/EnvelopeCache.java:59-121`).
- `HttpConnection` always sends `Content-Encoding: gzip`, with connect and read timeouts of 30 s. It parses `Retry-After` and `X-Sentry-Rate-Limits` into the `RateLimiter`, which filters envelope items per data category (`S/transport/HttpConnection.java:129-156,219-229`, `S/SentryOptions.java:344-347`).
- Cached envelopes are re-sent at startup by `SendCachedEnvelopeIntegration` (`C/AndroidOptionsInitializer.java:431-458`).
- **Propagation**: `sentry-trace` + `baggage` by default. W3C `traceparent` is **opt-in** with `propagateTraceparent` (default `false`, `S/SentryOptions.java:455,2463-2478`, used in `S/util/TracingUtils.java:69,100`).
- **No OTLP export from Android.** All Android telemetry is Sentry envelopes. The OTel modules:

| Module | What it does | Android? |
|---|---|---|
| `sentry-opentelemetry-core` | `SentrySpanProcessor` / `OtelSentrySpanProcessor` + `SentrySpanExporter` turn OTel spans into Sentry transactions. `SentryPropagator` handles sentry-trace/baggage. `OpenTelemetryLinkErrorEventProcessor` puts the current OTel span on Sentry error events | JVM backends. Android integrations emit Sentry spans, not OTel spans |
| `-agent`, `-agentcustomization`, `-bootstrap` | OTel Java agent + Sentry customisations | No (the Java agent cannot run on ART) |
| `-agentless`, `-agentless-spring` | The same without an agent, via autoconfigure | No Android sample or test |
| `sentry-opentelemetry-otlp` (#5100, 2026-02-27) | The reverse direction: the app's **OTel SDK exports traces over OTLP**, and Sentry handles errors and logs. `OpenTelemetryOtlpEventProcessor` copies the current OTel `traceId` / `spanId` into Sentry events; `OpenTelemetryOtlpPropagator` reads and writes sentry-trace | A Kotlin-JVM module (`kotlin.jvm` plugin, JVM 1.8) with `api` deps on `opentelemetry-sdk`, autoconfigure and the OTLP exporter. It would probably compile into an Android app, but none of the Android RUM integrations feed it, and it has no Android sample or test (inferred from build files and the sample list) |

## 6. Other features

- **Replay linked to issues**: the error sets `contexts.replay.replay_id` and the DSC `replay_id` (`S/SentryClient.java:246-256`). Feedback events get the replay id too (`:1295-1309`).
- **User feedback**: `SentryUserFeedbackDialog`, shake-to-report `FeedbackShakeIntegration` (initialised off the main thread since #5784), and a screenshot picker.
- **Feature flags**: `sentry-openfeature` and LaunchDarkly (`sentry-launchdarkly-android`); flags attached to events.
- **Distribution**: `DistributionIntegration` (build distribution and update checks).
- **Hybrid SDK hooks**: masked screenshot capture for React Native and Flutter (#6281), `ReplayFrameObserver` that gets each masked frame (`R/ReplayIntegration.kt:464-485`).
- **Not present**: funnels, journeys, heatmaps, surveys.

## 7. Performance footprint

### Vendor numbers

| Claim | Number | Method |
|---|---|---|
| Replay overhead `[docs only]` | FPS 55 → 54; memory 255 → 265 MB; CPU 36% → 42%; cold start 1533.35 → 1539.55 ms; bandwidth "7 KB/s"; main thread "20ms" (unit unclear) | Pocket Casts app, Pixel 2 XL, Android 11, full masking, release build, the same flow 10×, medians. No SDK version stated. The harness is not in the repo |
| SDK init `[blog only]` | `SentryAndroid.init` 43.5 ms (8.43.0) → 33.1 ms (8.54.0), −23.9% | Macrobenchmark in the repo (section 8), Pixel 3 with locked clocks, 4 interleaved rounds × 10 runs per version, SAGP 6.20.0 |
| Thread churn `[blog only]` | −3 MB heap (1 MB ART stack per avoided thread) | Not reproduced in the repo |

### Derived from code (MEDIUM unless stated)

Worked example: a 1080×2400 px screen at density 2.625 is 411×914 dp. Rounding to multiples of 16 gives a **416×912** video at MEDIUM/HIGH and **336×736** at LOW (`R/ScreenshotRecorder.kt:179-213`).

| Quantity | Value | Source |
|---|---|---|
| Capture bitmap | 416×912×2 B = **741 KiB** (RGB_565), held for the whole recording. 1.45 MiB as ARGB_8888 with SurfaceViews | `R/screenshot/PixelCopyStrategy.kt:53-62` |
| Video bitrate ceiling | 75 kbit/s = 9.4 KB/s. LOW 6.25 KB/s, HIGH 12.5 KB/s. VBR, so static screens come in far lower | `S/SentryReplayOptions.java:79-86` |
| Per 5 s segment | ≤ ~47 KB mp4 (LOW ≤ 31, HIGH ≤ 63) + ~1–3 KB JSON (replay_event + recording) before gzip. gzip does not shrink H.264 | `R/capture/CaptureStrategy.kt:145-253` |
| Per minute (session mode, constant change) | ≤ ~560 KB (LOW ~375, HIGH ~750). The docs' 7 KB/s ≈ 420 KB/min is consistent with VBR under the cap | arithmetic |
| Per hour cap | ≤ ~34 MB (60 min stop) | `S/SentryReplayOptions.java:144` |
| Disk in buffer mode | 30 JPEGs (1 fps × 30 s) at JPEG quality 30, plus the mp4 only after an error | `R/capture/BufferCaptureStrategy.kt:132-149` |
| CPU per second | One PixelCopy (GPU), one full tree walk on main, one mask pass, one JPEG encode + file write, **even when the screen is static** (re-emit path). Every 5 s: 5 JPEG decodes + 5 H.264 frames | `R/screenshot/PixelCopyStrategy.kt:371-394`, `R/ReplayCache.kt:176-205` |
| Extra threads | 2 (replay + persister), +1 with Canvas | 4.10 |

There are no replay video fixtures or segment-size fixtures in the repo: only `sentry/src/test/resources/json/replay_recording.json` and `sentry_replay_event.json`.

AAR size is tracked by `.github/workflows/integration-tests-size.yml`. It builds `test-app-size` (sentry-android + timber + sqlite + okhttp + compose + fragment) and uploads it to Sentry's own size analysis through SAGP (`sentry-android-integration-tests/test-app-size/build.gradle.kts:45-65`). No numbers are in the repo.

## 8. Blog-to-code grounding ("faster startup")

The blog says over 40 changes landed between 8.43.2 and 8.54.0 `[blog only]`. The four it names, matched to commits:

| Blog item | Commit (PR, date) | What changed in code |
|---|---|---|
| Manifest options resolved at build time (−6.5% `[blog only]`) | `5dc72eec5` (#5976, 2026-08-24), SAGP #1405 | `ManifestMetadataReader.manifestMetadata` is a static map "populated by the Sentry Android Gradle plugin from the merged manifest at build time". When set, `getMetadata` returns it and skips `PackageManager.getApplicationInfo(GET_META_DATA)` and `Bundle` unparcelling (`C/ManifestMetadataReader.java:34-35,1141-1148`) |
| Class availability at build time | `1e904b2bb` (#5875, 2026-07-30), SAGP #1404 | `LoadClass.classAvailability` static map consulted before `Class.forName` (`S/util/LoadClass.java:15-16,64`). Used for the `isFragmentAvailable` / `isTimberAvailable` / `isReplayAvailable` checks in init (`C/SentryAndroid.java:111-118`) |
| DSN parse 6 ms → 1 µs | `29f120b09` (#5448, 2026-06-09) | `new URI(dsn).normalize()` replaced by `indexOf` / `substring`; `URI` is built only from the parsed parts. The commit says it ran on main in `Sentry.init` via `preInitConfigurations()` |
| Shared executors instead of one-off threads (−3 MB) | `bcd3e76a8` (#5670, 2026-07-15), `023ef0038` (#5819, 2026-07-22), `c318acd31` (#5814, 2026-07-29) | A per-transaction `java.util.Timer` in `SentryTracer` (idle/deadline timeouts) was "the dominant source of SDK thread churn". `LifecycleWatcher` and `RateLimiter` timers lived forever. All three now use one lazily started shared timer executor that idles out |

Other startup work in the same window, found by `git log 8.43.0..8.54.0`:

- Deferred `SentryFrameMetricsCollector` `HandlerThread` (`3859a2cc3`, #5641) and its reflection (`52bd5a78e`, #5886).
- Reduced reflection in init (`8fe8bad58`, #5634).
- No executor prewarm (`7a19fee20`, #5681).
- Lazy outbox and cache dirs (`5e6844d5b`, #5792).
- Batched scope persistence writes (`41d7c517f`, #5791).
- App start profiling config parsed without `JsonSerializer` (`69bdef7a1`, #5867).
- Shake detector initialised off main (`8d299fcb8`, #5784).
- Lazily allocated locks (`ea2a517b5`, #5643).
- `getResourceId` without exceptions (`e279b061f`, #5631).
- `SentryOptions` overhead reduction (`2ebf90a0d`, #5499).

What still runs on main: `SentryInitProvider.onCreate` → `SentryAndroid.init` (auto-init ContentProvider, `C/SentryInitProvider.java:17-27`). The `Trace` section brackets the whole `Sentry.init`: options loading, integration registration, app start metric setup (`C/SentryAndroid.java:101-227`). Disk work such as cached-envelope sending and previous-replay finalisation is submitted to executors (`C/AndroidOptionsInitializer.java:431-458`, `R/ReplayIntegration.kt:663-664`).

**Measurement harness** (in this repo, not a separate one):

- `sentry-android-integration-tests/sentry-uitest-android-macrobenchmark` (`50431640e`, #5680, 2026-07-02). `MacrobenchmarkRule`, `StartupMode.COLD`, `CompilationMode.Full()`, **12 iterations** ("cold starts thermally throttle after ~14"). Metrics are `StartupTimingMetric` (TTID) and `TraceSectionMetric("SentryAndroid.init")` (`SentryStartupBenchmark.kt:35-55`).
- The trace section was added in `19a5688aa` (#5901) and wired into the benchmark in `1664d46c8` (#5903).
- The README requires interleaved A/B rounds, locked clocks and airplane mode. It is "not run in CI" as a gate.
- A manual Sauce Labs workflow (`integration-tests-macrobenchmark.yml`, `6a1c02c3a`, #5909) recovers `benchmarkData.json` by echoing it to logcat in 2000-char chunks, because Sauce cannot pull device files (`SentryStartupBenchmark.kt:59-103`).
- The commit message of #5680 quotes a Galaxy A55 TTID median of 514.5 ms.
- The older `sentry-uitest-android-benchmark` (CPU / dropped-frames comparison, assert CPU delta within ±2%) and `metrics-test.yml` (startup diff over 50 runs, allowed 0–150 ms, for plain vs Sentry test apps) were **deleted** in `67c065ca6` (#5972, 2026-08-25). Recover them with `git show 67c065ca6^:sentry-android-integration-tests/...`.
- The blog's Perfetto workflow is documented in `develop-docs` (`4d15f0e2b`, #5750).

## 9. Questions asked and answers

1. **Is the capture loop on the main thread?** Yes. A `Handler.postDelayed` loop on the main looper, plus the view-tree walk in the `PixelCopy` callback. Only masking, JPEG and video work leave it (`R/WindowRecorder.kt:84-115`, `R/screenshot/PixelCopyStrategy.kt:103-178`).
2. **Is there a `ScheduledExecutor` at N fps?** No. Main-looper `postDelayed(1000 / frameRate)`, default 1 fps (`R/WindowRecorder.kt:108`).
3. **PixelCopy or `View.draw`?** `PixelCopy` of the whole `Window` by default. `View.draw` → `Picture` only in the experimental Canvas strategy (`R/ScreenshotRecorder.kt:39-52`).
4. **How are duplicates handled?** `OnDrawListener` dirty flag, no pixel diff. Unchanged ticks re-emit the previous bitmap, so the JPEG is re-written each second and H.264 makes the repeat cheap (`R/ScreenshotRecorder.kt:74-77`).
5. **How are windows found?** Reflection swap of `WindowManagerGlobal.mViews`, last root wins (`R/Windows.kt:171-207`, `R/WindowRecorder.kt:118-145`).
6. **Text mask colour?** Longest `ForegroundColorSpan`, else `currentTextColor`, one rectangle per line. Images use the region's average colour, other views black (`R/util/MaskRenderer.kt:57-110`).
7. **Is occlusion applied?** No. `isObscured()` is dead code in `main` (`R/viewhierarchy/ViewHierarchyNode.kt:195`).
8. **What happens if Compose traversal breaks?** The whole Compose subtree goes unmasked (fail open, `R/viewhierarchy/ComposeViewHierarchyNode.kt:296-309`).
9. **Codec settings?** H.264, VBR, 1 fps, key frame every 6 s, bitrate 50k / 75k / 100k (`R/video/SimpleVideoEncoder.kt:136-160`).
10. **Segment length?** 5 s in session mode, 30 s buffer, 60 min cap, segments ≤ 5 min (`S/SentryReplayOptions.java:138-144`, `R/capture/CaptureStrategy.kt:81`).
11. **What happens on a crash?** Nothing is encoded in-process. The last segment is rebuilt from JPEGs on the next launch (`R/ReplayIntegration.kt:663-721`).
12. **Does replay restart with the session?** Yes. A new release-health session after 30 s in background gives a new replay; ending the session stops replay (`C/LifecycleWatcher.java:87-112`).
13. **Request sizes in replay network breadcrumbs?** `http.request_content_length` / `response_content_length` from OkHttp body `contentLength()`. Bodies and headers only for allow-listed URLs, ≤ 150 KiB (`R/DefaultReplayBreadcrumbConverter.kt:31-38`, `S/SentryReplayOptions.java:76,191-233`).
14. **Is replay recorded offline?** Session mode pauses while disconnected or rate-limited; buffer mode keeps buffering (`R/ReplayIntegration.kt:575-633`).
15. **Can Android emit OTLP?** Not from the SDK's own RUM. `sentry-opentelemetry-otlp` only links Sentry events to an app-managed OTel SDK and is JVM-oriented (section 5).
16. **How did Sentry measure startup?** In-repo Jetpack Macrobenchmark with a `SentryAndroid.init` trace section, on a local Pixel 3 with locked clocks. The Sauce Labs run is informational only (section 8).
17. **iOS vs Android at a high level?** Both take screenshots, mask in native code before encoding, and turn ~1 fps frames into H.264 mp4 segments sent as the same msgpack `replay_video` item (`project/kb/sentry-envelope-format.md`). Android-specific points:
    - **Capture source**: `PixelCopy` needs a `Window`, so `SurfaceView`, `TextureView`-like and GL content needs special compositing (opt-in).
    - **Which window**: only the top root is recorded, so the activity behind a dialog is not.
    - **Device quirks**: Exynos codec, Xiaomi, Motorola, Unisoc and emulator canvas workarounds.
    - **Compose**: masking relies on internal `LayoutNode` APIs and reflection, version-gated 1.5–1.10.2.
    - **Coordinates**: the video is in dp × scale at mdpi, which matches iOS points at MEDIUM.

## 10. Takeaways for ouo

**Copy (MIT):**

- `RootViewsSpy` / `WindowSpy` window discovery (credit curtains, Apache 2.0) and the "last root wins" rule.
- `OnDrawListener` dirty flag + 1 fps tick + `PixelCopy` into a pre-sized **RGB_565** bitmap at dp resolution. It is cheap and gives ADR-0006's half-resolution frames almost for free.
- Masking at the view-tree level before anything is written to disk: per-line text rectangles in text colour, average colour for images, the drawable heuristic that keeps vectors, colours and gradients visible, `ouo-mask` / `ouo-unmask` tags (like `sentry-mask`), a Compose `SemanticsPropertyKey`, and the same default class list including WebView, VideoView, PreviewView and ExoPlayer.
- Buffer mode that keeps only on-disk frames and encodes nothing until an error. Finalising the last segment on the next launch from persisted frames + metadata, which is how crash replays survive.
- Rotate segments on configuration and size change. Pause session-mode capture when offline or rate-limited.
- The macrobenchmark setup (cold start, `CompilationMode.Full`, a `Trace` section around init, interleaved A/B, ≤ 12 iterations) for ouo's own init budget. Build-time manifest and class-availability injection is worth it only if ouo ships a Gradle plugin.

**Avoid or improve:**

- **Fail closed** when Compose traversal fails: mask the whole `AndroidComposeView` instead of leaving it unmasked.
- Do not re-encode and re-write an identical frame every second. Skip the frame and let the player hold it, which ouo's frame player can do with explicit timestamps.
- Keep the tree walk off the main thread where possible (snapshot only geometry on main), and use fixed-rate scheduling.
- Hand-written `key=value` segment metadata (the source calls it awful): use a small JSON file.
- No OTLP on Android: ouo should emit OTel spans and logs natively (`opentelemetry-android`, Appendix G) and keep replay frames on its own chunk path (ADR-0006). Sentry's `traceparent` opt-in shows W3C propagation can coexist with `sentry-trace` for the Sentry bridge.
- Budget: at 1 fps a Sentry MEDIUM session is ≤ ~0.56 MB/min of video. ADR-0006's JPEG frames at 20–40 KB per *changed* frame cost 1.2–2.4 MB/min when the screen changes every second. Dedupe and sampling matter more for ouo until video encoding exists, and `MediaCodec` + `MediaMuxer` (≈ 360 lines here) is a realistic later step.
