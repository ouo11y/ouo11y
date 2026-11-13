# Sentry's iOS recorder as `pixel/video` over OTLP

How the [spike](sentry-ios-recorder-spike.md) became `replay.mode: "pixel/video"` of the React Native SDK on iOS (ADR-0021 decisions 5 and 6), what caused its screen-transition masking leak, and what it costs next to `pixel/frames`. Branch `claude/rn-ios-video-885aaf`, 2026-11-12. Evidence: [reports/rn-replay-video-ios](../../../agents/sdk-react-native/reports/rn-replay-video-ios/index.md).

## What changed from the spike

| | Spike (PR #181) | Now |
|---|---|---|
| Wire | `kind: "video"` JSON chunk, base64 mp4, gzip, `POST /v1/replay/chunks` | `ouo.replay.chunk` log record (sdk-spec section 11), format `ouo-video/1`, encoding `identity`, through `ReplayStream` and `ReplayDelivery` like `ouo-frames/3` |
| Body | JSON with the mp4 in base64 | One JSON header line (times, size, fps, frames, mp4 length, touches), a newline, the raw mp4 ([spec](../../../../docs/specs/mobile-replay.md#ouo-video1-video-segments-over-otlp)) |
| Chunk and segment | one chunk per segment, `seq` per session | one chunk per segment, each its own `ouo.replay.segment.index`, `keyframe=true` (RPL-25); same sequence, buffer ring, `ouo.replay.ended`, `discardPending`, `capture(trigger)`, diagnostics as frames |
| Masking | Sentry's (`SentryUIRedactBuilder` on presentation layers, average-colour fill, no `ouo-mask`/`ouo-unmask`) | ouo's: `ReplayMaskPlanner` (the frames walk, `ReplayMaskRegistry`, strict rules, secure fields always masked, no look during a transition, drop when a masked view moves), black fill. Injected into the driver as `Options.plan`; no upstream file changed |
| Format name | `sentry-video` | `ouo-video/1` (the legacy path's `kind: "video"` chunk carries it too) |
| Selection | `OuoReplayConfig.recorder = .sentryVideo` | `replay.mode: "pixel/video"`: `ReplayRecorderMode.supported` on UIKit builds, `NATIVE_REPLAY_MODES` on iOS in JS, the Expo module unchanged (the shared parser decides) |
| Packaging | Swift package only | also two podspecs (`OuoReplaySentryCore`, `OuoReplaySentryCoreObjC`), `NOTICE` and `THIRD_PARTY_NOTICES` copied into the npm package by `sync-ios.mjs` |

Why the body is a header line plus raw mp4 and not mp4 alone: the player needs the touches, and mp4 alone has no simple place for them. Why not base64 NDJSON (`{"type":"video","mp4":"<base64>"}` lines, which would have kept the line machinery as it is): 33 % more bytes, or a gzip pass over already-compressed data to win them back. The cost is one branch in `ReplayStream` (`selfContainedSegments`) and a 10-line parser in a player.

`ouo.replay.encoding` is `identity`, the HTTP name for "no transformation": a reader that sees it takes the body as it is.

## The leak: root cause

The spike leaked a frame with readable masked text at screen changes (2 of 5 runs). Reproduced on the unchanged spike: **5 of 6 runs**, always the first frame of the SwiftUI Products screen ("Card ending 4242" in clear, with `.ouoMask()` on it).

Traced with a temporary probe in the driver that logged, at every capture, the layer tree from the model (`window.layer`) and from the presentation (`window.layer.presentation()`), and whether a view controller transition ran (5 runs, 244 captures):

- **4 captures had a presentation tree shorter than the model tree**, for example 28 layers / 1 text layer against 38 / 5 (Products), and 25 / 1 against 119 / 23 (the statement list right after its push).
- **Those 4 are exactly the 4 frames OCR found readable.** No other frame was readable, and no other capture had a short tree.
- `transitionCoordinator` was already nil in all 4: the push had finished; the leak is not about the animation.

`SentryUIRedactBuilder.redactRegionsFor(view:)` walks `layer.presentation()` and its sublayers. The layers committed in the run-loop pass that captures (Sentry's observer runs after Core Animation's commit) are not in the presentation tree yet, while `drawHierarchy(afterScreenUpdates: false)` draws them. So a screen whose content is first committed in that pass is drawn with no regions for its text. SwiftUI screens hit this most because their text layers are created late, after the push.

**Fix:** the plan is taken from the views (`ViewTreeBuilder`, `convert(bounds, to: nil)`), the tree that was committed, right before the render in the same pass, which the frames recorder already did. The unit test cannot reproduce the presentation lag (it needs a window shown by the render server), so `ViewsCommittedInThisPassAreMaskedAtOnce` pins the plan's side and the trace above is the evidence for the other.

## Second leak found on the way, in both recorders

The first proof run of the fix showed a different partial leak, in **both** pixel recorders: on the statement list scrolled with `setContentOffset(_:animated: true)`, a line of text peeked out under each mask ("balance 2825.25"; frames showed "147.19", "373.21"). The capture landed mid-scroll (offset 936 between 260-point steps) with no layer animation, not dragging, not decelerating, presentation equal to the model: nothing said "moving", and the render lags the model offset by a frame.

**Fix (`ScrollMotion` in `ViewTreeBuilder.swift`, both recorders, legacy path too):** the scroll views a walk meets are sampled once per main run-loop pass by an observer that runs before the commit; a scroll view whose offset changed within 0.1 s counts as moving, so masked content in it drops the frame (PRV-8). A first version ("changed since the last walk") dropped every timer frame of the frames recorder on that list (7 frames in a 45 s journey instead of 37) and was replaced.

## Measurements

How: the spike's harness (`project/agents/session-replay/measure/`, scratch copy on ports 26400/26401): iOS Simulator iPhone 17 Pro, iOS 27.0, Apple Silicon Mac, a fresh install per run, the `replaydemo` journey of `examples/ouo-ios` (Home, SwiftUI Products, Cart, an 80-row statement scrolled in 25 animated steps and 2 flings, back to Home, about 50 s). 10 rounds, each recorder once per round, interleaved; median (min to max). Host load 2.3 to 3.5 in most runs (one run each at 17.9 and 42.5). Masking on with defaults in both. Raw numbers: [ocr-and-measurements.json](../../../agents/sdk-react-native/reports/rn-replay-video-ios/ocr-and-measurements.json).

| | `pixel/video` (this branch) | `pixel/frames` (this branch) | spike, Sentry masking (for reference) |
|---|---|---|---|
| Frames with readable masked text (Vision OCR, every frame; transitions checked by eye) | **0 of 530, in 0 of 10 runs** | 0 of 273, in 0 of 10 runs | 5 of 319, in 5 of 6 runs |
| Replay sent, KiB/min | **98** (97 to 102) | 209 (205 to 217) | 170 (spike kb) |
| Frames in the replay | 53 (53 to 53) | 27 (27 to 28) | 55 |
| Main thread per capture, p50 | **45 ms** (35 to 46) | 28 ms (24 to 29) | 47.6 ms |
| Main thread per capture, p90 / max | 49 / 52 ms (max 121 in the loaded run) | 31 / 34 ms | 51 / up to 203 ms |
| Main thread per minute of recording | **2,092 ms** (1,938 to 2,238) | 1,181 ms (1,136 to 1,239) | 2,533 ms |

The only OCR hit in either recorder is "Total 4.50", unmasked on purpose with `.ouoUnmask()`: the video recorder honours it now, as frames does (Sentry's masking did not). Bytes are the legacy path's gzip JSON with base64 mp4, which is about the raw mp4 size; video's are lower than the spike's because black masks compress better than Sentry's average-colour fills. Frames dropped from the spike's 37 to 27 per run: the scroll rule drops frames taken mid-scroll.

On the OTLP path (`examples/ouo-mobile`, `scripts/journey.sh`, fake collector, one run each, the demo's `maskText: false`): `ouo-video/1` 9 chunks in 48 s, 115 KiB (144 KiB/min); `ouo-frames/3` 5 chunks in 39 s, 73 KiB (112 KiB/min). This journey mostly shows still screens, where frames sends nothing and video still sends a frame per second when anything changes. The collector's `GET /__report` passed every rule for both; all 11 mp4 bodies decode with AVFoundation (5 or 6 frames each, 402 × 874).

Not measured: memory and off-main-thread CPU (the core keeps PNG frames on disk and encodes with AVAssetWriter; the spike kb cites Sentry replay's 42.5 MiB peak against frames' 3.8 MiB), and a device.

## Gotchas

- `xcodebuild test` of the package builds every test target for iOS; `OuoCrashTests` spawn a `Process` and are now `#if os(macOS)`. UIKit tests: `sdk/ios/test.sh --uikit <simulator udid>`. CI runs only the macOS tests.
- A worktree without its own `node_modules` resolves vitest and TypeScript from the main checkout's (stale) ones: a fault-injection test and `tsc` fail there for reasons unrelated to the change. `npm --prefix "$PWD" ci` first.
- The harness (`project/agents/session-replay/measure/`) drives `examples/ouo-ios`, which uses the legacy upload path; the OTLP path is exercised by `examples/ouo-mobile` and its fake collector. Both run the same core and the same plan.
