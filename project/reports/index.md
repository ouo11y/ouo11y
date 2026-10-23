# Reports

Cross-cutting HTML reports. Agent-specific reports live under `project/agents/<agent>/reports/`.

| File | What it shows |
|---|---|
| [mvp-verification.html](mvp-verification.html) | Phase 6 MVP verification: architecture, acceptance checklist with evidence, synthetic matrix vs rum-api with health bars, real sessions, known gaps, how to reproduce |
| [phase-8a-verification.html](phase-8a-verification.html) | Phase 8a verification, revision 2 (collector is the edge): architecture with the three tokens, checklist with evidence, e2e through the collector with Basic credentials, edge / sink / read negatives, project stamping and replay via the collector, real web and iOS sessions, unload keepalive, collector rate limit and self-metrics, plugin read token, findings, reproduce |
| [sentry-bridge-verification.html](sentry-bridge-verification.html) | Sentry SDK bridge (ADR-0008) verification on real iOS traffic: byte-identical forwarding to Sentry, Sentry outage behaviour, sessions/errors/traces in rum-api, Loki and Tempo checked against the raw envelopes, replay segments decoded, Grafana screenshots, follow-ups (Sentry logs, replay breadcrumbs on the timeline, app + backend traces in Explore, unmasked replay), fixes found on real traffic, gaps, reproduce |
| [benchmarks/](benchmarks/index.md) | device-cost benchmark ouo vs Sentry per tier (B3): one folder per run with result.json and report.html, trend page across runs |
