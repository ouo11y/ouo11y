# ADR-0019 Collector to Muninn: replay chunks travel as OTLP logs to a replay store

Status: **proposed** (2026-11-11). Not accepted until the founder confirms the choices in [section 10](#10-open-questions-and-recommendations). Design only; nothing here is built.

Number 0018 is taken by the open pull request for "borrow the replay recorder", so this is 0019.

Normative contract: [docs/specs/muninn.md](../specs/muninn.md). Explainer with the diagram: [collector-to-muninn-explainer.html](../../project/kb/muninn/collector-path/collector-to-muninn-explainer.html).

## 1. Context

What is already decided, and not reopened here:

- RUM signals are OTel events (log records with an event name). A replay chunk is one such record, event `ouo.replay.chunk`, scope `ouo.replay`, with the chunk bytes as its body, and `ouo.replay.ended` closes a stream ([SDK spec draft §11](../../project/kb/opentelemetry/rum-semantic-conventions/sdk-spec.md#11-replay-contract)). A chunk carries a structure recording (web DOM, mobile wireframes) or pixel frames; `ouo.replay.format` says which.
- All ingest goes through the OTel Collector ([ADR-0007](../adr-archive/0007-ingest-gateway-project-tokens.md)).
- The replay store is named Muninn, has a REST API and owns its writes. The Collector's replay pipeline uses a disk queue with fsync. Bytes travel SDK to Collector; the log store gets a reference, not the body ([replay.md, D3](../../project/kb/opentelemetry/rum-semantic-conventions/replay.md)).
- The Grafana plugin gets a Go BFF built on `ouo-go`, which queries Loki, Tempo, Mimir, the Victoria stack, Muninn and later Sentry. Vendor API querying does not live in Muninn.

What exists today ([today-and-target.md](../../project/kb/muninn/collector-path/today-and-target.md)): SDKs post a JSON envelope to a custom `ouoreplay` receiver on port 4319; a custom `ouoreplay` exporter posts it to rum-api; rum-api validates per kind (`rrweb`, `frames`, `video`), writes `replays/<session>/<seq>.json.gz` and `meta.json`, and serves kind-specific read endpoints. The queue is in memory, so a 202 from the receiver is not a durable acceptance.

The SDK spec leaves one requirement to this step: an SDK may delete a chunk only after a 2xx, so the Collector must answer 2xx only once the chunk is on its fsync-backed disk queue (TRN-12).

## 2. Decision in brief

1. **Signal and endpoint.** A chunk is an OTLP log record sent to the Collector's ordinary OTLP/HTTP endpoint, `POST /v1/logs`, binary protobuf, one chunk per request. No replay-specific port or path for SDKs.
2. **Collector.** Stock components only. A routing connector sends scope `ouo.replay` to a replay pipeline with no batch processor, whose exporter is the stock `otlp_http` exporter with a persistent (file storage, fsync) sending queue. A second copy with the body removed and `ouo.replay.ref` set goes to Loki.
3. **Muninn ingest.** Muninn accepts OTLP/HTTP logs at `POST /otlp/v1/logs`, the way Loki and Mimir accept OTLP. No custom exporter.
4. **Storage.** Object storage only (S3 or filesystem), no database. One immutable object per chunk, holding a small header and the body exactly as sent. Keys start with tenant, project and session, so "replays of a session" is a prefix listing. Structure and pixel chunks use the same layout.
5. **Read.** A small REST API for the BFF: list a session's replays, get a replay's manifest, get one chunk's bytes, delete.
6. **Retention and tenancy.** Per-project retention counted from a replay's last chunk; `X-Scope-OrgID` tenant plus `ouo.project.id`, the same model as the rest of the stack.
7. **rum-api.** Its replay sink and replay reads are frozen, then removed 30 days after the cut-over. Its other duties move with the BFF step.

## 3. How a chunk travels

```text
SDK ──OTLP/HTTP protobuf, POST /v1/logs, one chunk per request──▶ ouo-collector :4318
      otlp receiver → memory_limiter → ouoratelimit → resource/project
                    → routing connector (scope name == "ouo.replay"?)
          no  → logs pipeline (batch) → Loki
          yes → logs/replay        → otlp_http/muninn  [disk queue, fsync] ──▶ Muninn → object store
              → logs/replay-index  → drop body, set ouo.replay.ref, batch  ──▶ Loki
```

| Topic | Decision |
|---|---|
| OTLP signal | Logs. Scope `ouo.replay`, events `ouo.replay.chunk` and `ouo.replay.ended` |
| SDK endpoint | The same `/v1/logs` as telemetry. Auth, CORS, rate limits and project stamping are the existing ones |
| Routing | By instrumentation scope name, before any batch processor, so the pipeline call stays synchronous |
| Durable acceptance | The OTLP receiver answers 2xx only after the exporter's persistent queue has written the request to disk with fsync. This is what TRN-12 needs |
| Batching | None between SDK and queue. From queue to Muninn, one request per chunk at first; exporter-side batching up to Muninn's request limit may be switched on later without a contract change |
| Size limits | Chunk body 1 MiB (SDK spec RPL-10). OTLP receiver body limit stays 4 MiB. Muninn request limit 16 MiB |
| Compression | The body is already compressed by the format layer, so the hop to Muninn sends no `Content-Encoding` |
| Backpressure | Disk queue bounded in bytes. When full, the pipeline returns an error, the receiver answers 503 and the SDK keeps the chunk and retries. Telemetry pipelines have their own queues and are unaffected |
| Retries to Muninn | Stock exporter behaviour: retry on 429, 502, 503, 504 and network failure with backoff, honouring `Retry-After`, without a time limit. Any other status drops the request and counts it |
| Duplicates | Expected (at-least-once on both hops). Muninn de-duplicates by chunk identity |
| Collector restart | Queued chunks survive on disk and are sent after restart |
| Muninn down | Chunks queue on the Collector's disk until the queue is full, then SDKs get 503 and hold their own persisted chunks (72 h TTL). Other telemetry keeps flowing |

Why stock components: the earlier custom receiver and exporter existed because the payload was a JSON envelope on its own port. With the chunk as an OTLP record, the OTLP receiver, routing connector, transform processor, `otlp_http` exporter and file storage extension already do every step. That removes two custom components, and any OTel Collector, including a customer's own, can feed Muninn. The founder's preference for custom receivers still applies where a vendor wire format has to be accepted ([section 9](#9-later-work-scoped-not-designed)).

Facts checked in the Collector v0.160 source and what still needs a test are in [durable-handoff.md](../../project/kb/muninn/collector-path/durable-handoff.md).

## 4. Muninn ingest API

`POST /otlp/v1/logs`, OTLP/HTTP as specified by OTLP. Details in [the spec, section 4](../specs/muninn.md#4-ingest-api).

- Accepts log records in scope `ouo.replay` with event name `ouo.replay.chunk` or `ouo.replay.ended`. Anything else is rejected through OTLP partial success.
- Validates identity attributes, the SHA-256 and the byte size, and the 1 MiB limit.
- Answers 2xx only after every accepted chunk is stored in the object store.
- Idempotent on `(tenant, project, session.id, ouo.replay.id, ouo.replay.stream.id, ouo.replay.sequence)`. A repeat with the same hash is a success; a repeat with a different hash is rejected and the first write stays.
- Transient storage failure answers 503 for the whole request, so the Collector retries it.
- Muninn treats the body as opaque. It never decodes rrweb, wireframes, JPEG or MP4.

## 5. Storage layout

```text
[<prefix>/]muninn/schema.json
[<prefix>/]muninn/<tenant>/<project>/<session_id>/deleted.json
[<prefix>/]muninn/<tenant>/<project>/<session_id>/<replay_id>/deleted.json
[<prefix>/]muninn/<tenant>/<project>/<session_id>/<replay_id>/<stream_id>/c/<sequence, 10 digits>
[<prefix>/]muninn/<tenant>/<project>/<session_id>/<replay_id>/<stream_id>/ended.json
[<prefix>/]muninn/<tenant>/<project>/<session_id>/<replay_id>/<stream_id>/manifest.json
```

- **Chunk object.** Immutable, written once with a create-only write. It is a container: a short header with the record's attributes as JSON, then the body bytes exactly as the SDK sent them. One write per chunk, and the object describes itself, so no index can drift from the data.
- **`ended.json`.** The `ouo.replay.ended` record of the stream.
- **`manifest.json`.** A cache of the chunk headers of a closed stream. Derived; Muninn can rebuild it from the chunk objects at any time.
- **`deleted.json`.** A tombstone, so a chunk that arrives late from a queue cannot bring a deleted replay back.
- **Structure and pixel chunks** share this layout. They differ only in what the reader does: structure chunks are small, gzip-compressed and concatenated per segment; pixel chunks are stored without a second compression and served with byte ranges.
- **No database and no time partition.** The only lookup Muninn serves is by session, and the key gives it. Searching sessions is Loki's job, through the session events and the reference records.

## 6. Read API

For the BFF only. Browsers and SDKs never reach Muninn. Shapes in [the spec, section 7](../specs/muninn.md#7-read-api).

| Call | Returns |
|---|---|
| `GET /api/v1/projects/{project}/sessions/{session_id}/replays` | The session's replays, with state, time range and sizes |
| `GET .../replays/{replay_id}` | The manifest: streams, their chunks (sequence, segment, keyframe, times, format, encoding, size, hash), missing sequences, state |
| `GET .../replays/{replay_id}/streams/{stream_id}/chunks/{sequence}` | The body as stored, with `Content-Encoding` from the chunk's encoding, an `ETag` from its hash, and byte ranges for uncompressed bodies |
| `DELETE .../sessions/{session_id}/replays`, `DELETE .../replays/{replay_id}` | Deletes and writes a tombstone |

The store computes completeness (SDK spec RPL-22): a stream is `complete` only if its end record says so and every sequence up to `last_sequence` is held; `open` while chunks are still arriving; otherwise `partial`. The player picks a decoder by `ouo.replay.format` and treats an unknown format as stored but not playable (RPL-24). Role-based redaction (Clearance) is applied by the BFF, not by Muninn.

## 7. Retention and tenancy

- **Tenant.** `X-Scope-OrgID` on every request, as in Loki, Tempo and Mimir. With multi-tenancy off, the tenant is `anonymous`. The tenant is the first key segment.
- **Project.** Resource attribute `ouo.project.id`, stamped by the Collector from the authenticated project. Second key segment, and a path parameter on reads.
- **Service tokens.** Optional bearer tokens, one for ingest and one for read and delete, as rum-api has today. Muninn is never exposed to the internet.
- **Retention.** Default 720 h, per project override. A sweeper deletes a whole replay once its newest chunk is older than the retention. On S3, objects also carry a retention tag and a lifecycle rule set two days longer, so data still expires if Muninn is down. Tombstones live 7 days.

## 8. What happens to rum-api

| rum-api duty today | After this ADR |
|---|---|
| Replay sink `POST /v1/replay/chunks` | Frozen at cut-over, removed 30 days later with the `ouoreplay` receiver and exporter |
| Replay reads and the three kind-specific players' endpoints | Serve replays recorded before the cut-over until they expire (30 days). Not migrated |
| Replay retention sweeper, S3 lifecycle rules, schema file | The design moves to Muninn; the Go code in `services/rum-api/internal/replay` (S3 and filesystem stores, conditional writes, sweeper) is the starting point |
| Server-side replay sampling cap | Not carried over. Replay sampling is the SDK's (SMP-8) |
| Sessions, traces per session, funnels, vitals | Move to `ouo-go` in the plugin BFF (Step 9). Not decided here |
| Source maps, dSYMs, symbolication, delete-by-user | Stay in rum-api until Step 9 decides. Delete-by-user will call Muninn's delete |

Muninn is a new Go service, `services/muninn`, its own module, with images and Helm values beside rum-api's.

Cut-over order:

1. Muninn exists and the Collector config gains the routing, the queue and the two replay pipelines. The legacy path keeps working beside it.
2. The web and React Native SDKs emit `ouo.replay.chunk` over OTLP.
3. The Sentry bridge emits the same record instead of the legacy `video` envelope.
4. The plugin reads Muninn through the BFF. Thirty days later the legacy receiver, exporter and rum-api replay code are deleted.

## 9. Later work, scoped not designed

**Vendor envelope receivers.** One custom Collector receiver per vendor wire format: `ouosentry` (exists for mobile), then `ouodatadog` and `ouoposthog`. Each one:

- accepts the vendor SDK's own endpoint paths and auth, so an app changes only its host;
- optionally forwards the request unchanged to the vendor, as the Sentry bridge does;
- translates into OTLP: events and logs to Loki, spans to Tempo, edge-derived metrics to Mimir, and replay into `ouo.replay.chunk` records that enter the same routing connector and reach Muninn through the same queue.

For Muninn nothing changes: a vendor recording is one more value of `ouo.replay.format`, with `ouo.replay.source.vendor` and `ouo.replay.source.id` as extra attributes. Receivers must split vendor segments that exceed 1 MiB and compute the hash. Touches and breadcrumbs that vendors pack inside a recording become ordinary OTel events. Wire formats and fixtures are in [vendor-internals](../../project/kb/vendor-internals/index.md). Each receiver gets its own ADR and spec.

**Vendor API querying lives in the BFF.** Muninn makes no outbound calls and knows no vendor credentials. Reading replays, errors or traces from a vendor's API (for example a customer who keeps Sentry as the store) is a library in `ouo-go`, next to its Loki, Tempo, Mimir, Victoria and Muninn clients. The pull recipe researched in Step 6 ([muninn-sync-recipe.md](../../project/kb/vendor-internals/sentry/read-apis/muninn-sync-recipe.md)) is input for that library, not for Muninn. If pulled data should ever be stored, it goes in through the Collector like everything else.

## 10. Open questions and recommendations

| # | Question | Recommendation |
|---|---|---|
| Q1 | Muninn ingest as an OTLP/HTTP logs endpoint with the stock exporter, or a bespoke REST upload with a custom exporter? | **OTLP endpoint.** Fewer components, standard retry and partial success, works with any Collector. "REST API on Muninn" stays true for reads and deletes |
| Q2 | One SDK endpoint with routing by scope, or a separate replay port or path? | **One endpoint.** The SDK spec already says `/v1/logs`. Isolation comes from the separate pipeline and queue |
| Q3 | Reference records in Loki: one per chunk, one per stream, or none? | **One per chunk**, as D3 states. They are about 0.5 KB, give `has_replay` and coverage to LogQL without a Muninn call, and can be reduced later in Collector config alone. Muninn stays the source of truth; a reference is a hint |
| Q4 | One container object per chunk, a body plus a sidecar, or packing several chunks into blocks? | **One container object per chunk.** One atomic write. Packing is a later cost optimisation behind the same API |
| Q5 | Does Muninn need a database or a time-partitioned index? | **No.** Keys by session cover every read the BFF makes |
| Q6 | Tenant header now, or project only? | **Both now.** One path segment today avoids a data migration when the cloud step arrives |
| Q7 | Retention per chunk or per replay? | **Per replay, from its last chunk**, by sweeper; lifecycle rule as a safety net |
| Q8 | Migrate replays stored by rum-api? | **No.** They expire in 30 days; rum-api serves them until then |
| Q9 | What remains of rum-api? | **Decide in Step 9.** Recommended direction: query logic to `ouo-go`, rum-api shrinks to source maps and symbolication or is absorbed |
| Q10 | Who owns the list of format ids and their media types, and is an rrweb chunk body newline-delimited JSON? | **The SDK spec §11.6 owns the registry**, with a structure or pixel class per id. Muninn stays opaque and takes media types from that table. Recommend newline-delimited events for rrweb, because RPL-7 requires chunk bodies that concatenate |
| Q11 | Validate chunks in the Collector so an SDK sees a rejection? | **No.** Validate in Muninn only; the conformance suite checks SDK output against the same rules |
| Q12 | Collector deployment with a disk queue | **StatefulSet with a volume per replica** in Helm, a named volume in compose. Queue 2 GiB by default |
| Q13 | Sentry bridge video: where do touches go once the body is the MP4? | **Touches become OTel events**, like `ui.tap` already is. The chunk body is the MP4 alone |
| Q14 | Muninn's default port | **3400** |

## 11. Consequences

- The SDK path needs no custom Collector component. `ouoreplayreceiver` and `ouoreplayexporter` are deleted after the cut-over.
- The Collector becomes stateful: it needs a volume. That is new for operators and for the Helm chart.
- Loki receives about 12 small reference records per recording minute per session.
- Small structure chunks become many small objects (about 12 per recording minute). Request cost on S3 is the thing to measure before scale; packing is the answer if it matters.
- Muninn cannot answer "which sessions have a replay" across sessions. That is by design; Loki answers it.
- A chunk rejected by Muninn is not reported back to the SDK, which already got its 2xx from the Collector. Rejections are visible in Muninn's and the Collector's metrics.
