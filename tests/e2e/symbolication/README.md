# Symbolication end to end, on simulators

Proves the ADR-0026 path ([docs/adr/0026](../../../docs/adr/0026-debug-files-and-erasure-without-rum-api.md)) on real release builds: CI-style upload of debug files with `ouo-sourcemaps` to Muninn, a crash on a simulator, the exception record read back from Loki, resolved with `libs/ouo-go/symbolicate` (through [`cmd/ouo-symbolicate`](../../../libs/ouo-go/cmd/ouo-symbolicate/main.go)), and the original function, file and line asserted.

```bash
OUO_SESSION=<you> deploy/envs/ouo-env up <env> --muninn
xcrun simctl boot <udid>                                  # your own simulator
emulator -avd <avd> -port 5590 -no-window -no-audio -read-only &
tests/e2e/symbolication/run.sh --env <env> --sim <udid> --serial emulator-5590
```

| Target | App | Debug file | Crash | Asserted |
|---|---|---|---|---|
| `--native-ios` | [examples/ouo-ios](../../../examples/ouo-ios/README.md), Release | its `.dSYM`, `upload-dsym` | `OUO_ACTION=crash`: SIGSEGV in `crashForSymbolication()`, reported on the next launch | `crashForSymbolication` at `Journey.swift:167` |
| `--rn-ios` | [examples/ouo-mobile](../../../examples/ouo-mobile/README.md), Release, Hermes | `main.jsbundle.map` (Xcode with `SOURCEMAP_FILE`), `upload --bundle --sourcemap` | journey `action/js-crash`: a fatal JS error from a timer | `chargeCardForSymbolication` at `src/symbolication.ts:8` |
| `--rn-android` | the same, `--conformance` build (it listens to the journey broadcasts) | `index.android.bundle.map` (Gradle) | the same | the same |

No target flag runs all three. `--no-build` reuses earlier builds; `--out <dir>` keeps the builds and each target's resolved stack (`<target>.json`). It exits 1 when a target misses its expectation and prints the frames it did resolve. About 3 minutes after the builds (the first RN builds take 10 to 20 minutes each).

**Not in CI** (like `../mobile-native` and `../mobile-android`): it needs simulators and an `ouo-env` stack in one job.

What it found and why the expectations look the way they do: [project/kb/rum-api-retirement/symbolication/simulator-e2e.md](../../../project/kb/rum-api-retirement/symbolication/simulator-e2e.md).
