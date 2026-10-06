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

Folders for agents that have not run yet are created by the orchestrator when the phase starts.
