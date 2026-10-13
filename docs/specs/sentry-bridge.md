# Sentry bridge specification

Status: implemented (`collector/receiver/ouosentryreceiver`, rum-api video kind, plugin 0.4.0) and verified on real `@sentry/react-native` 8.30.0 / `sentry-cocoa` 9.30.1 traffic on 2026-10-14 (`reports/sentry-bridge-verification.html`). Becomes normative when ADR-0008 is accepted. The former **(verify)** items are resolved below from the captures in `collector/receiver/ouosentryreceiver/testdata/golden/`; Android payloads are still unverified.

Scope: envelopes from the Sentry mobile SDKs, `sentry.cocoa` (iOS), `sentry.java.android` (Android) and `sentry.javascript.react-native` (React Native over both). The supported SDK version range is pinned when the golden envelopes are captured and listed here.

## 1. Endpoint

```
POST /api/{sentry_project_id}/envelope/        port 4320 (ouosentry receiver in ouo-collector)
```

- Auth, in this order, and all present ones must agree: `X-Sentry-Auth: Sentry sentry_key=<public key>, ...`, query `?sentry_key=<public key>`, envelope header `dsn`. The pair `(sentry_project_id, public key)` must exist in the project table, else `403 {"detail":"unknown project or key"}` and nothing is forwarded.
- Body: `Content-Encoding` `gzip`, `deflate` or none is translated. Any other encoding (for example `br`) is forwarded but not translated, and counted with reason `encoding`.
- Body limit: `max_request_body_size` (default 20 MiB), `413` above it, not forwarded.
- CORS: none. Mobile SDKs send no `Origin` (verified); the receiver adds no CORS headers, so browsers cannot use it, which is fine while the browser SDK is out of scope.
- Observed on iOS: every request is `Content-Encoding: gzip`, `Content-Type: application/x-sentry-envelope`, auth in `X-Sentry-Auth` only (no query key, no envelope `dsn`).
- `ouoratelimit` applies per ouo project and client address to the **translated** side only. Upstream Sentry enforces its own limits on the forwarded side.

## 2. Forwarding

For a known project with an upstream:

1. Send `POST {upstream}/api/{sentry_project_id}/envelope/` with the original query string, the original body bytes, and the headers `Content-Type`, `Content-Encoding`, `X-Sentry-Auth`, `User-Agent`. Add `X-Forwarded-For` with the client address. Timeout `upstream_timeout` (default 10 s), pooled client, HTTP/2 when offered.
2. Copy the upstream status, `Content-Type`, `X-Sentry-Rate-Limits`, `Retry-After` and body to the response.
3. Upstream timeout or connection error: the receiver **aborts the client connection** instead of answering, and does not translate. The SDK then sees exactly what it sees when Sentry is down: a network error, so it keeps the envelope and retries (a `5xx` answer could make an SDK discard it). Verified on iOS: during an outage sentry-cocoa retried with backoff and flushed every cached envelope once Sentry was back; ouo recorded each event once.
4. Upstream `2xx`: enqueue the decoded envelope for translation. Queue size `translate_queue_size` (default 10 000 envelopes). When full, drop and count with reason `queue_full`.
5. Upstream non-`2xx`: not translated.

With `upstream: none` the receiver answers `200 {"id":"<envelope event_id or empty>"}` and enqueues.

## 3. Envelope parsing

Per develop.sentry.dev "Envelopes":

- First line: envelope header JSON (`event_id`, `dsn`, `sdk`, `sent_at`, `trace`).
- Then items: a header line JSON with `type` and optional `length`. With `length`, the payload is exactly that many bytes followed by `\n` or end of input. Without `length`, the payload runs to the next `\n` or end of input.
- A malformed envelope is forwarded anyway (upstream decides) and not translated, counted with reason `malformed`.
- Unknown item types are ignored by the translator.

Timestamps in Sentry payloads are either RFC 3339 strings or Unix seconds as a float. Both are accepted. ouo attributes use epoch milliseconds, OTLP uses nanoseconds.

## 4. Resource and common attributes

Every record and span produced from one envelope gets:

