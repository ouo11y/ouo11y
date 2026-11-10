# Client SDK safety: the golden rule

**The app must not pay for the SDK's failures.** The founder's most important SDK rule, turned into a checklist every ouo SDK (web, React Native, iOS, Android, later Flutter) is checked against. Researched 2026-11-10, ahead of Step 7. Start with the explainer.

| Path | What it is |
|---|---|
| [golden-rule.html](golden-rule.html) | Self-contained explainer: the rule, the checklist, the grades, filterable |
| [checklist/](checklist/index.md) | The 61-item checklist in 15 categories: MUST rule, motivating incident, platforms, automated test |
| [incidents/](incidents/index.md) | Real incidents from other vendors, ouo's own faults, and vendor safety guidance |
| [grades/](grades/index.md) | How web, React Native, iOS and Android score today, with `file:line` evidence |
| [spec-proposal/](spec-proposal/index.md) | How the rule enters the SDK spec in Step 7, and the fix order |
