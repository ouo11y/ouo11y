# Muninn incremental sync recipe for Sentry

> How does Muninn copy new and growing Sentry replays (and their errors, traces, sessions) without missing data, given what the API offers?

Versions: Sentry self-hosted 26.10.0. Research date 2026-11-10. Every rule below cites an observation or source in the sibling entries. This is a recipe, not a decision; Muninn's design (Step 8) decides.

## Facts the recipe rests on

| # | Fact | Evidence |
|---|---|---|
| F1 | No replay webhook; polling is the only way to learn about replays | [webhooks-and-push.md](webhooks-and-push.md) |
| F2 | R1's window matches replays with any segment row in the window, by **SDK timestamp, not receive time** | observed, [replays.md](replays.md) |
| F3 | A replay sent late (offline buffer) keeps its old timestamps: 3 h old data was invisible to `statsPeriod=1h` | observed, `late_replay` experiment |
| F4 | No `received`/`finished_at` filter exists; `sort=finished_at` exists | [replays.md](replays.md) |
| F5 | New replay visible in R1 after 2.4–4.8 s; second segment counted after 3.5–5.2 s; R4 returns both after 3.9–5.4 s | 5 runs, [ingest-latency-runs.json](fixtures/measurements/ingest-latency-runs.json) |
| F6 | Segments are immutable once written; new segments only append (higher ids) | storage key `{retention}/{project}/{replay}/{segment}`, source [reader.py](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/reader.py) |
| F7 | R4 hides gaps and missing blobs (`[]`); R5 proves a segment id exists | [replays.md](replays.md) |
| F8 | Errors readable after 5.5–7.6 s, spans after 14.5–18 s, logs 2.5–5 s, sessions ~50 s | [ingest-latency-runs.json](fixtures/measurements/ingest-latency-runs.json) |
| F9 | A web replay lasts at most 60 min and expires after 15 min idle; mobile max 60 min, ends after 30 s in background | Step 4: [sentry-web.md](../../../client-sdk-features/vendors/sentry-web.md) SES-b, RPL-j; [sentry-mobile.md](../../../client-sdk-features/vendors/sentry-mobile.md) RPL-j |
| F10 | Data is unreachable after 90 days (self-hosted retention and code cap) | [saas-vs-self-hosted.md](saas-vs-self-hosted.md) |

## Per-replay state Muninn keeps

`replay_id, project_id, platform, started_at, finished_at, count_segments (as last seen), segments_stored (set of ids), videos_stored (set), last_checked_at, state ∈ {open, closed, incomplete}`.

## Loop

1. **Hot scan, every 30–60 s.** `GET /organizations/{org}/replays/?project=-1&start=<now-2h>&end=<now>&sort=-started_at&field=id&field=project_id&field=platform&field=started_at&field=finished_at&field=count_segments&field=error_ids&field=trace_ids&per_page=100`, all pages (fixed `end`, de-dupe by id, see [pagination.md](pagination.md)).
   2 h covers the 60 min max replay plus late flushes (F9) and the visibility delay (F5).
2. For each row where `count_segments > len(segments_stored)` or the replay is new: fetch the missing segments.
   - Cheap path: R4 with `per_page=100` and `cursor=0:<len(segments_stored)>:0` returns only the tail, **if** stored ids are exactly `0..n-1`.
   - Safe path: for each id in `0..count_segments-1` not stored, R5 (exists?) then R6 (`?download`). R6 alone is enough: 404 means "not yet".
   - Mobile: for each new segment with a `video` custom event, R7, and check `len(mp4) == payload.size`.
   - Store each segment under `(replay_id, segment_id)`; re-downloading is idempotent (F6).
   - When assembling for playback, normalise timestamps: Sentry custom events in web replays use float seconds, rrweb core events use ms ([replays.md](replays.md)).
3. **Close** a replay when `now - finished_at > 20 min` (web idle expiry 15 min + margin) **and** `count_segments == len(segments_stored)` and ids are contiguous from 0. Otherwise keep it `open`.
4. **Warm scan, every 15–30 min.** Same query with `start=<now-26h>`: catches late deliveries from devices that were offline (F3) and replays whose segment 0 arrived late (they are hidden until it arrives).
5. **Cold sweep, daily.** `start=<now-30d>` with `field=id&field=count_segments` only, compare counts, fetch differences. Stop caring after 90 days (F10).
6. Mark `incomplete` (not an error) when a replay is closed by time but has gaps; retry gaps in the warm scan; give up at retention.

## Joins, fetched lazily or on close

- Errors: `GET /organizations/{org}/events/?dataset=errors&project=<id>&field=id&field=issue.id&field=title&field=level&field=timestamp&query=replayId:<replay_id>` (one call per replay), retry for ~10 s after a new `error_id` appears (F8). Full event via `/projects/{org}/{project}/events/{id}/`.
- Spans: `dataset=spans&query=replay.id:<replay_id>` (or `trace:[...]`), `per_page` up to 9999; wait ≥ 20 s after `finished_at` (F8).
- Logs: `dataset=logs&query=trace:[<trace_ids>]`.
- Sessions: aggregates only, poll `/sessions/` every few minutes and ignore the newest ~2 min (F8, [sessions.md](sessions.md)).

## Optional hint

An `error.created` webhook with `contexts.replay.replay_id` can trigger an immediate fetch of that replay (it arrives ~12 s after ingest, the replay is already listable). Only where the webhook can reach Muninn ([webhooks-and-push.md](webhooks-and-push.md)).

## Cost per poll (observed scale)

Listing 22 replays took 3 pages and 0.52 s. A 5 min mobile replay is 52 rrweb segments (19.7 KB) and 52 mp4s (258 KB): 1 R4 call (or 104 R5+R6 calls) plus 52 R7 calls, about 4–8 s sequentially on a laptop ([muninn-pull-report.json](fixtures/measurements/muninn-pull-report.json)).

## Measuring it yourself

- [scripts/ingest_latency_probe.py](scripts/ingest_latency_probe.py): sends one error, transaction, log, session and 2-segment replay through a DSN and polls 13 read paths until each sees the data.
- [scripts/muninn_pull.py](scripts/muninn_pull.py): lists every replay, downloads a web and a mobile replay both ways, checks completeness and reassembles.
