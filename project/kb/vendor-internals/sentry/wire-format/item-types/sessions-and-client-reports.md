# Sessions and client reports: session, sessions, client_report

Versions: Relay 26.10.0, Sentry 26.10.0. Researched 2026-11-10. Develop docs: <https://develop.sentry.dev/sdk/telemetry/sessions/> and <https://develop.sentry.dev/sdk/telemetry/client-reports/> (accessed 2026-11-10).

## `session` (session update)

Schema `SessionUpdate` in [`relay-event-schema/src/protocol/session.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-event-schema/src/protocol/session.rs):

| Key | Type | Notes |
|---|---|---|
| `sid` | UUID | session id (random if missing) |
| `did` | string | distinct id (user) |
| `seq` | u64 | sequence, default from timestamp |
| `init` | bool | first update of the session |
| `timestamp` | RFC 3339 | update time |
| `started` | RFC 3339 | session start |
| `duration` | float seconds | optional |
| `status` | `ok`, `exited`, `crashed`, `abnormal`, `errored`, `unhandled` | |
| `errors` | u64 | error count |
| `abnormal_mechanism` | `anr_foreground`, `anr_background`, `none` | Android ANR |
| `attrs.release` | string | **required** |
| `attrs.environment`, `attrs.ip_address`, `attrs.user_agent` | | |

## `sessions` (pre-aggregated)

`{"aggregates":[{"started": "...", "did": "...", "exited": n, "errored": n, "abnormal": n, "unhandled": n, "crashed": n}], "attrs": {"release": "...", "environment": "..."}}` (`SessionAggregates`). Used by server SDKs in request mode. Max 100 buckets per item (docs).

## What Relay does with sessions

Sessions are **not stored as records**. Relay validates them (release required, timestamps within limits, max 100 per envelope) and turns them into metrics (`relay-server/src/processing/sessions/`): a counter `c:sessions/session@none` tagged with `session.status`, and sets `s:sessions/user@none` (hashed `did`) and `s:sessions/error@none` (hashed `sid`), tagged with release, environment, sdk. These go to Kafka `ingest-metrics` → Sentry `metrics-consumer` (string indexer, Postgres `sentry_stringindexer`) → `snuba-metrics` → `metrics_raw_v2_local` → `metrics_counters_v2_local` / `metrics_sets_v2_local`. A global option `sessions_eap_rollout_rate` can also write them as EAP `user_session` items; we saw no EAP session items in self-hosted.

Observed: our session updates produced rows in `metrics_raw_v2_local` with `use_case_id = sessions`, integer tag keys and values, `count_value` 1..4 and set values (hashes). A session without `attrs.release` got 200 and was dropped later. A session in the same envelope as an error was accepted. Consequence: **individual sessions (sid, start, end, status history) cannot be read back from Sentry**, only aggregates per release/environment/status per 10 s bucket.

## `client_report`

Schema `ClientReport` ([`protocol/client_report.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-event-schema/src/protocol/client_report.rs)):

```json
{"timestamp": 1794280827.5,
 "discarded_events": [{"reason": "ratelimit_backoff", "category": "replay", "quantity": 2}],
 "rate_limited_events": [], "filtered_events": [], "filtered_sampling_events": []}
```

Relay turns each entry into an outcome (`client_discard`, id 5, with the given reason; `rate_limited_events` → `rate_limited`, `filtered_*` → `filtered`). No category on its own. Limits: 100 items and 100 KiB per envelope (observed 413 at 101 items). Observed rows in `outcomes_raw_local`: outcome 5 reasons `queue_overflow` (error), `sample_rate` (transaction), `ratelimit_backoff` (replay).
