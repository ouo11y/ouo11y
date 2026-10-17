# sentry-demo tracker

| Date | Event |
|---|---|
| 2026-10-14 | `examples/sentry-mobile` built (Expo 57, RN 0.86.3, `@sentry/react-native` 8.30.0 / sentry-cocoa 9.30.1), Release simulator build, unattended journey, real capture through `collector/tools/sentrytap -sink`. [summary](summaries/2026-10-14-sentry-demo.md) |
| 2026-10-17 | Runtime rollout switch `ouo.rum.mode` (OpenFeature, flagd over OFREP), `ROLLOUT.md` client guide, three cohorts verified on the simulator. [summary](summaries/2026-10-17-rum-mode-rollout.md) |

## Open

- Android: not built (no Android SDK on this Mac).
- Capture with a newer/older `@sentry/react-native` (for example Expo's pinned `~7.11.0`, sentry-cocoa 8.58) to pin the supported range in the spec.
- rum-api: filter sessions and health stats by `ouo.rum.mode` (today only by service).
