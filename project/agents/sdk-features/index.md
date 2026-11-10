# sdk-features

Step 4 of the post-MVP plan: which features the ouo web and mobile SDKs target, compared with Sentry, Datadog and PostHog.

- Owns: `project/kb/client-sdk-features/` and the generator in `scripts/`.
- Does not change the SDK spec (Step 7 reviews it with these gaps), measure SDKs (Step 5), research vendor internals (Step 6), or decide the mobile replay format.

| File | Content |
|---|---|
| [tracker.md](tracker.md) | What was done and what is open |
| [summaries/](summaries/index.md) | Dated run summaries |
| [scripts/build_matrix.py](scripts/build_matrix.py) | Builds `feature-matrix.html` from the kb Markdown; template in `scripts/matrix_template.html.in` |
| [The kb entries](../../kb/client-sdk-features/index.md) | Catalog, vendor research, target list, gaps, matrix |