| ouo attribute | Source |
|---|---|
| `ouo.project.id` (resource) | project table |
| `service.name` (resource) | project table `service_name` (required; iOS and Android are usually separate Sentry projects and get separate names) |
| `service.version` (resource) | release `<package>@<version>+<build>`: the part after `@` and before `+`. Without `@`, the part before `+` |
| `ouo.app.build` | the part after `+`, when present |
| `ouo.sentry.release` | the raw release |
| `deployment.environment.name` (resource) | `environment` |
| `ouo.platform` | `mobile` |
| `os.name`, `os.version` (resource) | `contexts.os.name`, `contexts.os.version` |
| `device.model.identifier` (resource) | `contexts.device.model` |
| `telemetry.sdk.name`, `telemetry.sdk.version` (resource) | envelope `sdk.name`, `sdk.version`, else event `sdk` |
| `ouo.sentry.sdk` | `sdk.name` (`sentry.cocoa`, `sentry.java.android`, `sentry.javascript.react-native`) |
| `session.id` | resolved per section 8 |
| `user.id` | event `user.id`, else session `did` |
| `ouo.sentry.session_match` | `envelope`, `replay`, `device` or `none` |

Session attributes are on records and spans, never on the resource, as in the session lifecycle spec.

## 5. Sessions (`session` item)

Payload fields used: `sid`, `did`, `init`, `started`, `timestamp`, `status`, `errors`, `duration`, `abnormal_mechanism`, `attrs.release`, `attrs.environment`.

| Sentry update | ouo log record |
|---|---|
| `init: true` | `session.start`, timestamp `started`, `ouo.session.started_at` = `started` in ms |
| `status: ok`, `init: false` | none (keeps the device state fresh, section 8) |
| `status: exited` | `session.end`, `ouo.session.end_reason = background` |
| `status: crashed` | `session.end`, `ouo.session.end_reason = crash` |
| `status: abnormal` | `session.end`, `ouo.session.end_reason = terminated`, `ouo.sentry.abnormal_mechanism` (for example `anr_foreground`) |
| `status: unhandled` | none; the error event in the same envelope carries the exception |

- `session.end` timestamp is the update `timestamp`, except: a `crashed` session ends at its fatal exception (sentry-cocoa reports the crash and the `crashed` update on the next launch), and an `abnormal` update whose `timestamp` equals `started` (killed process, reported on the next launch with duration 0) ends at the last activity the receiver saw for the session. `ouo.session.duration_ms` is `duration * 1000` when present and positive, else end minus `started`.
- Observed on iOS: updates after the first omit `init` (treated as `false`); `exited` is sent when the app returns to the foreground with `timestamp` = the moment it went to the background; after a crash the next session's `init` arrives before the crash event and the `crashed` update; `did` equals the default event `user.id`.
- Every `session.end` also carries `ouo.sentry.session.status` (raw status) and `ouo.sentry.session.errors`.
- The receiver emits at most one `session.start` and one `session.end` per `sid` while it holds the state. After a restart a duplicate is possible. It is harmless: it comes from the same Sentry update, so it has the same timestamp and reason, and rum-api folding keeps the last `session.end` of a session.
- **Unsampled errors.** Sentry counts every error in `errors` even when the error event itself was sampled out or dropped by `beforeSend`. When an update's `errors` exceeds the number of `exception` records the receiver emitted for that `sid`, it emits the difference as `exception` records with `exception.type = "sentry.unsampled_error"`, `exception.message = ""`, `ouo.exception.fatal = false`, `ouo.exception.handled = true`, `ouo.sentry.synthetic = true`. This keeps ADR-0004 `errored` in line with Sentry.
- `sessions` items (aggregates) come from server SDKs and are not translated.

## 6. Errors (`event` item)

An `event` becomes an `exception` log record when it has `exception.values`, or its `level` is `error` or `fatal`. Other events (`info`, `warning`, `debug` messages) become a `custom` record named `sentry.message` with `ouo.event.custom = true`.

| ouo attribute | Source |
|---|---|
| timestamp | event `timestamp` |
| trace id, span id of the log record | `contexts.trace.trace_id`, `contexts.trace.span_id` |
| `exception.type` | last element of `exception.values` (Sentry orders chained exceptions oldest to newest) `.type`; `Message` for message-only events |
| `exception.message` | that element's `.value`; for message-only events `logentry.formatted`, else `message` |
| `exception.stacktrace` | all values, newest first, each as `Type: value` then one line per frame from the top of the stack: `  at {function} ({module or filename}:{lineno}:{colno})`, `[in app]` suffix when `in_app`. Values after the first are prefixed `Caused by: `. Capped at 32 KiB |
| `ouo.exception.fatal` | `true` when `level == "fatal"`, or the same envelope holds a `session` update for the resolved `sid` with `status: crashed`. Else `false` |
| `ouo.exception.handled` | last value's `mechanism.handled`, default `true` |
| `ouo.sentry.mechanism` | last value's `mechanism.type` (for example `AppHang`, `ANR`, `signalhandler`, `onerror`) |
| `ouo.sentry.event_id` | envelope or event `event_id` |
| `ouo.sentry.level` | `level` |

