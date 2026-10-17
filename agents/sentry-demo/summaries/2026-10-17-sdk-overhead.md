# 2026-10-17 sdk-overhead: device cost of ouo next to Sentry (iOS simulator)

## Done

- `examples/sentry-mobile`: `OUO_PERF=1` build flag. One binary; `Documents/perf-mode.json` picks the SDK
  mix per launch (`src/config.ts`, read before `Sentry.init`); `src/sentry.ts` skips `Sentry.init` in the
  "ouo only" mode; `src/ouo.ts` takes `replay.enabled` from config (`OUO_REPLAY=0` for normal builds);
  `src/perf.ts` JS frame monitor + first-frame time to `Documents/perf.json`. All no-ops without the flag.
- `scripts/perf/`: `proxy.py` (counting HTTP forwarder), `sample.py` (host-side `proc_pid_rusage`
  sampler), `driver/` + `make-driver.rb` (XCUITest real-tap journey, own generated Xcode project),
  `run.sh` (interleaved loop), `analyze.py` (medians, spread, paired deltas), `report.py` + `notes.html`
  (HTML report), `profile.py` (Time Profiler attribution Sentry / ouo / other).
- 30 runs: none, sentry, both (ouo replay off), both-replay, ouo-replay x 6 rounds, 95 s each, on a
  dedicated simulator (`ouo-perf iPhone 18 Pro`, A99B6BF8-...) against the isolated compose project
  `ouo-perf` (released 0.2.0 images, ports 35xx/45xx/85xx). One Time Profiler trace of both-replay.
- Report `agents/sentry-demo/reports/sdk-overhead-ios.html`; kb `kb/sdk-overhead-ios.md`; pointer in
  `kb/ouo-next-to-sentry.md`; README section.

## Result

ouo next to Sentry with replay off: CPU +0.1 pp [-0.7, +0.8], memory +0.6 MB, start +2.5 ms, JS frames +1:
noise. Network +15 requests, +59 KB per 95 s. ouo replay on as well: +6.6 pp CPU, +1.08 MB per 95 s,
+93 ms start; ouo captures hold the main thread ~49 ms each (Sentry's ~18.5 ms) on the simulator.

## Verified how

- Every tap checked by its backend request in the proxy log (`?fail=500` -> 500, `GET /api/cart`, checkout).
- "none" and "ouo-replay" runs: zero Sentry requests; "none": zero SDK requests.
- Sampler counters checked against Time Profiler's sampled CPU (same order: ~14 s CPU in 85 s).
- `npx tsc --noEmit` in examples/sentry-mobile passes; Release build succeeds.

## Left / next agent

- No real device on this Mac: repeat on an iPhone (same scripts; the sampler needs replacing with
  `xctrace record --template 'Activity Monitor'` on a device, the proxy with a Mac-hosted one on the LAN).
- UI-thread hitches are only measured from one trace; a native CADisplayLink monitor in the app would
  give them per run.
- ouo replay's ~49 ms main-thread capture (`ReplayRecorder.captureFrame`, CoreGraphics + vImage) is a lead
  for `sdk/ios`: scale/encode off the main thread.
- The `ouo-perf` stack was stopped (`docker compose -p ouo-perf down -v`); the simulator was kept.

No new dependency: Python stdlib, the xcodeproj gem already shipped with CocoaPods, XCTest.
