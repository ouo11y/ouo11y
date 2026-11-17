# Summaries

| File | Content |
|---|---|
| [2026-10-10-backend-stack.md](2026-10-10-backend-stack.md) | writer run for `00-stack.md` and `10-backend.md` |
| [2026-10-10-frontend.md](2026-10-10-frontend.md) | writer run for `20-frontend.md` |
| [2026-10-10-mobile.md](2026-10-10-mobile.md) | writer run for `30-mobile-ios.md` |
| [2026-10-10-orchestrator.md](2026-10-10-orchestrator.md) | review, port-default fix, verification |
| [2026-10-24-quickstart-tiny-shop-funnels.md](2026-10-24-quickstart-tiny-shop-funnels.md) | quickstart 5: funnel steps from pages and custom events, 50 generated sessions, rum-api and Grafana built from source; verified from a clean checkout (N47) |
| [2026-10-25-quickstart-tiny-shop-otel.md](2026-10-25-quickstart-tiny-shop-otel.md) | Tiny Shop without the ouo SDK: OpenTelemetry JS + rrweb + web-vitals by hand; verified against quickstart.yaml, session crashed with traces and replay, inactivity rotation (N48) |
| [2026-10-27-quickstart-tiny-shop-otel-review.md](2026-10-27-quickstart-tiny-shop-otel-review.md) | tiny-shop-otel review round 1: stack one folder per service on `latest`, relative paths, browser-instrumentation fetch, readable event lines, package table, step 8 costs |
| [2026-10-28-quickstart-tiny-shop-funnels-rules.md](2026-10-28-quickstart-tiny-shop-funnels-rules.md) | tiny-shop-funnels rules pass: released images on `latest` (no build from source), relative paths, `40-mimir` for rum-api's metrics, package tables, `@ouo11y/browser` 0.3.0; verified on shifted ports, report = hand count (N47) |
| [2026-11-15-from-scratch-series.md](2026-11-15-from-scratch-series.md) | from-scratch series: 00 stack (stock contrib Collector, Tempo, Loki, Muninn, Grafana), 01 web, 02 React Native, 03 your own Grafana plugin on `ouo-go` and `@ouo11y/kit`; embed checker fix for empty blocks; verified on shifted ports, iOS Simulator and headless Chromium |
