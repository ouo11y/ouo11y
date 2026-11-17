# Symbolication end to end on simulators (2026-11-15)

Script: [tests/e2e/symbolication/run.sh](../../../../tests/e2e/symbolication/README.md). Stack: `ouo-env up <env> --muninn`. Simulators only (iOS 27 simulator, Android emulator `ouo-pixel` with `-read-only`), no phone.

## Verified live

| Target | Upload | Recorded | Resolved |
|---|---|---|---|
| Native iOS (`examples/ouo-ios`, Release, SwiftPM) | `upload-dsym` on `OuoExample.dSYM`: two slices (arm64, x86_64) under their LC_UUIDs | `exception` with `ouo.crash.frames` / `ouo.crash.images`, sent on the launch after the SIGSEGV | `crashForSymbolication` at `Journey.swift:167`, same as `atos` |
| RN Android (`examples/ouo-mobile`, Gradle release, Hermes) | `upload --bundle index.android.bundle --sourcemap index.android.bundle.map` (Gradle's composed map) | fatal `exception`, `ouo.exception.debug_ids` = `{"app:///index.android.bundle": "<id>"}` | `chargeCardForSymbolication` at `src/symbolication.ts:8` through the debug id |
| RN iOS (same app, Xcode Release, Hermes) | `upload --bundle main.jsbundle --sourcemap main.jsbundle.map` | same, `app:///main.jsbundle` | same |

Nothing in the SDKs, the CLI or `symbolicate` needed a fix: the path works as ADR-0026 describes.

## Traps (why the expectations look the way they do)

- **Hermes inlines.** `hermesc -O` inlined a small throwing function into the `setTimeout` arrow that called it. The recorded stack has one JavaScript frame (`anonymous`, a bytecode offset); the composed map names the inlined function and its line, so the resolved frame reads `chargeCardForSymbolication src/symbolication.ts:8`. Under the new architecture the timer callback is called from native code: there is no JS caller frame (no `callTimer`). Do not expect caller lines in a Hermes timer crash.
- **Swift merges identical closures.** The example's `crash` and `early` actions had the same closure body; the optimizer merged them (`…_Tm` suffix) and the merged code has no line in the dSYM. `symbolicate` returned the function with line 0, and so does `atos`. The `crash` action now calls an `@inline(never)` function of its own.
- **Swift names stay mangled.** `symbolicate` returns the linkage name (`$s10OuoExample21crashForSymbolicationyyF`); `atos` and Sentry demangle. A follow-up, not a bug of the resolver: the plugin shows mangled Swift names until it demangles (Go has no Swift demangler; options are a port of the demangler's common cases or demangling in the frontend).
- **iOS map without editing `.xcode.env`.** `SOURCEMAP_FILE` in the environment of `xcodebuild` reaches `react-native-xcode.sh`, so `scripts/build-ios.sh` needs no change to write the Hermes-composed map.
- **Muninn reads need the read token** (`mrt_dev_…` in dev); `ouo-symbolicate` takes it from `MUNINN_READ_TOKEN`, as the plugin backend does.
- **Android journey commands** are broadcasts that only `--conformance` (or debug) builds receive; the script builds with `--conformance`.
- **A fresh worktree** needs `npm ci` at the root before `sdk/react-native` builds (its type check fails on missing `react-native`), see [npm-in-worktrees.md](../../client-sdk-react-native/npm-in-worktrees.md).
