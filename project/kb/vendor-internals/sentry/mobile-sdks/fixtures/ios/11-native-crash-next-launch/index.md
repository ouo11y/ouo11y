# sentry / mobile-sdks / fixtures / ios / 11-native-crash-next-launch

What does a native crash look like at the next launch (`EXC_BAD_ACCESS`, mechanism `mach`)?

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [item-0-event.json](item-0-event.json) | Item 0: `event` item header and payload |
| [item-1-attachment.json](item-1-attachment.json) | Item 1: `attachment` item header and payload |
| [item-2-attachment.screenshot.png](item-2-attachment.screenshot.png) | Item 2: `attachment` item header and payload (image) |
| [item-3-session.json](item-3-session.json) | Item 3: `session` item header and payload |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
