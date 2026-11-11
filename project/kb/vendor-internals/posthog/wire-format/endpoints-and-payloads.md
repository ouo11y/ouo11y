# PostHog wire format: endpoints, encoding, limits, event JSON, replay chunking

- **Versions:**
  - posthog-js 1.447.6
  - posthog-ios 3.94.3
  - posthog-android 3.76.1 (android-v3.76.1)
  - posthog-react-native 4.85.4
  - PostHog server at commit `d231ab1719020024c6219d10dc7775f6621fd72c` (main, 2026-11-10)
- **Date:** 2026-11-10.
- **Source keys:**
  - `ph:` = `https://github.com/PostHog/posthog/blob/d231ab1719020024c6219d10dc7775f6621fd72c/`
  - `pj:` = `https://github.com/PostHog/posthog-js/blob/posthog-js@1.447.6/packages/`
  - `ios:` = `https://github.com/PostHog/posthog-ios/blob/3.94.3/`
  - `and:` = `https://github.com/PostHog/posthog-android/blob/android-v3.76.1/`
- **Fixtures** (observed, web): [fixtures/](fixtures/). The project token is redacted to `phc_<redacted>`.

## 1. Endpoints

### Ingestion (rust/capture)

| Path | Handler | Used by | Source |
|---|---|---|---|
| `/e`, `/e/`, `/i/v0/e`, `/i/v0/e/`, `/capture`, `/track`, `/engage` (± slash) | `v0_endpoint::event` (GET, POST) | posthog-js: `/e/` until remote config sets `analytics.endpoint` = `/i/v0/e/` (observed) | ph:rust/capture/src/router.rs L291-353 |
| `/batch`, `/batch/` | same handler | Mobile SDKs (iOS and Android `/batch`, RN `/batch/`), server SDKs | router.rs L253-267 |
| `/s`, `/s/` | `v0_endpoint::recording` | Replay `$snapshot` from web and mobile. The remote config `sessionRecording.endpoint` can move it | router.rs L372-386 |
| `/i/v0/ai`, `/i/v0/ai/batch`, `/i/v0/ai/otel` | AI and LLM events | — | router.rs L275-289, L391-411 |
| `/i/v1/logs?token=` | OTLP/JSON logs | posthog-js logs (observed), posthog-ios logs | Not in rust/capture; served by a separate logs service (`rust/capture-logs`, not read) |

- **Deployment split:** one capture binary runs in one mode (`CaptureMode`: Events, Recordings, Ai, Import) and serves only that mode's routes (router.rs L423-444).
- **Recordings are a separate deployment.** `/i/v0/s` is not registered in rust/capture. We infer an ingress rewrite.
- **Exceptions have no route of their own.** `$exception` is split by event name to a different Kafka topic (ph:rust/capture/src/v0_request.rs L230-239).

### Config and flags

| Path | Method | Notes |
|---|---|---|
| `/array/{token}/config.js` | GET | Web, script variant |
| `/array/{token}/config` | GET | Web JSON fallback. iOS fetches it from `https://{us\|eu}-assets.i.posthog.com/array/{token}/config` (ios:PostHog/PostHogApi.swift L157-176) |
| `/flags/?v=2` (web, RN), `/flags?v=2` (iOS) | POST | Flags. `/decide` is gone from the current SDKs and from the server (`posthog/api/decide.py` no longer exists at the pinned commit) |

## 2. Headers and encoding

### Web

- **Gzip** comes from `fflate` gzipSync, or from native `CompressionStream` off the main thread when available.
- **Content-Type** is `text/plain` for gzip and `application/json` for uncompressed bodies.
- **No `Content-Encoding` header and no `compression` query param for gzip** (observed). posthog-js removes `compression` from the URL when it is `gzip-js` (pj:browser/src/request.ts L573-585).
- **base64 mode:** the body is `data=<urlencoded base64>` with `Content-Type: application/x-www-form-urlencoded` and `?compression=base64`. It is used when the server does not list gzip, and as the sendBeacon fallback when gzip fails (request.ts L120-160, L650).
- **lz64 is never sent** by 1.447.6. The server still accepts it.
- **Retries** add `?retry_count=N` (observed; pj:browser/src/retry-queue.ts L86-88).
- **Unload** uses `navigator.sendBeacon`. We observed `sec-fetch-mode: no-cors`, a gzip body, and `text/plain`.

