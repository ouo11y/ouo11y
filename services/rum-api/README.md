# rum-api

Go service that turns the telemetry the ouo SDKs send through the OpenTelemetry
Collector into **session records**, stores **replay chunks** (rrweb events from the web
SDK, JPEG frames from the iOS SDK, mp4 video segments from Sentry mobile Session Replay
through the collector's Sentry bridge), and exposes the JSON API used by the Grafana app
plugin (`plugins/ouo11y-rum-app`).

rum-api is **internal** (ADR-0007 5). It is never exposed to the internet: the only
public services are the `ouo-collector` and Grafana. Replay chunks reach it from the
collector's `ouoreplay` exporter, which has already authenticated the project (Basic
project token at the collector) and stamps the project id on the request; session and
replay reads come from Grafana's server-side plugin proxy with the read token.

```
browser / mobile SDK --OTLP + replay chunks, Basic <project id>:<token>--> ouo-collector (public)
ouo-collector --OTLP--> Loki / Tempo / Mimir
ouo-collector --POST /v1/replay/chunks + X-Ouo-Project-Id [+ Bearer OUO_INGEST_TOKEN]--> rum-api (internal)
                                                                                           --> <DATA_DIR>/replays/<session_id>/<seq>.json.gz [+ <seq>.mp4], meta.json (kind, project_id)
Grafana plugin proxy --GET /v1/... + Authorization: Bearer <OUO_READ_TOKEN>--> rum-api --> Loki (session events, LogQL)
                                                                                      --> Tempo (traces per session, TraceQL)
                                                                                      --> replay store
rum-api --OTLP/HTTP--> ouo-collector (service.name=rum-api; own traces, logs, replay metrics)
```

Design references: `docs/adr/0007-ingest-gateway-project-tokens.md` (the collector is the
edge, replay sink contract, read token), `docs/specs/session-lifecycle.md` (server-side
record, end inference), ADR-0003 (replay layout), ADR-0004 (healthy / errored / crashed),
ADR-0006 and `docs/specs/mobile-replay.md` (frame chunks), ADR-0008 and
`docs/specs/sentry-bridge.md` section 11 (video chunks), `project/kb/ingest-gateway.md` (sink
contract notes), `project/kb/loki-session-queries.md`, `project/kb/tempo-session-search.md`.

## Run

```bash
go vet ./... && go test ./...
docker compose -f deploy/compose/compose.yaml up -d --build rum-api   # from the repo root
curl localhost:8080/readyz
```

Local binary against a running stack (ports from `deploy/compose/.env`). No project
configuration is needed; both tokens are optional and default to off:

```bash
OTEL_SDK_DISABLED=true LOKI_URL=http://localhost:3100 TEMPO_URL=http://localhost:3200 \
GRAFANA_URL=http://localhost:3000 OUO_INGEST_TOKEN=it_dev_0000000000000000 \
OUO_READ_TOKEN=rt_dev_0000000000000000 DATA_DIR=./data go run .
```

## Configuration

rum-api is configured like Loki and Tempo: an optional YAML file plus environment
variables.

```bash
rum-api -config.file=/etc/rum-api/config.yaml -config.expand-env=true
rum-api -config.file=/etc/rum-api/config.yaml -config.expand-env=true -config.verify  # validate, print redacted, exit
```

