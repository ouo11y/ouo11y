# benchmark tracker

| Date | Event |
|---|---|
| 2026-10-23 | B3: fairness rules in `docs/benchmarks.md`, harness for tiers T1 to T4 and every B3 metric, CI workflow with a proposed release gate, RELEASING step; simulator dry run (10 rounds × 8 cells, offline, 30 min soaks). [summary](summaries/2026-10-23-b3-harness-and-dry-run.md), [report](../../reports/benchmarks/2026-10-23-ouo-0.2.0-vs-sentry-8.32.0-sim/report.html) |

| 2026-10-23 | N22 on the iPhone 16 Pro Max: #40 does not help on the device (ouo 44–45 ms per capture vs Sentry 22 ms); crash flows pass; CPU/memory partial. B3 device run stopped by the founder. [summary](summaries/2026-10-23-n22-iphone-and-stop.md) |

| 2026-11-15 | Replay over OTLP counted again (ouo-T3/T4 had no data since #184 and the job passed); a cell with no usable run now fails the benchmark. [summary](summaries/2026-11-15-otlp-replay-and-empty-cells.md) |

## Open

- Phone experiments within the budget (`docs/benchmarks.md`): capture cost after N51, one run per cell. First: an in-app reset instead of a reinstall.
- Release gate thresholds: proposed in `docs/benchmarks.md` section 5, waiting for the founder.
- Sentry T1 `log` envelopes with `enableLogs` unset: find their origin.
