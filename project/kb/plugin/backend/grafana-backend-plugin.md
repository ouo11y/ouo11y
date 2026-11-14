# A Grafana plugin's Go backend in our stacks

> How is the Go backend of a Grafana plugin built and loaded in our stacks, what does Grafana pass it about the user, and what does it change for the rest of the plugin?

Learned building a BFF for `ouo11y-rum-app` in PRs [#189](https://github.com/ouo11y/ouo11y/pull/189) and [#191](https://github.com/ouo11y/ouo11y/pull/191), which were not merged ([ADR-0025](../../../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md)): a client builds its own backend, and this is what one will meet. The code (`plugins/ouo11y-rum-app/pkg`, `scripts/build-backend.mjs`, the nested datasource) stays on those branches as reference for the demo client. Verified 2026-11-13 on Grafana 13.2.5 (`grafana/grafana:13.2.5`) with `grafana-plugin-sdk-go` v0.299.0.

| Point | What holds |
|---|---|
| App or datasource backend | Pick the datasource if the backend needs the user's identity-provider tokens: an app backend never gets them ([idp-tokens](../idp-tokens/idp-tokens-in-a-plugin-backend.md)). A datasource can be nested in an app plugin (`includes` in the app's `plugin.json`) |
| Binary name | `plugin.json` has `"backend": true, "executable": "gpx_<id>"`; Grafana runs `gpx_<id>_<os>_<arch>`. A nested plugin's executable is looked up in its own folder (`dist/datasource/`). Build `linux_amd64` and `linux_arm64` (Grafana in Docker on CI runners and on Apple silicon) |
| webpack | The scaffolded config cleans `dist/` but keeps `*_amd64`, `*_arm64` files, so the Go build runs **after** webpack in `npm run build` |
| Go version | v0.299.0 of the SDK requires `go 1.26.5`; `go mod tidy` raises the module's `go` directive to that. Locally Go fetches the toolchain itself (`GOTOOLCHAIN=auto`) |
| Machines without Go | Fall back to `docker run golang:<go directive>` with the repository mounted (a `replace` of a library by path needs the whole repo). On rootless Docker (our CI runners) container root is the runner user on the host; elsewhere run as the calling user so `dist/` stays theirs. Keep the module and build caches in a host directory, or every build is cold |
| Resource path | `httpadapter` turns `/api/datasources/uid/<uid>/resources/v1/me` (for an app backend: `/api/plugins/<id>/resources/v1/me`) into a request for `/v1/me`; Go 1.22 method-and-path patterns (`GET /v1/projects/{project}/...`) work on it |
| The user | `backend.UserFromContext(ctx)` gives `Login`, `Name`, `Email` and the **org role** (`Viewer`, `Editor`, `Admin`, `None`). Teams are not passed: reading them needs a plugin service account and the Grafana API |
| Settings | `jsonData` and `DecryptedSecureJSONData` arrive in `backend.DataSourceInstanceSettings` (`backend.AppInstanceSettings` for an app backend); a settings change makes a new instance. Provisioned nested maps arrive as JSON objects |
| Settings are readable | `jsonData`, of an app (`GET /api/plugins/<id>/settings`) and of a datasource (in the frontend's boot data), is given to any signed-in user; secure fields only as `true`. A mapping users must not read goes in a secure field, as one JSON string |
| An Admin can make their own instance | An org Admin can create a second instance of a datasource with settings of their own, and its backend trusts them. Anything a backend decides from instance settings is outside reach only for non-Admins |
| Logins can be renamed | A local Grafana user can change their own login (`PUT /api/user`) unless the account is synced from outside, and login lookups are case-insensitive. Never key access on a login alone |
| Errors and caching | Store errors carry internal URLs and queries: log them, answer the browser a generic message (`ouogo.BackendError.Public()`). Answer `Cache-Control: no-store`, so a lowered permission takes effect at once |
| MVP route proxy | Unchanged with a backend: `/api/plugin-proxy/ouo11y-rum-app/rum/...` still answered 200 |
| Unsigned | `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` must list a nested datasource's id too: the app's permission does not cover it |
| Test without Grafana | Call `CallResource` with a `backend.PluginContext{User: ...}`, `Headers` for what Grafana forwards, and a `CallResourceResponseSenderFunc`: the same path Grafana uses |
