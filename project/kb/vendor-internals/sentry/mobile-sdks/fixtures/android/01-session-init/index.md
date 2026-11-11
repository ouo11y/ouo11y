# sentry / mobile-sdks / fixtures / android / 01-session-init

What does the first session update look like on Android (32-hex sid, no `seq`)?

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [item-0-session.json](item-0-session.json) | Item 0: `session` item header and payload |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
