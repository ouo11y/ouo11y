# sentry-cocoa session replay internals, against ouo's iOS capture

Question: why does Sentry's iOS replay hold the main thread ~22 ms per capture on the founder's
iPhone 16 Pro Max (iOS 18.6.2) while ouo's (`sdk/ios`, `OuoReplay`) holds it ~45 ms, and what
should `sdk/ios` change to reach or beat Sentry? Input for the N22 follow-up. Research only (read
the upstream source, 2026-10-23); no number below was measured in this session.

## Which sentry-cocoa ran in the benchmark

"Sentry 8.32.0" in the benchmark is **`@sentry/react-native` 8.32.0**, not sentry-cocoa 8.32.0.
Its `RNSentry.podspec` pins `sentry_cocoa_version = '9.31.0'` (line 71), which is also the latest
stable sentry-cocoa tag on 2026-10-23 (see also [sentry-bridge-examples.md](sentry-bridge-examples.md),
the SDK range table). Everything below cites **sentry-cocoa tag `9.31.0`** unless it says 8.32.0;
the sentry-cocoa 8.32.0 code (July 2024) is summarised at the end because it is very different.

Benchmark config (`examples/sentry-mobile/src/sentry.ts`): `replaysSessionSampleRate: 1.0`,
`replaysOnErrorSampleRate: 1.0`, `mobileReplayIntegration({ maskAllText: false, maskAllImages:
false, maskAllVectors: false })`. The RN integration defaults are `enableViewRendererV2: true`,
`enableFastViewRendering: false` (`dist/js/replay/mobilereplay.js` lines 27-29), quality `medium`.
ouo in the same app: `replay: { maskText: false }`, so images, inputs and web views are still
masked. **Masking is not like for like**: Sentry walks the tree with almost nothing to redact,
ouo plans real rectangles (on the queue, so this matters little for the main thread).

All paths below are relative to the sentry-cocoa repository root.

## 1. Frame capture: what renders a frame

- Renderer protocol: `SentryViewRenderer.render(view:) -> UIImage`
  (`Sources/Swift/Core/Tools/ViewCapture/SentryViewRenderer.swift:7-9`).
- `SentryDefaultViewRenderer` (`SentryDefaultViewRenderer.swift:7-14`): `UIGraphicsImageRenderer(size:)`
  with the default format + `drawHierarchy(in:afterScreenUpdates: false)`. Default format means
  screen scale and, on wide-color screens, the 16-bit extended-range bitmap that ouo's N6 work
  found expensive ([ios-replay.md](ios-replay.md), N6).
