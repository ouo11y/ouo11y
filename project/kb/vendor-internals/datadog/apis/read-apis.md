# Datadog read APIs a bridge could use

- **Research date:** 2026-11-10. Sources are the docs pages named below, all accessed 2026-11-10.
- The API reference is <https://docs.datadoghq.com/api/latest/rum/>.
- The OpenAPI spec is `datadog-api-client-go` `.generator/schemas/v2/openapi.yaml` (master), called SPEC below.
- **Not verified against a live account:** we have none, by design.

## RUM events

| Endpoint | Use |
|---|---|
| `POST /api/v2/rum/events/search` | Search with a JSON body (<https://docs.datadoghq.com/api/latest/rum/search-rum-events.md>) |
| `GET /api/v2/rum/events` | Same, with query parameters `filter[query]`, `filter[from]`, `filter[to]`, `sort`, `page[cursor]`, `page[limit]` |
| `POST /api/v2/rum/analytics/aggregate` | Counts, percentiles and timeseries grouped by facets (<https://docs.datadoghq.com/api/latest/rum/aggregate-rum-events.md>) |

**Search body:**
- `filter {query (default "*"), from (default now-15m), to (default now)}`. `from` and `to` accept ISO 8601, date math or epoch ms.
- `options {timezone | time_offset}`
- `page {cursor, limit}`
- `sort: timestamp | -timestamp`

**Paging:**
- `page.limit` defaults to 10; SPEC gives a maximum of **1000**.
- The next page is the same request with `page[cursor] = meta.page.after`. `links.next` is also given.
- A response has `meta.status: done | timeout` and `meta.warnings[]`. Results can be partial.

**Response item:**
- `{id, type: "rum", attributes: {attributes: <the original RUM event>, service, tags[], timestamp}}`.
- **So the API returns the same JSON as the intake schema** ([event-schema.md](../wire-format/event-schema.md)), wrapped. All event types come through one endpoint; filter with `@type:view` and so on.
- Only data within retention is available: 30 days, or 15 days for resources, long tasks and vitals. No other range cap is documented.

**Aggregate:**
- `compute[] {aggregation: count|cardinality|pc75…pc99|sum|min|max|avg|median, metric, type: total|timeseries, interval}`
- `group_by[] {facet, limit, histogram, missing, sort, total}`

## Session Replay

- **Segments are downloadable through a documented endpoint:** `GET /api/v2/rum/replay/sessions/{session_id}/views/{view_id}/segments` (<https://docs.datadoghq.com/api/latest/rum-replay-sessions/get-segments.md>, verified by fetching the page).
  - Permission: `rum_session_replay_read`.
  - Query: `source` ("Storage source: 'event_platform' or 'blob'"), `ts` (server timestamp ms), `max_list_size` (bytes), `paging` (token from the `X-Paging` response header).
  - SPEC: keep paging while `X-Has-More-Segments-To-Fetch: true`.
  - **The 200 response is documented only as "OK"**, with no schema or content type. Expect the SDK segment format ([browser-replay-format.md](../wire-format/browser-replay-format.md), [mobile-replay-wireframes.md](../mobile-sdks/mobile-replay-wireframes.md)), but this is unverified.
  - The endpoint was added to the public Go client on 2026-02-03. No preview label.
  - **Risk:** an undocumented payload that can change without notice. A bridge must test it against a real account and version its decoder.
- **Other replay endpoints (SPEC):**
  - Playlists: `/api/v2/rum/replay/playlists[/{id}][/sessions[/{session_id}]]`.
  - Watchers and viewership: `/api/v2/rum/replay/sessions/{id}/watchers`, `/watches`, `/api/v2/rum/replay/viewership-history/sessions`.
  - Heatmap snapshots: `/api/v2/replay/heatmap/snapshots`.
- To find replays: search RUM `view` events with `@session.has_replay:true`, then call segments per `session.id` / `view.id`.

## Other RUM endpoints (SPEC)

- Applications CRUD `/api/v2/rum/applications`, with `rum_apps_read` / `rum_apps_write`.
- Retention filters `/api/v2/rum/applications/{app_id}/retention_filters` (+ `/exclusion`, `/permanent`); retention quotas.
- RUM-based metrics `/api/v2/rum/config/metrics`.
- Managed Archive and recovery: `/api/v2/rum/config/archive`, `/api/v2/rum/recover/*`. Very new (client code dated 2026-11-06).

## Auth, sites and rate limits

- **Headers:** `DD-API-KEY` + `DD-APPLICATION-KEY`, or `Authorization: Bearer <personal or service access token>` (<https://docs.datadoghq.com/api/latest/authentication/>).
- **Permissions:** events need `rum_apps_read`; replay needs `rum_session_replay_read`. Application keys can be scoped. Scope names match permission names in SPEC; this is unverified in the docs.
- **API hosts:** `api.datadoghq.com`, `api.us3.datadoghq.com`, `api.us5.datadoghq.com`, `api.datadoghq.eu`, `api.ap1.datadoghq.com`, `api.ap2.datadoghq.com`, `api.uk1.datadoghq.com`, `api.ddog-gov.com`, `api.us2.ddog-gov.com`.
- **Rate limits:**
  - **No number is published** for the RUM endpoints.
  - Read `X-RateLimit-Limit`, `-Period`, `-Remaining`, `-Reset` and `-Name`, and back off on 429 (<https://docs.datadoghq.com/api/latest/rate-limits/>).

## Bulk alternative

**RUM Export Pipelines** stream ingested RUM events to the customer's S3, GCS or Azure bucket (<https://docs.datadoghq.com/real_user_monitoring/rum_export/>):
- Formats: NDJSON `.json.gz` or Parquet.
- Path: `dt=YYYYMMDD/hour=HH/…`.
- Presets: all event types, or sessions, views and actions only.
- For a bridge this is sturdier than polling the rate-limited search API.
- Replays are not mentioned. Preview status is unclear.

Other export paths:
- Explorer CSV export: up to 5 000 events.
- Managed Archive: Datadog-managed cold storage with recovery into the Explorer. No file access.