### Mobile

- **iOS:** `Content-Type: application/json; charset=utf-8`, `Content-Encoding: gzip`, `User-Agent: posthog-ios/3.94.3` (ios:PostHog/PostHogApi.swift L85-107).
- **Android:** `User-Agent: <sdkName>/<version>`, gzip via an OkHttp interceptor (and:posthog/src/main/java/com/posthog/PostHogConfig.kt L487-490).
- **RN:** `Content-Encoding: gzip` unless `disableCompression` is set.

### Server decoding (ph:rust/capture/src/payload/types.rs L27-39, utils.rs L88-113, payload/common.rs L71-144)

- **Compression names:** `gzip`/`gzip-js`, `lz64`/`lz-string`, `base64`/`b64`.
- **Precedence:** the query `compression`, then the form field, then `Content-Encoding`.
- **Gzip sniffing:** gzip is also detected by magic bytes regardless of the hint. That is why posthog-js can omit the flag.
- **Gzip bombs** are rejected at a 20× ratio.
- **Payload location:** query `data=` for legacy GET, otherwise the body. Form `data=` has `' '` turned back into `'+'`.
- **Query params:** `sent_at` or `_` (ms), and `beacon=1` (returns 204). `ver` is ignored.

### Tokens

- **Analytics:** batch-level `api_key` (alias `token`), or per event `token` / `$token` / `api_key` / `properties.token`.
- **Mixed tokens:** different tokens in one batch is an error.
- **Validation:** tokens are rejected if they are over 64 characters or look like a personal API key (ph:rust/capture/src/token.rs L45-64).

## 3. Limits and responses

| Limit | Value | Source |
|---|---|---|
| Analytics body (wire) | 20 MB | router.rs L39 |
| Analytics body (decompressed) | 100 MB (5 × body) | setup.rs L219-222 |
| Replay body (wire) | 25 MB | router.rs L41 |
| Replay body (decompressed) | Kafka `message.max.bytes`, default 1,000,000 B | config.rs L619-620 |
| Client replay chunk | ~0.9 MB per `$snapshot` (`RECORDING_MAX_EVENT_SIZE`). Batches over ~6.3 MB (`SEVEN_MEGABYTES` × 0.9) are split | pj:…/lazy-loaded-session-recorder.ts L135; sessionrecording-utils.ts L183-187 |
| `$session_id` | ≤ 70 chars, `[A-Za-z0-9-]` | ph:rust/capture/src/events/recordings.rs L402-428 |
| distinct_id (replay) | cut to 200 chars | recordings.rs L389-391 |
| Web string property | 65,535 chars (replay exempt) | pj:browser/src/posthog-core.ts L368 |

### Responses (ph:rust/capture/src/v0_endpoint.rs, api.rs)

- **Success:** `200 {"status":"Ok"}`. With `beacon=1`: `204`.
- **Quota-limited analytics:** still `200 {"status":"Ok"}`, and the events are dropped silently (v0_endpoint.rs L51-58).
- **Quota-limited replay:** `200 {"status":"Ok","quota_limited":["recordings"]}` (L148-151). posthog-js then stops sending that batch key for 60 s (pj:browser/src/rate-limiter.ts L154-171).
- **Errors:**
  - 400: validation
  - 401: token
  - 408: body timeout
  - 413: too big
  - 429: billing or rate limit
  - 503: retryable sink error
  - 500: internal error
- **Remote config also carries quota:** `quotaLimited: ["recordings"]` and `sessionRecording: false` (ph:posthog/models/remote_config.py L313-324). The mobile SDKs check `quotaLimited` for `"mobile_recordings"` before they start replay (ios:PostHog/PostHogRemoteConfig.swift L342-343, L366-368).

## 4. Event JSON

### Analytics envelope (web `/e/` and `/i/v0/e/`, mobile `/batch`)

