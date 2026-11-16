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

## Review round 1 (2026-11-16)

Reviewer session posted `Review: changes needed` on PR #213. Changes made:

1. With `passthrough_upstream` set, every request the bridge does not serve goes there: paths outside `/api/{id}/{endpoint}/` and a non-POST `/envelope/` included (were `404` / `405`). Tests added to `TestPassthrough`.
2. `upstream: none` projects' other endpoints go to passthrough: kept, documented in spec section 2a and the ADR.
3. The mirror's `dsn` rewrite decodes only the header line (64 KiB bound) and streams the re-encoding (gzip, zlib, raw deflate), so body size no longer matters. `TestRewriteDSNAnySize` covers a body over 20 MiB in all encodings. `Decompress` now shares `newDecoder`.
4. `body_not_rewritten` is a `reason` on the copy's send outcome, so each copy counts once.
5. One guard (`closing` / `closed` on the receiver) for the translate and mirror queues; a late handler drops with `reason="shutdown"` instead of panicking. `TestLateEnqueueAfterShutdown`.
6. Dropped `mirror.queue_size` and `mirror.workers` (now 4 workers, a 10 000 channel cap; `queue_bytes` is the bound). Mirror metrics carry `ouo.project.id`, so two projects mirrored to one host stay separate series.
7. The answer is flushed (`http.ResponseController`) before copies and translation are queued.
8. sentrytap in CI: not done, `.github/` is outside this session's paths; follow-up.

Verified: `go vet`, `gofmt`, `go test -race -count=3` in the receiver; `go vet` + build of sentrytap; lychee offline.
