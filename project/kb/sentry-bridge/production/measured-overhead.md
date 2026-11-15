# What the bridge costs, measured

Measured 2026-11-15 by `sentry-demo` (session sentry-mirror) on an Apple M5 / 32 GB with a 20 GB Docker VM shared with other stacks (host load average 20 to 200), self-hosted Sentry 26.10.0 as production, a second project on it as the mirror. Details and every run: [sentry-mirror-readiness.html](../../../agents/sentry-demo/reports/sentry-mirror-readiness.html). Driver: `sentrytap replay` (golden captures, round robin).

| Question | Answer |
|---|---|
| Latency added, one sender | +3 to 4 ms p50 (median of 3 interleaved rounds of 200); the same with the mirror absent, healthy or hanging. p99 is host noise here. In production add one round trip bridge → Sentry ingest |
| Saturation | About 300 envelopes/s through the bridge vs 450–900/s straight to Sentry with 64 senders, collector at 130 % CPU; translation shares the CPU |
| Memory | 35–88 MiB during a 10-minute 15/s soak, 177 MiB after 64-sender bursts; queue peaks 18 MB (translate) and 17 MB (mirror) |
| Restart | 3.2 s from `docker restart` to the first answer; at 20/s, 57 of 800 requests got a network error, none a 5xx |
| Fidelity | 49/49 real sentry-cocoa / RN envelopes and 40/40 sentry-go envelopes byte-identical at production with identical answers; mirror bodies identical except the rewritten envelope `dsn` (sentry-go sends one, mobile SDKs do not) |
| Mirror completeness | Copies dropped `queue_full` during 64-sender bursts (3 370 of 15 038 with 4 workers and a mirror at p99 5 s); none dropped at 15/s |

Gotchas found on the way:

- Replaying old captures fills Sentry but not ouo: Loki rejects samples older than its window, so content checks on the ouo side need fresh SDK traffic (`sentry-go` in a scratch module works: it sends errors and transactions as envelopes with a `dsn` header).
- A single sender address at hundreds per second hits `ouoratelimit`'s per-client bucket (100/s): the translation drops (`consumer_logs`, `consumer_traces`, `consumer_replay`) equal `ouo_ratelimit_rejected_total`. Behind a proxy all devices share one address unless `key_from: x_forwarded_for`.
- The sandbox Sentry's `taskbroker` got stuck again after a cold start under load (Relay `deadline exceeded`); restarting it (kb-archive `sentry-self-hosted.md`) delivered the held envelopes.
