# rum-api

Owns `services/rum-api`: ingest gateway (OTLP routes behind project tokens, ADR-0007), replay
chunk storage (rrweb, frame and video chunks), session folding over Loki, trace search over Tempo,
JSON API for the Grafana plugin.

- [tracker.md](tracker.md)
- `summaries/2026-10-06-phase-3.md` Phase 3 build and verification
- `summaries/2026-10-08-phase-7.md` Phase 7 frame chunks (kind, limits, frames endpoint, replay_kind)
- `summaries/2026-10-10-phase-8a.md` Phase 8a ingest gateway (project tokens, per-project CORS and limits, read token, ingest metrics)
- `summaries/2026-10-10-phase-8a-rev2.md` Phase 8a rev 2: rum-api internal, replay sink for the collector, read token kept
- `summaries/2026-10-14-video-kind.md` Sentry bridge: `kind: "video"` chunks (mp4 segments), manifest and ranged segment endpoints, `MAX_VIDEO_CHUNK_BYTES`
- `summaries/2026-10-16-config-file-s3.md` YAML config file (`-config.file`, `-config.expand-env`, `-config.verify`), S3 / MinIO replay store, compose opt-in MinIO, Helm `rumApi.storage`
- `summaries/2026-10-23-8b-data-lifecycle.md` 8b: retention per signal, replay sweeper and S3 lifecycle rules, delete by user / project with audit log, sampling, masking proof
- `summaries/2026-10-24-web-sourcemaps.md` N36 part C / A10 web: source maps (ADR-0011), upload CLI, symbolication on read, plugin stack view, ouo-web verify
- `summaries/2026-10-24-funnels.md` funnel reports (N46, ADR-0012): `internal/funnel`, `/v1/funnels/{query,dropped,steps}`, plugin Funnels page, live check against generated sessions
- `summaries/2026-11-04-r3-funnel-conditions.md` R3 (JUHI, ADR-0019): funnel step conditions, failed outcome per step, truncated flag, live check
- `scripts/8b-lifecycle-live.mjs` ingest and status script of the 8b live check (`docs/operations/data-lifecycle.md` section 7)
- `scripts/r3-funnel-journeys.mjs` OTLP payment journeys with known outcomes for the R3 live check
