# Appendix A: Sentry on native iOS (sentry-cocoa), Swift and Objective-C

Written 2026-10-29 by the `sentry-ios` research session. Everything below was read in the source unless it is marked `[docs only]`, `[blog only]` or `[PR only]`. Wire sizes were measured in this repo from real captures.

**Citation key.** `cocoa:<path>:<line>` means `getsentry/sentry-cocoa` at tag **9.32.0**, commit `4e1e4ba9ce329f91ad6bfb63bab6da576a3f348c`. `sentry:<path>:<line>` means `getsentry/sentry` (the FSL server and frontend) at `main`, commit `ea830614952edf9dc1be0d134d3907b8016ff152` (2026-10-29). Relay was not needed: the `replay_video` layout is already settled in `project/kb/sentry-envelope-format.md` and checked against traffic in `project/kb/sentry-react-native-demo.md`.

## 1. Sources

| Source | Version studied | Licence | Notes |
|---|---|---|---|
| `github.com/getsentry/sentry-cocoa` | tag 9.32.0, `4e1e4ba9`, released 2026-10-29 | MIT (`cocoa:LICENSE.md:1`) | Cloned with `--filter=blob:none`. History searched with `git log` on paths. `git log -S` without blobs was too slow, so archaeology used `CHANGELOG.md` and `gh pr view`. |
| SentryCrash (inside sentry-cocoa) | same | MIT, a fork of KSCrash (`cocoa:THIRD_PARTY_NOTICES.md:9-17`) | Crash capture in C. |
| `github.com/getsentry/sentry` `static/app/` | `ea830614`, sparse checkout of the replay player | FSL | Read only to learn how Sentry plays mobile replays. Do not copy. |
| PR getsentry/sentry-cocoa#4940 | merged 2025-03-11, `82cac0c4` | MIT | View renderer V2: design notes and benchmark tables. |
| PR getsentry/sentry-cocoa#5054 | merged 2025-04-25, `886c0560` | MIT | V2 made GA and default. |
| PR getsentry/sentry-cocoa#7851 | merged 2026-06-24, `dbb7392f` (first tag 9.19.0) | MIT | Run-loop capture scheduler. |
| PR getsentry/sentry-cocoa#8636 | merged 2026-08-07, `853e8cde` (first tag 9.26.0) | MIT | Live encode reads frames from memory. |
| Commit `d888cf5b` (PR #8698) | 2026-08-06 | MIT | Removed the benchmark workflow and its code. |
| Blog: "Boosting Session Replay performance on iOS with View Renderer V2", Phil Niedertscheider, 2025-08-06 | n/a | n/a | https://blog.sentry.io/boosting-session-replay-performance-on-ios-with-view-renderer-v2/ |
| Docs: Session Replay performance overhead (Apple) | fetched 2026-10-29 | n/a | https://docs.sentry.io/platforms/apple/guides/ios/session-replay/performance-overhead/ |
| Captures in this repo | sentry-cocoa 9.30.1 under `@sentry/react-native` 8.30.0 | ours | `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/{journey,realtap,shop,touch}`. Setup in `project/kb/sentry-react-native-demo.md`. |

An earlier entry on main, [sentry-ios-replay-internals.md](../sentry-ios-replay-internals.md), covers 9.31.0 against ouo's `sdk/ios` with device measurements (≈ 22 ms main thread per capture on an iPhone 16 Pro Max); this appendix was written without it and agrees with it on every shared point.

Everything in the SDK is open source. Sentry distributes it both as source (SPM) and as a prebuilt `Sentry.xcframework`. Since 9.20 it is no longer on CocoaPods trunk (`project/kb/sentry-react-native-demo.md`).

## 2. Platforms and languages

| Target | Who does the work | Minimum OS | Replay? |
|---|---|---|---|
| Native iOS, Swift | sentry-cocoa | iOS 15 (`cocoa:Package.swift:419`) | yes |
| Native iOS, Objective-C (with Clang modules) | sentry-cocoa through `@objc` bridging | iOS 15 | yes, through `options.sessionReplay` and `SentrySDK.replay` (`@objc(SentryReplayApi)`, `cocoa:Sources/Swift/Integrations/SessionReplay/SentryReplayApi.swift:11-28`) |
| Objective-C / ObjC++ without modules | the new **`SentryObjC`** wrapper (SPM products `SentryObjC-Dynamic` / `-Static`, `cocoa:Package.swift:52-53`). Hand-written ObjC headers over the Swift SDK (`cocoa:develop-docs/SENTRY-OBJC.md`) | iOS 15 | yes (`SentryObjCReplayApi maskView:`, `cocoa:Sources/SentryObjC/Public/SentryObjCReplayApi.h`) |
| SwiftUI | `SentrySwiftUI` product (`cocoa:Package.swift:51`) | iOS 15 | yes, plus the `.sentryReplayMask()` modifiers |
| tvOS 15, visionOS 1, macOS 12, watchOS 9 | sentry-cocoa | per `Package.swift:419` | replay on iOS, tvOS and visionOS only (`#if os(iOS) \|\| os(tvOS) \|\| os(visionOS)` guards, e.g. `cocoa:Sources/Swift/Integrations/SessionReplay/SentrySessionReplayIntegration.swift:4`). visionOS was added in PR #8924 (2026-09-04). |
| React Native, Flutter | the hybrid SDKs call into sentry-cocoa (Appendix C) | | Same native pipeline. Hybrid SDKs can swap the breadcrumb converter and the **screenshot provider** (`cocoa:Sources/Swift/HybridSDK/SentryInternalReplayApi.swift:53-60`). |

**The codebase is now mostly Swift.** Line counts under `Sources/` at 9.32.0: Swift 53,064; Objective-C `.m` 22,465; ObjC++ `.mm` 1,423; C 16,133; C++ 1,407; headers 24,921. Who owns what:

- **Swift:** all of Session Replay (`Sources/Swift/Integrations/SessionReplay/`, `Sources/Swift/Core/Tools/ViewCapture/`), the session tracker, ANR v1/v2, app start, the frames tracker, time to display, UI events, the watchdog-termination logic, network tracking, MetricKit, options, `SentryHub.swift` and `SentryClient.swift`.
- **Objective-C:** the HTTP transport (`SentryHttpTransport.m`), the file-manager helper, the msgpack serializer, the swizzling helpers, trace propagation and the `SentryClient+ReplayAndFeedback` category.
- **C / C++:** SentryCrash, the async-safe replay crash info and the sampling profiler.

The internal guide says not to add `@objc` without a consumer (`cocoa:Sources/AGENTS.md:49`). The ObjC surface is therefore deliberately curated, and `SentryObjC` is the supported path for ObjC++ apps such as RN ≤ 0.76 AppDelegates (`cocoa:develop-docs/SENTRY-OBJC.md`).

## 3. RUM

| Feature | How it works | Swizzling? | Code |
|---|---|---|---|
| Sessions / release health | `didBecomeActive` starts a session. `willResignActive` stores a `lastInForeground` timestamp. On the next activation, if the app spent ≥ `sessionTrackingIntervalMillis` (default **30,000**) in the background, the old session ends at `lastInForeground` and a new one starts. `willTerminate` ends the session. A cached session left without a foreground timestamp is closed as abnormal on the next start. | no (notifications) | `cocoa:Sources/Swift/Integrations/Session/SessionTracker.swift:60-63,113-121,138-185,196-213`; `cocoa:Sources/Swift/Options.swift:316` |
| Crashes | SentryCrash, a KSCrash fork. The **Mach exception** monitor allocates a port and sets it with `task_set_exception_ports`. The **signal** monitor installs `sigaction` handlers on a `sigaltstack`. Further monitors catch C++ exceptions and NSException. The report is written in the handler and sent on the next launch. | NSException handler, not swizzling | `cocoa:Sources/SentryCrash/Recording/Monitors/SentryCrashMonitor_MachException.c:486-505`; `.../SentryCrashMonitor_Signal.c:227,266`; `.../Monitors/` (CPPException, NSException); fatal signal list `cocoa:Sources/SentryCrash/Recording/Tools/SentryCrashSignalInfo.c:118` |
| Watchdog / OOM terminations | The decision is made by elimination on the next launch. If the previous run was not a simulator build, release upgrade, OS upgrade, reboot, debugger session, normal termination, crash, inactive app, ongoing ANR, or second `SentrySDK.start`, it is reported as a watchdog termination. | no | `cocoa:Sources/Swift/Integrations/WatchdogTerminations/SentryWatchdogTerminationLogic.swift:43-124` |
| App hangs (ANR) | On iOS, tvOS and visionOS always **V2**. A watchdog thread `io.sentry.app-hang-tracker` sleeps `timeout/5`. It asks `SentryFramesTracker` for the frame delay over the window. A delay ≥ timeout with no rendered frame is **fully blocking**. A delay > 0.99 × timeout is **non-fully blocking**. The default timeout is **2 s**. V1 (main-queue ping, 5 ticks) is used only without UIKit. `enableAppHangTrackingV2` went GA in #5149. | no | `cocoa:Sources/Swift/SentryDependencyContainer.swift:585-597`; `cocoa:Sources/Swift/Integrations/AppHangTracking/SentryANRTrackerV2.swift:50,59-64,151-171`; `.../SentryANRTrackerV1.swift:63-102`; `cocoa:Sources/Swift/Options.swift:659`; `cocoa:CHANGELOG.md:1757` |
| App start | Process start time comes from `sysctl(KERN_PROC_PID)` `p_starttime`. For **prewarmed** launches the start is the module-initialisation time instead. The end is the first frame from the frames tracker. Starts ≥ **180 s** are discarded. **Cold vs warm:** first launch, new release, or a reboot since the last run → cold; same boot → warm. Spans: `app.start.cold`/`app.start.warm`, with children Pre Runtime Init, Runtime Init to Pre Main Initializers, UIKit Init, Application Init, Initial Frame Render, under the first `ui.load` transaction. | no | `cocoa:Sources/Sentry/SentrySysctlObjC.m:40-49`; `cocoa:Sources/Swift/Integrations/AppStartTracking/SentryAppStartTracker.swift:27,187-260,298-322`; `.../SentryBuildAppStartSpans.swift:18-29`; `cocoa:Sources/Sentry/SentrySpanOperation.m:26-28` |
| Slow / frozen frames | A `CADisplayLink` drives it. A frame is **slow** if it takes > `1/(fps-1)` s (adapts to ProMotion) and **frozen** if it takes > **0.7 s**. The frame delay feeds ANR V2, TTID/TTFD and replay. | no | `cocoa:Sources/Swift/Integrations/Performance/SentryDisplayLinkWrapper.swift:20`; `cocoa:Sources/Swift/Core/Integrations/FramesTracking/SentryFramesTracker.swift:63,380-399,477-481` |
| Screen loads (UIViewController) | Swizzles `loadView`, `viewDidLoad`, `viewWillAppear:`, `viewDidAppear:`, `viewWillDisappear:` and `viewWill/DidLayoutSubviews` on every UIViewController subclass found in the app's images. With the opt-in `enableUIViewControllerInitSwizzling` it swizzles per class at init instead. Creates `ui.load` transactions. | **yes** | `cocoa:Sources/Sentry/SentryUIViewControllerSwizzlingHelper.m:159-257`; `cocoa:Sources/Swift/Core/Integrations/Performance/SentryUIViewControllerSwizzling.swift:74-115,164-195`; `cocoa:Sources/Swift/SentryExperimentalOptions.swift:65` |
| TTID / TTFD | `SentryTimeToDisplayTracker` adds `ui.load.initial_display` on the next rendered frame. It adds full display when the app calls `SentrySDK.reportFullyDisplayed()` (`enableTimeToFullDisplayTracing`, default off). If the app never calls it, the span finishes as `deadline_exceeded`. | via the VC swizzle | `cocoa:Sources/Swift/Integrations/Performance/SentryTimeToDisplayTracker.swift:30-160`; `cocoa:Sources/Swift/Options.swift:770` |
| Network | Swizzles `URLSessionTask.resume` on every concrete task class, found through `setState:`. Optional new-loader swizzles and response-capture swizzles of `dataTask(with:)`. Creates `http.client` spans, `http` breadcrumbs and failed-request events (`enableCaptureFailedRequests`). Adds `sentry-trace` + `baggage` to requests that match `tracePropagationTargets` (default `.*`). | **yes** | `cocoa:Sources/Swift/Integrations/Performance/Network/SentryNetworkTrackingIntegration.swift:57-65,100-106`; `cocoa:Sources/Sentry/SentryNSURLSessionTaskSearch.m:53`; `cocoa:Sources/Swift/Networking/SentryNetworkTracker.swift:206,244-249,374,443-463`; `cocoa:Sources/Swift/Options.swift:692,701` |
| User interactions | Swizzles `UIApplication sendAction:to:from:forEvent:`. Produces `touch` breadcrumbs and `ui.action.click` transactions (`enableUserInteractionTracing`). Replay touches use a separate `sendEvent:` swizzle. | **yes** | `cocoa:Sources/Sentry/SentrySwizzleWrapperHelper.m:19,58`; `cocoa:Sources/Swift/Integrations/UIEventTracking/SentryUIEventTracker.swift:40-50` |
| Screenshot / view hierarchy on errors | `attachScreenshot` and `attachViewHierarchy` are both **off** by default. The screenshot reuses `SentryViewPhotographer`, so replay masking applies (`SentryScreenshotOptions.maskAllText` default true). On crash, a screenshot is attempted after the report is saved. | no | `cocoa:Sources/Swift/Options.swift:383,401`; `cocoa:Sources/Swift/Core/Tools/ViewCapture/SentryScreenshotSource.swift:13-30`; `cocoa:Sources/SentryCrash/Recording/SentryCrashC.c:105-108` |
| MetricKit | `enableMetricKit` is off by default. Subscribes to `MXMetricManager` and turns crash, disk-write, CPU-exception, hang and (iOS 16+) app-launch diagnostics into events marked "from previous process". | no | `cocoa:Sources/Swift/Core/MetricKit/SentryMXManager.swift:44,81-130`; `cocoa:Sources/Swift/Options.swift:752-759` |
| Profiling | A C++ sampling profiler thread at **101 Hz** (`thread_get_state` backtraces). Continuous mode sends 60 s chunks. Configured with `configureProfiling`. | no | `cocoa:Sources/Sentry/SentryProfiler.mm:35`; `cocoa:Sources/Sentry/SentrySamplingProfiler.cpp:137-145`; `cocoa:Sources/Sentry/Profiling/SentryContinuousProfiler.mm:26,211`; `cocoa:Sources/Swift/Options.swift:602` |
| Custom spans, logs, metrics | `SentrySDK.startTransaction`, `SentrySDK.logger` (OTel severity numbers), `SentrySDK.metrics` | no | `cocoa:Sources/Swift/Protocol/SentryLogLevel.swift:5,62` |

Swizzling is global and can be switched off with `enableSwizzling = false` (`cocoa:Sources/Swift/Options.swift:583`) or narrowed with `swizzleClassNameExcludes` (`:590`). With swizzling off, replay loses **touches** because the touch tracker is installed only when swizzling is on (`SentrySessionReplayIntegration.swift:178-186`). Screen loads, network spans and UI breadcrumbs are lost too.

## 4. Session replay

### 4.1 Lifecycle and sampling

1. `SentrySessionReplayIntegration` is installed before `SentryCrashIntegration` (`cocoa:Sources/Swift/Core/Integrations/Integrations.swift:62-68`). It registers as a **session listener** on the hub. It also observes `didBecomeActive` and `UIScene.didActivate` so it can retry a start until a window exists (`SentrySessionReplayIntegration.swift:120-125,264-293`).
2. Each new Sentry session draws once: `random < sessionSampleRate` → **session** mode. Otherwise, if `onErrorSampleRate > 0` → **buffer** mode. Otherwise nothing is recorded (`:249-262`). Both rates default to 0 (`cocoa:Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift:12-13`). One replay id per session. A session end stops the replay (`:244-247`).
3. Replay pauses on `didEnterBackground` and resumes on `didBecomeActive` (`:404-405`). It pauses while offline: reachability drives `pauseSessionMode` / `resumeSessionMode` (`:607-618`). It stops after `maximumDuration` = **60 min** (`SentryReplayOptions.swift:45`, `SentrySessionReplay.swift:479-487`). It stops when `X-Sentry-Rate-Limits` covers `replay` or `all` (`SentrySessionReplayIntegration.swift:555-566`).
4. **Buffer → session.** For every error event in buffer mode, a second draw against `onErrorSampleRate` decides whether to flush (`SentrySessionReplayIntegration.swift:553`, `SentrySessionReplay.swift:365-404`). A flush encodes the last `errorReplayDuration` = **30 s** (+ half a frame) and switches the instance to session mode. `replay_type` stays `buffer` (`SentrySessionReplay.swift:430-438`). The event gets `contexts.replay.replay_id` and a `replayId` tag (`:440-456`). A segment also records the trace ids seen during it (`traceIds`, max 100; `:143-156,847-856`).

### 4.2 Capture cadence: a run-loop observer, not a timer

Since 9.19.0 (PR #7851) there is no `CADisplayLink` or `Timer`. A **`CFRunLoopObserver` on the main run loop** in `.commonModes` fires capture checks after the run loop has done UI work (`beforeWaiting`/`exit` following `afterWaiting`/`beforeTimers`/`beforeSources`) (`cocoa:Sources/Swift/Integrations/SessionReplay/SentrySessionReplayRunLoopCaptureScheduler.swift:54-78,95-108`). Each pass runs `captureFrameIfNeeded` (`SentrySessionReplay.swift:458-556`):

| Rule | Value | Code |
|---|---|---|
| Base interval | `1 / frameRate`. `frameRate` is SPI with default **1** (`SentryReplayOptions.swift:42,465-470`). | `SentrySessionReplay.swift:559-561` |
| Interaction (run loop in `.tracking` mode, a scroll view dragging or decelerating, a `UIControl` tracking, or a gesture `.began`/`.changed`) | capture at the base interval, no backoff | `SentrySessionReplayCaptureGuard.swift:15-39`; `SentrySessionReplay.swift:499-504` |
| Animations (≥ 4 `layer.animationKeys()` in the tree) | defer by 0.25 s, at most 1 s, then force a capture | `SentrySessionReplayCaptureGuard.swift:8,41-48`; `SentrySessionReplay.swift:649-698` |
| Adaptive backoff | Main-thread cost (redact + render) ≥ **150 ms** doubles the idle interval, up to **2 s**. Faster captures halve it. | `SentrySessionReplay.swift:658-662,700-714` |
| One in flight | skip while the previous screenshot is still processing | `:489-492,895-903` |

Before #7851, cocoa captured from a display-link callback. #7851 reports, on an iPhone 15 / iOS 26.5 release build with Sentry's "benchmark app": slow frames 4.1% → 1.4%, p99 frame 74.9 → 25.7 ms, average FPS 55.1 → 58.4 `[PR only]`. That benchmark app is not in the repo.

### 4.3 Taking a frame (main thread, then background)

`SentryViewPhotographer.timedImage` (`cocoa:Sources/Swift/Core/Tools/ViewCapture/SentryViewPhotographer.swift:66-96`):

1. **Redact (main thread).** `SentryUIRedactBuilder.redactRegionsFor(view:)` walks the **presentation layer** tree of the key window and returns `SentryRedactRegion`s (`size`, global `CGAffineTransform`, `type`, `color`) (`SentryUIRedactBuilder.swift:448-472`).
2. **Render (main thread).** `renderer.render(view:)` draws the window into a bitmap (see 4.5).
3. **Mask (background, `SentryDispatchQueueWrapper`).** `maskRenderer.maskScreenshot(... scale: 1)` draws the bitmap at **1×** (points) and fills the regions (`:80-95`).
4. The masked `UIImage` goes to `SentryOnDemandReplay.addFrameAsync` on `io.sentry.session-replay.processing` (utility QoS, relative priority −2) (`SentrySessionReplay.swift:908-916`; `SentrySessionReplayIntegration.swift:170-176`).

### 4.4 Redaction

**Default masked classes** (`SentryUIRedactBuilder.swift:142-253`):

| Option | Classes |
|---|---|
| `maskAllText` (default true) | `UILabel`, `UITextView`, `UITextField`, **`RCTTextView`, `RCTParagraphComponentView`** (React Native text, matched by class name so RN text is masked even when cocoa is started by hand), `SwiftUI.CGDrawingView`, and the pre-iOS 18 SwiftUI text view stored as base64 to avoid App Review false positives (`:146-173`) |
| `maskAllImages` (default true) | `UIImageView`, the SwiftUI SF Symbol hit-testing view (base64), `SwiftUI._UIGraphicsView` **only when its layer is `SwiftUI.ImageLayer`**, `RCTImageView` (`:175-196`) |
| always | `PDFView`, `WKWebView`, `UIWebView`, `SFSafariView`, `AVPlayerView`, `_UICollectionViewListLayoutSectionBackgroundColorDecorationView` (`:200-223`) |
| ignored by default | `UISlider`, `UISwitch` (the source says "The reason why exactly they are ignored is unknown") (`:225-230`) |
| iOS 26+ Liquid Glass | SwiftUI draws text and images as bare `CALayer`s without a `UIView`, so layer classes are matched: `CGDrawingLayer`, `SwiftUI.ImageLayer`, `ColorShapeLayer` (`:260-283,621-637`) |

Class matching walks superclasses for masking but **not** for unmasking: unmasking `UILabel` does not unmask subclasses (`:308-372`). `UIImageView` is exempt when the image is ≤ 10 px on a side (a gradient strip), an SF Symbol, or a bundle asset (`description` contains `named(`) (`:534-552`).

**Per-instance overrides** are associated objects on the view (`SentryRedactViewHelper.swift:19-49`):

- UIKit: `view.sentryReplayMask()` / `view.sentryReplayUnmask()` (`cocoa:Sources/Swift/Core/Extensions/UIViewExtensions.swift:13-24`) or `SentrySDK.replay.maskView(_:)` / `unmaskView(_:)` (`@objc`).
- SwiftUI: `.sentryReplayMask()` / `.sentryReplayUnmask()` add a transparent `UIViewRepresentable` overlay, `disabled(true)`, tagged `maskSwiftUI` or `clipOutView` (`cocoa:Sources/Swift/SentrySwiftUI/SentryReplayView.swift:10-58`). `.redactSwiftUI` regions are always painted last, so they win (`SentryUIRedactBuilder.swift:459-471`).
- Unmasking an instance propagates to its subtree. Class- and container-based ignore do not (`:579-603`).

**Geometry and occlusion** (`SentryUIRedactBuilder.swift:555-695,761-838`):

- Each layer's global transform is `position` (converted to window space) ∘ `layer.transform` ∘ `-anchorPoint` (`:761-771`).
- Hidden or zero-opacity layers are skipped (`:556`).
- A redacted view that `clipsToBounds` stops the descent. Otherwise its children are force-redacted (`:587-599`).
- An **opaque** unmasked view (view and layer both opaque, alpha 1, solid background) emits `clipOut`. If it covers the whole window and is axis aligned, it **clears** every region found so far (`:607-620,810-838`).
- `masksToBounds` emits a `clipBegin`/`clipEnd` pair. Siblings are sorted by `zPosition` and then index (`:658-694`).
- The list is reversed so clips apply before masks (`:446-471`). The mask renderer fills each region with the label's `textColor`, or else the **average colour of the pixels underneath** (`SentryDefaultMaskRenderer.swift:38-45`; `SentryUIRedactBuilder.swift:784-786`). It skips a region identical to the previous one, which is common in SwiftUI (`SentryDefaultMaskRenderer.swift:40-42`).

**Crash safety.** `layer.sublayers` and `layer.presentation()` are read inside an Objective-C exception handler. A malformed `CABasicAnimation` raises NSException. When that happens the whole subtree is masked (`:640-654,697-735`).

**Exclusions.** `excludedViewClasses` / `includedViewClasses` patterns skip subtrees that crash or are expensive. Excluded subtrees are fully masked. The iOS 26 camera chrome is excluded by default (`SentryViewSubtreeTraversal.swift:72-78`; `SentryUIRedactBuilder.swift:737-758`).

**Flutter and other hybrids.** Cocoa does not know Flutter widgets. A hybrid SDK hands in its own `SentryViewScreenshotProvider`, which bypasses the photographer and its redaction (`SentryInternalReplayApi.swift:53-60`; `SentrySessionReplayIntegration.swift:500-511`). RN text and images are covered by the class list above. The RN SDK adds `RCTImageComponentView, RCTParagraphComponentView` as `maskedViewClasses`, as seen in our capture's `options` event.

### 4.5 View renderer V1 vs V2 vs "fast"

| Mode | Option | Code | What it does |
|---|---|---|---|
| V1 ("default") | `enableViewRendererV2 = false` | `cocoa:Sources/Swift/Core/Tools/ViewCapture/SentryDefaultViewRenderer.swift:8-13` | Creates a new `UIGraphicsImageRenderer(size:)` per frame, at screen scale, and calls `view.drawHierarchy(in:afterScreenUpdates: false)` |
| **V2** (default since 8.50.0) | `enableViewRendererV2 = true` (`SentryReplayOptions.swift:18,287`) | `.../SentryViewRendererV2.swift:14-28` + `.../SentryGraphicsImageRenderer.swift:43-89` | Same `drawHierarchy`, but into a hand-made `CGContext`: one `calloc` of `w*scale × h*scale × 4` bytes, flipped CTM, `UIGraphicsPushContext`, `makeImage()`, `free`. No UIKit renderer and no context cache. The same flag selects `SentryMaskRendererV2`, which uses the same bitmap code for the mask pass (`SentrySessionReplayIntegration.swift:148-167`; `SentryMaskRendererV2.swift:7-13`). |
| V2 + fast | `enableFastViewRendering = true` (default false, `SentryReplayOptions.swift:19,310`) | `SentryViewRendererV2.swift:21-22` | `view.layer.render(in: cgContext)` instead of `drawHierarchy`. It does not go through the render server, so some content is missing: PR #4940 and the docs show tab-bar SF Symbol icons absent (`SentryReplayOptions.swift:301-303`). |

Captures always run with `afterScreenUpdates: false`, so the main thread never forces a layout and commit. After rendering, frames are downscaled to 1× in `rescaleImage` (`SentryOnDemandReplay.swift:148-160`). The video is therefore in **points** (402×874 on an iPhone 18 Pro, confirmed in our capture).

### 4.6 Frames → video

- **Per frame** (`cocoa:Sources/Swift/Integrations/SessionReplay/SentryOnDemandReplay.swift:113-146`): rescale to 1×, write a **PNG** to `<replay dir>/<timestamp>.png` (kept for crash recovery), keep the `UIImage` in memory for live encoding (#8636), and trim to `cacheMaxSize`. `cacheMaxSize` = segment seconds × fps + 1, i.e. **6 frames in session mode and 31 in buffer mode** (`SentrySessionReplayIntegration.swift:378-388`).
- **No de-duplication on the device.** Every capture is stored. The encoder repeats the last frame to fill every 1 s slot (`SentryVideoFrameProcessor.swift:98-147,191-208`), so `frameCount` always equals the seconds. Compression of identical frames is left to H.264 P-frames.
- **Segment cut.** After each capture, `prepareFullSessionSegmentsIfNeeded` cuts a segment once `sessionSegmentDuration` = **5 s** has passed (`SentryReplayOptions.swift:44`; `SentrySessionReplay.swift:717-760`). Real segments are **5 or 6 s** because the check runs at frame granularity, plus a short tail segment on backgrounding (2 s in our capture).
- **Encoder.** `AVAssetWriter` with `.mp4` output and `AVAssetWriterInput` fed from a `CVPixelBuffer` in `kCVPixelFormatType_32ARGB` (`SentryOnDemandReplay.swift:327-350`; `SentryPixelBuffer.swift:39`). Settings (`SentryOnDemandReplay.swift:381-437`): **H.264 Main AutoLevel**, `AVVideoAverageBitRateKey` = `quality.bitrate` (low 20 kbit/s, **medium 40 kbit/s (default)**, high 60 kbit/s; `SentryReplayOptions.swift:52-112`), `AllowFrameReordering = false` (no B-frames), `MaxKeyFrameInterval = 6`, BT.709 colour. `sizeScale` is 0.8 for `low` and 1.0 otherwise (`:110-112`). Our captures decode as AVC profile 77 (Main) level 3.1. A change of image size ends the video and starts a new one (`SentryVideoFrameProcessor.swift:155-157`).
- **Threading.** The asset worker queue `io.sentry.session-replay.asset-worker` has relative priority −1. The processing queue waits on it with `DispatchGroup.wait(timeout: 10 s)` (`SentryOnDemandReplay.swift:228-274`; `SentrySessionReplayIntegration.swift:170-176`).

### 4.7 Recording, events and envelope

- **`replay_recording`** = `{"segment_id":n}\n` + a JSON array. It starts with a meta event (type 4, width and height) and a video custom event (type 5, `tag:"video"`, `segmentId`, `size`, `duration`, `encoding:"h264"`, `container:"mp4"`, `frameCount`, `frameRateType:"constant"`, `frameRate`, `left`, `top`) (`SentryReplayRecording.swift:7-9,21-54`). Event types are `touch=3`, `meta=4`, `custom=5` (`RRWeb/SentryRRWebEvent.swift:6-11`).
- **Breadcrumbs** become custom events via `SentrySRDefaultBreadcrumbConverter` (`SentrySRDefaultBreadcrumbConverter.swift:49-112`):
  - `http` → an rrweb **span** event `op:"resource.http"` with method, status, sizes and, if `networkDetailAllowUrls` matches, headers and bodies.
  - `navigation` → `navigation` with `to`.
  - `touch` → `ui.tap`.
  - lifecycle → `app.foreground`/`app.background`.
  - also `device.connectivity`, `device.battery` and `device.orientation`.
  - Segment 0 also carries an `options` event (`SentrySessionReplay.swift:867-874`).
- **Touches** come from swizzled `UIApplication.sendEvent:`. Positions are `touch.location(in: nil)` × `sizeScale`. Moves are dropped if < 10 pt from the previous one and thinned when collinear (within 0.05 rad), but a pause > 500 ms is kept (`SentryTouchTracker.swift:84-100,140-179`). They are emitted as incremental source 2 types 7/9 and source 6 `positions[]` (`:190-216`; wire shape in `project/kb/sentry-react-native-demo.md`).
- **Envelope.** `SentryEnvelopeItem(replayEvent:replayRecording:video:)` builds an **`NSDictionary`** `{replay_event, replay_recording, replay_video}` (`cocoa:Sources/Swift/Tools/SentryEnvelopeItem.swift:168-203`). `SentryMsgPackSerializer` writes a fixmap (`0x80|count`), str8 keys and **bin32** values, streaming the mp4 from its file URL (`cocoa:Sources/Sentry/SentryMsgPackSerializer.m:14-39`). Because it iterates an `NSDictionary`, the key order is not stable: that is the cause of the varying order seen on the wire. The envelope holds this one item. Its header carries the replay event's `sdk`, which hybrids override (`cocoa:Sources/Sentry/SentryClient+ReplayAndFeedback.m:66-113`). The temporary mp4 is deleted after enveloping (`SentrySessionReplay.swift:880-885`).

### 4.8 Crash: the last seconds are sent on the next launch

- `SessionReplayFileManager` writes `replay/replay.current` (JSON: `replayId`, `path`, `errorSampleRate`, `replayType`) and arms an **async-signal-safe C struct** with the crash-info path (`SessionReplayFileManager.swift:12-14,34-63`; `cocoa:Sources/Sentry/SentrySessionReplaySyncC.c:16-56`).
- Each sent segment updates `segmentId` and `lastSegmentEnd` (`SentrySessionReplayIntegration.swift:572-576`).
- The SentryCrash handler calls `sentrySessionReplaySync_writeInfo()`, which uses only `open`/`write`, right after writing the crash report (`cocoa:Sources/SentryCrash/Recording/SentryCrashC.c:105`; `cocoa:Sources/Sentry/KSCrash/SentryKSCrashReportWriterCallbacks.c:203`; `SentrySessionReplaySyncC.c:58-95`).
- On the next start the integration renames `replay.current` → `replay.last` (`SentrySessionReplayIntegration.swift:116`).
- When the **fatal event** passes the global event processor, `SessionReplayRecovery.resumePreviousSessionReplay` runs (`SentrySessionReplayIntegration.swift:196-201`; `SessionReplayRecovery.swift:49-102`):
  - Session mode: encodes the PNGs from `lastSegmentEnd`, as segment `segmentId+1`, 5 s.
  - Buffer mode: re-samples with the saved `errorSampleRate` and encodes the last 30 s as segment 0 (`:115-168`).
  - Puts the replay id into the crash event's context.
- In buffer mode a crash therefore still yields up to 30 s of replay. The PNG frames on disk are what makes that possible.

## 5. Transport and OpenTelemetry

- **Endpoint:** `POST <dsn base>/envelope/` (`cocoa:Sources/Swift/SentryDsn.swift:91-96`).
- **Compression:** always gzip with `Content-Encoding: gzip` (`cocoa:Sources/Swift/Tools/SentryURLRequestFactory.swift:30-33`). On replay this saves only about 5% because the mp4 dominates (measured in 7).
- **Disk cache:** every envelope is written to disk before sending. At most `maxCacheItems` = **30** envelopes are kept (oldest dropped) and anything older than 90 days is deleted (`cocoa:Sources/Swift/Options.swift:173`; `cocoa:Sources/Sentry/SentryFileManagerHelper.m:137,988-1016`). Replay envelopes count towards the 30, so long offline periods drop replay or other telemetry.
- **Offline:** the transport observes reachability and flushes the cache when the connection returns (`cocoa:Sources/Sentry/SentryHttpTransport.m:9,87-133`). Replay capture itself pauses while offline (4.1).
- **Rate limits:** `X-Sentry-Rate-Limits` and `Retry-After` per category, including `replay` (`cocoa:Sources/Swift/Networking/DefaultRateLimits.swift:7-8`).
- **OTel:** **there is no OTLP export or OTel bridge in sentry-cocoa.** `grep -ri 'opentelemetry\|otlp\|otel' Sources` finds only comments: log severity numbers follow the OTel spec (`SentryLogLevel.swift:5,62`) and span data keys follow semconv (`cocoa:Sources/Sentry/include/SentrySpanDataKey.h:8`). Propagation is **`sentry-trace` + `baggage`** (`cocoa:Sources/Sentry/Public/SentryTraceHeader.h:15`; `cocoa:Sources/Sentry/Public/SentryBaggage.h:7`). W3C `traceparent` is added only with `enablePropagateTraceparent = true`, default **false** (`cocoa:Sources/Sentry/SentryTracePropagation.m:8,65-71`; `cocoa:Sources/Swift/Options.swift:685-690`).

## 6. Other features

- **Replay linked to issues:** errors carry `contexts.replay.replay_id` (4.1). Feedback captures resolve their own replay through `captureReplayForFeedback` (`SentrySessionReplayIntegration.swift:493-498`).
- **User feedback widget,** feature flags (`Sources/Swift/FeatureFlags`) and logs and metrics APIs exist.
- **No funnels, heatmaps or surveys** in the SDK.
- **Masking preview for developers:** `SentrySDK.replay.showMaskPreview(opacity)` overlays the computed regions, only while a debugger is attached (`SentrySessionReplayIntegration.swift:526-544`). SwiftUI previews have `SentryReplayMaskPreview`.
- **Network detail capture:** request and response headers and bodies for URLs in `networkDetailAllowUrls` (default empty), with a deny list. Bodies are on by default once a URL matches (`SentryReplayOptions.swift:33-37,312-370,500-523`).

## 7. Performance footprint

### 7.1 Vendor numbers and how they were measured

| Claim | Number | Method | Where |
|---|---|---|---|
| V1 render time per frame | p50 149 ms render + 6 ms redact, about 155 ms total, iPhone 8 at 2× | Hand-added `DispatchTime` timing around redact and render in `SentryViewPhotographer`, rolling 120 samples printed as min/max/avg/p50/p75/p95, sample app `iOS-Swift` on an iPhone 8 (iOS 15.7 per the blog). Not committed. Unit tests could not render ("has not been committed to render server"). | PR #4940 body `[PR only]`; blog `[blog only]` |
| Reusing `UIGraphicsImageRenderer` | no change (149.5 ms avg) | same | PR #4940 |
| V2 (custom CGContext + drawHierarchy) at 2× | avg 25.4 ms, p95 30.3 ms (render); total avg 31.4 ms | same | PR #4940; `SentryReplayOptions.swift:276-280` quotes "~160ms to ~36ms" |
| V2 at 1× | avg 38.8 ms, slower than at 2× | same | PR #4940 |
| `layer.render(in:)` + custom context | avg 20.7 ms render, total 26.8 ms, incomplete images | same | PR #4940; `SentryReplayOptions.swift:292-294` |
| Frames dropped per capture | 9-10 → about 2 per second on iPhone 8 | derived from the times above | blog `[blog only]`, docs `[docs only]` |
| Overhead with replay on (Pocket Casts, iPhone 14 Pro, full masking, 10 runs, medians) | FPS 55 → 53, memory 102 → 121 MB, CPU 4% → 13%, cold start unchanged (1264.8 → 1265 ms), about 25 ms main thread per capture, **10 KB/s** network | Not described beyond "same user flow 10 times" | docs `[docs only]` |
| Run-loop scheduler (#7851) | slow frames 4.1% → 1.4%, p99 74.9 → 25.7 ms (iPhone 15, iOS 26.5) | "benchmark app" outside the repo | PR #7851 `[PR only]` |

**Is the benchmark code in the repo?** No.

- There are no `XCTMetric` / `measure(metrics:)` tests anywhere in the tree (grep over `*.swift`).
- Until 2026-08-06 the repo had a `Benchmarking.yml` workflow. It ran `SentrySDKPerformanceBenchmarkTests.testProfilerCPUUsage` on Sauce Labs (iPad Pro 11 2024 / iOS 17 and iPhone SE 2022 / iOS 18). The test launched `iOS-Swift` 20 times with `--io.sentry.test.benchmarking`, ran 15 s of CPU work, and computed the profiler's CPU share via `SentryBenchmarking.mm`. That benchmarked **profiling only, never replay**. Commit `d888cf5b` (PR #8698, "remove benchmark workflow and infrastructure") deleted it, with 1,061 lines across 17 files.
- The only leftover is the `isBenchmarking` launch-argument switch in the sample app (`cocoa:TestApps/SentrySampleShared/Sources/SentrySampleShared/SentrySDKWrapper.swift:269-303,739-740`).
- Size is tracked by `size-analysis.yml` (`cocoa:.github/workflows/size-analysis.yml:1,56-125`), not by a Dangerfile.
- The V2 numbers came from a one-off manual run.

### 7.2 Estimates read from the code (iPhone 18 Pro, 402×874 pt, 3×)

| Item | Estimate | Basis |
|---|---|---|
| Main-thread work per capture | redact (tree walk) + V2 render, at most one capture per second when idle and backed off to ≤ 2 s if a capture costs ≥ 150 ms | 4.2, 4.3 |
| Transient render buffer | 1206 × 2622 × 4 B ≈ **12.1 MiB** `calloc`ed and freed on each capture | `SentryGraphicsImageRenderer.swift:45-58`; `SentryViewRendererV2.swift:18-20` |
| Kept frame (1×) | 402 × 874 × 4 B ≈ **1.34 MiB** decoded | `SentryOnDemandReplay.swift:148-160` |
| Frames held in memory | 6 in session mode (≈ 8 MiB), **31 in buffer mode (≈ 42 MiB)** if the `UIImage`s stay decoded. PR #8636 states "memory cost is ~5–6 frames in session mode; buffer mode holds ~30". | `SentrySessionReplayIntegration.swift:383-386`; `SentryReplayFrame.swift:8-16` |
| Disk | One PNG per captured frame, up to 6 or 31 kept, plus one temporary mp4 per segment (deleted after enveloping), plus up to 30 cached envelopes | 4.6, 5 |
| Threads | main (run-loop observer, redact, render), the photographer's background queue (mask), `session-replay.processing`, `session-replay.asset-worker` (AVAssetWriter), the transport queue | 4.3, 4.6 |
| Bandwidth bound from the code | medium: 40 kbit/s → about 25 KB per 5 s → about **293 KiB/min**. Low 146 KiB/min, high 439 KiB/min. AVFoundation treats the bitrate as a target, not a cap. | `SentryReplayOptions.swift:106-108` |

### 7.3 Measured wire size (this repo)

Measurement:

- Decoder: a standalone script (`replay_sizes.py` in this session's scratchpad; minimal msgpack + MP4 box parser), run over all 77 `replay_video` items in `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/`.
- **The capture came from a React Native app** (`@sentry/react-native` 8.30.0, Expo, iPhone 18 Pro simulator, iOS 27). The **native code path is sentry-cocoa 9.30.1**: same photographer, encoder and msgpack writer.
- Only the envelope `sdk` name differs (`sentry.javascript.react-native`), and the RN layer adds `maskedViewClasses`.
- Quality was `medium` in every run, 1 fps.

| Run | Masking (segment-0 `options`) | Segments | Seconds | mp4 total | mp4 per segment (median, min–max) | mp4 per minute | gzip body per minute |
|---|---|---|---|---|---|---|---|
| journey | maskAllText + maskAllImages on | 16 | 85 | 159,457 B | 9,585 (5,763–15,661) | **109.9 KiB** | 121.7 KiB |
| touch | on | 8 | 44 | 80,997 B | 9,535 (7,459–16,012) | **107.9 KiB** | 120.5 KiB |
| shop | **off** | 25 | 136 | 844,664 B | 33,511 (17,096–51,844) | **363.9 KiB** | 378.6 KiB |
| realtap | **off** | 28 | 158 | 973,813 B | 35,738 (29,647–50,006) | **361.1 KiB** | 374.1 KiB |
| all | mixed | 77 | 423 | 2,058,931 B | 30,174 | 285.2 KiB | 298.5 KiB |

The golden folder holds a fifth run, `selfhosted` (the remaining 24 items, masking off), which the decode left out; a reviewer's re-decode put it at 364.8 KiB/min, in line with `shop` and `realtap`. The four runs above are the measured set.

Per-segment facts from the decoded items:

- Every segment is 402×874, 1 fps, `frameCount` = seconds (5 or 6, tail segments 2).
- `replay_event` JSON: median **1,701 B** (1,672–2,222).
- `replay_recording`: **378–381 B** with no breadcrumbs. Median 657 B. Up to 5,475 B with 13 breadcrumbs and 4 touches.
- msgpack and envelope overhead is about 100 B. gzip shrinks the body by only about 5%.

**Why the video size depends on masking and not on activity.** Each segment is a standalone mp4 that starts with an I-frame (`stss` = sample 1). Further I-frames appear only on big changes.

- Masked: the I-frame is 4.2–4.9 KB and the P-frames are 0.2–1.1 KB (journey/000004 samples `[4166, 455, 567, 704, 1033]`).
- Unmasked: the I-frame is 24–27 KB (realtap/000005 `[25633, 975, 672, 947, 617]`). A screen change mid-segment adds a 44 KB keyframe (shop/000053 `[4912, 211, 43910, 204, 1685, 106]`).
- A static screen still costs one full I-frame every 5 s. Masked screens compress well because the mask boxes are flat colour.

**Extrapolation for one active user:** about **110 KiB/min ≈ 6.4 MiB/hour** with default masking, and about **362 KiB/min ≈ 21 MiB/hour** unmasked. Both are below Sentry's 10 KB/s ≈ 586 KiB/min docs figure. A 30 s buffer flush is about 6 segments, roughly 60 KB masked or 210 KB unmasked. By comparison, ADR-0006's JPEG-frame design (20–40 KB per changed frame at 1 fps) would be about 1.2–2.4 MB/min while the screen changes, **5–20× more than Sentry's H.264**.

## 8. Blog-to-code grounding (View Renderer V2)

| Blog claim | Grounded in | Verdict |
|---|---|---|
| Replay captures one screenshot per second into 5-second segments | `SentryReplayOptions.swift:42,44`; run-loop pacing `SentrySessionReplay.swift:559-561` | True. Since 9.19.0 the cadence is "at most 1/s when due, after run-loop work", with backoff and animation deferral, not a fixed tick. |
| Redact and Render must run on the main thread; Mask can run in the background | `SentryViewPhotographer.swift:70-95` | True |
| V1 created a new `UIGraphicsImageRenderer` per call and `drawHierarchy` took about 155 ms on iPhone 8 | `SentryDefaultViewRenderer.swift:8-13`; numbers from PR #4940 | Code true. Numbers come from a manual run (7.1). |
| Reusing the renderer did not help | PR #4940 "Alternative Attempts" | `[PR only]`. That code was never merged. |
| V2 = a custom `SentryGraphicsImageRenderer` on a raw `CGContext` at screen scale, about 80% less main-thread time | `SentryGraphicsImageRenderer.swift:6-89`; `SentryViewRendererV2.swift:14-28` | True. The class comment states the motivation. |
| Native scale is faster than 1× | `SentryViewRendererV2.swift:15-20` uses `screen.scale`, and the mask pass downscales afterwards (`SentryViewPhotographer.swift:85-86`) | True, implemented. |
| `layer.render(in:)` is faster but loses tab-bar icons, so it is opt-in as `enableFastViewRendering` | `SentryViewRendererV2.swift:21-25`; `SentryReplayOptions.swift:289-310`, default false `:19` | True |
| Shipped as experimental in **8.48.0** (`enableExperimentalViewRenderer`) | `CHANGELOG.md:1834-1850` lists it under **8.47.0** (#4940). The 8.48.0 entry is a fix to its initialisation (#4988, `:1832`). | The blog's version is off by one. |
| Default from **8.50.2** | `CHANGELOG.md:1746-1769`: **8.50.0** "GA of better session replay view renderer V2 (#5054)" and enabled by default. 8.50.2 (#5210, `:1723-1728`) fixed the defaults for the convenience initialiser and the dictionary options. | Both are true depending on the API path. Today: `DefaultValues.enableViewRendererV2 = true` (`SentryReplayOptions.swift:18`). The old name `enableExperimentalViewRenderer` is a deprecated alias (`:264-272`). |
| V2 also uses a new mask renderer | `SentryViewPhotographer.init` picks `SentryMaskRendererV2` when the V2 flag is set (`SentryViewPhotographer.swift:54`; `SentrySessionReplayIntegration.swift:155-166`) | True, though the blog does not mention it. |
| Known issues: heavy animations, HDR | Animation deferral and backoff were added later in #7851 (`SentrySessionReplayCaptureGuard.swift`). Nothing HDR-specific; the encoder colour is fixed at BT.709 (`SentryOnDemandReplay.swift:421-435`). | Partly addressed. |

## 9. Questions asked and answers

1. **Who starts replay?** The session listener: `sentrySessionStarted` runs a sample draw and starts on the first window, retrying on `didBecomeActive` / scene activation (`SentrySessionReplayIntegration.swift:239-314`). With the app inactive (a system alert, for example) it waits, which is what `project/kb/sentry-react-native-demo.md` observed.
2. **Timer cadence?** No timer. A CFRunLoop observer, at most 1 fps by default, backing off to ≤ 2 s on slow captures and deferring ≤ 1 s during animations (4.2).
3. **Which thread?** Redact and render on main. Mask on a background queue. PNG write and video encode on the two utility queues (4.3, 4.6).
4. **`drawHierarchy` or `layer.render`?** `drawHierarchy(afterScreenUpdates:false)` by default in both V1 and V2. `layer.render(in:)` only with `enableFastViewRendering` (4.5).
5. **Identical frames de-duplicated?** No. Every capture is stored. The encoder fills every slot by repeating the last frame and relies on H.264 (4.6).
6. **Codec, bitrate, fps, resolution?** H.264 Main, 20/40/60 kbit/s, 1 fps, points × `sizeScale` (0.8 for low, 1.0 otherwise), keyframe interval ≤ 6, no B-frames (4.6).
7. **Segment length?** 5 s nominal, 5–6 s observed. Buffer of 30 s. Maximum 60 min (4.1, 4.6).
8. **How do segments reach the network?** One envelope per segment with a single `replay_video` msgpack item `{replay_event, replay_recording, replay_video}`. The key order is random because it comes from an NSDictionary (4.7).
9. **What happens on crash?** The crash handler writes segment id and last end time with async-safe I/O. On the next launch the fatal event triggers re-encoding of the on-disk PNGs (4.8).
10. **How are RN text views found?** By class name (`RCTTextView`, `RCTParagraphComponentView`, `RCTImageView`) in the default list, plus RN-supplied `maskedViewClasses` (4.4).
11. **Flutter?** Cocoa cannot see widgets. The hybrid SDK injects its own screenshot provider through `SentrySDK.internal.replay.configure` (4.4; Appendix C).
12. **Clipping and transforms?** Presentation-layer transforms are composed per layer. Opaque views clip out or clear regions. `masksToBounds` pushes and pops clips. Regions are reversed and drawn as transformed rect paths (4.4).
13. **Touches in the recording?** Yes, via a `sendEvent:` swizzle (only with `enableSwizzling`), debounced (4.7).
14. **Network in the recording?** Yes, as `resource.http` span events from breadcrumbs, with optional headers and bodies for allow-listed URLs (4.7, 6).
15. **Is the V2 benchmark reproducible from the repo?** No. It was a manual timing patch on an iPhone 8. The only CI benchmark measured profiler CPU and was deleted in August 2026 (7.1).
16. **Can an Objective-C app use replay and every RUM feature?** Yes. Options and `SentrySDK.replay` are `@objc`. Apps without modules use the `SentryObjC` wrapper. SwiftUI modifiers are Swift-only by nature. `options.experimental` (`SentryExperimentalOptions`, `@objcMembers`) is reachable from ObjC, and `SentryObjC` exposes parts of it (`cocoa:CHANGELOG.md:11,26`). The `frameRate`, `sessionSegmentDuration`, `errorReplayDuration` and `maximumDuration` knobs are SPI (`@_spi(Private)`), available only to hybrid SDKs via the options dictionary (`SentryReplayOptions.swift:465-488,608-611`).
17. **Minimum iOS?** 15 (`Package.swift:419`).
18. **Does any of it export OTel?** No (5).
19. **What does a minute of replay cost on the wire?** About 110 KiB masked and about 362 KiB unmasked, measured. About 293 KiB at the medium bitrate target (7.2, 7.3).
20. **Why does `frameCount` equal the seconds even when the screen is static?** Frame-slot rendering repeats the last frame (`SentryVideoFrameProcessor.swift:98-147`, PR #8041 per #7851's description).

## 10. Takeaways for ouo

**Copy (MIT, reimplementing the ideas is fine; copied code needs Sentry's MIT notice):**

- **Encode to H.264 on the device.** The data shows one segment ≈ one I-frame. Masked UIs are about 110 KiB/min, 5–20× smaller than the nominal JPEG-frame bound (≈ 2× measured at matched quality, N50) of the JPEG-frame chunks in ADR-0006. Keep `kind` in the chunk contract, and plan video as the next step instead of "later".
- **Capture after run-loop work, not on a timer.** Use a `CFRunLoopObserver` on `beforeWaiting`, a base interval of 1 s, adaptive backoff on slow captures (≥ 150 ms doubles, capped at 2 s), defer during animations (max 1 s), and capture at full rate while the user interacts.
- **V2 rendering:** `drawHierarchy(afterScreenUpdates:false)` into a raw `CGContext` at screen scale. Do not use `UIGraphicsImageRenderer` on the hot path. Downscale to 1× off the main thread.
- **Redaction model:** walk presentation layers, compose transforms, handle `clipOut` / `clipBegin` / `clipEnd`, clear on full-screen opaque views, mask with the average colour, and mask whole subtrees when a read throws. Use class lists with RN class names, SwiftUI private classes as base64, and iOS 26 layer classes. Per-instance mask/unmask via associated objects and a SwiftUI overlay modifier.
- **Crash durability:** keep frames on disk, and write segment id plus end time from the crash handler with async-safe C. Recover on the next launch, triggered by the crash event.
- **Touches as rrweb incremental events in the same point space as the video.** Debounce moves.

**Avoid or improve:**

- No dedup. A static screen still costs an I-frame every 5 s. A longer segment, or a changed-pixels check before a new segment, would cut idle cost.
- Buffer mode holds about 31 decoded frames (≈ 42 MiB on a 3× phone) plus 31 PNGs.
- The 12 MiB render buffer is allocated per capture.
- The disk cache holds 30 envelopes shared with all telemetry, so replay can evict crashes offline. Give replay its own budget.
- Video and the rest of the telemetry are Sentry envelopes with no OTel. ouo should carry the session and replay ids as OTel attributes and send replay chunks to rum-api through the collector (ADR "collector is the edge").
- `enableFastViewRendering` (`layer.render`) drops SF Symbols. Do not use it by default.
- Masking depends on private SwiftUI class names that change per iOS release (pre-18, 18, 26). Budget for per-release fixes and a mask-preview tool like `showMaskPreview`.

**Licences:**

- sentry-cocoa and SentryCrash/KSCrash are **MIT**: reading and adapting is fine, keep the notice if code is copied.
- `getsentry/sentry` (player, `videoReplayer.tsx`) and Relay are **FSL**: ideas only.

**Player idea, from Sentry's frontend, FSL, reimplement:**

- One `<video>` per segment (`/replays/<id>/videos/<segmentId>/`), preloading ±3 segments and capped by an LRU (`sentry:static/app/components/replays/videoReplayer.tsx:10-16,272-293,450-479`). It tracks gaps between segments.
- An rrweb `Replayer` runs alongside with a **fake FullSnapshot injected after each meta event**, so rrweb can draw the touch "mouse tail" over the video (`sentry:static/app/components/replays/videoReplayerWithInteractions.tsx:27-80`; `sentry:static/app/utils/replays/replayReader.tsx:627-693`).
- Taps are clamped to a minimum visible duration (`replayReader.tsx:631-651`).
- Video events with `duration > 0` become the segment list (`sentry:static/app/utils/replays/hydrateFrames.tsx:30-77`). The video URL prefix is set in `sentry:static/app/components/replays/replayContext.tsx:464-469`.
- The Grafana frame player in ouo can follow the same split: a media timeline plus an rrweb interaction overlay.
