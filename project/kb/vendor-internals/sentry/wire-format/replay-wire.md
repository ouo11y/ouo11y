# Session Replay on the wire and through Relay

Versions: Relay 26.10.0, Sentry 26.10.0, Snuba 26.10.0, self-hosted 26.10.0. Researched 2026-11-10. SDK-side replay capture (rrweb options, masking, buffer mode) is in the sibling folders `browser-sdk/` and `mobile-sdks/` and in Step 4 ([../../../client-sdk-features/vendors/sentry-web.md](../../../client-sdk-features/vendors/sentry-web.md), [../../../client-sdk-features/vendors/sentry-mobile.md](../../../client-sdk-features/vendors/sentry-mobile.md)). Where the segments end up is in [../self-hosted-storage/object-storage.md](../self-hosted-storage/object-storage.md). This file is the one place that describes the replay items on the wire; the browser, storage and read-API entries link here instead of repeating it.

## Three item types, two shapes

| Shape | Items in one envelope | Sent by | Relay payload variant |
|---|---|---|---|
| Web replay | `replay_event` + `replay_recording` | browser SDK (rrweb) | `ReplayPayload::WebReplay` |
| Native (video) replay | one `replay_video` | Android, iOS, React Native mobile replay | `ReplayPayload::NativeReplay` |
| Standalone recording | one `replay_recording` | some older SDKs | `ReplayPayload::StandaloneRecording` |

Read: `ReplaysProcessor::prepare_envelope` and `process::expand` in [`relay-server/src/processing/replays/`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/processing/replays/mod.rs). Any other combination (two events, event without recording, event + video) is rejected. Observed:

| Envelope | Edge answer | Final outcome | Fixture |
|---|---|---|---|
| event + recording (zlib body) | 200 | stored, `replays_local` row + segment file | `item-replay-web-segment0.json` |
| event + recording (body plain JSON, starts with `[`) | 200 | stored; Sentry zlib-compresses it before writing | `item-replay-web-segment1-uncompressed.json` |
| event + recording (body **gzip**) | 200 | **silently dropped** by Sentry's recording task (no row, no file, no outcome) | `item-replay-web-segment2-gzip-body.json` |
| event only | 200 | invalid `invalid_replay_missing_recording` | `item-replay-event-only.json` |
| recording only | 200 | segment file stored, no `replays_local` row | `item-replay-recording-only.json` |
| two events + one recording | 413 (event limit count 1) | `too_large:replay_event` | `item-replay-two-events.json` |
| `replay_video` | 200 | stored, video packed into the segment file | `item-replay_video.json` |
| `replay_video` with empty video | 200 | invalid `invalid_replay_video` | `item-replay_video-empty-video.json` |
| error event + replay items | 413 | whole envelope rejected | `combo-event-plus-replay_event.json` |

## Envelope header

`event_id` must be the **replay id** (32 hex). Relay's `validate` rejects the replay with `NoEventId` otherwise, and the Kafka message key and `replay_id` come from it (`StoreReplay.event_id`, [`processing/replays/store.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/processing/replays/store.rs)).

```
{"event_id":"62649a29ef4440bfa140a17c472d1ba3","sent_at":"...","sdk":{...},"dsn":"..."}
{"type":"replay_event","length":612}
{...replay_event JSON...}
{"type":"replay_recording","length":447}
{"segment_id":0}\n<zlib bytes>
```

## `replay_event` payload

Schema: `Replay` in [`relay-event-schema/src/protocol/replay.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-event-schema/src/protocol/replay.rs); validation in [`relay-event-normalization/src/replay.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-event-normalization/src/replay.rs).

| Field | Type | Notes |
|---|---|---|
| `type` | `"replay_event"` | |
| `replay_id` | UUID | required (`MissingReplayId`) |
| `event_id` | UUID | same as `replay_id` in SDKs |
| `segment_id` | u64 | required; must fit u16 (`SegmentIdTooLarge` above 65535). Relay logs, but accepts, ids above 720 (`MAX_SEGMENTS_ID`, one hour at 5 s) |
| `replay_type` | string | `session` or `buffer` |
| `timestamp` | float seconds | segment end |
| `replay_start_timestamp` | float seconds | replay start, sent on segment 0 |
| `urls` | array of strings | max 100 kept |
| `error_ids` | array of UUID | max 100 kept; invalid UUID fails validation |
| `trace_ids` | array of UUID | max 100 kept |
| `segment_names` | array of strings | |
| `contexts` | object | `replay.session_sample_rate`, `replay.error_sample_rate`, `browser`, `os`, `device` |
| `platform`, `release`, `dist`, `environment`, `tags`, `user`, `request`, `sdk` | event fields | `user.ip_address` and user agent normalized by `replay::normalize` (GeoIP, UA parsing) |

Relay normalizes timestamps (`eap::time::normalize`), runs inbound filters, quotas (`replay` category), then PII scrubbing of the event with the project's PII config.

## `replay_recording` payload

```
{"segment_id":N}\n<body>
```

