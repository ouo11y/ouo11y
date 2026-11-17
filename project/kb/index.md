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
| [muninn/](muninn/index.md) | The replay store (step 8): how a replay chunk travels from an SDK through the Collector into Muninn and back to a player, what the Collector guarantees, with an HTML explainer; what building it and its Collector config taught (read-path gzip pitfalls, ocb and MinIO quirks) |
| [plugin/](plugin/index.md) | A client's own Grafana plugin on ouo11y data: building a plugin's Go backend, Loki answers as it reads them, how it gets the user's identity-provider tokens (only a datasource with `oauthPassThru`), and where `libs/ouo-go` and `@ouo11y/kit` fit (ADR-0025) |
| [rum-api-retirement/](rum-api-retirement/index.md) | What `services/rum-api` still held before deletion (debug files, erasure audit log) and where each duty goes (ADR-0026) |
| [symbolication/](symbolication/index.md) | Resolving recorded stacks with uploaded debug files: the R8 mapping format and the Android retrace check (ADR-0027) |
| [ci/](ci/index.md) | How the GitHub Actions workflows run: every job on GitHub-hosted runners since the repo went public, and why the self-hosted ones no longer serve it |
