# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-mvp-architecture.md) | MVP architecture: OTel Collector + LGTM + rum-api + Grafana app plugin | accepted |
| [0002](0002-session-model.md) | Session model and identifiers | accepted |
| [0003](0003-replay-model.md) | One session, one replay, many chunks | accepted |
| [0004](0004-session-health-classification.md) | Healthy / errored / crashed classification | accepted |
| [0005](0005-languages-and-tooling.md) | Go for services, TypeScript for SDKs, plugin and apps | accepted |
| [0006](0006-mobile-replay-native-screenshots.md) | Mobile replay: native screenshot capture with view-hierarchy masking, iOS first | accepted |
| [0007](0007-ingest-gateway-project-tokens.md) | The collector is the edge: project tokens as Basic auth, replay receiver and exporter, rum-api internal (rev 2) | accepted |
| [0008](0008-sentry-sdk-bridge.md) | Sentry SDK bridge: `ouosentry` receiver in ouo-collector, forward to Sentry and translate to ouo, `video` replay kind | accepted |
| [0009](0009-org-and-product-naming.md) | Org and product naming: `ouo11y` everywhere, plain product names, `ouo` as the short internal namespace, three repos | accepted |
| [0010](0010-repository-layout.md) | Repository layout: product by component at the top, process material under `project/` | accepted |
| [0011](0011-source-maps-and-symbolication.md) | Source maps: debug ids with release + URL fallback, maps in the rum-api bucket, upload token, symbolication on read; revised 2026-10-29 for iOS dSYMs by build UUID (W7) | proposed |
| [0012](0012-funnel-reports.md) | Funnel reports: page and custom-event steps, session-counted, computed by rum-api from Loki | accepted |
| [0013](0013-session-to-session-review.md) | Session-to-session review: a second session reviews, both comment on the PR, the author merges with `merge-agreed.sh`; releases at checkpoints; push only what you are proud of | proposed |

Format: Context, Decision, Consequences. New ADRs are numbered sequentially and added here.