```json
{"api_key":"phc_…","sent_at":"2026-11-10T03:29:28.936Z",
 "batch":[{"uuid":"<uuidv7>","event":"$autocapture","timestamp":"…",
   "properties":{"distinct_id":"<uuidv7>","$session_id":"<uuidv7>","$window_id":"<uuidv7>",
     "$lib":"web","$lib_version":"1.447.6","$current_url":"…","$event_type":"click",
     "$elements_chain":"button:attr__id=\"btn-click\"…;div.card:…;body:…","$el_text":"…","token":"phc_…", "…":"~70 more"}}]}
```

Mobile events use the same `{event, distinct_id, properties, timestamp, uuid}` per event. `distinct_id` sits at the event top level on mobile and in properties on web. The mobile `/batch` envelope is `{api_key, batch, sent_at}` (ios:PostHog/PostHogApi.swift L184-188; ios:PostHog/Models/PostHogEvent.swift L92-107).

### Event types a RUM platform cares about (observed web, read mobile)

| Event | Key properties |
|---|---|
| `$pageview` / `$screen` (mobile) | `$current_url`, `$pathname`, `$pageview_id`, `$prev_pageview_*`; mobile `$screen_name` |
| `$pageleave` | `$prev_pageview_duration`, `$prev_pageview_max_scroll(_percentage)` |
| `$autocapture` | `$event_type` (click/change/submit), `$elements_chain` (a string because `elementsChainAsString`), `$el_text`, `$input_value` only for allowlisted inputs, `data-ph-capture-attribute-*` as plain props (observed `step: "first"`) |
| `$rageclick`, `$dead_click` | as autocapture |
| `$$heatmap` | `$heatmap_data: {<url>: [{x, y, target_fixed, type: click\|mousemove\|rageclick}]}` |
| `$web_vitals` | `$web_vitals_<FCP\|LCP\|CLS\|INP>_value` and `…_event` `{name, value, rating, delta, id, navigationType, attribution, $current_url, $session_id, $window_id, timestamp}` |
| `$exception` | `$exception_list[{type, value, mechanism{type, handled, synthetic, exception_id}, stacktrace{type, frames[{platform, filename, function, lineno, colno, in_app}]}}]`, `$exception_level`. Mobile adds `$exception_source` and `$debug_images` (iOS) |
| `$identify` | `$anon_distinct_id`, `$set`, `$set_once` |
| `$$client_ingestion_warning` | Client rate-limit drop notice |

## 5. `$snapshot`: replay chunking

### Web

```json
[{"uuid":"…","event":"$snapshot","timestamp":"…","sent_at":"…",
  "properties":{"$snapshot_bytes":26662,"$snapshot_data":[ <rrweb events> ],
    "$session_id":"<uuidv7>","$window_id":"<uuidv7>","$lib":"web","$lib_version":"1.447.6",
    "$snapshot_host":"posthog-capture.localhost","distinct_id":"…","token":"phc_…"}}]
```

- **The body is a bare array.** Each element carries its own `sent_at`.
- **Buffering:** the recorder fills a buffer with rrweb events. It flushes every 2 s (`RECORDING_BUFFER_TIMEOUT`), or when the buffer passes ~0.9 MB, or when the session or window changes (lazy-loaded-session-recorder.ts L135-136, L2285-2397).
- **Chunk size:** each flush becomes one `$snapshot` whose `$snapshot_bytes` is the estimated JSON size.
- **Batching:** the request queue then merges every queued `$snapshot` into one POST under `batchKey: 'recordings'` (observed: one POST held 2 `$snapshot` events).
- **Compressed events:** FullSnapshot (type 2) `data` and Mutation (type 3, source 0) `texts/attributes/removes/adds`, plus StyleSheetRule adds/removes, are each gzipped, turned into a latin1 string, and marked `cv: "2024-10"` (L382-409). Everything else stays plain, so ingestion can read clicks, URLs and console counts without decompressing.
- **Debug properties:** `$sdk_debug_replay_throttled_mutations_dropped` and `$sdk_debug_replay_oversized_mutations_dropped` are added when the SDK dropped data.

