# 2026-10-29 mobile SDK research: Sentry, PostHog, Luciq and the field

## What was done

- Created `project/kb/mobile-sdk-research/` with a shared ten-section appendix template (`index.md`) and started eight Opus 5.5 sub sessions in this worktree, one appendix each: A sentry-cocoa, B sentry-java, C Sentry React Native + Flutter, D PostHog iOS + Android, E PostHog React Native + Flutter, F Luciq, G open-source landscape + OpenTelemetry on mobile, H closed vendors + 24-vendor feature matrix. Each session cloned the upstream repos (blobless, with history) into its own scratchpad, read the code, and cited every claim as `repo/path:line @ sha`, with `[docs only]` / `[blog only]` / `[binary headers]` labels for anything not read in code.
- Wrote `comparison.md`: one-page answers to the brief's questions, technique matrix per vendor and platform, the exact replay pipelines step by step, reconstruction and players, a wire-size table (measured plus derived), performance claims with their measurement methods, both Sentry blogs grounded in commits, RUM signal matrix, OTel matrix, condensed feature matrix, the six-target language matrix, open-source status, 13 recommendations for ouo and the limits of the research.
- Wrote the HTML report `reports/mobile-sdk-research.html` (self-contained: answer cards, coloured technique matrix, four pipelines, a log-scale wire-size bar chart with provenance colours and a table view, footprint table, blog grounding, OTel and feature matrices, recommendations).
- Updated `project/kb/index.md`, `project/agents/index.md`, `project/kb/competitors.md` (pointer), this agent's `index.md` and `tracker.md`.

## What was verified and how

- The orchestrator spot-checked the key constants in the sessions' clones before writing the synthesis: sentry-cocoa `SentryReplayOptions` (1 fps, 5 s segments, 30 s buffer, 60 min, 20/40/60 kbit/s), `SentryOnDemandReplay` (keyframe interval 6, no frame reordering), sentry-java `SentryReplayQuality` (50/75/100 kbit/s, JPEG 10/30/50), `SimpleVideoEncoder` (`KEY_I_FRAME_INTERVAL`), `WindowRecorder.postDelayed(1000 / frameRate)`, the dead `isObscured`, the four startup commits (`5dc72eec5`, `29f120b09`, `bcd3e76a8`, `1e904b2bb`), the macrobenchmark module; posthog-ios `screenshotMode = false`, `throttleDelay = 1`, WebP q0.3, `isNotFlutter`, the SwiftUI early return; posthog-android `screenshot = false`, `throttleDelayMs = 1000`, WebP q30, `isNativeSdk`, API 26 gate; sentry-react-native `RNSentryReplay.mm` class list and `cachedReplayId`; sentry-dart raw RGBA capture and unused `hasSameImageAs`; posthog-flutter PNG capture and `_screenshotScale`; LaunchDarkly `tileEventNode`; Datadog `ScreenChangeScheduler(minimumInterval: 0.1)` and no `otlp` in `DatadogTrace`. All matched.
- Re-aggregated the measured wire sizes from the decoder output over the 77 real `replay_video` segments in `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/`: 109.9 / 107.9 KiB per minute masked (journey, touch), 363.9 / 361.1 KiB per minute unmasked (shop, realtap), median segment 9.6 KB masked and 34–36 KB unmasked, `replay_event` ≈ 1.7 KB. Same figures as Appendix A §7.3.
- Rendered the HTML report in the in-app browser and checked the answer cards, the technique matrix and the chart (16 bars, table view) by screenshot.
- Corrected one summary error found while cross-reading: Appendix G's cross-vendor table had PostHog as "screenshot" on iOS; Appendix D shows wireframe is the default on both platforms. Fixed in G.

## Key findings (the five that matter most for ouo)

1. Sentry's H.264 pipeline costs about 110 KiB per minute with masking on real traffic, 5–20× less than ADR-0006's JPEG frames while the screen changes; LaunchDarkly's open tile-diff-as-rrweb design is cheaper still and plays in the rrweb player ouo already ships. ADR-0006 should be revised before the Android SDK.
2. Every vendor, including wireframe-first PostHog, Datadog and Fullstory, falls back to screenshots for SwiftUI, Compose, React Native and Flutter. React Native always wraps the native SDK; Flutter always needs Dart-side capture.
3. No mobile SDK of Sentry, PostHog or Luciq exports OTLP; PostHog's only OTel touch point is logs. Nobody in the field sends replay over OTel, and only Embrace and the OTel distributions export RUM to a user's collector. That slot is empty.
4. The iOS view renderer V2 blog's numbers came from a timing patch that was never committed; the Android startup blog is backed by an in-repo macrobenchmark with a `SentryAndroid.init` trace section. Sentry deleted its CPU/frame and startup benchmark gates in 2026; no vendor gates replay overhead in CI.
5. Sentry has no funnel product; PostHog, Luciq, Datadog and the analytics vendors do. Luciq's retroactive funnels with drop-offs linked to replays, its human-readable user steps and its next-launch keep/drop hook are the ideas worth borrowing.

## Layout move and overlap found at PR time

- The worktree was cut from the pre-move history (before ADR-0010), so the first commit put the files under `kb/` and `agents/`; `origin/main` had moved to `project/kb/` and `project/agents/` and the PR showed as conflicting. The branch was rebuilt on `origin/main` with the files under `project/`, prose paths rewritten with the `project/` prefix, and the app's sync tool could not be used because the repository's pinned origin changed when the repo moved (re-pin under Help → Troubleshooting).
- Main already had `sentry-ios-replay-internals.md`, `sdk-overhead-ios.md`, `ios-vitals.md`, `ios-native-crashes.md` and `docs/benchmarks.md`, none visible to the sub sessions. Appendix A agrees with the internals entry on every shared point; the comparison and the folder index now cross-reference them, and recommendation 11 was rewritten around the existing B3 harness instead of proposing a new one.

## What is left

- The recommendations in `comparison.md` §12 (tile-diff replay as rrweb, change-driven cadence with a budget, fail-closed masking, OTel semconv sessions, overhead harness) need an ADR revision and a roadmap entry before implementation.
- Not verified: sentry-android `maskAllText` coverage of React Native's newer Android text views; Amplitude's and Dynatrace's exact capture technique; Luciq's native internals (closed).
- All vendor figures other than Sentry iOS are derived from code or docs, not measured on a device.

## For the next agent

- Read `comparison.md` first; go to the appendix only for citations. Each appendix's §9 lists the questions it answered.
- The sub sessions' clones live in their scratchpads under `/private/tmp/claude-501/-Users-ziadhassanin-Desktop-personal-ouo--claude-worktrees-mobile-sdk-research-bf838b/<session>/scratchpad/` until the machine cleans them; re-clone at the commits listed in each appendix's §1 for anything new.
- The golden-capture decoder (`replay_sizes.py`, msgpack + mp4 box parser) is in the sentry-ios session's scratchpad `scripts/`; copy it into the repo if the measurement needs to be repeated.
