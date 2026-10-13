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
