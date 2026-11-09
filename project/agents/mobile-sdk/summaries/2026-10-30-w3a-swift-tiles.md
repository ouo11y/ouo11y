# 2026-10-30 W3a, step 2: tiles in `sdk/ios`

Branch `claude/w3a-swift`, second of the two W3 tiles PRs of [roadmap.md](../../../kb-archive/mobile-sdk-research/roadmap.md) §3 (lane A), as decided in [ADR-0014](../../../../docs/adr-archive/0014-replay-tiles-in-frames.md); step 1 (schema 2 in rum-api, the collector and the player) is [2026-10-30-w3a-schema2-player.md](2026-10-30-w3a-schema2-player.md). Env `w3a-tiles`, simulator `ouo-w3a` (89D4DCB3-6F29-4225-9566-2A65FE6BAA16, iPhone 18 Pro, iOS 27.0, same model and runtime as W1's B3 run).

## What was done

- **`TileDiffer`** (Core, pure): hashes every 64 px tile of the redacted frame (FNV-1a over 8-byte words) and compares with the last frame *sent*: `unchanged` (zero bytes), `full`, or `patches`. Changed tiles are merged into rectangles that do not overlap: runs per tile row, joined downwards while the column span matches. More than 8 rectangles become their bounding box, and more than half the frame becomes a full image. `commit()` adopts a frame only after its JPEGs encoded. `reset()` forces the next frame full (resume, screen change, session rotation). `forceFull` is the chunk-start rule: full only if something changed.
- **`FrameComposer.encode`**: diff, then one JPEG for a full image or one per patch rectangle (`CGImage.cropping`, top-left pixels as patches are). It replaces the 16x16 thumbnail dedupe; `FrameDeduper` is deleted.
- **Models**: `Patch`, a `Frame` with exactly one of `jpeg` and `patches` (`isFull`, `imageBytes`), `FrameChunk.schemaVersion` 2 and `mode`.
- **`ChunkBuilder`**:
  - cuts at 5 s, at 1 MiB of base64 images (not at 10 frames), on `update(viewport:)` when the size changes, and on flush;
  - `needsFullFrame`, and it drops a patch frame offered first;
  - clears the spool only after `onChunk` returned (checklist N54, W3b's point: a kill while the uploader stores the chunk lost it). The spec sentence about that window is gone.
  
  `ChunkSpool` keeps `mode` (an older spool without it is sent as `session`) and drops leading patch frames on recovery.
- **`ScreenCapturer.compose` / `ReplayRecorder`**: the capture queue updates the builder's viewport from the snapshot (a new size cuts the chunk), asks for a full frame when the chunk has none, and adds the `Frame` compose returns. `screenDidChange()` resets the differ, so a new screen is a full image (a seek point) in both modes. `OuoReplayConfig.maxFramesPerChunk` is removed.
- `tests/e2e/mobile/standin.cjs` models it: schema 2, `mode`, the 1 MiB cut. `profile.py` attributes `TileDiffer`. The spec's status line and `reason` list, the iOS row of the compatibility schema table (2), and the `sdk/ios` README and CHANGELOG are updated.

## Verified, and how

- After rebasing onto main (#116 merged, W3b's #114 merged):
  - `sdk/ios/test.sh` runs 83 Core tests (W3b's uploader tests included), and the UIKit target builds;
  - 153 React Native tests pass;
  - the conformance suite is OK with 13 required checks (C8 replay 3/3, C11 delivery 2/2);
  - env `w3a-tiles` rebuilt from this branch, so its validators check patch JPEG size: a one-round ouo-T3 and ouo-T4 run from the rebuilt app got 202 on all 24 replay requests, both sessions are stored with their patch frames, and rum-api logged no invalid chunk.
- `sdk/ios/test.sh` before the rebase: 76 Core tests. New: `TileDifferTests` (7: unchanged and padding, clamped edge tiles, the merge, the bounding box, the half-frame rule, forceFull/reset/size, commit), `FrameComposerTests.EncodesFullUnchangedAndPatches` (real JPEGs; a patch decodes to its rectangle's pixels), builder byte limit, first-frame rule, viewport cut, the spool kept during the hand-off, an old spool with leading patch frames.
- `xcodebuild -scheme OuoReplay -destination 'generic/platform=iOS Simulator'`: the UIKit target builds.
- `sdk/react-native`: 131 Vitest tests pass. `tests/e2e/mobile/conformance.mjs` against env `w3a-tiles`: CONFORMANCE OK, 11 required checks; C8 replay 3/3 with schema 2 chunks.
- `TileDiffer.diff` on a 402x874 frame: 0.135 ms (optimized build, 200 iterations); W1's whole `compose` is about 6 ms.
- Live: the T3 round's replay (19 frames, 5 patch frames) plays in Grafana from the canvas. Every frame paints at 402x874, and a patch frame shows no seams.
- **B3 on the simulator** ([report](../../../reports/benchmarks/2026-10-30-w3a-ouo-0.2.1-vs-sentry-8.33.0-sim/report.html)):
  - Setup: `bench.sh --env w3a-tiles --target sim --runs 10 --ouo workspace --sentry 8.33.0 -- --cells "none sentry-T3 ouo-T3 sentry-T4 ouo-T4" --no-soak --no-offline`, the same cells, rounds, flags and Sentry version as W1's run, on a simulator of the same model and runtime. Every run is complete (no missing replay, no problems).
  - Replay KiB/min, median (IQR):
    - **ouo-T3 119.7 (114.5–128.2)**, against W1's 234.5 and Sentry's 134.0 (131.3–135.7) in this run. Exit target ≤ 150: **met**.
    - **ouo-T4 333.8 (321.1–354.9)**, against W1's 387.7 and Sentry's 360.3 (350.5–368.4). Exit target ≤ 450: **met**.
  - Paired against `none` (W1 in parentheses): CPU +3.8 pp at T3 and T4 (W1 +3.8, +4.2), against Sentry's +6.2; peak memory +25.4 MB (+25.5); steady memory +1.5 MB (+1.6); start +38 ms (+72.5 at T3). The tile hash adds nothing measurable.
- **Static screen: zero image bytes.** The journey ends with about 20 s on a still home screen (the last tap at ~75 s, the end at 96 s). All 22 ouo sessions of the run (11 at T3, 11 at T4) sent no frame after second 77, read from rum-api's stored chunks. The masked sessions still sent their touches in frame-less chunks.
- Before the 10 rounds: one round per ouo cell, read from the stored chunks (`project/kb-archive/ios-replay.md`, "W3a: tiles on the device"). At T4, 11 of the 21 full images open a 5 s chunk, and most of the others follow a scroll or a screen change that redraws more than half the screen.

## Left, and what the next session must know

- At T4, most bytes are keyframes: the full image that opens every 5 s chunk, plus full images after scrolls. A longer keyframe interval would save more, but ADR-0014 fixes it at 5 s (the roadmap's 6 s); revisit only with a new measurement and an ADR revision.
- Buffer mode (ADR-0014) is not built: it needs the on-disk ring (`ChunkSpool` as its one-entry case) and the plugin's label.
- `examples/fast-tracked/30-mobile-ios.md` still describes pre-W1 capture (touch captures, 10 frames per chunk); it is a historical guide, left as is.

## Review round 1 (review-pr-118-tiles)

- **Fixed**:
  - `ChunkSpool.recover()` deleted the file before the recovered chunk reached the outbox, so a kill in that window lost it. The file now stays until the caller's `clear()`, which `ReplayRecorder.recoverSpool` runs after `enqueue` (a kill before that re-sends the chunk with the same seq, which replaces its copy). With nothing to send, `recover()` still removes the file. Tested: the chunk recovers again until `clear()`.
  - The `withPixels` fallback made its bitmap in the image's own color space, which fails for gray or extended-range images; it is sRGB now. Tested with 8-bit gray and 16-bit float extended sRGB.
  - The spec no longer says no SDK emits `mode`.
- **Answered, not changed**:
  - Each P3 patch JPEG carries the 554 B Display P3 profile. Stripping it would make browsers draw the patch in sRGB beside a P3 full image (visible seams), and gzip absorbs most of the repeat within a chunk.
- Verified: `sdk/ios/test.sh` 84 Core tests, the UIKit simulator build.
