# sdk-state

Step 5 of the post-MVP plan: the current state of the ouo browser, iOS, Android and React Native SDKs, against the draft SDK spec, against Sentry, and on device overhead.

- Owns: `project/kb/client-sdk-state/`, the audit data and results in `findings/`, the generators in `scripts/`, and the measurement harnesses in `measure/`.
- Does not change SDK code (Step 12 refines the SDKs), the spec (Step 7 reviews it), or research vendor internals (Step 6).

| File | Content |
|---|---|
| [tracker.md](tracker.md) | What was done and what is open |
| [summaries/](summaries/index.md) | Dated run summaries |
| [findings/](findings/index.md) | Audit files per SDK, the requirement and feature lists they graded, effort sizes, gaps, overhead numbers, proposed budgets |
| [scripts/](scripts/index.md) | `build_gaps.py`, `summarize_overhead.py`, `build_report.py` |
| [measure/](measure/index.md) | Overhead harnesses: web (Chromium), iOS (simulator), Android (emulator) |
| [The kb entries](../../kb/client-sdk-state/index.md) | Compliance, Sentry gaps, overhead and budgets, HTML report |
