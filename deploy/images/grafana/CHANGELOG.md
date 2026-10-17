# Changelog: grafana image

`ghcr.io/ziadmansourm/ouo/grafana`, tag `grafana-v<version>`: Grafana with the `ouo-rum-app`
plugin baked in (unsigned). Its own version series; every entry names the Grafana base image
and the plugin version inside. Policy: `docs/releasing.md`.

## Unreleased

## 0.2.0 (2026-10-17)

Tagged with plugin 0.6.0 inside (the GitHub release notes name it).

First released image.

- Base `grafana/grafana:13.2.1`.
- `ouo-rum-app` at the plugin version on `main` when tagged (0.5.0 on 2026-10-16; the
  release notes record the exact version).
- `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo-rum-app`.

### Compatibility

- rum-api >= 0.2.0. Provisioning (datasources, plugin settings with the read token) is not in
  the image; mount `deploy/compose/grafana/provisioning` or use the Helm chart.
