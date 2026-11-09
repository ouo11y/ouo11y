# React Native Android conformance suite

The suite of `@ouo11y/react-native` on Android, with the check ids of
[docs/specs/mobile-sdk.md](../../../docs/specs/mobile-sdk.md) section 3 ([ADR-0015](../../../docs/adr/0015-mobile-sdk-spec-and-conformance.md)).
Unlike the React Native iOS suite (`../mobile/`, a model in Node), it runs the real app: the example
[examples/ouo-mobile](../../../examples/ouo-mobile/README.md) built in Release with `OUO_CONFORMANCE=1`
(default replay masking, a 5 s background timeout, `OUO_NOTE` lines in logcat) on an Android emulator,
against an `ouo-env` stack.

```bash
OUO_SESSION=<you> deploy/envs/ouo-env up <env>
# an emulator (project/kb/android-setup.md): emulator -avd <avd> -port 5580 -no-window -no-audio &
tests/e2e/mobile-android/run.sh <env> emulator-5580
```

| File | What it does |
|---|---|
| [run.sh](run.sh) | builds the golden app (`examples/ouo-mobile/scripts/build-android.sh --conformance`, OTLP through `../mobile-native/proxy.mjs` for C11.2 and C11.3), then the launches, each named with `am start -e ouo_action <name>`: the journey with a background stay past the 5 s timeout, the taps, a native (Kotlin exception) crash on Cart, an NDK crash (SIGSEGV in `libouochaos.so`, the demo module's C code) on Cart and an NDK `abort()` with a message (C2.4, read from the tombstone: Android 12+), a 3 s main-thread block on Cart, a native (Kotlin exception) crash 200 ms after the JS bundle runs, a memory warning and a SIGKILL on Cart (each crash or kill followed by the launch that reports it), an offline run with the collector stopped and the launch after it, and a run whose first OTLP request the proxy answers 500 every time and second 503 once |
| [check.mjs](check.mjs) | reads the app's notes from logcat and asserts rum-api (and Tempo through Grafana) per check, prints the checks and the maturity row |

Commands reach the app as broadcasts (`am broadcast -a dev.ouo.mobilestore.JOURNEY --es cmd ...`,
received by the demo module `examples/ouo-mobile/modules/ouo-chaos`): a Release build's files are not
writable by adb, and a deep link pauses the activity, which React Native reports as a background.
C6.1's taps are `adb shell input tap` / `swipe` on the views `uiautomator dump` finds by test id
(React Native puts `testID` in the resource id). C8.2's pixels are measured with
`../mobile-native/pixels.swift` on the areas the app notes (`measureInWindow`, in dp, the viewport's
points).

Every check of section 3 runs and is required (no `pending` since W9 part 2). C3.2's kill is
`Process.killProcess` after an `onTrimMemory(RUNNING_CRITICAL)` the demo module delivers, so
`ApplicationExitInfo` reports a `SIGKILL` at foreground importance with a memory warning a second
before: cause `memory`.

About 6 minutes plus the build (the first one downloads the NDK and takes about 15 minutes).

**Not in CI** (like the native iOS suite, checklist N78): the Mac runner runs one job at a time and
has no stack. CI builds the library, runs its unit tests and compiles the Expo module (`ci.yml`, job
`android`).