- The first line is a JSON header. Relay's scrubber requires exactly one `\n` after it and a non-empty body ([`relay-replays/src/recording.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-replays/src/recording.rs) `process_recording`).
- `<body>` is either a raw rrweb JSON array (first byte `[`) or **zlib** (RFC 1950). Not gzip. Relay only inflates when it scrubs; Sentry's task inflates with `zlib.decompress` and falls back to raw JSON when the first byte is `[`, else it drops the segment ([`sentry/replays/consumers/recording.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/consumers/recording.py) `decompress_segment`). Observed: a gzip body vanished without an outcome.
- The rrweb array is a list of events `{"type": n, "timestamp": ms, "data": {...}}`. rrweb types: 0 DomContentLoaded, 1 Load, 2 FullSnapshot, 3 IncrementalSnapshot, 4 Meta, 5 Custom, 6 Plugin. Sentry uses type 5 with `data.tag` = `breadcrumb`, `performanceSpan`, `options`, `video` (mobile) and others.

### PII scrubbing of recordings

`RecordingScrubber` only touches **type 5** events, and inside them only applies "PII" field semantics to `data.payload.description` and `data.payload.data` (other strings get the default rules). DOM snapshots (type 2/3) are never scrubbed by Relay; masking must happen in the SDK. Scrubbing output is always zlib. It runs only when the project has the feature `organizations:session-replay-recording-scrubbing` (read: `process::scrub` in [`processing/replays/process.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/processing/replays/process.rs)).

Observed in self-hosted 26.10.0: the feature is not in the default `SENTRY_FEATURES` ([`sentry/sentry.conf.example.py`](https://github.com/getsentry/self-hosted/blob/26.10.0/sentry/sentry.conf.example.py)). Our segment 0 contained `password=hunter2 card 4111 1111 1111 1111` in a type-5 breadcrumb and a card number in a DOM text node; the stored file was byte-for-byte the zlib we sent ([../self-hosted-storage/fixtures/replay-segment-0-decoded.json](../self-hosted-storage/fixtures/replay-segment-0-decoded.json)). The replay **event** is still scrubbed by the normal datascrubber.

## `replay_video` payload

A MessagePack map with three binary (or string) values, decoded by `ReplayVideoEvent` (serde, field names exact):

```
{ "replay_event": <JSON bytes>, "replay_recording": <"{\"segment_id\":N}\n" + rrweb JSON, optionally zlib>, "replay_video": <MP4 bytes> }
```

- `replay_video` must be non-empty, else `invalid_replay_video`.
- `replay_event` is parsed and handled like above.
- The video itself is not inspected by Relay. Sentry stores it with the recording (see storage).
- The rrweb part of mobile replays holds a type-5 `video` event: `{"tag":"video","payload":{"segmentId","size","duration","encoding":"h264","container":"mp4","height","width","frameCount","frameRate","frameRateType","left","top"}}` plus breadcrumbs and touch events. Mobile SDK specifics are in `mobile-sdks/`.
- Observed: `platform: "android"` in our hand-made replay_event was stored as `platform: "other"` in `replays_local` (the Snuba replays processor keeps only known platform values; not checked further).

## What Relay sends to Kafka

One message per segment to **`ingest-replay-recordings`**, msgpack, type `replay_recording_not_chunked` ([`services/store.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/services/store.rs) `ReplayRecordingNotChunkedKafkaMessage`):

| Key | Content |
|---|---|
| `type` | `replay_recording_not_chunked` |
| `replay_id` | envelope `event_id` |
| `key_id`, `org_id`, `project_id` | scoping |
| `received` | unix seconds |
| `retention_days` | project event retention (90 here) |
| `payload` | the recording item bytes (header line + body) |
| `replay_event` | normalized replay_event JSON, or absent |
| `replay_video` | video bytes, or absent |
| `relay_snuba_publish_disabled` | always `true`: Relay no longer writes replay events to Snuba itself; the Sentry task must publish them |

Observed (kafka-console-consumer on the topic): the keys above appear in this order.

## What happens next (self-hosted 26.10.0)

1. **taskbroker** consumes `ingest-replay-recordings` in raw mode (consumer group `ingest-replay-recordings`, [`taskbroker/config.yml`](https://github.com/getsentry/self-hosted/blob/26.10.0/taskbroker/config.yml)) and turns each message into a `sentry.replays.tasks.process_replay_recording` task run by **taskworker**. There is no dedicated replay consumer container any more.
2. The task ([`replays/tasks.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/tasks.py), [`usecases/ingest/__init__.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/ingest/__init__.py)):
   - splits the header line, inflates the body (zlib or raw `[`);
   - writes the segment to blob storage; the key layout and the byte format of web and video segments are described once, in [../self-hosted-storage/object-storage.md](../self-hosted-storage/object-storage.md#replay-segments);
   - publishes `{start_time, replay_id, project_id, retention_days, payload: replay_event}` to **`ingest-replay-events`**;
   - parses type-5 events into click/tap/action rows and emits them to `ingest-replay-events` too, plus EAP trace items;
   - on segment 0, tracks the billing outcome.
3. **snuba-replays-consumer** reads `ingest-replay-events` and writes `replays_local`; the materialized view fills `replays_aggregated_local`.
4. Errors with `contexts.replay.replay_id` produce an extra `event_link` message on `ingest-replay-events` (observed: a row with `segment_id = NULL`, `error_id` set, in `replays_local`).

Details and observed rows: [../self-hosted-storage/follow-one-event.md](../self-hosted-storage/follow-one-event.md).
