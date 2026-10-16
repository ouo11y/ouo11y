# rum-api

Owns `services/rum-api`: ingest gateway (OTLP routes behind project tokens, ADR-0007), replay
chunk storage (rrweb and frame chunks), session folding over Loki, trace search over Tempo,
JSON API for the Grafana plugin.

- [tracker.md](tracker.md)
- `summaries/2026-10-06-phase-3.md` Phase 3 build and verification
- `summaries/2026-10-08-phase-7.md` Phase 7 frame chunks (kind, limits, frames endpoint, replay_kind)
- `summaries/2026-10-10-phase-8a.md` Phase 8a ingest gateway (project tokens, per-project CORS and limits, read token, ingest metrics)
