# Changelog index

ouo packages are versioned independently (see `docs/releasing.md`). This file only points
at the per-package changelogs and records which versions were released together. Do not
add per-package entries here.

## Packages

| Package | Current version | Changelog | Tag prefix |
|---|---|---|---|
| `@ouo/browser` | 0.2.0 | [sdk/browser/CHANGELOG.md](sdk/browser/CHANGELOG.md) | `browser-v` |
| `@ouo/react-native` | 0.2.0 | [sdk/react-native/CHANGELOG.md](sdk/react-native/CHANGELOG.md) | `react-native-v` |
| `OuoReplay` (Swift) | unreleased | `sdk/ios/CHANGELOG.md` (to be created by the ios-replay agent at the first `ios-v` tag) | `ios-v` |
| `ouo-rum-app` (Grafana plugin) | 0.3.0 | [plugins/ouo-rum-app/CHANGELOG.md](plugins/ouo-rum-app/CHANGELOG.md) | `plugin-v` |
| `rum-api` | unreleased (first: 0.2.0, after the YAML config + S3 work) | `services/rum-api/CHANGELOG.md` (to be created by the rum-api agent at the first `rum-api-v` tag) | `rum-api-v` |
| `grafana` image | unreleased (first: 0.2.0) | [deploy/images/grafana/CHANGELOG.md](deploy/images/grafana/CHANGELOG.md) | `grafana-v` |
| `collector` image (ouo-collector) | unreleased (first: 0.2.0) | [collector/CHANGELOG.md](collector/CHANGELOG.md) | `collector-v` |
| Helm chart `ouo` | unreleased | `deploy/helm/ouo/CHANGELOG.md` (helm agent) | `chart-v` |

## Release trains

Versions that were released and verified together. A row is added when the qa agent has
run the upgrade procedure (`docs/operations/upgrade.md`) for that combination.

| Date | rum-api | collector | grafana image | chart | plugin | @ouo/browser | @ouo/react-native | OuoReplay | Verified by |
|---|---|---|---|---|---|---|---|---|---|
| (none yet) | | | | | | | | | |

## Before tags existed

Phases 1 to 7 (MVP) shipped on `main` without tags; their history is in `project/tracker/mvp.md`
and the per-agent summaries under `project/agents/`. The first tagged versions are the Phase 8a
ones above.
