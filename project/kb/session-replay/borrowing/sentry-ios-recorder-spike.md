# Borrowing Sentry's iOS recorder core: the spike

Can ouo use sentry-cocoa's session-replay recorder core instead of maintaining its own, and ship its output as an ouo replay chunk? Spike of 2026-11-11, branch `claude/sentry-recorder-ios`, for the proposed ADR-0018, "Borrow the recorder core" (`docs/adr/0018-borrow-the-replay-recorder.md`, in PR #178, not decided). Demo report: [sentry-recorder-spike.html](../../../agents/session-replay/reports/sentry-recorder-spike.html).

Follow-up (2026-11-12): the recorder now ships as `replay.mode: "pixel/video"` over OTLP with ouo's masking, and the transition leak of finding 1 is traced and fixed: [sentry-ios-video-over-otlp.md](sentry-ios-video-over-otlp.md).

Follow-up (2026-11-13, review of PR #184): the spike's legacy wiring is removed from `sdk/ios`: `VideoReplayRecorder`, `VideoChunk`, `ChunkUploader.enqueue(VideoChunk)`, `OuoReplayConfig.recorder` and `OuoConfig.replayRecorder` (and `OUO_RECORDER` in `examples/ouo-ios`). `SentryCoreRecorder` stays, driven by `OTLPReplayRecorder`. The collector still accepts `kind: "video"` chunks. The findings and measurements below describe the spike as it was built.

**Answer: yes, technically.** 28 upstream files (3,157 lines) compile in the ouo package unmodified apart from a scripted header and one import line, behind an 82-line seam file and a 358-line ouo driver (`SentryCoreRecorder`), plus 178 lines that wrap segments as chunks (`VideoReplayRecorder`). The segments play in the existing Grafana video player as `kind: "video"` chunks with `ouo.replay.format = "sentry-video"`. What it costs and leaks is in [Measurements](#measurements).

## Seam map (sentry-cocoa 9.33.0)

Paths are under `Sources/` of [getsentry/sentry-cocoa@9.33.0](https://github.com/getsentry/sentry-cocoa/tree/9.33.0).

### Recorder core: copied as is (`sdk/ios/Sources/OuoReplaySentryCore/Upstream/`)

| Step | Upstream file | What it does | Sentry types it touches |
|---|---|---|---|
| Hook | `Swift/Integrations/SessionReplay/SentrySessionReplayRunLoopCaptureScheduler.swift` | Main run-loop observer: fires once per pass that did work (`afterWaiting`/`beforeSources` then `beforeWaiting`/`exit`), tells whether the run loop is in tracking mode | `SentryRunLoopObserver` and the `CreateObserverFunc` typealiases |
| Hook | `.../SessionReplay/SentrySessionReplayCaptureGuard.swift` | Interaction (scroll dragging/decelerating, tracking control, active gesture) or 4+ running animations | none |
| Record | `Swift/Core/Tools/ViewCapture/SentryViewPhotographer.swift` | Redaction regions (main), render (main), mask drawing (background queue); timing per phase | `SentryDispatchQueueWrapper`, `SentryCurrentDateProvider` |
| Record | `SentryViewRenderer.swift`, `SentryDefaultViewRenderer.swift`, `SentryViewRendererV2.swift`, `SentryGraphicsImageRenderer.swift`, `SentryViewScreenshotProvider.swift` | `drawHierarchy` (default) or the faster layer render (V2, Sentry's default) at 1x | `SentrySDKLog` |
| Mask | `SentryUIRedactBuilder.swift` | Walks views and their **presentation** layers into redact/clip regions: text classes, images (not SF symbols or bundle assets), web views, PDF, video, SwiftUI text and image drawing views, custom classes | `SentrySDKLog`, `SentryObjCExceptionHelper` |
| Mask | `SentryRedactRegion.swift`, `SentryRedactRegionType.swift`, `SentryRedactViewHelper.swift`, `SentryViewSubtreeTraversal.swift`, `Core/Protocol/SentryRedactOptions.swift` | Region model, per-view overrides (associated objects), traversal exclusions, the options protocol | `AssociatedObjectAccessor` |
| Mask | `SentryMaskRenderer.swift`, `SentryDefaultMaskRenderer.swift`, `SentryMaskRendererV2.swift`, `Core/Tools/UIImageHelper.swift` | Fills regions with the average colour of the area (so masks look like blocks of the background, not black) | none |
| Pack | `.../SessionReplay/SentryOnDemandReplay.swift` | Frame store (PNG on disk + image in memory), cuts `[start, end)` windows into mp4 files | `SentryDispatchQueueWrapper`, `SentryMutex`, `SentrySDKLog` |
| Pack | `SentryVideoFrameProcessor.swift`, `SentryPixelBuffer.swift`, `SentryReplayFrame.swift`, `SentryVideoInfo.swift`, `SentryRenderVideoResult.swift`, `SentryOnDemandReplayError.swift`, `SentryReplayVideoMaker.swift` | AVAssetWriter H.264 Main profile, no B-frames, one keyframe per 6 frames, BT.709 | `SentrySDKLog` |
| (helpers) | `Swift/Concurrency/SentryMutex.swift`, `Swift/Core/Helper/AssociatedObjectAccessor.swift` | os_unfair_lock box; typed associated objects | none |
| (ObjC) | `Sentry/SentryObjCExceptionHelper.{h,m}` (to `OuoReplaySentryCoreObjC/`) | `@try/@catch` around `layer.sublayers` / `presentation()`, which Core Animation can raise from (sentry-cocoa#7810) | `SentryLogC.h` |

### Seams: re-implemented (`Seams.swift`, `SentryLogC.h`)

| Upstream | What the core needs | ouo stand-in |
|---|---|---|
| `SentrySDKLog` (wired to `SentryOptions.debug`) | `debug/info/warning/error/fatal(String)` | `OuoSentryCoreLog.sink`, set to the ouo `ReplayLogger` when `debug` |
| `SentryDispatchQueueWrapper` (built by the SDK's dispatch factory) | a serial queue, `dispatchAsync`, `.queue` | same name over `DispatchQueue`, utility QoS with relative priority (asset worker -1, processing -2: the processing queue waits on the worker, upstream's rule) |
| `SentryCurrentDateProvider` (dependency container) | `getAbsoluteTime()` | `DispatchTime.now().uptimeNanoseconds` |
| `SentryRunLoopObserver` and `CreateObserverFunc`/`AddObserverFunc`/`RemoveObserverFunc` (app-hang tracker file) | the typealiases | copied (6 lines) |
| `_SentryPrivate` (the SDK's private ObjC module) | `SentryObjCExceptionHelper` | the `OuoReplaySentryCoreObjC` target; the ObjC class gets an `objc_runtime_name` so it cannot clash with a real Sentry in the same app |
| `SentryLogC.h` `SENTRY_LOG_WARN` | a log macro | a no-op (the Swift caller logs) |

### The orchestrator: replaced, not copied

`Swift/Integrations/SessionReplay/SentrySessionReplay.swift` (958 lines) drives the core and is where Sentry lives. `SentryCoreRecorder.swift` keeps, adapted: the pacing of `captureFrameIfNeeded` (1 frame/s; base rate during interaction; adaptive backoff doubling to 2 s when the main-thread part takes 150 ms or more, halving when fast; defer up to 1 s while 4+ animations run) and the 5 s full-session segment cut. **Cut**: the hub and scope, replay id and segment id, `SentryReplayEvent` and the envelope (`SentryClient+ReplayAndFeedback`), buffer mode for errors (`errorReplayDuration`), `SentryRRWebOptionsEvent`/breadcrumb/span/network events (`SentrySRDefaultBreadcrumbConverter`, `SentryReplayNetworkDetails`), the touch tracker (it swizzles `UIApplication.sendEvent`; ouo uses its own gesture recognizer), `SessionReplayFileManager` and `SessionReplayRecovery` (crash recovery of the PNG frames), the 60 min maximum, the hybrid-SDK API and the masking preview. Also from `SentrySessionReplayIntegration.swift`: only the photographer and queue construction.

The ouo seam is `OuoSegmentRecorder` (`SegmentRecorder.swift`): `start/pause/resume/flush/stop` plus `onSegment(OuoReplaySegment)` with mp4 bytes, start, end, width, height, frame count and frame rate. A PostHog or Datadog core would implement the same protocol with its own `format`.

## ouo side

- `OuoReplayConfig.recorder` / `OuoConfig.replayRecorder`: `.frames` (default, unchanged) or `.sentryVideo`.
- `VideoReplayRecorder` (OuoReplay): app lifecycle (background cuts the segment, active resumes), ouo touches (`TouchObserver`), session id and `seq` (`SeqStore`), one `VideoChunk` per segment through the existing `ChunkUploader` (gzip, disk outbox, retries, Basic credential).
- `VideoChunk` (OuoReplayCore): the bridge's video chunk without `source`, plus `format` and `mode` ([mobile-replay.md](../../../../docs/specs/mobile-replay.md#video-chunks-from-the-ios-sdk-spike-proposed-adr-0018)).
- Collector `ouoreplay` receiver: accepts `kind: "video"` (rum-api's rules, the frames body limit) and writes `ouo.replay.format` from the chunk's `format`. Before this, only the Sentry bridge (port 4320) could produce video records.
- Not built: the crash spool (the PNG frames are on disk, so it is possible), `navigation` mode, feedback frames, mapping `ouo-mask`/`ouo-unmask` to Sentry's `sentryReplayMask/Unmask`, the sdk-spec section 11 OTLP path (the chunk still goes to `/v1/replay/chunks`).

## Keeping the copy in sync

`sdk/ios/scripts/sentry-core-sync.sh`:

```bash
sdk/ios/scripts/sentry-core-sync.sh check          # our copy == pinned tag + the transforms (exit 1 on drift)
sdk/ios/scripts/sentry-core-sync.sh diff 9.34.0    # upstream changes to the copied files, and new files in the two upstream folders
sdk/ios/scripts/sentry-core-sync.sh vendor 9.34.0  # re-copy and move the pin (UPSTREAM_TAG); then build for the simulator and run test.sh
```

The transforms are exactly three: a header (tag, upstream path, MIT notice), `internal import _SentryPrivate` to `import OuoReplaySentryCoreObjC`, and the ObjC runtime name. Anything else in `Upstream/` is drift and `check` fails. A new upstream dependency shows up as a compile error naming a missing `Sentry*` type: copy the file (add it to the list) or add a seam.

## Measurements

How: `project/agents/session-replay/measure/` (raw numbers in `results.json`). The method is Step 5's ([overhead.md](../../client-sdk-state/overhead.md)): iOS Simulator (iPhone 17 Pro, iOS 27.0, Apple M5 Mac), a fresh install per run, both recorders interleaved and rotated, 5 rounds, median (min to max), host load 4.5 to 17.7. The journey is `examples/ouo-ios` `OUO_ACTION=replaydemo`: Home, Products (SwiftUI), Cart, an 80-row statement scrolled in 25 animated steps and 2 flings, back to Home, backgrounded at 50 s. Masking is on with defaults in both. The sink is a local server that answers itself (`sink.py`).

| | Sentry-derived (`sentry-video`) | ouo frames |
|---|---|---|
| Replay sent (gzip bodies), KiB/min | **170** (154 to 187) | 283 (278 to 289) |
| Requests per run | 10 | 8 |
| Frames in the replay | 55 (53 to 55) | 37 |
| Main thread per capture, p50 | **47.6 ms** (41.8 to 50.0) | 29.4 ms (22.9 to 30.3) |
| Main thread per capture, p90 / max | 51.3 / up to 203 ms | 33.9 / up to 42 ms |
| Main thread per minute of recording | **2,533 ms** (2,057 to 2,549) | 1,622 ms (1,333 to 1,654) |
| Frames with readable text (Vision OCR, each checked by eye) | **2 of 272**, in 2 of 5 runs (and 1 in a trial run) | 0 of 185 (OCR's only hit is "Total 4.50", unmasked on purpose with `.ouoUnmask()`) |
| Code added (Release, arm64 simulator object, text+data before dead-stripping) | about 236 KiB | none |

No range overlaps between the two recorders on bytes, frames or main-thread time. Main-thread time is what each recorder measures itself (`OuoReplay.captureStats`). For Sentry it is redaction plus render (`mainThreadDuration`). For frames it is the walk, mask plan and render, and it includes walks that took no frame. On this scroll-heavy journey, both send more than on Step 5's light journey (Sentry iOS 49.5, ouo 38.8 KiB/min).

Not measured: off-main-thread CPU and memory. Step 5 measured Sentry replay's peak at 42.5 MiB against ouo's 3.8 MiB, and this is the same code. Also not measured: device numbers.

## Findings

1. **The Sentry core leaks a frame at screen transitions.** In 2 of 5 runs (and in the trial), one frame showed text in full:
   - the first frame of the SwiftUI Products screen, including `Card ending 4242` with `.ouoMask()`;
   - Home right after the pop back, its `UILabel` greeting readable.

   The next frame was masked each time. No frame leaked during scrolling. My reading of the frames: the redaction walk, taken just before the render, has not yet seen the views the render draws. SwiftUI had not made its text drawing views yet, and the label was in the transition's container. This is not a traced root cause. ouo's recorder does not capture during a view controller transition, waits a settle time, and drops frames when a masked view moves, so it had no such frame. The masking-experiment session tests Sentry's masking directly.
2. **Masks move with the content.** Sentry redacts from presentation layers, so during scrolling its boxes follow the rows and no frame is dropped (55 frames against 37).
3. **Different masking rules.**
   - Sentry ignores ouo's per-view overrides (`.ouoUnmask()`, `ouo-mask`/`ouo-unmask` identifiers; it has its own `sentryReplayMask`/`Unmask`).
   - It leaves SF Symbols and bundled images visible.
   - It paints masks in the area's average colour.

   Adopting it means mapping the overrides or changing ouo's documented behaviour.
4. **Cheaper on the wire, dearer on the main thread.**
   - Video is 40 % smaller than JPEG tiles on a changing screen.
   - Each capture costs about 1.6 times the main-thread time. Sentry's render runs every second, even when nothing changed. ouo walks first, renders only what it needs, and sends nothing for an unchanged screen.
5. **Low upstream churn.** From 9.32.0 to 9.33.0 none of the 28 files changed. Against 9.30.2, one file differs by 12 lines. The seams held: the core needed 5 stand-ins and one ObjC helper.
6. **The shipping gap closes with a small collector change.** Before this branch, `kind: "video"` reached rum-api only through the Sentry bridge (port 4320). The `ouoreplay` receiver now accepts it, which is the route the demo used. The sdk-spec section 11 OTLP path is still not built.
