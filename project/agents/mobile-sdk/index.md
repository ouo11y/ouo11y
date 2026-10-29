# mobile-sdk

Owns the decisions of the ouo mobile SDK roadmap ([roadmap.md](../../kb/mobile-sdk-research/roadmap.md), W1–W10, agreed by the founder on 2026-10-29) and the record of the sessions that carry them out. Code lives with the package owners (`sdk/ios`, `sdk/react-native`, later `sdk/android`); this folder holds the run summaries.

- [tracker.md](tracker.md)
- `summaries/` dated run summaries
  - [2026-10-29-w7-symbolication.md](summaries/2026-10-29-w7-symbolication.md) W7: native iOS crash symbolication from dSYMs (ADR-0011 section 7)
- `verify/` reproducible checks
  - [w7-dsym-e2e.sh](verify/w7-dsym-e2e.sh) a real `OuoCrashProbe` crash through the collector, dSYM upload with the CLI, rum-api frames compared with `atos -i`
