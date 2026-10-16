# Sentry envelope format (for the Sentry bridge, ADR-0008)

Question: what exactly do the Sentry mobile SDKs send, so `ouosentry` can forward it untouched and translate it into ouo telemetry?

Researched 2026-10-13 from develop.sentry.dev and the MIT `sentry-java` sources; checked against real iOS traffic on 2026-10-14 (`@sentry/react-native` 8.30.0, sentry-cocoa 9.30.1; captures in `collector/receiver/ouosentryreceiver/testdata/golden/`). Details of the capture setup: `kb/sentry-react-native-demo.md`.

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

iOS (sentry-cocoa 9.30.1) produces the same single msgpack item, confirmed on captured traffic, **but the key order varies between segments** (for example `replay_video, replay_event, replay_recording`): decode it as a map. `replay_start_timestamp` is on every segment and equals that segment's start.

Recording events (`sentry-java` `io.sentry.rrweb`):

- Video segment: rrweb custom event, `data.tag = "video"`, `data.payload` keys `segmentId`, `size`, `duration`, `encoding` (default `h264`), `container` (default `mp4`), `height`, `width`, `frameCount`, `frameRate`, `frameRateType` (default `constant`), `left`, `top`.
- Touch: incremental snapshot, source mouse interaction. `data.type` is the ordinal of `InteractionType`: MouseUp 0, MouseDown 1, Click 2, ContextMenu 3, DblClick 4, Focus 5, Blur 6, TouchStart 7, TouchMove_Departed 8, TouchEnd 9, TouchCancel 10. Keys `id`, `x`, `y`, `pointerType` (2 = touch), `pointerId`.

Session mode sends a segment about every 5 s. The maximum replay is 60 minutes. Buffer mode keeps about 30 s and flushes on error, then continues as a session-mode stream with `replay_type` still `buffer`.

## Answered by the iOS capture (2026-10-14)

- **Replay id on errors and transactions**: events carry `contexts.replay.replay_id`; event and transaction envelopes carry `trace.replay_id` in the envelope header. After a background rotation the React Native JS layer keeps sending the **previous** session's replay id on transactions for a while, so a replay-id match must also check the session's time window.
- **`did` and `user.id`**: equal. The default event `user.id` is the installation id the SDK uses as `did`.
- **Touch coordinates**: video and touches are both in points (402x874 on an iPhone 18 Pro), no scaling. Starts and ends are incremental source 2, types 7 and 9; **moves are source 6** with `positions[]` (`x`, `y`, `id`, `timeOffset` ms, negative = before the event).
- **`exited`**: sent when the app returns to the foreground; its `timestamp` is the moment it went to the background.
- **Crashes**: reported on the next launch. The new session's `init` arrives first, then the crash event together with the `crashed` update of the old session.
- **Killed process**: reported on the next launch as `abnormal` with `timestamp == started` and duration 0. The timestamp is not a real end time.
- **Auth and transport**: `X-Sentry-Auth` header only (no `sentry_key` query, no envelope `dsn`), always gzip, no `Origin`.
- **SDK names**: `sentry.javascript.react-native` (JS events, transactions, most replay segments) and `sentry.cocoa.react-native` (sessions, native crash, some replay segments). Plain `sentry.cocoa` never appears from React Native. `replay_event.platform` is `cocoa`.
- **When Sentry is unreachable**: with the connection dropped, sentry-cocoa retries the first envelope with backoff, keeps the rest on disk, and flushes everything right after the endpoint answers again.

Still open: Android (`sentry-java`) payloads and native-only iOS apps.

## Logs and replay breadcrumbs (observed 2026-10-14, @sentry/react-native 8.30.0 / @sentry/core 10.76.0)

- `log` item header: `{"type":"log","item_count":N,"content_type":"application/vnd.sentry.items.log+json","length":L}`. Payload `{"version":2,"items":[...]}`. The envelope carries only the `sdk` header (no `trace` DSC, never a `session` item).
- Entry: `timestamp` (Unix seconds, float), `level`, `body`, `trace_id`, `severity_number` (OTel numbers; `info` sent as 10 for console output), `attributes` as `{"value":..,"type":"string|boolean|integer|double"}`.
- Attributes the RN SDK adds itself: `sentry.release`, `sentry.environment`, `sentry.sdk.name`, `sentry.sdk.version`, `sentry.replay_id` (present on iOS: the mobile replay integration answers `getReplayId`), `sentry.timestamp.sequence`, `sentry.origin` (`auto.log.console` for console capture), `sentry.message.template` and `sentry.message.parameter.N` with `logger.fmt`, `sentry.trace.parent_span_id` inside a span, and from `LogEnricher` `device.model`, `device.family`, `os.name`, `os.version`. `user.id`/`user.email`/`user.name` only when the JS scope has a user.
- `enableLogs: true` in RN 8.30 also installs console capture: every `console.*` line becomes a log entry. The same lines are console breadcrumbs in the replay recording, so they arrive twice.
- Logs are flushed 5 s after the last one (RN client idle timer), usually after the transaction with the same trace id.
- Replay recordings carry the scope breadcrumbs as rrweb custom events `{"type":5,"data":{"tag":"breadcrumb","payload":{category, message, level, type, timestamp, data}}}`, each in one segment: `fetch` (`method`, `url`, `status_code`, `__span`), `console`, `navigation`, `app.inactive` / `app.background`, `sentry.transaction`, and every `Sentry.addBreadcrumb`. Segment 0 also has a `{"tag":"options"}` event with `maskAllText`, `maskAllImages`, `quality`, `maskedViewClasses`.
- Without `startNewTrace`, every root span (`startSpan({forceTransaction: true})`) reuses the scope's propagation trace id until the next navigation, so several user flows share one trace id.

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
