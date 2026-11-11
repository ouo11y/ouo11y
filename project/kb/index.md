# Knowledge base

The knowledge base for the post-MVP work. Entries live in descriptive topic folders, `project/kb/<area>/<subject>/<topic>.md`, and every folder has an `index.md`. Add one line here for every new area.

MVP-era knowledge is in [kb-archive](../kb-archive/index.md). It was mostly written by AI without founder review, so check anything you take from it before relying on it.

| Area | What it covers |
|---|---|
| [opentelemetry/](opentelemetry/index.md) | Logs, traces and metrics data models, OTLP, storage backends, RUM semantic conventions, with HTML explainers |
| [client-sdk-features/](client-sdk-features/index.md) | Which features our web and mobile SDKs target, compared with Sentry, Datadog and PostHog, with an HTML matrix and the spec gaps for Step 7 |
| [client-sdk-state/](client-sdk-state/index.md) | How the four SDKs on `main` meet the draft spec, where they stand against Sentry, and what they cost on a device, with proposed overhead budgets and an HTML report |
| [client-sdk-safety/](client-sdk-safety/index.md) | The golden rule, "the app must not pay for the SDK's failures", as a 61-item checklist with incidents, grades of our four SDKs, and the spec proposal for Step 7 |
| [vendor-internals/](vendor-internals/index.md) | How Sentry, Datadog and PostHog work inside on web and mobile: SDK architecture and options, wire formats with captured fixtures, reliability, storage, and the read APIs Muninn can use, with HTML explainers |
| [session-replay/](session-replay/index.md) | How session replay works inside on the browser, iOS, Android, React Native and Flutter, from source at pinned tags, as seven topics with an animated HTML explainer; replay as six steps and what to borrow |
