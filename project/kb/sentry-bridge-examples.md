# Examples per path, trace continuity, mobile vitals, Sentry SDK range (batch 2, 2026-10-23)

Question: how do the three examples (`examples/ouo-web`, `examples/ouo-mobile`, `examples/sentry-mobile`) prove "no broken traces" (checklist N23 / N24), and what did running them against real SDKs find? Also what Sentry sends for mobile vitals (A4) and across SDK versions (N3).

## How the checks work

- `examples/tools/tracecheck.py` (stdlib, unit tests in `test_tracecheck.py`) is shared by every `verify`. Its reference is the backend's own per-request log line (`request` in Loki, with `trace_id` and `flags`), which `examples/backend` writes whether or not the trace is sampled. Every logged request must be a sampled trace whose backend server span is in Tempo, with its parent in the same trace and that parent a client span of the app. The other checks:
  - `session.id` on backend spans (ouo paths);
  - no client request to the backend without its backend span;
  - backend span count equal to the request count;
  - a CORS preflight with `traceparent`, `tracestate`, `baggage` (+ `sentry-trace`);
  - no span from the other SDK path in the window (`ouo.rum.mode`, `ouo.sentry.session_match`).
- **Tempo search returns traces outside `start`/`end`** (it filters by block, not by trace time): results are filtered by `startTimeUnixNano`, and fetched traces by span start. Without that, an earlier run's traces made the checks fail.
- Tempo search caps `spss` at 100 (`spans per span set exceeds 100` is a 400).
- rum-api caches a session's Tempo answer for `TEMPO_CACHE_TTL` (60 s), **also an empty one** taken before Tempo indexed the traces: the session detail reads `trace_count: 0` for up to a minute after the session ends. `rumcheck.py` retries past the TTL; rum-api itself is unchanged (follow-up).
- CI has no iOS Simulator on Linux. The `examples` job runs `ouo-web` for real (headless Chromium, Playwright). For `ouo-mobile` it runs the `@ouo11y/react-native` bundle in Node (`sdk/react-native/playground`). For `sentry-mobile` it runs `scripts/ci-journey.py`, which sends what @sentry/react-native 8 sends (headers and envelopes) through the real bridge. The same `verify.py` runs afterwards. The iOS runs are `scripts/run.sh` on a Mac.

## Broken traces found on the Sentry path, and the fixes

