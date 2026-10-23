# Changelog: Helm chart `ouo`

`oci://ghcr.io/ouo11y/charts/ouo`, tag `chart-v<version>`. `version` in `Chart.yaml` bumps on any
change under `deploy/helm/ouo`; `appVersion` is the rum-api image the chart defaults to.
Policy: [`docs/releasing.md`](../../../docs/releasing.md). New entries are written by
release-please from conventional commits (`feat(chart): ...`, `fix(chart): ...`).

## Unreleased

### Added

- `retention` (roadmap 8b): one entry for Loki `retention_period` (compactor retention and
  deletes on), Tempo `block_retention`, Mimir `compactor_blocks_retention_period` and rum-api's
  replay retention, with per-project `retention.projects.<id>.logs` (Loki `retention_stream`) and
  `.replays`; `adminToken` (rum-api's `/v1/admin/*`), `rumApi.sampling`,
  `rumApi.storage.s3.lifecycleRules`. Bundled Loki promotes `ouo.project.id` to the
  `ouo_project_id` stream label.

### Documentation

- README: the paths verified on kind on 2026-10-23 (checklist N12): S3 on MinIO, ingress-nginx +
  cert-manager (CA bootstrap from a self-signed issuer), `x_forwarded_for`, rate-limit buckets per
  collector pod, every `existingSecret` (with `otlp-headers`), `lgtm.mode=external`, HA render and
  server dry-run, upgrade from 0.1.0 with a values file and `--rollback-on-failure` (Helm 4).

## 0.1.1 (2026-10-18, not published)

### Changed

- Images default to `ghcr.io/ouo11y/{rum-api,collector,grafana}:0.3.0` (ADR-0009); `appVersion` 0.3.0.
  The packages are private: set `imagePullSecrets` (`README.md`, "Pull access").

## 0.1.0 (2026-10-13, not published)

### Added

- First chart: the ouo collector as the only public edge (custom image, htpasswd Secret, 4318/4319
  Service and Ingress), rum-api as a ClusterIP service, Grafana with the plugin image, bundled
  single-binary Loki, Tempo and Mimir or an external LGTM stack. Verified on kind (ADR-0007 rev 2).
