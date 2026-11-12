# `pixel/video` on Android: sentry-java's encoder over OTLP

`replay.mode: "pixel/video"` (`ouo-video/1`) on Android, for `@ouo11y/react-native` under [ADR-0021](../../../../docs/adr/0021-react-native-sdk-keep-and-extend.md) decisions 5 and 6. Branch `claude/rn-android-video-42ade9`, 2026-11-12. The iOS twin is the sentry-cocoa spike (`sentry-ios-recorder-spike.md` in this folder, on branch `claude/sentry-recorder-ios`, PR #181) brought onto OTLP by the `rn-ios-video` session. Evidence: [reports/rn-replay-video-android](../../../agents/sdk-react-native/reports/rn-replay-video-android/index.md).

**Answer: the Android port copies sentry-java's video encoder only, and keeps ouo's capture loop and masks.** The rest of sentry-java's recorder cannot mask the way `pixel/frames` does without editing it, needs Jetpack Compose to compile, and accepts the kind of frame that leaked on iOS. The result masks the same pixels as `pixel/frames` by construction, and no frame in 60 transitions (two video runs, 325 frames) showed masked text.

## What was copied

From [getsentry/sentry-java@8.64.0](https://github.com/getsentry/sentry-java/tree/8.64.0) (MIT, the latest stable tag on 2026-11-12), `sentry-android-replay/src/main/java/io/sentry/android/replay/`, into `sdk/android/replay-sentry-core/src/main/upstream/`:

| Upstream file | Lines | What it does |
|---|---|---|
| `video/SimpleVideoEncoder.kt` | 361 | `MediaCodec` H.264 from a surface input (`lockHardwareCanvas`, software canvas on emulators and some SoCs), drains into the muxer, clamps the bit rate to the codec's range, one keyframe every 6 frames |
| `video/SimpleMp4FrameMuxer.kt` | 86 | `MediaMuxer` mp4, fixed frame duration (1 s at 1 fps) |
| `video/SimpleFrameMuxer.kt` | 44 | the muxer interface |
| `util/SystemProperties.kt` | 20 | `Build.SOC_MANUFACTURER` for the software-canvas list |

511 lines in all. Two scripted transforms only: a header (tag, upstream path, MIT notice pointing at `sdk/android/NOTICE`) and the package prefix `io.sentry.` → `dev.ouo.sentrycore.`, so the copy cannot clash with a real Sentry SDK in the same app. `sdk/android/scripts/sentry-core-sync.sh` does `check` (copy == pin + transforms, nothing extra in `upstream/`), `diff <tag>` (upstream changes to the four files, new files in `video/`) and `vendor <tag>`, cloning with `git clone --depth 1 --branch <tag>` into a fresh temp directory. `sdk/android/NOTICE` carries the MIT licence (byte-identical to upstream's `LICENSE`); `sync-android.mjs` copies it into the Expo module's `vendor/` with the sources.

## What was not copied, and why

| Upstream | Why not |
|---|---|
| `viewhierarchy/ViewHierarchyNode.kt`, `util/Views.kt`, `util/Nodes.kt`, `ComposeViewHierarchyNode.kt`, `util/MaskRenderer.kt` (redaction) | The mask decision is private to `ViewHierarchyNode.shouldMask`: class sets plus `sentry-mask`/`sentry-unmask` tags and `R.id.sentry_privacy`. It cannot read ouo's `ReplayMaskRegistry` (`mask(reactTag)`), the `ouo-mask`/`ouo-unmask` testIDs, or the strict rules (a secure input is always masked, a mask inside an unmasked subtree wins) without editing upstream. Text is masked per layout line in the text colour, images only for some drawables (`isMaskable`). `Views.kt` imports the Compose node, and `Nodes.kt` needs `androidx.compose.ui` at compile time (compileOnly upstream), which an Expo app does not have. |
| `screenshot/PixelCopyStrategy.kt`, `ScreenshotRecorder.kt`, `WindowRecorder.kt`, `Windows.kt` (capture) | It copies the window first and walks the views in the copy's callback, so the walk can see a later tree than the pixels. When the tree changed during the copy it skips the frame once and **accepts the second consecutive one** (`MAX_UNSTABLE_CAPTURES_TO_SKIP = 1`): during an animation or a transition the masks can then sit where content moved to, not where it was copied. That is the class of the one-frame leak the iOS spike saw. ouo's recorder waits for a drawn, settled tree, walks before and after the copy and drops the frame when the two differ. |
| `ReplayCache.kt` (frame store), `capture/*Strategy.kt`, `ReplayIntegration.kt`, gestures, breadcrumbs | Hub, envelope, `SentryId`, rrweb and session/buffer strategies: ouo has its own (the stream, buffer ring and OTLP delivery). The 1 frame/s slot rule of `ReplayCache.createVideoOf` is re-implemented as frames come (below). |

## The seam and the driver

- `replay-sentry-core/src/main/kotlin/dev/ouo/sentrycore/Seams.kt` (47 lines): `SentryOptions` (`logger`, `sessionReplay.isDebug`), `SentryReplayOptions`, `ILogger` (the two `log` forms the copy calls; exceptions by class name only, ERR-8), `SentryLevel`.
- `Mp4SegmentWriter.kt` (110 lines): the module's only public class. `start / encode(bitmap) / finish(): ByteArray? / abort`, one file per segment, read back and deleted; `recordingSize` ports upstream's `ScreenshotRecorderConfig.fromSize` (1 px per dp, sides in 16 px blocks); `isSupported` = API 26 (upstream's `@TargetApi(26)`). The copy stays `internal`.
- `replay-core/.../VideoSegmenter.kt` (157 lines, JVM-tested): fixed-rate slots like `createVideoOf` (a slot shows the newest frame taken before it ends, or repeats the previous), 5 slots of 1 s per segment, a full segment carries the frame on screen into the next one, and a segment with no new frame (a static screen) is dropped instead of sent, as `ouo-frames/3` sends nothing for an unchanged screen.
- `replay/.../VideoFormatAdapter.kt` (200 lines): reads the same `PixelLook` as `ouo-frames/3`, paints the masks with the same painter (`ScreenCapturer.paintMasks`, extracted from the frames path), scales to the recording size and feeds the segmenter. It builds the body the iOS `VideoFormatAdapter` writes, byte for byte: `{"t","type":"video","end","w","h","scale","fps","frames","mp4","touches":[{"t","x","y","phase"}]}\n<mp4>`, `ouo.replay.encoding = "identity"`. Touches go into the header of the segment they were made in.
- `ReplayStream` (shared): `ReplayEvent.segment` (a whole segment, raw bytes, with an `end`) is one chunk alone with a new segment index and keyframe true (RPL-25), never joined or split; one over the hard limit is dropped and counted. `ReplayFormatAdapter.pending(t, closing)` lets a format hand over what it holds on tick, flush, background, `capture(trigger)` and end. Sequence, delivery, buffer ring, `ouo.replay.ended`, `discardPending` and diagnostics are unchanged (`replay.video_segments` added).
- `OtlpPipeline` picks the adapter from `replay.mode`; `pixel/video` below API 26 leaves replay off (`replay.mode_unsupported`). `ReplayRecorderMode.supported` now has both pixel modes; the JS supported set (`sdk/react-native/src/replay.ts`) is the parent session's to change.

## Leak check

Own emulator (AVD `rn-android-video`, Android 15 arm64, headless), `examples/ouo-mobile` Release conformance build (`maskText` default true), against `scripts/fake-collector.mjs` on port 27318 and `examples/backend` on 27319. Per run: push/pop of a product, the Cart screen as `presentation: "modal"` open/close, an instant switch to Chaos (`animation: "none"`, standing in for a tab switch: the app has no tabs) and back; 2.5 s apart; 10 runs per recording, 60 transitions. The modal and animation options, `maskText: true`, `debug: true` and `pixel/video` in the JS supported set were local edits for the test only, reverted after.

Frames were extracted on the Mac with AVFoundation (every real sample of every mp4, zero tolerance) and read with Vision OCR (accurate), then checked by eye on contact sheets labelled with the transition before each frame. No ffmpeg or tesseract on the machine.

| | `pixel/video` run 1 | `pixel/video` run 2 | `pixel/frames` |
|---|---|---|---|
| Images checked | 165 frames (33 mp4) | 160 frames (32 mp4) | 61 JPEG frames (no patches: navigation cadence) |
| OCR text found | product titles only (26 frames) | product titles only (27) | product titles only (10) |
| Readable masked text, by eye | none | none | none |
| Frames dropped by the two-walk gate | 0 | 0 | 1 (`resume`, a masked view moved) |

The product title is `testID="ouo-unmask"` on purpose. Every other text, input, image and the header are masked in both recorders with the same rectangles. No frame of either recorder caught a transition mid-animation: the settled-tree wait and the second walk keep them out, so the iOS one-frame leak has no Android counterpart in what ships. Sentry's own capture (`PixelCopyStrategy`) was not run on Android; its leak exposure above is from reading the code.

## Measurements (emulator, same journey)

| | `pixel/video` | `pixel/frames` |
|---|---|---|
| Replay sent, KiB per minute of journey | 200 (559 KB in 32 chunks, run 1) | 114 (325 KB in 23 chunks) |
| Frames in the replay | 165 (1 per second while the screen changes) | 61 (1 per screen change) |
| Main-thread work per look | the same code (walk, copy, second walk) | same |
| Compose thread, finishing a segment (EOS drain) | 1 ms median, 4 ms max (33 segments) | n/a |

Read with care. On this emulator the software AVC encoder (`c2.android.avc.encoder`) raised the asked 75 kbit/s to its minimum, 1,138 kbit/s (in the logged output format), so the video bytes are an upper bound; a device encoder accepts 75 kbit/s. And `cadence` resolved to `navigation` here, which gives frames one image per screen while video keeps 1 frame/s slots for the length of a segment. Per-frame encode time was not measured separately; not measured: memory, device numbers.

## Bugs met

- Kotlin initializes properties in declaration order: fields the stream's initializer read were declared after it, so `pixel/video` threw in the `OtlpPipeline` constructor on a device ("replay not started") while all JVM tests passed. Fixed, with a device test that starts both pixel modes (`VideoPipelineTest`).
- `AVAssetReaderTrackOutput` returns empty sample buffers around the real ones in these mp4s (9 buffers for 5 frames); count `CMSampleBufferGetNumSamples > 0`.
- The example's Gradle bundle task does not re-run when only an `EXPO_PUBLIC_*` variable changes: the JS must change too.
