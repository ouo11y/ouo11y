# 2026-10-29 W1: production-safe iOS capture

Branch `claude/w1-ios-capture`, work package W1 of [roadmap.md](../../../kb/mobile-sdk-research/roadmap.md) (N51, N52). Env `w1-ios-capture` (released images), simulator `ouo-w1` (0A7A1A06-7317-4FA2-B166-D85E366D6621).

## What was done

- **Capture scheduling** (`sdk/ios`): `CapturePacer` (Core, pure, unit tested) decides once per main run-loop pass (`CFRunLoopObserver` at `beforeWaiting`, order `CFIndex.max`, common modes): interval (`session` mode) or pending screen change (`navigation` mode, 0.4 s after the signal), no capture while a view controller transition runs, animation deferral (≥ 4 layer animations wait up to 1 s), 0.25 s settle after motion, and a 100 ms/s main-thread time bank (also the backoff: a 150 ms capture leaves one frame every 1.5 s). The 1 Hz `Timer` that captured and the touch-triggered captures are gone; a 1 s keep-alive timer only wakes the run loop, cuts chunks on time and re-attaches the touch observer. One capture in flight (was 2).
- A dropped resume or navigation frame (masked view moving, render failed) is asked for again 0.5 s later; in navigation mode nothing else would show that screen.
- **Render** 1:1 at the screen's scale into an 8-bit bitmap in the screen's color space (Sentry's default renderer), downscale on the capture queue (`FrameComposer.downscale`).
- **Fail-closed masking**: `ViewNode.moving` (an animation other than opacity, colors, contents, borders, corner radius, shadows, filters on the layer) and `truncated` (walk depth limit). `RedactionPlanner.rects` returns nil when a masked rectangle is moving (or inside a moving view): the frame is dropped. Truncated subtrees are masked whole. The walk no longer descends into hidden or transparent views.
- **Modes and device tier**: `ReplayMode` `session` / `navigation` / `auto` (navigation below 3.5 GiB of RAM), `OuoReplay.screenDidChange()`; React Native `replay.mode`, and every tracked route change calls `screenDidChange` on the native module.
- **Crash durability**: `ChunkSpool` keeps the open chunk on disk (JSON Lines in `Application Support/ouo/replay/open-chunk.jsonl`); the next launch sends it with its session, seq and last-item end time.
- **N52**: `OuoCrash.setSession(_:startedAtMs:)`, the C core keeps id and start in one double-buffered record and writes `session_started_ms`; the RN SDK passes the session start on install and on every rotation, ends a session the storage never saw from the crash report, and rum-api's fold takes the start from `session.end`'s `ouo.session.started_at` when `session.start` is missing.
- Docs: ADR-0006 revision 2, `docs/specs/mobile-replay.md` capture rules 1-8 and the chunk durability rule, `sdk/ios` and `sdk/react-native` READMEs and CHANGELOGs, kb `ios-replay.md` "W1", checklist N51 (open part: the phone) and N52 (done), focus note.

## Verified, and how

- `sdk/ios/test.sh`: 63 Core tests (new: `CapturePacerTests` 9, `ChunkSpoolTests` 4, planner fail-closed 2) and the crash probe tests (the report carries `session_started_ms`). `xcodebuild` for the iOS simulator builds the UIKit target clean.
- `sdk/react-native`: `tsc --noEmit` clean, 130 Vitest tests (new: N52 unpersisted crashed session, `session_started_ms` parsing, `screenDidChange` forwarding with older native builds, `mode` pass-through).
- `services/rum-api`: `go vet` clean; `internal/session` tests pass with the new `TestFoldStartedAtFromSessionEndWithoutStart`. `internal/replay` fails locally only because Docker Hub timed out pulling the minio image (untouched package; CI runs it).
- Simulator, `examples/ouo-mobile` Release against env `w1-ios-capture`, scripted journey:
  - Replays arrive in rum-api for every run (13-15 kept frames per 42 s in session mode). A contact sheet of the first build showed 3 of 15 frames with the transition's last frame; diagnostics showed 0 animations and no transition coordinator at those captures (the screen trails the model). After the settle rule: 0 of 26 frames over two runs; the promo-code input is black in every frame.
  - Navigation mode: 10 frames for 9 screen changes plus launch, all settled, no timer frames.
  - `kill -9` of the app 4 s after launch (spool 68 KB, chunk not cut): after relaunch rum-api had the killed session's 3 frames, `ended_at` = last frame.
  - Main-thread `snapshot` per capture (signposts, two runs per variant, interleaved): 1:1 27-31 ms, 1x nearest-neighbour 26-31 ms, 1x default (before W1) 31-34 ms. Simulator numbers do not decide N51; see "Left".
- B3 on the simulator: see the bench result below.
- `lychee --offline` clean.

## Left

- **The phone check (W1 exit criterion)**: per-capture main-thread time ≤ 25 ms on the iPhone 16 Pro Max against Sentry in the same trace (`n22_device.py profile`, 3 rounds, about 7 min) and the T3/T4 CPU delta against Sentry (4 device runs, about 15 min). Needs the founder; N51 stays open until then.
- Env `w1-ios-capture` is up (released images, `http://grafana.w1-ios-capture.ouo.localhost`); simulator `ouo-w1` is booted. Both go down when the PR merges.

## For the next agent

- `drawHierarchy(afterScreenUpdates: false)` shows what the screen last showed, not the model: any "capture right after X" logic needs the settle time.
- npm inside `.claude/worktrees/*` breaks while the main checkout has a conflicted `package.json`; use `npm --prefix` (kb `ios-replay.md` W1).
- W2 (spec and conformance) was proposed as a separate session; W3 needs ADR-0014 first.
