# Agents

One folder per agent or team. Each folder has `index.md`, `tracker.md` and `summaries/`. Reports are HTML under `reports/` inside the folder. All of it lives under `project/` (ADR-0010).

| Agent | Owns | Phase |
|---|---|---|
| [orchestrator](orchestrator/) | phase planning, hand-offs, PRs, this index | all |
| [platform-infra](platform-infra/) | `deploy/` (compose, collector, Grafana provisioning) | 1 |
| [backend-demo](backend-demo/) | `examples/backend` (Go API with OTel) | 1 |
| [sdk-browser](sdk-browser/) | `sdk/browser` | 2 |
| [web-demo](web-demo/) | `examples/ouo-web` | 2 |
| [rum-api](rum-api/) | `services/rum-api` | 3 |
| [grafana-plugin](grafana-plugin/) | `plugins/ouo11y-rum-app` | 4 |
| [sdk-react-native](sdk-react-native/) | `sdk/react-native`, `examples/ouo-mobile` | 5 |
| [qa](qa/) | end-to-end verification, `project/reports/` | 6 |
| [ios-replay](ios-replay/) | `sdk/ios`, Expo module in `sdk/react-native` (`ios/`, `android/`, `src/replay.ts`), replay in `examples/ouo-mobile` | 7 |
| [fast-tracked](fast-tracked/) | `examples/fast-tracked` onboarding guides (stack, Go backend, React, Expo iOS), `examples/quickstarts` standalone apps | docs |
| [collector](collector/) | `collector/` custom distribution (ocb), replay receiver and exporter, rate limit processor, `deploy/compose/collector/` config and htpasswd | 8a |
| [helm](helm/) | `deploy/helm` Kubernetes chart and kind verification | 8a |
| [release](release/) | versioning, changelogs, package publishing workflows, upgrade procedure (`.github/`, `CHANGELOG.md`, package manifests) | 8a |
| [sentry-demo](sentry-demo/) | `examples/sentry-mobile` (Expo iOS app with `@sentry/react-native`, `ouo.rum.mode` rollout switch to `@ouo11y/react-native`, journey driver, envelope capture for the Sentry bridge); since batch 2 also the three examples' journeys, `verify` scripts and `examples/tools` (trace-continuity checks) | ADR-0008 |
| [benchmark](benchmark/) | device-cost benchmark ouo vs Sentry (B3): `examples/sentry-mobile/scripts/perf/`, `.github/workflows/benchmark.yml`, `project/reports/benchmarks/`, `docs/benchmarks.md`; iPhone run N22 | B3 |
| [mobile-sdk-research](mobile-sdk-research/) | `project/kb-archive/mobile-sdk-research/` research on Sentry, PostHog, Luciq and the field (RUM, replay techniques, wire size, footprint methods, OTel, feature matrix) for phases 10 and 13 | research |
| [mobile-sdk](mobile-sdk/) | the ouo mobile SDK roadmap W1–W10 ([roadmap](../kb-archive/mobile-sdk-research/roadmap.md)): its ADRs (0014, 0015, 0016), the spec `docs/specs/mobile-sdk.md` and its conformance suite `tests/e2e/mobile/`, the sessions that build it, and the package code they write (`sdk/ios`, the Expo module and JS of `sdk/react-native`, the rum-api and plugin pieces a package needs) | W1–W10 |
| [web-sdk-research](web-sdk-research/) | `project/kb-archive/web-sdk-research/` research on Sentry, Datadog, PostHog, Faro and the OTel-shaped vendors, the replay specialists and the field on the web (RUM, replay, bundle and wire cost measured on one page, OTel, 25-vendor matrix), ouo's web stack today, and the web roadmap (WB1–WB10) | research |
| [otel-data-models](otel-data-models/) | Step 1 of the post-MVP plan: `project/kb/opentelemetry/`, explaining OTel logs, traces, metrics and OTLP from primary sources | post-MVP step 1 |
| [rum-semconv](rum-semconv/) | Step 2 of the post-MVP plan: `project/kb/opentelemetry/rum-semantic-conventions/`, on RUM conventions, predictions, and which signals are events or spans | post-MVP step 2 |
| [sdk-spec](sdk-spec/) | Step 3 of the post-MVP plan: the draft SDK spec, `project/kb/opentelemetry/rum-semantic-conventions/sdk-spec.md` | post-MVP step 3 |
| [sdk-features](sdk-features/) | Step 4 of the post-MVP plan: `project/kb/client-sdk-features/`, the feature catalog, vendor comparison, target list and spec gaps | post-MVP step 4 |
| [sdk-safety](sdk-safety/) | The golden rule, "the app must not pay for the SDK's failures": `project/kb/client-sdk-safety/`, checklist, incidents, SDK grades and spec proposal | before post-MVP step 7 |

Folders for agents that have not run yet are created by the orchestrator when the phase starts.
