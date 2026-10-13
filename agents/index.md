# Agents

One folder per agent or team. Each folder has `index.md`, `tracker.md` and `summaries/`. Reports are HTML under `reports/` inside the folder.

| Agent | Owns | Phase |
|---|---|---|
| [orchestrator](orchestrator/) | phase planning, hand-offs, PRs, this index | all |
| [platform-infra](platform-infra/) | `deploy/` (compose, collector, Grafana provisioning) | 1 |
| [backend-demo](backend-demo/) | `examples/backend` (Go API with OTel) | 1 |
| [sdk-browser](sdk-browser/) | `sdk/browser` | 2 |
| [web-demo](web-demo/) | `examples/web` | 2 |
| [rum-api](rum-api/) | `services/rum-api` | 3 |
| [grafana-plugin](grafana-plugin/) | `plugins/ouo-rum-app` | 4 |
| [sdk-react-native](sdk-react-native/) | `sdk/react-native`, `examples/mobile` | 5 |
| [qa](qa/) | end-to-end verification, `reports/` | 6 |
| [ios-replay](ios-replay/) | `sdk/ios`, Expo module in `sdk/react-native` (`ios/`, `android/`, `src/replay.ts`), replay in `examples/mobile` | 7 |
| [fast-tracked](fast-tracked/) | `examples/fast-tracked` onboarding guides (stack, Go backend, React, Expo iOS) | docs |
| [collector](collector/) | `collector/` custom distribution (ocb), replay receiver and exporter, rate limit processor, `deploy/docker/collector/` config and htpasswd | 8a |
| [helm](helm/) | `deploy/helm` Kubernetes chart and kind verification | 8a |
| [release](release/) | versioning, changelogs, package publishing workflows, upgrade procedure (`.github/`, `CHANGELOG.md`, package manifests) | 8a |
| [sentry-demo](sentry-demo/) | `examples/sentry-mobile` (Expo iOS app with `@sentry/react-native` only, journey driver, envelope capture for the Sentry bridge) | ADR-0008 |

Folders for agents that have not run yet are created by the orchestrator when the phase starts.
