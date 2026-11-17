# 2026-11-17 Hybrid Sentry fan-out: nginx mirror to the bridge

Session sentry-hybrid (sentry-demo), started from the orchestrating session. Branch `claude/sentry-hybrid-eval`, cut from PR #213's branch with PR #214's merged in locally (neither merged yet).

## Done

- Evaluated the hybrid: production ingest nginx keeps `proxy_pass` to production Sentry and adds one `mirror` of `/api/{id}/envelope/` to a bridge with `upstream: none`, which mirrors to a Preview Sentry and translates. [Report](../reports/sentry-hybrid-mirror.html), kb [hybrid-nginx-mirror.md](../../../kb/sentry-bridge/production/hybrid-nginx-mirror.md).
- Code: the receiver now hands the request's `X-Forwarded-For` to the pipelines as `client.Info.Metadata` (`job.clientInfo`), so `ouoratelimit` `key_from: x_forwarded_for` works for bridged telemetry; before, every device behind a proxy shared the proxy's bucket. Test `TestForwardedForReachesThePipeline`.
- Docs: deployment guide section "Hybrid" with the measured nginx snippet; spec 2a (mirror-fed bridge leaves `passthrough_upstream` unset) and section 10 (XFF metadata).

## Verified, and how

- Mirrors fire with `upstream: none` (code: `answerLocally`; rig: 60 in, 60 copies 200 at Preview).
- Latency matrix (healthy, +200 ms, +2 s, refused, blackholed, SYN blackhole) × (nginx defaults, 500 ms, 100 ms timeouts) with `sentrytap replay` through nginx, toxiproxy in front of the collector; confirmation rounds with self-hosted Sentry 26.10 as production. Numbers in the report.
- Duplicates with `passthrough_upstream` = production: 120 sent, 180 at production (sink count).
- Rate limiter: 1 200 envelopes from 20 XFF addresses through nginx with `key_from: x_forwarded_for` → 0 rejected, 0 translate drops.
- `go vet`, `gofmt`, `go test -race -count=1` in the receiver; the new test fails without the fix.

## Not done / unverified

- Second Sentry install on another version (no memory), a real Preview 429, Android, the `key_from: address` repeat run: the Mac saturated (load average up to 40) and the runs were stopped. Marked unverified in the report.
- Throughput ceiling on the target VM (only the shared Mac's: lossless at 40/s with a 100 ms read timeout, ~300/s CPU ceiling from 2026-11-15).

## For the next agent

- Rig files (nginx template, toxiproxy, `sentrytap -sink` as production) lived in the session scratchpad; the report has every setting needed to rebuild it. Docker had no free address pool for a new network: the rig joined the env's network.
- Env `sentry-hybrid-eval` torn down; `sentry-sbx` stopped again (as found). No dependency added.
