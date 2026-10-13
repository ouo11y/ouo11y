# 2026-10-14 grafana-plugin: video replay player (Sentry bridge S4, part 1)

ADR-0008 / `docs/specs/sentry-bridge.md` section 11. Plugin `ouo-rum-app` 0.3.0 -> **0.4.0**.

## What was done

- `src/components/VideoPlayer.tsx` (new): mounted on Session detail when the renderer is `video`. Plays the
  manifest's mp4 segments in seq order as one timeline from `started_at` to `ended_at`. The replay clock is the
  master; the `<video>` of the segment under the cursor follows it (play at `playbackRate = speed`, re-seek past
  250 ms drift, exact frame while paused, never restart an ended segment). Current + next segment are mounted
  (next hidden, `preload="auto"`). Gaps and the time after the last segment keep the previous segment paused on
  its last frame ("no video here" tag); before the first segment its first frame. Clock holds up to 4 s while the
  active segment has no frame yet. Undecodable segment: notice, clock/touches/markers keep working. Touch overlay,
  play/pause, scrubber, time, 1x/2x, keyboard (space, arrows = one encoded frame, shift+arrows = one segment,
  Home/End), "Sentry replay" `Badge` (tooltip with `replay_id`) when `source.vendor === "sentry"`, 70vh stage.
- `src/utils/video.ts` (new): `locateSegment` (global time -> segment, offset, gap), `segmentDurationMs`,
  `orderSegments`, `segmentStartOffset`, `mediaTimeSec`, `mountedSegmentIndices`, `videoBounds`, `totalFrames`,
  `frameStepMs`, `syncMediaElement`, `mediaPending`, `mediaErrorText`.
- Shared with the frame player (refactor, FramePlayer tests unchanged and green): `src/hooks/usePlaybackClock.ts`
  (rAF clock + goto/play/pause/toggle, optional `hold` and `onAdvance`) and `src/components/TouchOverlay.tsx`
  (the 500 ms fading touch dots). `STAGE_MAX_HEIGHT` and `SPEEDS` are exported from `FramePlayer.tsx`.
- API: `VideoManifest`, `VideoSegment`, `ReplaySource` types, `ReplayKind` gains `video`, `rumApi.replayVideo(id)`,
  `videoSegmentUrl(sessionId, segment)` maps the manifest `path` onto `/api/plugin-proxy/ouo-rum-app/rum`.
- `replayRenderer` and `replaySummary` accept `video` (`isReplayKind`); Session detail fetches `/replay/video`,
  bounds from `videoBounds`, markers/timeline seek the video player through the same `ReplayHandle`; info line;
  "Replay is empty" alert for a manifest without segments. Sessions table Replay column: `video` with the
  `presentation-play` icon (`@grafana/data` 13 has no video icon).
- Version 0.4.0 (minor: new user-visible replay kind, per `docs/releasing.md`), `CHANGELOG.md`, `README.md`
  (Replay players section).
- kb: `kb/grafana-plugin-video-player.md` + index line.

## Verified, and how

- `npm run -w plugins/ouo-rum-app typecheck`: clean. `lint`: 0 errors, 3 pre-existing `Select` warnings.
  `test`: 12 suites, 97 tests (new `video.test.ts` 23, `VideoPlayer.test.tsx` 12, plus video cases in
  `frames.test.ts`, `format.test.ts`, `SessionsTable.test.tsx`). `build`: compiled, `dist/plugin.json` 0.4.0.
- **Range through the Grafana proxy passes** (Grafana 13.2.1): `curl -r 0-99` / `-r 100-199` through
  `/api/plugin-proxy/ouo-rum-app/rum/...` -> `206`, `Content-Range` intact; Chrome's media requests 206. So the
  player uses the proxy URL as `<video src>` directly (cookie auth); no blob fallback. Grafana rewrites
  `Cache-Control` to `no-store` and adds `Content-Security-Policy: sandbox` (no effect on media).
- Live in the `ouo-sb` stack (built-in browser, plugin rebuilt, only `ouo-sb-grafana-1` restarted): see
  `agents/grafana-plugin/reports/s4-video-player.html` (`s4-0*.jpg`).
  - Real iOS Sentry session `BD134401-A1B3-4B1E-BB8B-E0477AC9B035` (sentry-demo, 5 segments, 25 s, 402x874):
    segments decode (`readyState 4`), scrubber 17.7 s -> seq 3 @ 2.712 s, playback crossed seq 3 -> seq 4 with the
    preloaded element (21.2 s = seq 4 @ 1.23 s) and stopped at 25.0 s; marker and timeline clicks seek.
  - Stub `e61027febc524625b7c474f7c787413e`: MediaError 4 notice; failed-request marker -> +0.2 s; ArrowRight x2 ->
    +2.2 s; touch (100, 200) drawn at 25.6% / 23.7% (within 0.5 px of the expected position), opacity 0.6.
  - Sessions table shows `video` for both. No console errors.

## Left / for the next agent

- **`package-lock.json`** (repo root, outside my allowed paths) still records `plugins/ouo-rum-app` as `0.3.0`;
  bump it to `0.4.0` (or run `npm install`) when committing, as was done for 0.3.0.
- Gaps between segments are verified by unit tests only; the live sessions had contiguous segments, and the
  real session had no touches (touches were verified on the stub).
- `kb/video-replay-serving.md` (rum-api agent) lists "Range through the Grafana proxy" as open: it is answered in
  `kb/grafana-plugin-video-player.md` (passes through).
- The manifest of the real session has `platform: ""`; the info line just omits it. rum-api/bridge may want to
  fill `ios`.
- Prettier reformatted two pre-existing blocks in files I touched (`SessionsTable.tsx`, `frames.ts`); two
  untouched test files (`FramePlayer.test.tsx`, `format.test.ts` before my edit) were already not prettier-clean.
- No new npm dependencies.
