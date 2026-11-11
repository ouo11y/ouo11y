# 2026-11-11 Collector to Muninn design

## Done

- [ADR-0019](../../../../docs/adr/0019-collector-to-muninn.md) (proposed): how `ouo.replay.chunk` travels, Muninn's ingest API, storage layout, read API, retention and tenancy, what happens to rum-api, later work, and 15 open questions each with a recommendation.
- [docs/specs/muninn.md](../../../../docs/specs/muninn.md) (draft): the contract for SDK authors, the Collector and the BFF, with requirement ids `MUN-`, `COL-`, `RDR-` and a conformance table.
- [project/kb/muninn/collector-path/](../../../kb/muninn/collector-path/index.md): the explainer with the architecture diagram, the today-versus-target table, and the durable hand-off notes.
- One-line pointer in the Step 6 Sentry pull recipe saying the recipe now feeds the BFF library, not Muninn.
- Index rows: `docs/adr/README.md`, `docs/index.md`, `project/kb/index.md`, `project/agents/index.md`.

## The design in brief

- A chunk is an OTLP log record sent to the Collector's normal `/v1/logs`. A routing connector splits scope `ouo.replay` into a pipeline with no batch processor and a disk queue with fsync, so the SDK's 2xx means "on disk".
- The stock `otlp_http` exporter sends to Muninn's `POST /otlp/v1/logs`. No custom Collector component on this path.
- It is a new Collector configuration for the spec wire only. The MVP replay receiver, exporter, envelope names and rum-api's replay store are removed, with no compatibility and no migration (founder, 2026-11-11).
- Loki gets a copy of each chunk record without the body and with `ouo.replay.ref`.
- Muninn stores one create-only container object per chunk in object storage, keyed by tenant, project, session, replay, stream and sequence. No database and no stored manifest. Bodies are opaque, so structure and pixel chunks are stored the same way.
- The BFF reads through three calls: list a session's replays, get a manifest, get a chunk.

## Review

A fresh-context reviewer agent (the app refused to start a separate session from this turn) read the pull request against the repo and the Collector source and answered `Review: changes needed`. All findings were applied:

- `set(log.body, nil)` is a no-op in OTTL v0.160, so the sketch would have sent chunk bodies to Loki. Now `set(log.body, "")`, with `error_mode: propagate`.
- Muninn is stricter than the SDK spec draft on four points; they are now listed in the spec (section 3.3) as requirements on the SDK spec, and as Q15.
- The stored manifest was not safe with several replicas. It is dropped; every object is create-only, including the end record.
- Tombstones: the sweeper deletes again before removing one; no session-level tombstone; the remaining windows are written down.
- Muninn answers 503 for every failure of its own, because the exporter drops on any other status.
- The sweeper's method and cost, the one-tenant-per-Collector limit, the nature of the Loki references, and the read API's status codes and edge cases are now stated.
- Byte ranges, conditional requests, manifest time windows, OTLP/JSON ingest and Muninn-side rate limits are left out of the first version.

## Verified, and how

- Collector behaviour that the design depends on was read in the v0.160.0 source in the Go module cache: receiver error to HTTP status mapping, sending queue settings, the persistent queue's synchronous write, the `otlp_http` exporter's retryable statuses and partial-success handling. Listed in [durable-handoff.md](../../../kb/muninn/collector-path/durable-handoff.md).
- The explainer was opened in a browser and the diagram checked by eye.
- `lychee --offline` on the changed files.

## Not verified

- Nothing was run against a Collector. The file storage extension's `fsync` setting (its module is not in the local cache) and the cost of about three synced writes per chunk are open, with a test for each in `durable-handoff.md`. Routing on scope name, error propagation and the full-queue answer were settled from source by the reviewer but not run.
- S3 request cost for many small objects is not measured.

## What the next session must know

- The ADR is **proposed** and the pull request is **not merged**: the founder is the only one who merges. Do not build on it before the founder answers Q1 to Q15.
- ADR number 0018 belongs to the open pull request 178. If that pull request merges first, `docs/adr/README.md`, `project/kb/index.md` and `project/agents/index.md` need a trivial merge.
- The SDK spec is still the draft in `project/kb/opentelemetry/rum-semantic-conventions/sdk-spec.md`. The Muninn spec cites its `RPL-` and `TRN-` ids; if the spec moves to `docs/specs/`, update the links.
- The format registry (which `ouo.replay.format` ids exist, their class and media type) is not in any spec yet. Muninn does not need it to store, only to set `Content-Type`.
- No dependency was added. No env was started.
