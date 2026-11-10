# sentry / mobile-sdks / fixtures / android / 13-native-jvm-crash-sent-at-crash

What does a JVM crash send from the dying process (event, session, attachments, client report)?

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [item-0-event.json](item-0-event.json) | Item 0: `event` item header and payload |
| [item-1-session.json](item-1-session.json) | Item 1: `session` item header and payload |
| [item-2-attachment.screenshot.png](item-2-attachment.screenshot.png) | Item 2: `attachment` item header and payload (image) |
| [item-3-attachment.json](item-3-attachment.json) | Item 3: `attachment` item header and payload |
| [item-4-client_report.json](item-4-client_report.json) | Item 4: `client_report` item header and payload |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
