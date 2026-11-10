# Sentry mobile SDK fixtures (captured 2026-11-10)

These are real requests from `examples/sentry-mobile`: @sentry/react-native 8.34.0 with sentry-cocoa 9.33.0 on the iOS 27 simulator, and with sentry-android 8.62.0 on the API 35 emulator. They were recorded by `sentrytap` and decoded by `examples/sentry-mobile/scripts/extract.py`. How they were made, and what they show: [../wire-capture.md](../wire-capture.md) and [../replay-mobile.md](../replay-mobile.md).

Each folder is one HTTP request:
- `request.json`: method, path, headers and Sentry's response. The `sentry_key` is redacted.
- `envelope-header.json`.
- One `item-<i>-<type>.json` per item: item header plus payload.
- Replay segments instead have `replay_event.json`, `replay_recording.json` (segment header plus rrweb events), `replay_video.mp4` and `mp4info.json`.

Redactions:
- DSN public keys became `<redacted>`.
- The demo feedback e-mail became `<redacted>`.
- Profiles were trimmed: every list with more than 8 entries keeps the first 5 and gains a `<key>__truncated_from` count.
- Two iOS folders dropped duplicate attachments; their `ATTACHMENTS.txt` says so.
- Simulator and emulator ids (`did`, `device_app_hash`) are not personal and were kept.

| Path | What it is |
|---|---|
| [replay-2min-stats.json](replay-2min-stats.json) | Per-replay byte counts of the four 2-minute replay runs (iOS and Android, unmasked and default masking) |
| [ios/01-session-init](ios/01-session-init/) | What does the first native session update look like on iOS (cocoa sdk, upper-case UUID sid, `seq` 1)? |
| [ios/02-transaction-profile-client-report](ios/02-transaction-profile-client-report/) | What does the first `ui.load` transaction send, with its JS `profile` and a `client_report`? |
| [ios/03-log](ios/03-log/) | What does a `log` item from console capture look like? |
| [ios/04-replay-segment-0](ios/04-replay-segment-0/) | What does replay segment 0 contain (msgpack parts, `options` event, 402x874 H.264 Main mp4)? |
| [ios/05-error-js-handled-screenshot-viewhierarchy](ios/05-error-js-handled-screenshot-viewhierarchy/) | How does a handled JS error travel with its screenshot, view hierarchy and session update? |
| [ios/06-message-event](ios/06-message-event/) | What does `captureMessage` send (level info)? |
| [ios/07-user-report-legacy](ios/07-user-report-legacy/) | What is a legacy `user_report` item (no `sdk` header)? |
| [ios/08-feedback](ios/08-feedback/) | What does a `feedback` item from `captureFeedback` look like? |
| [ios/09-session-exited-after-background](ios/09-session-exited-after-background/) | What is sent when the app returns after more than 30 s in the background (`exited`)? |
| [ios/10-js-fatal-sent-before-exit](ios/10-js-fatal-sent-before-exit/) | What does a JS fatal send on iOS (fatal event + `crashed`, before the process exits)? |
| [ios/11-native-crash-next-launch](ios/11-native-crash-next-launch/) | What does a native crash look like at the next launch (`EXC_BAD_ACCESS`, mechanism `mach`)? |
| [ios/12-replay-segment-recovered-after-crash](ios/12-replay-segment-recovered-after-crash/) | Which segment of the crashed replay is sent at the next launch (cocoa sdk name)? |
| [ios/13-replay-segment-default-masking](ios/13-replay-segment-default-masking/) | What does a segment with Sentry's default masking look like and weigh? |
| [android/01-session-init](android/01-session-init/) | What does the first session update look like on Android (32-hex sid, no `seq`)? |
| [android/02-session-exited-1s-after-start](android/02-session-exited-1s-after-start/) | Why is there an `exited` update for the same sid 1.2 s after start? (observed, cause not confirmed) |
| [android/03-transaction-profile-client-report](android/03-transaction-profile-client-report/) | What does the Android `profile` (`sampled_profile` + `js_profile`) look like next to its transaction? |
| [android/04-log](android/04-log/) | What does a `log` item look like on Android? |
| [android/05-replay-segment-0](android/05-replay-segment-0/) | What does Android replay segment 0 contain (416x912 H.264 Baseline, masked class list in `options`)? |
| [android/06-replay-segment-1-touches](android/06-replay-segment-1-touches/) | How are real taps recorded (rrweb touch events)? |
| [android/07-session-exited-on-handled-error](android/07-session-exited-on-handled-error/) | Why does a handled JS error end the Android health session (`exited`)? |
| [android/08-session-init-after-handled-error](android/08-session-init-after-handled-error/) | Which new session is started right after it? |
| [android/09-error-js-handled-screenshot-viewhierarchy](android/09-error-js-handled-screenshot-viewhierarchy/) | How does a handled JS error travel on Android (masked screenshot, view hierarchy, old sid `ok`)? |
| [android/10-user-report-legacy](android/10-user-report-legacy/) | What is the legacy `user_report` on Android? |
| [android/11-feedback](android/11-feedback/) | What is the `feedback` item on Android? |
| [android/12-js-fatal-stored-sent-next-launch](android/12-js-fatal-stored-sent-next-launch/) | When is a JS fatal sent on Android (stored, next launch)? |
| [android/13-native-jvm-crash-sent-at-crash](android/13-native-jvm-crash-sent-at-crash/) | What does a JVM crash send from the dying process (event, session, attachments, client report)? |
| [android/14-replay-segment-flushed-at-crash](android/14-replay-segment-flushed-at-crash/) | Which 7 s replay segment is flushed at the crash? |
| [android/15-replay-segment-default-masking](android/15-replay-segment-default-masking/) | What does an Android segment with default masking look like and weigh? |
