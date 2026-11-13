# ouo11y RUM (Grafana app plugin)

Plugin id `ouo11y-rum-app`, version in `package.json` (see `CHANGELOG.md`). Frontend-only Grafana app
plugin that is the ouo user interface: **Overview** (healthy / errored / crashed percentages per
platform and version), **Sessions** (filterable list), **Funnels** (step conversion and drop-off, [docs/funnels.md](../../docs/funnels.md)) and **Session detail** (timeline, traces with
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

## Session explorer and the backend (ADR-0023)

The pages under `/a/ouo11y-rum-app/explore` read the spec wire (Loki, Muninn) through the plugin's
own Go backend, the BFF of [ADR-0023](../../docs/adr/0023-plugin-bff-and-clearance.md), and nothing
else. The backend belongs to `ouo11y-rum-datasource`, a datasource nested in this plugin
(`src/datasource/`), because Grafana forwards the user's identity-provider token only to a
datasource ([ADR-0024](../../docs/adr/0024-clearance-from-idp-groups.md)). The backend (`pkg/`, built on [`ouo-go`](../../libs/ouo-go/README.md)) resolves the signed-in
user's Clearance level and redacts every answer before it leaves; the frontend uses the replay player
of [`@ouo11y/kit`](../../libs/ouo-kit/README.md). The MVP pages below still read rum-api and are
deleted with it.

| URL | What |
|---|---|
| `/a/ouo11y-rum-app/explore` | sessions with records in the last 1 h / 6 h / 24 h / 7 d, newest first |
| `/a/ouo11y-rum-app/explore/<project>/<session_id>?from&to` | the session's event timeline (click an event for its attributes) and its replay |

Backend resources, all `GET` under `/api/datasources/uid/ouo11y/resources/v1`: `me`, `sessions`,
`projects/{p}/sessions/{s}`, `.../replays/{r}` (manifest), `.../streams/{st}/chunks/{seq}`
(decompressed bytes). The datasource instance has the uid `ouo11y` and is provisioned in
`deploy/compose/grafana/provisioning/datasources/datasources.yaml`:

| Setting | What |
|---|---|
| `jsonData.oauthPassThru` | `true`: Grafana forwards the user's ID token, which groups mode reads |
| `jsonData.lokiUrl`, `muninnUrl`, `muninnTenant` | default `http://loki:3100`, `http://muninn:3400`, `anonymous` |
| `jsonData.oidc` | `issuer`, `audience` (the OAuth client id), `jwksUrl`, `groupsClaim` (default `groups`): how the ID token is verified |
| `secureJsonData.clearance` | a JSON object: `mode` (`groups` or `roles`), `groups` (identity-provider group to level 0-5; the highest of a user's groups wins), `roles` (Viewer, Editor, Admin to level). No user can read it back. No setting, or another mode: everyone is level 0 |
| `secureJsonData.muninnReadToken` | Muninn's read token |

For groups mode, get these right (ADR-0024):

- Grafana signs users in with OIDC (`[auth.generic_oauth]`) and has `use_refresh_token = true`. Without it a user falls to level 0 when their ID token expires.
- The groups are in the **ID token** (Keycloak: a group-membership mapper with "add to ID token").
- `oidc.issuer` is the token's `iss` exactly, character for character; `oidc.audience` is Grafana's OAuth client id; `oidc.jwksUrl` is `https` unless Grafana and the provider share a private network.
- Group names match exactly. A group change shows at the user's next sign-in or token refresh.
- A Grafana org Admin can create datasources and so is outside Clearance.

`ouo-env up <env> --muninn --idp` runs the stack with Keycloak and groups mode.

| Level | Sees |
|---|---|
| 0 | nothing (every data resource answers 403) |
| c1 | sessions and their timeline: times, event names, severity, ids, counts |
| c2 | plus event attributes and bodies, except identity |
| c3 | plus replays |
| c4, c5 | plus identity (`enduser.*`, `user.*`, `client.address`, the session's user) |

## Pages

| URL | What |
|---|---|
| `/a/ouo11y-rum-app/overview?from=now-24h&to=now` | stat tiles + version table per platform, Grafana time range picker (state in the URL) |
| `/a/ouo11y-rum-app/sessions?from&to&platform&status&service&version&user&limit` | sessions table; row click opens the detail |
| `/a/ouo11y-rum-app/funnels?from&to&step=page:/&step=page:/products/*&step=event:add_to_cart&within&service&environment&release&platform&project&dropped&offset` | funnel builder (steps in the URL, autocomplete from `GET /v1/funnels/steps`), bars with conversion, drop-off and median / p75 time per step (`POST /v1/funnels/query`); `dropped=N` opens the sessions that stopped before step N (`GET /v1/funnels/dropped`), each opening its session page and replay |
| `/a/ouo11y-rum-app/sessions/<session_id>?from&to` | header (device, OS, build, environment), replay (web `rrweb`, native `frames`, or `video` mp4 segments from the Sentry bridge) with the activity list beside it and the session's user feedback under it (message, contact, the last 20 steps before it, a seek to the replay at its time; mobile SDK spec C10), traces, logs; the Timeline panel behind the `sessionTimelinePanel` toggle |
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
npm run -w plugins/ouo11y-rum-app build          # -> dist/: webpack, then the Go backend (scripts/build-backend.mjs)
                                              #    datasource/gpx_ouo11y-rum-datasource_linux_{amd64,arm64}; local Go or the golang image
(cd plugins/ouo11y-rum-app && go vet ./... && go test ./...)   # the backend
npm run -w plugins/ouo11y-rum-app test           # jest: formatting, marker math, tables, config page, 401 banner
npm run -w plugins/ouo11y-rum-app typecheck
npm run -w plugins/ouo11y-rum-app lint
docker compose -f deploy/compose/compose.yaml up -d grafana   # mounts dist/ into Grafana
```

`deploy/compose/compose.yaml` bind-mounts `dist/` at `/var/lib/grafana/plugins/ouo11y-rum-app` and the
provisioning file above enables the app. Grafana must allow the unsigned plugin
(`GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app,ouo11y-rum-datasource`: the nested
datasource is a plugin id of its own). After a rebuild, restart Grafana if
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
src/components/              TimeRangeBar, HealthTiles, VersionTable, SessionsTable, Timeline,
                             TracesTable, ReplayPlayer (rrweb-player), FramePlayer, ReplayMarkers, ...
src/pages/                   Overview, Sessions, SessionDetail, Funnels (MVP, rum-api)
src/explore/                 Session explorer (the BFF's only client: bff.ts)
pkg/                         Go backend: main.go, bff/ (resource handlers over ouo-go)
scripts/build-backend.mjs    builds pkg/ into dist/ for linux amd64 and arm64
src/utils/format.ts          percentages, durations, relative times (tested)
src/utils/markers.ts         replay marker positioning / seek / active-event math (tested)
src/utils/timerange.ts       URL <-> Grafana TimeRange
.config/                     webpack, jest, tsconfig, eslint from @grafana/create-plugin 7.12.1
```

See `project/kb-archive/grafana-app-plugin.md` for the gotchas (route path must be `rum/*`, secureJsonData handling,
rrweb-player float, browser cache after rebuild, sandbox).