| Flag | Meaning |
|---|---|
| `-config.file` | YAML file; every key, its default and its variable are in [`config.example.yaml`](config.example.yaml). Unknown keys are errors |
| `-config.expand-env` | replace `${VAR}` and `${VAR:-default}` in the file before parsing (Loki's syntax), so tokens and S3 keys stay in the environment. A bare `$VAR` is left alone, `$${` is a literal `${` |
| `-config.verify` | load and validate, print the effective config with secrets redacted, exit 0 (2 when invalid) |
| `-check` | probe `GET /healthz` on the configured address and exit (container health check) |

Precedence: built-in defaults < file < environment variables. Every variable below keeps
working and **overrides the file**, so env-only deployments need no change (an empty
variable counts as unset). Do not bake these variables into an image or a base manifest
when you ship a file: they would silently win over it. The Dockerfile sets none.

| Variable | File key | Default | Meaning |
|---|---|---|---|
| `RUM_API_ADDR` | `server.http_listen_address` | `:8080` | listen address |
| `LOKI_URL` | `loki.url` | `http://loki:3100` | Loki base URL |
| `TEMPO_URL` | `tempo.url` | `http://tempo:3200` | Tempo base URL |
| `GRAFANA_URL` | `grafana.url` | `http://localhost:3000` | browser-facing Grafana URL used in trace deep links |
| `GRAFANA_TEMPO_DATASOURCE_UID` | `tempo.datasource_uid` | `tempo` | datasource uid in the deep links |
| `GRAFANA_LOKI_DATASOURCE_UID` | `loki.datasource_uid` | `loki` | datasource uid in the session logs' Explore link |
| `STORAGE_BACKEND` | `storage.backend` | `filesystem` | replay store: `filesystem` or `s3` (below) |
| `DATA_DIR` | `storage.filesystem.dir` | `/data` | filesystem store: replay chunks live in `$DATA_DIR/replays` |
| `S3_ENDPOINT` | `storage.s3.endpoint` | AWS `s3.<region>.amazonaws.com` | s3 store: `host[:port]`, no scheme |
| `S3_BUCKET` | `storage.s3.bucket` | | s3 store: bucket (required; rum-api never creates it) |
| `S3_REGION` | `storage.s3.region` | `us-east-1` | |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` | `storage.s3.access_key_id`, `.secret_access_key`, `.session_token` | | static keys; all empty uses the AWS chain (`AWS_*` / `MINIO_*` variables, `~/.aws/credentials`, instance or pod role such as EKS IRSA) |
| `S3_INSECURE` | `storage.s3.insecure` | `false` | plain HTTP (local MinIO) |
| `S3_INSECURE_SKIP_VERIFY` | `storage.s3.insecure_skip_verify` | `false` | TLS without certificate verification |
| `S3_FORCE_PATH_STYLE` | `storage.s3.force_path_style` | `false` | bucket in the path (MinIO and most S3 compatibles) |
| `S3_PREFIX` | `storage.s3.prefix` | | optional key prefix (environment, tenant) |
| `OUO_INGEST_TOKEN` | `auth.ingest_token` | | shared secret between the collector's replay exporter and rum-api. When set, `POST /v1/replay/chunks` needs `Authorization: Bearer <token>` (401 otherwise). Leave empty only when the network already isolates rum-api |
| `OUO_READ_TOKEN` | `auth.read_token` | | when set, every `GET` / `DELETE /v1/*` needs `Authorization: Bearer <token>` (401 otherwise); `/healthz`, `/readyz` and the replay sink are unaffected. Grafana's plugin proxy injects it from `secureJsonData.readToken` |
| `CORS_ALLOWED_ORIGINS` | `server.cors_allowed_origins` | | comma separated exact origins allowed besides the implicit `http://localhost:*` and `http://127.0.0.1:*` (local tooling only; browsers never talk to rum-api in a deployment) |
| `SESSION_INACTIVITY` | `session.inactivity` | `30m` | a session with no signal for this long is `ended` (`end_reason: inactivity`) |
| `SESSION_MAX_DURATION` | `session.max_duration` | `4h` | sessions that lasted at least this long end with `max_duration`; also the Loki lookback before `from` |
| `SESSION_DETAIL_LOOKBACK` | `session.detail_lookback` | `168h` | how far back `GET /v1/sessions/{id}` searches when `from` is not given |
| `TEMPO_CONCURRENCY` | `tempo.concurrency` | `8` | parallel Tempo searches |
| `TEMPO_CACHE_TTL` | `tempo.cache_ttl` | `60s` | in-memory cache of Tempo results per session id + range |
| `MAX_CHUNK_BYTES` | `limits.max_chunk_bytes` | `4194304` | max rrweb chunk size (compressed and decompressed) |
| `MAX_FRAME_CHUNK_BYTES` | `limits.max_frame_chunk_bytes` | `8388608` | max `kind: "frames"` chunk size (compressed and decompressed); never below `MAX_CHUNK_BYTES` |
| `MAX_VIDEO_CHUNK_BYTES` | `limits.max_video_chunk_bytes` | `8388608` | max decoded `video.mp4` of one `kind: "video"` chunk; never below `MAX_CHUNK_BYTES`. The chunk body (base64 mp4 + envelope) may be up to `base64(MAX_VIDEO_CHUNK_BYTES) + 1 MiB` (12.2 MiB by default), compressed and decompressed |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | | OTel defaults | own telemetry; `OTEL_SDK_DISABLED=true` turns it off |

### Replay storage

Both stores keep the same layout, `replays/<session_id>/<seq %06d>.json.gz` (+
`<seq>.mp4` for video chunks) and `meta.json`, under `DATA_DIR` or under
`[<prefix>/]` in the bucket, so `mc mirror <DATA_DIR>/replays <alias>/<bucket>/[<prefix>/]replays`
moves a filesystem store to S3. The S3 store (`internal/replay/s3.go`, minio-go):

- writes the chunk objects, then `meta.json` with a conditional PUT (`If-Match` on the
  ETag it read, `If-None-Match: *` for a new replay) and re-reads on a 412 / 409, so
  several replicas on one bucket never drop a chunk from the meta. A retried `seq`
  overwrites its objects and replaces its meta entry (no duplicates), as on the filesystem;
- serves `GET .../replay/video/{seq}` with ranged GETs (`http.ServeContent` seeks a
  `minio.Object`), the object's ETag and `Last-Modified`;
- checks the bucket at start (exit when it is missing or the keys are wrong) and in
  `/readyz` (`"storage": "ok"`).

The size limits and kind / project checks are shared code, identical for both stores.

## API

All endpoints are JSON unless noted. Errors are `{"error": "..."}` with 400 (bad input,
missing or invalid `X-Ouo-Project-Id`), 401 (missing ingest token on the sink, missing read
token on reads), 403 (replay recorded under another project id), 404, 409 (replay kind
conflict), 413 (too large), 415 (unsupported `Content-Encoding`), 502 (Loki / Tempo failed).

**CORS**: the `Origin` is reflected when it is `http://localhost[:port]`,
`http://127.0.0.1[:port]` or one of `CORS_ALLOWED_ORIGINS` (exact match); any other origin
gets no CORS headers and the request is handled normally. Methods `GET, POST, DELETE,
OPTIONS`; headers `Authorization, Content-Type, Content-Encoding, X-Ouo-Project-Id,
X-Ouo-Session-Id, X-Ouo-Seq, Accept, Accept-Encoding, Range`; `X-Ouo-Replay-Kind`,
`Content-Range` and `Accept-Ranges` are exposed.
Preflights are answered with 204 before authentication.

**Authentication**: the replay sink (`POST /v1/replay/chunks`) needs `Authorization: Bearer
<OUO_INGEST_TOKEN>` when that variable is set; read routes (`GET` / `DELETE /v1/*`) need
`Authorization: Bearer <OUO_READ_TOKEN>` when that one is set. The two tokens are
independent: the ingest token does not read, the read token does not write. Both are
compared in constant time; the scheme is case-insensitive.

Time parameters `from` / `to` accept RFC 3339, Unix seconds or milliseconds, or relative
`now`, `now-30m`, `now-1h`, `now-7d`. Defaults: `from=now-1h`, `to=now`.

### Health

- `GET /healthz` -> `{"status":"ok"}`
- `GET /readyz` -> `{"ready":true,"checks":{"loki":"ok","tempo":"ok"}}` (503 when a
  backend is unreachable); with the s3 store `checks` also has `"storage"` (bucket reachable)

### Replay sink (collector -> rum-api)

`POST /v1/replay/chunks` is the sink for the collector's `ouoreplay` exporter (ADR-0007
5). It is not meant for SDKs: they post to the collector's replay receiver on port 4319
with the project credential, and the exporter forwards each chunk here.

Request:

| Header | Required | Meaning |
|---|---|---|
| `Authorization: Bearer <OUO_INGEST_TOKEN>` | when `OUO_INGEST_TOKEN` is set | shared secret; **401** + `WWW-Authenticate: Bearer` otherwise |
| `X-Ouo-Project-Id` | yes | the project the collector authenticated; must match `^[a-z0-9][a-z0-9._-]{0,63}$` (surrounding spaces are trimmed). Missing or invalid: **400**, nothing is read or stored |
| `Content-Type: application/json` | | the chunk envelope (below) |
| `Content-Encoding: gzip` | no | body is gzip; `identity` or absent means plain JSON; anything else **415** |
| `X-Ouo-Session-Id`, `X-Ouo-Seq` | no | informational copies of the body fields; a mismatch is logged as a warning, the body wins |

Checks run in this order and stop at the first failure: `Content-Length` above the largest
body limit (frames or video, **413**), ingest token (**401**), project id (**400**), body read and decompression
(**413** when the wire or the decompressed size exceeds the limit, **400** on bad gzip),
then the chunk rules below. The project id is recorded as `project_id` in `meta.json` and
returned in the response; a chunk with a different project id for an existing session is
**403** and nothing is written (replays stored before Phase 8a have no `project_id` and
adopt the first project that writes to them).

A session has one replay of one **kind**: `rrweb` (web SDK, ADR-0003), `frames` (iOS SDK,
ADR-0006 / `docs/specs/mobile-replay.md`) or `video` (Sentry mobile Session Replay through
the collector's `ouosentry` receiver, ADR-0008 / `docs/specs/sentry-bridge.md`). All kinds
share the sink and the storage layout; `meta.json` records the kind of the first chunk and a
chunk of another kind is rejected with 409. `session_id` must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`, `seq` is
`0..999999`. Re-posting a `seq` replaces that chunk.

- rrweb (no `kind`, or `kind: "rrweb"`): `{session_id, seq, started_at, ended_at, events: [...]}`,
  at most `MAX_CHUNK_BYTES` (4 MiB).
- frames (`kind: "frames"`): `{kind, schema_version: 1, session_id, seq, started_at, ended_at,
  viewport: {width, height, scale}, platform, frames: [{ts, jpeg, reason}], touches: [{ts, x, y, phase}], masked}`,
  at most `MAX_FRAME_CHUNK_BYTES` (8 MiB). Validation: `schema_version` is `1`,
  `started_at > 0`, `ended_at >= started_at`, `viewport.width/height > 0` (`scale` defaults to
  1), `frames` is an array (may be empty) where every element has `ts > 0` and a non-empty
  base64 `jpeg` that decodes (padded or unpadded) and starts with the JPEG marker `FF D8`;
  every touch has `ts`, `x`, `y` and `phase` in `began | moved | ended`. At most 1000 frames
  per chunk. Unknown keys are ignored. `platform` is optional.
- video (`kind: "video"`): `{kind, schema_version: 1, session_id, seq, started_at, ended_at,
  viewport: {width, height, scale}, platform, video: {container, encoding, duration_ms, frame_count,
  frame_rate, mp4}, touches: [{ts, x, y, phase}], source: {vendor, replay_id, segment_id, replay_type}, masked}`.
  Validation: `schema_version` is `1`, `started_at > 0`, `ended_at >= started_at`,
  `viewport.width/height > 0` (`scale` defaults to 1), `video` is an object with
  `container: "mp4"` and a non-empty base64 `mp4` (padded or unpadded) that decodes to at most
  `MAX_VIDEO_CHUNK_BYTES` (**413** above) and has `ftyp` at byte offset 4; `encoding` (string),
  `duration_ms` and `frame_count` (integers >= 0) and `frame_rate` (number) are optional;
  touches as for frames. `source` is optional; when present it must be an object whose
  `vendor` / `replay_id` are strings. Unknown keys (in the chunk and in `video`) are kept.
  A segment's duration is `video.duration_ms`, or `ended_at - started_at` without it.

Timestamps are epoch milliseconds. The body is read up to the largest limit; a body above the
rrweb limit is then checked against the limit of its `kind` (`frames` 8 MiB, `video`
base64(`MAX_VIDEO_CHUNK_BYTES`) + 1 MiB). Response `202`:

```json
{"accepted":true,"project_id":"web-store","session_id":"<id>","kind":"frames","seq":1,"events":0,"frames":2,"touches":3,"bytes":5823}
{"accepted":true,"project_id":"mobile-store","session_id":"<id>","kind":"video","seq":3,"events":0,"frames":5,"touches":1,"bytes":64410}
```

(`events` counts rrweb events; `frames` counts frame-chunk frames, or `video.frame_count` for
video; `touches` counts touches; the other kinds' counters are 0; `bytes` is the
decompressed request body.) 409 `{"error":"replay kind mismatch: session <id> holds a frames replay, chunk is rrweb"}`
when the session already has a replay of another kind; nothing is written.

On disk: `<DATA_DIR>/replays/<session_id>/000003.json.gz` (always gzip) plus `meta.json`,
both written atomically (temp file + rename, one mutex per session). A video chunk also
writes `000003.mp4` (the decoded mp4, written first) and its `000003.json.gz` is the chunk
without `video.mp4` and with `video.bytes` (the mp4 size); every other byte of the upload is
kept. Re-posting a `seq` replaces both files.

Metrics (exported through rum-api's own OTel pipeline, `service.name=rum-api`):
`ouo.replay.chunks` (`{chunk}`) and `ouo.replay.bytes` (`By`, decompressed), both with the
attribute `ouo.project.id`. Rejected chunks are not counted; the collector's own
`otelcol_receiver_*` and `ouo_replay_chunks_total` cover the edge.

### Replay reads

- `GET /v1/sessions/{id}/replay` -> the meta. `kind` is always present (`meta.json` files
  written before frames existed read as `rrweb`); `project_id` since 8a (absent on older
  replays); `viewport` and `platform` only for frames and video; `frame_count` /
  `touch_count` are totals (0 for rrweb; for video `frame_count` sums `video.frame_count`);
  `source` (`{vendor, replay_id}` of the first chunk that had one) only for video. Video
  chunks add `duration_ms` and `video_bytes` (mp4 size) and their `bytes` counts the mp4
  plus the gzip JSON:

```json
{"session_id":"<id>","project_id":"web-store","kind":"frames","chunk_count":2,"first_seq":0,"last_seq":1,
 "started_at":1791471538578,"ended_at":1791471548578,"bytes":1796,"frame_count":5,"touch_count":5,
 "viewport":{"width":393,"height":852,"scale":0.5},"platform":"ios","updated_at":"2026-10-08T15:00:08Z",
 "chunks":[{"seq":0,"started_at":1791471538578,"ended_at":1791471543578,"bytes":918,"event_count":0,"frame_count":3,"touch_count":2}, ...]}
{"session_id":"<id>","project_id":"mobile-store","kind":"video","chunk_count":2,"first_seq":0,"last_seq":1,
 "started_at":1791471538578,"ended_at":1791471548578,"bytes":97240,"frame_count":10,"touch_count":1,
 "viewport":{"width":288,"height":624,"scale":1},"platform":"ios",
 "source":{"vendor":"sentry","replay_id":"<32 hex>"},"updated_at":"2026-10-14T10:00:08Z",
 "chunks":[{"seq":0,"started_at":1791471538578,"ended_at":1791471543578,"bytes":48530,"event_count":0,"frame_count":5,"touch_count":1,
            "duration_ms":5000,"video_bytes":48211}, ...]}
```

- `GET /v1/sessions/{id}/replay/events` -> one JSON array with every rrweb event of every
  chunk in `seq` order (streamed; gzip when `Accept-Encoding: gzip`). Feed it to
  `rrweb-player` as `events`. Chunks that fail to decode are skipped. **409** when the
  session's replay is `frames`.
- `GET /v1/sessions/{id}/replay/frames` -> all frame chunks concatenated in `seq` order
  (streamed; gzip when accepted; frame objects are copied through as uploaded):

```json
{"session_id":"<id>","kind":"frames","viewport":{"width":393,"height":852,"scale":0.5},"platform":"ios",
 "started_at":1791471538578,"ended_at":1791471548578,
 "frames":[{"ts":1791471538678,"jpeg":"<base64>","reason":"resume"}, ...],
 "touches":[{"ts":1791471540828,"x":120.5,"y":640,"phase":"began"}, ...]}
```

  **409** when the replay is `rrweb` or `video`, 404 when there is none.
- `GET /v1/sessions/{id}/replay/video` -> the video manifest (gzip when accepted): segments
  in `seq` order (`bytes` is the mp4 size, `path` serves it), every touch of every chunk in
  `seq` order, `source` (`null` when no chunk had one). **409** when the replay is `rrweb` or
  `frames`:

```json
{"session_id":"<id>","kind":"video","viewport":{"width":288,"height":624,"scale":1},"platform":"ios",
 "started_at":1791471538578,"ended_at":1791471548578,
 "segments":[{"seq":0,"started_at":1791471538578,"ended_at":1791471543578,"duration_ms":5000,"frame_count":5,"bytes":48211,
              "path":"/v1/sessions/<id>/replay/video/0"}, ...],
 "touches":[{"ts":1791471540828,"x":120.5,"y":410,"phase":"began"}],
 "source":{"vendor":"sentry","replay_id":"<32 hex>"}}
```

- `GET /v1/sessions/{id}/replay/video/{seq}` -> the mp4 (`Content-Type: video/mp4`) through
  `http.ServeContent`: `Range` requests (**206** + `Content-Range`, **416** outside the
  file), `Last-Modified` and `ETag` (size + mtime) with `If-Modified-Since` /
  `If-None-Match` (**304**), `HEAD`; `Cache-Control: private, no-cache` because a re-posted
  `seq` replaces the file. **400** when `seq` is not an integer in `0..999999`, **404** when
  the session or the segment is missing, **409** when the replay is not video.

  The three streaming endpoints (`/replay/events`, `/replay/frames`, `/replay/video`) and the
  segment endpoint set `X-Ouo-Replay-Kind`; a 409 names the endpoint of the replay's kind.
- `DELETE /v1/sessions/{id}/replay` -> `204`, removes the directory (any kind, mp4 files
  included).

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
  "trace_count":5,"has_replay":true,"replay_kind":"rrweb",
  "replay_duration_ms":20410,"replay_frame_count":null
 }],"count":1,"from":"2026-10-06T04:30:00Z","to":"2026-10-06T05:30:00Z"}
```

- `has_replay` / `replay_kind`: `replay_kind` is `"rrweb"`, `"frames"` or `"video"` when a
  replay exists, `null` otherwise, so the plugin can pick the player without a second call.
- `replay_duration_ms` / `replay_frame_count`: from the replay's `meta.json`
  (`ended_at - started_at` in ms; `frame_count`, for video the sum of the segments'
  `video.frame_count`). `replay_duration_ms` is `null` without a replay or when the meta has
  no usable timestamps; `replay_frame_count` is `null` for rrweb replays (they have events,
  not frames) and without a replay. Both are filled on the list
  and the detail endpoints by reading `meta.json` per session (a `stat` first, so sessions
  without a replay cost one syscall).

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

`GET /v1/sessions/{id}/logs[?from=&to=]` -> the session's log lines and the lines of other
services that share one of its traces (a backend's request logs when the app propagates
`traceparent` but no session id):

```json
{"session_id":"...","count":119,"truncated":false,"trace_count":26,
 "query":"{service_name=~\".+\"} | session_id=\"<id>\" or trace_id=~\"<id1>|<id2>\"",
 "explore_url":"http://localhost:3000/explore?...loki...",
 "logs":[{"ts":"...","service":"demo-backend","level":"error","body":"request failed",
          "trace_id":"...","span_id":"...","source":"trace","trace_url":"http://.../explore?...tempo...",
          "attrs":{"http_route":"/api/checkout","http_response_status_code":"500"}}]}
```

The Tempo search of `/traces` gives the trace ids (padded to 32 hex, at most 200); one LogQL
query over the session's window returns both kinds of lines. Session events that are the
timeline rather than log lines (`session.start`, `session.end`, `navigation`, `http.request`,
`http.request.failed`, `web_vital`, `app.lifecycle`, `ui.tap`, `breadcrumb`) are left out;
`log`, `console`, `exception` and lines without an event name stay. `source` is `session`
(the record carries the session id) or `trace`. `level` is the lower-cased severity text. At
most 2000 lines (`truncated`); `explore_url` opens the full query in Explore. When Tempo
fails, `trace_count` is -1 and only the session's own lines are returned. 404 for an unknown
session.

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

Development values (`deploy/compose/.env.example`): ingest token `it_dev_0000000000000000`,
read token `rt_dev_0000000000000000`. The sink calls below imitate the collector's
exporter; in a deployment only the collector reaches this port.

```bash
I='Authorization: Bearer it_dev_0000000000000000'
P='X-Ouo-Project-Id: demo'
R='Authorization: Bearer rt_dev_0000000000000000'

# store a plain chunk as the collector would
curl -i -X POST localhost:8080/v1/replay/chunks -H "$I" -H "$P" -H 'content-type: application/json' \
  -d '{"session_id":"demo-1","seq":0,"started_at":1000,"ended_at":2000,"events":[{"type":4,"data":{"href":"http://x"},"timestamp":1000},{"type":2,"data":{},"timestamp":1001}]}'
# -> 202 {"accepted":true,"project_id":"demo",...}; 401 without -H "$I" when OUO_INGEST_TOKEN is set; 400 without -H "$P"
# gzip chunk with the informational headers
gzip -c chunk.json | curl -i -X POST localhost:8080/v1/replay/chunks -H "$I" -H "$P" -H 'x-ouo-session-id: demo-1' -H 'x-ouo-seq: 1' \
  -H 'content-type: application/json' -H 'content-encoding: gzip' --data-binary @-
curl -H "$R" localhost:8080/v1/sessions/demo-1/replay          # 401 without the read token when OUO_READ_TOKEN is set
curl -H "$R" --compressed localhost:8080/v1/sessions/demo-1/replay/events | head -c 300
# frames chunk (jpeg is a base64 JPEG; "/9j/" is the base64 of FF D8 FF)
curl -i -X POST localhost:8080/v1/replay/chunks -H "$I" -H "$P" -H 'content-type: application/json' \
  -d '{"kind":"frames","schema_version":1,"session_id":"demo-ios-1","seq":0,"started_at":1791471538578,"ended_at":1791471543578,"viewport":{"width":393,"height":852,"scale":0.5},"platform":"ios","frames":[{"ts":1791471538678,"jpeg":"/9j/4AAQSkZJRg...","reason":"resume"}],"touches":[{"ts":1791471540828,"x":120.5,"y":640,"phase":"began"}]}'
curl -H "$R" --compressed localhost:8080/v1/sessions/demo-ios-1/replay/frames | head -c 300
curl -H "$R" -i localhost:8080/v1/sessions/demo-ios-1/replay/events     # 409
# video chunk as the Sentry bridge emits it (mp4 is base64; "AAAAGGZ0eXBtcDQy" is 00 00 00 18 "ftypmp42")
curl -i -X POST localhost:8080/v1/replay/chunks -H "$I" -H 'X-Ouo-Project-Id: mobile-store' -H 'content-type: application/json' \
  -d '{"kind":"video","schema_version":1,"session_id":"demo-sentry-1","seq":0,"started_at":1791471538578,"ended_at":1791471543578,"viewport":{"width":288,"height":624,"scale":1},"platform":"ios","video":{"container":"mp4","encoding":"h264","duration_ms":5000,"frame_count":5,"frame_rate":1,"mp4":"AAAAGGZ0eXBtcDQyAAAAAG1wNDJpc29t..."},"touches":[],"source":{"vendor":"sentry","replay_id":"0123456789abcdef0123456789abcdef","segment_id":0,"replay_type":"session"}}'
curl -H "$R" --compressed localhost:8080/v1/sessions/demo-sentry-1/replay/video
curl -H "$R" -r 0-99 -D - -o /dev/null localhost:8080/v1/sessions/demo-sentry-1/replay/video/0   # 206, Content-Range: bytes 0-99/<size>
curl -H "$R" -X DELETE -i localhost:8080/v1/sessions/demo-1/replay

curl -H "$R" 'localhost:8080/v1/sessions?from=now-2h&status=crashed&platform=web'
curl -H "$R" 'localhost:8080/v1/sessions/<session_id>' | jq '.timeline[] | {ts, type, name}'
curl -H "$R" 'localhost:8080/v1/sessions/<session_id>/traces' | jq '.traces[] | {trace_id, root_name, span_count, has_error, grafana_url}'
curl -H "$R" 'localhost:8080/v1/sessions/<session_id>/logs?from=now-24h' | jq '.logs[] | {ts, service, level, body}'
curl -H "$R" 'localhost:8080/v1/stats/health?from=now-24h' | jq
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
- **Replay**: `internal/replay.Store` interface, filesystem implementation; the events and
  frames endpoints stream chunk files through a JSON token decoder without loading
  everything (touches of a frames replay are buffered, frames are copied through). A video
  chunk's mp4 is decoded once at ingest and stored raw, so segment reads are plain file
  serving; the stored JSON is the upload with only the `video` value replaced (byte offsets
  from the token decoder), and the manifest reads only those small JSON files. The kind
  and the project id are checked under the per-session lock before the chunk file is
  written, so a rejected chunk leaves nothing behind. `PeekKind` scans only top-level keys
  and runs only for bodies above the rrweb limit.
- **Auth**: two independent bearer tokens compared with `crypto/subtle`; the ingest token
  guards only the sink, the read token only `GET` / `DELETE /v1/*`. Project identity is not
  verified here: the collector authenticated it, rum-api records what the collector says.

## Layout

```
main.go                      config, telemetry, HTTP server, -check healthcheck
internal/config              env parsing
internal/httpapi             routes, CORS (local origins), ingest / read tokens, replay sink, handlers, metrics (+ tests with fakes)
internal/session             Loki stream -> Event, Fold, Classify, Health (+ fixtures)
internal/loki                query_range client with pagination
internal/tempo               search client, cache, Grafana Explore links
internal/replay              Store interface, chunk validation (rrweb, frames, video), filesystem store (+ mp4 segments), event / frame streaming, video manifest
internal/timerange           from/to parsing
internal/telemetry           OTel SDK setup (traces, logs, metrics via OTLP/HTTP)
```
