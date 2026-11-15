# Muninn ingest and query contract

Status: **draft** (2026-11-11). Becomes normative when [ADR-0019](../adr/0019-collector-to-muninn.md) is accepted. Nothing in it is implemented.

Muninn is ouo's replay store. This spec is the contract for three parties:

| Party | Reads |
|---|---|
| SDK authors (web, React Native, native) | [Section 3](#3-records) and [section 5](#5-collector-requirements): what a chunk record must look like to be stored, and what a 2xx from the Collector means |
| Collector configuration and vendor receivers | [Sections 4](#4-ingest-api) and [5](#5-collector-requirements) |
| The plugin BFF (`ouo-go`) and players | [Sections 7](#7-read-api) to [9](#9-retention-and-tenancy) |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Requirement ids are `MUN-` for Muninn, `COL-` for the Collector and `RDR-` for readers.

The chunk model itself (session, replay, stream, segment, chunk; attributes; delivery rules) is defined by the SDK spec, [section 11](../../project/kb/opentelemetry/rum-semantic-conventions/sdk-spec.md#11-replay-contract), whose requirement ids (`RPL-`, `TRN-`) are cited here. Where the two disagree, the SDK spec wins for what an SDK emits and this spec wins for what Muninn accepts and serves.

## 1. Roles and boundaries

- **MUN-1** Muninn MUST accept writes only from Collectors and reads only from server-side components (the BFF). It MUST NOT be exposed to browsers, apps or the internet.
- **MUN-2** Muninn MUST treat chunk bodies as opaque bytes. It MUST NOT decode, transcode, recompress or inspect them beyond hashing and measuring.
- **MUN-3** Muninn MUST NOT make outbound calls to vendor APIs and MUST NOT hold vendor credentials. Its only outbound dependencies are its object store and the Collector it sends its own telemetry to.
- **MUN-4** Muninn MUST keep all durable state in the object store. Any replica MUST be able to serve any request, and replicas MUST NOT need to talk to each other.

## 2. Identifiers

| Name | Source | Syntax |
|---|---|---|
| Tenant | `X-Scope-OrgID` header | `^[a-z0-9][a-z0-9_-]{0,63}$`. `anonymous` when multi-tenancy is off. Bad syntax answers 400, a missing header 401 |
| Project | Resource attribute `ouo.project.id` on ingest; path parameter on reads | `^[a-z0-9][a-z0-9._-]{0,63}$` |
| Session | `session.id` | `^[0-9a-f]{32}$` |
| Replay | `ouo.replay.id` | `^[0-9a-f]{32}$` |
| Stream | `ouo.replay.stream.id` | `^[0-9a-f]{32}$` |
| Sequence | `ouo.replay.sequence` | Integer, 0 to 999 999 999 |

**Chunk identity** is the tuple `(tenant, project, session, replay, stream, sequence)`.

- **MUN-5** Muninn MUST reject any identifier that does not match its syntax. Identifiers are used in storage keys, so no other characters are ever accepted.

## 3. Records

Muninn stores two kinds of OTLP log record. Both MUST be in an instrumentation scope named `ouo.replay`, under a resource that carries `ouo.project.id`.

### 3.1 `ouo.replay.chunk`

`event_name` is `ouo.replay.chunk`. The body is an OTLP `bytes_value`: the chunk bytes as produced by the format layer, after compression. `time_unix_nano` is the chunk start.

| Attribute | Type | Required | Rule checked by Muninn |
|---|---|---|---|
| `session.id` | string | yes | Syntax |
| `ouo.replay.id` | string | yes | Syntax |
| `ouo.replay.stream.id` | string | yes | Syntax |
| `ouo.replay.sequence` | int | yes | Range |
| `ouo.replay.segment.index` | int | yes | ≥ 0 |
| `ouo.replay.keyframe` | bool | yes | |
| `ouo.replay.start_time`, `ouo.replay.end_time` | int, ms since epoch | yes | `start_time` ≤ `end_time`. Not compared with the server clock |
| `ouo.replay.format` | string | yes | 1 to 64 characters of `[a-z0-9./_-]`. The value is not checked against a list |
| `ouo.replay.encoding` | string | yes | `gzip` or `identity` |
| `ouo.replay.sha256` | string | yes | 64 lowercase hex, equal to the SHA-256 of the body bytes |
| `ouo.replay.byte_size` | int | yes | Equal to the body length, 1 to 1 048 576 |
| `ouo.replay.masked` | bool | yes | |
| `ouo.replay.mode` | string | yes | `session` or `buffer` |
| `ouo.replay.trigger` | string | when `mode` is `buffer` | |
| `ouo.view.id` | string | no | |
| `ouo.replay.source.vendor`, `ouo.replay.source.id` | string | no | Set by vendor receivers only |
| `ouo.replay.ref` | string | must be absent | Set only on the Loki copy ([COL-6](#5-collector-requirements)) |

Resource attributes other than `ouo.project.id` are not stored. `time_unix_nano` is stored and returned, not interpreted.

- **MUN-6** Muninn MUST store every attribute of an accepted record, including ones this table does not list, and return them unchanged on read. Total attribute size per record is limited to 16 KiB.
- **MUN-7** `ouo.replay.format` names the format and its version, for example `rrweb/2`. The list of formats, their class (structure or pixel) and their media types belongs to the SDK spec, section 11.6. Muninn MUST store a chunk whose format it does not know (RPL-24).

Two classes of format exist, and Muninn handles both the same way:

| Class | Examples | Typical encoding | Body |
|---|---|---|---|
| Structure | Web DOM recording, mobile wireframes | `gzip` | Each body decompresses alone; the decompressed bodies of a segment, in sequence order, concatenate into one valid payload (RPL-7) |
| Pixel | JPEG frames with tiles, MP4 segments | `identity` | Already compressed by the image or video codec |

### 3.2 `ouo.replay.ended`

`event_name` is `ouo.replay.ended`. No body.

| Attribute | Required | Rule |
|---|---|---|
| `session.id`, `ouo.replay.id`, `ouo.replay.stream.id` | yes | Syntax |
| `ouo.replay.end_state` | yes | `complete` or `partial` |
| `ouo.replay.end_reason` | yes | Stored as sent |
| `ouo.replay.last_sequence` | when any chunk was produced | Range |

- **MUN-8** A stream has at most one stored end record, written create-only. The first one stored stays; a later one for the same stream is answered as success and not stored.

### 3.3 Required of the SDK spec

Muninn is stricter than the SDK spec draft in four places. An SDK that breaks one of them gets its 2xx from the Collector and then loses the chunk at Muninn without being told, so the SDK spec has to state them before SDKs are built against it:

| SDK spec today | Muninn requires |
|---|---|
| `ouo.replay.id`, `ouo.replay.stream.id`: "128-bit random" | Written as 32 lowercase hex characters, like `session.id` (SES-1) |
| `ouo.replay.encoding`: "for example `gzip`" | Exactly `gzip` or `identity` |
| `ouo.replay.format`: no syntax | 1 to 64 characters of `[a-z0-9./_-]` |
| Nothing about a capture window with no data | A chunk body is never empty. A window with nothing to send produces no chunk and does not consume a sequence number |

## 4. Ingest API

```
POST /otlp/v1/logs
```

OTLP/HTTP, as specified by OTLP 1.x: the request is an `ExportLogsServiceRequest`, the success response an `ExportLogsServiceResponse`.

| Header | Rule |
|---|---|
| `Content-Type` | `application/x-protobuf`. Anything else 415 (OTLP/JSON is not accepted in the first version) |
| `Content-Encoding` | absent, `identity` or `gzip`. Anything else 415 |
| `X-Scope-OrgID` | Required when multi-tenancy is on (401 if missing, 400 if malformed). Ignored when off |
| `Authorization: Bearer <ingest token>` | Required when an ingest token is configured (401 otherwise). Compared in constant time |

### 4.1 Processing rules

- **MUN-9** Muninn MUST answer 503 for every failure of its own on the ingest path, including an unexpected internal error. It MUST NOT answer any other 5xx: the Collector's exporter drops a request on every status outside 429, 502, 503 and 504, and by then the SDK has already deleted the chunk.
- **MUN-10** The request body MUST NOT exceed `limits.max_request_bytes` (default 16 MiB), compressed or decompressed. Larger: 413, nothing stored.
- **MUN-11** Each record is validated on its own against [section 3](#3-records). An invalid record is **rejected**: it is not stored, it is counted in `partial_success.rejected_log_records`, and `partial_success.error_message` names the first reason. Other records in the request are unaffected.
- **MUN-12** A record outside scope `ouo.replay`, or with another event name, or under a resource without a valid `ouo.project.id`, is rejected with reason `not_replay`, `unknown_event` or `no_project`.
- **MUN-13** A chunk whose identity is already stored with the **same** `ouo.replay.sha256` MUST be answered as success and MUST NOT be written again.
- **MUN-14** A chunk whose identity is already stored with a **different** hash MUST be rejected with reason `conflict`. The first write stays.
- **MUN-15** A record whose replay has a tombstone ([section 8](#8-delete-api)) MUST be answered as success and MUST NOT be stored. It is counted with outcome `tombstoned`.
- **MUN-16** Muninn MUST answer 2xx only after every accepted chunk and end record of the request is durably stored: the object-store write has returned success, and on the filesystem store the file and its directory entry are synced.
- **MUN-17** If any valid record cannot be stored for a transient reason (object store unreachable, timeout, throttled), Muninn MUST answer 503 for the whole request. Records of that request that were already stored become no-ops on the retry (MUN-13).
- **MUN-18** Muninn MUST NOT assume arrival order. A chunk may arrive before a lower sequence, after its stream's end record, or days late.
- **MUN-19** Records of one request MAY belong to different sessions, projects and streams.

### 4.2 Responses

| Status | Meaning | What the Collector's exporter does |
|---|---|---|
| 200, `partial_success` unset | Every record stored, already stored, or tombstoned | Removes the request from its queue |
| 200, `rejected_log_records` > 0 | Valid records stored, the rest rejected for good | Removes the request, logs the message |
| 400 | Body is not a decodable OTLP logs request, or the tenant header is malformed | Drops, counts |
| 401 | Missing or wrong token or tenant | Drops, counts |
| 413 | Request too large | Drops, counts |
| 415 | Unsupported content type or encoding | Drops, counts |
| 503 with `Retry-After` | Transient storage failure, an internal error, or Muninn is starting or stopping | Retries with backoff |

A 401, 404 or 413 between Collector and Muninn means a configuration fault (wrong token, wrong URL, limits out of step) and loses chunks. Operators MUST alert on the Collector's failed-send counter for the Muninn exporter. Rejections through partial success appear only in Muninn's metrics; the exporter logs them and counts nothing.

Rejection reasons, used in `error_message` and in metrics: `not_replay`, `unknown_event`, `no_project`, `bad_id`, `missing_attribute`, `bad_attribute`, `too_large`, `hash_mismatch`, `size_mismatch`, `conflict`.

## 5. Collector requirements

These bind the ouo-collector configuration and any other Collector that feeds Muninn.

- **COL-1** SDKs send replay records to the Collector's ordinary OTLP/HTTP logs endpoint (`/v1/logs`), protobuf, one chunk per request (TRN-1, TRN-5). The Collector MUST NOT require a replay-specific port or path.
- **COL-2** The Collector MUST route log records by instrumentation scope name: scope `ouo.replay` goes to the replay pipeline, everything else to the logs pipeline. The routing MUST happen before any batching, and the project MUST be stamped on the resource before the routing.
- **COL-3** The replay pipeline MUST NOT contain a batch processor or any other component that returns before its downstream has accepted the data.
- **COL-4** The replay pipeline's exporter MUST use a persistent sending queue on local disk with fsync. The Collector MUST answer the SDK 2xx only after the request is written to that queue. This is the "durably accepted" of TRN-12.
- **COL-5** The queue MUST be bounded (default 2 GiB). When it is full the Collector MUST answer the SDK 503 (or 429) and MUST NOT block the request or drop silently. A full replay queue MUST NOT affect the logs, traces or metrics pipelines.
- **COL-6** For every `ouo.replay.chunk` record, the Collector MUST also send Loki a copy **without the chunk bytes** (an empty body) and with `ouo.replay.ref` set. `ouo.replay.ended` records are sent to both Muninn and Loki unchanged.
- **COL-7** `ouo.replay.ref` is `muninn:/<project>/<session.id>/<ouo.replay.id>/<ouo.replay.stream.id>/<ouo.replay.sequence>`. Consumers MUST treat it as opaque apart from that it names one chunk within the tenant.
- **COL-8** The Collector MUST retry a request to Muninn on 429, 502, 503, 504 and network failure, honouring `Retry-After`, with no overall time limit, and MUST reuse the same bytes. It MUST drop and count a request on any other status.
- **COL-9** The Collector MUST overwrite any `ouo.project.id` supplied by a client. When Muninn runs multi-tenant, the exporter sends one fixed `X-Scope-OrgID`: in the first version a Collector serves one tenant. A Collector shared by tenants is later work.
- **COL-10** The Collector MUST NOT compress the request to Muninn a second time when it carries chunk bodies.

A reference record in Loki is a hint. The copy is handed to the logs pipeline on every attempt, before the queue write is known to have succeeded. So a reference can exist for a chunk Muninn never stored, each SDK retry against a full queue adds another reference, and "has a replay" answered from Loki can be true for a replay Muninn does not hold.

- **RDR-1** A reader MUST treat Muninn as the only authority on which chunks exist.

## 6. Storage layout

Normative for operators and for compatibility between Muninn versions. Readers MUST use the API, never the store.

```text
[<prefix>/]muninn/schema.json
[<prefix>/]muninn/<tenant>/<project>/<session>/<replay>/deleted.json
[<prefix>/]muninn/<tenant>/<project>/<session>/<replay>/<stream>/c/<sequence as 10 digits>
[<prefix>/]muninn/<tenant>/<project>/<session>/<replay>/<stream>/ended.json
```

Backends: S3-compatible object storage, or a local filesystem with the same relative paths.

### 6.1 Chunk object

One object per chunk, immutable.

```text
offset 0   4 bytes   magic "OUOC"
offset 4   1 byte    container version, 0x01
offset 5   4 bytes   header length N, unsigned big-endian
offset 9   N bytes   header, UTF-8 JSON
offset 9+N           body, exactly the bytes of the record's body
```

Header:

```json
{
  "attributes": { "session.id": "…", "ouo.replay.sequence": 42, "ouo.replay.keyframe": false, "…": "…" },
  "time_unix_nano": "1794400000000000000",
  "received_at": 1794400003120,
  "project": "shop-web"
}
```

- **MUN-20** A chunk object MUST be created with a create-only write (S3 `If-None-Match: *`; filesystem: write a temporary file, sync, hard-link to the final name). If the object exists, Muninn reads its header and applies MUN-13 or MUN-14.
- **MUN-21** No object except `schema.json` is ever modified after creation. Chunk objects, end records and tombstones are create-only, so replicas cannot overwrite each other.
- **MUN-22** Structure and pixel chunks MUST use the same key layout and container.

### 6.2 Other objects

| Object | Content | Written |
|---|---|---|
| `ended.json` | The end record's attributes, `time_unix_nano` and `received_at` | On `ouo.replay.ended`, create-only (MUN-8) |
| `deleted.json` | `{"deleted_at": ms, "by": "api" \| "retention"}` | On delete, per [section 8](#8-delete-api) |
| `schema.json` | Highest layout version written to this store, and by which Muninn version | At start. Muninn MUST refuse to start on a store with a newer layout version than it knows |

There is no stored manifest or index in the first version. A replay's manifest is computed on read: one listing of the replay prefix (one request per 1000 objects) and one ranged read of each chunk header. Headers never change, so a replica MAY cache them in memory by object key without any invalidation; the listing is always fresh. A stored manifest for closed streams is a later optimisation and must not be the only source of truth.

On S3 every object except `schema.json` carries a retention tag ([section 9](#9-retention-and-tenancy)).

## 7. Read API

All paths start with `/api/v1/projects/{project}`. Every request carries `X-Scope-OrgID` when multi-tenancy is on, and `Authorization: Bearer <read token>` when a read token is configured. The admin token (`auth.admin_token`) opens every route of this section too; it alone opens MUN-45 and section 14, and when it is not configured those routes answer 401. The admin token is the operator's (`ouo-erase`); a plugin backend holds only the read token. Responses are JSON unless stated, and are gzip-compressed when the request accepts it. Errors are `{"error": "<message>"}`.

### 7.1 List the replays of a session

```
GET /api/v1/projects/{project}/sessions/{session_id}/replays
```

200:

```json
{
  "session_id": "…",
  "replays": [
    {
      "replay_id": "…",
      "state": "complete",
      "start_time": 1794400000000,
      "end_time": 1794400312000,
      "chunk_count": 63,
      "byte_size": 184220,
      "formats": ["rrweb/2"],
      "stream_count": 1
    }
  ]
}
```

A session with no replay answers 200 with an empty list. Replays are ordered by `start_time`.

### 7.2 Get a replay

```
GET /api/v1/projects/{project}/sessions/{session_id}/replays/{replay_id}
```

200:

```json
{
  "session_id": "…",
  "replay_id": "…",
  "project": "shop-web",
  "state": "partial",
  "start_time": 1794400000000,
  "end_time": 1794400312000,
  "chunk_count": 63,
  "byte_size": 184220,
  "streams": [
    {
      "stream_id": "…",
      "state": "partial",
      "start_time": 1794400000000,
      "end_time": 1794400312000,
      "end": { "end_state": "complete", "end_reason": "pagehide", "last_sequence": 63, "time_unix_nano": "…" },
      "missing": [[17, 17]],
      "chunks": [
        {
          "sequence": 0,
          "segment_index": 0,
          "keyframe": true,
          "start_time": 1794400000000,
          "end_time": 1794400005000,
          "format": "rrweb/2",
          "encoding": "gzip",
          "byte_size": 20311,
          "sha256": "…",
          "received_at": 1794400003120,
          "attributes": { "ouo.replay.masked": true, "ouo.replay.mode": "session", "ouo.view.id": "…" },
          "path": "/api/v1/projects/shop-web/sessions/…/replays/…/streams/…/chunks/0"
        }
      ]
    }
  ]
}
```

- `chunks` is ordered by `sequence`. `attributes` holds every stored attribute that has no field of its own.
- `end` is `null` when no end record is stored.
- `missing` lists inclusive sequence ranges that are not held, between 0 and the highest of `last_sequence` and the highest held sequence.
- A stream that holds only an end record is listed with no chunks, state `partial`, and `missing` covering 0 to `last_sequence` when that is present.
- `start_time`, `end_time`, `chunk_count` and `byte_size` are computed from the chunks held.
- The answer is not paged in the first version. A chunk entry is about 300 bytes, so an hour of recording is about 0.2 MB of JSON before gzip and the 24-hour session maximum about 5 MB.
- 404 when the replay does not exist or is deleted.

**State.**

- **MUN-30** A stream is `complete` when an end record is stored with `end_state=complete` and every sequence from 0 to `last_sequence` is held.
- **MUN-31** A stream is `open` when it is not complete, no end record is stored, and its most recently received chunk (highest `received_at`) arrived less than `stream_idle_timeout` (default 30 min) ago.
- **MUN-32** Otherwise a stream is `partial`. State is computed, not final: a late chunk can turn `partial` into `complete`.
- **MUN-33** A replay is `open` if any stream is open, `complete` if all streams are complete, else `partial`.

### 7.3 Get a chunk

```
GET /api/v1/projects/{project}/sessions/{session_id}/replays/{replay_id}/streams/{stream_id}/chunks/{sequence}
```

200: the body bytes exactly as stored.

| Response header | Value |
|---|---|
| `Content-Type` | The media type of the chunk's format from the SDK spec's format registry; `application/octet-stream` for a format Muninn has no entry for |
| `Content-Encoding` | `gzip` when the chunk's encoding is `gzip`; absent for `identity` |
| `ETag` | `"<ouo.replay.sha256>"` |
| `Content-Length` | Stored body length |
| `X-Ouo-Replay-Format` | The chunk's `ouo.replay.format` |

- **MUN-34** Muninn MUST NOT decompress a `gzip` chunk for a client. Its client is the BFF, which MUST accept gzip.
- 404 when the chunk is not held.

Byte ranges, conditional requests and a call that returns a run of chunks in one response are left out of the first version. A chunk is at most 1 MiB and is fetched whole.

### 7.4 Status codes of reads and deletes

| Status | When |
|---|---|
| 200 | Read answered. A session with no replays is 200 with an empty list |
| 204 | Delete done, or nothing to delete |
| 400 | An identifier or the tenant header is malformed |
| 401 | Missing or wrong read token (admin token on MUN-45 and section 14), or missing tenant header |
| 404 | The replay or chunk does not exist, is deleted, or belongs to another tenant or project |
| 503 | The object store is unavailable |

### 7.5 Reader rules

- **RDR-2** A reader MUST choose a decoder by `format` and MUST show a chunk of unknown format as stored but not playable (RPL-24).
- **RDR-3** A segment is playable from its keyframe chunk up to the first missing sequence. After a gap, a reader MUST resume at the next chunk with `keyframe=true`.
- **RDR-4** A reader MUST order chunks by `sequence` within a stream and place streams on the session timeline by `start_time` and `end_time`. One replay can have several streams, which can overlap (two tabs).
- **RDR-5** Role-based redaction and access checks are the BFF's. Muninn returns what is stored.

### 7.6 Health

`GET /ready` answers 200 when the object store is reachable, 503 otherwise. `GET /healthz` answers 200 while the process runs. Neither needs a token.

## 8. Delete API

```
DELETE /api/v1/projects/{project}/sessions/{session_id}/replays
DELETE /api/v1/projects/{project}/sessions/{session_id}/replays/{replay_id}
```

- **MUN-40** Deleting a replay MUST first write the tombstone (`deleted.json` at the replay prefix, create-only), then remove every other object under that prefix, then answer 204. It is idempotent.
- **MUN-41** Deleting a session's replays deletes each replay found under the session prefix, each with its own tombstone. There is no session-level tombstone, so a new replay in the same session (for example after consent is granted again) is stored normally.
- **MUN-42** A tombstone MUST be kept for `tombstone_ttl` (default 7 days). Before the sweeper removes a tombstone it MUST delete every other object under the replay prefix again, which removes any chunk that slipped in between an ingest's tombstone check and the delete.
- **MUN-43** Reads of a tombstoned replay answer as if it does not exist.
- **MUN-44** Every delete through the API MUST be recorded as a log record sent to the Collector, with tenant, project, session, replay and the number of objects removed. The tombstone is the durable evidence; the log record is best effort.

Known windows, accepted in the first version:

- A chunk held back longer than `tombstone_ttl` (the SDK persists for 72 h; a Collector queue retries without a time limit while Muninn is down) arrives after the tombstone is gone and is stored. It shows as a `partial` replay and is removed by retention.
- A replay whose first chunk arrives only after its session's replays were deleted has no tombstone and is stored.

```
DELETE /api/v1/projects/{project}
```

- **MUN-45** Deleting a project MUST remove every replay of the project as MUN-40 does (each with its own tombstone, `by` `api`), then every debug file, meta, pointer and `.seen` of the project (section 13). It takes the admin token only. It answers 200 with `{"replays": n, "debug_files": n}`: the replays that were live (not tombstoned before) and the debug files (bodies, not their meta or pointers), the same counts as its MUN-44 log record. It is idempotent (a second call answers zeros) and used by `ouo-erase project`. It may run for minutes: its write deadline is 10 minutes, and a rerun after a timeout finishes the job.

Delete by user or by time range is composed by the caller (`ouo-erase` or a client backend), which finds the sessions in Loki and calls these endpoints.

## 9. Retention and tenancy

- **MUN-50** Retention is configured as a default (720 h) with an override per project. `0` keeps replays forever.
- **MUN-51** A sweeper MUST delete a replay, as a whole and with a tombstone marked `retention`, when the newest object under its prefix is older than the project's retention. It finds this by listing each project's keys with their last-modified times, every `retention.sweep_interval`. That is one list request per 1000 objects stored; a cheaper index (for example a day marker per replay) is a later optimisation. The sweeper MUST be safe to run in several replicas at once.
- **MUN-52** On S3, objects MUST be tagged `ouo-retention=<n>d`, where n is the project's retention in whole days plus the days of `tombstone_ttl`, or `ouo-retention=keep` for retention `0`. Muninn MAY own the matching bucket lifecycle rules. The rules are a safety net for when Muninn is down; the sweeper is what makes a replay disappear as a whole. A changed retention applies to the sweeper at once and to tags only for objects written afterwards.
- **MUN-53** A request for one tenant MUST NOT read, list or delete another tenant's keys. A request for one project MUST NOT reach another project's keys.
- **MUN-54** With multi-tenancy off, Muninn MUST use tenant `anonymous` and ignore `X-Scope-OrgID`.

## 10. Limits and defaults

| Setting | Default | On breach |
|---|---|---|
| `limits.max_chunk_bytes` | 1 048 576 | Record rejected, `too_large` |
| `limits.max_attribute_bytes` | 16 384 | Record rejected, `bad_attribute` |
| `limits.max_request_bytes` | 16 777 216 | 413 |
| `stream_idle_timeout` | 30 min | Stream becomes `partial` |
| `tombstone_ttl` | 168 h | Tombstone removed |
| `retention.default` | 720 h | Replay swept |
| `retention.sweep_interval` | 1 h | |
| `server.http_listen_port` | 3400 | |

Configuration follows the stack's convention: a YAML file (`-config.file`) with environment expansion, as Loki and Tempo do (and rum-api did).

## 11. Self-telemetry

Muninn sends its own traces, logs and metrics to the Collector over OTLP, as every platform service does. Metrics it MUST expose:

| Metric | Attributes |
|---|---|
| `muninn.ingest.records` | `ouo.project.id`, `event`, `outcome` (`stored`, `duplicate`, `tombstoned`, `rejected`), `reason`, `ouo.replay.format` |
| `muninn.ingest.bytes` | `ouo.project.id`, `ouo.replay.format` |
| `muninn.ingest.request.duration` | `http.response.status_code` |
| `muninn.read.requests`, `muninn.read.bytes` | `route`, `http.response.status_code` |
| `muninn.store.operation.duration` | `operation`, `outcome` |
| `muninn.sweeper.deleted` | `ouo.project.id`, `reason` |

Tenant is a resource-level concern of the deployment and is not a metric attribute by default.

## 12. Conformance

Checked by a suite that runs against a real Muninn with a filesystem store and a MinIO store.

| Requirements | Check |
|---|---|
| MUN-5, MUN-11, MUN-12 | A table of bad records: each is rejected with its reason, counted, and its neighbours in the same request are stored |
| MUN-6, MUN-7 | A chunk with an unknown format and unknown attributes is stored and returned unchanged |
| MUN-8, MUN-21 | Two end records for one stream: the first stays |
| MUN-9 | Injected internal error on ingest answers 503 |
| MUN-10 | Request over the limit answers 413 and stores nothing |
| MUN-13, MUN-14, MUN-20, MUN-21 | Same chunk twice from two replicas at once: one object, two successes. Same identity with other bytes: `conflict`, first bytes still served |
| MUN-15, MUN-40 to MUN-44 | Delete, then send a late chunk: success, not stored, replay still absent. Chunk written during a delete is gone after the tombstone is swept. New replay in a session whose replays were deleted is stored |
| MUN-16, MUN-17 | Object store paused: 503, then retry stores everything once. Kill Muninn right after a 2xx: the chunk is readable after restart |
| MUN-18 | Chunks in reverse order, end record first: same manifest as in order |
| MUN-30 to MUN-33 | State table: complete, gap, no end record before and after idle timeout, late chunk closing a gap |
| MUN-34 | `Content-Encoding` on a `gzip` chunk, none on an `identity` chunk; bytes equal the bytes sent |
| MUN-50 to MUN-52 | Fake clock past retention: replay gone as a whole, tombstone present, tags set |
| MUN-53, MUN-54 | Cross-tenant and cross-project reads answer 404 |
| COL-1 to COL-5, COL-8 | Against the real ouo-collector: 2xx only after the queue write (kill the Collector right after a 2xx, restart, chunk reaches Muninn); Muninn down, telemetry still flows; queue full answers 503; restart drains the queue |
| COL-6, COL-7 | Loki holds a record per chunk with the reference and an empty body |
| RDR-1 to RDR-5 | Player tests in the plugin, against recorded manifests |

## 13. Debug files

Decided in [ADR-0026](../adr/0026-debug-files-and-erasure-without-rum-api.md). A debug file is a build artefact a client's CI uploads so that stacks can be resolved on read: a JavaScript source map (`sourcemap`), one Mach-O DWARF slice of a dSYM (`dsym`), later an R8 mapping (`proguard`). Muninn stores it opaque and write-once; it never parses one. Resolution is `ouo-go/symbolicate`'s job.

### 13.1 Identifiers and layout

- **kind**: `sourcemap`, `dsym` or `proguard`.
- **debug id**: a UUID, lowercase with dashes (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`). Muninn accepts the 32-hex and uppercase spellings and normalises them. For a source map it is the id `ouo-sourcemaps inject` wrote; for a map without one, the CLI derives it from the SHA-256 of the map (the first 16 bytes as a UUID, version nibble 4, variant 10); for a dSYM it is the slice's `LC_UUID`.
- **file** (optional): the script's URL path, normalised as rum-api did: a full URL loses scheme, host, query and fragment; a bare name gets a leading `/`; then `path.Clean`.

```
[<prefix>/]debug-files/<tenant>/<project>/<kind>/<debug id>                         body, gzip
[<prefix>/]debug-files/<tenant>/<project>/<kind>/<debug id>.json                    meta
[<prefix>/]debug-files/<tenant>/<project>/<kind>/<debug id>.seen                    last re-upload (overwritten)
[<prefix>/]debug-files/<tenant>/<project>/release/<h(release)>/<h(file)>/<kind>/<debug id>   empty pointer
```

`h(x)` is the lowercase hex SHA-256 of x. The meta object is `{"kind", "debug_id", "sha256", "bytes", "release", "file", "uploaded_at"}`, where `sha256` and `bytes` describe the **decompressed** content and `uploaded_at` is Unix milliseconds. The `debug-files/` root is separate from `muninn/`, so the replay sweeper never sees it.

### 13.2 Upload (the one public route)

```
PUT /api/v1/projects/{project}/debug-files/{kind}/{debug id}[?release=&file=]
Authorization: Bearer <upload token>
[Content-Encoding: gzip]
```

- **DBG-1** The route MUST accept only an upload token configured for `{project}` (`debug_files.upload_tokens`), compared in constant time. The read token and the ingest token MUST NOT open it, and an upload token MUST NOT open any other route. A wrong or missing token, or a token of another project, answers 401.
- **DBG-2** The tenant of an upload is the tenant configured with its token (`anonymous` with multi-tenancy off). `X-Scope-OrgID` is ignored on this route, so a client cannot write into another tenant.
- **DBG-3** The body is read up to the kind's size limit, decompressed when `Content-Encoding: gzip`; over the limit answers 413 and stores nothing. An empty body answers 400.
- **DBG-4** Write-once by content. If the key is new, Muninn writes the body (gzip) first, then the meta, then the pointer when `release` and `file` are both given, and answers **201**. If the key exists and the stored `sha256` equals the new content's, it writes any missing pointer, overwrites `<debug id>.seen` with the time (DBG-20) and answers **200**. Otherwise it answers **409** and keeps the first file. Two uploads racing for one key end with one stored file and the other answered 200 or 409.
- **DBG-5** A store failure answers 503 with `Retry-After`. A Muninn holds at most 4 uploads at once (a dSYM is up to 512 MiB decompressed in memory, plus its gzip copy, and Muninn also serves replays); a fifth answers 503 with `Retry-After: 10` before reading the body, and `ouo-sourcemaps` retries it. A leaked upload token can still keep the route busy: rotate it. The response body is the meta as JSON (201 and 200) or `{"error": ...}`.

### 13.3 Reads (private, read or admin token)

```
GET /api/v1/projects/{project}/debug-files/{kind}/{debug id}       the file
GET /api/v1/projects/{project}/debug-files/{kind}/{debug id}/meta  the meta object
GET /api/v1/projects/{project}/debug-files/{kind}?release=&file=   {"debug_ids": [...]}
GET /api/v1/projects/{project}/debug-files/{kind}                  {"debug_files": [{"debug_id", "bytes", "uploaded_at"}]}
```

- **DBG-10** Reads take the read token and `X-Scope-OrgID` like section 7. The file is sent with `Content-Encoding: gzip` when the request accepts gzip, decompressed otherwise. 404 when the file does not exist or belongs to another tenant or project.
- **DBG-11** The list with `release` and `file` returns the debug ids of the pointers under `h(release)/h(file)/<kind>/`, sorted; the caller decides what one, none or several candidates mean (ADR-0022: exactly one). `bytes` in the unfiltered list is the stored (compressed) size.

### 13.4 Retention

- **DBG-20** A debug file, its meta and its pointers are deleted together when the file is older than `debug_files.retention.default` (per project: `debug_files.retention.per_project`), counted from the last upload: a 200 re-upload restarts it (the newer of the body's and `.seen`'s time counts), so a long-lived mobile release keeps its dSYMs while CI uploads them again. `0` keeps them forever. The sweep runs with the replay sweeper, records `muninn.sweeper.deleted` with `reason` `debug_file_retention`, and is safe in several replicas. On S3 the objects carry `ouo-retention=<days>d` or `keep`; a bucket lifecycle rule on that tag counts from the first upload, so the operator sets none for `debug-files/` or one well above the retention.
- A file deleted by retention can be uploaded again.

### 13.5 Settings

| Setting | Default | |
|---|---|---|
| `debug_files.upload_tokens` | none | List of `{project, tenant, token}`. `tenant` is ignored with multi-tenancy off. A project without a token cannot upload |
| `debug_files.max_bytes.sourcemap` | 67 108 864 | Decompressed |
| `debug_files.max_bytes.dsym` | 536 870 912 | Decompressed, one slice |
| `debug_files.max_bytes.proguard` | 268 435 456 | Decompressed |
| `debug_files.retention.default` | 8 760 h (one year) | `0` keeps forever |
| `debug_files.retention.per_project` | none | |

### 13.6 Exposure

Only `PUT /api/v1/projects/*/debug-files/*` is published to the internet (Caddy on the VM, the Ingress in Helm). Every other route stays on the private network. This is the one exception to "ingest only through the Collector" (ADR-0026 section 3).

## 14. Audit entries

The record of erasures run by `ouo-erase` (ADR-0026 section 5). Muninn stores them create-only and never deletes them; no retention applies.

```
PUT /api/v1/audit/{entry}/{status}     create-only, admin token
GET /api/v1/audit[?entry=]             {"entries": [{"entry", "status", "record"}]}, oldest first
[<prefix>/]audit/<tenant>/<entry>/<status>.json
```

- **AUD-1** `entry` matches `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$` (UTC start time, then 8 random hex digits), so keys sort by time. `status` is `started`, `completed` or `failed`. The body is a JSON object of at most 65 536 bytes; anything else answers 400.
- **AUD-2** Create-only: a new key answers 201; the same bytes again answer 200; other bytes answer 409 and the first record stays. Muninn MUST NOT update or delete an audit object; on S3 the operator pairs the `audit/` prefix with Object Lock for immutability. **Tamper evidence exists only on S3 with Object Lock.** The filesystem backend has none: anyone with access to the disk can edit or remove a record without a trace (rum-api's filesystem audit was a hash chain; Muninn's is not).
- **AUD-3** The routes take the admin token only (never the read token) and `X-Scope-OrgID` like section 7. A read without `entry` lists every entry of the tenant.
