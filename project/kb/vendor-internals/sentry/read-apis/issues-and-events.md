# Sentry issues and events read API

> How does Muninn find the errors that belong to a replay, and read them in full?

Versions: Sentry self-hosted 26.10.0 (tag `26.10.0`). Research date 2026-11-10. Rate limits are the per-class `rate_limits` from source, `[limit per window, window s, concurrent]`; they are **not enforced on self-hosted** (see [auth-scopes-and-rate-limits.md](auth-scopes-and-rate-limits.md)).

## Endpoints

| Method and path | Status | Scope (user token) | SaaS limit (GET) | Source |
|---|---|---|---|---|
| `GET /api/0/organizations/{org}/issues/` | public | `event:read` | 10/s IP and user, 20/s org | [organization_group_index.py#L265](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/issues/endpoints/organization_group_index.py#L265) |
| `GET /api/0/organizations/{org}/issues/{issue_id}/` (also `/issues/{id}/`, `/groups/{id}/`) | public | `event:read` | 5/s | [group_details.py#L102](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/issues/endpoints/group_details.py#L102) |
| `GET .../issues/{issue_id}/events/` | public | `event:read` | default | [group_events.py#L66](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/issues/endpoints/group_events.py#L66) |
| `GET .../issues/{issue_id}/events/{event_id\|latest\|oldest\|recommended}/` | public | `event:read` | 15/s | [group_event_details.py#L165](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/issues/endpoints/group_event_details.py#L165) |
| `GET .../issues/{issue_id}/tags/{key}/values/` | public | `event:read` | enforced | [group_tagkey_values.py#L33](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/issues/endpoints/group_tagkey_values.py#L33) |
| `GET /api/0/projects/{org}/{project}/events/{event_id}/` | public | `project:read` | 5/s | [project_event_details.py#L107](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/issues/endpoints/project_event_details.py#L107) |
| `GET /api/0/projects/{org}/{project}/events/` | public | `project:read` | 60 per 60 s, 1 concurrent | [project_events.py#L34](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/issues/endpoints/project_events.py#L34) |
| `GET .../events/{event_id}/attachments/` and `/attachments/{id}/?download` | public | `project:read` | default | [event_attachments.py#L36](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/event_attachments.py#L36), [event_attachment_details.py#L92](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/event_attachment_details.py#L92) |
| `GET /api/0/organizations/{org}/eventids/{event_id}/` | public | `org:read` | **1/s** | [organization_eventid.py#L41](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/issues/endpoints/organization_eventid.py#L41) |
| `GET /api/0/organizations/{org}/events/` (Discover / Explore table) | public | `org:read` | 30/s, 15 concurrent | [organization_events.py#L132](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_events.py#L132) |
| `GET /api/0/organizations/{org}/events-timeseries/` | public | `org:read` | 30/s, 15 concurrent | [organization_events_timeseries.py#L111](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_events_timeseries.py#L111) |
| `GET /api/0/organizations/{org}/events-stats/` | **experimental** | `org:read` | default | [organization_events_stats.py#L67](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_events_stats.py#L67) |
| `GET /api/0/organizations/{org}/events/{project}:{event_id}/` | **private** | `org:read` | default | [organization_event_details.py#L79](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/issues/endpoints/organization_event_details.py#L79) |

Docs (accessed 2026-11-10): [Events & Issues](https://docs.sentry.io/api/events/), [Explore table](https://docs.sentry.io/api/explore/query-explore-events-in-table-format/), [timeseries](https://docs.sentry.io/api/explore/query-explore-events-in-timeseries-format/), [Resolve an event id](https://docs.sentry.io/api/organizations/resolve-an-event-id/).

## Issues list

- `query` defaults to `is:unresolved` ([group_index/index.py#L46](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/helpers/group_index/index.py#L46)); pass `query=` (empty) for all. Other params: `statsPeriod`/`start`/`end`, `project` (org tokens need `-1`), `environment`, `sort` (`date` default, `new`, `freq`, `user`, `trends`, `inbox`, `recommended`; [savedsearch.py#L13-L19](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/models/savedsearch.py#L13-L19)), `limit` (not `per_page`), `cursor`, `shortIdLookup`, `expand`, `collapse`.
- Pagination: **score cursors**, e.g. `cursor="1794280862000:0:0"` (last-seen ms for `sort=date`), not offsets. Headers `X-Hits: 17`, `X-Max-Hits: 1000` (observed, [issues-list.headers.txt](fixtures/issues-list.headers.txt)).
- Item fields (observed): `id, shortId, title, culprit, permalink, level, status, substatus, platform, project{id,slug}, type, issueType, issueCategory, metadata, count, userCount, firstSeen, lastSeen, stats, lifetime, filtered, priority, assignedTo, isUnhandled, ...` ([issues-list.json](fixtures/issues-list.json)).

## Events of an issue

- `/issues/{id}/events/`: `per_page`, `cursor` (offset `0:N:0`), `full=true` adds `entries`, `contexts`, `sdk`, `fingerprints`, `_meta` per event; `query`, `environment`, window ([issue-events.json](fixtures/issue-events.json)).
- `/events/latest/` returns one full event plus `nextEventID`/`previousEventID`, `release`, `userReport` ([issue-event-latest.json](fixtures/issue-event-latest.json), breadcrumbs trimmed).
- Replay link in an event (observed): `contexts.replay.replay_id`. Trace link: `contexts.trace.trace_id`, `span_id`. User: top-level `user` and the `user` tag.

## Event by id

- `/projects/{org}/{project}/events/{event_id}/` needs the project. `/organizations/{org}/eventids/{event_id}/` finds it org-wide and returns `{organizationSlug, projectSlug, groupId, eventId, event}` with the full event inside ([eventid-lookup.json](fixtures/eventid-lookup.json)). On SaaS that lookup is limited to **1 request per second**, so Muninn should prefer the project endpoint when the replay already gives `project_id`.
- `error_ids` on a replay are event ids. To map them to issues in one call use Discover: `/events/?dataset=errors&field=id&field=issue.id&field=issue&query=replayId:<replay_id>` or `id:[a,b,c]` (observed: `query=replayId:de88…` returned both errors with `issue.id`).

## Discover / Explore `/organizations/{org}/events/`

| Param | Notes |
|---|---|
| `dataset` | `errors`, `transactions`, `discover`, `issuePlatform`, `spans`, `logs` (`ourlogs` is a deprecated alias), `tracemetrics`, `uptime_results`, `profile_functions`, `processing_errors`, `profiles`, `preprodSize`, `metrics`, `metricsEnhanced`, `spansMetrics`. `replays` and `occurrences` exist but are feature-flagged (observed 400 / "not supported currently") ([snuba/utils.py#L34-L66](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/snuba/utils.py#L34-L66)) |
| `field` (repeatable) | columns and aggregates, e.g. `id`, `title`, `timestamp`, `trace`, `replayId`, `user.id`, `issue`, `issue.id`, `count()` |
| `query`, `sort` (`-timestamp`), `statsPeriod`/`start`/`end`, `project`, `environment` | |
| `per_page` | max **100** for Snuba datasets (400 above), max **9999** for RPC/EAP datasets (`spans`, `logs`, ...) (observed 250 spans; [organization_events.py#L757](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_events.py#L757)) |
| `cursor` | offset `0:N:0` |

Response: `{data:[...], meta:{fields, units, dataset, datasetReason, dataScanned, isMetricsData, tips}}` ([events-errors.json](fixtures/events-errors.json)).

## Consistency delay (observed, 5 runs, [ingest-latency-runs.json](fixtures/measurements/ingest-latency-runs.json))

| Read path | Seconds from send to visible |
|---|---|
| `eventids` lookup | 5.5 – 7.4 |
| project event details | 5.7 – 7.5 |
| Discover `dataset=errors` | 5.8 – 7.6 |
| Discover `dataset=transactions` | 5.8 – 6.6 |

The issue (group) exists at about the same time as the event. A fresh error that names a replay is findable from the replay side (`error_ids:` search) after 2.5 – 5.1 s, i.e. sometimes **before** the error itself can be read. Muninn must retry error lookups for a few seconds.

**Muninn can use it for:** turning a replay's `error_ids` into issue ids, titles, levels and stack traces; showing "errors in this replay"; and going the other way, issue to replays with `replay-count?returnIds=true`.
