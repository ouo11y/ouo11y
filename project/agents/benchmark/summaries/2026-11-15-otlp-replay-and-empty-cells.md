# 2026-11-15: harness counts OTLP replay, fails on empty cells

## What was done

- Since #184 (ADR-0021, `@ouo11y/react-native` 0.4.0) ouo replay is one `ouo.replay.chunk` (or `ouo.replay.ended`) OTLP log record per request to `/v1/logs`, sent by the native layer to the OTLP endpoint. The harness still listened for the old replay route (proxy port 4719), so the ouo-T3/T4 cells had no data: every run was excluded as "replay expected but nothing uploaded", and the job passed (PR #198 smoke run 43651971451).
- `proxy.py` now labels an otlp-route `/v1/logs` request whose uncompressed body holds one of the two replay event names `replay` (field `route: otlp` kept). `bench_result.py`, the report and the replay bytes per minute read that label as before. The 4719 route is gone from `bench.py`, `build.sh` and the proxy.
- `bench_result.py` writes `empty_cells` (cells of the run with no usable main run). `bench.sh` publishes the result and report as before, then exits 1 when the list is not empty, so the workflow step fails.
- `benchmark.yml`: the PR smoke run is on `macos-latest`, the same hunks as #198 (identical changes merge cleanly in either order).
- `docs/benchmarks.md`: replay bytes definition, the empty-cell rule, and the base of the gate must be 0.4.0 or later.

## Verified

- Proxy on spare ports with `--sink`: a protobuf body holding `ouo.replay.chunk` on `/v1/logs` is logged `replay`; a gzip log batch and a `/v1/traces` request stay `otlp`.
- Local `bench.sh --env none --sink --target sim --runs 1`, cells `none sentry-T3 ouo-T2 ouo-T3 ouo-T4`, on an own iPhone 17 Pro iOS 27.0 simulator (deleted after): every cell has 1 run in the statistics, exit 0. ouo-T3 replay 97 KB/min (a chunk every 5 to 7 s, protobuf, no Content-Encoding), ouo-T4 227 KB/min, sentry-T3 138 KB/min. Simulator numbers, one round: not results.
- The same runs with the replay label removed (the old behaviour): `bench_result.py` reports `NO DATA for cell(s): ouo-T3 ouo-T4` and the bench.sh check exits 1.

## Left / next agent

- `examples/sentry-mobile/app.config.ts` still reads `OUO_REPLAY_ENDPOINT` into `ouoReplayEndpoint`, which nothing uses since #184; README line 203 mentions it. Dead config, outside this harness.
- A base release before 0.4.0 cannot be gated (no replay data in its replay cells, which now fails the run).
