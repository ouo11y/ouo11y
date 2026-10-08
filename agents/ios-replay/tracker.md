# ios-replay tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-08 | `sdk/ios` package: Core (models, ChunkBuilder, SeqStore, FrameDeduper, RedactionPlanner, Gzip, ChunkUploader) | done, 35 tests pass on macOS (`sdk/ios/test.sh`) |
| 2026-10-08 | `sdk/ios` UIKit target (OuoReplay API, ScreenCapturer, TouchObserver, ReplayRecorder) | written; compiles to the stub on macOS, iOS compile pending Xcode |
| 2026-10-08 | Real upload to rum-api (`OUO_REPLAY_STUB_URL=http://localhost:8080`) | done, chunks stored as `kind: frames` and served by `/replay/frames` |
| 2026-10-08 | Expo module: config, `OuoReplayModule.swift`, three podspecs, source sync script, Android stub | done; autolinking resolves them; native compile / `pod install` pending Xcode + CocoaPods |
| 2026-10-08 | JS bridge `src/replay.ts`, `rum.replay`, `initRUM({ replay, replayEndpoint })`, rotation hook, tests | done, 56 RN tests pass |
| 2026-10-08 | `examples/mobile`: replay enabled, `ouo-mask` / `ouo-unmask` demo, Chaos button, Metro peer redirect, prebuild, README | done (prebuild `--no-install` ran; `run:ios` pending Xcode) |
| 2026-10-08 | kb entries, tracker boxes, summary | done |
| open | Simulator verification (masked fields black, pause stops chunks, Grafana playback) | blocked: Xcode not installed (`kb/xcode-setup.md`) |
| open | `xcodebuild -scheme OuoReplay -destination 'generic/platform=iOS Simulator' build` | blocked: Xcode |
| 2026-10-08 | Native verification on iOS 27 simulator: replay captured, masked, stored, played in Grafana; 3 fixes landed | review |
