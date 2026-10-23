# 2026-10-23: batch 2, bridge and examples (A4, N3, N5, N23, N24)

Two PRs. PR #43: rename `examples/web` → `examples/ouo-web`, `examples/mobile` → `examples/ouo-mobile`, and the vitals spec `docs/specs/mobile-vitals.md`. PR 2 (stacked on #43): the rest, below.

## Done

- **A4 mobile vitals, end to end.** The format is `docs/specs/mobile-vitals.md`, shared with the ouo RN SDK (G2): OTel log events `ouo.app.start`, `ouo.screen.display`, `app.jank` (semconv) and `ouo.stall`.
  - Receiver `collector/receiver/ouosentryreceiver/vitals.go` maps transaction `measurements`, with tests in `vitals_test.go` (synthetic + golden).
  - rum-api (done by a subagent and checked here): timeline type `vital`, `GET /v1/sessions/{id}/vitals` (summary with ratings + records), `app_start_ms` / `app_start_type` on sessions.
  - Plugin: a vitals row in the session header, and timeline / activity entries coloured by rating.
- **N3 SDK range.** Golden journeys `testdata/golden/ios-rn-8.32.0/journey` (sentry-cocoa 9.31.0) and `ios-rn-7.11.0/journey` (8.58.0, the Expo 57 default), each with a row in `versions_test.go`. The range is written into `docs/specs/sentry-bridge.md` and `docs/compatibility.md`.
  - 8.x is supported.
  - 7.11.0 is partial: under Expo 57 it traces no fetch, sends no app start, a TTID in days and transactions hours in the past.
  - `examples/sentry-mobile` moved to 8.32.0.
- **N5** `docs/sentry-client-setup.md`.
- **N23** three examples:
  - each has a five-minute README (ouo-env and plain compose with `ghcr.io/ouo11y/*:0.3.0` + `docker login`), `.env.example`, `scripts/run.sh` (journey + `verify.py`), and a leg in the new CI job `examples`;
  - `ouo-web`: Playwright journey;
  - `ouo-mobile`: Release build script and journey mailbox;
  - `sentry-mobile`: `.env.example` with `upstream: none` through the stack's bridge and `OUO_RUM_MODE=sentry`; `ci-journey.py` is its Linux stand-in.
- **N24** `examples/tools/tracecheck.py` (+ `rumcheck.py`, unit tests). It found and fixed:
  - Sentry requests with no active span (random parent, unsampled flag): `src/api.ts` waits for the first navigation span or opens a transaction;
  - the Expo plugin's `sentry.options.json` silently skipping the native SDK start: `autoInitializeNativeSdk: true`;
  - `tracePropagationTargets: ["localhost"]`: now the backend only;
  - `sentry-trace` missing from the backend's CORS.

## Verified, and how

- `go test -race ./...` (receiver), `go vet` / `go test` (rum-api, backend), and the plugin's typecheck / lint / tests (166 tests).
- `python3 -I -m unittest discover -s examples/tools`, `lychee --offline`, `node .github/scripts/compat-check.mjs`.
- Env `b2-bridge-examples-vitals`:
  - `ouo-web` 16/16 (Playwright, 13 requests);
  - `ouo-mobile` 14/14 on the iOS 27 simulator (13 requests, session.id on backend spans), and 14/14 for the Node playground leg CI runs;
  - `sentry-mobile` 14/14 on the simulator (short and `--full`, 31 requests, vitals), and the CI stand-in 14/14.
- Plugin in the env's Grafana (browser):
  - the session header of a bridged session shows "Warm start 2.95 s · TTID p50 533 ms · max 3.07 s · Frames 5 slow · 0 frozen / 193";
  - the activity list has "App start (warm) 2.95 s", "Home displayed in 3.07 s" and "Janky frames 3 / 145";
  - Grafana needed a restart for the new chunk (known, `grafana-app-plugin.md`).
- Live against self-hosted Sentry 26.10 (project 2), `sentry-mobile` 8.32.0, `--full`:
  - 61 envelopes forwarded, all 200; ouo 14/14.
  - Sentry stored per run 3 errors and 1 info message, 4 replays, 19 transactions (via the `sentry-sbx` MCP), matching ouo's 4 sessions, 3 exceptions, 1 `sentry.message` and 19 joined traces.
  - The taskbroker had to be restarted again (kb). Sentry was stopped afterwards (`down`, volumes kept).

## Dependencies added

- `playwright` 1.64.1 (dev, `examples/ouo-web`): the scripted journey in a real browser, locally and in CI.
- `expo-file-system` ~57.0.7 (`examples/ouo-mobile`): the journey's command file.
- `@sentry/react-native` 8.30.0 → 8.32.0 and `@sentry/core` 10.76.0 → 10.76.2 (`examples/sentry-mobile`): the current major's latest, for N3.

## Left / for the next agent

- CI job `examples` first runs on this PR. Watch the compose build time (about 5 min), and Playwright's Chromium download.
- N27, N28 (checklist): the shared `ouo/collector` image tag across ouo-envs; rum-api caching empty Tempo answers.
- Native sentry-cocoa and sentry-java apps (N3 medium term, B6). Older 7.x only if a client runs one.
- `ouo-mobile` `verify --vitals` once `@ouo11y/react-native` emits vitals (G2, other session).
- A `sentrytap` left by an older session (PID 46082, since 2026-10-16) still listens on 127.0.0.1:4400. It received one of this run's journeys by accident, a capture of no value to it. Left running because it is not ours.
- The env `b2-bridge-examples-vitals` was torn down at the end (see the final message). The simulator `ouo-b2-examples` (B7203003-EA32-4D19-8BA0-1D90B1829B41) was shut down and kept for reruns.
