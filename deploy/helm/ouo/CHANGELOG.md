# Changelog: Helm chart `ouo`

`oci://ghcr.io/ouo11y/charts/ouo`, tag `chart-v<version>`. `version` in `Chart.yaml` bumps on any
change under `deploy/helm/ouo`; `appVersion` is the rum-api image the chart defaults to.
Policy: [`docs/releasing.md`](../../../docs/releasing.md). New entries are written by
release-please from conventional commits (`feat(chart): ...`, `fix(chart): ...`).

## Unreleased

## 0.1.1 (2026-10-18, not published)

### Changed

- Images default to `ghcr.io/ouo11y/{rum-api,collector,grafana}:0.3.0` (ADR-0009); `appVersion` 0.3.0.
  The packages are private: set `imagePullSecrets` (`README.md`, "Pull access").

## 0.1.0 (2026-10-13, not published)

### Added

- First chart: the ouo collector as the only public edge (custom image, htpasswd Secret, 4318/4319
  Service and Ingress), rum-api as a ClusterIP service, Grafana with the plugin image, bundled
  single-binary Loki, Tempo and Mimir or an external LGTM stack. Verified on kind (ADR-0007 rev 2).
