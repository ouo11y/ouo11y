# 2026-11-10 — sentry-wire-storage (Step 6)

Agent: `sentry-wire-storage`. Pinned: Relay 26.10.0 (`b4194151`), Sentry 26.10.0 (`da07b233`), Snuba 26.10.0 (`584740ea`), self-hosted 26.10.0, sentry-protos 0.80.0.

## What was done

- Read Relay at tag 26.10.0 (envelope parser, item types, endpoints, auth, decompression, size limits, rate-limit header, replay processing and recording scrubber, OTLP integration, Kafka store service), Sentry (replay recording task and storage, nodestore, attachments, cleanup) and Snuba (storages ↔ topics ↔ tables), and the develop docs pages for envelopes and rate limiting.
- Sent about 100 hand-crafted requests to self-hosted Relay (`localhost:9000`, project `step6-wire`) covering framing, compression, auth, every item type, replay variants, size limits, other endpoints and OTLP; recorded each answer.
- Triggered a real 429 by setting the project key rate limit to 1/60 s through the API for about 3 minutes, then set it back to `null` (verified).
- Read-only inspection of the stores: Kafka topics, configs and consumer groups; ClickHouse schema and rows; Postgres; seaweedfs buckets; filestore files; Redis key families.
- Wrote `project/kb/vendor-internals/sentry/wire-format/` and `.../self-hosted-storage/` with indexes, HTML explainers and fixtures.

## Verified and how

- Every status code and body in `wire-format/fixtures/relay-responses/*.json` is observed.
- Storage claims marked "observed" were checked with `clickhouse-client`, `psql`, `docker exec ... cat`, the seaweedfs filer, `kafka-topics`/`kafka-consumer-groups`.
- `lychee --offline` on both folders: 0 errors. 32-hex scan: only synthetic event/trace/replay ids; no DSN keys, token or passwords. IPs redacted.

## Top findings

1. Replay recordings in self-hosted 26.10.0 are consumed by **taskbroker in raw mode** (no replay consumer container) and written to the **filestore filesystem** (`/data/files/<retention>/<project>/<replay_id>/<segment>`, volume `sentry-data`), not Postgres and not seaweedfs. Web segments are stored byte-for-byte as received (zlib); video segments as `zlib(0x01 + len + mp4 + rrweb)`.
2. A **gzip** recording body is silently dropped (no file, no row, no outcome); Sentry only accepts zlib or raw JSON.
3. Recording PII scrubbing is off in self-hosted (feature `organizations:session-replay-recording-scrubbing` not enabled): a card number and password in our segment were stored unchanged.
4. Only **one** of event/transaction/feedback/replay_event/security per envelope: `event` + `replay_event` gets 413 for the whole envelope.
5. Nodestore is the seaweedfs S3 bucket `nodestore` (zstd, key `md5("project:event")`); Postgres `nodestore_node` is empty. Sessions are stored only as metrics aggregates. Spans, logs and trace metrics all live in `eap_items_1_local`.
6. Relay framing differs from our receiver: two trailing newlines → 400, CRLF → 400, `x-gzip` → 415, raw deflate → 400, br/zstd accepted. Our receiver translates 7 of 23 item types and does not translate web replays (`replay_event` + `replay_recording`) at all. See `wire-format/ouo-receiver-gaps.md`.

## Unverified / left

- Browser and mobile capture fixtures from the sibling agents were not in the notes folder during this run; envelopes used here are hand-crafted.
- Whether anything ever deletes replay segment files on the filesystem backend (source suggests no; not observed over time). The nodestore bucket lifecycle rule was not read back.
- `X-Sentry-Rate-Limits` on a 200 response was never observed.
- Why one legacy `user_report` sent next to a `feedback` item for the same error left no trace of its own text.
- Profiles (`profile`, valid `profile_chunk`), attachments over 192 bytes, minidump/unreal success paths, TUS uploads, Vercel and Integrity endpoints were not exercised.
- SaaS differences (GCS for replays, Bigtable nodestore, objectstore) are from source only.

## Next agent must know

- Read-only use is safe; the `step6-wire` project now holds test data (errors, replays `62649a29…`, `0fa16ee4…`, monitor `step6-wire-cron`, which now raises "missed check-in" issues).
- New dependency: `brotli` (Python) installed only in a scratchpad venv to test `Content-Encoding: br`; nothing added to the repo.
