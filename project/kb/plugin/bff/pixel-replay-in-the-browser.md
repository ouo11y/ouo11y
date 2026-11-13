# Pixel replays in the browser

> What does playing `ouo-frames/3` and `ouo-video/1` in `@ouo11y/kit` need from the browser, and how is it tested?

Verified 2026-11-13 in env `pluginbff` with `tests/e2e/plugin-bff/run.mjs` (steps 4 and 5).

- **H.264 needs a real Chrome in Playwright.** Playwright's bundled Chromium has no proprietary codecs, so an `ouo-video/1` segment does not decode there. `chromium.launch({ channel: "chrome" })` uses the installed Google Chrome, which decodes the Sentry iOS fixture (402x874, `readyState` 4). The e2e defaults to `OUO_E2E_CHANNEL=chrome`. Users' browsers (Chrome, Edge, Safari, Firefox) all decode H.264.
- **A real segment for tests** is in the repo: `project/kb/vendor-internals/sentry/mobile-sdks/fixtures/ios/04-replay-segment-0/replay_video.mp4` (31 KB, 5 frames at 1 fps, one keyframe). The `ouo-video/1` body is a JSON header line with `mp4` set to its length, a newline, then those bytes, `ouo.replay.encoding` `identity`.
- **JPEGs for `ouo-frames/3` tests** come from `page.screenshot({ type: "jpeg" })` of a page set with `setContent`; a `clip` gives a patch of a known colour. Asserting pixel colours with `getImageData` on the canvas proves the patch was drawn over the frame, not only that a canvas exists.
- **A mobile-shaped session** needs no device: two `ouo.rum` events (`session.start`, `app.navigation.complete`) and the replay records, sent as OTLP to the Collector with `tests/e2e/muninn/otlp.mjs`. Loki rejects records older than 7 days, so the test dates them a minute back.
- **The video follows the replay clock**, as the MVP player did (kb-archive `grafana-plugin-video-player.md`): the `<video>` is seeked only past 0.25 s of drift while playing, and in a gap between segments it is held on the last frame.
