# Changelog index

ouo packages are versioned independently (see `docs/releasing.md`). This file only points
at the per-package changelogs and records which versions were released together. Do not
add per-package entries here.

## Rename to ouo11y (2026-10-18, ADR-0009)

The repo moved to `github.com/ouo11y/ouo11y` and every published identifier moved with it.
Each package's own changelog has the details under Unreleased.

- npm: `@ouo/browser` is `@ouo11y/browser`, `@ouo/react-native` is `@ouo11y/react-native`.
  Neither was published to npm under the old name, so there is nothing to deprecate.
- Go modules: `github.com/ZiadMansourM/ouo/...` is `github.com/ouo11y/ouo11y/...`.
- Images: `ghcr.io/ziadmansourm/ouo/{collector,rum-api,grafana}` is
  `ghcr.io/ouo11y/{collector,rum-api,grafana}`. The 0.2.0 images exist only under the old
  path; `deploy/compose/compose.images.yaml`, the Helm chart and the examples point at the new
  path, so they pull only once the next tags are released.
- Grafana plugin ID: `ouo-rum-app` is `ouo11y-rum-app` (folder `plugins/ouo11y-rum-app`).
  Grafana treats it as a new plugin: see the plugin's changelog for moving an existing install.
- SwiftPM: package name `ouo11y-ios`, mirror repo `github.com/ouo11y/ouo11y-ios`; products
  `OuoReplay` and `OuoReplayCore` keep their names.
- Unchanged: `ouo.` attributes, the `ouosentry`, `ouoreplay` and `ouoratelimit` components,
  `OUO_*` variables, the Helm chart name `ouo`.

## Packages

| Package | Current version | Changelog | Tag prefix |
|---|---|---|---|
| `@ouo11y/browser` (was `@ouo/browser`) | 0.2.0 | [sdk/browser/CHANGELOG.md](sdk/browser/CHANGELOG.md) | `browser-v` |
| `@ouo11y/react-native` (was `@ouo/react-native`) | 0.2.0 | [sdk/react-native/CHANGELOG.md](sdk/react-native/CHANGELOG.md) | `react-native-v` |
| `OuoReplay` (Swift) | unreleased | `sdk/ios/CHANGELOG.md` (to be created by the ios-replay agent at the first `ios-v` tag) | `ios-v` |
| `ouo11y-rum-app` (Grafana plugin, was `ouo-rum-app`) | 0.7.0 (not tagged; baked into the grafana 0.3.0 image) | [plugins/ouo11y-rum-app/CHANGELOG.md](plugins/ouo11y-rum-app/CHANGELOG.md) | `plugin-v` |
| `rum-api` | 0.3.0 (prepared 2026-10-18, tag pending) | [services/rum-api/CHANGELOG.md](services/rum-api/CHANGELOG.md) | `rum-api-v` |
| `grafana` image | 0.3.0 (prepared 2026-10-18, tag pending, plugin 0.7.0 inside) | [deploy/images/grafana/CHANGELOG.md](deploy/images/grafana/CHANGELOG.md) | `grafana-v` |
| `collector` image (ouo-collector) | 0.3.0 (prepared 2026-10-18, tag pending) | [collector/CHANGELOG.md](collector/CHANGELOG.md) | `collector-v` |
| Helm chart `ouo` | unreleased | `deploy/helm/ouo/CHANGELOG.md` (helm agent) | `chart-v` |

## Release trains

Versions that were released and verified together. A row is added when the qa agent has
run the upgrade procedure (`docs/operations/upgrade.md`) for that combination.

| Date | rum-api | collector | grafana image | chart | plugin | @ouo11y/browser | @ouo11y/react-native | OuoReplay | Verified by |
|---|---|---|---|---|---|---|---|---|---|
| (none yet) | | | | | | | | | |

## Before tags existed

Phases 1 to 7 (MVP) shipped on `main` without tags; their history is in `project/tracker/mvp.md`
and the per-agent summaries under `project/agents/`. The first tagged versions are the Phase 8a
ones above.
