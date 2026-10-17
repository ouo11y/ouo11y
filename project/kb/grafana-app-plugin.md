# grafana app plugin

Status: filled in Phase 4 by grafana-plugin (2026-10-07). Code: `plugins/ouo-rum-app`.
Verified against Grafana 13.2.1 (compose), `@grafana/create-plugin` 7.12.1,
`@grafana/{data,ui,runtime}` 13.2.2, `rrweb-player` 2.1.7 (same major as the SDK's `rrweb` 2.1.7).

## Question

How do we build, load (unsigned), provision and wire a frontend-only Grafana app plugin that
proxies to rum-api and embeds rrweb-player, inside the npm workspace monorepo?

## What works

- **Scaffold**: `npx @grafana/create-plugin@7.12.1 --plugin-name=rum --org-name=ouo --plugin-type=app --backend=false`
  generated `ouo-rum-app` (id = `<org>-<name>-<type>`). The `--backend=false` flag was ignored
  (it still generated `pkg/`, `go.mod`, `Magefile.go`, `backend: true`) and the process hung
  after generating (probably `go mod tidy` / a prompt), so: run it in a scratch dir, kill it,
  copy only the frontend parts (`.config/`, `src/`, `jest*.js`, `tsconfig.json`,
  `eslint.config.mjs`, `.prettierrc.js`, `package.json`) and drop `backend`/`executable` from
  `plugin.json`. The build toolchain in `.config/` (webpack 5 + swc, jest + swc, tsconfig,
  eslint 9) is untouched.
- **Monorepo**: the plugin is an npm workspace (`plugins/*`). Its React 19 / `@grafana/*`
  deps are nested in `plugins/ouo-rum-app/node_modules` because `examples/web` uses React 18.
  The scaffold's `.config/tsconfig.json` sets `typeRoots: ["../node_modules/@types"]`, which
  misses hoisted `@types/jest`; the root `tsconfig.json` overrides
  `typeRoots: ["./node_modules/@types", "../../node_modules/@types"]`. Scripts: `test` is
  `jest --passWithNoTests` (the scaffold default is `--watch`).
- **Unsigned loading**: `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo-rum-app` (+
  `GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS=ouo-rum-app`). Grafana logs
  `Permitting unsigned plugin` and registers it. `dist/` is bind-mounted at
  `/var/lib/grafana/plugins/ouo-rum-app` (short volume syntax: Docker Desktop creates an
  empty host dir when `dist/` is missing, so Grafana still starts without a build).
- **Provisioning**: `deploy/compose/grafana/provisioning/plugins/ouo-rum-app.yaml`
  (`apiVersion: 1`, `apps: [{type: ouo-rum-app, org_id: 1, disabled: false, jsonData: {rumApiUrl: http://rum-api:8080}}]`).
  `GET /api/plugins/ouo-rum-app/settings` then shows `enabled: true, pinned: true, jsonData`.
- **Route proxy**: `plugin.json` `routes: [{ "path": "rum/*", "method": "*", "reqRole": "Viewer",
  "url": "{{ if .JsonData.rumApiUrl }}{{ .JsonData.rumApiUrl }}{{ else }}http://rum-api:8080{{ end }}" }]`.
  The browser calls `/api/plugin-proxy/ouo-rum-app/rum/v1/...` (NOT
  `/api/plugins/<id>/resources/...`, which is the backend-plugin CallResource endpoint and
  returns 500 for a frontend-only app). The URL is a Go `text/template` evaluated per request
  against the app settings, so `if/else` works and the config page can change it without a
  restart. Verified: empty `jsonData` -> falls back to `http://rum-api:8080`; wrong port -> 502.
- **Frontend fetch**: `getBackendSrv().fetch({ url, showErrorAlert: false })` + `lastValueFrom`;
  errors are turned into a `RumApiError` with the proxied URL so the UI can show it.
- **Time range in the URL**: `TimeRangePicker` from `@grafana/ui` with `from`/`to` query
  params written through `locationService.partial`. rum-api accepts the same relative
  (`now-24h`) and ISO strings, so the raw strings are forwarded untouched.
- **Navigation**: `includes` with `addToNav: true` for Overview and Sessions
  (`defaultNav: true` on Overview) show under "More apps > ouo RUM"; the detail include
  (`/a/ouo-rum-app/sessions/:id`, `addToNav: false`) keeps the breadcrumb. Routing inside the
  plugin is `react-router-dom` v6 `Routes` (bundled; `react-router` is an external).
- **rrweb-player embedding**: `import rrwebPlayer from 'rrweb-player'; import 'rrweb-player/dist/style.css'`
  (style-loader from the scaffold handles the CSS). `new rrwebPlayer({ target, props: { events,
  width, height, autoPlay: false, showController: true, skipInactive: true } })`; seek with
  `player.goto(ms)` (no second argument keeps the play state), current time via
  `player.addEventListener('ui-update-current-time', ({ payload }) => ...)` (payload is ms from
  replay start, fires every frame; throttle to ~100 ms before `setState`). Resize with
  `player.$set({ width, height }); player.triggerResize()`; tear down with `player.$destroy()`
  (`$set`/`$destroy` are Svelte methods missing from the shipped typings because `svelte` is
  not installed; cast through a small interface). Replay start/duration = first/last event
  `timestamp`; marker position = `(ts - start) / duration`, clamped.
- **Sandbox**: `@rrweb/replay` creates the iframe with `sandbox="allow-same-origin"` (scripts
  disabled) unless `UNSAFE_replayCanvas` is set; verified in the DOM. Inputs arrive masked from
  the SDK (`maskAllInputs`), e.g. the card field value is `*******************`.

## What was tried

- `routes[].path: "rum"`: Grafana 13 matches route paths with its tree router
  (`web.NewTree().Add(route.Path)`), so a bare `rum` only matches `/rum` exactly and every
  sub-path answered `{"message":"plugin route match not found"}`. `rum/*` is required and the
  `*` remainder is appended to `url`.
- `/api/plugins/ouo-rum-app/resources/rum/...`: 500 `plugin.requestFailureError` (no backend).
- `InteractiveTable` from `@grafana/ui` for sessions: no row click handler, so the tables are
  plain `<table>` elements styled with `useStyles2` (row `onClick` + keyboard `Enter`).
- Browser cache: Grafana loads `module.js?_cache=<plugin version>` and chunks with content
  hashes, all `immutable`; after a rebuild the browser kept serving the old `module.js` until a
  hard reload (`fetch(url, { cache: 'reload' })` or DevTools "disable cache"). Bump `version`
  in `package.json` for releases.

## Gotchas

- `rrweb-player/dist/style.css` sets `.rr-player { float: left }`, which collapses the host
  element to height 0 and pushes whatever follows (our marker bar) above the player. Give the
  host `display: flow-root` and `.rr-player { float: none }`.
- Deleting the `.config/` backend bits is fine, but keep `.config/webpack`, `bundler`, `jest`,
  `types`, `tsconfig.json`, `eslint.config.mjs`: `webpack.config.ts` imports them by path.
- `eslint-plugin-react-hooks` 7 (scaffold) errors on `setState` inside effects and ref reads
  during render; sync derived state during render instead (`if (synced !== key) {...}`), and
  store callbacks in refs from an effect.
- Grafana restarts are needed only when `plugin.json` changes (routes, includes); JS changes
  need just a rebuild + hard reload.
- `Select` from `@grafana/ui` is deprecated in 13 (warning only); `Combobox` is the successor.
- `GRAFANA_URL` in rum-api must be the browser-facing URL (`http://localhost:3001` here) for
  the Explore links the plugin opens in a new tab.

## Phase 7b additions (grafana-plugin, 2026-10-08)

- **New chunk files need a Grafana restart.** Grafana builds the plugin's static file allowlist when
  the plugin loads; a webpack build that produces a chunk name that did not exist before (e.g.
  `865.js` after a code split) is on disk in the mounted `dist/` but Grafana answers 404
  (`Content-Type: application/json`), the browser logs `ChunkLoadError` and the page shows "Plugin
  failed to load". `docker compose -f deploy/compose/compose.yaml restart grafana` fixes it; a hard
  reload (`fetch(url, { cache: 'reload' })` on every `/public/plugins/ouo-rum-app/*` URL) is enough
  when only the contents of existing files changed.
- **Pinned replay next to a long timeline.** `position: sticky` on a grid item only moves inside
  its own grid area, so the sticky panel must be shorter than the row: give it `align-self: start`,
  make the other panel a stretched flex column whose list is the scroll container
  (`flex: 1; max-height: calc(100vh - 150px); overflow-y: auto`), and cap the frame stage with
  `calc(100vh - 300px)` so a portrait mobile replay fits the viewport (a `70vh` stage plus controls
  and markers was taller than the window). Grafana's page scrolls inside its own container, not
  the window, and sticky works there without extra wrappers; `top: 8px` is the right offset since
  the page header scrolls away with the content.
- **Auto-scrolling the active event** with `element.scrollIntoView({ block: 'nearest' })` also
  scrolls the page container and drags the pinned replay along; set the list's `scrollTop`
  directly instead (`src/utils/scroll.ts`, list has `position: relative` so `offsetTop` is
  relative to it).
- **Sorting**: plain `<table>` with `<button>` headers (`aria-sort`, arrow icon) and a pure
  comparator in `src/utils/sort.ts`; `InteractiveTable` still lacks a row click handler.

## Stale plugin after a rebuild (2026-10-08)

Grafana loads `module.js?_cache=<plugin version>` and the scaffold's webpack config names lazy chunks `<id>.js?_cache=<contenthash>`. After a rebuild with the **same** plugin version the browser keeps the old `module.js`, which still points at the old chunk hashes, so nothing appears to change even after `docker compose restart grafana`. Fix: bump `version` in `plugins/ouo-rum-app/package.json` (it becomes `plugin.json`'s version) for every user-visible change, or hard-reload (Cmd+Shift+R). Bumped to 0.2.0 for the Phase 7b changes.

