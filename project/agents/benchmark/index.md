# benchmark

Device-cost benchmark of the ouo SDK against the Sentry SDK (roadmap B3), and the iPhone run of
#40's replay and crash work (checklist N22).

- Owns: `examples/sentry-mobile/scripts/perf/` (harness), `.github/workflows/benchmark.yml`,
  `project/reports/benchmarks/` (results and trend page), `docs/benchmarks.md` (method, fairness
  rules, release gate).
- Method notes and quirks: [`project/kb-archive/sdk-overhead-ios.md`](../../kb-archive/sdk-overhead-ios.md).

| File | Content |
|---|---|
| [tracker.md](tracker.md) | what was done, what is open |
| [summaries/](summaries/index.md) | one dated summary per run |
