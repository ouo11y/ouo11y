# 2026-11-15: symbolication end to end on simulators

## Done

- `tests/e2e/symbolication/run.sh` (+ README): builds release apps, uploads debug files with `ouo-sourcemaps` to Muninn, crashes them on simulators, reads the exception from Loki and resolves it with `libs/ouo-go/symbolicate`, asserts function, file and line; exit 1 on a mismatch. Targets `--native-ios`, `--rn-ios`, `--rn-android`.
- `libs/ouo-go/cmd/ouo-symbolicate` (+ test): the read side, Loki record -> `symbolicate.Resolve` -> JSON.
- `examples/ouo-mobile`: journey command `action/js-crash` (`src/symbolication.ts`, a fatal JS error from a timer).
- `examples/ouo-ios`: the `crash` action calls `@inline(never) crashForSymbolication()`, so the dSYM has its line (identical closures were merged and lost it).
- kb: [symbolication/simulator-e2e.md](../../../kb/rum-api-retirement/symbolication/simulator-e2e.md).

## Verified, and how

On env `mystifying-lovelace-022c45` (`--muninn`), iOS 27 simulator and Android emulator (`ouo-pixel`, `-read-only`): all three targets PASS, first one by one, then one full run with builds. Native: `crashForSymbolication` at `Journey.swift:167`, cross-checked with `atos`. RN Android and iOS: `chargeCardForSymbolication` at `src/symbolication.ts:8` by debug id. A wrong expectation made the script print the resolved frames and exit 1. `go test` / `go vet` of `libs/ouo-go` pass.

## Left / next

- No bug found in the SDKs, CLI or `symbolicate`. Gap: Swift names stay mangled (no demangler in Go); the plugin shows `$s10OuoExample21crashForSymbolicationyyF`. Worth a task.
- Not in CI: needs simulators plus an `ouo-env` stack in one job (same as `mobile-native`, `mobile-android`).
- No dependency added.
