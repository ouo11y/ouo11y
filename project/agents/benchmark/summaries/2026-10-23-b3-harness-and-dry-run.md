# 2026-10-23 B3 harness, fairness rules, simulator dry run (session b2-benchmark)

## Done

- **Rules first:** [docs/benchmarks.md](../../../../docs/benchmarks.md) was written before any run. It has 12 fairness rules
  (tiers T1–T4, no-SDK baseline, release builds and a real-tap journey, 100 % sampling, N ≥ 10 with medians and IQR,
  cold start, one device and OS, pinned versions, Sentry per its docs with the configs published, the same network
  path, losses reported plainly, runs that did not do the work left out and counted), the metrics, how to run it, and
  the proposed release gate (section 5, waiting for the founder).
- **Harness** (`examples/sentry-mobile/scripts/perf/`, extends #25):
  - `build.sh`: Release build for sim or device; endpoints on the proxy; link map and Hermes source map;
    `--ouo` / `--sentry latest`, which moves `@sentry/core` with it.
  - `bench.py`: cells per SDK × tier; Sim and Device targets; offline + recover runs; 30 min soak.
  - `proxy.py`: decodes Content-Encoding, types Sentry envelope items, `--lan`, `--offline-flag`, `--sink`.
  - `bench_result.py`, `bench_report.py`, `bench_trend.py`, `gate.py`, `size.py`.
  - `n22_device.py`: Time Profiler and the crash flows on the phone.
  - The driver now uses the screen centre and `PERF_DY`, with `loop` and `idle` journeys; signing by `TEAM_ID`.
- **App switch** (commit 848e777, `examples/sentry-mobile/{index.ts,src/}`): `perf-mode.json` takes `"tier"`, in
  OUO_PERF=1 builds only. **The orchestrator's OK was asked for at 10:00 and had not arrived; committed separately so it can
  be dropped.**
- **CI:** `.github/workflows/benchmark.yml` runs on the simulator, `--sink` (no Docker on macOS runners), native demo
  backend, latest stable Sentry; ouo cells of the previous `react-native-v*` tag; `gate.py`; smoke run on PRs that touch
  the harness. Not run on GitHub yet (it runs when this PR changes the harness).
- **RELEASING:** step 3 in `docs/releasing.md` section 5 (major `react-native` releases).
- **Dry run (simulator only):** 10 rounds × 8 cells, offline, 30 min soaks, all 80 runs in the statistics.
  [report](../../../reports/benchmarks/2026-10-23-ouo-0.2.0-vs-sentry-8.32.0-sim/report.html), trend page, notes with
  every loss.

## Verified, and how

- Each tier does what it says. In round 1, the envelope item types per cell were:
  - T1: session, event, log; no transactions.
  - T2: adds transactions.
  - T3/T4: add `replay_video`.
  - ouo T2: no `/v1/replay`; ouo T3/T4: replay chunks.
  - `perf.json` records mode and tier.
- Every tap lands. 3 runs had one extra backend request; none missed one.
- The proxy, tested by hand: gzip decoded, envelope items parsed, sink answers, offline closes the connection.
- The report and trend pages were viewed in the browser pane.
- The device code paths (`Device` target, `n22_device.py`, xctrace parsing on device) are **not run**. The Activity
  Monitor column names were checked on an export.

## Findings (simulator)

- ouo costs more on the network:
  - replay about 2× Sentry's (+267 KB/min in T4);
  - OTLP JSON uncompressed (Sentry gzips);
  - no offline buffer (Sentry kept 535 KB on disk and re-sent it, ouo lost the run).

  New checklist items N48, N49, N50.
- ouo costs less on CPU (−3.9 pp with replay), idle CPU (−5 pp), memory (−8 MB steady, −46 MB peak with replay),
  startup and size (0.7 MB vs 3.9 MB).
- Sentry's session replay sometimes does not start (1 of 4 launches in the smoke runs, 0 of 20 in the dry run).
  Possibly N7.
- Sentry T1 sends 6 `log` envelopes per run with `enableLogs` unset: origin not determined.

## Left

- **N22 and the B3 iPhone run:** waiting for the founder (phone, Team ID). The commands are in docs/benchmarks.md
  section 4 and in `n22_device.py`. The "before #40" source is a worktree at 5a887d6 in this session's scratchpad;
  recreate it with `git worktree add <dir> 5a887d6`.
- Founder: approve or change the gate thresholds.
- The JS bundle's Hermes string tables are not attributed per SDK (about 40 % of the bundle).

## Dependencies

None added. `build.sh` uses `npm install --no-save` to swap SDK versions per build.

## Env

`b2-benchmark-e8cad7` (http://grafana.b2-benchmark-e8cad7.ouo.localhost) is kept up for the iPhone run. Take it down
with `deploy/envs/ouo-env down b2-benchmark-e8cad7` when B3 and N22 are done.
