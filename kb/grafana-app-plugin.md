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
- **Provisioning**: `deploy/docker/grafana/provisioning/plugins/ouo-rum-app.yaml`
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
