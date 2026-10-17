# ios-replay

Owns `sdk/ios` (Swift package `OuoReplay`), the Expo module side of `sdk/react-native`
(`ios/`, `android/`, `expo-module.config.json`, `src/replay.ts`), replay wiring in
`examples/mobile`, `kb/ios-replay.md`, `kb/xcode-setup.md`. Phase 7 (ADR-0006).

- [tracker.md](tracker.md)
- `summaries/` dated run summaries
  - [2026-10-08-phase-7.md](summaries/2026-10-08-phase-7.md) iOS replay package, Expo module, example app, docs
  - [2026-10-08-phase-7b.md](summaries/2026-10-08-phase-7b.md) masking opt-out (`maskInputs`), docs, simulator proof, replay duration on session records
  - Phase 8a (project token on uploads) is in [sdk-react-native/summaries/2026-10-10-phase-8a.md](../sdk-react-native/summaries/2026-10-10-phase-8a.md)
  - Phase 8a revision 2 (Basic credential to the collector's replay receiver) is in [sdk-react-native/summaries/2026-10-10-phase-8a-rev2.md](../sdk-react-native/summaries/2026-10-10-phase-8a-rev2.md)
- `reports/` [phase-7-ios-verification.html](reports/phase-7-ios-verification.html) simulator verification checks and figures (Phase 7 and 7b)
