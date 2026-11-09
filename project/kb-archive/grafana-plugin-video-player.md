# grafana plugin: video replay through the plugin proxy

Status: verified 2026-10-14 by grafana-plugin (plugin 0.4.0, Grafana 13.2.1, isolated stack `ouo-sb`).
Code: `plugins/ouo11y-rum-app/src/components/VideoPlayer.tsx`, `src/utils/video.ts`,
`src/hooks/usePlaybackClock.ts`. Server side: `project/kb-archive/video-replay-serving.md`, ADR-0008, `docs/specs/sentry-bridge.md` section 11.

## Question

Can the plugin play rum-api's mp4 segments (`kind: "video"`) with a plain `<video src>` even though rum-api needs
`Authorization: Bearer <read token>`, and does Grafana's plugin proxy pass `Range` / 206 through?

## What works

- **`<video src="/api/plugin-proxy/ouo11y-rum-app/rum/v1/sessions/<id>/replay/video/<seq>">`.** Same origin as
  Grafana, so the browser sends the Grafana session cookie; the `rum/*` route adds the read token server-side
  (ADR-0007). No blob/object-URL fallback is needed. The manifest's `path` is relative to the rum-api root and is
  prefixed with the proxy base (`videoSegmentUrl`, which ignores anything that is not a `/v1/` path).
- **Range passes through.** `curl -r 0-99` and `-r 100-199` through the proxy return `206 Partial Content` with
  `Content-Range: bytes 100-199/7728`, and Chrome's own media requests for the segments show `206` in the network
  log. Grafana 13.2.1 forwards the `Range` request header and the upstream status/headers unchanged.
- Headers Grafana adds to every proxied response: `Cache-Control: no-store` (replaces rum-api's
  `private, no-cache`, so a remounted segment is fetched again; segments are ~8 KB to ~50 KB, fine),
  `Content-Security-Policy: sandbox`, `X-Frame-Options: deny`, `Via: 1.1 grafana`. The CSP applies to documents,
  not to media loaded by a `<video>` element: playback works.
- **Real Sentry iOS segments decode in Chrome**: 402x874 H.264, `duration` 5 s, `readyState` 4. The stub test mp4
  (32 bytes, `ftyp` only) fails with `MediaError.code` 4 (`MEDIA_ERR_SRC_NOT_SUPPORTED`); the player shows a
  notice and keeps the clock, touches and markers working.

## Player design that held up

- The replay clock (rAF, wall time x speed, shared with the frame player in `usePlaybackClock`) is the master;
  the `<video>` of the segment under the cursor follows it (`syncMediaElement`): played at `playbackRate = speed`
  and re-seeked only past 250 ms drift while playing, seeked to the exact frame while paused, never re-`play()`ed
  once `ended` (that would restart it at 0), not seeked while `seeking`.
- Global time to segment: binary search for the last segment with `started_at <= t`; past its duration is a gap
  and the same element stays paused on its last frame (`currentTime = duration - 1 ms`). Before the first segment
  the first frame is shown.
- Only the current and the next segment are mounted (`key = seq`, next one `visibility: hidden`, `preload="auto"`),
  so the hand-over at a segment boundary is instant (verified live: seq 3 to seq 4 while playing, media time
  followed the global clock to within one rAF). A seek to a far segment mounts a new element and shows
  "Loading segment N..." for a moment. **Changed in 0.8.0 (F4):** that moment was a black stage for about 1 s
  on every seek (Sentry's player shows the frame at once). Now both neighbours are mounted, and the element on
  screen is tracked separately from the one under the cursor (`paintedSegmentIndex`): the old element stays
  visible (and mounted) until the new one fired `loadeddata` while not `seeking`, or `seeked`, and only a small
  "loading segment N..." tag shows. A remounted element starts unpaintable again (its ref callback clears it).
- The clock holds (up to 4 s) while the active segment has `readyState < HAVE_CURRENT_DATA` and no error, so a
  slow segment does not get skipped.
- Touch x/y are in the video's pixel space (= manifest `viewport`); the stage has the viewport's aspect ratio and
  the video uses `object-fit: fill`, so `x / width` and `y / height` as percentages land exactly (measured live:
  64.2, 127.9 px vs 63.7, 127.4 expected on a 248x538 stage).

## Gotchas

- jsdom has no media pipeline: tests stub `HTMLMediaElement.prototype.play/pause` and the `paused`,
  `readyState`, `duration` and `currentTime` getters with `jest.spyOn(proto, 'x', 'get')`. `error` is not on the
  jsdom prototype at all; set it on the element with `Object.defineProperty` before `fireEvent.error`.
- `IconButton`'s `aria-label` is its tooltip text (`Play (space)`), not the `aria-label` prop.
- `@grafana/data` 13 has no `video`/`film` icon; `presentation-play` is used for the Replay column.
- Taps (plugin 0.6.0) are drawn by `TapOverlay` from the merged touches and `ui.tap` breadcrumbs, not by the plain
  touch overlay: `project/kb-archive/sentry-replay-taps.md`.