rrweb event types seen on web:

| Type | Seen as | Notes |
|---|---|---|
| 4 Meta | `{href, width, height}` | |
| 2 FullSnapshot | compressed | 5.8 KB JSON for the demo page |
| 3 Incremental | sources 0 Mutation, 1 MouseMove, 2 MouseInteraction, 3 Scroll, 5 Input | Input values masked |
| 5 Custom | `$remote_config_received`, `$session_options`, `$posthog_config`, `$recording_started`, `$pageview` | |
| 6 Plugin | `rrweb/network@1` (`{requests:[PerformanceEntry + method, status, requestHeaders, responseHeaders, requestBody, responseBody]}`), `rrweb/console@1` (`{level, payload[], trace[]}`) | |

### Server side (ph:rust/capture/src/events/recordings.rs)

- **Fields read:** `$session_id`, `$window_id`, `$snapshot_data`, `$snapshot_source`, `$snapshot_host`, `$lib`, `$lib_version`.
- **Missing fields:** `$window_id` defaults to the session id and `$snapshot_source` to `"web"` (L456-467).
- **Kafka message:** the whole HTTP batch becomes **one** Kafka message `$snapshot_items`, `{distinct_id, $session_id, $window_id, $snapshot_source, $snapshot_items: [...all rrweb events], $lib}`. It goes to `session_recording_snapshot_item_events`, keyed by session id (L561-674).

### Mobile `$snapshot`

```json
{"event":"$snapshot","distinct_id":"…","api_key":"phc_…","timestamp":"…","uuid":"…",
 "properties":{"$snapshot_source":"mobile","$snapshot_data":[ … ],"$session_id":"<uuidv7>",
   "$window_id":"<same as session id>","distinct_id":"…","$lib":"posthog-ios","$lib_version":"3.94.3"}}
```

- **Endpoint and body:** sent to `/s/` as a bare JSON array. Each event carries `api_key`, and there is no `sent_at`: the Android code comments "sent_at isn't supported by the snapshot endpoint" (and:posthog/src/main/java/com/posthog/internal/PostHogApi.kt L91-106).
- **No per-event gzip** inside the payload. The whole HTTP body is gzipped.
- **Batching:** one `$snapshot` per captured frame. The queue batches up to `maxBatchSize` (50), with only events sharing the same distinct id and session in one batch (ios:PostHog/QueueEndpoint+Factories.swift L59-63).
- **Wireframe schema:** see [../mobile-sdks/replay-wireframe-vs-screenshot.md](../mobile-sdks/replay-wireframe-vs-screenshot.md).

## 6. Fixtures

| File | What it shows |
|---|---|
| [web-remote-config.json](fixtures/web-remote-config.json) | Config request headers plus our mock config (server keys) |
| [web-flags-v2.json](fixtures/web-flags-v2.json) | `/flags/?v=2` body after identify |
| [web-e-pageview.json](fixtures/web-e-pageview.json) | First `$pageview` to `/e/`, full property list |
| [web-i-v0-e-batch.json](fixtures/web-i-v0-e-batch.json) | One of each: `$identify`-era `$autocapture`, `$rageclick`, `$$heatmap`, `$web_vitals`, manual event |
| [web-exceptions.json](fixtures/web-exceptions.json) | Four `$exception` mechanisms |
| [web-s-snapshot-raw.json](fixtures/web-s-snapshot-raw.json) | `/s/` as sent, with compressed `cv 2024-10` fields |
| [web-s-snapshot-decoded.json](fixtures/web-s-snapshot-decoded.json) | Decoded selection of every rrweb event type seen |
| [web-i-v1-logs-otlp.json](fixtures/web-i-v1-logs-otlp.json) | OTLP/JSON logs from console capture |
| [web-unload-beacons.json](fixtures/web-unload-beacons.json) | sendBeacon flush at navigation |
| [web-retry-500.json](fixtures/web-retry-500.json) | The same event retried with `retry_count` after forced 500s |

No mobile fixtures were captured. Mobile was read from source, not run; see the [mobile entry](../mobile-sdks/sdks-ios-android-rn.md).
