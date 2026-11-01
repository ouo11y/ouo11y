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
| [run.sh](run.sh) | builds the golden app (`examples/ouo-mobile/scripts/build-android.sh --conformance`, OTLP through `../mobile-native/proxy.mjs` for C11.2), then the launches: the journey with a background stay past the 5 s timeout, the taps, a native crash on Cart and the launch after it, an offline run with the collector stopped and the launch after it |
| [check.mjs](check.mjs) | reads the app's notes from logcat and asserts rum-api (and Tempo through Grafana) per check, prints the checks and the maturity row |

Commands reach the app as broadcasts (`am broadcast -a dev.ouo.mobilestore.JOURNEY --es cmd ...`,
received by the demo module `examples/ouo-mobile/modules/ouo-chaos`): a Release build's files are not
writable by adb, and a deep link pauses the activity, which React Native reports as a background.
C6.1's taps are `adb shell input tap` / `swipe` on the views `uiautomator dump` finds by test id
(React Native puts `testID` in the resource id). C8.2's pixels are measured with
`../mobile-native/pixels.swift` on the areas the app notes (`measureInWindow`, in dp, the viewport's
points).

Checks that need W9 part 2 (native crashes, ANR, app start and frame counts on opentelemetry-android)
are `pending`: C2.2 and C4.1 run and report, C2.3, C3.1 and C3.2 are not run yet. A pending check
that passes fails the run until its `pending` is removed.

About 3 minutes plus the build (the first one downloads the NDK and takes about 15 minutes).

**Not in CI** (like the native iOS suite, checklist N78): the Mac runner runs one job at a time and
has no stack. CI builds the library, runs its unit tests and compiles the Expo module (`ci.yml`, job
`android`).
