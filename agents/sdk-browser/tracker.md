# sdk-browser tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-06 | Phase 2: `sdk/browser` package (init API, session manager, correlation, propagation, errors, network, vitals, navigation, replay) | done |
| 2026-10-06 | Unit tests (45) incl. spec cases 1, 2, 3, 4, 7 and jsdom integration against OTLP payloads | done |
| 2026-10-06 | Real browser verification against Tempo, Loki and a replay stub | done (see summaries/2026-10-06-phase-2.md) |
| 2026-10-06 | kb/otel-browser-sdk.md, kb/rrweb-chunking.md | done |
| 2026-10-08 | QA phase 6 bug 1: duplicate `session.start` on rotation (atomic `rotate()`, ensure-free log processor, `test/rotation.test.ts` in browser and react-native; live re-check against rum-api and Loki) | done (see summaries/2026-10-08-bugfix.md) |
| open | FCP/LCP/CLS/INP observed in a foreground browser (automation tabs load hidden) | QA phase |
| open | Multi-tab replay interleaving | post-MVP |
