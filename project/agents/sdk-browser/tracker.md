# sdk-browser tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-06 | Phase 2: `sdk/browser` package (init API, session manager, correlation, propagation, errors, network, vitals, navigation, replay) | done |
| 2026-10-06 | Unit tests (45) incl. spec cases 1, 2, 3, 4, 7 and jsdom integration against OTLP payloads | done |
| 2026-10-06 | Real browser verification against Tempo, Loki and a replay stub | done (see summaries/2026-10-06-phase-2.md) |
| 2026-10-06 | project/kb/otel-browser-sdk.md, project/kb/rrweb-chunking.md | done |
| 2026-10-08 | QA phase 6 bug 1: duplicate `session.start` on rotation (atomic `rotate()`, ensure-free log processor, `test/rotation.test.ts` in browser and react-native; live re-check against rum-api and Loki) | done (see summaries/2026-10-08-bugfix.md) |
| 2026-10-10 | Phase 8a: ADR-0007 section 7 in `@ouo11y/browser` 0.2.0 (`endpoint` = rum-api, `projectToken` required, `replayEndpoint` removed, `otlpEndpoint` escape hatch, `X-Ouo-Project-Token` on OTLP exporters and replay uploads, CHANGELOG + publishable package metadata, demo app env `VITE_RUM_API` / `VITE_OUO_PROJECT_TOKEN`, guide and kb updates; 57 tests incl. real-socket stub on :18081) | superseded the same day by revision 2 (see summaries/2026-10-10-phase-8a.md) |
| 2026-10-10 | Phase 8a revision 2: ADR-0007 section 6 in `@ouo11y/browser` 0.2.0 (`endpoint` = collector OTLP/HTTP base, `replayEndpoint?` derived 4318 -> 4319, `projectId` + `projectToken` required, `Authorization: Basic` on OTLP exporters and replay uploads incl. keepalive, `otlpEndpoint` and `X-Ouo-Project-Token` removed, CHANGELOG rewritten, demo app env `VITE_OTLP_ENDPOINT` / `VITE_OUO_PROJECT_ID` / `VITE_OUO_PROJECT_TOKEN`, guide and kb updates; 61 tests incl. two-port real-socket collector stub on :18081/:18082) | done, merged in #14; live run by qa 2026-10-13 (`project/reports/phase-8a-verification.html`) (N1 2026-10-17) |
| 2026-10-23 | FCP/LCP/CLS/INP observed in a foreground browser (root causes: hidden automation tabs, OTel batch processors skipping the hide flush, web-vitals INP at hide) | done, checklist N10 (see summaries/2026-10-23-batch3-n10-n25.md) |
| 2026-10-23 | Multi-tab replay interleaving (one recording tab, BroadcastChannel lease) | done, checklist N10 |
| 2026-10-23 | CI bundle-size budget; cross-browser Playwright matrix; interaction and soft-navigation spans; long tasks; rage / dead clicks; React subpath; meta traceparent docs; session and error-triggered replay sampling | done, checklist N25, 8b (browser) |
| 2026-10-24 | N36 part B: page safety (guards, shutdown / re-init, SSR, CSP + Trusted Types, storage), browser support and es-check, fault-injection e2e, 1 h soak, rrweb cost | done, checklist N42, N43 (see summaries/2026-10-24-n36b-safety-long-sessions.md) |
| 2026-10-24 | Session lifecycle: `user_change` rotation, `endSession`, `clearUser`, `device.id` (+ rum-api `device_id`) | done, checklist N45 (see summaries/2026-10-24-session-lifecycle.md) |
| open | Plugin looks for the new `ouo.*` events; rum-api known event names; server-side sampling override | other owners |
