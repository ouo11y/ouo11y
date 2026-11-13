# `pixel/video` on iOS: leak trace, OCR proof, end-to-end run

Evidence for [sentry-ios-video-over-otlp.md](../../../../kb/session-replay/borrowing/sentry-ios-video-over-otlp.md) (2026-11-12, branch `claude/rn-ios-video-885aaf`).

| File | Content |
|---|---|
| [leak-trace.json](leak-trace.json) | The spike's leak traced over 5 runs: every capture whose presentation layer tree was shorter than the model tree, next to every frame OCR found readable (4 and 4, the same captures) |
| [spike-leak-products-first-frame.jpg](spike-leak-products-first-frame.jpg) | The spike's leak: first frame of the SwiftUI Products screen, "Card ending 4242" readable (presentation tree 28 layers, model 38) |
| [spike-leak-statement-first-frame.jpg](spike-leak-statement-first-frame.jpg) | The spike's leak: first frame of the statement list, every row readable (presentation 25 layers, model 119) |
| [fixed-video-transition-frames.jpg](fixed-video-transition-frames.jpg) | This branch, `pixel/video`: the first frame after each screen change (Products, Cart, statement, Home after the pop), all masked; "Total 4.50" is unmasked on purpose |
| [ocr-and-measurements.json](ocr-and-measurements.json) | OCR of every frame of 6 spike runs and 20 runs of this branch (10 per recorder), bytes, frames and main-thread time per recorder, the OTLP bytes of the React Native journey |
| [rn-e2e-collector-report.json](rn-e2e-collector-report.json) | `examples/ouo-mobile` with `replay.mode: "pixel/video"`: the fake collector's `GET /__report` (verdict pass, 11 `ouo-video/1` chunks, one ended stream) |
| [rn-e2e-mp4-decode.json](rn-e2e-mp4-decode.json) | Every mp4 of that run decoded with AVFoundation (frames, duration; OCR text, readable because the demo sets `maskText: false`) |
| [rn-e2e-video-frames.jpg](rn-e2e-video-frames.jpg) | Three frames extracted from those mp4s: checkout (promo input masked), chaos screen, the fetch-failed screen (no backend in this run) |
