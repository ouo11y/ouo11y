# 2026-10-17 Batch 0, step 1: B5 repository layout

Founder approved the B5 layout from `project/tracker/roadmap.md` on 2026-10-17 and asked for it while no other session writes to the repo. Decision recorded as [ADR-0010](../../../../docs/adr/0010-repository-layout.md) (accepted; 0009 is taken by the naming proposal, PR #27).

## Done

- `git mv` only, history follows (`git log --follow`): `agents/`, `kb/`, `tracker/`, `reports/` → `project/`; `deploy/docker` → `deploy/compose`. Root `RELEASING.md` merged into `docs/releasing.md` (one document, 11 sections: packages, semver incl. the quick table and image rules, pre-releases, triggers, per-package procedure, image release checklist, local checks, pull access, secrets, changelogs, not automated).
- References rewritten in 177 files with a two-pass script (link targets resolved against the old tree and recomputed; prose paths prefixed), method in [project/kb/repo-layout.md](../../../kb/repo-layout.md). False positives fixed by hand (an agent folder's own `reports/`, historical "before" sentences in roadmap B5 and the release tracker).
- AGENTS.md: "Read first" now starts at `project/tracker/checklist.md`; layout block rewritten; rule that new top-level entries need an ADR and that links are checked. README "Where things live" table rewritten product first. LICENSE table paths. `docs/index.md`, `docs/adr/README.md`, `project/kb/index.md`.
- CI: new job `links` (`lycheeverse/lychee-action@v2.9.0`, lychee 0.24.2, `--offline`, excludes `node_modules` and `/dist/`). Collector config validation path in `ci.yml` now `deploy/compose/collector/config.yaml`.
- Trackers: roadmap B5 and checklist B5 ticked, founder decision 4 (layout) marked approved.

## Verified (how)

- `lychee --offline` over every tracked `.md` / `.html`: 326 links, 0 errors. Negative check: a missing Markdown and HTML target both fail.
- `actionlint` clean.
- `go vet ./... && go test ./...` in all 7 Go modules: pass. rum-api `TestS3Errors` / `TestS3ServeContentRange` failed once on a MinIO image pull timeout (Docker Hub was timing out all evening), passed on rerun (that test pulls an image, checklist N11).
- `npm ci`, build and test of all workspaces: browser 61, plugin 82, react-native 119 tests pass.
- `helm lint` and `helm template` with default (plus required values), kind, HA and external-LGTM values.
- `docker compose -p ouo-b5check -f deploy/compose/compose.yaml build` (third-party pulls retried after Docker Hub timeouts), `up`, `wait-ready.sh`, `smoke.sh` (SMOKE OK) and `e2e.sh` (E2E OK, 40 sessions) on isolated ports 23xxx; Grafana image built from `deploy/images/grafana/Dockerfile` with the plugin baked in. Stack removed afterwards (`down -v`: a throwaway check stack with no data worth keeping).
- The founder's running `ouo` stack was not touched: its project name comes from `name: ouo` in the compose file, not the folder.

## Left / next agent must know

- Old paths in open branches: rebase onto main after this merges; git's rename detection carries edits on moved files.
- ADR-0009 rename (PR #27) runs after batch 0 as its own mechanical PR. Folder names carry no product name except `plugins/ouo-rum-app`.
- No new dependency in the repo; lychee runs only in CI (and from a downloaded release binary locally).
