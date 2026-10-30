# mobile-sdk tracker

Order and exit criteria: [roadmap.md §3 and §10](../../kb/mobile-sdk-research/roadmap.md#3-the-ordered-work-list).

| Package | Status | Notes |
|---|---|---|
| ADR-0014 replay representation, ADR-0016 OpenTelemetry in process | merged (PR #105) | unblock W3, W8, W9; `docs/specs/mobile-replay.md` rewritten for schema 2 with W3 |
| W1 production-safe iOS capture | merged (PR #109) | run-loop pacer, 1:1 render, fail-closed masking, modes, spool, N52; the phone check is pending |
| W2 spec and conformance suite | PR #106 open | `docs/specs/mobile-sdk.md`, ADR-0015, `tests/e2e/mobile/` ([summary](summaries/2026-10-29-w2-mobile-spec.md)); every later package turns its pending checks required: W3 (C11.1, C11.2), W4 (C3.1, C3.2, C4.2), W5 (C6.1), W6 (C10.1); suites for native iOS, Android and Flutter with W8–W10, same check ids |
| W3 wire and durability | todo | after W1; ADR-0014 merged |
| W4 signals parity | todo | |
| W5 funnels and user steps | todo | |
| W6 feedback primitive | todo | |
| W7 native symbolication | merged (PR #107) | ADR-0011 section 7, `ouo-sourcemaps upload-dsym`, rum-api `PUT /v1/dsyms` and symbolication on read, plugin native frames, `docs/symbolication.md` ([summary](summaries/2026-10-29-w7-symbolication.md)); follow-ups: Swift demangling, dSYM upload through the collector (with N41), Android R8 / ProGuard (W9), one cache load per key in flight and a peak-memory note for dSYMs near `limits.max_dsym_bytes` (PR #107 review item 7) |
| W8 native iOS package | todo | |
| W9 Android | todo | needs JDK, Android SDK, emulator |
| W10 Flutter | todo | after W8 and W9 |
