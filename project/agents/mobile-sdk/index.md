# mobile-sdk

Owns the decisions of the ouo mobile SDK roadmap ([roadmap.md](../../kb/mobile-sdk-research/roadmap.md), W1–W10, agreed by the founder on 2026-10-29), the record of the sessions that carry them out, and the package code those sessions write (`sdk/ios`, the Expo module and JS of `sdk/react-native`, the small rum-api or plugin changes a package needs). One PR per package (ADR-0013 review). The spec and its conformance suite (W2) are `docs/specs/mobile-sdk.md`, ADR-0015 and `tests/e2e/mobile/`: each later package turns its own checks from pending to required, updates `tests/e2e/mobile/standin.cjs` when it changes the native module, and updates the spec's matrix.

- [tracker.md](tracker.md)
- [summaries/](summaries/index.md) dated run summaries
  - [2026-10-29-adr-0014-0016.md](summaries/2026-10-29-adr-0014-0016.md) ADR-0014 (tiles in `frames` schema 2) and ADR-0016 (OpenTelemetry in process)
  - [2026-10-29-w1-ios-capture.md](summaries/2026-10-29-w1-ios-capture.md) W1 production-safe iOS capture
  - [2026-10-29-w2-mobile-spec.md](summaries/2026-10-29-w2-mobile-spec.md) W2: the mobile SDK spec, ADR-0015 and the React Native iOS conformance suite
  - [2026-10-29-w7-symbolication.md](summaries/2026-10-29-w7-symbolication.md) W7: native iOS crash symbolication from dSYMs (ADR-0011 section 7)
  - [2026-10-30-w3a-schema2-player.md](summaries/2026-10-30-w3a-schema2-player.md) W3a step 1: `frames` schema 2, canvas player
  - [2026-10-30-w3a-swift-tiles.md](summaries/2026-10-30-w3a-swift-tiles.md) W3a step 2: Swift tiles, B3 T3 120 / T4 334 KiB/min
  - [2026-10-30-w4-signals.md](summaries/2026-10-30-w4-signals.md) W4: app hangs, foreground terminations, TTFD and error context
  - [2026-10-31-w8-native-ios-part1.md](summaries/2026-10-31-w8-native-ios-part1.md) W8 part 1: the native iOS SDK `OuoSDK`
  - [2026-10-31-w8-native-ios-part2.md](summaries/2026-10-31-w8-native-ios-part2.md) W8 part 2: screens, taps, SwiftUI masking, the native example and its suite
- `verify/` reproducible checks
  - [w7-dsym-e2e.sh](verify/w7-dsym-e2e.sh) a real `OuoCrashProbe` crash through the collector, dSYM upload with the CLI, rum-api frames compared with `atos -i`
  - [w4-signals-sim.sh](verify/w4-signals-sim.sh) the real hang watchdog and termination check in examples/ouo-mobile on a simulator: a 3 s block, a stutter, a simulated out-of-memory kill, kills in the background and the foreground, read back from rum-api
  - [w8-native-sim.sh](verify/w8-native-sim.sh) the `OuoSDK` package in a UIKit app ([w8-native-sim/](verify/w8-native-sim/Package.swift)) on a simulator: a journey with a background rotation, a hang, a crash, a memory kill and an offline run, read back from rum-api by [w8-native-sim-check.mjs](verify/w8-native-sim-check.mjs)
