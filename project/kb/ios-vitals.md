# Native mobile vitals on iOS (G2): app start and frame counters

Question: how does the iOS side of `@ouo11y/react-native` measure what `ouo.app.start` and
`app.jank` need (`docs/specs/mobile-vitals.md`), the way sentry-cocoa does, without costing the
main thread? Code: `sdk/ios/Sources/OuoVitalsCore` (C), `sdk/ios/Sources/OuoVitals` (Swift), the
Expo functions in `sdk/react-native/ios/OuoReplayModule.swift`. Built and verified 2026-10-23.

## Contract (what JS reads)

- `getAppStartInfo()` -> `{ processStartMs, type: "cold" | "warm", prewarmed }` or `null`.
  `processStartMs` is the **start of this launch**, not always the process start: the process
  start for `cold`, the image load time for a prewarmed `cold`, the JS runtime's start (the Expo
  module instance's creation) for `warm`. Resolved once per module instance (= per JS runtime).
- `getFrameStats()` -> `{ total, slow, frozen, delayMs, expectedFrameMs }`, cumulative since the
  module was first created in the process; JS diffs two snapshots per window.

## Things that are easy to get wrong

- **Process start**: `sysctl(CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid())` `kp_proc.p_starttime`
  (a `timeval`, epoch). Same call as sentry-cocoa's `SentrySysctl`. Works on macOS too, so the
  test checks it against `Date()`.
- **Prewarming** (iOS 15+): iOS may create the process minutes before the user taps the icon
  (`ActivePrewarm=1` in the environment). Measuring from the process start then gives absurd cold
  starts. sentry-cocoa measures those from its "module initialization" (a `+load`); ouo uses a C
  `__attribute__((constructor))` in `OuoVitalsCore` (runs before `main` when the static pod is
  loaded). The JS side also drops the start when the app was not `active` at init. Prewarming
  does not happen on the simulator, so that path is covered by the unit test only.
- **Cold vs warm**: the spec's warm is a JS reload in a live process, not sentry-cocoa's
  heuristics (boot time, app update). The first `getAppStartInfo()` call in the process is cold,
  any later module instance's call is warm. Counting on calls, not on module creation, keeps the
  Expo dev launcher (which may create its own app context and modules first) from turning the
  app's real cold start into a warm one. Expo creates a new module instance per reload, so
  `OnCreate` time is the warm start.
- **Slow frame rule** (sentry-cocoa `SentryFramesTracker`): duration = time between two
  `CADisplayLink` callbacks; expected = `targetTimestamp - timestamp` of the current callback,
  which follows 60/120 Hz and ProMotion throttling without reading `maximumFramesPerSecond`; slow
  when the duration exceeds `1 / (fps - 1)` (one frame of jitter tolerance; 16.95 ms at 60 Hz),
  frozen at >= 700 ms (the spec; Sentry uses > 700 ms). `delayMs` sums `duration - expected` of
  slow and frozen frames.
- **Background**: the display link stops firing while inactive; without a reset the first frame
  after foregrounding is "frozen" for the whole background time. The tracker resets the reference
  on `willResignActive` and `didBecomeActive`.
- **Display link retains its target**: the tracker gives it a weak proxy.
- **Expo `extra` is baked at native build time**: `Constants.expoConfig.extra` in a dev build comes
  from `EXConstants.bundle/app.config`, written by an Xcode build phase. Setting
  `EXPO_PUBLIC_OTLP_ENDPOINT` only for Metro sends the data to the default `:4318` (env `main`);
  export it before `xcodebuild`.
- **CocoaPods 1.17 on Ruby 4** fails with `Unicode Normalization not appropriate for ASCII-8BIT`
  unless `LANG`/`LC_ALL` are UTF-8.
- **Metro on another port in a dev build**: `RCT_METRO_PORT` as an `xcodebuild` setting does
  nothing; `xcrun simctl spawn <udid> defaults write <bundle id> RCT_jsLocation localhost:<port>`
  does. A JS reload from a script: send `{"version":2,"method":"reload"}` to
  `ws://localhost:<port>/message`.
- **xctrace on the simulator**: `--attach <pid>` and `--attach <name>` both said "Cannot find
  process"; `--device <udid> --launch -- <path to .app>` works (and profiles the launch).

## Cost

Per frame: one Objective-C message from the display link, two timestamp reads, an uncontended
`os_unfair_lock` and a few double operations. Measured: 6 ns per frame in a Release build (136 ns
Debug) in `FrameCostTests`; a 30 s Time Profiler capture of the Debug example app (about 1 800
callbacks) had 0 of 608 main-thread samples (1 ms) in any vitals frame
(`project/agents/ios-replay/perf/vitals_profile.py`, report
`project/agents/ios-replay/reports/g2-vitals.html`).
