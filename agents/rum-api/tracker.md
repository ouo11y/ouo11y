# rum-api tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-06 | Phase 3: services/rum-api (replay store, Loki folding, Tempo search, JSON API, OTel, Dockerfile, compose) | done, verified end to end (see summaries/2026-10-06-phase-3.md) |
| 2026-10-06 | kb/loki-session-queries.md, kb/tempo-session-search.md | done |
| 2026-10-08 | Phase 7: `kind: frames` chunks (8 MiB), meta `kind` + viewport/platform/counts, `GET .../replay/frames`, 409 kind matrix, `replay_kind` on session records | done, unit + curl verified (see summaries/2026-10-08-phase-7.md) |
| 2026-10-10 | Phase 8a: ADR-0007 ingest gateway: `internal/project` (YAML / env registry, origin patterns), `internal/ingest` (`POST /ingest/otlp/v1/{traces,logs,metrics}`, check order 413/401/403/429/400/502, token buckets, `ouo.project.id` stamping, protobuf forward, `ouo.ingest.*` / `ouo.replay.*` metrics), token + origin + rate on `POST /v1/replay/chunks` with `project_id` in `meta.json`, per-project CORS, `OUO_READ_TOKEN` on `GET`/`DELETE /v1/*`, README | done, unit + live verified against the running stack (see summaries/2026-10-10-phase-8a.md) |
| open | S3 ReplayStore, Tempo result paging beyond 1000, read-side project scoping, shared rate limit state across replicas | post-MVP |
