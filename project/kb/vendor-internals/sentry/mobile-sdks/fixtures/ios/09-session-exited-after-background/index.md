# sentry / mobile-sdks / fixtures / ios / 09-session-exited-after-background

What is sent when the app returns after more than 30 s in the background (`exited`)?

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [item-0-session.json](item-0-session.json) | Item 0: `session` item header and payload |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
