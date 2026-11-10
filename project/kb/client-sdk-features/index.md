# Client SDK features

Which features the ouo web and mobile SDKs should have, compared with what Sentry, Datadog and PostHog ship on web, iOS, Android and React Native. Step 4 of the post-MVP plan, researched 2026-11-10. Start with the matrix.

| Path | What it is |
|---|---|
| [feature-matrix.html](feature-matrix.html) | Every feature, every vendor and platform, and our target, filterable, with configuration, defaults, limits and sources per cell |
| [target-list.md](target-list.md) | Which features do we target: must, should, later or never, why, and which spec section covers each? |
| [gaps-for-step-7.md](gaps-for-step-7.md) | What does the target list need that the SDK spec lacks, and how does Step 4 answer the spec's nine questions? |
| [catalog.md](catalog.md) | Which features exist, with the stable ids every other file uses? |
| [mobile-replay-format-evidence.md](mobile-replay-format-evidence.md) | What does the evidence say about wireframe and video mobile replay? Evidence only, no decision |
| [vendors/](vendors/index.md) | Per vendor and platform: has it, configuration, default, limits, source and date, for every catalog row |

The HTML matrix is generated from these Markdown files by `project/agents/sdk-features/scripts/build_matrix.py`. Edit the Markdown, then rebuild.
