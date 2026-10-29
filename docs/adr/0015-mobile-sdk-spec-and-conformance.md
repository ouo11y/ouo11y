# ADR-0015 Mobile SDK spec: twelve capabilities, conformance checks per package, maturity L0–L3

Status: accepted (2026-10-29, with the roadmap and its W2 package); two departures from the roadmap's wording, taps staying `ui.tap` (decision 1) and the Node suite (decision 4), to be confirmed by the founder at the next checkpoint.

## Context

The founder decided on one ouo SDK spec with a conformance suite, implemented per platform in roadmap order (checklist N17, decision (b)), and on 2026-10-29 approved the mobile SDK roadmap ([roadmap.md](../../project/kb/mobile-sdk-research/roadmap.md)) whose W2 package is that spec. Today the mobile records are spread over four specs (session lifecycle, vitals, replay, funnels) plus the Sentry bridge spec, and whether a platform "has" a capability is an opinion: nothing says which records a capability needs or how to prove a platform emits them. Ten more packages (W1, W3–W10) will each change one or more capabilities on React Native, then native iOS, Android and Flutter, so each needs a pass/fail it can turn on.

Options considered for the conformance suite:

1. **A synthetic golden session** (OTLP posted by the test, like `tests/e2e/scenario.mjs` does for health): it tests rum-api only. Every check passes whatever the SDK does.
2. **A recorded capture from the simulator, replayed in CI** (like the bridge's golden Sentry captures): real native output, but it goes stale the moment the SDK changes, and recording the full journey (two crashes, a foreground kill, an offline run) on a simulator for every package is slow.
3. **The SDK's own code in Node against the real stack**, with the React Native and native module stand-ins: what CI already does for `examples/ouo-mobile` and the `rn-background` test. It runs on every PR on Linux and catches regressions in the JavaScript SDK, the native module contract and the backend together. Native behaviour is modelled, not run.

## Decision

1. **One spec, [docs/specs/mobile-sdk.md](../specs/mobile-sdk.md)**, with twelve capabilities (C1 sessions, C2 errors and crashes, C3 hangs and terminations, C4 vitals, C5 network, C6 interactions, C7 screens, C8 replay, C9 span and log API, C10 feedback, C11 delivery, C12 cost). Each lists its records, required attributes, thresholds and conformance checks, and links the existing specs instead of repeating them. Existing names are kept: taps stay `ui.tap` (what the bridge already emits; the roadmap's `app.screen.click` is semconv's event for a coordinate click and would rename a record two producers already share), hangs stay an `exception` (as [mobile-vitals.md](../specs/mobile-vitals.md) decided and the bridge maps Sentry's `AppHang`) with `ouo.exception.kind = hang`.
2. **Maturity per capability and platform, L0 to L3**: not available, basic (records but failing or missing checks), conformant (every check passes in CI), benchmarked (conformant plus a B3 cell with the release gate). The spec holds the matrix; the suite prints the row it measures.
3. **One conformance suite per package**, with the same check ids: `@ouo11y/react-native` (iOS, later Android), the native iOS package, the native Android package. **Objective-C and Java are API surfaces** of the native packages (a smoke target per language compiles against the public API), not separate implementations with their own suite.
4. **The React Native iOS suite is option 3**: `tests/e2e/mobile/conformance.mjs` runs launches of the built bundle in Node under `standin.cjs`, a model of the `OuoReplay` Expo module and the OS, then asserts rum-api. The model follows the Swift code; a package that changes the native module changes the model in the same PR. Native behaviour itself stays covered by the native package's tests and the simulator run of the example app.
5. **Pending checks**: a check whose package has not landed is marked with that package, runs and reports without failing CI, and fails the run once it passes, until the package marks it required. C2.3, C3, C4.2, C6.1, C8.3, C10.1 and C11 start pending.
6. **C12 is not an e2e check**: cost is the B3 benchmark and its release gate ([benchmarks.md](../benchmarks.md)).

## Consequences

- Every later package has its definition of done in check ids, and the matrix moves only when CI says so. Today's row for React Native iOS: L2 on C1, C5, C7, C9; L1 on C2, C4, C6, C8, C11, C12; L0 on C3, C10.
- The suite runs in about two minutes inside the existing `examples` job (the stack, the backend and the SDK build are already there), with no new framework and no simulator in CI.
- The model can drift from the Swift code. The rule in decision 4 and the simulator run are the guard; when the native iOS package (W8) gets its own suite, that suite runs the real native code on a simulator.
- Records marked *draft* in the spec (C3, the C6 additions, C10, the C11 store) are fixed by their package without a new ADR; renaming anything else, or adding a capability, needs one.
- Android and Flutter suites reuse the check ids and the same rum-api assertions; only the driver changes.
