# The MVP replay path and the target

> rum-api, the MVP Grafana plugin (`ouo11y-rum-app`) and the MVP replay path (`ouoreplay` receiver/exporter, :4319) were removed on 2026-11-15 (refactor!: remove rum-api, the MVP plugin and the MVP replay path). Text below that names them is the record of that time.

> What does the replay path look like on `main` today, and how does the target of ADR-0019 differ hop by hop?

**The MVP path is removed, not evolved** (founder, 2026-11-11). The target is a new Collector configuration for the spec wire, with no compatibility with the MVP envelope, its `kind` names, or rum-api. The left column is here only so a reader who knows the MVP can find their bearings.

Read on 2026-11-11 at `origin/main` 27f7101e. Sources: [collector config](../../../../deploy/compose/collector/config.yaml), [collector README](../../../../collector/README.md), rum-api README (removed 2026-11-15), [data-lifecycle.md](../../../../docs/operations/data-lifecycle.md), [SDK spec draft §8 and §11](../../opentelemetry/rum-semantic-conventions/sdk-spec.md).

## Hop by hop

| Hop | MVP, to be removed | Target ([ADR-0019](../../../../docs/adr/0019-collector-to-muninn.md)) |
|---|---|---|
| SDK payload | JSON envelope with `kind` (`rrweb`, `frames`; `video` only from the Sentry bridge), gzip | OTLP log record, event `ouo.replay.chunk`, bytes body, protobuf |
| SDK endpoint | `POST /v1/replay/chunks` on port 4319 | `POST /v1/logs` on the OTLP port 4318, one chunk per request |
| Collector receiver | Custom `ouoreplay` receiver, validates per kind | Stock `otlp` receiver |
| Routing | Own pipeline because own receiver; Sentry bridge chunks through a routing connector on an attribute | Routing connector on scope name `ouo.replay` |
| Collector queue | In memory, 1000 requests, retries for 5 minutes | On disk with fsync, bounded in bytes, retries without a time limit |
| What 2xx to the SDK means | Handed to an in-memory queue. Lost on a Collector restart | Written to the disk queue |
| Exporter | Custom `ouoreplay` exporter, posts the JSON to rum-api with `X-Ouo-Project-Id` and a bearer | Stock `otlp_http` exporter to Muninn `/otlp/v1/logs` |
| Store | rum-api: `replays/<session>/<seq>.json.gz` (+ `<seq>.mp4`), `meta.json` rewritten per chunk with a conditional PUT | Muninn: one create-only container object per chunk under `muninn/<tenant>/<project>/<session>/<replay>/<stream>/c/`, no manifest object |
| Identity | `(session, seq)`, one replay of one kind per session | `(tenant, project, session, replay, stream, sequence)`; several replays, streams and formats per session |
| Server-side validation | Decodes the payload per kind | Opaque body: ids, hash, size |
| Log store | Nothing about replay | One reference record per chunk, no body |
| Read | `GET /v1/sessions/{id}/replay`, `/replay/events`, `/replay/frames`, `/replay/video[/{seq}]`, each for one kind, assembled by rum-api | `GET .../replays`, `.../replays/{id}` (manifest), `.../chunks/{sequence}` (bytes). The player assembles |
| Reader | Grafana plugin proxy with a read token | Plugin BFF (`ouo-go`) |
| Retention | Sweeper from `meta.json` `updated_at`, S3 lifecycle tags | Sweeper from the newest object found by listing keys, lifecycle tags as a safety net, plus tombstones |

## Ideas worth reusing from rum-api

No code or interface is kept for compatibility. These parts solved problems Muninn also has and can serve as reference:

- The S3 and filesystem stores and their tests against real MinIO (`services/rum-api/internal/replay/s3*.go`, `fs.go`), described in [rum-api-config-s3.md](../../../kb-archive/rum-api-config-s3.md). The conditional `meta.json` write is no longer needed, since chunk objects are create-only.
- The sweeper and lifecycle-rule ownership (`lifecycle.go`).
- The store schema file and the refuse-to-start rule (`schema.go`).
- The YAML config style with environment expansion.

## What is dropped

- The JSON envelope, `kind`, port 4319 and the `ouoreplay` receiver and exporter.
- Per-kind parsing (`parse.go`) and the three read shapes. Muninn does not decode.
- Replays the MVP stored. They are not migrated and Muninn does not read them.
- The server-side replay sampling cap.
- `X-Ouo-Session-Id` and `X-Ouo-Seq` headers. The record's attributes are the only source.

## Things in the SDK spec that this design relies on

| Rule | Why Muninn needs it |
|---|---|
| RPL-4: a retransmission reuses the same sequence and the same bytes | Makes "same identity, same hash" a safe no-op |
| RPL-12: `ouo.replay.sha256` over the bytes as sent | The integrity and de-duplication check |
| RPL-7: each chunk body decompresses alone | The player can fetch chunks in parallel and Muninn never has to join them |
| TRN-5: one chunk per request | A failed request maps to exactly one chunk |
| RPL-22: the store computes completeness | The `state` and `missing` fields of the manifest |
