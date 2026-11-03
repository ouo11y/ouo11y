# W9 part 2: native signals on Android, React Native Android at L2 on C1–C11

Date: 2026-11-01. Branch `claude/w9-android-part2`. Follows [part 1](2026-10-31-w9-android-part1.md) (PR #141, merged).

## What was done

- **Decision, [ADR-0017](../../../../docs/adr/0017-android-signals-and-opentelemetry-android.md)** (proposed): the brief asked for the opentelemetry-android base under the React Native module (ADR-0016). Reading opentelemetry-android 1.8.0 against the module showed its sessions, export and disk buffering duplicate what the JavaScript half already owns (the spec's session manager and the C11 outbox), and its detectors miss the spec (ANR at 5 s reported at detection, no foreground terminations, crash and slow rendering emitted through its own SDK). So the signals are ouo detectors in `sdk/android`, written to the iOS report contract, and opentelemetry-android stays the pipeline of the native package, which will register these detectors as instrumentations. The founder or the coordinator confirms or rejects the ADR at the checkpoint.
- **`sdk/android/signals-core`** (plain Kotlin, JVM tests): the report (`jvm`, `hang`, `termination`, JVM frames with Sentry's Java field names, at most 100 frames, causes appended to the message), `RunState`, `Termination.decide` (the C3.2 heuristic on `ApplicationExitInfo` facts), `HangDetector` (C3.1 rules on a ping), `FrameCounter` (slow, frozen, delay from rendered frames), `AppStart` (cold only for a process started to show the app).
- **`sdk/android/signals`** (`Signals`): the uncaught exception handler chained to React Native's (writes `crash.json` at crash time), the 200 ms main-looper watchdog, memory warnings (`onTrimMemory` running levels, `onLowMemory`), `ApplicationExitInfo` for the previous pid at the next launch, `FrameMetrics` per resumed activity window (replaces part 1's `Choreographer` counter, so vsync is no longer requested every frame), `ApplicationStartInfo` on Android 15 and a 10 s window before it (the reviewer's cold-start finding).
- **Expo module**: `installCrashReporter`, `setCrashSessionId`, `takePendingCrash`, `onHang`, and `getAppStartInfo` / `getFrameStats` over `Signals`; `Vitals.kt` removed; `sync-android.mjs` vendors the two new modules.
- **JavaScript** (`src/crash.ts` only, nothing of the outbox or C11): the `jvm` mechanism, JVM frames formatted as a Java stack trace, `JavascriptException` recognised as the JS fatal; 3 Vitest cases.
- **Replay**: `screenDidChange()` marks the window dirty, so on a static screen the next interval frame is taken (a full image), as on iOS; C10.1 found it (a feedback on a static Cart had no frame after it).
- **Example**: the demo module's `launchAction()` (`am start -e ouo_action <name>`), a memory warning before the simulated kill, the C2.3 early crash armed from the launch action.
- **Suite**: launches named by action; new launches hang, early crash, memory kill and reject (C11.3 through the proxy, N89); C2.2, C2.3, C3.1, C3.2 required; no `pending` left.
- **CI**: the `android` job also runs `:signals-core:test` and builds `:signals`.
- **Docs**: spec C3 Android rules and the matrix (React Native Android L2 on C1–C11), the RN README, `sdk/android/README.md` Signals section, the suite README, kb [android-setup.md](../../../kb/android-setup.md); tracker row and the part 1 summary flipped to merged; checklist N89 closed.

## Verified, and how

- `cd sdk/android && ./gradlew :replay-core:test :signals-core:test`: 18 + 7 JVM tests pass (report fields, run state, every termination cause and non-termination, one hang per block with the quiet period, a frozen watchdog, frame counting, app start cases). `:replay:connectedAndroidTest` on the emulator: 2 pass.
- `tests/e2e/mobile-android/run.sh w9-android-part2 emulator-5580` (env with released images, API 35 emulator): all 19 checks pass, row C1–C11 L2. Values: the hang 3127 ms for a 3 s block, fully blocking, on Cart; the memory kill a `WatchdogTermination` with cause `memory`; both crashes `java.lang.IllegalStateException`, sessions `crashed` / `crash`; the early crash's session starts before it (N52); cold app start 515 ms; C11.3's 500 sent once and the 503 again until accepted.
- `npm run -w sdk/react-native typecheck` and `test` (200 tests), the example's `tsc`, `lychee --offline`.

## Left, and what the next session must know

- **Native Android package** (next W9 part): opentelemetry-android as the pipeline (its session provider set to the spec's rules, OTLP/HTTP, disk buffering, network), the `signals` and `replay` classes registered as its instrumentations, a Kotlin API and a Java smoke target, its own suite. Then Compose modifiers, R8 / ProGuard symbolication (JVM frames are already in the report with `module`, `function`, `filename`, `lineno`), B3 Android cells, the suite in CI (N85).
- **Android NDK (C/C++) native crashes are NOT captured.** Only uncaught Java/Kotlin exceptions are crashes (the suite's C2.2 and C2.3 throw a Kotlin exception). An NDK crash sends no `native` exception and no stack: on Android 11+ the next launch reports `REASON_CRASH_NATIVE` as a termination with cause `unknown`, before Android 11 nothing. **Next part: NDK crash capture from `ApplicationExitInfo` tombstones (Android 12+, `getTraceInputStream()`)**, reported as a `native` crash with native frames for symbolication. Before Android 11 no termination is reported at all (no `ApplicationExitInfo`).
- The hang watchdog measures the main looper, not frames: a main thread that draws but never runs ordinary messages is not seen; documented in the spec.
- `RUM.feedback` still asks for the frame through `screenDidChange()`; N82 (a `frameForFeedback` on the module) applies to Android too.
- My first `npm ci` in this worktree ran through an npm shim another session had rewritten in a shared scratchpad folder, so it installed into that session's worktree (since removed); reinstalled here. Shims now live in a folder named for this task.
- No dependency added (platform APIs only).
- Env `w9-android-part2` and the emulator are torn down at the end of this run.
