# ADR-0028 Sentry bridge: mirror upstreams and a passthrough upstream

Status: **proposed** (2026-11-15). Amends [ADR-0008](../adr-archive/0008-sentry-sdk-bridge.md) (one upstream per project, unknown keys rejected). Spec: [sentry-bridge.md](../specs/sentry-bridge.md) sections 2a and 2b.

## 1. Context

A pilot app is about to point its production Sentry DSN host at the bridge. Two needs came with it:

1. A second Sentry (a newly deployed self-hosted "Sentry preview") must get the same traffic as production, so both can be compared on real data, while production stays exactly as it is.
2. A project table row that is missing or wrong must not cost production events. Today an unknown `(project, key)` pair is answered `403` and not forwarded; Sentry SDKs delete an envelope on a `4xx` other than `429`, so a typo, a rotated key or a second app on the same host loses data in production, silently from the SDK's side.

## 2. Decision

**Mirrors.** A project row may list `mirrors`. Each envelope the bridge answered (any status from the primary, or `upstream: none`) is queued for each mirror; the primary's answer is the only one the SDK sees, and it is written and flushed to the SDK before the copy is queued. Mirrors get the same method, body bytes and end-to-end headers (with the same `X-Forwarded-For`), through queues bounded by the bytes of all mirrors together, their own HTTP client and connection pool, their own timeout and a fixed number of workers. A copy that does not fit is dropped and counted; a failed send is counted and never retried. When the primary is unreachable the SDK connection is aborted as before and no copy is queued: the SDK retries, and the mirror gets the retry.

A mirror may set `sentry_project_id` and `public_key` because the preview Sentry has its own ids. Then exactly these are rewritten in the copy: the project id in the path, `sentry_key` in `X-Sentry-Auth`, `Authorization` and the query string (`sentry_secret` is dropped), and the `dsn` of the envelope header when there is one (only the header line is decoded to look; gzip and deflate bodies are re-encoded as a stream). Nothing else changes; a body without `dsn` (every mobile SDK observed) stays byte-identical.

**Passthrough.** A global `passthrough_upstream` (production Sentry) receives, unchanged and untranslated, every request the bridge does not serve itself: unknown or missing key, unknown project, other ingest endpoints (`store`, `minidump`, `security`, ...) of unknown or `upstream: none` projects, other paths, and a non-`POST` envelope request. Without it the bridge keeps answering `403` / `404` / `405`. Other ingest endpoints of a project with an upstream go to that upstream; only `envelope` is translated and mirrored.

## 3. Why

- Fan-out in the bridge keeps the SDK and the app unchanged: one DSN, one request per envelope from the phone. A second SDK client or a `tunnel` would change the app.
- Asynchronous copies with bounded queues are the only way to give the mirror the traffic without giving it any say over the primary's latency, answer or memory.
- Passthrough to a single configured upstream is not an open proxy: the target is fixed by the operator and authenticates the request itself. What it buys is that the bridge can never be the reason production loses an event.

## 4. Consequences

- Mirrors see what production answered, not what production stored (a `429` at production is still mirrored; the mirror has its own quotas).
- A mirror is best effort by design. `ouo_sentry_mirror_requests_total{mirror,outcome,reason,status_code}` and `ouo_sentry_queue_bytes{queue}` show how complete it is.
- Translation keeps its own bounded queue, now also bounded in bytes (`translate_queue_bytes`), so a burst cannot grow the process until it is killed, which would stop production forwarding.
- A translator panic drops that envelope (counted `panic`) instead of the process.

## 5. Rejected

- **Mirror from the SDK (two DSNs, `beforeSend` duplication)**: changes the app, doubles the phone's network cost.
- **Synchronous fan-out, answer when both replied**: the preview's latency and failures would reach production.
- **Mirror through an OTel exporter**: the Sentry wire format is not OTLP; the mirror must get Sentry's own bytes.
