# PostHog read APIs we could consume

- **PostHog server:** commit `d231ab1719020024c6219d10dc7775f6621fd72c` (2026-11-10).
- **Method:** read from source. No API call was made: we have no PostHog instance or account, by Step 6 rules.
- **Date:** 2026-11-10.
- **Source key:** `ph:` = `https://github.com/PostHog/posthog/blob/d231ab1719020024c6219d10dc7775f6621fd72c/`.

## Auth

- **Personal API key:**
  - Sent as `Authorization: Bearer <phx_…>`, or as `personal_api_key` in the body or query (ph:posthog/auth.py L280-329).
  - Keys are scoped per object with `:read` / `:write` (ph:posthog/scopes.py: `person` L109, `query` L115, `session_recording` L120).
- **Project token vs personal key:** the project token (`phc_…`) is write-only for ingestion. Capture rejects anything that looks like a personal key (ph:rust/capture/src/token.rs L45-64).
- **Rate limits apply only to personal-key requests.** The bucket is the hashed key, then team, user and IP (ph:posthog/rate_limit.py L268-297).

## Session recordings

`SessionRecordingViewSet` (ph:posthog/session_recordings/session_recording_api.py L1069-1110) requires the scope `session_recording:read`. Filtering on `experiment_exposure` additionally requires `experiment:read`.

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /api/projects/:id/session_recordings` | List | Filters from `RecordingsQuery` (ph:posthog/schema.py L31790+): `date_from` (default `-3d`), `date_to`, `events`, `actions`, `properties`, `having_predicates` (for example `active_seconds`, `console_error_count`), `person_uuid`, `distinct_ids`, `session_ids`, `filter_test_accounts`, `console_log_filters`, `order`, `order_direction`, `limit` (default 50), `offset`, `after`, `comment_text`. Offset pagination when `offset` is set, otherwise cursor (`after` / `next_cursor`). Response `{results, has_next, version: 4, next_cursor?}` (L676-708; queries/session_recording_list_from_query.py L67, L224-240) |
| `GET …/session_recordings/:session_id` | Metadata | From `session_replay_events`: duration, active seconds, click and console counts, start URL, person |
| `GET …/session_recordings/:session_id/snapshots` | Step 1: block list | `{sources: [{source: "blob_v2", blob_key: "<i>", start_timestamp, end_timestamp}], replay_proxy_token, block_token, block_token_expires_at}` (L1799-1846) |
| `GET …/snapshots?source=blob_v2&start_blob_key=N&end_blob_key=M` | Step 2: data | At most **20 blocks per call for personal API keys** (100 otherwise). `decompress=true` (default) returns `application/jsonl`, one `[windowId, rrwebEvent]` per line. `decompress=false` returns `application/octet-stream` length-prefixed compressed blocks. `Cache-Control: max-age=3600` (L541-585, L1970-2003) |
| `DELETE …/session_recordings/:id`, bulk delete (≤ 100) | Delete | Crypto-shred, see [storage](../storage/storage-and-ingestion.md#5-retention-and-deletion) |

- **No realtime source:** only `blob_v2` or nothing is accepted. A live session becomes visible after the ~10 s ingestion flush plus ClickHouse merge *(inferred)*.
- **What the JSONL contains:** web events still have their `cv: "2024-10"` gzip strings. The player decompresses them, so a consumer must too. Mobile events come back as wireframes.

### Throttles for personal API keys

Source: ph:posthog/settings/session_replay.py L26-48; ph:posthog/rate_limit.py L608-619.

| Class | Free | Paid | Enterprise |
|---|---|---|---|
| Snapshots | 12/min, 60/h | 60/min, 300/h | 100/min, 400/h |
| Listing | same tiers | | |
| Viewset default | ClickHouseBurst 240/min, ClickHouseSustained 1200/h | | |
| Per-user blob fetch | 200/min, 3000/h (log-only by default) | | |

Implication: pulling every recording of a busy project through the API is slow. At 60 snapshot calls per hour and 20 blocks per call, the paid tier moves about 1,200 blocks per hour.

## Query API (HogQL)

`POST /api/projects/:id/query` (ph:posthog/api/query.py), scope `query:read`.

- **Request:** `{"query": {"kind": "HogQLQuery", "query": "select … from events where …"}, "refresh": "blocking"|"async"|…, "client_query_id": "…", "name": "…"}`.
- **Async mode:** poll `GET /api/projects/:id/query/:client_query_id` (L514).
- **Response:** `{results, columns, types, hasMore, limit, offset, hogql, clickhouse, timings, query_status?, error?}`.
- **Row limits:** default 100 and maximum 50,000 per query. Paginate with `LIMIT` and `OFFSET` in HogQL. CSV export allows 300,000 (ph:posthog/hogql/constants.py L44, L47, L75).
- **Throttles:**
  - `APIQueriesBurst` 240/min and `APIQueriesSustained` 2400/h for teams on the new API queries setting.
  - Otherwise `HogQLQueryThrottle` 120/h, which `team.api_query_rate_limit` can override.
  - Otherwise ClickHouse burst and sustained (query.py L306-324; rate_limit.py L1030-1044).
- **Tables useful to RUM:**
  - `events` (with `elements_chain` and `properties.$…`)
  - `sessions` (virtual, see [storage](../storage/storage-and-ingestion.md#3-sessions-in-clickhouse))
  - `persons`
  - `session_replay_events` (exposed in HogQL; the `snapshot_mode_v2` column is not, per ph:docs/internal/mobile-replay-capture-mode.md)

Example: errors per session with a replay.

```sql
select $session_id, count() as errors
from events
where event = '$exception' and timestamp > now() - interval 1 day
group by $session_id order by errors desc limit 100
```

## Persons

- **Endpoint:** `GET /api/projects/:id/persons`, scope `person:read`.
- **Pagination:** limit and offset, `DEFAULT_PAGE_LIMIT` 100 (ph:posthog/api/person.py L107, L718-731).

## Self-hosted vs cloud

| | Cloud | Self-hosted / hobby |
|---|---|---|
| Recording retention default | 30 d (by plan up to 5 y) | 5 y |
| Replay blobs | S3 *(inferred)* | SeaweedFS (dev defaults); MinIO in older settings |
| Rate limits | Plan tiers above | Same code. Tiers keyed on billing features *(inferred: self-hosted resolves to the free tier unless configured)* |
| Hosts | `us.i.posthog.com` / `eu.i.posthog.com` for ingestion; `us.posthog.com` for the API | One host |