`ouo.sentry.event_id` lets the plugin later link an ouo timeline entry to the same event in Sentry (`<sentry ui>/organizations/<org>/issues/?query=id:<event_id>`), configured per project as `sentry_ui_url`.

Breadcrumbs are not translated in this version: every error carries up to the last 100, so they repeat across errors and arrive late. The timeline gets navigation from transactions (section 7).

## 7. Transactions (`transaction` item)

Each transaction becomes one root span plus one span per element of `spans`.

| OTel span field | Root (the transaction) | Child (`spans[]`) |
|---|---|---|
| trace id | `contexts.trace.trace_id` | `trace_id` |
| span id | `contexts.trace.span_id` | `span_id` |
| parent span id | `contexts.trace.parent_span_id` (may be empty) | `parent_span_id` |
| name | `transaction` | `description`, else `op` |
| start, end | `start_timestamp`, `timestamp` | same |
| kind | `INTERNAL` | `CLIENT` when `op` starts with `http.client`, else `INTERNAL` |
| status | `contexts.trace.status` | `status` |
| attributes | `sentry.op`, measurements as `ouo.sentry.measurement.<name>` (value in the measurement's unit, unit in `.unit`) | `sentry.op`, allowlisted `data` keys |

Status: `ok` or absent is `Unset`; anything else is `Error` with the Sentry status as the description.

`data` keys copied for HTTP spans: `http.request.method` (or `method`), `url` as `url.full`, `http.response.status_code` (or `status_code`), `http.query` dropped. Other `data` keys are not copied.

Derived log records (same trace and span id as their span):

- `http.request.failed` for a span with `op` `http.client` and either `http.response.status_code >= 500`, or no status code and span status in `internal_error`, `unavailable`, `deadline_exceeded`, `unknown_error`, `aborted`. Attributes `http.request.method`, `url.full`, `http.response.status_code` (absent for network failures).
- `navigation` for a transaction with `op` `ui.load` (iOS view controllers, Android activities) or `navigation` (React Navigation): `url.path` = `transaction`, `ouo.navigation.kind = screen`, `ouo.navigation.from` = the previous screen of the same session from receiver state, when known.

Envelope header `trace.replay_id`, when present, feeds the `replay_id -> sid` map (section 8).

## 8. Session resolution

Rules in order; the first match wins.

1. **envelope**: the envelope contains exactly one `session` item. Its `sid` applies to every item in the envelope. With several `session` items, the one whose `errors` changed applies to `event` items, and transactions fall through to rule 2.
2. **replay**: the item has a replay id (`contexts.replay.replay_id` on events; envelope header `trace.replay_id` on event and transaction envelopes, both observed), `replay_id -> sid` is known, and the item's time falls inside that session's window (`[started - 1 min, last activity + 30 min]`, or `+ 30 s` once the session has ended). The window check is required: after a background rotation the React Native JS layer keeps sending the previous session's replay id in transaction trace headers. The map is learned from any envelope where rule 1 matched and a replay id is present. Replay segments themselves are matched by replay id without the window check (a session's last segments are flushed after it ended).
3. **device**: `(ouo project, did)` has a session whose window `[started, last_update + 30 min]` contains the item timestamp. The device key of an item is its `user.id` (verified on iOS: the default `user.id` is the installation id the SDK also uses as `did`). When the app sets its own user id, `did` follows it, so the key still matches.
4. **none**: emitted without `session.id`.

State: LRU of `max_sessions` (default 200 000) entries, TTL 4 h after the last update. Replay segments with no resolution are held up to `replay_hold` (default 10 min, at most `replay_hold_max_bytes`, default 256 MiB), retried on every state change, then dropped with reason `replay_unresolved`.

## 9. Replay (`replay_video` item)

### Input

The item payload is a msgpack map with binary values under the keys `replay_event`, `replay_recording`, `replay_video`, in any order (sentry-java writes them in that order; sentry-cocoa varies it between segments, observed). `replay_recording` and `replay_video` may be absent. Observed on iOS: fixmap with str8 keys and bin32 values, uncompressed recording JSON, H.264 mp4 at 1 fps, a segment every 5 to 6 s; `replay_start_timestamp` is present on every segment and equals that segment's start.

