# sdk-browser tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-06 | Phase 2: `sdk/browser` package (init API, session manager, correlation, propagation, errors, network, vitals, navigation, replay) | done |
| 2026-10-06 | Unit tests (45) incl. spec cases 1, 2, 3, 4, 7 and jsdom integration against OTLP payloads | done |
| 2026-10-06 | Real browser verification against Tempo, Loki and a replay stub | done (see summaries/2026-10-06-phase-2.md) |
| 2026-10-06 | kb/otel-browser-sdk.md, kb/rrweb-chunking.md | done |
| 2026-10-08 | QA phase 6 bug 1: duplicate `session.start` on rotation (atomic `rotate()`, ensure-free log processor, `test/rotation.test.ts` in browser and react-native; live re-check against rum-api and Loki) | done (see summaries/2026-10-08-bugfix.md) |
| 2026-10-10 | Phase 8a: ADR-0007 section 7 in `@ouo/browser` 0.2.0 (`endpoint` = rum-api, `projectToken` required, `replayEndpoint` removed, `otlpEndpoint` escape hatch, `X-Ouo-Project-Token` on OTLP exporters and replay uploads, CHANGELOG + publishable package metadata, demo app env `VITE_RUM_API` / `VITE_OUO_PROJECT_TOKEN`, guide and kb updates; 57 tests incl. real-socket stub on :18081) | superseded the same day by revision 2 (see summaries/2026-10-10-phase-8a.md) |
| 2026-10-10 | Phase 8a revision 2: ADR-0007 section 6 in `@ouo/browser` 0.2.0 (`endpoint` = collector OTLP/HTTP base, `replayEndpoint?` derived 4318 -> 4319, `projectId` + `projectToken` required, `Authorization: Basic` on OTLP exporters and replay uploads incl. keepalive, `otlpEndpoint` and `X-Ouo-Project-Token` removed, CHANGELOG rewritten, demo app env `VITE_OTLP_ENDPOINT` / `VITE_OUO_PROJECT_ID` / `VITE_OUO_PROJECT_TOKEN`, guide and kb updates; 61 tests incl. two-port real-socket collector stub on :18081/:18082) | done, live check pending qa (see summaries/2026-10-10-phase-8a-rev2.md) |
| open | FCP/LCP/CLS/INP observed in a foreground browser (automation tabs load hidden) | QA phase |
| open | Multi-tab replay interleaving | post-MVP |