1. **Requests with no active span** (the first screen's data load at cold start; any request outside a transaction) carry Sentry's propagation context: `traceparent: 00-<trace>-<random span>-00`. The parent span never exists and the flag is unsampled, so the backend's `ParentBased` sampler drops the spans. The backend still logged the request (`flags` 0), which is how the check caught it. Fix in `examples/sentry-mobile/src/api.ts`:
   - before the navigation container is ready, wait for it (`navigationReady`), so the request is a child of Sentry's first navigation span;
   - later, give a request with no active span its own transaction (`Sentry.startSpan`, `forceTransaction`).
   **Do not** start your own root span at cold start: @sentry/react-native attaches the app start to the *first started root span*, whatever it is. Our first fix made the app start a `ui.load` transaction named `GET /api/products`, and the bridge turned that into a navigation to a screen with that name.
2. **The native SDK never started** (no envelope at all, no `Library/Caches/io.sentry`). The @sentry/react-native Expo plugin writes `sentry.options.json` when `SENTRY_ENVIRONMENT` is set at prebuild (or the plugin has `options`). In Release builds the 8.x JS SDK then logs `Using options file. Native SDK is expected to be initialized before JS` and skips the native start. Fix: `autoInitializeNativeSdk: true` in `Sentry.init` (or the plugin's `useNativeInit`). Look for that log line under `com.facebook.react.log`, which shows with `simctl spawn <udid> log stream --predicate 'process == "sentrydemo"'`. It probably explains the open item in `env-test-sessions.md`.
3. `tracePropagationTargets: ["localhost"]` matched every local URL, collector and flag server included. The example now lists the backend only.
4. The backend's CORS lacked `sentry-trace` (`examples/backend/internal/api/cors.go`). Mobile apps send no preflight, but web views and browsers would drop the header.

## Mobile vitals in Sentry transactions (A4)

Measurements on @sentry/react-native 8.30 / 8.32 on iOS:

- `app_start_cold` / `app_start_warm` (millisecond) arrive on the first root transaction (`ui.load`), whose `start_timestamp` is the process start: first frame = start + value.
- `time_to_initial_display` (millisecond) arrives on `ui.load` and `navigation` transactions.
- `frames_total`, `frames_slow`, `frames_frozen` (unit `none`), and `frames_delay` (second) when there are frames, arrive on `navigation` and `ui.action` transactions.
- `stall_count`, `stall_total_time`, `stall_longest_time` arrive on almost every transaction, mostly zeros.
- The receiver maps them per `docs/specs/mobile-vitals.md` section 6: zeros emit nothing, values above 1 h are dropped, and there is at most one `ouo.app.start` per session.
- The warm start after a background relaunch was about 2.6 to 3.7 s on the simulator.

## SDK range (N3)

Golden journeys live in `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-<version>/journey`, tested by `versions_test.go`. They were captured with `sentrytap -forward <bridge>` between the app and the bridge while `run.sh --full` and `verify.py` ran. The verify results:

| Version | sentry-cocoa | Result |
|---|---|---|
| 8.32.0 (latest 8.x) | 9.31.0 | 14/14, all vitals |
| 7.11.0 (Expo 57 default, `bundledNativeModules.json` `~7.11.0`) | 8.58.0 | see the issues below |

What 7.11.0 gets wrong under Expo 57 / React Native 0.86:

- no `fetch` instrumentation: only the raw XHR got an `http.client` span, so no `traceparent` and no backend correlation;
- no app start measurement;
- TTID of about 617,918,368 ms;
- transactions stamped about 3.6 h in the past;
- the native crash type is `EXC_BREAKPOINT`;
- logs come mostly as console.

Sessions, errors, replays and logs still translate. Recommend 8.x.

## Live run against self-hosted Sentry (2026-10-23)

- `examples/sentry-mobile` 8.32.0, `run.sh --full`, bridge upstream `http://host.docker.internal:9000` (project 2):
  - 61 envelopes forwarded, all 200; ouo `verify` 14/14.
  - Sentry stored per run: 3 errors and 1 info message, 4 replays (one per session), 19 transactions. ouo had 4 sessions, 3 exceptions, 1 `sentry.message` and 19 backend-joined traces.
- The taskbroker got stuck again right after `up` (`sentry-self-hosted.md`, "Ingest stuck"): restart it, then **wait about a minute** for the Kafka rebalance before Relay stops timing out. The envelopes Relay held arrive after that.
- Docker memory: about 15 GiB in use with Sentry plus four ouo stacks and a kind cluster.

## ouo-env trap: shared collector image tag

`deploy/compose/compose.yaml` names the collector image `ouo/collector` for every env. Any env's build re-tags it, so `ouo-env up <env> --no-build` (or a recreate) can start another branch's collector. One of our runs lost every vitals record that way. Rebuild (`ouo-env up <env>` without `--no-build`) before a check that depends on your collector code, and confirm that the records your branch adds arrive. Follow-up: a per-env image name.

## Other traps

- Leftover `sentrytap` processes from other sessions held ports 4400 and 4411. Your app's traffic then lands in their capture. Check with `lsof -nP -iTCP:<port> -sTCP:LISTEN` and pick a free port.
- macOS has no `timeout`: use `perl -e 'alarm 15; exec @ARGV' <cmd>`.
- `ouo-mobile` has no Metro in the examples. `scripts/build-ios.sh` bakes the stack's URLs into a Release build, which also settles Q2 R2-2: `expo.extra` always matches the stack it was built for.
