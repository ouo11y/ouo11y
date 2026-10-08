# rum-api

Go service that turns the telemetry the ouo SDKs send through the OpenTelemetry
Collector into **session records**, stores **rrweb replay chunks**, and exposes the
JSON API used by the Grafana app plugin (`plugins/ouo-rum-app`).

```
browser SDK --POST /v1/replay/chunks--> rum-api --> <DATA_DIR>/replays/<session_id>/<seq>.json.gz
Grafana plugin --GET /v1/...--> rum-api --> Loki (session events, LogQL)
                                       --> Tempo (traces per session, TraceQL)
                                       --> replay store
rum-api --OTLP/HTTP--> otel-collector (service.name=rum-api)
```

Design references: `docs/specs/session-lifecycle.md` (server-side record, end inference),
ADR-0003 (replay layout), ADR-0004 (healthy / errored / crashed), `kb/loki-session-queries.md`,
`kb/tempo-session-search.md`.

## Run

```bash
go vet ./... && go test ./...
docker compose -f deploy/docker/compose.yaml up -d --build rum-api   # from the repo root
curl localhost:8080/readyz
```

Local binary against a running stack (ports from `deploy/docker/.env`):

```bash
OTEL_SDK_DISABLED=true LOKI_URL=http://localhost:3100 TEMPO_URL=http://localhost:3200 \
GRAFANA_URL=http://localhost:3000 DATA_DIR=./data go run .
```

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `RUM_API_ADDR` | `:8080` | listen address |
| `LOKI_URL` | `http://loki:3100` | Loki base URL |
| `TEMPO_URL` | `http://tempo:3200` | Tempo base URL |
| `GRAFANA_URL` | `http://localhost:3000` | browser-facing Grafana URL used in trace deep links |
| `GRAFANA_TEMPO_DATASOURCE_UID` | `tempo` | datasource uid in the deep links |
| `DATA_DIR` | `/data` | replay chunks live in `$DATA_DIR/replays` |
| `CORS_ALLOWED_ORIGINS` | | extra exact origins; `http://localhost:*` and `http://127.0.0.1:*` are always allowed |
| `SESSION_INACTIVITY` | `30m` | a session with no signal for this long is `ended` (`end_reason: inactivity`) |
| `SESSION_MAX_DURATION` | `4h` | sessions that lasted at least this long end with `max_duration`; also the Loki lookback before `from` |
| `SESSION_DETAIL_LOOKBACK` | `168h` | how far back `GET /v1/sessions/{id}` searches when `from` is not given |
| `TEMPO_CONCURRENCY` | `8` | parallel Tempo searches |
| `TEMPO_CACHE_TTL` | `60s` | in-memory cache of Tempo results per session id + range |
| `MAX_CHUNK_BYTES` | `4194304` | max replay chunk size (compressed and decompressed) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | OTel defaults | own telemetry; `OTEL_SDK_DISABLED=true` turns it off |

## API

All endpoints are JSON. CORS: any `http://localhost:*` / `http://127.0.0.1:*` origin (plus
`CORS_ALLOWED_ORIGINS`) with methods `GET, POST, DELETE, OPTIONS` and headers
`content-type, content-encoding, x-ouo-session-id, x-ouo-seq, accept, accept-encoding`.
Errors are `{"error": "..."}` with 400 (bad input), 404, 413 (chunk too large),
502 (Loki / Tempo failed).

Time parameters `from` / `to` accept RFC 3339, Unix seconds or milliseconds, or relative
`now`, `now-30m`, `now-1h`, `now-7d`. Defaults: `from=now-1h`, `to=now`.

### Health

- `GET /healthz` -> `{"status":"ok"}`
- `GET /readyz` -> `{"ready":true,"checks":{"loki":"ok","tempo":"ok"}}` (503 when a
  backend is unreachable)

### Replay

`POST /v1/replay/chunks` accepts the SDK chunk
`{session_id, seq, started_at, ended_at, events: [...]}` (timestamps are epoch
milliseconds). Body is gzip when `Content-Encoding: gzip`, plain JSON otherwise.
`session_id` must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`, `seq` is `0..999999`.
Re-posting a `seq` replaces that chunk. Response `202`:

```json
{"accepted":true,"session_id":"<id>","seq":3,"events":12,"bytes":5321}
```

On disk (always gzip): `<DATA_DIR>/replays/<session_id>/000003.json.gz` plus
`meta.json`, both written atomically (temp file + rename, one mutex per session).

- `GET /v1/sessions/{id}/replay` -> the meta:

```json
{"session_id":"<id>","chunk_count":8,"first_seq":0,"last_seq":7,
 "started_at":1791263180896,"ended_at":1791263220123,"bytes":12345,"updated_at":"2026-10-06T05:07:00Z",
 "chunks":[{"seq":0,"started_at":1791263180896,"ended_at":1791263185900,"bytes":1316,"event_count":4}, ...]}
