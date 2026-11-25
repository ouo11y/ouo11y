# `ouo-video/1` in a browser: 1 frame/s, one keyframe per segment

Measured on 2026-11-25 in Google Chrome (Playwright `channel: 'chrome'`) and Playwright WebKit 2370 on macOS, with real H.264 segments (AVAssetWriter, 1 frame/s, 5 frames, a single keyframe, like the SDK recorders) and the Sentry SDK segments in [the Sentry fixtures](../../vendor-internals/sentry/mobile-sdks/fixtures/index.md), served by a real Muninn.

**Playing the element is not reliable.** With `<video>` playback (`play()` with `playbackRate`):

- WebKit above 2x presents only the keyframe: `requestVideoFrameCallback` fires once per segment and frame 0 stays on screen while `currentTime` runs to the end (AVFoundation trick play shows keyframes only at high rates; a segment has one). 1x and 2x present every frame.
- WebKit, after a seek while playing at 1x, keeps the frame it had for about a second: seeking to 1.9 s showed frame 0 until 3.0 s, so frames 1 and 2 were never shown.
- `timeupdate` fires about 4 times a second of wall time in both engines, 2 s of video at 8x: overlays driven by it (touches drawn for one frame, 1 s) are missed.
- A `play()` promise rejected by a source that fails to decode looks like an autoplay refusal; treating every rejection as "stop" stopped the stream at a corrupt segment (WebKit, 1 run in 4).

**Seeking a paused element is exact** in both engines: setting `currentTime` lands on the frame that covers that time (frame `floor(t * fps)`) at every speed. So `VideoPlayer` keeps its own clock on `requestAnimationFrame`, never calls `play()`, and sets `currentTime` once per frame change: 1 to 8 seeks a second, each decoding at most 5 frames from the keyframe. The touches follow the same clock. The clock waits for a new segment's `loadedmetadata` before it runs on.

**Other measurements.** The mp4 from AVAssetWriter puts `mdat` before `moov`; from a blob URL that does not matter. Every generated mp4 held `0x0A` bytes, so the header must be split at the first newline only. A page Content Security Policy without `media-src blob:` makes each segment fail with an `error` event (Chrome: "Media load rejected by URL safety check", WebKit: code 4) and a console CSP violation; nothing is thrown into the page. Playwright's bundled Chromium has no H.264 decoder: use `channel: 'chrome'`.
