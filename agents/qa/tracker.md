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
