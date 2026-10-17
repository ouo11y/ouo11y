# sentry-demo

Owns `examples/sentry-mobile`: an Expo (React Native) iOS app instrumented only with `@sentry/react-native`, used to generate real Sentry mobile SDK traffic (sentry-cocoa + RN JS layer, mobile Session Replay) for the Sentry bridge (ADR-0008), plus its Release simulator build script, unattended journey driver, recorder and capture analyser.

- [tracker.md](tracker.md)
- `summaries/` dated run summaries
  - [2026-10-14-sentry-demo.md](summaries/2026-10-14-sentry-demo.md) app, build, journey, first real capture (item counts, sdk names, replay_video layout)
  - [2026-10-17-sdk-overhead.md](summaries/2026-10-17-sdk-overhead.md) device cost of ouo next to Sentry: perf build mode, harness, 30 runs, result
  - [2026-10-17-bridge-vs-sdk.md](summaries/2026-10-17-bridge-vs-sdk.md) bridge vs ouo SDK comparison on one journey, parallel-mode demo fixes
- `reports/` HTML reports
  - [sdk-overhead-ios.html](reports/sdk-overhead-ios.html) CPU, memory, start, network, JS frames and main-thread stalls of five SDK mixes on the iOS simulator, with the client claim
  - [bridge-vs-sdk.html](reports/bridge-vs-sdk.html) field-by-field comparison of what the Sentry bridge and the ouo RN SDK deliver, gap register (a/b/c) with effort, pitch guidance
