# sentry-demo

Owns `examples/sentry-mobile`: an Expo (React Native) iOS app instrumented with `@sentry/react-native` (and `@ouo/react-native` per the `ouo.rum.mode` rollout flag), used to generate real Sentry mobile SDK traffic (sentry-cocoa + RN JS layer, mobile Session Replay) for the Sentry bridge (ADR-0008), plus its Release simulator build script, unattended journey driver, recorder and capture analyser.

- [tracker.md](tracker.md)
- `summaries/` dated run summaries
  - [2026-10-14-sentry-demo.md](summaries/2026-10-14-sentry-demo.md) app, build, journey, first real capture (item counts, sdk names, replay_video layout)
  - [2026-10-17-rum-mode-rollout.md](summaries/2026-10-17-rum-mode-rollout.md) runtime switch Sentry / parallel / ouo via OpenFeature, verified three cohorts
