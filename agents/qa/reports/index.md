# qa reports

| File | What |
|---|---|
| [phase-6-bugs.html](phase-6-bugs.html) | bugs and observations found during Phase 6 with reproduction steps |
| [e2e-last-run.json](e2e-last-run.json) | full output of the last passing `deploy/scripts/e2e.sh --out` run (run `muymf83c`) |
| [phase-8a-bugs.html](phase-8a-bugs.html) | Phase 8a findings with reproduction steps: revision 2 (R2-1 to R2-4, collector edge) and revision 1 (2 minor, 4 observations) |
| [e2e-phase-8a-run.json](e2e-phase-8a-run.json) | revision 1 (superseded): `--out` of e2e run `mv2kfrpc` through the rum-api gateway |
| [e2e-phase-8a-rev2-run.json](e2e-phase-8a-rev2-run.json) | full `--out` of the passing revision 2 e2e run `mv6swsxe` (edge / sink / read checks, matrix, project stamping, replay via the collector) |
| [rate-limit.mjs](rate-limit.mjs), `rate-limit-run.txt` | revision 2: 400-request burst against the collector (`OUO_OTLP_URL=http://localhost:4330 node agents/qa/reports/rate-limit.mjs`) and its output (307 x 200, 93 x 429) |
| `8a-rev2-collector-metrics.txt` | Mimir snapshot of the collector self-metrics after the burst (`ouo_ratelimit_rejected_total`, `ouo_replay_chunks_total`, `otelcol_receiver_*`) |
| `8a-rev2-web-network.txt`, `8a-rev2-unload-keepalive.txt`, `8a-rev2-ios-session.txt` | revision 2 evidence: web network log and headers, unload keepalive chunk, iOS Metro / native logs and rum-api answers |
| `8a-rev2-web-order.jpg`, `8a-rev2-web-chaos.jpg`, `8a-rev2-plugin-overview.jpg`, `8a-rev2-plugin-sessions.jpg`, `8a-rev2-plugin-session-detail.jpg`, `8a-rev2-plugin-replay-playing.jpg`, `8a-rev2-plugin-401-banner.jpg`, `8a-rev2-ios-order.jpg`, `8a-rev2-ios-chaos.jpg`, `8a-rev2-plugin-mobile-frames.jpg` | revision 2 screenshots referenced by `reports/phase-8a-verification.html` |
| `ingest-counters-after-ratelimit.txt`, `ingest-counters-final.txt` | revision 1 (rum-api gateway, superseded): Mimir `ouo_ingest_requests` snapshots |
| `8a-web-session-detail.txt`, `8a-unload-keepalive.txt`, `8a-mobile-session-detail.txt` | rum-api answers for the real web and iOS sessions (read token) |
| `8a-web-order.jpg`, `8a-web-chaos.jpg`, `8a-plugin-overview.jpg`, `8a-plugin-sessions.jpg`, `8a-plugin-session-detail.jpg`, `8a-plugin-replay-playing.jpg`, `8a-plugin-401-banner.jpg`, `8a-plugin-test-connection-401.jpg`, `8a-plugin-test-connection-ok.jpg`, `8a-ios-order.jpg`, `8a-ios-chaos.jpg`, `8a-ios-fatal.jpg`, `8a-plugin-mobile-session-frames.jpg` | revision 1 screenshots (rum-api gateway, superseded; no longer referenced by the report) |
| `plugin-overview.jpg`, `plugin-sessions.jpg`, `plugin-session-detail.jpg`, `plugin-replay-masked.jpg`, `plugin-replay-deleted.jpg`, `grafana-explore-trace.jpg`, `web-checkout-live.jpg`, `mobile-expo-web-chaos.jpg` | walk-through screenshots referenced by `reports/mvp-verification.html` |
