# mobile-sdk tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-29 | ADR-0014 replay representation: tiles in `frames` schema 2, modes, schema 1 reader behaviour (unblocks W3, W9) | written, PR open |
| 2026-10-29 | ADR-0016 OpenTelemetry in process: opentelemetry-android, dependency-free Swift package, swift-core fallback (unblocks W8, W9) | written, PR open |
| open | `docs/specs/mobile-replay.md` rewritten for schema 2 | with W3 |
| 2026-10-29 | W7 native crash symbolication (iOS): ADR-0011 section 7, `ouo-sourcemaps upload-dsym`, rum-api `PUT /v1/dsyms` and symbolication on read, plugin native frames, `docs/symbolication.md` | built and verified on `ouo-env w7-symbolication`, PR #107 |
| open | W7 follow-ups: Swift demangling of names, dSYM upload through the collector (with N41), Android R8 / ProGuard (W9) | later |
| open | Symbolicator cache: one load per key in flight (concurrent cold reads of one dSYM or map parse it once), and a peak-memory note for dSYMs near `limits.max_dsym_bytes` (PR #107 review item 7) | later |
