# Replay sink contract: why the ingest gateway moved to the collector

Question: what does rum-api accept on `POST /v1/replay/chunks` now that it is internal, and
why did the Phase 8a gateway leave rum-api? Written while revising ADR-0007 in
`services/rum-api` (Phase 8a, revision 2). Package docs: `services/rum-api/README.md`.

## Why the gateway moved

The first 8a draft made rum-api the internet-facing edge: `/ingest/otlp/v1/*` with a project
token header, a YAML project registry, per-project CORS and origin patterns, a token-bucket
rate limiter, OTLP decode / stamp / re-encode and a forward to the collector. It worked
(see the first summary in `project/agents/rum-api/summaries/2026-10-10-phase-8a.md`) but it put a
second ingress next to the standard one, and it meant re-implementing in Go what the
OpenTelemetry Collector already has: receivers with auth, CORS, body limits, batching and
back-pressure. The founder's review restated the principle: the collector is the only
ingress, every other service is hidden. The revised `docs/adr-archive/0007-ingest-gateway-project-tokens.md`
moves project tokens (`basicauth`), stamping (`resource` processor), limits (`ouoratelimit`)
and the replay receiver into a custom `ouo-collector` distribution; rum-api drops all of it
and keeps one write endpoint for the collector's `ouoreplay` exporter.

Lessons that survive from the deleted code, for whoever writes the collector components:

- OTLP/JSON encodes `traceId` / `spanId` as hex, protojson decodes `bytes` as base64; a
  32-char hex id is also valid base64 and silently becomes 24 wrong bytes. The upstream OTLP
  receiver handles this; a hand-written decoder must rewrite ids first.
- A size check must bound both the wire bytes and the decompressed bytes or a 4 MiB limit
  admits a gzip bomb. `confighttp`'s `max_request_body_size` applies to the wire size; the
  replay receiver must still bound the inflated chunk.
- Check order matters for the response code: size before auth (413 before 401), auth before
  anything that reveals validation detail.

## The sink contract (rum-api side)

`POST /v1/replay/chunks`, called only by the collector's `ouoreplay` exporter.

| Check (in order) | Status |
|---|---|
| `Content-Length` above `MAX_FRAME_CHUNK_BYTES` (8 MiB) | 413 |
| `Authorization: Bearer <OUO_INGEST_TOKEN>` missing or wrong, when the variable is set | 401 + `WWW-Authenticate: Bearer` |
| `X-Ouo-Project-Id` missing or not matching `^[a-z0-9][a-z0-9._-]{0,63}$` (trimmed) | 400 |
| body read (wire or decompressed above the limit) | 413 |
| `Content-Encoding` other than `gzip`, `x-gzip`, `identity`, empty | 415 |
| bad gzip, invalid chunk envelope | 400 |
| rrweb chunk above `MAX_CHUNK_BYTES` (4 MiB) | 413 |
| chunk kind differs from the session's replay | 409 |
| project id differs from the session's recorded `project_id` | 403 |
| stored | 202 `{"accepted":true,"project_id":...,"session_id":...,"kind":...,"seq":...,...}` |

`X-Ouo-Session-Id` and `X-Ouo-Seq` are informational: the body wins, a mismatch is a
warning in rum-api's log. The project id goes into `meta.json` as `project_id`; replays
written before 8a have none, read fine, and adopt the first project that writes to them.
Metrics `ouo.replay.chunks` and `ouo.replay.bytes` carry `ouo.project.id`.

Design notes:

- The ingest token is a shared secret between two internal services, so a plain bearer is
  enough; it is optional for installs where the network already isolates rum-api (Compose
  without a published port, a ClusterIP Service with a NetworkPolicy).
- rum-api trusts the project id it is given. Authentication happened at the collector; the
  sink only validates the shape so the value is safe in `meta.json` and as a metric
  attribute.
- Bearer before project id: an unauthenticated caller learns nothing about header
  validation. 413 on `Content-Length` comes first because it costs nothing and the body is
  never read.
- The 403 on a project mismatch is kept from the first draft: it stops a session id
  collision across projects from mixing two customers' chunks in one directory.

## Read side and CORS

- `GET` / `DELETE /v1/*` need `Authorization: Bearer <OUO_READ_TOKEN>` when set
  (`crypto/subtle.ConstantTimeCompare`, case-insensitive scheme). Grafana's plugin proxy
  injects it from `secureJsonData.readToken`; the browser never sees it.
- CORS is back to the pre-gateway rule: reflect `http://localhost:*`, `http://127.0.0.1:*`
  and `CORS_ALLOWED_ORIGINS` (exact), otherwise no CORS headers. `Authorization` is in the
  allowed headers so local tooling can send the read token from a browser page. Per-project
  origin allowlists are a collector concern (global CORS on both receivers in 8a).

## Verified

- `go vet ./... && go test ./...` in `services/rum-api`: `TestReplaySink` (400 cases,
  `project_id` in response / meta / `meta.json`, 403 cross-project, legacy adoption,
  `ouo.replay.*` series through a `ManualReader`, no `ouo.ingest.*` left),
  `TestReplaySinkIngestToken` (401 / 401 / 401 / 400 / 202), `TestReadToken`,
  `TestCORSReflect`, plus the existing replay and session tests.
- Live binary on `127.0.0.1:18089` with `OUO_INGEST_TOKEN` and `OUO_READ_TOKEN` set and no
  project configuration: 401 -> 400 -> 400 -> 202 (gzip, `project_id: demo` in the ack and in
  `meta.json`), read 401 / 200, localhost preflight 204 with `Authorization` allowed, foreign
  preflight and `POST /ingest/otlp/v1/traces` both 404.
