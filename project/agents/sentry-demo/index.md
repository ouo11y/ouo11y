# sentry-demo

Owns `examples/sentry-mobile`: an Expo (React Native) iOS app instrumented with `@sentry/react-native` (and `@ouo11y/react-native` per the `ouo.rum.mode` rollout flag), used to generate real Sentry mobile SDK traffic (sentry-cocoa + RN JS layer, mobile Session Replay) for the Sentry bridge (ADR-0008), plus its Release simulator build script, unattended journey driver, recorder and capture analyser.

- [tracker.md](tracker.md)
- `summaries/` dated run summaries
  - [2026-10-14-sentry-demo.md](summaries/2026-10-14-sentry-demo.md) app, build, journey, first real capture (item counts, sdk names, replay_video layout)
  - [2026-10-17-rum-mode-rollout.md](summaries/2026-10-17-rum-mode-rollout.md) runtime switch Sentry / parallel / ouo via OpenFeature, verified three cohorts
  - [2026-10-17-sdk-overhead.md](summaries/2026-10-17-sdk-overhead.md) device cost of ouo next to Sentry: perf build mode, harness, 30 runs, result
  - [2026-10-17-bridge-vs-sdk.md](summaries/2026-10-17-bridge-vs-sdk.md) bridge vs ouo SDK comparison on one journey, parallel-mode demo fixes
  - [2026-10-18-sentry-self-hosted.md](summaries/2026-10-18-sentry-self-hosted.md) self-hosted Sentry as the bridge's real upstream (N2), Sentry MCP, F4 side by side
  - [2026-11-15-sentry-mirror-readiness.md](summaries/2026-11-15-sentry-mirror-readiness.md) bridge in front of a production DSN: risk list, mirrors and passthrough (ADR-0028), measured overhead, go/no-go
  - [2026-10-23-b2-bridge-examples.md](summaries/2026-10-23-b2-bridge-examples.md) batch 2: three examples with trace-continuity `verify`, mobile vitals, SDK range goldens, client setup notes, live run against self-hosted Sentry
- `project/reports/` HTML reports
  - [sdk-overhead-ios.html](reports/sdk-overhead-ios.html) CPU, memory, start, network, JS frames and main-thread stalls of five SDK mixes on the iOS simulator, with the client claim
  - [bridge-vs-sdk.html](reports/bridge-vs-sdk.html) field-by-field comparison of what the Sentry bridge and the ouo RN SDK deliver, gap register (a/b/c) with effort, pitch guidance
  - [sentry-mirror-readiness.html](reports/sentry-mirror-readiness.html) production DSN readiness: risk list, fan-out design, end to end against self-hosted Sentry with a mirror, latency, burst, soak, failure injection, config to use
  - [sentry-self-hosted-n2-f4.html](reports/sentry-self-hosted-n2-f4.html) bridge in front of self-hosted Sentry (byte-identical, Sentry's answers, ouo checks), memory, Sentry MCP, the unmasked replay in Sentry's player and ouo's plugin side by side
