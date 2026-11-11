# Datadog capture fixtures

Real requests captured on 2026-11-10 by [examples/datadog-capture](../../../../../../examples/datadog-capture/README.md):
- Browser SDK 7.17.0 in headless Chrome.
- dd-sdk-ios 3.21.0 on an iOS 27 simulator.

**What each file holds:** one capture record: `headers`, `forwardPath`, `forwardParams` (URL query), `bodyBytes` (on the wire), and `body`.
- `body` is decoded: deflate or gzip is inflated, NDJSON or JSON arrays become `events[]`, and multipart becomes `parts[]` with the replay segment JSON inline.

**Redaction:**
- UUIDs (session, view, action, …) are replaced by stable placeholders `00000000-0000-4000-8000-0000000000NN`, so references between files still match.
- Client token, request ids, idempotency keys, user-agent details, time zone and locale are redacted.
- The application id and client token were fake to begin with.
- The two 32-hex strings left (`traceparent` / `_dd.trace_id` values) are random trace ids from the local test, not secrets.

| Path | What it shows |
|---|---|
| [browser/rum-batch-fetch.json](browser/rum-batch-fetch.json) | A 16 KiB-limited RUM batch over `fetch`: resource, action, view events, URL parameters |
| [browser/rum-batch-exit-beacon.json](browser/rum-batch-exit-beacon.json) | The page-exit batch over `sendBeacon` (`_dd.api=beacon`), with an ended and an active view |
| [browser/rum-batch-deflate.json](browser/rum-batch-deflate.json) | `compressIntakeRequests`: `dd-evp-encoding=deflate`, 5 702 B wire vs 51 941 B raw (events cut to 4) |
| [browser/rum-batch-view-update.json](browser/rum-batch-view-update.json) | A `view_update` partial event next to errors, vitals and actions |
| [browser/rum-telemetry.json](browser/rum-telemetry.json) | SDK telemetry `usage` events on the RUM track (cut to 3) |
| [browser/logs-batch.json](browser/logs-batch.json) | Logs SDK batch: network, source, console and logger origins |
| [browser/replay-segment-first.json](browser/replay-segment-first.json) | First replay segment: Meta, Focus, Change-format full snapshot, mouse records, Change records |
| [browser/replay-segment-next.json](browser/replay-segment-next.json) | A following segment: DOM mutations and masked `InputValue` changes (`"***"`) |
| [browser/replay-segment-first-privacy-mask.json](browser/replay-segment-first-privacy-mask.json) | Same page with `defaultPrivacyLevel: 'mask'`: all text as `x` runs |
| [browser/backend-request-trace-headers.json](browser/backend-request-trace-headers.json) | Headers our backend received: `traceparent`, `tracestate`, `x-datadog-*`, `baggage` |
| [ios/rum-batch.json](ios/rum-batch.json) | iOS RUM batch: deflate body, `DD-*` headers, view, view_update, app_launch vital, native resource |
| [ios/logs-batch.json](ios/logs-batch.json) | iOS logs: JSON array body |
| [ios/replay-full-snapshot.json](ios/replay-full-snapshot.json) | Mobile wireframes: Meta, Focus, full snapshot (type 10) with shape, text and placeholder wireframes, masked |
| [ios/replay-incremental-mutation.json](ios/replay-incremental-mutation.json) | Incremental record (type 11, source 0) updating one text wireframe |
| [ios/replay-two-segments.json](ios/replay-two-segments.json) | One request carrying two segments (`file0`, `file1`) and an `event` metadata array |
