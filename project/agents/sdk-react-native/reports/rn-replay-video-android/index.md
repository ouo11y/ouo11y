# rn-replay-video-android: leak evidence for `pixel/video` on Android

The transition-leak check of [sentry-android-video-over-otlp.md](../../../../kb/session-replay/borrowing/sentry-android-video-over-otlp.md), 2026-11-12, emulator `rn-android-video` (Android 15), `examples/ouo-mobile` Release conformance build.

- [video-cart-modal.png](video-cart-modal.png) — a `pixel/video` frame 0.6 s after the Cart modal opened: every text and the inputs masked
- [video-product-push.png](video-product-push.png) — a `pixel/video` frame 0.7 s after a product push: only the `ouo-unmask` title is readable
- [sheet-video-run1-part1.png](sheet-video-run1-part1.png) — the first 60 of 165 video frames of run 1, labelled with the transition before each
- [sheet-frames.png](sheet-frames.png) — all 61 `pixel/frames` images of the comparison run
- [ocr-summary.json](ocr-summary.json) — Vision OCR over every image of the three runs: only product titles found
- [collector-report-video.json](collector-report-video.json), [collector-report-video2.json](collector-report-video2.json), [collector-report-frames.json](collector-report-frames.json) — the fake collector's `/__report` per run (all pass; `ended` checked in run 2 and frames)
- [transitions-video-run1.log](transitions-video-run1.log), [transitions-video-run2.log](transitions-video-run2.log), [transitions-frames.log](transitions-frames.log) — epoch ms of each transition command
- [leak-run.sh](leak-run.sh) — drives the 10 runs of six transitions over adb broadcasts
- [extract.py](extract.py) — frames bodies to JPEGs, video chunks to mp4, with times
- [frames-ocr.swift](frames-ocr.swift) — every mp4 sample and JPEG through AVFoundation and Vision OCR
