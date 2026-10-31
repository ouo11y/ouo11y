# Changelog: Helm chart `ouo`

`oci://ghcr.io/ouo11y/charts/ouo`, tag `chart-v<version>`. `version` in `Chart.yaml` bumps on any
change under `deploy/helm/ouo`; `appVersion` is the rum-api image the chart defaults to.
Policy: [`docs/releasing.md`](../../../docs/releasing.md). New entries are written by
release-please from conventional commits (`feat(chart): ...`, `fix(chart): ...`).

## Unreleased

## 0.2.0 (2026-10-31)

First published version of the chart (0.1.0 and 0.1.1 were never pushed).

### Breaking

- **Default images move from 0.3.0** to rum-api 0.6.0, collector 0.5.0 and the grafana image 0.6.0
  (plugin 0.10.0); `appVersion` is 0.6.0
  ([bb0d61a](https://github.com/ouo11y/ouo11y/commit/bb0d61a1b8f35857d94fe271ae682ce9be45a10f)).
  rum-api 0.6.0 marks the replay store with schema 2 at its first start. **Roll forward only**:
  once rum-api 0.6.0 has run, do not `helm rollback` to chart 0.1.x, and do not let
  `--rollback-on-failure` / `--atomic` take a failed upgrade back to it. The rum-api 0.3.0 it
  restores has no schema guard; it is harmless while the store holds only schema 1 data, but must
  never run once an SDK has sent schema 2 chunks (`docs/operations/upgrade.md` sections 4 and 6).
  Fix a failed upgrade forward instead. To stay on the old images, pin `*.image.tag` in your values.

### Added

- `retention` (roadmap 8b): one entry for Loki `retention_period` (compactor retention and
  deletes on), Tempo `block_retention`, Mimir `compactor_blocks_retention_period` and rum-api's
  replay retention, with per-project `retention.projects.<id>.logs` (Loki `retention_stream`) and
  `.replays`; `adminToken` (rum-api's `/v1/admin/*`), `rumApi.sampling`,
  `rumApi.storage.s3.lifecycleRules`. Bundled Loki promotes `ouo.project.id` to the
  `ouo_project_id` stream label
  ([b45c0c3](https://github.com/ouo11y/ouo11y/commit/b45c0c3d36b6c8472074c9d3487df4a9167a3b76)).

### Documentation

- README: the paths verified on kind on 2026-10-23 (checklist N12): S3 on MinIO, ingress-nginx +
  cert-manager (CA bootstrap from a self-signed issuer), `x_forwarded_for`, rate-limit buckets per
  collector pod, every `existingSecret` (with `otlp-headers`), `lgtm.mode=external`, HA render and
  server dry-run, upgrade from 0.1.0 with a values file and `--rollback-on-failure` (Helm 4)
  ([28d39f4](https://github.com/ouo11y/ouo11y/commit/28d39f4da916773e51ce384a23bca54eb37e33b3)).

### Compatibility

- Needs collector >= 0.5.0 and rum-api >= 0.6.0 (its defaults) and Kubernetes >= 1.25. The
  rendered rum-api and collector configs pass `rum-api:0.6.0 -config.verify` and
  `collector:0.5.0 validate`. Still not in the chart (checklist N29, N78): the collector's
  `ouoauth` failure counter and `ouoratelimit` middleware, the plugin's `featureToggles`, and
  project upload tokens for source maps and dSYMs.

## 0.1.1 (2026-10-18, not published)

### Changed

- Images default to `ghcr.io/ouo11y/{rum-api,collector,grafana}:0.3.0` (ADR-0009); `appVersion` 0.3.0.
  The packages are private: set `imagePullSecrets` (`README.md`, "Pull access").

## 0.1.0 (2026-10-13, not published)

### Added

- First chart: the ouo collector as the only public edge (custom image, htpasswd Secret, 4318/4319
  Service and Ingress), rum-api as a ClusterIP service, Grafana with the plugin image, bundled
  single-binary Loki, Tempo and Mimir or an external LGTM stack. Verified on kind (ADR-0007 rev 2).
