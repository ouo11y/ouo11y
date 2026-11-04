# ouo11y RUM (Grafana app plugin)

Plugin id `ouo11y-rum-app`, version in `package.json` (see `CHANGELOG.md`). Frontend-only Grafana app
plugin that is the ouo user interface: **Overview** (healthy / errored / crashed percentages per
project and app side by side, then per platform and version), **Sessions** (filterable list), **Funnels** (step conversion and drop-off, [docs/funnels.md](../../docs/funnels.md)) and **Session detail** (timeline, traces with
Grafana Explore links, rrweb, frame or video replay synced to the timeline). All data comes from
`services/rum-api` through the plugin route proxy; the browser never talks to rum-api directly and
never sees the read token.

```
browser --/api/plugin-proxy/ouo11y-rum-app/rum/v1/...--> Grafana --(routes[].url = jsonData.rumApiUrl,
                                                                  + Authorization: Bearer <secureJsonData.readToken>)--> rum-api
```

Who may call what through the proxy (`routes` in `src/plugin.json`; Grafana refuses a method
without a route with 404 and a role below the route's `reqRole` with 403):

| Method and path | Org role | Used for |
|---|---|---|
| `GET rum/*` | Viewer | every page, the replay players (including the `<video>` segments) and the connection test |
| `POST rum/v1/funnels/*` | Viewer | `POST /v1/funnels/query` (a read with a JSON body) |
| `DELETE rum/v1/sessions/*` | Admin | `DELETE /v1/sessions/{id}/replay`, erasing one replay (no button in the UI) |

## Pages

Overview, Sessions and Funnels have a **Project** and **App** selector next to the time range
(`ScopePicker`, options from `GET /v1/projects`). The scope lives in the URL (`project`, `service`)
so links keep it; "All projects" / "All apps" is the cross-project view. The last scope is
remembered per Grafana org (localStorage) and comes back on a page opened without one, such as
the nav menu's Sessions or Funnels. Every rum-api call,
Session detail included, carries it ([docs/specs/rum-api-scope.md](../../docs/specs/rum-api-scope.md)).
The selector narrows what you see; it is **not an access boundary**: one read token reads every
project, so anyone with the plugin can pick any project (per-project tokens are Phase 11).

| URL | What |
|---|---|
| `/a/ouo11y-rum-app/overview?from=now-24h&to=now&project&service` | "Projects and apps" cards (health per project and app, click to scope), then stat tiles + version table per platform, Grafana time range picker (state in the URL) |
| `/a/ouo11y-rum-app/sessions?from&to&project&service&platform&status&version&user&limit` | sessions table (each row names its project); row click opens the detail |
| `/a/ouo11y-rum-app/funnels?from&to&step=page:/&step=page:/products/*&step=event:add_to_cart&within&service&environment&release&platform&project&dropped&offset` | funnel builder (steps in the URL, autocomplete from `GET /v1/funnels/steps`), bars with conversion, drop-off and median / p75 time per step (`POST /v1/funnels/query`); `dropped=N` opens the sessions that stopped before step N (`GET /v1/funnels/dropped`), each opening its session page and replay |
| `/a/ouo11y-rum-app/sessions/<session_id>?from&to&project&service` | header (device, OS, build, environment), replay (web `rrweb`, native `frames`, or `video` mp4 segments from the Sentry bridge) with the activity list beside it and the session's user feedback under it (message, contact, the last 20 steps before it, a seek to the replay at its time; mobile SDK spec C10), traces, logs; the Timeline panel behind the `sessionTimelinePanel` toggle |
| `/plugins/ouo11y-rum-app` | configuration: `rumApiUrl`, `readToken` (write-only), "Test connection" |

## Replay players

`replay_kind` on the session record (or `kind` in `GET /v1/sessions/{id}/replay` for older records) picks the
player; all three expose the same `goto`/`play`/`pause` handle, so replay markers and timeline clicks seek them
the same way.

| Kind | Data | Player |
|---|---|---|
| `rrweb` | `/replay/events` | `ReplayPlayer` (rrweb-player in a sandboxed iframe) |
| `frames` | `/replay/frames` (base64 JPEG + touches) | `FramePlayer` |
| `video` | `/replay/video` manifest + `/replay/video/{seq}` mp4 (ADR-0008) | `VideoPlayer`: one `<video>` per segment (current and both neighbours preloaded; on a seek the frame on screen stays until the new segment can paint) whose `src` is the proxy URL (`/api/plugin-proxy/ouo11y-rum-app/rum/v1/sessions/<id>/replay/video/<seq>`); the Grafana session cookie authenticates it and the proxy passes `Range`/206 through. The replay clock is the master, gaps keep the previous segment's last frame, touches fade over 500 ms, "Sentry replay" badge from `source.vendor`. Keys: space, arrows (one frame), shift+arrows (one segment). |

## Configuration

Administration > Plugins and data > Plugins > ouo11y RUM > Configuration (`/plugins/ouo11y-rum-app`, Admin role).

| Setting | Stored as | Meaning |
|---|---|---|
| rum-api URL | `jsonData.rumApiUrl` | rum-api base URL as reachable **from the Grafana server**, with no trailing `/`. Empty means `http://rum-api:8080` (the compose service). The page trims a trailing `/` on save; a provisioning file must not have one, because the narrowed routes append `/v1/...` and a doubled `//` gets a 307 from rum-api. |
| Read token | `secureJsonData.readToken` | The value of rum-api's `OUO_READ_TOKEN` (ADR-0007 section 6). Grafana stores it encrypted and only reports `secureJsonFields.readToken: true` back, so the field shows "configured" with a Reset button. Leave it empty when rum-api runs without `OUO_READ_TOKEN`. |

Both are saved with `POST /api/plugins/ouo11y-rum-app/settings` (`{ enabled, pinned, jsonData, secureJsonData }`).
`secureJsonData` is only sent when a new token was typed (or a stored one was reset), because Grafana
keeps every stored secret whose key is absent from the body. The page reloads after a save so Grafana
re-reads the plugin meta.

**Test connection** runs two requests through the proxy with the *saved* settings:

1. `GET /api/plugin-proxy/ouo11y-rum-app/rum/healthz` (open in rum-api): 200 proves Grafana reaches `rumApiUrl`.
2. `GET /api/plugin-proxy/ouo11y-rum-app/rum/v1/stats/health?from=now-1h` (needs the token): 200 means the
   token is accepted; 401 is reported as "read token rejected by rum-api".

When rum-api answers 401 to any call, the Overview, Sessions and Session detail pages replace their
content with one banner ("rum-api rejected the read token") linking to the configuration page.

### How the token reaches rum-api

`src/plugin.json`:

```json
"routes": [
  {
    "path": "rum/*",
    "method": "*",
    "reqRole": "Viewer",
    "url": "{{ if .JsonData.rumApiUrl }}{{ .JsonData.rumApiUrl }}{{ else }}http://rum-api:8080{{ end }}",
    "headers": [{ "name": "Authorization", "content": "Bearer {{ .SecureJsonData.readToken }}" }]
  }
]
```

Grafana evaluates `url` and `headers[].content` as Go templates per request against the app settings
(`.JsonData`, decrypted `.SecureJsonData`) and adds the header before forwarding. A change to
`plugin.json` needs a Grafana restart; settings changes do not.

### Provisioning

`deploy/compose/grafana/provisioning/plugins/ouo11y-rum-app.yaml` (compose) or the Helm chart's plugin
provisioning. `$VAR` / `${VAR}` are expanded from Grafana's environment, so the token lives in `.env`
(`OUO_READ_TOKEN`, shared with rum-api; compose defaults to the development value
`rt_dev_0000000000000000`), not in the YAML:

```yaml
apiVersion: 1
apps:
  - type: ouo11y-rum-app
    org_id: 1
    disabled: false
    jsonData:
      rumApiUrl: http://rum-api:8080
      featureToggles: "${OUO_FEATURE_TOGGLES_ENABLE}"
    secureJsonData:
      readToken: ${OUO_READ_TOKEN}
```

### Feature toggles

Grafana-style toggles for plugin features that are not on by default. They are stored as
`jsonData.featureToggles` (a comma separated string or a list of names) and provisioned from the environment
variable `OUO_FEATURE_TOGGLES_ENABLE`, comma separated like Grafana's `GF_FEATURE_TOGGLES_ENABLE`:

| Toggle | Default | What it does |
|---|---|---|
| `sessionTimelinePanel` | off | Shows the Timeline panel on the session page, left of the replay. Off: the page shows the replay with only its activity list beside the player (the activity list lists the same events). |

- **Compose:** `OUO_FEATURE_TOGGLES_ENABLE=sessionTimelinePanel` in `.env` (or the shell) reaches Grafana, and
  the provisioning file sets `featureToggles: "${OUO_FEATURE_TOGGLES_ENABLE}"`; restart Grafana after a change.
- **Helm:** `grafana.plugin.featureToggles: [sessionTimelinePanel]` in the values; the chart passes it to
  Grafana as `OUO_FEATURE_TOGGLES_ENABLE` and provisions it the same way.
- Unknown names are ignored. The configuration page lists every toggle and whether it is on.

Provisioning is applied on every Grafana start and overwrites settings saved from the configuration
page, so in a provisioned install the token is rotated in `.env` and Grafana is restarted.

## Build, test, run

```bash
npm install                                   # repo root (npm workspaces)
npm run -w plugins/ouo11y-rum-app build          # -> plugins/ouo11y-rum-app/dist (plugin.json gets the version)
npm run -w plugins/ouo11y-rum-app test           # jest: formatting, marker math, tables, config page, 401 banner
npm run -w plugins/ouo11y-rum-app typecheck
npm run -w plugins/ouo11y-rum-app lint
docker compose -f deploy/compose/compose.yaml up -d grafana   # mounts dist/ into Grafana
```

`deploy/compose/compose.yaml` bind-mounts `dist/` at `/var/lib/grafana/plugins/ouo11y-rum-app` and the
provisioning file above enables the app. Grafana must allow the unsigned plugin
(`GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app`). After a rebuild, restart Grafana if
`plugin.json` changed or a new chunk file appeared; for JS-only changes bump `version` in
`package.json` (every user-visible change does, see `CHANGELOG.md`) so browsers drop the cached
`module.js?_cache=<version>`.

## Layout

```
src/plugin.json              id, includes (nav pages), routes (rum/* -> rumApiUrl + Authorization header)
src/module.tsx               AppPlugin root + config page
src/api/                     rum-api types and fetch client (getBackendSrv through the proxy; 401 -> unauthorized)
src/components/AppConfig     configuration page (rumApiUrl, readToken SecretInput, Test connection)
src/components/ApiErrorAlert one banner per failed call; dedicated wording + settings link on 401
src/hooks/useScope.ts        project / app scope from the URL, rum-api params, link helpers
src/components/              ScopePicker, ProjectHealthGrid, TimeRangeBar, HealthTiles, VersionTable, SessionsTable, Timeline,
                             TracesTable, ReplayPlayer (rrweb-player), FramePlayer, ReplayMarkers, ...
src/pages/                   Overview, Sessions, SessionDetail, Funnels
src/utils/format.ts          percentages, durations, relative times (tested)
src/utils/markers.ts         replay marker positioning / seek / active-event math (tested)
src/utils/timerange.ts       URL <-> Grafana TimeRange
.config/                     webpack, jest, tsconfig, eslint from @grafana/create-plugin 7.12.1
```

See `project/kb/grafana-app-plugin.md` for the gotchas (route path must be `rum/*`, secureJsonData handling,
rrweb-player float, browser cache after rebuild, sandbox).
