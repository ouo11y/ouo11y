# benchmark tracker

| Date | Event |
|---|---|
| 2026-10-23 | B3: fairness rules in `docs/benchmarks.md`, harness for tiers T1 to T4 and every B3 metric, CI workflow with a proposed release gate, RELEASING step; simulator dry run (10 rounds × 8 cells, offline, 30 min soaks). [summary](summaries/2026-10-23-b3-harness-and-dry-run.md), [report](../../reports/benchmarks/2026-10-23-ouo-0.2.0-vs-sentry-8.32.0-sim/report.html) |

## Open

- Device run of every tier on the founder's iPhone 16 Pro Max (needs the phone and the founder's Team ID).
- N22: #40's per-capture main-thread time and both crash flows on the iPhone (`n22_device.py`).
- Release gate thresholds: proposed in `docs/benchmarks.md` section 5, waiting for the founder.
- Sentry T1 `log` envelopes with `enableLogs` unset: find their origin.
