# 2026-11-25 `@ouo11y/kit` plays `ouo-video/1`

Branch `feat/kit-ouo-video-player`, cut from `origin/main` at `d3434e7`. Spec: [`ouo-video/1`](../../../../docs/specs/mobile-replay.md#ouo-video1-video-segments-over-otlp).

## What was done

- **`libs/ouo-kit/src/replay/video.ts`** (new): `parseVideoChunk` (header line up to the first `0x0A`, then exactly `header.mp4` bytes; throws a showable message on no newline, a header that is not JSON or lacks `t`/`end`/`w`/`h`/`mp4`, or a length mismatch; defaults `scale` and `fps` to 1, drops malformed touches), `videoTimeline` (held segments in sequence order, back to back, a gap takes no time; segment length from the chunk's `start_time`/`end_time`), `locateSegment`, `touchesAt` (a touch is drawn for one frame, 1000 ms, from `t - header.t`).
- **`VideoPlayer`** (new, exported): props `chunks`, `fetchChunk(sequence)`, `onTime`, `className`. Fetches the segment under the cursor and the next one, keeps the one on screen until its successor replaces it, revokes every other object URL (and all on unmount). One `<video>` (`muted`, `playsInline`), play/pause, a range scrubber over the whole stream, speeds 1/2/4/8 (rrweb-player's `speedOption`), touch circles in an SVG whose `viewBox` is the video size, so they scale with the rendered video. A chunk that fails to fetch, parse or decode is listed under the video ("Segment N skipped: ...") and play moves on. Play after the last segment ended starts over.
- **`formats.ts`**: `ouo-video/1` has renderer `video` (`Renderer = 'rrweb' | 'video'`). **`ReplayPlayer`** dispatches it to `VideoPlayer`, keyed by stream, with the playable runs flattened (all `ouo-video/1` chunks are keyframes, so this is every held chunk in order). No new prop; the existing `fetchChunk(stream, seq)` is reused and the video chunks are not fetched up front.
- README format table and a paragraph on the video player. `CHANGELOG.md` untouched: release-please writes the entry from the `feat(kit)` commit.

## Verified, and how

- `npm test -w libs/ouo-kit`: 4 files, 26 tests (9 new on the parser, timeline, locate and touches; 8 on `VideoPlayer` in jsdom with stubbed object URLs and `play`/`pause`; 1 dispatch test in `ReplayPlayer`). The two tests for seeking back into the segment on screen and for replay-from-end were checked to fail with their fix disabled.
- `npm run typecheck -w libs/ouo-kit`: clean. `npm run build -w libs/ouo-kit` and `npm pack --dry-run -w libs/ouo-kit`: ok.
- `lychee --offline` on the repository: clean.
- Not verified by the author: playback of a real `ouo-video/1` recording in a browser (jsdom decodes no video). No stack was started; no env is left running.
- Review session, same day: played in Google Chrome and Playwright WebKit from a real Muninn (OTLP ingest, filesystem store) with real H.264 segments at 1 frame/s (AVAssetWriter, with a gap, touches, a corrupt chunk, a 40-segment stream, the Sentry SDK fixture segments) and an `rrweb/2` recording. WebKit showed only keyframes above 2x and stale frames after a seek while playing, touches were missed at 8x (`timeupdate` is about 4 Hz) and a decode failure could stop the stream (`play()` rejection). `VideoPlayer` now keeps its own clock and seeks a paused element once per frame; 94 browser checks pass in each engine. Measurements in the kb: [video at 1 frame/s](../../../kb/plugin/ouo-kit/video-at-1-fps.md).

## Dependencies added

None.

## Next

- Not played yet: Safari itself (Playwright WebKit uses the same AVFoundation stack), iOS Safari, Firefox (no H.264 on some Linux builds), and a recording that went through the Sentry bridge (PR #221).
- `docs/compatibility.md` needs a `kit | 0.2` row ("plays `rrweb/2` and `ouo-video/1`") in the release PR.
- `ouo-frames/3` is still not playable in the kit.
