# Sentry bridge in front of production

| File | Question |
|---|---|
| [cutover-risks.md](cutover-risks.md) | What does the SDK do in each way the bridge can fail, and which of them lose production data? |
| [hybrid-nginx-mirror.md](hybrid-nginx-mirror.md) | Production stays on nginx and the bridge gets a `mirror`: does a dead or slow bridge slow production, which nginx timeouts, duplicates from passthrough, why one instance (measured 2026-11-17) |
| [measured-overhead.md](measured-overhead.md) | How much latency, memory and fidelity does the bridge (with a mirror) cost, measured against self-hosted Sentry 26.10? |

The readiness report with the risk list: [sentry-mirror-readiness.html](../../../agents/sentry-demo/reports/sentry-mirror-readiness.html).
