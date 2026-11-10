# datadog / wire-format / fixtures / browser

| Path | What it is |
|---|---|
| [backend-request-trace-headers.json](backend-request-trace-headers.json) | Headers our backend received: `traceparent`, `tracestate`, `x-datadog-*`, `baggage` |
| [logs-batch.json](logs-batch.json) | Logs SDK batch: network, source, console and logger origins |
| [replay-segment-first-privacy-mask.json](replay-segment-first-privacy-mask.json) | Same page with `defaultPrivacyLevel: 'mask'`: all text as `x` runs |
| [replay-segment-first.json](replay-segment-first.json) | First replay segment: Meta, Focus, Change-format full snapshot, mouse records, Change records |
| [replay-segment-next.json](replay-segment-next.json) | A following segment: DOM mutations and masked `InputValue` changes (`"***"`) |
| [rum-batch-deflate.json](rum-batch-deflate.json) | `compressIntakeRequests`: `dd-evp-encoding=deflate`, 5 702 B wire vs 51 941 B raw (events cut to 4) |
| [rum-batch-exit-beacon.json](rum-batch-exit-beacon.json) | The page-exit batch over `sendBeacon` (`_dd.api=beacon`), with an ended and an active view |
| [rum-batch-fetch.json](rum-batch-fetch.json) | A 16 KiB-limited RUM batch over `fetch`: resource, action, view events, URL parameters |
| [rum-batch-view-update.json](rum-batch-view-update.json) | A `view_update` partial event next to errors, vitals and actions |
| [rum-telemetry.json](rum-telemetry.json) | SDK telemetry `usage` events on the RUM track (cut to 3) |
