# Sentry profiles read API

> Can Muninn fetch the profile behind a slow replay, and which endpoints would it use?

Versions: Sentry self-hosted 26.10.0 (tag `26.10.0`). Research date 2026-11-10.
**Status of this entry: read from source, not verified with real data.** The local instance held no profiles (`dataset=profiles`, `profile_functions` and `has:profiler.id` on spans all returned no rows on 2026-11-10). The profile and chunk endpoints only proxy to the `vroom` service; with a made-up id the profile endpoint answered 500 and the chunks endpoint 400 "error: no chunks found to merge" (observed).

## Endpoints

| Method and path | Status | Scope | Feature flag | Source |
|---|---|---|---|---|
| `GET /api/0/projects/{org}/{project}/profiling/profiles/{profile_id}/` | public | `project:read` | `organizations:profiling` | [project_profiling_profile.py#L86](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/project_profiling_profile.py#L86) |
| `GET /api/0/projects/{org}/{project}/profiling/raw_profiles/{profile_id}/` | private | `project:read` | `organizations:profiling` | [#L165](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/project_profiling_profile.py#L165) |
| `GET /api/0/organizations/{org}/profiling/chunks/?project=&profiler_id=&start=&end=` | public | `org:read` | `organizations:continuous-profiling` | [organization_profiling_profiles.py#L222](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_profiling_profiles.py#L222) |
| `GET /api/0/projects/{org}/{project}/profiling/raw_chunks/{profiler_id}/{chunk_id}/` | private | `project:read` | continuous profiling | [#L177](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/project_profiling_profile.py#L177) |
| `GET /api/0/organizations/{org}/profiling/flamegraph/` | public | `org:read` | profiling | [organization_profiling_profiles.py#L125](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_profiling_profiles.py#L125) |
| `GET /api/0/organizations/{org}/events/?dataset=profile_functions` | public | `org:read` | | [snuba/utils.py#L34-L55](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/snuba/utils.py#L34-L55) |

Routes: [api/urls.py#L3389-L3404](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/urls.py#L3389-L3404). Self-hosted 26.10.0 enables `organizations:profiling` and `organizations:continuous-profiling` in the feature-complete profile ([sentry.conf.example.py#L417-L422](https://github.com/getsentry/self-hosted/blob/26.10.0/sentry/sentry.conf.example.py#L417-L422)).

## How to reach a profile from a replay

- Transaction-based profiles: spans (and the `/trace/` tree) carry `profile_id`. Call the project profile endpoint with it.
- Continuous profiles (UI profiling): spans carry `profiler_id`; call `profiling/chunks/` with that `profiler_id`, the project, and the span's time window. The chunk ids are found by a Snuba query inside the endpoint (`get_chunk_ids`).
- Response format is the Sentry sample profile JSON produced by vroom (not verified here).

**Muninn can use it for:** a "profile" link on slow spans. Low priority: link out to Sentry instead of copying profiles until a pilot needs them.
