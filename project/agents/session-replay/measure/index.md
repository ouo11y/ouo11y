# Recorder comparison harness

Compares the iOS frames recorder with the Sentry-derived one on the `replaydemo` journey of `examples/ouo-ios` (Home, Products, Cart, a scrolled 80-row statement, about 45 s), on the iOS Simulator, against a local sink.

| File | Content |
|---|---|
| [run.sh](run.sh) | `run.sh <udid> <OuoExample.app> <out> [rounds]`: per round, each recorder once on a fresh install, interleaved and rotated; background at 50 s so the open chunk is sent |
| [sink.py](sink.py) | Answers OTLP (200) and the replay receiver (202), logs bytes per request, saves each replay body |
| [frames.swift](frames.swift) | `swift frames.swift <run dir>`: rebuilds every frame (JPEG patches or mp4 frames), OCRs each with Vision (`ocr.json`), writes `sheet.jpg` |
| [analyze.py](analyze.py) | Per-run and per-recorder medians: KiB/min sent, frames, main-thread ms per capture, frames with readable text |
| [results.json](results.json) | The numbers in the kb entry and the report |

Build the app with `examples/ouo-ios/scripts/build.sh <out>`.