- `replay_event` (JSON): `replay_id`, `segment_id`, `replay_type` (`session` or `buffer`), `replay_start_timestamp` (first segment), `timestamp`, `trace_ids`, `platform`, plus scope data (`user`, `contexts`).
- `replay_recording`: a JSON header line `{"segment_id": n}`, a newline, then a JSON array of rrweb-style events. The array may be gzip compressed (check for `1f 8b`).
- `replay_video`: raw mp4 bytes, H.264.

Recording events used:

| rrweb event | Meaning | Fields |
|---|---|---|
| `type: 5` (custom), `data.tag: "video"` | the segment | `timestamp` (ms, segment start), `data.payload`: `segmentId`, `size`, `duration` (ms), `encoding`, `container`, `height`, `width`, `frameCount`, `frameRate`, `frameRateType`, `left`, `top` |
| `type: 3` (incremental), `data.source: 2` (mouse interaction) | a touch start or end | `timestamp`, `data.type` 7 TouchStart, 8 TouchMove_Departed, 9 TouchEnd, 10 TouchCancel; `data.x`, `data.y`, `data.pointerId` |
| `type: 3` (incremental), `data.source: 6` (touch move) | touch moves | `data.positions[]`: `x`, `y`, `id`, `timeOffset` (ms, negative = before the event `timestamp`) |

Other events (breadcrumb custom events, meta events) are ignored in this version.

### Output: `kind: "video"` chunk

One chunk per segment, emitted into the replay pipeline (section 10):

```json
{
  "kind": "video",
  "schema_version": 1,
  "session_id": "<sid>",
  "seq": 3,
  "started_at": 1791471538578,
  "ended_at": 1791471543578,
  "viewport": { "width": 288, "height": 624, "scale": 1 },
  "platform": "ios",
  "video": {
    "container": "mp4",
    "encoding": "h264",
    "duration_ms": 5000,
    "frame_count": 5,
    "frame_rate": 1,
    "mp4": "<base64>"
  },
  "touches": [{ "ts": 1791471540828, "x": 120.5, "y": 410, "phase": "began" }],
  "source": { "vendor": "sentry", "replay_id": "<32 hex>", "segment_id": 3, "replay_type": "session" },
  "masked": true
}
```

- `seq` = `segment_id`. `started_at` = the video event `timestamp`; `ended_at` = `started_at + duration`. A segment without a video event or without mp4 bytes is dropped with reason `replay_incomplete`.
- `viewport` = video `width` and `height`, `scale` 1. Touches are copied in the recording's coordinate space, which on iOS is the video's (both in points, 402x874 on an iPhone 18 Pro, observed). Android unverified.
- Touch `phase`: 7 `began`, 8 and source 6 `moved`, 9 and 10 `ended`.
- `platform`: from `contexts.os.name` when present, else `replay_event.platform` (`cocoa` is `ios`, `java` is `android`), else the SDK name (`sentry.cocoa*` is `ios`, `sentry.java*` but not `sentry.javascript*` is `android`). React Native envelopes are named `sentry.javascript.react-native` or `sentry.cocoa.react-native`, never plain `sentry.cocoa`.
- A session keeps the first `replay_id` it sees. Segments of another `replay_id` for the same `sid` are dropped with reason `replay_conflict`.

## 10. Collector wiring

Checked against the Phase 8a rev 2 components in `collector/` and `deploy/docker/collector/config.yaml`.

**Project context.** On the OTLP and replay paths, `basicauth` puts the project id in `client.Info.Auth` as `username`. `resource/project` stamps `ouo.project.id` from it, and `ouoratelimit` keys its project bucket on it. The Sentry path has no Basic credential. After the project table lookup, the receiver therefore puts an auth value with `username = <ouo_project_id>` into `client.Info` on the context it hands to its consumers. Both processors then work unchanged. The receiver also sets `client.Info.Addr` to the client address.

**Replay records.** These are the records the `ouoreplay` exporter already consumes, as the `ouoreplay` receiver writes them:
- body: the chunk JSON as bytes;
- resource `ouo.project.id`, and `service.name = ouo-replay`;
- attributes `ouo.project.id`, `session.id`, `ouo.replay.seq` (int), `ouo.replay.kind = video` and `ouo.replay.encoding = json`.

The receiver adds `ouo.replay.chunk = true`. A routing connector uses it to send these records to `logs/replay` and everything else to `logs`.

