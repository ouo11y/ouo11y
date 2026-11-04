# 2026-11-04 R1: project and app selector, cross-project overview (JUHI)

Branch `claude/r1-project-selector` (stacked on `origin/main` after PR #157). It covers both rum-api and the plugin. Spec: `docs/specs/rum-api-scope.md`.

## Done

- **rum-api**
  - `?project=` (the `ouo_project_id` label funnels already use; an invalid id is a 400) and `?service=` work on every read:
    - `GET /v1/sessions` and `/v1/stats/health` (via `loki.Filters.Project`)
    - session detail, `/traces`, `/logs`, `/vitals`: a session outside the scope is a 404
    - replay meta, events, frames, video and segments: checked against `meta.project_id`; a replay without a project is served in every scope
  - Records carry `project_id`. Health buckets carry `project_id` and gain `apps`, health per (project, service).
  - New `GET /v1/projects`: one Loki `sum by (ouo_project_id, service_name, ouo_platform)` count of `session.start`, default 7 d, at most 720 h.
  - `loki.Client.CountsBy` is a multi-label `Counts`.
- **Plugin**
  - `ScopePicker` (Combobox Project and App) on Overview, Sessions and Funnels. The state is the URL (`project`, `service`) and the default is all.
  - `useScope` helpers. Every `rumApi` call takes the scope, including `traces` and the replay reads; `videoSegmentUrl` takes params.
  - Session detail sends the scope, shows the project, and keeps the scope in its back and previous-session links.
  - Overview "Projects and apps" grid (`ProjectHealthGrid`). VersionTable gets a Project column when projects mix. Sessions rows show the project.
  - The Service text filter is gone from Sessions, and Service / Project are gone from Funnels; the selector replaces them.
  - `useRumQuery` returns `dataKey`. Overview and Sessions hide data from another scope (`isOtherScope`).
- **Tests**
  - Go: `internal/httpapi/scope_test.go` (sessions, health and apps, detail / traces / logs / vitals, replay reads, `/v1/projects` incl. rounding, 501, 401), `internal/session/stats_test.go`, loki `TestCountsBy` and filter cases.
  - Jest: `ScopePicker.test`, `useScope.test`, `api/scope.test`, `Overview.test`, `Sessions.test`, `SessionDetail.scope.test`.
  - e2e: `tests/e2e/scenario.mjs` now expects `project_id`, checks `apps`, `?project=` and `/v1/projects`.
- **Docs**
  - `docs/specs/rum-api-scope.md` (new; it includes the "not an access boundary" section)
  - rum-api README (Scope, Sessions, Stats, Projects), plugin README, `docs/funnels.md`, tiny-shop-funnels guide, `docs/index.md`
  - kb `project/kb/project-scope.md`

## Verified

- `go test ./...` and `go vet ./...` in `services/rum-api`: pass.
- Plugin `jest`: 34 suites, 231 tests. `tsc --noEmit` clean. `eslint`: 0 errors and 7 warnings, all from before this change.
- Live stack `r1scope` (ports 24700-24712):
  - e2e OK as `demo` and as `internal`.
  - Playwright selector run and screenshots: `project/agents/grafana-plugin/reports/r1-project-selector.html`.
- The live run found two bugs, both fixed:
  - Stale data from the previous scope showed under the new labels.
  - `/v1/projects` cut off the last minute.

## Left / next agent

- The Grafana side-menu links in `plugin.json` open unscoped. PR #155 owns `plugin.json` routes and includes. Remembering the last scope (for example in localStorage) would be a follow-up.
- Phase 11 (per-project tokens, org/folder mapping) is unchanged. The selector is not access control.
- Release notes: rum-api after 0.6.0 adds `project_id`, `apps` and `/v1/projects`. The plugin needs that rum-api to show the selector options; with an older rum-api the selector flags "Project list unavailable" and Overview works without the grid.

## Dependencies

None added.
