# 2026-11-12 — `pixel/video` on Android (branch claude/rn-android-video-42ade9)

Done: sentry-java 8.64.0's video encoder (4 files, 511 lines, MIT) vendored into `sdk/android/replay-sentry-core` behind `Seams.kt` and `Mp4SegmentWriter`, with `scripts/sentry-core-sync.sh` and `sdk/android/NOTICE`; `VideoSegmenter` and `VideoFormatAdapter` put `ouo-video/1` (the iOS body layout) through the shared `ReplayStream` over OTLP; the Expo module compiles the new module. Redaction and capture were not copied: see the kb entry for why.

Verified: JVM `:replay-core:test :signals-core:test` 68/68 (golden hex included); device tests on my own AVD 7/7 (`Mp4SegmentWriterTest` 2, `MaskPixelTest` 2, `VideoMaskPixelTest` 2, `VideoPipelineTest` 1); `sdk/react-native` vitest 318/318 and `tsc --noEmit` clean; fake collector tests 7/7; sync `check` ok. Leak check: 2 × 10 video runs and 10 frames runs (60 transitions each), Vision OCR plus eye: no readable masked text.

Left: the JS supported set (`NATIVE_REPLAY_MODES`) and `docs/specs/mobile-replay.md` are the parent's; touches out of `ouo.replay.chunk` lines are in the video header. Device (non-emulator) bytes not measured.

Next agent: the fake collector now reads `ouo-video/1`; rn-ios-video may edit the same file. Kotlin initializes properties in declaration order (the bug fixed here).

Kb: [sentry-android-video-over-otlp.md](../../../kb/session-replay/borrowing/sentry-android-video-over-otlp.md). Evidence: [reports/rn-replay-video-android](../reports/rn-replay-video-android/index.md). No env, emulator or process left running; AVD deleted.