## Phase 8a additions: read token, secureJsonData, route headers (grafana-plugin, 2026-10-10)

Context: ADR-0007 section 6. rum-api requires `Authorization: Bearer <OUO_READ_TOKEN>` on `/v1/*`
when the variable is set; the plugin must add it without exposing it to the browser. Plugin 0.3.0.

- **Route headers are templates too.** `routes[].headers[].content` is evaluated like `url`, as a Go
  `text/template` against the app settings: `.JsonData.<key>` and the *decrypted* `.SecureJsonData.<key>`.
  `{"name": "Authorization", "content": "Bearer {{ .SecureJsonData.readToken }}"}` is enough; the
  browser request to `/api/plugin-proxy/ouo-rum-app/rum/...` carries only the Grafana session. Any
  `plugin.json` edit (routes, headers) needs a Grafana restart; changing the stored settings does not.
  With no token stored the header is literally `Bearer ` (empty), which rum-api without
  `OUO_READ_TOKEN` ignores.
- **App plugin settings API.** `GET /api/plugins/<id>/settings` returns `enabled`, `pinned`, `jsonData`
  and `secureJsonFields` (`{"readToken": true}`), never the secret. `POST /api/plugins/<id>/settings`
  takes `{ enabled, pinned, jsonData, secureJsonData }`. Grafana encrypts each `secureJsonData` value
  and **merges per key** into the stored map: keys absent from the body keep their stored value, so the
  config page sends `secureJsonData` only when the user typed a token or pressed Reset. `jsonData` is
  replaced as a whole, so always send the complete object. Quirk to confirm live: `secureJsonFields.<key>`
  is `true` for any stored ciphertext, so saving an empty string after Reset still shows "configured"
  (the proxied header becomes `Bearer `). The plugin meta the frontend gets (`plugin.meta.secureJsonFields`)
  is read at page load; the config page reloads after a save.
