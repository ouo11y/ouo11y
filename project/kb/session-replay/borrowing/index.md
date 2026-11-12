# Borrowing recorders

| Entry | Content |
|---|---|
| [sentry-ios-recorder-spike.md](sentry-ios-recorder-spike.md) | Spike: sentry-cocoa 9.33.0's iOS recorder core inside the ouo SDK behind a switch, shipped as `kind: "video"` chunks: seam map, what was cut, the sync script, measurements against the frames recorder, masking findings |
| [sentry-ios-video-over-otlp.md](sentry-ios-video-over-otlp.md) | The spike as `replay.mode: "pixel/video"` (`ouo-video/1` over OTLP) with the frames recorder's masking: what changed, the transition leak's root cause (presentation layers lag the commit), a second scroll leak found in both recorders, OCR proof over 20 runs, bytes and main-thread cost next to frames |
| [sentry-android-video-over-otlp.md](sentry-android-video-over-otlp.md) | `replay.mode: "pixel/video"` on Android: sentry-java 8.64.0's video encoder behind ouo's capture and masks, sent as `ouo-video/1` over OTLP: what was copied and why not more, the seam, the sync script, the transition-leak check, measurements against `pixel/frames` |
