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
| [client-sdk-web/](client-sdk-web/index.md) | How `@ouo11y/browser` is built after its rebuild on the spec (ADR-0018): per-requirement compliance report, architecture, the replay format on the wire, and the OpenTelemetry JS and browser quirks met on the way |
| [client-sdk-react-native/](client-sdk-react-native/index.md) | How `@ouo11y/react-native` is built while it moves to the spec (ADR-0021): the layers step A added, what building them taught us, and the npm-in-worktrees trap |
| [session-replay/](session-replay/index.md) | How session replay works inside and what ouo can borrow; the Sentry iOS recorder spike, the Android `pixel/video` port and the `structure/wireframe` recorder choice (seam maps, sync scripts, measurements). PR #178 adds the explainer topics |
