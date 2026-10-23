# ios-replay

Owns `sdk/ios` (Swift package: `OuoReplay`, `OuoCrash`, `OuoVitals`), the Expo module side of `sdk/react-native`
(`ios/`, `android/`, `expo-module.config.json`, `src/replay.ts`), replay wiring in
`examples/ouo-mobile`, `project/kb/ios-replay.md`, `project/kb/xcode-setup.md`. Phase 7 (ADR-0006).

- [tracker.md](tracker.md)
- `summaries/` dated run summaries
  - [2026-10-08-phase-7.md](summaries/2026-10-08-phase-7.md) iOS replay package, Expo module, example app, docs
  - [2026-10-08-phase-7b.md](summaries/2026-10-08-phase-7b.md) masking opt-out (`maskInputs`), docs, simulator proof, replay duration on session records
  - [2026-10-23-n6-g1.md](summaries/2026-10-23-n6-g1.md) replay capture off the main thread (N6), native crash capture (G1)
  - [2026-10-23-g2-vitals.md](summaries/2026-10-23-g2-vitals.md) native app start and CADisplayLink frame counters for the mobile vitals (G2)
  - Phase 8a (project token on uploads) is in [sdk-react-native/summaries/2026-10-10-phase-8a.md](../sdk-react-native/summaries/2026-10-10-phase-8a.md)
  - Phase 8a revision 2 (Basic credential to the collector's replay receiver) is in [sdk-react-native/summaries/2026-10-10-phase-8a-rev2.md](../sdk-react-native/summaries/2026-10-10-phase-8a-rev2.md)
- `reports/` [phase-7-ios-verification.html](reports/phase-7-ios-verification.html) simulator verification checks and figures (Phase 7 and 7b); [n6-g1-replay-crashes.html](reports/n6-g1-replay-crashes.html) per-capture main-thread time before/after vs Sentry, CPU/memory/frames, native crash flows (N6, G1); [g2-vitals.html](reports/g2-vitals.html) vitals records in Loki and the plugin, Time Profiler cost (G2)
- `perf/` measurement and verification scripts (`profile-runs.sh`, `capture_stalls.py`, `signposts.py`, `crash-flow.sh` with `crashtap/`, `report.py`, `vitals_profile.py`) and their data (`results/sim`, `results/vitals-g2-time-profile.txt`)
