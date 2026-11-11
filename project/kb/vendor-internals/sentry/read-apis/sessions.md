# Sentry sessions and release health read API

> What can Muninn read about release-health sessions, and can it get one session's details?

Versions: Sentry self-hosted 26.10.0 (tag `26.10.0`). Research date 2026-11-10.

**Short answer: aggregates only.** Sessions are counted into metrics on ingest. There is no API that returns one session, its id, its user, or its timeline. Muninn's "session" view for Sentry data has to be built from replays (which have ids, users and timelines), not from release-health sessions.

## Endpoints

| Method and path | Status | Scope | Rate limit (SaaS) | Source |
|---|---|---|---|---|
| `GET /api/0/organizations/{org}/sessions/` | public | `org:read` | default | [organization_sessions.py#L35](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_sessions.py#L35) |
| `GET /api/0/organizations/{org}/releases/?health=1` | public | `project:read` (or `org:ci` for org tokens) | 40/s | [organization_releases.py#L333](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_releases.py#L333) |
| `GET /api/0/organizations/{org}/releases/{version}/?health=1` | public | same | default | `organization_release_details.py` |

Docs: [Retrieve Release Health Session Statistics](https://docs.sentry.io/api/releases/retrieve-release-health-session-statistics/) (accessed 2026-11-10).

## `/sessions/` parameters

| Param | Values | Source / observed |
|---|---|---|
| `field` (required, repeatable) | `sum(session)`, `count_unique(user)`, `avg/p50/p75/p90/p95/p99/max(session.duration)`, `crash_rate`, `crash_free_rate`, `unhandled_rate`, `errored_rate`, `abnormal_rate`, `unhealthy_rate` (each `(session)` or `(user)`), `anr_rate()`, `foreground_anr_rate()` | [release_health/metrics_sessions_v2.py#L376-L397](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/release_health/metrics_sessions_v2.py#L376-L397) |
| `groupBy` | `project`, `environment`, `release`, `session.status` (healthy, abnormal, crashed, errored, unhandled) | [sessions_v2.py#L252-L257](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/snuba/sessions_v2.py#L252-L257). Observed: `groupBy=session.id` and `groupBy=user` → 400 `Invalid groupBy` ([sessions-groupby-session-id-rejected.json](fixtures/sessions-groupby-session-id-rejected.json)) |
| `interval` | `1m` ... `1d` | Too many buckets → 400 "Your interval and date range would create too many results" (observed with 30d/1m) |
| `statsPeriod` / `start`+`end`, `project`, `environment`, `query` (`release:`, `environment:`) | as elsewhere | **Org auth tokens need `project=-1`** or get 400 "No projects available" (observed) |
| `orderBy`, `per_page` | order groups by a field; limit groups | Link header with `cursor=0:5000:0` (observed) |

Constraints observed: `crash_free_rate(session)` cannot be combined with `groupBy=session.status` (400). Response: `{groups:[{by:{...}, totals:{field:value}, series:{field:[...]}}], start, end, intervals, query}` ([sessions-grouped.json](fixtures/sessions-grouped.json), [sessions-by-status.json](fixtures/sessions-by-status.json)).

## Why there is no per-session detail (verified)

- ClickHouse in the 26.10.0 self-hosted stack has no sessions table. `system.tables` lists `replays_local`, `eap_items_*` and `metrics_raw_v2_local`, nothing named `sessions*` (observed with `clickhouse-client`).
- The endpoint runs `run_sessions_query` from the metrics release-health backend ([organization_sessions.py#L33](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_sessions.py#L33)).
- `groupBy` accepts only the four dimensions above.

## Release health on releases

`GET /organizations/{org}/releases/?project=-1&health=1&healthStatsPeriod=24h` adds `projects[].healthData` with `crashFreeUsers`, `crashFreeSessions`, `sessionsCrashed`, `sessionsErrored`, `totalUsers`, `totalSessions` (+`24h` variants), `adoption`, `sessionsAdoption`, `durationP50/P90`, `stats`, `hasHealthData` ([releases-health.json](fixtures/releases-health.json)).

## Consistency delay (observed)

A fresh session envelope (unique release each time) became visible in `/sessions/` after **48.7 s, 50.1 s and 52.7 s** (3 runs, [ingest-latency-runs.json](fixtures/measurements/ingest-latency-runs.json)). That is much slower than errors (~6 s) and replays (~4 s), because sessions go through the metrics pipeline.

**Muninn can use it for:** crash-free rates and session counts per project, release and environment, to show next to its own replay list. It cannot link a release-health session to a replay. Poll it on an interval of minutes and treat the last ~1–2 minutes as incomplete.
