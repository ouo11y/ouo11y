# Changelog: grafana image

`ghcr.io/ouo11y/grafana` (until 0.2.0: `ghcr.io/ziadmansourm/ouo/grafana`), tag `grafana-v<version>`: Grafana with the `ouo11y-rum-app`
plugin baked in (unsigned). Its own version series; every entry names the Grafana base image
and the plugin version inside. Policy: `docs/releasing.md`.

## Unreleased

## 0.4.0 (2026-10-24)

Base `grafana/grafana:13.2.1`, plugin `ouo11y-rum-app` 0.8.0 inside.

### Changed

- Plugin 0.8.0: the session page shows only the activity list beside the player (Timeline behind
  the `sessionTimelinePanel` toggle), stack traces, device / OS / build / environment in the header,
  replay tap markers and the seek and clock fixes. See the plugin changelog.

### Compatibility

- Use with rum-api >= 0.4.0; with rum-api 0.3.x the masking state and header context fall back.

## 0.3.0 (2026-10-18)

First release under `ghcr.io/ouo11y/grafana` (ADR-0009). Base `grafana/grafana:13.2.1`, plugin
`ouo11y-rum-app` 0.7.0 inside.

### Changed

- Image `ghcr.io/ouo11y/grafana`; the plugin inside is `ouo11y-rum-app` (was `ouo-rum-app`), and
  `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app`. Upgrading an existing Grafana: see the plugin changelog.

### Compatibility

- rum-api >= 0.2.0. Provisioning must enable `ouo11y-rum-app` (the repo's `deploy/compose/grafana/provisioning`
  and the Helm chart do from 2026-10-18 on); a provisioning file that still names `ouo-rum-app` leaves the app
  missing.

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