```

- `GET /v1/sessions/{id}/replay/events` -> one JSON array with every rrweb event of every
  chunk in `seq` order (streamed; gzip when `Accept-Encoding: gzip`). Feed it to
  `rrweb-player` as `events`. Chunks that fail to decode are skipped.
- `DELETE /v1/sessions/{id}/replay` -> `204`, removes the directory.

### Sessions

`GET /v1/sessions?from=now-1h&to=now&platform=web|mobile&status=healthy|errored|crashed&version=1.4.2&user=u1&service=web-store&limit=100`

Returns sessions whose `started_at` is inside `[from, to]`, newest first (`limit` max 1000):

```json
{"sessions":[{
  "session_id":"a4d47dfa-...","user_id":"3c63803d-...","platform":"web",
  "service_name":"web-store","service_version":"1.4.2",
  "started_at":"2026-10-06T05:06:20.896Z","last_signal_at":"2026-10-06T05:06:40.747Z",
  "ended_at":null,"end_reason":null,"state":"active","status":"crashed",
  "error_count":2,"crash_count":1,"failed_request_count":1,"event_count":12,
  "trace_count":5,"has_replay":true
 }],"count":1,"from":"2026-10-06T04:30:00Z","to":"2026-10-06T05:30:00Z"}
```

- `status` per ADR-0004: `crashed` if any `exception` with `ouo.exception.fatal=true` (or a
  `session.end` with reason `crash`), else `errored` if any non-fatal `exception` or
  `http.request.failed`, else `healthy`.
- `state` / `ended_at` / `end_reason`: from the SDK's `session.end` when present, otherwise
  inferred: no signal for `SESSION_INACTIVITY` -> `ended`, reason `inactivity`
  (or `max_duration` when the session lasted at least `SESSION_MAX_DURATION`).
- `trace_count` is best effort: `-1` when Tempo failed for that session.
- `user_id` is the latest non-empty `user.id` seen in the session (`setUser` can arrive late).

`GET /v1/sessions/{id}[?from&to]` -> the record plus `timeline` and `traces`:

```json
{ ...record fields...,
  "timeline":[
    {"ts":"...","type":"session.start","name":"session.start","attrs":{"ouo_session_started_at":"1791263180896","severity_text":"INFO"}},
    {"ts":"...","type":"navigation","name":"navigation","attrs":{"url_path":"/","ouo_navigation_kind":"load"}},
    {"ts":"...","type":"exception","name":"exception","attrs":{"exception_type":"Error","exception_message":"handled","ouo_exception_fatal":"false","ouo_exception_handled":"true","exception_stacktrace":"..."}},
    {"ts":"...","type":"http.request.failed","name":"http.request.failed","attrs":{"http_request_method":"POST","url_full":"http://localhost:8082/api/checkout?fail=500","http_response_status_code":"500"}},
    {"ts":"...","type":"custom","name":"cart.added","attrs":{"sku":"sku-1","qty":"1","ouo_event_custom":"true"}},
    {"ts":"...","type":"web_vital","name":"web_vital","attrs":{"ouo_web_vital_name":"TTFB","ouo_web_vital_value":"4.7","ouo_web_vital_rating":"good"}},
    {"ts":"...","type":"session.end","name":"session.end","attrs":{"ouo_session_end_reason":"inactivity","ouo_session_duration_ms":"..."}}
  ],
  "traces":[{"trace_id":"10398504df131ef48188906b1d611cc8","root_name":"GET","root_service":"web-store",
             "start":"2026-10-06T05:06:21.463Z","duration_ms":6,"span_count":2,"has_error":true,
             "grafana_url":"http://localhost:3000/explore?schemaVersion=1&orgId=1&panes=%7B%22ouo%22%3A..."}]
}
```

`type` is one of `session.start | navigation | exception | http.request.failed | web_vital |
custom | session.end`; `name` is the raw `event.name` (differs from `type` only for custom
events). `attrs` is every Loki label and structured-metadata field of the record with
`.` replaced by `_`, minus the identifiers already on the record and per-SDK constants
(`telemetry_sdk_*`, `browser_*`, `os_*`, `user_agent_original`, ...). `trace_id` / `span_id`
are kept when the SDK attached them.

`GET /v1/sessions/{id}/traces` -> `{"session_id":"...","traces":[...],"count":n}` with the
same trace objects (the Tempo window is derived from the session's events; 502 when Tempo
fails). `grafana_url` opens Grafana Explore on the Tempo datasource with that trace id
(`/explore?schemaVersion=1&orgId=1&panes={"ouo":{"datasource":"tempo","queries":[{"refId":"A",
"datasource":{"type":"tempo","uid":"tempo"},"queryType":"traceql","query":"<trace id>"}],
"range":{"from":"<ms>","to":"<ms>"}}}`).

### Stats

`GET /v1/stats/health?from=now-24h&to=now&platform=&service=&version=&user=`

```json
{"buckets":[
  {"platform":"mobile","service_name":"mobile-store","service_version":"9.9.9","total":1,"healthy":0,"errored":1,"crashed":0,"healthy_pct":0,"errored_pct":100,"crashed_pct":0},
  {"platform":"web","service_name":"web-store","service_version":"1.4.2","total":4,"healthy":1,"errored":1,"crashed":2,"healthy_pct":25,"errored_pct":25,"crashed_pct":50}
 ],
 "totals":{"platform":"","service_name":"","service_version":"","total":5,"healthy":1,"errored":2,"crashed":2,"healthy_pct":20,"errored_pct":40,"crashed_pct":40},
 "from":"...","to":"..."}
