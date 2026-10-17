# sdk-react-native tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-07 | `@ouo/react-native` SDK: session manager (spec mobile rules, cases 1, 2, 3, 5, 6, 7), AppState, ErrorUtils fatal + crash marker, fetch wrapper with traceparent/baggage, OTLP HTTP logs + traces, shims, RUMProvider | done, 36 tests |
| 2026-10-07 | `examples/mobile` Expo app (Products / Product / Cart / Checkout / Order / Chaos), `file:` link + Metro config, README | done, iOS .hbc export builds |
| 2026-10-07 | Expo web gotcha: timers bypass `ErrorUtils`; window listeners now installed alongside | fixed, tested |
| 2026-10-07 | End-to-end against the real collector: rum-api statuses per version, Tempo traces with demo-backend spans | verified (Node playground + Expo web) |
| 2026-10-07 | iOS Simulator verification | **blocked: no Xcode installed on this machine** |
| 2026-10-07 | project/kb/otel-react-native.md | filled |
| 2026-10-10 | Phase 8a (ADR-0007): `@ouo/react-native` 0.2.0: `endpoint` = rum-api, required `projectToken` (header `X-Ouo-Project-Token` on OTLP exporters and native replay), `otlpEndpoint` escape hatch, `replayEndpoint` removed, publishable package (`exports`, `prepack`, `ios/.npmignore`, CHANGELOG), demo app on `EXPO_PUBLIC_RUM_API` / `EXPO_PUBLIC_OUO_PROJECT_TOKEN`, guide 30 and kb updated | review: 67 RN tests, ingest stub on :18082, demo tsc clean, dev client compiles; live run owed to QA ([summary](summaries/2026-10-10-phase-8a.md)) |
| 2026-10-10 | Phase 8a rev2 (ADR-0007 revised, the collector is the edge): `@ouo/react-native` 0.2.0 re-cut: `endpoint` = collector OTLP/HTTP, optional `replayEndpoint` (4318 -> 4319 default), required `projectId` + `projectToken` as `Authorization: Basic` (own base64 encoder) on both exporters and the native uploader, `otlpEndpoint` / `X-Ouo-Project-Token` gone; CHANGELOG rewritten; demo app on `EXPO_PUBLIC_OTLP_ENDPOINT` / `EXPO_PUBLIC_OUO_PROJECT_ID` / `EXPO_PUBLIC_OUO_PROJECT_TOKEN`; guide 30 and kb updated | review: 68 RN tests incl. collector stub with basicauth on :18082, demo tsc clean, dev client rebuilt and installed on the simulator; live run owed to QA ([summary](summaries/2026-10-10-phase-8a-rev2.md)) |
