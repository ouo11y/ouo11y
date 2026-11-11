# sentry / mobile-sdks / fixtures / android / 02-session-exited-1s-after-start

Why is there an `exited` update for the same sid 1.2 s after start? (observed, cause not confirmed)

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [item-0-session.json](item-0-session.json) | Item 0: `session` item header and payload |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
