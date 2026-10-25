# 2026-10-23 evening: N22 on the iPhone; B3 device run stopped by the founder

## Done

- Rebased on origin/main (#43–#47). The tier switch now lives in `src/perf.ts` (`perfTier`,
  `perfSentryOptions`, `perfOuoReplay`), with one-line hooks in `src/sentry.ts` and `src/ouo.ts`, as
  the orchestrator approved.
- Device harness made to work on the iPhone 16 Pro Max (iOS 18.6.2, free team VW3XJCFN53):
  - JS frame monitor on a setTimeout heartbeat: rAF is setTimeout(0) in bridgeless React Native and busy-looped.
  - The XCUITest runner stays installed, so the developer trust holds.
  - Each fresh install is primed for the Local Network permission.
  - Tap offset `--dy -16`.
  - Hitches recorded.
  - Runs where an SDK sent nothing, or the journey stopped early, are excluded and counted.
  - Crashes and hangs of the harness are survived.
- **N22 measured** (results in `project/agents/ios-replay/perf/results/device`, report regenerated):
  - Capture cost, 3 rounds per build. ouo 40 ms main-thread CPU per capture before #40 and 44–45 ms
    after, against Sentry's 21–23 ms. Snapshot 47–49 ms on the main thread, compose 5.7 ms on the queue.
    Filed as N51.
  - Crash flows: all three pass. A crash within 1 s of launch loses the session start: N52.
  - CPU and memory per mode: partial (n = 1–3).
    - Before #40: Sentry 11.4 %, both 15.7 %, ouo 11.1 % CPU.
    - After #40: Sentry 11.4 %, both 17.1 %, ouo 12.6 % CPU.
    - ouo's steady memory is about 47 MB against Sentry's 79 MB.
- B3 on the device: **not run.** The founder stopped all phone work. I killed every job and the phone
  was released.

## Not measured

- Every B3 tier on the device.
- Energy (Power Profiler needs iOS 26).
- N ≥ 10 on the device.
- Hang tables from Time Profiler (the traces were deleted after export).

## Next

- Phone budget (`docs/benchmarks.md`): (1) capture cost after the N51 fix, about 7 min; (2) one run per
  cell, about 30 min.
- Before asking: reset the app in-app instead of reinstalling, so the Local Network permission is asked once.
- Everything else of B3 stays on the simulator (dry run published, N = 10).

## Env

`b2-benchmark-e8cad7` is still up (http://grafana.b2-benchmark-e8cad7.ouo.localhost). Take it down with
`deploy/envs/ouo-env down b2-benchmark-e8cad7` once the PR merges.
