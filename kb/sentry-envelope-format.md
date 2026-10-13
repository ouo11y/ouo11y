# Sentry envelope format (for the Sentry bridge, ADR-0008)

Question: what exactly do the Sentry mobile SDKs send, so `ouosentry` can forward it untouched and translate it into ouo telemetry?

Researched 2026-10-13 from develop.sentry.dev and the MIT `sentry-java` sources. Nothing here has been checked against captured traffic yet. Spec section 14 step 1 does that and must update this file with what it finds.

## Transport

- `POST /api/<project_id>/envelope/`, content type `application/x-sentry-envelope` (assumed when absent; `text/plain` also accepted to avoid browser preflights).
- Auth: HTTP header (`X-Sentry-Auth: Sentry sentry_key=...`), query string (`sentry_key=`), or the envelope `dsn` header. When several are present they must match. No auth is `403`.
- Compression is whole-body `Content-Encoding`. The format itself has none.
- Rate limits come back as `X-Sentry-Rate-Limits` and `Retry-After` and the SDK honours them, so the bridge must return them verbatim.

## Wire format

- Line 1: envelope header JSON (`event_id`, `dsn`, `sdk`, `sent_at`, and `trace` for the dynamic sampling context).
- Each item: header line JSON with `type` and optional `length`. With `length` the payload is exactly that many bytes, then `\n` or end of input. Without it the payload runs to the next `\n`.
- At most one `event` or `transaction` per envelope (mutually exclusive). Session updates SHOULD travel with the error or crash event that changed them. This is what makes session correlation of errors stateless.

## Sessions

`session` item fields: `sid`, `did`, `seq`, `timestamp`, `started`, `init`, `duration` (float seconds), `status`, `errors`, `abnormal_mechanism`, `attrs.{release, environment, ip_address, user_agent}`. Only `status`, `duration` and `errors` change after the first send.

Statuses: `ok`, `exited`, `crashed`, `abnormal` (fate unknown, for example kill or power loss, usually recorded on the next launch; ANRs use `abnormal_mechanism`), `unhandled` (unhandled error, process alive). `errored` is derived: `ok` or `exited` with `errors > 0`. Mobile sessions may end after 30 s in background.

`errors` counts every error, including ones whose event was sampled out. Hence the synthetic `sentry.unsampled_error` records in the bridge spec.

## Mobile replay

Web replay is two items, `replay_event` plus `replay_recording`. Mobile replay is different: `sentry-java` builds a **single `replay_video` item** whose payload is a msgpack map, written as a fixmap with str8 keys and bin32 values, in a fixed order the source comment says Relay expects:

1. `replay_event`: JSON (`replay_id`, `segment_id`, `replay_type` `session|buffer`, `replay_start_timestamp`, `timestamp`, `trace_ids`, scope data).
2. `replay_recording`: optional. `{"segment_id":n}` newline, then a JSON array of rrweb-style events.
3. `replay_video`: optional raw mp4 bytes, not JSON encoded.

Source: `sentry/src/main/java/io/sentry/SentryEnvelopeItem.java`, `fromReplay` and `serializeToMsgpack`.

iOS is expected to produce the same layout because Relay accepts one format for the item. Not yet confirmed: the `sentry-cocoa` source path guessed during research returned 404.

Recording events (`sentry-java` `io.sentry.rrweb`):

- Video segment: rrweb custom event, `data.tag = "video"`, `data.payload` keys `segmentId`, `size`, `duration`, `encoding` (default `h264`), `container` (default `mp4`), `height`, `width`, `frameCount`, `frameRate`, `frameRateType` (default `constant`), `left`, `top`.
- Touch: incremental snapshot, source mouse interaction. `data.type` is the ordinal of `InteractionType`: MouseUp 0, MouseDown 1, Click 2, ContextMenu 3, DblClick 4, Focus 5, Blur 6, TouchStart 7, TouchMove_Departed 8, TouchEnd 9, TouchCancel 10. Keys `id`, `x`, `y`, `pointerType` (2 = touch), `pointerId`.

Session mode sends a segment about every 5 s. The maximum replay is 60 minutes. Buffer mode keeps about 30 s and flushes on error, then continues as a session-mode stream with `replay_type` still `buffer`.

## Open questions (to answer from a capture)

- Do error events and transactions carry `contexts.replay.replay_id`, and does the envelope `trace` header carry `replay_id`, on both platforms?
- Is the default event `user.id` the same installation id the SDK uses as session `did`?
- What is the touch coordinate space: video pixels or screen points?
- Is `exited` sent when the app goes to the background or when it next comes to the foreground?

## Licensing

The SDKs are MIT. Relay and the Sentry server are FSL, so do not copy their code. Implement from develop.sentry.dev and the SDK sources only.

## Sources

- https://develop.sentry.dev/sdk/data-model/envelopes/
- https://develop.sentry.dev/sdk/data-model/envelope-items/
- https://develop.sentry.dev/sdk/telemetry/sessions/
- https://develop.sentry.dev/sdk/telemetry/replays/
- https://github.com/getsentry/sentry-java/blob/main/sentry/src/main/java/io/sentry/SentryEnvelopeItem.java
- https://github.com/getsentry/sentry-java/blob/main/sentry/src/main/java/io/sentry/rrweb/RRWebVideoEvent.java
- https://github.com/getsentry/sentry-java/blob/main/sentry/src/main/java/io/sentry/rrweb/RRWebInteractionEvent.java
