# Changelog index

ouo packages are versioned independently (see `docs/releasing.md`). This file only points
at the per-package changelogs and records which versions were released together. Do not
add per-package entries here. Since 2026-10-23 release-please proposes each package's next
version and changelog section in a release PR; the versions it starts from are in
`.github/release-please/manifest.json`, which versions work together in
[docs/compatibility.md](docs/compatibility.md).

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
| `@ouo11y/browser` (was `@ouo/browser`) | 0.3.1 (npm, 2026-11-01) | [sdk/browser/CHANGELOG.md](sdk/browser/CHANGELOG.md) | `browser-v` |
| `@ouo11y/react-native` (was `@ouo/react-native`) | 0.3.0 (npm, 2026-11-01) | [sdk/react-native/CHANGELOG.md](sdk/react-native/CHANGELOG.md) | `react-native-v` |
| Swift package `ouo11y-ios` (`OuoSDK`, `OuoReplay`, ...) | 0.3.0 (tagged 2026-10-31; the mirror push waits for its deploy key) | [sdk/ios/CHANGELOG.md](sdk/ios/CHANGELOG.md) | `ios-v` |
| `ouo11y-rum-app` (Grafana plugin, was `ouo-rum-app`) | 0.10.0 (released 2026-10-31; inside the grafana image 0.6.0) | [plugins/ouo11y-rum-app/CHANGELOG.md](plugins/ouo11y-rum-app/CHANGELOG.md) | `plugin-v` |
| `rum-api` | 0.6.0 (released 2026-10-31) | [services/rum-api/CHANGELOG.md](services/rum-api/CHANGELOG.md) | `rum-api-v` |
| `grafana` image | 0.6.0 (released 2026-10-31, Grafana 13.2.5, plugin 0.10.0 inside) | [deploy/images/grafana/CHANGELOG.md](deploy/images/grafana/CHANGELOG.md) | `grafana-v` |
| `collector` image (ouo-collector) | 0.5.0 (released 2026-10-31) | [collector/CHANGELOG.md](collector/CHANGELOG.md) | `collector-v` |
| Helm chart `ouo` | 0.2.0 (released 2026-10-31; GitHub "Latest") | [deploy/helm/ouo/CHANGELOG.md](deploy/helm/ouo/CHANGELOG.md) | `chart-v` |

## Release trains

Versions that were released and verified together, and how they were verified. The full
check is the upgrade procedure (`docs/operations/upgrade.md`) run by the qa agent for that
combination; a row says when it has not been run yet.

| Date | rum-api | collector | grafana image | chart | plugin | @ouo11y/browser | @ouo11y/react-native | ouo11y-ios | Verified by |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-31 to 2026-11-01 (M2/M3 checkpoint) | 0.6.0 | 0.5.0 | 0.6.0 | 0.2.0 | 0.10.0 | 0.3.1 | 0.3.0 | 0.3.0 (tagged, mirror pending) | `release-check` e2e on every release PR (collector, rum-api, plugin built from source together); the released images' versions and digests checked by CI `quickstart` (#128, no stack started); the chart's rendered configs accepted by the released `rum-api:0.6.0` (`-config.verify`) and `collector:0.5.0` (`validate`) (#129); upgrade procedure run 2026-11-01 on the released images (compose, `ouo-env`) from rum-api 0.5.0, collector 0.4.0 and grafana 0.5.0: old replays and sessions identical, smoke, e2e, the ouo-web journey on `@ouo11y/browser` 0.3.1 and the React Native conformance suite on the npm 0.3.0 bundle pass (`docs/operations/upgrade.md` section 8); release-train commit `6893447` (`browser-v0.3.1`). Summaries: `project/agents/release/summaries/2026-10-31-checkpoint-m2-m3.md`, `project/agents/release/summaries/2026-11-01-qa-upgrade-m2-m3.md` |

## Before tags existed

Phases 1 to 7 (MVP) shipped on `main` without tags; their history is in `project/tracker/mvp.md`
and the per-agent summaries under `project/agents/`. The first tagged versions are the Phase 8a
ones above.