```yaml
receivers:
  ouosentry:
    endpoint: 0.0.0.0:4320
    max_request_body_size: 20971520
    upstream_timeout: 10s
    translate_queue_size: 10000
    state: { max_sessions: 200000, ttl: 4h, replay_hold: 10m, replay_hold_max_bytes: 268435456 }
    projects:
      - sentry_project_id: "4504"
        public_keys: ["<public key>"]
        upstream: https://o123.ingest.sentry.io     # or none
        ouo_project_id: mobile-store
        service_name: mobile-store-ios
        sentry_ui_url: https://acme.sentry.io

connectors:
  routing/sentry:
    default_pipelines: [logs]
    table:
      - condition: attributes["ouo.replay.chunk"] == true   # exact syntax pinned to the ocb manifest version (0.160.0)
        pipelines: [logs/replay]

service:
  pipelines:
    traces:
      receivers: [otlp, ouosentry]
      processors: [memory_limiter, ouoratelimit, resource/project, batch]
      exporters: [otlp_grpc/tempo]
    logs/sentry:
      receivers: [ouosentry]
      processors: [memory_limiter]
      exporters: [routing/sentry]
    logs:
      receivers: [otlp, routing/sentry]
      processors: [memory_limiter, ouoratelimit, resource/project, transform/events, batch]
      exporters: [otlp_http/loki]
    logs/replay:
      receivers: [ouoreplay, routing/sentry]
      processors: [memory_limiter, ouoratelimit]
      exporters: [ouoreplay]
```

The `ouoreplay` receiver's chunk validation and the `ouoreplay` exporter must accept `kind: "video"`. The exporter copies the body through. The receiver's kind check rejects anything other than `rrweb` and `frames` today, which matters only for clients posting video chunks to port 4319 directly. Bridged chunks never pass through that receiver.

Deployment: the Sentry receiver runs in its own single-replica `ouo-collector` deployment (or with client-address affinity) until correlation state moves to a shared store (Phase 11). It exports OTLP to the main collector or directly to the backends.

Metrics: `ouo_sentry_envelopes_total{project,outcome}` (`forwarded`, `rejected`, `upstream_error`), `ouo_sentry_upstream_duration_seconds`, `ouo_sentry_items_total{type,translated}`, `ouo_sentry_translate_dropped_total{reason}` (`queue_full`, `malformed`, `encoding`, `replay_unresolved`, `replay_conflict`, `replay_incomplete`), `ouo_sentry_session_match_total{rule}`.

## 11. rum-api: video replay kind

Additions to `services/rum-api/README.md` and ADR-0006's contract, nothing else changes:

- `POST /v1/replay/chunks` accepts `kind: "video"`. Validation: `schema_version` 1, `started_at > 0`, `ended_at >= started_at`, `viewport.width/height > 0`, `video.container == "mp4"`, `video.mp4` decodes (padded or unpadded base64) to at most `MAX_VIDEO_CHUNK_BYTES` (default 8 MiB) and has `ftyp` at byte offset 4, touches as for frames. `source` is optional and stored.
- Storage: `<seq>.mp4` and `<seq>.json.gz` (the chunk without `video.mp4`, with `video.bytes`), both written atomically under the per-session lock, mp4 first. `meta.json` `kind: "video"`; mixing kinds is `409` as today.
- `GET /v1/sessions/{id}/replay`: meta with `kind: "video"`, `viewport`, `platform`, `chunks[].duration_ms`, `frame_count` total.
- `GET /v1/sessions/{id}/replay/video`:

  ```json
  {"session_id":"<id>","kind":"video","viewport":{"width":288,"height":624,"scale":1},"platform":"ios",
   "started_at":1791471538578,"ended_at":1791471548578,
   "segments":[{"seq":0,"started_at":1791471538578,"ended_at":1791471543578,"duration_ms":5000,"frame_count":5,"bytes":48211,
                "path":"/v1/sessions/<id>/replay/video/0"}],
   "touches":[{"ts":1791471540828,"x":120.5,"y":410,"phase":"began"}],
   "source":{"vendor":"sentry","replay_id":"<32 hex>"}}
  ```

- `GET /v1/sessions/{id}/replay/video/{seq}`: `video/mp4` through `http.ServeContent` (range requests, `Last-Modified`), `404` when the segment is missing.
- `409` when the replay is not video; `/replay/events` and `/replay/frames` return `409` for a video replay. All three streaming endpoints set `X-Ouo-Replay-Kind`.
- Session list and detail: `replay_kind: "video"`, `replay_duration_ms` from the meta, `replay_frame_count` from the video frame counts.

Clarifications from the implementation (rum-api, 2026-10-14):

