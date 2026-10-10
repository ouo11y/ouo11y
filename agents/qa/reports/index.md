# qa reports

| File | What |
|---|---|
| [phase-6-bugs.html](phase-6-bugs.html) | bugs and observations found during Phase 6 with reproduction steps |
| [e2e-last-run.json](e2e-last-run.json) | full output of the last passing `deploy/scripts/e2e.sh --out` run (run `muymf83c`) |
| [phase-8a-bugs.html](phase-8a-bugs.html) | Phase 8a findings (2 minor, 4 observations) with reproduction steps |
| [e2e-phase-8a-run.json](e2e-phase-8a-run.json) | full `--out` of the passing Phase 8a e2e run `mv2kfrpc` (gateway checks, matrix, project stamping) |
| [rate-limit.mjs](rate-limit.mjs), `rate-limit-run.txt`, `ingest-counters-after-ratelimit.txt`, `ingest-counters-final.txt` | 400-request burst script (`node agents/qa/reports/rate-limit.mjs`), its output and Mimir `ouo_ingest_requests` snapshots |
| `8a-web-session-detail.txt`, `8a-unload-keepalive.txt`, `8a-mobile-session-detail.txt` | rum-api answers for the real web and iOS sessions (read token) |
| `8a-web-order.jpg`, `8a-web-chaos.jpg`, `8a-plugin-overview.jpg`, `8a-plugin-sessions.jpg`, `8a-plugin-session-detail.jpg`, `8a-plugin-replay-playing.jpg`, `8a-plugin-401-banner.jpg`, `8a-plugin-test-connection-401.jpg`, `8a-plugin-test-connection-ok.jpg`, `8a-ios-order.jpg`, `8a-ios-chaos.jpg`, `8a-ios-fatal.jpg`, `8a-plugin-mobile-session-frames.jpg` | Phase 8a screenshots referenced by `reports/phase-8a-verification.html` |
| `plugin-overview.jpg`, `plugin-sessions.jpg`, `plugin-session-detail.jpg`, `plugin-replay-masked.jpg`, `plugin-replay-deleted.jpg`, `grafana-explore-trace.jpg`, `web-checkout-live.jpg`, `mobile-expo-web-chaos.jpg` | walk-through screenshots referenced by `reports/mvp-verification.html` |
