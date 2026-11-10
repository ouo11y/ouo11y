# Following one error event and one replay through every store

Observed 2026-11-10 on self-hosted Sentry 26.10.0, project `step6-wire` (id 8, org 1). Data sent by our harness ([../wire-format/fixtures/](../wire-format/fixtures/index.md)). All reads were read-only (`clickhouse-client SELECT`, `psql SELECT`, `cat` of files, seaweedfs filer GET). IPs and keys redacted.

## Error event `ff562c370e33407b98236dd8193d01da`

1. **Request**: `POST /api/8/envelope/` with one `event` item (TypeError, one frame, release `step6-wire@1.0.0`) → `200 {"id":"ff562c37…"}` ([`event-plain.json`](../wire-format/fixtures/relay-responses/event-plain.json)).
2. **Relay** normalizes and produces to Kafka `ingest-events` (msgpack `event`).
3. **events-consumer** (`ingest-consumer` group) → taskworker `save_event`: grouping (`grouping_config` in the event), Postgres issue, nodestore write, produce to `events`.
4. **Nodestore**: seaweedfs object `nodestore/nodestore/23bb3ab4436141fb52eb90d927eb3144` (= `md5("8:ff562c37…")`), 1187 bytes zstd; decoded value has the default JSON (2857 bytes) and subkey `unprocessed` ([fixtures/nodestore-error-event.json](fixtures/nodestore-error-event.json)). `_metrics`: `bytes.ingested.event 442`, `bytes.stored.event 2794`.
5. **Postgres**: `sentry_groupedmessage` id 14 (`short_id 5`, type 1; `times_seen 16` because all harness errors share one stack trace and so one fingerprint, and the group's `message` shows the latest one), `sentry_grouphash` row, release `step6-wire@1.0.0` in `sentry_release`; later the feedback created `sentry_userreport` id 1 pointing at this event.
6. **ClickHouse** `errors_local`: one row with `group_id`, `primary_hash`, `title`, `exception_stacks.*`, `exception_frames.*`, `retention_days 90`, Kafka `partition 0`/`offset` ([fixtures/rows/errors_local-error-event.jsonl](fixtures/rows/errors_local-error-event.jsonl)).
7. **EAP** `eap_items_1_local`: `item_type 13` processing-error rows (`error_type js_no_source`) because no source maps exist.
8. **Outcomes**: counted as `accepted` (0), category `error` (1), in `outcomes_raw_local` (outcomes are aggregated per minute, not per event id).
9. **Post-process**: `post-process-forwarder-errors` after Snuba commit; replay linking applies only to errors with a replay context (see below).

## Replay `62649a29ef4440bfa140a17c472d1ba3`

Sent as five envelopes with envelope `event_id` = replay id ([`item-replay-*.json`](../wire-format/fixtures/relay-responses/index.md)): segment 0 (event + zlib recording with 4 rrweb events, `error_ids` = the error above), segment 1 (uncompressed body), segment 2 (gzip body), a lone `replay_event` (segment 3), a lone recording (segment 4).

1. **Relay**: each web segment → one Kafka message on `ingest-replay-recordings` (`replay_recording_not_chunked`, with `replay_event` inside). The lone event became outcome `invalid_replay_missing_recording`.
2. **taskbroker** (raw mode, group `ingest-replay-recordings`) → taskworker task `process_replay_recording`.
3. **Blob files** (`sentry-data` volume): `/data/files/90/8/62649a29ef4440bfa140a17c472d1ba3/0`, `/1`, `/4`. **No `/2`** (gzip body dropped silently). Segment 0 = zlib of exactly what we sent, PII not scrubbed ([fixtures/replay-segment-0-decoded.json](fixtures/replay-segment-0-decoded.json)); segment 1 = zlib of our raw JSON; segment 4 = zlib of `[]`.
4. **`ingest-replay-events`** → **snuba-replays-consumer** → `replays_local`: rows for segment 0 (`urls`, `error_ids`, `trace_ids`, `count_errors 1`, `user_id`, `ip_address_v4` = Docker gateway, `sdk_name`) and segment 1. Segment 4 has no row (no replay_event) ([fixtures/rows/replays_local-web-video-link.jsonl](fixtures/rows/replays_local-web-video-link.jsonl)).
5. `replays_aggregated_local` gets the hourly aggregate via MV.
6. Postgres: nothing (`replays_replayrecordingsegment` empty).
7. Outcomes: category `replay` (7) accepted.

### Video replay `0fa16ee44572493da849817ed72e01c9`

One `replay_video` item (msgpack). File `/data/files/90/8/0fa16ee4…/0`: `zlib(0x01, len=20, 20 video bytes, rrweb JSON)` ([fixtures/replay-video-segment-0-decoded.json](fixtures/replay-video-segment-0-decoded.json)). `replays_local` row with `platform` stored as `other` (we sent `android`).

### Error-to-replay link

An error with `contexts.replay.replay_id = 3e360678…` (no replay ever sent for that id) produced a `replays_local` row with `segment_id NULL`, `error_id` = the error, `count_error_events 1`: the link is written even when the replay itself does not exist. Its `ingest-replay-events` message is `{"payload":{"type":"event_link", "replay_id", "event_hash", "timestamp", "error_id"}}`.

## Transaction, spans, logs, metrics (same run)

- Transaction `044bf5fb…`: 1 row in `transactions_local`; 2 spans in `eap_items_1_local` (`pageload` segment, `http.client` child) with web-vital scores computed from `measurements.lcp` ([fixtures/rows/transactions_local-transaction.jsonl](fixtures/rows/transactions_local-transaction.jsonl), [fixtures/rows/eap_items_1_local-span-log-metric.jsonl](fixtures/rows/eap_items_1_local-span-log-metric.jsonl)).
- Standalone spans (v2 container, legacy v1, OTLP JSON, OTLP protobuf): 4 more EAP span rows.
- Logs: 2 from the container, 1 from OTLP, 1 from NEL → EAP `item_type 3`.
- Trace metric `step6.clicks` → EAP `item_type 8`; plus one span-derived distribution.
- Session updates → `metrics_raw_v2_local` (`use_case_id sessions`) only.
