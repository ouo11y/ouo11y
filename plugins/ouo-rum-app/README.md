# ouo RUM (Grafana app plugin)

Plugin id `ouo-rum-app`. Frontend-only Grafana app plugin that is the ouo MVP user
interface: **Overview** (healthy / errored / crashed percentages per platform and version),
**Sessions** (filterable list) and **Session detail** (timeline, traces with Grafana Explore
links, rrweb replay synced to the timeline). All data comes from `services/rum-api` through
the plugin route proxy; the browser never talks to rum-api directly.

```
browser --/api/plugin-proxy/ouo-rum-app/rum/v1/...--> Grafana --(routes[0].url = jsonData.rumApiUrl)--> rum-api
```

## Pages

| URL | What |
|---|---|
| `/a/ouo-rum-app/overview?from=now-24h&to=now` | stat tiles + version table per platform, Grafana time range picker (state in the URL) |
| `/a/ouo-rum-app/sessions?from&to&platform&status&service&version&user&limit` | sessions table; row click opens the detail |
| `/a/ouo-rum-app/sessions/<session_id>?from&to` | header, timeline, replay (web sessions with `has_replay`), traces |
| `/plugins/ouo-rum-app` | configuration: `rumApiUrl` (default `http://rum-api:8080`) |

## Build, test, run

```bash
npm install                                   # repo root (npm workspaces)
npm run -w plugins/ouo-rum-app build          # -> plugins/ouo-rum-app/dist
npm run -w plugins/ouo-rum-app test           # jest: formatting + marker math
npm run -w plugins/ouo-rum-app typecheck
npm run -w plugins/ouo-rum-app lint
docker compose -f deploy/docker/compose.yaml up -d grafana   # mounts dist/ into Grafana
```

`deploy/docker/compose.yaml` bind-mounts `dist/` at `/var/lib/grafana/plugins/ouo-rum-app`
and `deploy/docker/grafana/provisioning/plugins/ouo-rum-app.yaml` enables the app with
`jsonData.rumApiUrl=http://rum-api:8080`. Grafana must allow the unsigned plugin
(`GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo-rum-app`). After a rebuild, restart Grafana
only if `plugin.json` changed; for JS-only changes a hard reload of the browser is enough
(Grafana caches `module.js?_cache=<version>`).

## Layout

```
src/plugin.json              id, includes (nav pages), routes (rum/* -> rumApiUrl)
src/module.tsx               AppPlugin root + config page
src/api/                     rum-api types and fetch client (getBackendSrv through the proxy)
src/components/              TimeRangeBar, HealthTiles, VersionTable, SessionsTable, Timeline,
                             TracesTable, ReplayPlayer (rrweb-player), ReplayMarkers, StatusBadge, ...
src/pages/                   Overview, Sessions, SessionDetail
src/utils/format.ts          percentages, durations, relative times (tested)
src/utils/markers.ts         replay marker positioning / seek / active-event math (tested)
src/utils/timerange.ts       URL <-> Grafana TimeRange
.config/                     webpack, jest, tsconfig, eslint from @grafana/create-plugin 7.12.1
```

See `kb/grafana-app-plugin.md` for the gotchas (route path must be `rum/*`, rrweb-player float,
browser cache after rebuild, sandbox).
