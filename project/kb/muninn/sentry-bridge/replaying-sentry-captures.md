# Replaying recorded Sentry SDK traffic into a fresh stack

Learned 2026-11-15 writing `examples/tools/sentryreplay.py`.

- **Old timestamps are refused.** The golden captures (`collector/receiver/ouosentryreceiver/testdata/golden/`) are from October; Loki rejects samples older than `reject_old_samples_max_age` (168 h in `deploy/compose/loki/config.yaml`). Every timestamp has to move: ISO-8601 strings, epoch seconds (session `started`, event `timestamp`, `replay_start_timestamp`) and epoch milliseconds (rrweb events inside `replay_recording`).
- **Tempo's metrics generator wants fresh spans.** Spans that ended more than 30 s before Tempo ingests them (`metrics_ingestion_time_range_slack`, default 30 s) are stored but get no span metrics. A replay that moves the journey to "ended a minute ago" passes every Tempo check and produces no `traces_spanmetrics_*` at all. Replaying in real time (each request leaves when it left the SDK) keeps every envelope exactly as fresh as it was: the journey is 2.5 minutes.
- **Ids must be fresh per run**, or rum-api answers 409 for replay chunks it already holds and sessions merge across runs. Map every 128-bit id (32 hex and dashed UUID, any case) to a new random one, consistently within a run, so sessions, traces, replays and devices still link. Keep `debug_id`s.
- **replay_video is msgpack** (`replay_event`, `replay_recording`, `replay_video`, binary values): rewrite the first two, leave the mp4 alone, re-encode, recompute the item `length`.
- **Save what was sent** in sentrytap's layout (`NNNNNN/request.json`, `body.bin`): `examples/sentry-mobile/scripts/verify-bridge.py` then checks it unchanged. Pass `--no-backend`: a replay calls no backend, so the traceparent join cannot exist.
- `verify-bridge.py` counted a `captureMessage` at `info` (one synthetic exception value) as an error; the bridge spec section 6 makes it a `sentry.message`. Fixed in the same change.
