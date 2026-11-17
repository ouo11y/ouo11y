# The Sentry bridge next to Muninn

How the Sentry bridge (`ouosentry`, ADR-0008) and Muninn's spec-wire path run in one collector, written 2026-11-15 by the sentry-demo agent. Report with the per-signal matrix and back-pressure numbers: [bridge-muninn-lgtm.html](../../../agents/sentry-demo/reports/bridge-muninn-lgtm.html).

| Entry | What it answers |
|---|---|
| [where-bridge-output-lands.md](where-bridge-output-lands.md) | Where each bridge output goes with Muninn in the stack, why bridged replay cannot reach Muninn by configuration, and what PR #208 changes |
| [backpressure.md](backpressure.md) | Does a down Loki, Muninn or rum-api slow the bridge's answer? (No.) What is lost, and the rate-limit trap behind a reverse proxy |
| [replaying-sentry-captures.md](replaying-sentry-captures.md) | How to replay old sentrytap captures into a fresh stack: time shift, fresh ids, msgpack, Tempo's 30 s span-metrics window |
