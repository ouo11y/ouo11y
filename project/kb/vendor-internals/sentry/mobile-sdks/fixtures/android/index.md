# sentry / mobile-sdks / fixtures / android

| Path | What it is |
|---|---|
| [01-session-init/](01-session-init/index.md) | What does the first session update look like on Android (32-hex sid, no `seq`)? |
| [02-session-exited-1s-after-start/](02-session-exited-1s-after-start/index.md) | Why is there an `exited` update for the same sid 1.2 s after start? (observed, cause not confirmed) |
| [03-transaction-profile-client-report/](03-transaction-profile-client-report/index.md) | What does the Android `profile` (`sampled_profile` + `js_profile`) look like next to its transaction? |
| [04-log/](04-log/index.md) | What does a `log` item look like on Android? |
| [05-replay-segment-0/](05-replay-segment-0/index.md) | What does Android replay segment 0 contain (416x912 H.264 Baseline, masked class list in `options`)? |
| [06-replay-segment-1-touches/](06-replay-segment-1-touches/index.md) | How are real taps recorded (rrweb touch events)? |
| [07-session-exited-on-handled-error/](07-session-exited-on-handled-error/index.md) | Why does a handled JS error end the Android health session (`exited`)? |
| [08-session-init-after-handled-error/](08-session-init-after-handled-error/index.md) | Which new session is started right after it? |
| [09-error-js-handled-screenshot-viewhierarchy/](09-error-js-handled-screenshot-viewhierarchy/index.md) | How does a handled JS error travel on Android (masked screenshot, view hierarchy, old sid `ok`)? |
| [10-user-report-legacy/](10-user-report-legacy/index.md) | What is the legacy `user_report` on Android? |
| [11-feedback/](11-feedback/index.md) | What is the `feedback` item on Android? |
| [12-js-fatal-stored-sent-next-launch/](12-js-fatal-stored-sent-next-launch/index.md) | When is a JS fatal sent on Android (stored, next launch)? |
| [13-native-jvm-crash-sent-at-crash/](13-native-jvm-crash-sent-at-crash/index.md) | What does a JVM crash send from the dying process (event, session, attachments, client report)? |
| [14-replay-segment-flushed-at-crash/](14-replay-segment-flushed-at-crash/index.md) | Which 7 s replay segment is flushed at the crash? |
| [15-replay-segment-default-masking/](15-replay-segment-default-masking/index.md) | What does an Android segment with default masking look like and weigh? |
