# sentry / mobile-sdks / fixtures / android / 09-error-js-handled-screenshot-viewhierarchy

How does a handled JS error travel on Android (masked screenshot, view hierarchy, old sid `ok`)?

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [item-0-event.json](item-0-event.json) | Item 0: `event` item header and payload |
| [item-1-attachment.json](item-1-attachment.json) | Item 1: `attachment` item header and payload |
| [item-2-attachment.screenshot.png](item-2-attachment.screenshot.png) | Item 2: `attachment` item header and payload (image) |
| [item-3-session.json](item-3-session.json) | Item 3: `session` item header and payload |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
