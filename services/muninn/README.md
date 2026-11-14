# Muninn

ouo's replay store. The OTel Collector sends it replay chunk records over OTLP/HTTP; it keeps one immutable object per chunk in S3-compatible storage (or a directory) and serves them to the plugin's back end. No database, no stored index: keys are laid out by tenant, project, session and replay, and a replay's manifest is computed from one listing.

Design: [ADR-0019](../../docs/adr/0019-collector-to-muninn.md) "Collector to Muninn" (proposed) and the spec [docs/specs/muninn.md](../../docs/specs/muninn.md) (draft). This module implements that draft spec on the recommended answers to its open questions Q1 to Q15; the summary [2026-11-13-muninn-build.md](../../project/agents/muninn-build/summaries/2026-11-13-muninn-build.md) lists where the code depends on each one.

## What it serves

| Route | Who calls it | What |
|---|---|---|
| `POST /otlp/v1/logs` | the Collector's stock `otlp_http` exporter | OTLP/HTTP protobuf (`gzip` or none). Records in scope `ouo.replay`, events `ouo.replay.chunk` and `ouo.replay.ended`. Invalid records are rejected one by one through OTLP partial success; every failure of Muninn's own is a 503 so the Collector retries |
| `GET /api/v1/projects/{p}/sessions/{s}/replays` | the BFF | The session's replays with state, time range, size, formats |
| `GET .../replays/{r}` | the BFF | The manifest: streams, chunks in sequence order, missing ranges, `open` / `complete` / `partial` |
| `GET .../replays/{r}/streams/{st}/chunks/{seq}` | the BFF | The chunk body exactly as the SDK sent it, `Content-Encoding: gzip` when it is gzip (never decompressed), `ETag` = its SHA-256 |
| `DELETE .../replays/{r}`, `DELETE .../sessions/{s}/replays` | the BFF, operators | Tombstone, then remove; a late chunk for a deleted replay is accepted and not stored |
| `DELETE /api/v1/projects/{p}` | `ouo-erase project` | Admin token only. Every replay of the project (tombstoned) and every debug file; answers the live replays and the files it removed (MUN-45) |
| `PUT /api/v1/projects/{p}/debug-files/{kind}/{id}` | the client's CI (`ouo-sourcemaps upload`, `upload-dsym`) | **The one public route.** A source map, dSYM slice or R8 mapping, checked with the project's upload token; write-once by content: 201 stored, 200 same content again (restarts its retention), 409 other content; at most 4 uploads at once, then 503 with `Retry-After` (spec section 13, ADR-0026) |
| `GET .../debug-files/{kind}/{id}`, `.../meta`, `GET .../debug-files/{kind}[?release=&file=]` | `ouo-go/symbolicate` | The file, its meta, the debug ids uploaded for a release and script path |
| `PUT /api/v1/audit/{entry}/{status}`, `GET /api/v1/audit` | `ouo-erase` | Admin token only. Create-only erasure audit records, never deleted (section 14) |
| `GET /ready`, `GET /healthz` | probes | Store reachable / process up |

Muninn is internal except for the debug-file upload route, which a reverse proxy publishes alone so a client's CI can reach it; an upload token opens that route and nothing else. Otherwise only the Collector writes to it and only server-side components read it. Writes carry `Authorization: Bearer <ingest token>`, reads `Bearer <read token>`. The admin token (`auth.admin_token`, held by the operator's `ouo-erase`, never by a plugin backend) opens every `/api/v1` route and is the only one that deletes a project or touches the audit entries; without it those routes answer 401. With `multitenancy_enabled`, `X-Scope-OrgID` names the tenant as in Loki; without it every request is tenant `anonymous`. Chunk bodies are opaque: any format id that matches `[a-z0-9./_-]{1,64}` is stored (`rrweb/2`, `ouo-frames/3`, `ouo-video/1`, `ouo-wireframe/1` and formats not invented yet).

Storage layout under `[<prefix>/]muninn/`: `<tenant>/<project>/<session>/<replay>/<stream>/c/<sequence, 10 digits>` (a container: `OUOC`, version byte, header length, JSON header with every attribute, then the body), `<stream>/ended.json`, `<replay>/deleted.json` (tombstone) and `schema.json`. Every object but `schema.json` is written create-only (S3 `If-None-Match: *`; on disk a synced temp file hard-linked into place), so replicas never overwrite each other. Debug files live under `[<prefix>/]debug-files/<tenant>/<project>/<kind>/<debug id>` (gzip, plus `.json` meta, empty release pointers and, after a re-upload, a `.seen` time) and audit records under `[<prefix>/]audit/<tenant>/<entry>/<status>.json`. A retention sweeper removes debug files a year after their last upload by default, and whole replays whose newest object is older than the project's retention and tags S3 objects `ouo-retention=<n>d` as a lifecycle safety net.

## Run

```bash
go run . -config.file=config.example.yaml -config.expand-env=true
```

Every key and its default is in [config.example.yaml](config.example.yaml). In the local stack it runs from `deploy/compose/compose.muninn.yaml` on MinIO, next to a Collector on `deploy/compose/collector/config.muninn.yaml`:

```bash
deploy/envs/ouo-env up <env> --muninn
```

Its own traces, logs and metrics (`muninn.ingest.records`, `muninn.ingest.bytes`, `muninn.ingest.request.duration`, `muninn.read.requests`, `muninn.read.bytes`, `muninn.store.operation.duration`, `muninn.sweeper.deleted`) go to the Collector over OTLP (`OTEL_EXPORTER_OTLP_*`), like every platform service. Deletes are logged there too.

## Test

```bash
go vet ./... && go test ./...
```

The store tests also run against MinIO when `OUO_TEST_S3_ENDPOINT`, `OUO_TEST_S3_BUCKET`, `OUO_TEST_S3_ACCESS_KEY` and `OUO_TEST_S3_SECRET_KEY` are set. The end-to-end check with a real browser and the Collector is [tests/e2e/muninn/run.mjs](../../tests/e2e/muninn/run.mjs).

Reading chunks over HTTP: send `Accept-Encoding: gzip`. A Go client or proxy whose transport adds that header itself also gunzips the body and drops `Content-Encoding`, and then the SHA-256 no longer matches ([kb](../../project/kb/muninn/implementation/gzip-on-the-read-path.md)).
