# sentry / mobile-sdks / fixtures / android / 03-transaction-profile-client-report

What does the Android `profile` (`sampled_profile` + `js_profile`) look like next to its transaction?

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [item-0-transaction.json](item-0-transaction.json) | Item 0: `transaction` item header and payload |
| [item-1-client_report.json](item-1-client_report.json) | Item 1: `client_report` item header and payload |
| [item-2-profile.json](item-2-profile.json) | Item 2: `profile` item header and payload |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
