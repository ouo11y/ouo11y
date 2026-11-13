# The plugin's Go backend in our stacks

> How is the backend of `ouo11y-rum-app` built and loaded, what does Grafana pass it, and what changed for the rest of the plugin?

Verified 2026-11-13 on Grafana 13.2.5 (`grafana/grafana:13.2.5`) with `grafana-plugin-sdk-go` v0.299.0, in env `pluginbff` and in the plugin's Go tests.

| Point | What holds |
|---|---|
| Binary name | `plugin.json` has `"backend": true, "executable": "gpx_ouo11y-rum-app"`; Grafana runs `dist/gpx_ouo11y-rum-app_<os>_<arch>`. We build `linux_amd64` and `linux_arm64` (Grafana in Docker on CI runners and on Apple silicon) |
| webpack | The scaffolded config cleans `dist/` but keeps `*_amd64`, `*_arm64` files, so the Go build runs **after** webpack in `npm run build` |
| Go version | v0.299.0 of the SDK requires `go 1.26.5`; `go mod tidy` raised the plugin's `go` directive to that. Locally Go fetched the toolchain itself (`GOTOOLCHAIN=auto`) |
| Machines without Go | `scripts/build-backend.mjs` falls back to `docker run golang:<go directive>` with the repository mounted (the module `replace`s `libs/ouo-go` by path). On rootless Docker (our CI runners) it runs as container root, which is the runner user on the host; elsewhere as the calling user, so `dist/` stays theirs. The module cache is a host directory in the temp dir |
| Resource path | `httpadapter` turns `/api/plugins/<id>/resources/v1/me` into a request for `/v1/me`; Go 1.22 method-and-path patterns (`GET /v1/projects/{project}/...`) work on it |
| The user | `backend.UserFromContext(ctx)` gives `Login`, `Name`, `Email` and the **org role** (`Viewer`, `Editor`, `Admin`, `None`). Teams are not passed: reading them needs a plugin service account and the Grafana API |
| Settings | `jsonData` and `DecryptedSecureJSONData` arrive in `backend.AppInstanceSettings`; a settings change makes a new instance (the old one's `Dispose` runs). Provisioning of nested maps (`clearance.roles`) arrives as JSON objects |
| Settings are readable | `GET /api/plugins/ouo11y-rum-app/settings` returns `jsonData` to any signed-in user (secure fields only as `true`). So the Clearance map, with any logins in it, is visible to Viewers. It is configuration, not data, but do not put anything secret in `jsonData` |
| MVP route proxy | Unchanged with a backend: `/api/plugin-proxy/ouo11y-rum-app/rum/...` still answered 200 |
| Unsigned | `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app` covers the backend too |
| Teams need a service account | Grafana passes login and role, not teams. The plugin asks for a **managed service account** in `plugin.json` (`"iam": {"permissions": [...]}`) and reads its token with `backend.GrafanaConfigFromContext(ctx).PluginAppClientSecret()`. Grafana creates the account only with `GF_FEATURE_TOGGLES_ENABLE=externalServiceAccounts` and `GF_AUTH_MANAGED_SERVICE_ACCOUNTS_ENABLED=true` (log: `serviceauth.extsvcaccounts ... Create service account service=ouo11y-rum-app`). Without them the token is empty |
| `org.users:read` for team members | With `teams:read` and `teams.permissions:read` only, `/api/teams/search` works but `/api/teams/{id}/members` answers **200 with `[]`**: members are filtered by the caller's right to read users. Adding `{"action": "org.users:read", "scope": "users:*"}` returns them. An empty list is not an error, so test it with a real member |
| The team creator joins the team | `POST /api/teams` as admin makes admin a member (the search showed `memberCount: 2` after adding one user). A test that grants a team a level must remove admin, or admin gets the team's level too |
| Grafana's URL from inside | The backend runs in Grafana's container, so it calls `http://localhost:3000`; `AppURL()` is the public root URL, which may not resolve inside the container |
| Settings changes and instances | Grafana rebuilds an app instance when the settings' update time changes, apparently in whole seconds: two settings writes within one second leave the first in force (a test restored settings and the old instance kept serving). Wait over a second between writes. A Grafana restart re-applies provisioning and overwrites settings saved through the API |
| Test without Grafana | Call `App.CallResource` with a `backend.PluginContext{User: ...}` and a `CallResourceResponseSenderFunc`; the same path Grafana uses (`pkg/bff/app_test.go`) |
