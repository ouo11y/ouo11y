# tempo session search

Status: filled in Phase 3 by rum-api (2026-10-06). Code: `services/rum-api/internal/tempo`.
Verified against Tempo 3.0.3 and Grafana 13.2.1.

## Question

How does rum-api list the traces of one session (count, root name, duration, span count,
error flag) and build a link that opens the trace in Grafana Explore?

## What works

- Search: `GET /api/search?q={ span.session.id = "<id>" }&start=<unix s>&end=<unix s>&limit=1000&spss=1`.
  `start`/`end` are **required in practice**: without them Tempo only searches the last few
  minutes and returned 0 traces for 30 s old data. rum-api uses
  `[started_at - 2 min, last_signal_at + 2 min]` (end = now while the session is active),
  rounded to whole minutes so the in-memory cache key (`id|start|end`, TTL 60 s) is stable.
- Response fields used: `traces[].traceID`, `rootServiceName`, `rootTraceName`,
  `startTimeUnixNano` (string), `durationMs`, `serviceStats{<service>{spanCount,errorCount}}`
  (sum = `span_count`), `spanSet.matched` as a fallback. `spss=1` keeps the matched span
  list to one entry per trace (we do not need the spans).
- Error flag: a second query `{ span.session.id = "<id>" && status = error }` returns the
  trace ids that contain at least one errored span; rum-api marks those `has_error`.
  `serviceStats.errorCount` was not populated by Tempo 3.0.3, hence the second query.
- Concurrency: the list endpoint searches once per session through a semaphore
  (`TEMPO_CONCURRENCY=8`); 10 sessions took ~150 ms in total. On error `trace_count` is
  `-1` and the error is logged; the list still returns.
- Grafana Explore deep link (verified by opening it in Grafana 13.2.1: Explore opens on
  the Tempo datasource with the TraceQL query = trace id and renders the trace view):

```
${GRAFANA_URL}/explore?schemaVersion=1&orgId=1&panes=<urlencoded JSON>
panes = {"ouo":{"datasource":"tempo",
                "queries":[{"refId":"A","datasource":{"type":"tempo","uid":"tempo"},
                            "queryType":"traceql","query":"<trace id>","limit":20,"tableType":"traces"}],
                "range":{"from":"<epoch ms>","to":"<epoch ms>"}}}
```

  The pane key (`ouo`) is arbitrary. `range` values are epoch-millisecond strings (relative
  `now-1h` also works). rum-api pads the range 5 min around the trace. A bare trace id as a
  TraceQL query makes Grafana open the trace directly instead of a search result table.
  `GRAFANA_URL` must be the browser-facing URL (`http://localhost:${OUO_GRAFANA_PORT}`),
  not the in-network `http://grafana:3000`.

```bash
S=$(( $(date +%s) - 3600 )); E=$(date +%s)
curl -sG localhost:3201/api/search --data-urlencode 'q={ span.session.id = "<id>" }' \
  --data-urlencode start=$S --data-urlencode end=$E --data-urlencode limit=1000 --data-urlencode spss=1 \
  | jq '.traces[] | {traceID, rootTraceName, durationMs, serviceStats}'
curl -sG localhost:3201/api/search --data-urlencode 'q={ span.session.id = "<id>" && status = error }' --data-urlencode start=$S --data-urlencode end=$E | jq '.traces[].traceID'
```

## What was tried

- `GET /api/search` without `start`/`end`: empty for anything older than a minute or two.
- `serviceStats.errorCount` for `has_error`: always 0 in 3.0.3 even for traces whose span
  has `status = error`; the TraceQL `status = error` filter is reliable.
- Grafana `/explore?left=["now-1h","now","tempo",{"query":"<id>"}]` (the pre-10 format):
  still redirects in Grafana 13 but is deprecated; `schemaVersion=1&panes=` is the format
  Grafana itself writes to the address bar, so rum-api emits that.

## Gotchas

- Traces become searchable 10 to 60 s after ingestion; a session detail opened right after
  the events may show fewer traces than a minute later. The 60 s cache can extend that
  lag by at most one more minute.
- Every `documentLoad` page load is one trace with ~30 resource spans; trace counts for a
  web session are dominated by navigation, not API calls.
- `limit` caps results per search (1000 in rum-api); a very long session could exceed it,
  in which case `trace_count` is a floor.
- The search window uses whole seconds; `startTimeUnixNano` is a string and must be parsed
  as int64.
