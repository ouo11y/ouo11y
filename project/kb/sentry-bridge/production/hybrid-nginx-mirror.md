# Hybrid: nginx mirror to a bridge with `upstream: none`

Measured 2026-11-17 by `sentry-demo` (session sentry-hybrid) on the founder's Mac (Apple M5, 32 GB, Docker VM 20 GB shared with other stacks, host load average 15 to 28): nginx 1.27.3 → production (a `sentrytap -sink`, then self-hosted Sentry 26.10 project 2), `mirror` → toxiproxy 2.9 → ouo-collector (`ouosentry`, `upstream: none`, mirror to Sentry project 9 as Preview). Driver: `sentrytap replay`, golden capture `ios-rn-8.32.0/journey` re-keyed, 8 keep-alive senders at 40 req/s. Report: [sentry-hybrid-mirror.html](../../../agents/sentry-demo/reports/sentry-hybrid-mirror.html). Recommended nginx snippet: [deployment guide](../../../../docs/sentry-bridge-deployment.md), section "Hybrid".

| Question | Answer |
|---|---|
| Do mirrors fire with `upstream: none`? | Yes: `answerLocally` flushes the 200, then queues the mirror copy and the translation (receiver.go). No change needed |
| Does a slow or dead bridge slow production? | Yes, through keep-alive: nginx answers the client on time but reads the next request on that connection only when the mirror subrequest ends. Defaults (60 s): blackholed bridge → p50 60.0 s, 8/24 clients timed out (5 of those had reached production, so the SDK's retry duplicates them; 3 had not); 2 s slow → p50 2.07 s |
| With tight mirror timeouts? | connect 50 ms, send/read 100 ms: healthy +0.2–0.6 ms p50 vs no mirror (real Sentry, 3 rounds); blackholed p50 66–77 ms; SYN blackhole (non-routable target) p50 28 ms; refused ≈ no mirror. 500 ms timeouts: blackholed p50 501 ms |
| Copies lost with 100 ms? | 0 of 400 healthy at 40/s; 128 of 1 200 (11 %) at 32 unpaced senders (~70/s) on the saturated host. Preview got 3 457 of 3 460 (3 mirror timeouts while sbx Kafka restarted) |
| `passthrough_upstream` on a mirror-fed bridge? | Duplicates: 60 bridge-project + 60 other-project envelopes → production received 180 (each unknown-key envelope twice, plus a probe on `/`). Must stay unset; validation cannot forbid it (the edge cutover mode needs it) |
| Rate limiter behind nginx | Before this fix the bridge handed its output to the pipeline with `Addr` = nginx and no metadata, so `key_from: x_forwarded_for` fell back to nginx's address: one 100/s bucket for all phones. Fixed (`X-Forwarded-For` in `client.Info.Metadata`); 1 200 envelopes from 20 XFF addresses through nginx → 0 `ouo_ratelimit_rejected`, 0 translate drops |
| N instances | Session, replay, trace, origin and event correlation are per instance; per-client and per-project buckets are per instance (limits × N); queues and byte budgets are per instance. Sentry SDKs send no device header; hashing on `$remote_addr`/XFF breaks on Wi-Fi↔cellular; hashing on the DSN key is one instance per app. Run one, with an nginx `backup` standby |

Gotchas:

- `host.docker.internal` resolves to IPv6 first inside containers on Docker Desktop; nginx then logs `Network unreachable` and marks the server down. Use the IPv4 (192.168.65.254) in a rig.
- nginx does not log subrequests (`log_subrequest off`): an `access_log` in the mirror location stays empty. Mirror failures show only in the error log (`upstream timed out ... subrequest: "/_ouo_mirror"`).
- With equal keep-alive timeouts (nginx 60 s, collector `idle_timeout` 1 min) nginx sometimes reuses a connection the collector just closed (`upstream prematurely closed connection`): set the upstream `keepalive_timeout` lower (30 s).
- The busybox nginx image's `/var/log/nginx/access.log` is a symlink to stdout: `tail` on it in `docker exec` hangs.
- Self-hosted Sentry's Kafka restarted once under host load during a run (p99 32.8 s at the client from production itself, not the mirror): measure the mirror's effect against a stable sink.
