# 2026-11-15 Sentry bridge: production readiness, mirrors, passthrough

Session sentry-mirror (sentry-demo), started from the orchestrating session for the pilot app's production DSN switch. Branch `claude/eager-mcnulty-ac5ad3`.

## Done

- **Audit** of `collector/receiver/ouosentryreceiver` for a production DSN: 17 risks with evidence in [the report](../reports/sentry-mirror-readiness.html), kb [cutover-risks.md](../../../kb/sentry-bridge/production/cutover-risks.md).
- **Mirrors** (ADR-0028, spec 2b): per-project `mirrors` with optional `sentry_project_id` / `public_key` rewrite (path, `X-Sentry-Auth`, `Authorization`, query, envelope `dsn`); bounded per-mirror queues plus a shared byte budget, own client, timeout, workers; metrics `ouo_sentry_mirror_requests_total`, `ouo_sentry_mirror_duration_seconds`, `ouo_sentry_queue_bytes`. Code: `mirror.go`.
- **Passthrough** (spec 2a): `passthrough_upstream` forwards unmatched requests instead of 403/404; other ingest endpoints (`store`, `minidump`, `security` …) forwarded to the project's upstream.
- **Hardening**: translate queue bounded in bytes (`translate_queue_bytes`), translator panic recovered (`reason="panic"`).
- `sentrytap replay` (latency percentiles, concurrency, rate) and `sentrytap -sink -delay`.
- Spec, deployment guide (production cut-over section with an nginx fallback), ADR-0028, kb area `sentry-bridge/`.

## Verified, and how

- `go test -race ./...` and `go vet` in the receiver; new tests in `mirror_test.go` (failure injection: hanging / 500 / 429 mirrors, byte budget, primary down, rewrite, passthrough, panic), run 5× with `-race`.
- End to end on env `eager-mcnulty-ac5ad3` (collector built from the branch, demo config swapped in with a compose override) with self-hosted Sentry 26.10 as production and project 9 (`pilot-preview`, created for this) as the mirror: sentrytap compare 49/49 and 40/40 byte-identical; preview stored the same 20 errors; Loki 20 exceptions, Tempo 20 traces. Latency, burst, soak, mirror kill, collector restart: numbers in the report and [measured-overhead.md](../../../kb/sentry-bridge/production/measured-overhead.md).
- Relay answers `400 project id header mismatch` for a mismatched envelope `dsn` (checked on the sandbox), which is why the mirror rewrites it.

## Not done / next

- No second self-hosted Sentry: the preview is a second project on the same instance (the Mac was swapping; another install needs 14 GB). A different Sentry version as mirror is untested.
- No real quota 429 from production; Android SDKs untested (as before).
- Residual: the pending-log ticker goroutine has no `recover`; concurrent request bodies are not bounded in bytes.
- Bridged video replay to Muninn is not wired (sibling session's finding), separate receiver task.

## For the next agent

- Before switching a production DSN: merge, deploy an image with this change, set `passthrough_upstream`, put the fallback proxy in front (deployment guide), check one event's IP in Sentry.
- `sentry-sbx` was started by this session and left as found (stopped) at the end; project `pilot-preview` (id 9) stays in it.
- No dependency was added to the repo. `sentry-go` was used only in a scratch module outside the repo.
