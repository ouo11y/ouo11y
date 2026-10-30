# mobile-sdk

Owns the decisions of the ouo mobile SDK roadmap ([roadmap.md](../../kb/mobile-sdk-research/roadmap.md), W1–W10, agreed by the founder on 2026-10-29), the record of the sessions that carry them out, and the package code those sessions write (`sdk/ios`, the Expo module and JS of `sdk/react-native`, the small rum-api or plugin changes a package needs). One PR per package (ADR-0013 review). The spec and its conformance suite (W2) are `docs/specs/mobile-sdk.md`, ADR-0015 and `tests/e2e/mobile/`: each later package turns its own checks from pending to required, updates `tests/e2e/mobile/standin.cjs` when it changes the native module, and updates the spec's matrix.

- [tracker.md](tracker.md)
- [summaries/](summaries/index.md) dated run summaries
  - [2026-10-29-adr-0014-0016.md](summaries/2026-10-29-adr-0014-0016.md) ADR-0014 (tiles in `frames` schema 2) and ADR-0016 (OpenTelemetry in process)
  - [2026-10-29-w1-ios-capture.md](summaries/2026-10-29-w1-ios-capture.md) W1 production-safe iOS capture
  - [2026-10-29-w2-mobile-spec.md](summaries/2026-10-29-w2-mobile-spec.md) W2: the mobile SDK spec, ADR-0015 and the React Native iOS conformance suite
  - [2026-10-29-w7-symbolication.md](summaries/2026-10-29-w7-symbolication.md) W7: native iOS crash symbolication from dSYMs (ADR-0011 section 7)
  - [2026-10-30-w3a-schema2-player.md](summaries/2026-10-30-w3a-schema2-player.md) W3a step 1: `frames` schema 2, canvas player
- `verify/` reproducible checks
  - [w7-dsym-e2e.sh](verify/w7-dsym-e2e.sh) a real `OuoCrashProbe` crash through the collector, dSYM upload with the CLI, rum-api frames compared with `atos -i`
