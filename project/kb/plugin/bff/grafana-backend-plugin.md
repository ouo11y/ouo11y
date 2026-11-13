# The plugin's Go backend in our stacks

> How is the backend of `ouo11y-rum-app` built and loaded, what does Grafana pass it, and what changed for the rest of the plugin?

Since [ADR-0024](../../../../docs/adr/0024-clearance-from-idp-groups.md) the backend belongs to the datasource nested in the plugin, not to the app; the rows below say so where it matters, and [clearance-idp](../clearance-idp/idp-groups-in-a-plugin-backend.md) says why.

Verified 2026-11-13 on Grafana 13.2.5 (`grafana/grafana:13.2.5`) with `grafana-plugin-sdk-go` v0.299.0, in env `pluginbff` and in the plugin's Go tests.

| Point | What holds |
|---|---|
| Binary name | `src/datasource/plugin.json` has `"backend": true, "executable": "gpx_ouo11y-rum-datasource"`; Grafana runs `dist/datasource/gpx_ouo11y-rum-datasource_<os>_<arch>` (a nested plugin's executable is looked up in its own folder). The app's `plugin.json` lists the datasource under `includes` and has no backend. We build `linux_amd64` and `linux_arm64` (Grafana in Docker on CI runners and on Apple silicon) |
| webpack | The scaffolded config cleans `dist/` but keeps `*_amd64`, `*_arm64` files, so the Go build runs **after** webpack in `npm run build` |
| Go version | v0.299.0 of the SDK requires `go 1.26.5`; `go mod tidy` raised the plugin's `go` directive to that. Locally Go fetched the toolchain itself (`GOTOOLCHAIN=auto`) |
| Machines without Go | `scripts/build-backend.mjs` falls back to `docker run golang:<go directive>` with the repository mounted (the module `replace`s `libs/ouo-go` by path). On rootless Docker (our CI runners) it runs as container root, which is the runner user on the host; elsewhere as the calling user, so `dist/` stays theirs. The module cache is a host directory in the temp dir |
| Resource path | `httpadapter` turns `/api/datasources/uid/<uid>/resources/v1/me` (for an app backend: `/api/plugins/<id>/resources/v1/me`) into a request for `/v1/me`; Go 1.22 method-and-path patterns (`GET /v1/projects/{project}/...`) work on it |
| The user | `backend.UserFromContext(ctx)` gives `Login`, `Name`, `Email` and the **org role** (`Viewer`, `Editor`, `Admin`, `None`). Teams are not passed: reading them needs a plugin service account and the Grafana API |
| Settings | `jsonData` and `DecryptedSecureJSONData` arrive in `backend.DataSourceInstanceSettings` (`backend.AppInstanceSettings` for an app backend); a settings change makes a new instance (the old one's `Dispose` runs). Provisioning of nested maps (`clearance.roles`) arrives as JSON objects |
| Settings are readable | `jsonData`, of an app (`GET /api/plugins/<id>/settings`) and of a datasource (in the frontend's boot data), is given to any signed-in user; secure fields only as `true`. So the Clearance map is the secure field `clearance`, one JSON string |
| MVP route proxy | Unchanged with a backend: `/api/plugin-proxy/ouo11y-rum-app/rum/...` still answered 200 |
| Unsigned | `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app,ouo11y-rum-datasource`: the nested datasource is its own plugin id and the app's permission does not cover it |
| Test without Grafana | Call `App.CallResource` with a `backend.PluginContext{User: ...}`, `Headers` for what Grafana forwards, and a `CallResourceResponseSenderFunc`; the same path Grafana uses (`pkg/bff/app_test.go`) |
