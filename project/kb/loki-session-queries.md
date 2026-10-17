# loki session queries

Status: filled in Phase 3 by rum-api (2026-10-06). Code: `services/rum-api/internal/loki`,
`services/rum-api/internal/session`. Verified against Loki 3.7.7 with the Phase 1 label
config (`project/kb/collector-lgtm.md`).

## Question

Which LogQL and which `/loki/api/v1/query_range` parameters give rum-api every session
event of a time range (or of one session) with all attributes, so it can fold them into
session records and classify them per ADR-0004?

## What the data looks like

- Stream labels: `service_name`, `event_name`, `ouo_platform`, `deployment_environment_name`.
- Everything else is **structured metadata** and comes back merged into the `stream` map of
  each result: `session_id`, `user_id`, `service_version`, `ouo_exception_fatal`,
  `ouo_session_end_reason`, `ouo_session_started_at` (epoch ms), `url_path`, `url_full`,
  `http_response_status_code`, `exception_type`, `exception_message`,
  `exception_stacktrace`, `trace_id`, `span_id`, `severity_text`, `ouo_event_custom`,
  plus resource noise (`telemetry_sdk_*`, `browser_*`, `os_*`, `user_agent_original`,
  `scope_name`, `detected_level`, `observed_timestamp`). Dots are rewritten to `_`.
- Because the metadata differs per record, Loki returns **one stream per record** (a
  result with 84 entries had 84 streams). Treat `result[].stream` as the attribute map of
  `result[].values[]` and flatten; do not expect one stream per session.
- The log line (`values[i][1]`) is just the event name (the SDK sets `body` = event name).
- Booleans arrive as strings `"true"` / `"false"`; a `boolValue` in OTLP becomes the same.

## What works

Selector used by rum-api (`loki.Filters.Query()`):

```
{service_name=~".+", event_name=~".+"[, ouo_platform="web"][, service_name="web-store"]}
  [| session_id="<id>"] [| service_version="1.4.2"] [| user_id="u1"]
```

- `event_name=~".+"` instead of the fixed list so custom events (`cart.added`,
  `add_to_cart`, ...) are counted in `event_count` and shown on the timeline as type
  `custom`. Records without `session_id` are dropped after parsing.
- Query params: `start`/`end` in **nanoseconds**, `limit=5000`
  (`max_entries_limit_per_query` default), `direction=forward`.
- Pagination: when a page returns exactly `limit` entries, re-query with
  `start = last timestamp` (inclusive, so entries sharing a nanosecond are not lost) and
  de-duplicate on `(ts, session_id, event_name, line)`. Bounded to 20 pages.
- List window: query `[from - SESSION_MAX_DURATION, to]` and keep sessions whose folded
  `started_at` is in `[from, to]`. Without the lookback, a session that started before
  `from` shows up with a wrong `started_at` (its first event in range) and possibly a wrong
  status. Cost at demo scale: 10 sessions / 100 events in ~20 ms.
- Single session: `{service_name=~".+", event_name=~".+"} | session_id="<id>"` over the
  last 168 h (`SESSION_DETAIL_LOOKBACK`, equal to `reject_old_samples_max_age`). The
  metadata filter is cheap: Loki reports `totalStructuredMetadataBytesProcessed` ~ the
  stream bytes, so a 7-day window over a few thousand records is fine.

Folding (pure, `session.Fold`): group by `session_id`; `started_at` = `session.start`
timestamp (or `ouo_session_started_at` when it is earlier by less than 1 h, which covers
export lag), else first event; `last_signal_at` = last event; `user_id` = latest non-empty
value (`setUser` after start); platform / service / version = first non-empty.
End: `session.end` wins (reason from `ouo_session_end_reason`), else
`now - last_signal > 30 min` -> `ended` with `inactivity`, or `max_duration` when the
session lasted >= 4 h; otherwise `active`. Status: crashed (fatal exception or
`session.end` reason `crash`) > errored (non-fatal exception or `http.request.failed`) >
healthy. Fixtures: `services/rum-api/internal/session/testdata/*.json` (one is a real
Loki response).

Handy manual queries (ports from `deploy/compose/.env`):

```bash
curl -sG localhost:3101/loki/api/v1/query_range \
  --data-urlencode 'query={service_name=~".+", event_name=~".+"} | session_id="<id>"' \
  --data-urlencode "start=$(( $(date +%s) - 7200 ))000000000" --data-urlencode "end=$(date +%s)000000000" \
  --data-urlencode limit=5000 --data-urlencode direction=forward | jq '.data.result[] | [.values[0][0], .stream.event_name, .stream.ouo_exception_fatal]'
curl -s localhost:3101/loki/api/v1/label/event_name/values
```

## Gotchas

- `start`/`end` must be nanoseconds (or RFC3339); seconds silently give an empty range.
- Loki rejects samples older than 168 h; synthetic fixtures must use current timestamps.
- Do not put `session_id` in the selector braces: it is not a label, the query returns
  nothing. Metadata filters go after `|`.
- Structured metadata values are always strings; parse `ouo_session_started_at` as int ms.
- Two tabs of one web session, or an SDK retry, can produce identical records; the
  `(ts, session_id, event_name, line)` de-dup handles paging but not true duplicates with
  different nanosecond timestamps (harmless for status, inflates `event_count` by one).
- The demo backend logs also carry `session_id` but no `event_name`; the
  `event_name=~".+"` selector keeps them out of the timeline on purpose.
