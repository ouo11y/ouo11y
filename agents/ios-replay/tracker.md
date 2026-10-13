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
| 2026-10-08 | Tap-driven checks done on the simulator panel: checkout masking, ouo-unmask, header masking (3 planner/rule fixes), crash flow | review |
| 2026-10-08 | Phase 7b: `maskInputs` split from `maskText` (Swift core, config, Expo record, JS options, docs), demo `maskText: false`, simulator proof (figure 12) | review |
| 2026-10-08 | Phase 7b: rum-api `replay_duration_ms` / `replay_frame_count` on session records (list + detail), unit test, compose rebuilt | review |
| 2026-10-10 | Phase 8a (ADR-0007): `OuoReplayConfig.projectToken`, `ChunkUploader` sends `X-Ouo-Project-Token` on every upload, Expo `StartOptions.projectToken` (`ERR_OUO_REPLAY_TOKEN` when empty), SwiftPM-by-URL note for the release agent | review: 39 Swift tests, `xcodebuild` OuoReplay for the simulator and the demo dev client build succeed ([summary](../sdk-react-native/summaries/2026-10-10-phase-8a.md)) |
| 2026-10-10 | Phase 8a rev2 (ADR-0007 revised): `OuoReplayConfig(endpoint:projectId:projectToken:)` with computed `authorization`, `ChunkUploader` sends `Authorization: Basic base64(id:token)` on every request incl. retries (`basicAuthorization`, `authorizationHeader`; `projectTokenHeader` gone), Expo `StartOptions.projectId` + `projectToken` (`ERR_OUO_REPLAY_CREDENTIAL`), vendored copies re-synced | review: 40 Swift tests (`BasicAuthorizationValue`, `EveryRequestCarriesTheBasicCredential`), `xcodebuild` OuoReplay for the simulator green, demo dev client rebuilt with the new record ([summary](../sdk-react-native/summaries/2026-10-10-phase-8a-rev2.md)) |
