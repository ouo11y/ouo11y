# ADR-0001 MVP architecture

Status: accepted (2026-10-06)

## Context

The MVP must show session health, session to trace correlation and web session replay for a React web app and a React Native app, using OpenTelemetry and the LGTM stack, with a unified Grafana experience. The full vision (`docs/VISION.md`) includes ClickHouse, PostgreSQL and a standalone UI; none of that is needed to answer the MVP questions.

## Decision

```
web app ──(OTLP/HTTP + traceparent + baggage)──┐
mobile app ─────────────────────────────────────┼──▶ OTel Collector ──▶ Tempo (traces)
backend (Go) ───────────────────────────────────┘        │             Loki  (logs / events)
                                                         └───────────▶ Mimir (metrics)
web app ──(rrweb chunks)──▶ rum-api ──▶ filesystem (deploy/data/replays)
Grafana app plugin ──▶ rum-api ──▶ Loki (session events) + Tempo (trace search) + replay store
```

- **Telemetry path**: SDKs send OTLP/HTTP straight to an OpenTelemetry Collector (contrib) with the OTLP receiver's CORS enabled. The Collector is the only ingress for telemetry. Exporters: `otlp` to Tempo, `otlphttp` to Loki's native OTLP endpoint, `otlphttp` to Mimir's OTLP endpoint.
- **Session events** are OTel log records with `event.name` (see `docs/specs/session-lifecycle.md`). Loki stores them with `service_name`, `event_name` and `ouo_platform` as labels; everything else is structured metadata.
- **rum-api** (Go) owns everything LGTM cannot do alone: replay chunk ingestion and storage, folding Loki session events into session records with status, counting traces per session through Tempo's search API (`{ span.session.id = "<id>" }`), and serving a JSON API. Storage for replay is the local filesystem in the MVP; the store is behind an interface so S3 can follow.
- **Grafana app plugin** (`plugins/ouo11y-rum-app`) is the only UI. It proxies to rum-api through a plugin route. Pages: Overview (health percentages by platform and version), Sessions (list, filters), Session detail (timeline, traces with Tempo deep links, rrweb player). Grafana runs with unsigned plugins allowed for local use.
- **Correlation**: SDKs put `session.id` and `user.id` on every span (SpanProcessor) and log record, and propagate `session.id` in W3C Baggage so the backend can copy it onto its own spans via a baggage span processor. Trace search by `session.id` therefore matches at any span.
- **No ClickHouse, PostgreSQL, S3, Kafka or standalone UI** in the MVP.

## Consequences

- Session aggregation is computed at query time from Loki. That is fine at demo scale and is explicitly replaced by an analytical store after the MVP (vision §18).
- Loki label cardinality is kept low by never putting `session.id` in a label.
- Grafana is a hard dependency of the MVP UI; the vision's standalone UI comes later.
- Mobile has no replay (rrweb is DOM-only).
