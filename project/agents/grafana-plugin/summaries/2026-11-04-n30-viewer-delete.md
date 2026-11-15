# N30: Viewers can no longer delete replays through the plugin proxy (2026-11-04)

Branch `claude/n30-viewer-delete`. Checklist item N30 V1 (found by N15 on 2026-10-23).

## What was wrong

`plugin.json` had one route, `rum/*`, `method: "*"`, `reqRole: Viewer`. Grafana adds the read
token to every proxied request and rum-api's `readAuth` accepts the read token for
`DELETE /v1/sessions/{id}/replay`, so any Grafana Viewer could erase a replay (N15 saw 204).

## What changed

- `plugins/ouo11y-rum-app/src/plugin.json`: three routes, one method each.

  | Route | Role | Why |
  |---|---|---|
  | `GET rum/*` | Viewer | every page, the players, `<video>` segments, Test connection |
  | `POST rum/v1/funnels/*` | Viewer | `POST /v1/funnels/query` is a read with a JSON body; the only POST the plugin makes |
  | `DELETE rum/v1/sessions/*` | Admin | `DELETE /v1/sessions/{id}/replay` |

  **Admin, not Editor:** deleting a replay erases personal data (for a pilot client, GDPR Art. 9 data) and cannot
  be undone. Grafana Editors are usually everyone who builds dashboards. rum-api's other erasure
  endpoints (`/v1/admin/users`, `/v1/admin/projects`) need the admin token. So erasure through
  Grafana goes to org Admins only.
- Every other method (PUT, PATCH, POST outside `/v1/funnels/`, DELETE outside `/v1/sessions/`)
  has no route, so Grafana answers 404 and rum-api never sees it. Before, a Viewer's
  `POST /v1/replay/chunks` or `PUT /v1/sourcemaps` reached rum-api with the read token: harmless
  while the ingest and upload tokens are set, open when they are not.
- A narrowed route strips its whole prefix, so its `url` ends with `/v1/funnels` or `/v1/sessions`.
  A `rumApiUrl` with a trailing slash would then give `//v1/...`, which rum-api's mux redirects
  (measured: 307). The config page saves the URL without a trailing slash (`AppConfig.tsx`) and the
  chart's `ouo.rumApiUrl` helper uses `trimSuffix "/"`. A stored value that already has a trailing
  slash keeps working for GET. It breaks the funnel POST and the Admin DELETE until it is saved again.
- UI: the plugin has no delete control (checked with grep), so there is nothing to hide. Deleting
  stays an API call for Admins.
- `src/plugin.test.ts` pins the route table: one method each, a `reqRole` on every route, Viewer =
  `GET rum/*` + `POST rum/v1/funnels/*`, DELETE = Admin, and each narrowed `url` maps back onto
  the same rum-api path.
- `tests/e2e/edge-qa.mjs` `viewer`: the V1 finding is now a set of assertions (below).
- Docs: plugin README (route table), CHANGELOG (Unreleased, Fixed), `deploy/README.md`, kb
  `grafana-app-plugin.md` (new section "Route roles"), kb `e2e-scenario.md`.

## How Grafana 13 matches routes (read in v13.2.5 `pkg/api/pluginproxy/pluginproxy.go`)

Routes are tried in declared order. `method` is one string compared with `==` (`""` and `"*"`
match all). The first route that matches method and path decides: a failed role check is a 403
and later routes are not tried. No match is a 404. No `reqRole` lets any signed-in user through.
Details are in the kb.

## Verified

- `npx jest` in the plugin: 29 suites, 207 tests pass (5 new route tests, 1 new AppConfig test).
  Typecheck and build pass. Lint has 0 errors; its 7 warnings are in files this PR does not touch.
- `helm lint deploy/helm/ouo` passes. `helm template -f values-kind.yaml --set
  grafana.plugin.rumApiUrl=http://rum.example:8080/` renders `http://rum.example:8080`.
- Live on `ouo-env` env `n30-viewer-delete` (compose project `ouo-n30-viewer-delete`, built from
  this worktree, Grafana 13.2.5):
  - `node tests/e2e/edge-qa.mjs --profile default --only viewer`: 26/26 assertions pass.
    Viewer GET (healthz, stats, sessions, funnel steps) 200. Viewer funnel POST 200. Viewer DELETE
    403 and Editor DELETE 403, and the replay is still there. Viewer PUT sourcemaps, PATCH replay,
    POST chunks, POST symbolicate and DELETE admin/projects all 404 with
    `plugin route match not found`. Admin DELETE 204, then the replay is 404.
  - `node tests/e2e/scenario.mjs`: E2E OK, 40 sessions.
  - Headless Chromium (repo Playwright) logged in once as a Viewer and once as admin, and opened
    Sessions, Funnels and Session detail (rrweb session). Every plugin-proxy call was 2xx
    (`GET /v1/sessions`, `POST /v1/funnels/query`, `GET /v1/funnels/steps`, session, replay,
    replay events, logs). The detail page renders for the Viewer.
  - Trailing slash: `rumApiUrl` set to `http://rum-api:8080/` through the settings API gives 307
    for the funnel POST and 200 for GET. Without the slash, the POST reaches rum-api.
  - Env torn down with `ouo-env down n30-viewer-delete --purge`.

## Left / for the next agent

- Session detail throws `Cannot read properties of undefined (reading 'id')` in the rrweb chunk
  (`150.js`) for both Viewer and Admin on the scenario's synthetic replay (full snapshot
  `data: {}`). It comes from the synthetic data, not from the roles. Not investigated further.
- `project/tracker/checklist.md` has two items with the ID N30: line ~176 (rum-api config vs
  released 0.3.0, still open) and this one. One of them should be renumbered.
- `ouo-env up` cannot build the plugin while the shared checkout's root `package.json` is
  conflicted: npm walks up and fails with "Exit prior to config file resolving". I built it in the
  plugin folder and wrote `dist/.ouo-env-built` with HEAD.
- Grafana must be restarted after upgrading the plugin, because the routes changed (CHANGELOG
  says so).
