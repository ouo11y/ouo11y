# vendor-research

Step 6 of the post-MVP plan: research Sentry (main focus), Datadog and PostHog in depth on web and mobile.

- Owns: `project/kb/vendor-internals/`, the capture demos `examples/sentry-web/`, `examples/datadog-capture/`, `examples/posthog-capture/`, and demo-only additions to `examples/sentry-mobile/` (flag-gated, defaults unchanged).
- Does not change product code, the SDK spec (Step 7 reviews it), measure SDK overhead (Step 5, `project/kb/client-sdk-state/`), or decide the mobile replay format.
- Ran as one coordinator plus six research agents (sentry-browser, sentry-mobile, sentry-wire-storage, sentry-read-api, datadog, posthog), each owning one kb folder.

| File | Content |
|---|---|
| [tracker.md](tracker.md) | What was done and what is open |
| [summaries/](summaries/index.md) | Dated run summaries, one per research agent plus the coordinator's |
| [The kb entries](../../kb/vendor-internals/index.md) | Sentry, Datadog and PostHog internals |
