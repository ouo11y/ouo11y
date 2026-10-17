# sentry-demo tracker

| Date | Event |
|---|---|
| 2026-10-14 | `examples/sentry-mobile` built (Expo 57, RN 0.86.3, `@sentry/react-native` 8.30.0 / sentry-cocoa 9.30.1), Release simulator build, unattended journey, real capture through `collector/tools/sentrytap -sink`. [summary](summaries/2026-10-14-sentry-demo.md) |
| 2026-10-17 | Device cost of `@ouo/react-native` next to Sentry measured (simulator, 30 runs, real taps): replay off = noise on CPU/memory/start, +15 requests / +59 KB per 95 s; replay on = +6.6 pp CPU. [summary](summaries/2026-10-17-sdk-overhead.md), [report](reports/sdk-overhead-ios.html) |
| 2026-10-17 | Bridge vs ouo SDK comparison on one real-tap journey in parallel mode (3 runs, isolated `ouo-cmp`): 11 (a) gaps tracked as A1 to A11 in `project/tracker/roadmap.md`; demo wires ouo navigation and `RUMProvider`, `OUO_REPLAY` flag. [summary](summaries/2026-10-17-bridge-vs-sdk.md), [report](reports/bridge-vs-sdk.html) |
| 2026-10-17 | Runtime rollout switch `ouo.rum.mode` (OpenFeature, flagd over OFREP), `ROLLOUT.md` client guide, three cohorts verified on the simulator; #24's navigation wiring and #25's perf harness folded into the modes. [summary](summaries/2026-10-17-rum-mode-rollout.md) |

## Open

- Android: not built (no Android SDK on this Mac).
- Capture with a newer/older `@sentry/react-native` (for example Expo's pinned `~7.11.0`, sentry-cocoa 8.58) to pin the supported range in the spec.
- rum-api: filter sessions and health stats by `ouo.rum.mode` (today only by service).
- Repeat the overhead measurement on a real iPhone (none available on 2026-10-17).
- Run-1 Sentry replay stopped after 41 s while the ouo replay ran; not reproduced in run 3. Rerun parallel sessions to confirm the two replays coexist.