```

Buckets are sorted by platform, service, version; percentages are rounded to two decimals
(the integer counts always add up to `total`).

## curl examples

```bash
# upload a plain chunk
curl -i -X POST localhost:8080/v1/replay/chunks -H 'content-type: application/json' \
  -d '{"session_id":"demo-1","seq":0,"started_at":1000,"ended_at":2000,"events":[{"type":4,"data":{"href":"http://x"},"timestamp":1000},{"type":2,"data":{},"timestamp":1001}]}'
# upload a gzip chunk
gzip -c chunk.json | curl -i -X POST localhost:8080/v1/replay/chunks -H 'content-type: application/json' -H 'content-encoding: gzip' --data-binary @-
curl localhost:8080/v1/sessions/demo-1/replay
curl --compressed localhost:8080/v1/sessions/demo-1/replay/events | head -c 300
curl -X DELETE -i localhost:8080/v1/sessions/demo-1/replay

curl 'localhost:8080/v1/sessions?from=now-2h&status=crashed&platform=web'
curl 'localhost:8080/v1/sessions/<session_id>' | jq '.timeline[] | {ts, type, name}'
curl 'localhost:8080/v1/sessions/<session_id>/traces' | jq '.traces[] | {trace_id, root_name, span_count, has_error, grafana_url}'
curl 'localhost:8080/v1/stats/health?from=now-24h' | jq
```

## How it works

- **Loki**: one `query_range` over
  `{service_name=~".+", event_name=~".+"[, ouo_platform="web"][, service_name="x"]} [| session_id="..."] [| service_version="..."] [| user_id="..."]`
  with `direction=forward`, `limit=5000`, paging by moving `start` to the last timestamp
  (inclusive) until a page is short; duplicates are dropped by `(ts, session_id, event_name, line)`.
  For the list, Loki is queried from `from - SESSION_MAX_DURATION` so a session that started
  before `from` folds with all of its events and is then excluded by `started_at`.
  Folding and classification are pure (`internal/session`, fixtures in `testdata/`).
- **Tempo**: `GET /api/search?q={ span.session.id = "<id>" }&start=&end=&limit=1000` over the
  session's window (started_at - 2 min .. last signal + 2 min, or now while active), then
  `{ span.session.id = "<id>" && status = error }` for `has_error`. One search per session
  through a semaphore of `TEMPO_CONCURRENCY`, cached for `TEMPO_CACHE_TTL`.
- **Replay**: `internal/replay.Store` interface, filesystem implementation; the events
  endpoint streams chunk files through a JSON token decoder without loading everything.

## Layout

```
main.go                      config, telemetry, HTTP server, -check healthcheck
internal/config              env parsing
internal/httpapi             routes, CORS, handlers (+ tests with fakes)
internal/session             Loki stream -> Event, Fold, Classify, Health (+ fixtures)
internal/loki                query_range client with pagination
internal/tempo               search client, cache, Grafana Explore links
internal/replay              Store interface, filesystem store, event streaming
internal/timerange           from/to parsing
internal/telemetry           OTel SDK setup (traces, logs, metrics via OTLP/HTTP)
```
