# 2026-11-12: `replay.mode: "pixel/video"` on iOS

Branch `claude/rn-ios-video-885aaf`, cut from `claude/rn-replay-otlp`; not pushed, no PR (the parent session merges it). Knowledge: [sentry-ios-video-over-otlp.md](../../../kb/session-replay/borrowing/sentry-ios-video-over-otlp.md). Evidence: [reports/rn-replay-video-ios](../reports/rn-replay-video-ios/index.md).

## Done

1. Merged `origin/claude/sentry-recorder-ios` (PR #181, untouched): conflicts resolved for the OTLP path. `sentry-core-sync.sh check` passes; no upstream file edited. `sdk/ios/NOTICE` credits sentry-cocoa 9.33.0.
2. `ouo-video/1` (`VideoFormatAdapter`, `docs/specs/mobile-replay.md` new section): one chunk per mp4 segment, keyframe, own segment index, body = JSON header line (with touches) + raw mp4, `ouo.replay.encoding` `identity`. `ReplayStream` gained a self-contained-segment path. `OTLPReplayRecorder` drives the core: same stream, delivery, buffer, ended record, discard, trigger, diagnostics.
3. `OuoReplayModule.swift`: doc only (the shared parser now accepts `pixel/video` on UIKit builds). `src/replay.ts`: `NATIVE_REPLAY_MODES` per platform (`pixel/video` on iOS). Two podspecs, `sync-ios.mjs` copies the core, its ObjC helper and the notices.
4. Masking parity by construction: the driver takes ouo's plan (`ReplayMaskPlanner`), not Sentry's redaction.
5. Leak: reproduced (5 of 6 runs), root cause traced (presentation tree lags the commit; 4 of 4 leaked frames had a short presentation tree, 0 others), fixed. A second, scroll leak found in both recorders and fixed (`ScrollMotion`). Proof: 10 runs per recorder, 0 frames with readable masked text (OCR on 803 frames, transitions by eye).
6. End to end: `examples/ouo-mobile` with `EXPO_PUBLIC_OUO_REPLAY_MODE=pixel/video` (new env var) against `fake-collector.mjs` on 26318: verdict pass, 11 chunks, all mp4s decode with AVFoundation. The fake collector now checks `ouo-video/1` bodies (header line, mp4 box structure, `identity`).
7. Tests: macOS `test.sh` 331 tests pass (7 new); UIKit `test.sh --uikit <udid>` 8 tests pass on the simulator (new target `OuoReplayUIKitTests`); vitest 319 pass, `tsc --noEmit` clean; fake collector `node --test` 8 pass.

## ADR-0021 follow-up note

- `ouo-video/1` uses `ouo.replay.encoding = "identity"` (the HTTP token for "not transformed"): the body is not compressed again. Readers that branch on `gzip` must treat `identity` as raw.
- RPL-25 is used: every video chunk is its own segment.
- The scroll rule (offset changed within 0.1 s = moving) changes `pixel/frames` too: 27 frames instead of the spike measurement's 37 on the scroll-heavy journey.

## Next agent must know

- `xcodebuild test` builds every test target for iOS; `OuoCrashTests` are now `#if os(macOS)`. CI does not run the UIKit tests yet (follow-up: a simulator job running `test.sh --uikit`).
- `sdk/react-native/src/types.ts` still says `pixel/video` is "not in this build yet" (doc comment; `src` was out of scope except `NATIVE_REPLAY_MODES`).
- The legacy path's video chunk now carries `format: "ouo-video/1"` (was `sentry-video`); the collector copies it as is.
- Not measured: memory, off-main CPU, a device. Not built: the crash spool for video.
- No env, simulator or process left running: both simulators (`rn-ios-video`, `rn-ios-video-tests`) deleted, fake collector and sinks stopped by PID.
- Dependencies added: none.
