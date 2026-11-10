# 2026-11-10: sentry-mobile (Step 6 vendor research)

Agent `sentry-mobile`. Sentry's iOS, Android and React Native SDKs: internals, every option, reliability, the wire bytes, and mobile replay evidence.

## What was done

- **Pinned SDKs.** Latest stable on 2026-11-10: sentry-cocoa 9.33.0, sentry-java 8.63.0, @sentry/react-native 8.34.0 (bundles cocoa 9.33.0 and android 8.62.0). Their sources were cloned at the tags.
- **Nine source-read entries** in `project/kb/vendor-internals/sentry/mobile-sdks/{ios,android,react-native}/{architecture,configuration,reliability}.md`. Three research sub-agents drafted them, one per platform; I reviewed and placed them.
- **Captures.**
  - Two Release builds of `examples/sentry-mobile` (iOS 27 simulator `step6-sentry-mobile`, Android API 35 emulator AVD `step6-sentry-mobile` on port 5580).
  - `sentrytap` sat in front of self-hosted Sentry: 4530 for iOS → project 5, 4531 for Android → project 7.
  - Six runs: a full journey per platform, and 2-minute replay journeys per platform, unmasked and with default masking. 468 requests in all.
  - Sentry stored all events and all 11 replays.
- **Write-ups.** `wire-capture.md`, `replay-mobile.md`, redacted `fixtures/` (28 request folders and the replay stats JSON), `mobile-sdks-explainer.html` (three inline SVG diagrams), and `index.md`.
- **Demo additions** in `examples/sentry-mobile`, all behind flags, with defaults unchanged:
  - Android build: `android` block, `plugins/withAndroidCleartext.js`, `scripts/build-android.sh`.
  - `SENTRY_CAPTURE_ALL=1` and `SENTRY_REPLAY_MASK=default`.
  - Scripts: `scripts/android-journey.py`, `scripts/replay-journey.sh`, `scripts/extract.py`, `scripts/mp4info.py`.
  - `build-ios.sh` now calls `./node_modules/.bin/expo` instead of `npx expo` (npx failed from a worktree).
  - Everything is documented in the README.
- **Hand-over for other agents:** `step6-sentry-mobile-captures.md` in the shared notes, with replay, event and trace ids and the raw capture paths.

## Dependency change (justification)

The captures used `@sentry/react-native` 8.34.0 and `@sentry/core` 10.78.0, the latest stable versions, installed locally. They bundle sentry-cocoa 9.33.0 and sentry-android 8.62.0. The coordinator kept the committed pin in `examples/sentry-mobile/package.json` at 8.32.0, because the bridge journey in CI runs on it. No new package.

## Verified, and how

- `tsc --noEmit` passes for the demo. The Python and shell scripts pass syntax checks.
- iOS and Android builds succeeded, and the journeys ran (logs in the scratchpad). Replays and events were confirmed in Sentry through the API.
- Source citations were spot-checked: 26 random links out of the 1,724 GitHub line links were checked against the cloned source. All 26 support the claim; 3 anchors start a few lines before the statement. The sub-agents also checked by script that every linked file exists and every anchor is within the file.
- `lychee --offline` passes on the new md and html files. No DSN key, token or e-mail is in the committed files.

## Top findings

1. **Android React Native rotates release-health sessions on every captured JS error.** Every handled error, message and rejection gives `exited` plus a new `init` (`InternalSentrySdk.captureEnvelope`), while the replay id stays. iOS keeps one session.
2. **Mobile replay bytes (2-minute scripted journey, medium quality).**
   - iOS: 415 KB/min unmasked, 165 KB/min with default masking.
   - Android: 421 KB/min unmasked, 212 KB/min masked.
   - Video: 1 fps, 5 s segments, H.264. iOS uses Main profile at 402x874 points; Android uses Baseline at 416x912 dp.
   - The iOS average bit rate (55 kbps) is above its 40 kbps target.
3. **Fatal timing differs by platform and kind.**
   - iOS native crash: sent at the next launch.
   - iOS JS fatal: sent before exit (the source suggests store-to-disk).
   - Android JVM crash: sent from the dying process, plus a last 7 s replay segment.
   - Android JS fatal: stored and sent at the next launch.
4. **Both native SDKs delete an envelope on any HTTP 4xx or 5xx** and keep it only on network failure. There is no timed backoff, and the cache holds 30 envelopes (source). Replay pauses while offline or rate-limited, which leaves gaps rather than a backlog.
5. **JS sends everything through native as base64.** The JS `beforeSend` never sees native events, and JS never sees rate limits (source).
6. **On iOS, `profilesSampleRate: 1` dominates the bytes.** Each Hermes `profile` item is about 470 KB raw and 50 to 70 KB gzipped; envelopes with a transaction and its profile were 53 % of the iOS full-journey wire bytes (1.44 of 2.73 MB).

## Not verified / open

- Binary size added by Sentry: no official per-SDK number was found.
  - Android APK: Sentry's native libraries are 0.96 MB uncompressed (arm64).
  - iOS: Sentry is linked into the main binary and cannot be isolated cheaply.
  - Step 5 has the RN JS bundle number (109 KiB gzip).
- Offline, retry and rate-limit behaviour, read from source only. The disk-cache rotation was not reproduced.
- Android: double `init` and an `exited` 1.2 s after start for the same sid. Cause not confirmed.
- Android: the relaunch right after the JVM crash sent nothing within 15 s. Cause not confirmed; a crash dialog is likely.
- `enableCaptureFailedRequests: true` produced no failed-request events for the 500 responses. Cause not confirmed.
- No iOS UIKit touches in the iOS runs: the mailbox driver sends none. Touch format on iOS is from the archive capture.
- `profile_chunk` (UI profiling), NDK native crash, ANR and app hang were not exercised.
- Native-only iOS and Android apps were not captured; only React Native.

## Next agent must know

- Simulator and AVD were deleted, and the emulator, sentrytap and the demo backend were stopped (own PIDs only).
- Generated `examples/sentry-mobile/ios/` and `android/` are gitignored build outputs.
- Raw captures (with keys) live only in this session's scratchpad: `.../scratchpad/sentry-mobile/caps/`.
