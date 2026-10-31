# 2026-10-31 N76: a frame follows the feedback on iOS

Branch `claude/ios-n76-feedback-frame`, checklist N76 (W6 review item 10, PR #120). Env `ios-n76-feedback-frame`, simulator `ouo-n77-n76` (F93D8F09-8AE9-45DF-A577-3ED43108C897, iPhone 18 Pro, iOS 27).

## What was done

- **`sdk/ios`**: `FrameReason.feedback`; `OuoReplay.frameForFeedback()` (the recorder's `frameForFeedback()`): the tile differ forgets the last frame, so the next one is a full image even on a static screen (an unchanged frame is otherwise not sent, which is what "the deduper keeps" means since W3a's tiles), and the pacer is asked for a `feedback` frame at once, in every mode; a dropped one (a masked view moving) is retried like a new screen's. `Ouo.feedback(screenshot: true)` calls it instead of `screenDidChange()`.
- **Native conformance C10.1** (`tests/e2e/mobile-native/check.mjs`): also asks for a frame with reason `feedback` at or after the record and at most 2 s after it, and prints the measured delay.
- **Plugin**: `buildFeedback(timeline, frames)` finds a `feedback` frame from 0.5 s before to 2 s after each record (`feedbackFrameTs`). With one the badge says "screenshot" (camera icon) and "Replay at feedback" seeks to that frame; else, with `ouo.feedback.screenshot`, it keeps "replay recording" and the seek to the record's time (React Native sessions, the bridge). `FrameReason` type gains `feedback`.
- **Spec**: `mobile-sdk.md` C10 (record, plugin, the C10.1 row), `mobile-replay.md` (the `reason` list). kb `feedback.md`, iOS README.
- **Example** (`examples/ouo-ios` journey): Products now stays 2 s instead of 1.2 s, the later steps 0.8 s later. With 1.2 s the next push could start before Products had a frame (a push takes about 0.5 s and the recorder waits 0.25 s after it), and C8.2 then read the Home frame where Products' areas were: it failed in two of three runs today (N77's run on the toolbar title, this branch's first run on the three Products areas).
- New checklist item **N82**: the same for React Native (the Expo module, `rum.feedback`, the stand-in, the RN C10.1). The React Native outbox item first numbered N81 in #137 is renumbered **N83**: the release session had taken N81 the same day.

## Verified, and how

- `sdk/ios/test.sh` (Xcode): 34 / 77 / 95 / 24 pass; new `CapturePacerTests.FeedbackFrameIsTakenAtOnceInEveryMode` (session mode between interval frames, navigation mode, the retry).
- Plugin: `tsc --noEmit` clean, eslint 0 errors (the 7 warnings were there), Jest 28 suites / 201 tests; new: `feedback.test.ts` (the window, before and after, another reason, no frames) and `SessionDetail.test.tsx` (the "screenshot" badge, no "replay recording", the seek shows the `feedback` frame).
- Native suite (`tests/e2e/mobile-native/run.sh ios-n76-feedback-frame <sim>`): first run 17 / 18 (C10.1 pass, the feedback frame 1 ms after the record; C8.2 failed as above); after the journey change **18 / 18**, C8 L2, the feedback frame 1 ms after the record, a full image 1.3 s after the last interval frame on the static Cart screen.
- Grafana of the env (branch build of the plugin): the session shows the "screenshot" badge; "Replay at feedback" shows "frame 3/3 · feedback".
- `lychee --offline` with the AGENTS.md flags: clean.

## What the next session must know

- npm walks up from a worktree into the shared checkout, which was mid-merge this run; an `npm` shim adding `--prefix "$(pwd)"` was on `PATH` for `ouo-env up` and `npm ci` (see the N77 summary).
- Env `ios-n76-feedback-frame` and the simulator are torn down at the end of the run (see the PR).
