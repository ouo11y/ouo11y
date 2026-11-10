# Sentry replay read API

> How does Muninn list Sentry replays, fetch their metadata, and download every rrweb segment and mobile video, and what can go wrong?

Versions: Sentry self-hosted **26.10.0** (`getsentry/sentry` tag `26.10.0`, commit `da07b233`), compose project `sentry-sbx`. Research date 2026-11-10.
Source links are pinned to the tag. "Observed" means measured against the local instance; the fixture or command is named.

## Endpoint map

| # | Method and path | Status (`publish_status`) | Scope (user token) | What it returns | Source |
|---|---|---|---|---|---|
| R1 | `GET /api/0/organizations/{org}/replays/` | public | `org:read` | Page of replay summaries | [organization_replay_index.py#L34](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/organization_replay_index.py#L34) |
| R2 | `GET /api/0/organizations/{org}/replays/{replay_id}/` | public | `org:read` | One replay summary | [organization_replay_details.py#L225](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/organization_replay_details.py#L225) |
| R3 | `GET /api/0/projects/{org}/{project}/replays/{replay_id}/` | **private** (GET); DELETE public | `project:read` | Same body as R2 | [project_replay_details.py#L33](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/project_replay_details.py#L33) |
| R4 | `GET /api/0/projects/{org}/{project}/replays/{replay_id}/recording-segments/` | public | `project:read` | **Segment contents**, `[[seg0 events], [seg1 events], ...]` | [project_replay_recording_segment_index.py#L29](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/project_replay_recording_segment_index.py#L29) |
| R5 | `GET .../recording-segments/{segment_id}/` | public | `project:read` | Segment metadata `{replayId, segmentId, projectId, dateAdded}` | [project_replay_recording_segment_details.py#L60](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/project_replay_recording_segment_details.py#L60) |
| R6 | `GET .../recording-segments/{segment_id}/?download` | public | `project:read` | Raw rrweb JSON array of one segment | same file, [#L88](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/project_replay_recording_segment_details.py#L88) |
| R7 | `GET .../replays/{replay_id}/videos/{segment_id}/` | **experimental** | `project:read` | The mp4 of one mobile segment, supports one `Range` | [project_replay_video_details.py#L36](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/project_replay_video_details.py#L36) |
| R8 | `GET .../replays/{replay_id}/clicks/` | public | `project:read` | Clicked DOM nodes matching a selector query | [project_replay_clicks_index.py#L60](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/project_replay_clicks_index.py#L60) |
| R9 | `GET /api/0/organizations/{org}/replay-selectors/` | public | `org:read` | Dead/rage click selectors with counts | [organization_replay_selector_index.py#L83](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/organization_replay_selector_index.py#L83) |
| R10 | `GET /api/0/organizations/{org}/replay-count/` | public | `org:read` | Replay counts (or ids) per issue / transaction / replay id | [organization_replay_count.py#L69](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/organization_replay_count.py#L69) |
| R11 | `GET /api/0/organizations/{org}/replays-events-meta/` | **private** | `org:read` | Discover rows (errors etc.) for a replay | [organization_replay_events_meta.py#L18](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/organization_replay_events_meta.py#L18) |
| R12 | `GET /api/0/projects/{org}/{project}/replays/{replay_id}/viewed-by/` | public (GET), private (POST) | `event:read` | Users who viewed the replay (full user objects, with emails) | [project_replay_viewed_by.py#L37](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/project_replay_viewed_by.py#L37) |
| R13 | `GET/POST .../replays/{replay_id}/summarize/` | **experimental** | `event:read` | AI summary (Seer). Self-hosted: 403 "Replay summaries are not available for this organization." (observed) | [project_replay_summary.py#L52](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/project_replay_summary.py#L52) |
| R14 | `DELETE /api/0/projects/{org}/{project}/replays/{replay_id}/` | public | `project:write` or `project:admin` | Deletes one replay (not tested: no writes) | [project_replay_details.py#L85](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/project_replay_details.py#L85) |
| R15 | `GET/POST /api/0/projects/{org}/{project}/replays/jobs/delete/` (+ `/{job_id}/`) | public | `project:write` or `project:admin` | Batch deletion jobs (not tested) | [project_replay_jobs_delete.py#L96](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/project_replay_jobs_delete.py#L96) |

Routes: [api/urls.py#L2738-L2760](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/urls.py#L2738-L2760) (org) and [#L3213-L3255](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/urls.py#L3213-L3255) (project). The status, scope and rate-limit columns come from a dump of Django's URL resolver inside `sentry-sbx-web-1` ([routes-26.10.0.json](fixtures/measurements/routes-26.10.0.json)) and were checked with real tokens ([scope-matrix.json](fixtures/measurements/scope-matrix.json)).
Public docs: [Replays API](https://docs.sentry.io/api/replays/) (accessed 2026-11-10). There is no docs page for the video endpoint, `replays-events-meta` or `summarize`.

All replay endpoints first check the feature `organizations:session-replay` (404 if off) and then `has_replay_permission` (403) ([organization_replay_endpoint.py#L22-L31](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/organization_replay_endpoint.py#L22-L31)). See [auth-scopes-and-rate-limits.md](auth-scopes-and-rate-limits.md).

**Muninn can use it for:** R1 to discover replays and changes, R2 for one replay's summary, R4 or R5+R6 for rrweb segments, R7 for mobile video, R10 to map issues to replays. R3, R11 and R13 are private or experimental; do not depend on them.

## R1 list replays

Query parameters (validator [validators.py#L41](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/validators.py#L41), endpoint [#L50-L135](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/organization_replay_index.py#L50-L135)):

| Param | Default | Effect | Source / observed |
|---|---|---|---|
| `statsPeriod` or `start`+`end` | 90 days (`MAX_STATS_PERIOD`) | Window on **segment row timestamps** (see below) | [api/utils.py#L79](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/utils.py#L79); observed |
| `project` | the caller's member projects | Project ids; `-1` = all accessible. **Org auth tokens get zero projects unless `project=-1` or explicit ids** | observed: org token returned `{"data":[]}` without it, 17 rows with it |
| `projectSlug` | none | Same by slug, takes precedence | endpoint `get_query_params_with_project_slug_precedence` |
| `environment` | all | Repeatable | source |
| `field` | all fields | Repeatable; must be one of 32 names in `VALID_FIELD_SET`, else 400 | [validators.py#L5-L38](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/validators.py#L5-L38) |
| `sort` / `sortBy` / `orderBy` | `-started_at` | `-` prefix = descending. Tie-breaker `replay_id`. `count_segments` is **not** sortable (400) | [usecases/query/\_\_init\_\_.py#L59](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/query/__init__.py#L59), [aggregate_sort.py](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/query/configs/aggregate_sort.py); observed |
| `query` | none | Sentry search syntax, keys below | [aggregate.py#L150-L180](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/query/configs/aggregate.py#L150-L180) |
| `per_page` | 100 | 1..100, else 400 "Invalid per_page value" | observed |
| `cursor` | `0:0:0` | `0:<offset>:<is_prev>`; offset pagination | [#L137-L160](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/organization_replay_index.py#L137-L160) |
| header `X-Preferred-Data-Source` | `scalar` | `aggregated` forces the slower strategy. Debug knob. Response header `X-Data-Source: scalar-subquery` | observed [replays-list.headers.txt](fixtures/replays-list.headers.txt) |

Fields returned when `field` is omitted (observed, [replays-list.json](fixtures/replays-list.json)): `activity, browser, clicks, count_dead_clicks, count_errors, count_infos, count_rage_clicks, count_segments, count_urls, count_warnings, device, dist, duration, environment, error_ids, finished_at, has_viewed, id, info_ids, is_archived, os, ota_updates, platform, project_id, releases, replay_type, sdk, segment_names, started_at, tags, trace_ids, urls, user, warning_ids`.
`replay_type` and `ota_updates` are returned but **cannot be requested with `field=`** (observed: 400 `"replay_type" is not a valid choice`). The public docs list `replay_type` as a field; the 26.10.0 validator does not.

Search keys (`query=`): `id`, `error_ids`/`error_id`, `trace_ids`/`trace_id`/`trace`, `info_ids`, `warning_ids`, `urls`/`url`/`screen`/`screens`, `user`, `user.id/email/username/ip`, `user.geo.*`, `release(s)`, `dist`, `environment`, `platform`, `replay_type` (`session`/`buffer`), `sdk.name/version`, `os.*`, `browser.*`, `device.*`, `ota_updates.*`, `tap.*`, `click.*`, `dead.selector`, `rage.selector`, `count_*`, `duration`, `activity`, `is_archived`, `segment_names`, `viewed_by_id`/`viewed_by_me`, and any tag. There is **no `started_at` or `finished_at` search key**, so "changed since" must use the time window. Observed: `query=platform:cocoa count_errors:>0` works.

### Time-window semantics (observed)

- The window selects replays that have **any segment row** whose timestamp is inside it. The returned aggregates are then computed over the whole replay ([two-step query](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/query/__init__.py#L222-L318)). Observed with replay `4805a6…` (22:58:28 to 23:03:19): window 23:03–23:30 returns it with all 52 segments and the full duration; window 23:04–23:30 returns nothing.
- The row timestamp is the **SDK's event timestamp, not the receive time.** Observed: a replay sent at 03:34 with segment timestamps 3 h old was invisible to `statsPeriod=1h` and visible to `statsPeriod=4h` (see [muninn-sync-recipe.md](muninn-sync-recipe.md)).
- The scalar strategy may find replay ids whose segment 0 is missing; those replays are dropped from the page, which can make a page shorter than `per_page` ([comment at #L337-L341](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/query/__init__.py#L337-L341)). The aggregated strategy requires `min(segment_id) = 0`.

Pagination is offset based (`ReplayPaginator` asks for `limit+1` rows to set `results="true"`). Offsets shift when new replays arrive during a scan; see [pagination.md](pagination.md).

## R2 replay details

`GET /organizations/{org}/replays/{replay_id}/`. Same object as one R1 row, wrapped in `{"data": {...}}` ([replay-details.json](fixtures/replay-details.json)). Uses all accessible projects, so it works for org tokens without `project=-1`. Window defaults to 90 days. Unknown or malformed id: **404 with an empty body** (observed). Feature flag `organizations:replay-details-eap-query` switches the backend to EAP; it is not in the self-hosted feature list ([#L276](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/organization_replay_details.py#L276)).
R3 (project variant) returned a byte-identical body (observed with `cmp`), but it is private.

## R4 recording segments (list)

- The body is **not metadata**. It is the downloaded content of every segment in the page, streamed as one JSON array of arrays (`download_segments`, [reader.py#L253-L275](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/reader.py#L253-L275)).
- Ordered by `segment_id` ascending ([reader.py#L223](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/reader.py#L223)). **The body carries no segment ids.** A gap (segment 7 not yet ingested) is invisible: you get N arrays for the N existing rows.
- A blob missing in storage becomes `[]` ([reader.py#L265-L275](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/reader.py#L265-L275)).
- An unknown replay id returns **200 `[]`**, not 404 (observed).
- Segment rows are looked up only in the last **90 days from now**, whatever the request says ([reader.py#L209-L215](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/reader.py#L209-L215)).
- `per_page` 1..100 (400 above 100, observed); cursor `0:<offset>:0`. The blobs of one page are fetched in parallel with 10 threads.
- Server-side the blob is zlib/gzip and is **decompressed before sending** ([reader.py#L305-L320](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/reader.py#L305-L320)); the 1-byte pack header is stripped ([pack.py](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/pack.py)). Observed: `Content-Type: application/json`, chunked, and **no `Content-Encoding` even with `Accept-Encoding: gzip`** on self-hosted nginx.

## R5 and R6 one segment

- Without `download`: `{"data":{"replayId","segmentId","projectId","dateAdded"}}` ([recording-segment-meta.json](fixtures/recording-segment-meta.json)). `dateAdded` is the segment's SDK timestamp rounded to seconds (observed: 3 h old for the late replay), not the time Sentry received it.
- `?download` (any value, even empty): the rrweb JSON array, `Content-Length` set, `Content-Disposition: attachment; filename="{retention_days}/{project_id}/{replay_id}/{segment_id}"` (observed `90/8/6264…/0`). That filename is the storage key layout.
- Unknown segment: 404 `{"detail":"Replay recording segment not found."}`.
- Muninn uses R5 to **prove which segment ids exist**, because R4 hides gaps.

## R7 mobile video

- Experimental, no docs page. Returns the mp4 bytes of one segment: `Content-Type: application/octet-stream`, `Accept-Ranges: bytes`, `Content-Disposition: ...{segment_id}.video` ([replay-video-segment0.mp4.headers.txt](fixtures/replay-video-segment0.mp4.headers.txt)).
- One byte range is supported: `Range: bytes=0-31` gives 206 with `Content-Range: bytes 0-31/4101` (observed). Several ranges or a bad range give 416 with `Content-Range: bytes */<size>` ([#L89-L125](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/project_replay_video_details.py#L89-L125)).
- Storage: the blob is `0x01` + 4-byte big-endian video length + mp4 + rrweb JSON ([pack.py#L30-L58](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/pack.py#L30-L58)). R4/R6 return the rrweb part, R7 the mp4 part.
- Web segment (no video): 404 "Replay recording segment not found." (observed).
- Each mobile segment's rrweb JSON contains a custom event (`type: 5`, `data.tag: "video"`) whose `payload` has `segmentId, size, duration (ms), encoding "h264", container "mp4", frameRate, frameRateType, frameCount, width, height, left, top` (observed, [recording-segments-mobile-page1.json](fixtures/recording-segments-mobile-page1.json)). `payload.size` equalled the downloaded mp4 length for all 52 segments (observed, [muninn-pull-report.json](fixtures/measurements/muninn-pull-report.json)).

## R8 to R12 helpers

| Endpoint | Key params | Observed |
|---|---|---|
| R8 clicks | `query` on `click.*` keys, `per_page`, window | `{"data":[]}` for both test replays (no DOM clicks in synthetic and mobile data) |
| R9 selectors | `project`, window, `sort`, `query`, `per_page` | `{"data":[]}` |
| R10 replay-count | `query` on exactly one of `issue.id:[..]`, `transaction:[..]`, `replay_id:[..]`; `data_source` (`discover` default, `errors`, `events`, `transactions`, `search_issues`, `spans`); `returnIds=true` | `{"7":1,"9":1,"8":1}`; with `returnIds` gives `{"7":["ea9b…"],...}` ([replay-count.json](fixtures/replay-count.json)). Use `curl -g` for the brackets |
| R11 replays-events-meta | `dataset=discover`, `query=replayId:<id>`, `field` | Error rows with `issue.id`, `level`, `title` ([replays-events-meta.json](fixtures/replays-events-meta.json)). Private |
| R12 viewed-by | none | Full user objects including the **email** of every viewer. Personal data that Muninn does not need |

R10 is limited to 20 requests/s per IP, user and org where rate limits are enforced ([organization_replay_count.py#L80-L86](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/endpoints/organization_replay_count.py#L80-L86)).

## End-to-end download, sizes and latency (observed)

Script [scripts/muninn_pull.py](scripts/muninn_pull.py), internal-integration token, local Docker on a Mac, `per_page=10` to force paging (report: [muninn-pull-report.json](fixtures/measurements/muninn-pull-report.json)).

| Replay | Platform / SDK | Duration | Segments | R4 list (pages, bytes, s) | R5+R6 per segment (requests, s) | R7 videos (bytes, s) | Complete |
|---|---|---|---|---|---|---|---|
| `bb6e59…` | web, `@sentry/react` 11.11.0 (browser agent's demo) | 89 s | 5 | 1, 27 583, 0.12 | 10, 0.65 | none | yes |
| `4805a6…` | iOS via sentry-react-native 8.32.0 | 291 s | 52 | 6, 19 694, 0.28 | 104, 4.82 | 52 mp4, 258 388, 2.89 | yes |
| `62649a…` | web, wire agent's synthetic sender | 2 s | 2 | 1, 1 123, 0.12 | 4, 0.42 | none | yes |

- R4 contents equalled the concatenation of the R6 downloads for all three replays.
- Listing all 28 replays in 3 pages of 10 took 0.41 s.
- Mobile: about 5 KB of mp4 and about 380 bytes of rrweb JSON per 5 s segment (1 fps screenshots). The sum of `payload.duration` = 291 000 ms = the replay duration.
- Web (`@sentry/react` 11.11.0): about 5.5 KB of rrweb JSON per segment for a small demo page; 42 events: types 2 (full snapshot, **twice**: a page reload inside the replay starts a new snapshot), 3 (incremental), 4 (meta, twice), 5 (custom: `breadcrumb`, `options`, `performanceSpan`) ([recording-segments-browser-sdk-11.11.0.json](fixtures/recording-segments-browser-sdk-11.11.0.json)).
- **Mixed timestamp units.** rrweb core events use ms since epoch, but 18 of 42 events in the real web replay (all `performanceSpan` custom events and some `breadcrumb` events) carry a top-level `timestamp` in **float seconds** (e.g. `1794281732.3313`). A naive sort puts them all first. Normalise (`t < 1e12` → `t × 1000`) before sorting or playing. The mobile replay had none.
- Reassembly: concatenating segments in id order is **not** time-ordered (both web and mobile); sort by the normalised timestamp after concatenating.

## Fields Muninn should store per replay

`id`, `project_id`, `platform`, `replay_type` (`session`, or `buffer` = on-error), `started_at`, `finished_at`, `duration`, `count_segments`, `error_ids`, `trace_ids`, `urls` (screens on mobile), `user` (id, username, email, ip, geo: personal data), `releases`, `environment`, `sdk`, `os`, `device`, `browser`, `is_archived`. `error_ids` and `trace_ids` are the join keys to [issues-and-events.md](issues-and-events.md) and [traces-spans-logs.md](traces-spans-logs.md).
