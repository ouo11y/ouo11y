# sentry / mobile-sdks / fixtures / ios / 02-transaction-profile-client-report

What does the first `ui.load` transaction send, with its JS `profile` and a `client_report`?

| Path | What it is |
|---|---|
| [envelope-header.json](envelope-header.json) | Envelope header line |
| [item-0-transaction.json](item-0-transaction.json) | Item 0: `transaction` item header and payload |
| [item-1-client_report.json](item-1-client_report.json) | Item 1: `client_report` item header and payload |
| [item-2-profile.json](item-2-profile.json) | Item 2: `profile` item header and payload |
| [request.json](request.json) | HTTP method, path, headers (key redacted) and Sentry's response |
