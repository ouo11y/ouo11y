# sentry-demo tracker

| Date | Event |
|---|---|
| 2026-10-14 | `examples/sentry-mobile` built (Expo 57, RN 0.86.3, `@sentry/react-native` 8.30.0 / sentry-cocoa 9.30.1), Release simulator build, unattended journey, real capture through `collector/tools/sentrytap -sink`. [summary](summaries/2026-10-14-sentry-demo.md) |
| 2026-10-17 | Device cost of `@ouo11y/react-native` next to Sentry measured (simulator, 30 runs, real taps): replay off = noise on CPU/memory/start, +15 requests / +59 KB per 95 s; replay on = +6.6 pp CPU. [summary](summaries/2026-10-17-sdk-overhead.md), [report](reports/sdk-overhead-ios.html) |
| 2026-10-17 | Bridge vs ouo SDK comparison on one real-tap journey in parallel mode (3 runs, isolated `ouo-cmp`): 11 (a) gaps tracked as A1 to A11 in `project/tracker/roadmap.md`; demo wires ouo navigation and `RUMProvider`, `OUO_REPLAY` flag. [summary](summaries/2026-10-17-bridge-vs-sdk.md), [report](reports/bridge-vs-sdk.html) |
| 2026-10-17 | Runtime rollout switch `ouo.rum.mode` (OpenFeature, flagd over OFREP), `ROLLOUT.md` client guide, three cohorts verified on the simulator; #24's navigation wiring and #25's perf harness folded into the modes. [summary](summaries/2026-10-17-rum-mode-rollout.md) |
| 2026-10-18 | Self-hosted Sentry 26.10 (`sentry-sbx`, 14 GiB) as the bridge's real upstream: 49/49 envelopes byte-identical, all 200, ouo 19/21 (startup console lines without a session); Sentry MCP (user-level `sentry-sbx`, needs https → `sentry.ouo.localhost` on the ouo-env proxy); F4 unmasked replay compared with Sentry's player. [summary](summaries/2026-10-18-sentry-self-hosted.md), [report](reports/sentry-self-hosted-n2-f4.html) |
| 2026-10-23 | Batch 2: examples per path (N23) with trace-continuity `verify` (N24), mobile vitals end to end (A4), SDK range goldens 8.32.0 / 7.11.0 (N3), client setup notes (N5); all three examples 14/14 on an env, sentry-mobile also against self-hosted Sentry; PRs #43 and batch 2 PR 2; [summary](summaries/2026-10-23-b2-bridge-examples.md) |
| 2026-11-15 | Bridge + Muninn + LGTM in one collector: `config.muninn-sentry.yaml` overlay on the `--muninn` stack, real-time replay of the golden capture (`examples/tools/sentryreplay.py`), demo 58/58, back-pressure (no backend slows the SDK's answer; the rate limiter drops bridged output behind a proxy), plan for bridged replay into Muninn. [summary](summaries/2026-11-15-bridge-muninn-lgtm.md), [report](reports/bridge-muninn-lgtm.html) |

## Open

- Android: not built (no Android SDK on this Mac).
- rum-api: filter sessions and health stats by `ouo.rum.mode` (today only by service).
- Repeat the overhead measurement on a real iPhone (none available on 2026-10-17).
- Bridge: startup `log` items without a session (attach to the next session, de-duplicate with breadcrumbs). Plugin: black frame on seek. (Info `captureMessage` is a `sentry.message` since bridge spec section 6; `verify-bridge.py` follows it since 2026-11-15.)
- Bridge: replay into Muninn as `ouo-video/1` (plan in [bridge-muninn-lgtm.html](reports/bridge-muninn-lgtm.html#plan)); `X-Forwarded-For` into the client context for the rate limiter.
- Run-1 Sentry replay stopped after 41 s while the ouo replay ran; not reproduced in run 3. Rerun parallel sessions to confirm the two replays coexist.
