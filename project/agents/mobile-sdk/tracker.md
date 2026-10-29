# mobile-sdk tracker

Order and exit criteria: [roadmap.md §3 and §10](../../kb/mobile-sdk-research/roadmap.md#3-the-ordered-work-list).

| Package | Status | Notes |
|---|---|---|
| ADR-0014 replay representation, ADR-0016 OpenTelemetry in process | merged (PR #105) | unblock W3, W8, W9; `docs/specs/mobile-replay.md` rewritten for schema 2 with W3 |
| W1 production-safe iOS capture | PR open | run-loop pacer, 1:1 render, fail-closed masking, modes, spool, N52; the phone check is pending |
| W2 spec and conformance suite | PR #106 open | its own session, lane C |
| W3 wire and durability | todo | after W1; ADR-0014 merged |
| W4 signals parity | todo | |
| W5 funnels and user steps | todo | |
| W6 feedback primitive | todo | |
| W7 native symbolication | PR #107 open | its own session |
| W8 native iOS package | todo | |
| W9 Android | todo | needs JDK, Android SDK, emulator |
| W10 Flutter | todo | after W8 and W9 |
