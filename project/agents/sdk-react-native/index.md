# sdk-react-native

Owns `sdk/react-native` (`@ouo11y/react-native`) and `examples/ouo-mobile` (Expo "mobile-store").

- [tracker.md](tracker.md) — work items and status
- `summaries/` dated run summaries
  - [2026-10-07-phase-5.md](summaries/2026-10-07-phase-5.md) — Phase 5: SDK, Expo app, headless + Expo web verification, simulator blocked
  - [2026-10-10-phase-8a.md](summaries/2026-10-10-phase-8a.md) — Phase 8a: 0.2.0, rum-api ingest routes and project token (RN, Swift, demo app, guide), publishable package
  - [2026-10-10-phase-8a-rev2.md](summaries/2026-10-10-phase-8a-rev2.md) — Phase 8a revision 2: the collector is the edge; `endpoint` = collector, `projectId` + `projectToken` as HTTP Basic, derived `replayEndpoint` (RN, Swift, demo app, guide)
  - [2026-10-23-b2-bridge-parity.md](summaries/2026-10-23-b2-bridge-parity.md) — batch 2: span and log API, timeline (taps, lifecycle, requests), Sentry forwarding, device model, trace id on errors, stack paths, JS vitals, Q1 fatal de-duplication; native hooks still needed for app start and frames