- **Provisioning**: `apps[].secureJsonData` is supported in `provisioning/plugins/*.yaml`; `$VAR` and
  `${VAR}` are expanded from Grafana's environment, so `readToken: $OUO_READ_TOKEN` keeps the secret in
  `.env`. Provisioning runs on every Grafana start and overwrites UI-saved settings for that app.
- **UI**: `SecretInput` from `@grafana/ui` (`isConfigured`, `onReset`, rest are `Input` props). When
  configured it renders a disabled text input with value `configured` and a `Reset` button and keeps the
  `id`, so the `Field` label still points at it. In Jest, `Field`'s `<label>` text includes the
  description, so `getByLabelText('Read token')` fails: look inputs up by `id`.
- **401 through the proxy.** Grafana core's `backend_srv` treats a 401 from any `/api/...` call,
  including the plugin proxy, as a possibly expired Grafana session: it refreshes the session (token
  rotation / login ping) and retries once before surfacing `status: 401`; the user is only logged out
  if that refresh itself fails. Read from `public/app/core/services/backend_srv.ts`; the retry is to be
  confirmed live (expect two rum-api 401 log lines per plugin request). A signed-in user without the
  `reqRole` gets 403, so 401 can be mapped unambiguously to "rum-api rejected the read token"
  (`RumApiError.unauthorized`, `ApiErrorAlert` renders the settings link).
- **Testable save flow**: `window.location.reload` cannot be spied on in jsdom (Jest 29, jsdom 20);
  the config page takes an optional `onSaved` prop (default: reload) so tests assert the `POST` body
  and skip the reload. Grafana only passes `PluginConfigPageProps`, so the extra prop is inert in
  production.
- **Versioning rule**: every user-visible change bumps `package.json` `version` and gets a line in
  `plugins/ouo-rum-app/CHANGELOG.md`; the version ends up in `dist/plugin.json` through the
  `%VERSION%` replacement in `.config/webpack/webpack.config.ts`.