- Body limit: a video chunk body (base64 mp4 plus envelope) may be up to `base64(MAX_VIDEO_CHUNK_BYTES) + 1 MiB`, about 12.2 MiB by default, compressed and decompressed. A body above it is `413` before parsing; a decoded mp4 above `MAX_VIDEO_CHUNK_BYTES` is `413` too (not `400`). Whatever forwards video chunks to rum-api (the `ouoreplay` exporter) must allow bodies of that size.
- Optional `video` fields: `encoding` (string), `duration_ms` and `frame_count` (integers >= 0), `frame_rate` (number). A segment's duration is `video.duration_ms`, or `ended_at - started_at` without it. `source.vendor` and `source.replay_id` must be strings when present.
- `202` body as for the other kinds: `frames` is `video.frame_count`, `touches` the touch count, `events` 0.
- Meta: `chunks[]` of a video replay carry `duration_ms` and `video_bytes` (mp4 size); `source` is `{vendor, replay_id}` of the first chunk that had one. `segment_id` and `replay_type` stay in the chunk file.
- Segment endpoint: also `ETag` (size and mtime, so a `seq` replaced within the same second is not served from cache), `Cache-Control: private, no-cache`, `400` for a `seq` outside `0..999999`, `416` for an unsatisfiable range. The manifest's `path` is relative to the rum-api root; the plugin maps it onto its proxy route. Its `source` is `null` when no chunk had one.

Plugin (`plugins/ouo-rum-app`): a video player mounted when `replay_kind` is `video`. One `<video>` element per segment in sequence (preload the next), global time to `(segment, offset)` mapping for the scrubber and timeline markers, touch overlay fading over 500 ms as in the frame player, gaps between segments shown as a still of the last frame.

## 12. Attribute allowlist

Only the attributes named in sections 4 to 9 are produced. In particular these Sentry fields are never copied: `user.ip_address`, `user.email`, `user.username`, `request.*`, `extra`, `tags`, `contexts` other than `os`, `device.model`, `trace`, `replay`, breadcrumbs, attachments, view hierarchies and screenshots attached to errors.

## 13. Expected differences between Sentry and ouo

| Topic | Sentry | ouo through the bridge |
|---|---|---|
| Crash-free sessions | `crashed` / total | `crashed` / total, same unless upstream rejected envelopes the bridge therefore skipped |
| ANRs and app hangs | `abnormal` (ANR) or error events | `session.end` reason `terminated`; the ANR error event counts as `errored` |
| Errored sessions | `errors > 0` | same, through synthetic unsampled errors (section 5) |
| Traces per session | sampled by `tracesSampleRate` | same sampled set; `trace_count` and derived `http.request.failed` / `navigation` are lower than a fully traced ouo SDK would produce |
| Session boundaries | Sentry's (30 s background) | Sentry's; ouo's own SDK rules do not apply to bridged apps |
| Replay | session or on-error buffer sampling | exactly the segments Sentry accepted |

## 14. Verification

Done on 2026-10-14 for iOS; results in `reports/sentry-bridge-verification.html`.

1. **Capture.** `examples/sentry-mobile` (Expo app on `@sentry/react-native` 8.30.0, sentry-cocoa 9.30.1) drives an unattended journey on the iOS Simulator (`scripts/journey.sh`). `collector/tools/sentrytap` records every request in front of the bridge (A) and at a fake Sentry behind it (B). Two captures are committed as golden fixtures in `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/`; findings in `kb/sentry-react-native-demo.md` and `kb/sentry-envelope-format.md`.
2. **Unit tests**: envelope parser, msgpack decoder (both fuzzed), forwarding against a fake upstream (body and headers byte-identical, status and rate-limit headers echoed, unknown key `403` and not forwarded, upstream non-2xx not translated, unreachable upstream aborts the connection), translation of a synthetic journey, restart baseline, replay resolution and hold queue, and golden tests on the real captures with an invariant that nothing lands outside its session's window.
3. **rum-api tests**: video chunk validation, storage, manifest, range request, cross-kind `409`.
4. **End to end**: `sentrytap compare A B` must report every request byte-identical with identical responses; `examples/sentry-mobile/scripts/verify-bridge.py` derives sessions, errors, transactions and replays from the raw envelopes and checks rum-api, Loki, Tempo and every mp4 (sha256 and AVFoundation decode). A run with the fake Sentry stopped checks that the SDK retries and that ouo records each event once.
5. **Not done yet**: a run against a real Sentry project as upstream, Android, other SDK versions.
