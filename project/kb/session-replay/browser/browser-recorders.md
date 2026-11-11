# Browser recorders

Explainer: [topic 4](../session-replay-explainer.html#t4), with a step-through flow per vendor. Citations: [browser-source-notes.md](browser-source-notes.md). Bytes and wire formats: Step 6 [sentry/browser-sdk/replay-browser.md](../../vendor-internals/sentry/browser-sdk/replay-browser.md) and [datadog/wire-format/browser-replay-format.md](../../vendor-internals/datadog/wire-format/browser-replay-format.md).

| Recorder | Engine | Notable choices |
|---|---|---|
| rrweb 2.2.2 | full snapshot with node ids, a Mirror (id ↔ node), observers, one Mutation event per observer callback | replay rebuilds the DOM in a sandboxed iframe; seeking applies deltas to a virtual DOM first |
| Sentry (sentry-javascript 11.11.0, getsentry/rrweb fork) | rrweb fork | session or error-buffer mode, checkout every 60 s in buffer mode, stops above 10,000 mutations in one batch, compresses with fflate in a worker, flushes on a 5 s debounce (5.5 s max) |
| PostHog (posthog-js 1.447.9) | rrweb fork, lazy-loaded | token-bucket throttle for noisy mutations, per-field gzip of large event fields, flush at 2 s or 0.9 MB |
| Datadog (browser-sdk v7.17.1) | own recorder | mutations mark nodes dirty and are processed in idle callbacks; snapshots and deltas are compact Change records; segments of at most 5 s or 60,000 compressed bytes with a sync-flush trailer so a segment can close at unload |
| OpenReplay v1.28.0 | own recorder | binary message encoding |
| Highlight 3bf0021 | rrweb | checkouts at 10 MB or 4 min |
| Clarity v0.8.77 | own recorder | suspends recording of mutations that repeat |

Common pattern: serialise once, then stream small deltas; mask while serialising, so masking cannot miss; spend the engineering on throttling mutation storms and moving compression off the main thread.
