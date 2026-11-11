# sentry / mobile-sdks / fixtures / ios

| Path | What it is |
|---|---|
| [01-session-init/](01-session-init/index.md) | What does the first native session update look like on iOS (cocoa sdk, upper-case UUID sid, `seq` 1)? |
| [02-transaction-profile-client-report/](02-transaction-profile-client-report/index.md) | What does the first `ui.load` transaction send, with its JS `profile` and a `client_report`? |
| [03-log/](03-log/index.md) | What does a `log` item from console capture look like? |
| [04-replay-segment-0/](04-replay-segment-0/index.md) | What does replay segment 0 contain (msgpack parts, `options` event, 402x874 H.264 Main mp4)? |
| [05-error-js-handled-screenshot-viewhierarchy/](05-error-js-handled-screenshot-viewhierarchy/index.md) | How does a handled JS error travel with its screenshot, view hierarchy and session update? |
| [06-message-event/](06-message-event/index.md) | What does `captureMessage` send (level info)? |
| [07-user-report-legacy/](07-user-report-legacy/index.md) | What is a legacy `user_report` item (no `sdk` header)? |
| [08-feedback/](08-feedback/index.md) | What does a `feedback` item from `captureFeedback` look like? |
| [09-session-exited-after-background/](09-session-exited-after-background/index.md) | What is sent when the app returns after more than 30 s in the background (`exited`)? |
| [10-js-fatal-sent-before-exit/](10-js-fatal-sent-before-exit/index.md) | What does a JS fatal send on iOS (fatal event + `crashed`, before the process exits)? |
| [11-native-crash-next-launch/](11-native-crash-next-launch/index.md) | What does a native crash look like at the next launch (`EXC_BAD_ACCESS`, mechanism `mach`)? |
| [12-replay-segment-recovered-after-crash/](12-replay-segment-recovered-after-crash/index.md) | Which segment of the crashed replay is sent at the next launch (cocoa sdk name)? |
| [13-replay-segment-default-masking/](13-replay-segment-default-masking/index.md) | What does a segment with Sentry's default masking look like and weigh? |
