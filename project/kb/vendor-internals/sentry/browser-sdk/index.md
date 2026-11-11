# Sentry browser SDK internals

How the Sentry JavaScript browser SDK works inside, what it sends, and how reliably. Step 6 (vendor research), researched 2026-11-10 against `@sentry/browser` and `@sentry/react` **11.11.0** (released 2026-11-05), compared with the maintained 10.x line (10.78.0). Wire captures are from self-hosted Sentry 26.10.0. Feature lists and defaults per catalog row are in Step 4's [sentry-web.md](../../../client-sdk-features/vendors/sentry-web.md); this folder goes deeper. Start with the explainer.

| Path | What it is |
|---|---|
| [browser-sdk-explainer.html](browser-sdk-explainer.html) | How does a call become an HTTP request, and how does a replay segment get out? Diagrams and the main numbers on one page |
| [architecture.md](architecture.md) | How do init, the client, scopes, integrations, event processors, envelopes and the transport fit together, and where are the hooks? |
| [configuration.md](configuration.md) | What does every `init` option and integration option do, with its default and source line? |
| [sampling.md](sampling.md) | Where exactly are errors, traces, replays and profiles sampled, and what travels in `sentry-trace`, `baggage` and the DSC? |
| [reliability.md](reliability.md) | What happens on page hide, on a full buffer, offline, on 429 and when a tab closes mid-replay? |
| [replay-browser.md](replay-browser.md) | How does session replay record, buffer, flush, compress and link to errors, with every constant? |
| [wire-capture.md](wire-capture.md) | What does each envelope and item look like on the wire, byte for byte, as observed? |
| [footprint.md](footprint.md) | How many KiB does each feature add to a tree-shaken bundle, and how big are the CDN bundles? |
| [fixtures/](fixtures/index.md) | Which raw captured envelopes can I replay or parse (errors, spans, logs, metrics, profiles, replays, client reports)? |

The demo that produced the captures is [examples/sentry-web/](../../../../../examples/sentry-web/README.md).
