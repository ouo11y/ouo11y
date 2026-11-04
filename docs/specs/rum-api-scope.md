# Project and app scope on rum-api reads

Status: normative since rum-api after 0.6.0 and the plugin after 0.10.0 (JUHI gap R1, 2026-11-04).

One Grafana organisation often watches several projects (a project is one ingest credential) and
several apps per project (an app is one `service.name`). Every rum-api read takes the same two
optional query parameters, and the Grafana plugin sends them on every call from one selector.

## Terms

| Term | Telemetry | Loki | Set by |
|---|---|---|---|
| project | resource attribute `ouo.project.id` | stream label `ouo_project_id` | the collector, from the ingest credential's Basic username. The value the client sends is overwritten (ADR-0007). |
| app | resource attribute `service.name` | stream label `service_name` | the SDK (`serviceName`) |

The project is the same label that funnels (`docs/specs/funnels.md`), retention and
delete-by-project already use. A project id matches `^[a-z0-9][a-z0-9._-]{0,63}$`.

## Parameters

- `project=<id>`: only telemetry with that `ouo_project_id`. If the id is not valid, the response is `400 {"error":"invalid project id"}`.
- `service=<service.name>`: only that app.
- Both are optional. If neither is given, the read covers all projects and apps (the cross-project view).
- Both can be combined. A `service` with no `project` matches that app name in every project.

## Endpoints

| Endpoint | Effect of the scope |
|---|---|
| `GET /v1/sessions` | Adds the stream matchers `ouo_project_id="<id>"` and `service_name="<name>"`. Each record carries `project_id` (`""` when the session was ingested without one). |
| `GET /v1/stats/health` | Same matchers. Each bucket carries `project_id` and the bucket key is (project, platform, service, version). A new `apps` array gives health per (project, app) across versions and platforms, sorted by project and then service. |
| `GET /v1/sessions/{id}`, `/traces`, `/logs`, `/vitals` | The session's events are looked up inside the scope. A session outside the scope is `404 session not found`, the same as a missing one. `/logs` still includes the lines of other services that share the session's traces (the backend), because those carry no project. |
| `GET /v1/sessions/{id}/replay`, `/replay/events`, `/replay/frames`, `/replay/video`, `/replay/video/{seq}` | `project` is checked against the replay meta's `project_id`. A replay of another project is `404 no replay for session`. A replay stored without a project (before Phase 8a) is served in every scope. `service` is not checked, because a replay has no `service.name`. |
| `POST /v1/funnels/query`, `GET /v1/funnels/dropped`, `GET /v1/funnels/steps` | Unchanged: they already take `project` and `service` (`filters.project` / `filters.service` in the body). |
| `GET /v1/sourcemaps` | Unchanged: `project` was already required. |

`DELETE` routes and `/v1/admin/*` are not reads and take no scope.

## `GET /v1/projects`

This endpoint provides the selector's options: every project and app that started a session in the range.

`GET /v1/projects?from=now-7d&to=now` (read token). Rules:

- The default range is 7 days and the maximum is 720 h. A longer range is `400`, so the query stays under Loki's default `max_query_length`.
- `from` is rounded down and `to` up to the minute, so a session that just started is still counted.

```json
{"projects":[
  {"project_id":"bank","sessions":4,"apps":[{"service_name":"bank-web","platforms":["web"],"sessions":4}]},
  {"project_id":"shop","sessions":10,"apps":[
    {"service_name":"shop-rn","platforms":["mobile","web"],"sessions":3},
    {"service_name":"shop-web","platforms":["web"],"sessions":7}]}],
 "unscoped_sessions":0,"from":"...","to":"..."}
```

How the response is built:

- The endpoint makes one Loki instant query:
  `sum by (ouo_project_id, service_name, ouo_platform) (count_over_time({service_name=~".+", event_name="session.start"} [<range>s]))`.
  It counts `session.start` records, so a session that started before `from` is not counted.
- Projects are sorted by id, and apps by `service_name` within each project.
- `unscoped_sessions` counts sessions without `ouo.project.id`. The selector cannot narrow to them, but they still appear in the "all" view.
- Without a Loki client (only test fakes), the response is `501`.

## Plugin

- **Selector.** Overview, Sessions and Funnels show the Project and App selectors next to the time range.
  - The state lives in the URL query (`project`, `service`), so every in-app link carries it: Overview → Sessions → Session detail → back.
  - Changing the scope drops `dropped` and `offset`, because those belong to the old scope.
  - The default is "All projects" / "All apps", which is the cross-project view.
- **Session detail.** It has no selector of its own. It sends the URL scope on every call, shows the session's project, and keeps the scope in its links.
- **Overview.**
  - Without an app selected, it opens with **Projects and apps**: one card per project, side by side, with the project's healthy / errored / crashed shares and one row per app.
  - Clicking a project or an app scopes the page to it.
  - The platform sections and their version tables follow below. A version table has a Project column when it mixes projects.
- **Sessions.** The free-text Service filter is gone, because the App selector replaces it. Each row shows its project.
- **Funnels.** The Service and Project text inputs are gone, because the selectors replace them. The URL keys are the same.

## Not an access boundary

The scope narrows what a page shows. It is not access control:

- rum-api has one read token (`OUO_READ_TOKEN`).
- The plugin proxy adds that token to every call.
- Anyone who can open the plugin can pick any project, or edit the URL.

Per-project tokens, and a mapping from Grafana organisation or folder to project, are Phase 11
(`project/tracker/roadmap.md`). Until then, isolate tenants with separate stacks, or with separate
Grafana organisations that each point at their own rum-api.
