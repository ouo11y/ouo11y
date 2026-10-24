# 2026-10-24 Quickstart 3: tiny-shop-sessions (N48)

Owner: quickstarts. Branch `claude/quickstart-tiny-shop-sessions`, stacked on
`claude/web-sdk-session-lifecycle` (PR #73, N45), which it depends on.

## Done

- `examples/quickstarts/tiny-shop-sessions/`: standalone shop (Express API, React app) with three
  panels: **Your session** (session id, state and end reason, previous id, user, device id, read
  from `localStorage` so the panel itself is not activity), **Account** (log in as alice / bob,
  switch, log out = `clearUser`, End session = `endSession`, a 1-minute inactivity switch) and
  **Break it** (handled error, uncaught error, failed request to `GET /api/broken`).
- Split, commented stack (`stack/compose.yaml` holds only `include:`), copied from quickstart 5's
  layout without Mimir: collector, Tempo, Loki, rum-api and Grafana, the last two built from source.
- README: "What's new" table, `<details>` on the lifecycle (start, the four end reasons, 30 min /
  4 h defaults, closing the tab does not end a session, login / switch / logout rules, status),
  on device id and why no IP linking (privacy, NAT / carrier / VPN sharing and IP changes), the
  usual running / flow / files sections, an "Unreleased parts" table, a five-minute run.
- rum-api: `device=` filter on `GET /v1/sessions` (`loki.Filters.Device`, test case, README).
- Plugin: `device_id` in the types; **Device** on the session header, linking to the Sessions list
  filtered by that device; a Device filter on the Sessions page. The previous-session link and
  the end reason were already there.
- `build-it-yourself-guide.md` (after the founder's review, rewritten to be standalone): from an
  empty `tiny-shop-sessions/mine/` (gitignored; same depth as `result/` so the relative source
  paths resolve): plain API, plain React shop, the stack one service at a time, the API's and the
  web app's instrumentation, then one step per session feature, clean-up and a troubleshooting
  table. The app is split into `SessionPanel`, `AccountPanel`, `BreakItPanel` so each step embeds
  one file. Followed once from an empty folder, each step's check held, and `mine/` ended equal
  to `result/` (lockfiles aside). The walkthrough found and fixed: `npm pack --pack-destination`
  needs the folder; the NodeSDK's default metrics and logs exporters posted to localhost:4318
  without the credential (now `OTEL_*_EXPORTER=none` in `instrumentation.js`); Tempo search lags
  ingest by up to a minute; any SDK signal (a `long_animation_frame` from a throttled background
  tab) starts the next session after a timeout.
- Grafana is now stock `grafana/grafana:13.2.1` with `plugins/ouo11y-rum-app/dist` bind-mounted
  (no Dockerfile), so `result/` is exactly what the guide writes; the reader builds the plugin with
  the SDK (`npm run build -w sdk/browser -w plugins/ouo11y-rum-app`).
- Indexes: quickstarts README and index, fast-tracked tracker, checklist N48.

## Verified, and how

- `go vet ./... && go test ./...` in `services/rum-api`; plugin `tsc --noEmit`, `jest` (166 tests),
  `eslint` (no new findings), `prettier`.
- End to end on a clean stack (fresh compose project and volumes, shifted ports because another
  stack held the defaults), SDK packed from this branch, in the built-in browser: anonymous +
  failed request, login alice (same session), switch to bob (new session, previous = alice's),
  handled error, logout (new anonymous session), uncaught error, End session, click, short timeout
  and 70 s idle, click. rum-api: 6 sessions, end reasons `user_change` (alice, errored),
  `user_change` (bob, errored), `manual` (crashed), `inactivity` (healthy), one active; one
  `device_id` across all sessions of the run; `device=<id>` returns those five and `device=nope`
  none. Plugin: Overview 3 healthy / 2 errored / 1 crashed; bob's session header shows
  `ended · user_change`, User, Device, Previous session; the Device link filters the list.
- Stack torn down with `docker compose down -v`; API and Vite processes stopped. No ouo-env used.

## Left / next agent must know

- **TODO after the next release**: `@ouo11y/browser` from npm instead of `frontend/vendor/`
  (and commit a `package-lock.json` again), `image:` instead of `build:` for rum-api, and the released
  grafana image instead of the plugin bind mount. Never push tags for this.
- Gotchas found: `rum.session.id()` lazily starts a new session (so a UI that polls it defeats
  `endSession` / inactivity); clearing site data with the page open is undone by the SDK's unload
  write. Both are in the README's "Things that bite".
- npm inside this worktree fails with "call config.load()"; run `cd /tmp && npm --prefix <dir>`
  (see quickstart 5's note).
