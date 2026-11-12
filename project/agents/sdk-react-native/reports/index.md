# sdk-react-native reports

| Folder | Content |
|---|---|
| [rn-replay-video-ios/](rn-replay-video-ios/index.md) | `replay.mode: "pixel/video"` on iOS: the transition leak's trace, the OCR proof over 20 runs, the end-to-end run against the fake collector |
| [rn-replay-otlp-ios/](rn-replay-otlp-ios/index.md) | `pixel/frames` over OTLP on the iOS Simulator: fake Collector verdicts, retry and drop evidence, masked frames (default and with `maskText: false`), a normal stream end, capture timing |
| [rn-replay-otlp-android/](rn-replay-otlp-android/index.md) | `pixel/frames` over OTLP on an Android emulator: collector verdicts and two masked frames |
