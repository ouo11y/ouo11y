# Client SDK state

Where the ouo browser, iOS, Android and React Native SDKs on `main` stand: against the draft SDK spec, against Sentry's SDKs, and on device overhead. Step 5 of the post-MVP plan, measured 2026-11-10 at commit `3e9e2c11`. Start with the report.

| Path | What it is |
|---|---|
| [sdk-state-report.html](sdk-state-report.html) | Every requirement per SDK with evidence, the Sentry gap matrix, the overhead charts and the proposed budgets, filterable |
| [compliance.md](compliance.md) | How many spec MUSTs does each SDK meet, and what are the structural differences? |
| [sentry-gaps.md](sentry-gaps.md) | Feature by feature, how far behind or ahead of Sentry is each SDK, and how big is the work? |
| [overhead.md](overhead.md) | What do the SDKs cost in bundle, CPU, memory and bytes, next to Sentry, and what budgets should spec section 13 set? |

The report is generated from [`project/agents/sdk-state/findings/`](../../agents/sdk-state/findings/index.md) by the scripts in [`project/agents/sdk-state/scripts/`](../../agents/sdk-state/scripts/index.md). Edit the data, then rebuild.
