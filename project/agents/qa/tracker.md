# qa tracker

Phase 6, branch `phase-6-qa`. Allowed paths: `tests/e2e/**`, `deploy/scripts/**` (new),
`project/reports/**`, `project/agents/qa/**`, root `README.md`, `docs/MVP.md` (ticks), `project/tracker/mvp.md`
(Phase 6), `project/kb-archive/`.

- [x] Scenario script `tests/e2e/scenario.mjs` + `deploy/scripts/e2e.sh` (passes: 40 sessions, 0 mismatches)
- [x] Unit test runs recorded: sdk/browser 45, sdk/react-native 36, plugin 14, rum-api and backend `go test` green
- [x] Real-app walk-through in the browser: healthy / errored / crashed web sessions, Grafana Overview, Sessions, detail, replay masking, Explore link, replay pause and delete, inactivity rotation
- [x] Mobile demo on Expo web: errored + fatal + relaunch -> crashed with `end_reason=crash`, version 2.3.0 (simulator not possible)
- [x] `project/reports/mvp-verification.html` + `project/reports/index.md`
- [x] Root `README.md` quickstart
- [x] `docs/MVP.md` ticks with methods, `project/tracker/mvp.md` Phase 6 boxes
- [x] `project/kb-archive/e2e-scenario.md` + index line
- [x] Bug report `project/agents/qa/reports/phase-6-bugs.html` (1 bug, 3 minor observations)
- [x] iOS Simulator run: done after Xcode was installed (Phase 7 native verification, #9; Phase 8a rev 2 iOS session, `project/reports/phase-8a-verification.html`) (N1 2026-10-17)
- [ ] `background` end reason only unit-tested (checklist N15)

## Phase 8a, branch `phase-8a-install-secure` (2026-10-10)

Allowed paths: `tests/e2e/**`, `project/reports/**`, `project/agents/qa/**`, `project/tracker/roadmap.md` (8a ticks),
`project/kb-archive/e2e-scenario.md`, `docs/MVP.md` and `README.md` only if a method or command changed (neither did).

- [x] `tests/e2e/scenario.mjs` through rum-api ingest with the project token, read token on reads, ten gateway checks, `ouo.project.id` assertion via the Tempo datasource proxy; `e2e.sh` passes (run `mv2kfrpc`, 40 sessions, 0 mismatches, `project/agents/qa/reports/e2e-phase-8a-run.json`)
- [x] Real web session in the browser pane: crashed with 12 traces and rrweb replay through :8090 only; plugin Overview / Sessions / detail via the proxy, no token in the browser
- [x] Plugin read token: wrong token banner on three pages, Test connection failure and success, Reset + empty save (key dropped), restore via settings API
- [x] Unload path: keepalive chunk accepted on navigation; pane tab close lost one chunk (finding 4)
- [x] iOS simulator: dev build, checkout + 500 + fatal + relaunch; crashed session with 14 frames / 18 touches, 8 traces, frame uploads with the token (`uploaded seq=…`, replay-ok counter)
- [x] Rate limit 400 burst -> 92 x 429 `Retry-After: 1`, recovery; 413 at 4.3 MB; collector loopback-only
- [x] `project/reports/phase-8a-verification.html` + `project/reports/index.md`; `project/agents/qa/reports/phase-8a-bugs.html`; `project/tracker/roadmap.md` 8a ticks; `project/kb-archive/e2e-scenario.md`
- [ ] Not done: Helm on a cluster, VM install, publish, upgrade (other agents / drills); plugin Viewer-role check; keepalive on stock Chrome tab close; per-project limit overrides live

## Phase 8a revision 2, the collector is the edge (2026-10-13)

Same allowed paths as revision 1. Stack `ouo-8a` (collector OTLP 4330, replay 4331).

- [x] `tests/e2e/scenario.mjs`: OTLP to `OUO_OTLP_URL` and one replay chunk to `OUO_REPLAY_URL` with `Authorization: Basic`, 14 edge / sink / read checks, sorted browser-style preflights, `ouo.project.id=demo` on sampled traces, replay stored with `project_id demo`; rev-1 gateway assertions removed; `e2e.sh` passes (run `mv6swsxe`, 40 sessions, 0 mismatches, `project/agents/qa/reports/e2e-phase-8a-rev2-run.json`)
- [x] Real web session `b652aad5`: crashed, 24+ traces, 14 rrweb chunks; OTLP 20 x 200 to :4330 and replay 10 x 202 to :4331 with `Authorization: Basic`, nothing to :8090; plugin Overview / Sessions / detail via the proxy (temporary replay endpoint override, finding R2-1)
- [x] Unload: seq 12 plain-JSON keepalive chunk with Basic at `pagehide` on cross-origin navigation, stored; tab close delivered seq 13
- [x] iOS `3d4ea94f`: checkout `ord-000002`, 500, fatal, relaunch; crashed / `end_reason crash`, 8 traces, 8 frames chunks / 17 frames, native `uploaded seq=0..7`, Mimir frames accepted 9 (temporary JS override, finding R2-2)
- [x] Collector rate limit: 400 burst -> 307 x 200, 93 x 429 `Retry-After: 1`, recovery; `ouo_ratelimit_rejected_total` 93 in Mimir (self-metrics arrive; 401s not counted, R2-3); body limits 400 / 413
- [x] Plugin read token re-check: proxy 200, wrong token 401 + banner, restore 200
- [x] `project/reports/phase-8a-verification.html` rewritten for revision 2, `project/reports/index.md` line, `project/agents/qa/reports/phase-8a-bugs.html` R2 section, `project/tracker/roadmap.md` project-token item rewritten and ticked, `project/kb-archive/e2e-scenario.md`
- [ ] Not done: per-project rate bucket and quota live; foreign-origin CORS rejection from a real browser (the collector list is global, smoke warns); stock-SDK `OTEL_EXPORTER_OTLP_HEADERS` client; Helm / VM / publish / upgrade (other agents)
