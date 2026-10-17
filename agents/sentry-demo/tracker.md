# sentry-demo tracker

| Date | Event |
|---|---|
| 2026-10-14 | `examples/sentry-mobile` built (Expo 57, RN 0.86.3, `@sentry/react-native` 8.30.0 / sentry-cocoa 9.30.1), Release simulator build, unattended journey, real capture through `collector/tools/sentrytap -sink`. [summary](summaries/2026-10-14-sentry-demo.md) |
| 2026-10-17 | Device cost of `@ouo/react-native` next to Sentry measured (simulator, 30 runs, real taps): replay off = noise on CPU/memory/start, +15 requests / +59 KB per 95 s; replay on = +6.6 pp CPU. [summary](summaries/2026-10-17-sdk-overhead.md), [report](reports/sdk-overhead-ios.html) |

## Open

- Android: not built (no Android SDK on this Mac).
- Capture with a newer/older `@sentry/react-native` (for example Expo's pinned `~7.11.0`, sentry-cocoa 8.58) to pin the supported range in the spec.
- Repeat the overhead measurement on a real iPhone (none available on 2026-10-17).
