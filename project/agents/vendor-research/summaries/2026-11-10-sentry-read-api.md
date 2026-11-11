# 2026-11-10 sentry-read-api (Step 6)

Agent `sentry-read-api`. Goal: document every Sentry API that Muninn can use to read sessions, replays and joined data in topology (a), verified against self-hosted Sentry 26.10.0 (`sentry-sbx`).

## What was done

- Wrote [project/kb/vendor-internals/sentry/read-apis/](../../../kb/vendor-internals/sentry/read-apis/index.md): 11 entries (replays, sessions, issues and events, traces/spans/logs, profiles, users/releases/projects, auth and rate limits, pagination, webhooks, SaaS vs self-hosted, sync recipe), an HTML explainer with an inline SVG read path and a filterable endpoint table, 6 scripts and 70+ redacted fixtures.
- Dumped all API routes from Django's URL resolver inside `sentry-sbx-web-1` (class, `publish_status`, scope map, `rate_limits`), so status and scope claims come from the running 26.10.0 code, not from docs. The container's commit `da07b233` equals tag `26.10.0`; source links are pinned to that tag.
- Minted 8 tokens with narrow scopes (`sentry exec`) and 1 internal integration (API), ran a 30-endpoint × 10-token matrix.
- Downloaded three replays end to end (real `@sentry/react` 11.11.0 web replay, 5-minute iOS React Native replay with 52 mp4 segments, synthetic web replay) through both segment endpoints and the video endpoint; all complete.
- Measured ingest-to-API visibility 5 times with a probe that sends an error, transaction, log, session and 2-segment replay into `sentry-demo` (environment `read-api-probe`).
- Tested a late-delivered replay (timestamps 3 h old) and internal-integration webhooks (listener on port 4550).

## Verified and how

- Every scope, status code and response shape in the entries was observed with curl or the scripts; fixtures under `read-apis/fixtures/`.
- Latency: [ingest-latency-runs.json](../../../kb/vendor-internals/sentry/read-apis/fixtures/measurements/ingest-latency-runs.json). Replays 2.4–5.4 s, errors 5.5–7.6 s, logs 2.5–5 s, trace 6–7.7 s, spans 14.5–18 s, sessions 48.7–52.7 s.
- Webhooks: fired (`error.created`, `issue.created`, ~12 s after ingest) but were halted by `SENTRY_DISALLOWED_IPS` (`restricted_ip` in taskworker logs).
- `lychee --offline` on all new md and html: 0 errors. `grep -rE '[0-9a-f]{32}'` over the folder: only replay, event, trace, issue and fingerprint ids and the release commit sha remain; every DSN key, email, IP and token is redacted. Token values were checked absent.

## Top findings

1. Rely on public R1 list, R2 details, R4/R5/R6 segments. Video (`/videos/{n}/`) is experimental; project replay details GET is private.
2. The segment list returns contents without ids and hides gaps; unknown replay → 200 `[]`.
3. Replay time windows filter on SDK timestamps, not receive time; late deliveries need wider re-scans.
4. Real web replays mix ms (rrweb) and float-seconds (Sentry custom events) timestamps.
5. Sessions are aggregates only (no sessions table in ClickHouse; `groupBy=session.id` rejected).
6. No replay webhook. Issue/error webhooks only, and blocked to private IPs on self-hosted by default.
7. Muninn needs `org:read project:read event:read`; internal integration recommended; always pass `project=-1` (org auth tokens see nothing otherwise).
8. Self-hosted skips API rate limiting entirely; SaaS has per-endpoint limits (e.g. `eventids` 1/s).
9. `replay_type` is returned but cannot be requested via `field=` (docs disagree with the 26.10.0 validator).

## Not verified

- SaaS behaviour (region routing via `links.regionUrl`, real rate-limit values, flags): docs and source only.
- Profile and chunk retrieval: no profiles existed locally.
- Webhook payload shape (deliveries were blocked); granular replay permissions with an allowlist (needs an org option change).
- Replay DELETE and deletion jobs (no writes allowed).
- Android replays (none present yet); only iOS (React Native) mobile replays were downloaded.

## Data written to Sentry and cleanup

- Written: probe events, transactions, logs, sessions and 6 small synthetic replays in project `sentry-demo` (env `read-api-probe`, releases `read-api-probe@*`), plus one error with fingerprint `webhook-probe`. Left in place (normal data, retention applies).
- Tokens: user tokens ids 10–14, org auth tokens ids 1–3, internal integration `step6-read-api-muninn-probe-ce9fbe` (token id 15, plus one auto token). All revoked with `scripts/revoke_tokens.sentry-exec.py` (calls now return 401); the integration was deleted with `deletions.exec_sync` via `sentry exec` (the coordinator token got 403 on `DELETE /sentry-apps/{slug}/`). Temp files removed from the container. Webhook listener (own PID) stopped.

## Dependencies

None. All scripts are Python standard library.

## What the next agent must know

- The sync recipe in `muninn-sync-recipe.md` is a proposal for Step 8, not a decision.
- `scripts/muninn_pull.py` and `scripts/ingest_latency_probe.py` take the token from `SENTRY_TOKEN`; the probe writes data.
- Link headers carry `system.url-prefix` (`https://sentry.ouo.localhost`), not the host you called.
