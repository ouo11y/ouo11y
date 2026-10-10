# qa tracker

Phase 6, branch `phase-6-qa`. Allowed paths: `tests/e2e/**`, `deploy/scripts/**` (new),
`reports/**`, `agents/qa/**`, root `README.md`, `docs/MVP.md` (ticks), `tracker/mvp.md`
(Phase 6), `kb/`.

- [x] Scenario script `tests/e2e/scenario.mjs` + `deploy/scripts/e2e.sh` (passes: 40 sessions, 0 mismatches)
- [x] Unit test runs recorded: sdk/browser 45, sdk/react-native 36, plugin 14, rum-api and backend `go test` green
- [x] Real-app walk-through in the browser: healthy / errored / crashed web sessions, Grafana Overview, Sessions, detail, replay masking, Explore link, replay pause and delete, inactivity rotation
- [x] Mobile demo on Expo web: errored + fatal + relaunch -> crashed with `end_reason=crash`, version 2.3.0 (simulator not possible)
- [x] `reports/mvp-verification.html` + `reports/index.md`
- [x] Root `README.md` quickstart
- [x] `docs/MVP.md` ticks with methods, `tracker/mvp.md` Phase 6 boxes
- [x] `kb/e2e-scenario.md` + index line
- [x] Bug report `agents/qa/reports/phase-6-bugs.html` (1 bug, 3 minor observations)
- [ ] Not done: iOS Simulator run (Phase 5 box, needs Xcode); `background` end reason only unit-tested

## Phase 8a, branch `phase-8a-install-secure` (2026-10-10)

Allowed paths: `tests/e2e/**`, `reports/**`, `agents/qa/**`, `tracker/roadmap.md` (8a ticks),
`kb/e2e-scenario.md`, `docs/MVP.md` and `README.md` only if a method or command changed (neither did).

- [x] `tests/e2e/scenario.mjs` through rum-api ingest with the project token, read token on reads, ten gateway checks, `ouo.project.id` assertion via the Tempo datasource proxy; `e2e.sh` passes (run `mv2kfrpc`, 40 sessions, 0 mismatches, `agents/qa/reports/e2e-phase-8a-run.json`)
- [x] Real web session in the browser pane: crashed with 12 traces and rrweb replay through :8090 only; plugin Overview / Sessions / detail via the proxy, no token in the browser
- [x] Plugin read token: wrong token banner on three pages, Test connection failure and success, Reset + empty save (key dropped), restore via settings API
- [x] Unload path: keepalive chunk accepted on navigation; pane tab close lost one chunk (finding 4)
- [x] iOS simulator: dev build, checkout + 500 + fatal + relaunch; crashed session with 14 frames / 18 touches, 8 traces, frame uploads with the token (`uploaded seq=…`, replay-ok counter)
- [x] Rate limit 400 burst -> 92 x 429 `Retry-After: 1`, recovery; 413 at 4.3 MB; collector loopback-only
- [x] `reports/phase-8a-verification.html` + `reports/index.md`; `agents/qa/reports/phase-8a-bugs.html`; `tracker/roadmap.md` 8a ticks; `kb/e2e-scenario.md`
- [ ] Not done: Helm on a cluster, VM install, publish, upgrade (other agents / drills); plugin Viewer-role check; keepalive on stock Chrome tab close; per-project limit overrides live
