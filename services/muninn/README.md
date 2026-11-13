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
| `GET /ready`, `GET /healthz` | probes | Store reachable / process up |

Muninn is internal: only the Collector writes to it and only server-side components read it. Writes carry `Authorization: Bearer <ingest token>`, reads `Bearer <read token>`. With `multitenancy_enabled`, `X-Scope-OrgID` names the tenant as in Loki; without it every request is tenant `anonymous`. Chunk bodies are opaque: any format id that matches `[a-z0-9./_-]{1,64}` is stored (`rrweb/2`, `ouo-frames/3`, `ouo-video/1`, `ouo-wireframe/1` and formats not invented yet).

Storage layout under `[<prefix>/]muninn/`: `<tenant>/<project>/<session>/<replay>/<stream>/c/<sequence, 10 digits>` (a container: `OUOC`, version byte, header length, JSON header with every attribute, then the body), `<stream>/ended.json`, `<replay>/deleted.json` (tombstone) and `schema.json`. Every object but `schema.json` is written create-only (S3 `If-None-Match: *`; on disk a synced temp file hard-linked into place), so replicas never overwrite each other. A retention sweeper removes whole replays whose newest object is older than the project's retention and tags S3 objects `ouo-retention=<n>d` as a lifecycle safety net.

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
