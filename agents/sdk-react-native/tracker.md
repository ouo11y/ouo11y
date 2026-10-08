# sdk-react-native tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-07 | `@ouo/react-native` SDK: session manager (spec mobile rules, cases 1, 2, 3, 5, 6, 7), AppState, ErrorUtils fatal + crash marker, fetch wrapper with traceparent/baggage, OTLP HTTP logs + traces, shims, RUMProvider | done, 36 tests |
| 2026-10-07 | `examples/mobile` Expo app (Products / Product / Cart / Checkout / Order / Chaos), `file:` link + Metro config, README | done, iOS .hbc export builds |
| 2026-10-07 | Expo web gotcha: timers bypass `ErrorUtils`; window listeners now installed alongside | fixed, tested |
| 2026-10-07 | End-to-end against the real collector: rum-api statuses per version, Tempo traces with demo-backend spans | verified (Node playground + Expo web) |
| 2026-10-07 | iOS Simulator verification | **blocked: no Xcode installed on this machine** |
| 2026-10-07 | kb/otel-react-native.md | filled |