- `SentryViewRendererV2` (`SentryViewRendererV2.swift:7-29`), **the default since sentry-cocoa
  8.50.0** (CHANGELOG `## 8.50.0`; added as `enableExperimentalViewRenderer` in 8.47.0, PR #4940):
  - scale = `window.screen.scale` (**3.0 on the 16 Pro Max: the frame is drawn at full native
    resolution, 1320 x 2868 px**), lines 15-19;
  - `SentryGraphicsImageRenderer` (`SentryGraphicsImageRenderer.swift:43-89`): a `calloc`ed buffer,
    `CGContext` 8 bits per component, `CGColorSpaceCreateDeviceRGB()`,
    `CGImageAlphaInfo.premultipliedLast`, flipped CTM, `UIGraphicsPushContext`. Its doc comment
    says `UIGraphicsImageRenderer`'s context cache caused the slowness;
  - then `view.drawHierarchy(in: view.bounds, afterScreenUpdates: false)`, or
    `view.layer.render(in:)` when `enableFastViewRendering` is true (lines 20-26).
- Options: `SentryReplayOptions.enableViewRendererV2` (default `true`) and
  `enableFastViewRendering` (default `false`), `Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift:18-19`
  defaults, docs 275-310 (`enableExperimentalViewRenderer` is a deprecated alias, 259-271). The
  option docs claim "up to 4-5x faster" (~160 ms -> ~36 ms on older devices) for V2 and a further
  "up to 20%" for fast rendering, which they warn "can lead to rendering issues".
  The renderer is chosen in `SentrySessionReplayIntegration.createViewPhotographer`
  (`SentrySessionReplayIntegration.swift:142-165`); V2 also selects `SentryMaskRendererV2`.
- Tradeoffs: `drawHierarchy(afterScreenUpdates: false)` reads the last committed frame from the
  render server, so it gets blur, materials, video layers and Liquid Glass, and does not force a
  layout pass. `layer.render(in:)` re-draws the model layer tree on the CPU: it skips what only the
  render server composites (blurs, `UIVisualEffectView`, AV layers, iOS 26 glass). Neither Sentry
  path uses `afterScreenUpdates: true`.

**Main-thread difference to ouo**: Sentry draws **1:1 at the native scale** and leaves the
downscale to a background queue. ouo draws **at a reduced scale** (`FrameComposer.renderScale`,
1.0 on 3x phones) inside `drawHierarchy` on the main thread
(`sdk/ios/Sources/OuoReplay/ScreenCapturer.swift:61-88`), so the resample from the 3x render-server
surface down to 1x happens on main, with the context's default interpolation quality. The
pre-N6 Time Profiler leaves (`resample_*`, `decode_data`) show that resampling is real work there.
This is the most likely single cause of the 2x gap (hypothesis: verify on the device, see the
ranked list).

## 2. Redaction

- `SentryViewPhotographer.timedImage(view:onComplete:)`
  (`Sources/Swift/Core/Tools/ViewCapture/SentryViewPhotographer.swift:66-96`). On the main thread:
  `redactBuilder.redactRegionsFor(view:)` (line 72), then `renderer.render(view:)` (line 77). Then
  `dispatchAsync` to a background queue: `maskRenderer.maskScreenshot(... scale: 1)` (line 86).
  `SentryViewPhotographerScreenshotMetadata.mainThreadDuration` = redact + render (lines 23-25).
- `SentryUIRedactBuilder.redactRegionsFor(view:)` (`SentryUIRedactBuilder.swift:448-472`) starts
  from `view.layer.presentation() ?? view.layer` and recurses `mapRedactRegion(fromLayer:...)`
  (lines 555-695) over **layers**, not views:
  - returns early when the layer is hidden or `opacity == 0`, or when no redact class is
    configured (line 556);
  - carries the transform down (`concatenateTranform`, line 761) instead of converting each frame
    to window coordinates;
  - for a layer whose delegate is a `UIView`: class-set lookup (`containsRedactClass`, line 353),
    instance overrides, `UIImageView` special cases (bundle and symbol images not masked,
    534-552); opaque views emit a `clipOut` region or clear everything already found when they
    cover the root frame (607-620); `masksToBounds` layers wrap their subtree in
    `clipEnd`/`clipBegin` (658-694);
  - iOS 26: SwiftUI drawing layers without a view are matched by layer class name (527-531, 621-637);
  - a region is appended only when something matches (it stores `view.debugDescription`, one string
    per matched view). With the benchmark's masking off, almost nothing matches, so the walk is a
    cheap recursion with no allocation per node.
  - Default redact classes include `RCTTextView`, `RCTParagraphComponentView`, `RCTImageView`,
    `WKWebView` (lines 140-202).
- Mask applied after capture, off main: `SentryDefaultMaskRenderer.applyMasking`
  (`SentryDefaultMaskRenderer.swift:14-71`) draws the full-resolution image into a **1x** context
  with `interpolationQuality = .none` (nearest neighbour, line 27), then fills each region with its
  view's background color or `UIImageHelper.averageColor` and applies the clip stack. V2 uses
  `SentryGraphicsImageRenderer` for that context (`SentryMaskRendererV2.swift:7-13`).
- `SentrySessionReplayCaptureGuard` (`SentrySessionReplayCaptureGuard.swift:15-48`) is a second
  main-thread walk per capture decision (see 3), stopped at the first hit.

ouo, by contrast, walks **views** on main into a full value tree
(`ViewTreeBuilder.node(for:)`, `sdk/ios/Sources/OuoReplay/ViewTreeBuilder.swift:26-52`): one
`ViewNode` per view with class-name strings, a superclass array, `accessibilityIdentifier` and
`view.convert(view.bounds, to: nil)` (which walks up to the window for every view). The planner
runs on the queue. The N6 simulator profile put the walk well below drawHierarchy, but there is
no device split yet.

## 3. Scheduling

- 9.31.0 has **no timer and no CADisplayLink**. `DefaultSentrySessionReplayRunLoopCaptureScheduler`
  (`SentrySessionReplayRunLoopCaptureScheduler.swift:48-108`) adds a `CFRunLoopObserver` to the main
  run loop in `.commonModes` with order `CFIndex.max` (runs after Core Animation's commit
  observer). It calls back on `beforeWaiting`/`exit` only when the pass did work
  (`afterWaiting`/`beforeTimers`/`beforeSources` seen), so a capture runs **after the UI work of
  that run-loop pass, when the main thread is about to sleep**, and never on an idle pass. It
  passes `currentMode == .tracking` (scrolling). CHANGELOG 9.19.0 (#7851): "scheduling screenshots
  after run loop UI work instead of from display refresh callbacks".
- `SentrySessionReplay.captureFrameIfNeeded` (`SentrySessionReplay.swift:467-554`), per pass:
  1. skip if paused or past `maximumDuration` (1 h);
  2. skip while the previous screenshot is processing (`processingScreenshot`: **one capture in
     flight**, including the background mask step; cleared in the completion, 526-552);
  3. throttle the activity check (`shouldCheckCaptureActivity`, 594-609);
  4. interval: `1 / frameRate`; `frameRate` default **1** (`SentryReplayOptions.swift:42`, not
     public);
  5. activity guard (`SentrySessionReplayCaptureGuard`): a dragging/decelerating/tracking scroll
     view, a tracking `UIControl` or an active gesture recognizer = `.interaction`; >= 4
     `layer.animationKeys()` in the tree = `.animation`;
  6. **animations defer the capture** by 0.25 s steps up to 1 s, then force one
     (`screenshotDeferralDecision`, 674-696; constants `CapturePacing`, 647-666);
  7. interaction or tracking mode: capture at the base 1 s interval with no backoff;
  8. **adaptive backoff**: when the main-thread part (redact + render) takes >= 150 ms the interval
     doubles up to 2 s, faster captures halve it again (`updateAdaptiveScreenshotInterval`,
     698-713). Not reached at 22 ms.
- No change detection: no dedupe of identical frames before encode (the video encoder compresses
  static frames to almost nothing).
- **Touches never trigger a capture.** `SentryTouchTracker.trackTouchFrom(event:)`
  (`SentryTouchTracker.swift:84-104`) is fed by a swizzled `UIApplication.sendEvent`
  (`SentrySessionReplayIntegration.swift:176-183`), copies positions on main and processes them on
  a queue; they become rrweb touch events per segment (`replayEvents(from:until:)`, from line 190).
- That is why Sentry captures 73-83 frames per 75 s run (<= 1 per second, minus deferrals) and ouo
  95: ouo's 1 Hz `Timer` in `.common` mode (`ReplayRecorder.swift:117-127`) plus up to 4
  touch-triggered captures per second on the next run-loop turn (`handle(_:)`, 141-151), with 2 in
  flight (`maxInFlight`, line 17).

## 4. Encoding and transport

- Frame store: `SentryOnDemandReplay.addFrameAsync` (`SentryOnDemandReplay.swift:104-111`) hops to
  the processing queue (utility, relative priority -2; queues made in
  `SentrySessionReplayIntegration.swift:166-172`); `addFrame` (113-146) **PNG-encodes every frame
  and writes it to disk** (crash recovery) and keeps the 1x `UIImage` in memory for the live encode
  (CHANGELOG 9.26.0, #8636). `cacheMaxSize` = `duration * frameRate + 1` frames
  (`SentrySessionReplayIntegration.swift:371-381`): 6 in session mode, 31 in buffer mode.
- Segments: `sessionSegmentDuration` = 5 s, `errorReplayDuration` = 30 s, `maximumDuration` = 1 h
  (`SentryReplayOptions.swift:43-45`). `prepareFullSessionSegmentsIfNeeded` -> `prepareSegment` ->
  `createAndCaptureInBackground` (`SentrySessionReplay.swift:715-813`) ->
  `createVideoInBackgroundWith` (`SentryOnDemandReplay.swift:190-290`) on the asset-worker queue.
- Video: `AVAssetWriter` `.mp4`, H.264 Main AutoLevel, no B-frames, keyframe interval 6, average
  bit rate from quality (`createVideoSettings`, `SentryOnDemandReplay.swift:381-430`, BT.709 color tags included): low 20 kbps
  at `sizeScale` 0.8, medium 40 kbps, high 60 kbps at 1.0 (`SentryReplayQuality.bitrate` and
  `sizeScale`, `SentryReplayOptions.swift:106-112`). Frames go through an
  `AVAssetWriterInputPixelBufferAdaptor` pool (`kCVPixelFormatType_32ARGB`), each `UIImage` drawn
  into a `CVPixelBuffer` with `CGContext.draw` (`SentryPixelBuffer.swift:36-105`);
  `SentryVideoFrameProcessor.processFrames` pulls frames with `requestMediaDataWhenReady` and
  repeats the last frame to keep timing (`SentryVideoFrameProcessor.swift:83-228`).
- Combining: `captureSegment` (`SentrySessionReplay.swift:836-878`) builds a `SentryReplayEvent`
  plus a `SentryReplayRecording` whose rrweb events are the video event, breadcrumbs converted
  with `SentrySRDefaultBreadcrumbConverter`, touch events and, on segment 0, an options event; the
  delegate sends one `replay_video` envelope per segment, then the mp4 is deleted. Wire format:
  [sentry-envelope-format.md](sentry-envelope-format.md). Upload batching = one segment per 5 s.
- Memory and disk (estimates from the code): a 1x frame on a 440 x 956 pt phone is ~1.7 MB
  decoded; session mode keeps up to 6 in memory (~10 MB) plus their PNGs, buffer mode up to 31
  (~52 MB decoded) plus 31 PNGs on disk. The transient main-thread bitmap is 1320 x 2868 x 4 =
  ~15 MB per capture (allocated and freed each time; one in flight).

ouo: dedupe on a 16x16 thumbnail, JPEG per frame (ImageIO, quality 0.5), 10-frame / 5 s chunks,
JSON + gzip, all on one serial `.utility` queue (`ScreenCapturer.compose`,
`ScreenCapturer.swift:90-108`). Per frame that is lighter than PNG + H.264 off main; on main it
does not matter.

## 5. Scale and resolution

- Sentry renders on main at `screen.scale` (V2) or the default renderer format (V1), then the mask
  step redraws at **1x** on the background queue with nearest-neighbour sampling
  (`SentryViewPhotographer.swift:85-86`, `SentryDefaultMaskRenderer.swift:27`).
  `SentryOnDemandReplay.rescaleImage` (148-160) is a second guard that brings any >1x image down to
  1x. `sizeScale` (0.8 only for `low`) is applied at **video encode** time
  (`videoScale`, `SentryOnDemandReplay.swift:327-328`).
- So **no Sentry setting changes its main-thread cost**: quality and `sizeScale` act after the
  main thread has finished. Only `enableFastViewRendering` (layer.render) and the number of views
  (walk) change it.
- ouo picks the output size up front (`maxLongestSide` 1000 px -> 1.0 on 3x phones) and pays for the
  downscale inside drawHierarchy on main.

## 6. Session mode versus buffer (on-error) mode

- Chosen per Sentry session in `SentrySessionReplayIntegration.startSession`
  (`SentrySessionReplayIntegration.swift:247-260`): `random < sessionSampleRate` = session mode;
  otherwise buffer mode if `onErrorSampleRate > 0`; otherwise replay does not start.
- **The main-thread cost is identical**: same scheduler, guard, photographer and 1 fps in both.
- Session mode: a video segment every 5 s (encode on the asset-worker queue, upload, delete).
- Buffer mode: frames only (PNG on disk + in memory), trimmed to the last 31; on an error event
  (`captureReplayFor(event:)` -> `captureReplay` -> `captureReplayInternal`,
  `SentrySessionReplay.swift:363-436`) it encodes the last 30 s as video, sends it and switches to
  session mode. Less CPU and network until an error, more memory (31 frames instead of 6).

## Side by side (main thread marked **[main]**)

| Step | Sentry 9.31.0 (benchmarked) | ouo `sdk/ios` (origin/main, after #40) |
|---|---|---|
| Trigger | **[main]** CFRunLoopObserver at `beforeWaiting` after a busy pass, <= 1 fps, deferred up to 1 s during animations | **[main]** 1 Hz `Timer` in `.common` + up to 4 touch captures/s |
| Gate | one in flight (render + mask) | `maxInFlight = 2` |
| Activity check | **[main]** `SentrySessionReplayCaptureGuard` walk (early exit) | none |
| View walk | **[main]** presentation-layer walk, transforms carried down, regions only for matches | **[main]** full `ViewNode` tree, strings per node, `convert(to: nil)` per view |
| Render | **[main]** drawHierarchy 1:1 at 3x into 8-bit DeviceRGB RGBA | **[main]** drawHierarchy at 1.0 (resample 3x -> 1x inside) into 8-bit P3 BGRA |
| Downscale | queue: redraw at 1x, nearest neighbour | (done on main above) |
| Redact | queue: fill regions, clip stack | queue: plan + fill rects |
| Dedupe | none | queue: 16x16 thumbnail |
| Encode | queue: PNG to disk per frame; H.264 per 5 s segment | queue: JPEG per frame; JSON + gzip per chunk |
| Upload | `replay_video` envelope per 5 s segment | chunk per 10 frames / 5 s |

Measured (founder's iPhone, N22 run): Sentry ~22-23 ms main per capture, 73-83 captures per
75 s (~1.7 s main in total); ouo ~45 ms, snapshot median ~47-49 ms, 95 captures (~4.3 s), compose
on the queue ~5.7 ms.

## Ranked changes for `sdk/ios`

Ordered by expected main-thread saving per unit of risk. Effects are estimates from the code and
the N6 simulator data until the device confirms them; measure each step with the N22 harness
(`profile-runs.sh --device ... --signposts`) in the same trace as Sentry.

0. **Split the `snapshot` signpost into `walk` and `draw`** (`ReplayRecorder.captureFrame`,
   `ReplayRecorder.swift:153-176`). No effect on cost; without it the device run cannot rank 1
   against 4. Risk: none.
1. **Stop resampling inside drawHierarchy on main.** A/B on the device:
   (a) render 1:1 at `screen.scale` (as Sentry does) and downscale to 1x on the capture queue
   (`CGContext` with `interpolationQuality = .none` or `.low`, or vImage), before redaction;
   (b) keep the 1x target but set `ctx.interpolationQuality = .none` before `drawHierarchy`
   (`ScreenCapturer.swift:73-79`).
   Expected: the largest saving, most of the 45 -> 22 ms gap if the resample dominates, as the
   pre-N6 leaves suggest. Risk: (a) costs a ~15 MB bitmap per capture on a Pro Max (30 MB with 2
   in flight; set `maxInFlight` to 1, see 4) and a bit more queue CPU; (b) aliased text in the
   replay (Sentry accepts the same with `.none` in its downscale). Also try the bitmap format at
   1:1: Sentry's DeviceRGB/RGBA vs our P3/BGRA (N6 measured a 13 ms spread between color spaces on
   the simulator).
2. **No touch-triggered captures; one capture per second at most** (`ReplayRecorder.handle(_:)`,
   141-151). Sentry captures none on touch. Keep the touch events, and if a frame right after a tap
   matters, move the next timer capture earlier instead of adding one. Expected: 95 -> ~75
   captures per run, -20 % main-thread total, no change per capture. Risk: a tap's result can show
   up to 1 s late in the replay, as in Sentry.
3. **Capture after the run-loop pass, not from a Timer**: a `CFRunLoopObserver` on
   `beforeWaiting` in `.commonModes` with a late order, skipping passes that did no work, plus
   Sentry's animation deferral (>= 4 animation keys: defer up to 1 s). Expected: little change per
   capture; fewer captures stacked on a busy frame (fewer hitches, which matter more than the
   average), fewer captures during transitions. Risk: a run loop that never sleeps (continuous
   animation) needs the forced-capture fallback Sentry has.
4. **One capture in flight** (`maxInFlight` 2 -> 1). Expected: caps memory if 1(a) lands; skips a
   capture only when the queue is > 1 s behind. Risk: none in practice.
5. **Lighter view walk** (`ViewTreeBuilder.node(for:)`): carry the transform down instead of
   `convert(view.bounds, to: nil)` per view; skip hidden / alpha-0 subtrees before recursing;
   cache the per-class match result (a Bool or small enum) instead of name strings; read
   `accessibilityIdentifier` only when a rule uses it; emit only candidate nodes and opaque/clip
   nodes rather than the full tree. Expected: a few ms on large RN trees (size it with step 0).
   Risk: redaction regressions; keep `RedactionPlanner` tests green and add cases for the pruning.
6. **Adaptive backoff** as a guard rail: double the interval when the main-thread part exceeds a
   threshold (Sentry: 150 ms, cap 2 s). Expected: nothing on the 16 Pro Max; protects older devices.
   Risk: fewer frames on slow phones.
7. **`layer.render(in:)` only as an opt-in** (Sentry's `enableFastViewRendering`, off by default).
   N6 measured ~5 ms on the simulator, but it misses blur, materials, video and iOS 26 glass. Do not
   make it the default; offer it once 1-5 are measured, if a customer prefers cost over fidelity.
   Do not go back to `UIGraphicsImageRenderer` (Sentry moved away from it for cost, and N6 found its
   16-bit format).

Expected outcome if 1 works as hypothesised: per capture at or below Sentry's ~22 ms (same
drawHierarchy work, and ouo's walk does not redact on main), and with 2 the total main-thread time
per run below Sentry's because ouo would capture no more often.

## sentry-cocoa 8.32.0 (July 2024), for reference

- `SentryViewPhotographer.image(view:options:onComplete:)` (`Sources/Swift/Tools/SentryViewPhotographer.swift:16-35`):
  `UIGraphicsImageRenderer(size:)` default format + `drawHierarchy(afterScreenUpdates: false)` on
  main, then `UIRedactBuilder.redactRegionsFor` on main, then `DispatchQueue.global()` redraws at
  1x with `interpolationQuality = .none` and fills the regions. No V2 renderer, no fast option.
- Scheduling: a `CADisplayLink` (`SentryDisplayLinkWrapper`, `Sources/Sentry/SentrySessionReplayIntegration.m:141`)
  calls `newFrame` every display frame and captures when 1 / `frameRate` has passed
  (`Sources/Swift/Integrations/SessionReplay/SentrySessionReplay.swift:173-195`), one in flight
  (`takeScreenshot`, 272-286). No animation deferral, no backoff.
- Same shape otherwise: PNG per frame, H.264 per 5 s segment, 20 kbps default bit rate
  (`SentryOnDemandReplay.swift:47`).

What changed by 9.31.0 that matters for cost: V2 renderer and `SentryGraphicsImageRenderer`
(8.47.0, default 8.50.0); run-loop observer instead of display link (9.19.0, #7851); animation
deferral and adaptive backoff, with the backoff measuring main-thread time only (9.26.0, #8740);
in-memory frames for the live encode (9.26.0, #8636).
