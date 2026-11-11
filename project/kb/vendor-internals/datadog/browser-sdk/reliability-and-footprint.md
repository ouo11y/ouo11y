# Browser SDK: reliability and footprint

- **SDK:** v7.17.0. `src:` = `https://github.com/DataDog/browser-sdk/blob/v7.17.0/packages/`. Research date 2026-11-10.
- Overhead benchmarking is Step 5's job. This page gives sizes and documented or observed costs only.

## Bundle size (measured)

Method:
- `npm pack @datadog/<pkg>@7.17.0`, then the `bundle/` (CDN-style, minified) files.
- Sizes with `wc -c` and `gzip -9 | wc -c` on 2026-11-10.

| File | Raw | gzip -9 | Loaded when |
|---|---|---|---|
| `browser-rum/bundle/datadog-rum.js` | 196 525 B | **66 832 B** | Always. Includes the inline deflate worker source. |
| `browser-rum/bundle/chunks/datadogRecorder-*.js` | 32 807 B | 11 560 B | Only if the session is sampled for replay |
| `browser-rum/bundle/chunks/datadogProfiler-*.js` | 8 555 B | 3 386 B | Only if sampled for profiling |
| `browser-rum-slim/bundle/datadog-rum-slim.js` | 151 619 B | 51 195 B | Slim build without replay or profiler |
| `browser-logs/bundle/datadog-logs.js` | 61 568 B | 22 092 B | Always, if Logs is used |

- RUM, replay and Logs together cost about **100 KB gzip**: 66.8 + 11.6 + 22.1.
- The ESM npm entry points tree-shake somewhat, but the CDN bundle is the upper bound.
- npm tarball sizes: `browser-rum` 497 KB, `browser-rum-core` 625 KB, `browser-core` 329 KB, `browser-logs` 107 KB. They include ESM, CJS and maps, so they are not shipped sizes.

## CPU, memory and network

**Main thread:**
- Collectors and the replay serializer run on the main thread. Compression runs in a worker.
- The recorder emits serialization stats in replay telemetry (`serializationDuration`, `cssText` size; `src:browser-rum/src/domain/segmentCollection/buildReplayPayload.ts`).
- We did not profile.

**Replay network:**
- Docs say Session Replay averages under 100 kB/min (Step 4 RPL-j).
- Observed: about 39 KB/min on our small page ([observed-behaviour.md](observed-behaviour.md)).

**RUM network:**
- Uncompressed batches are cut at 16 KiB, so a busy page sends one request per 16 KiB.
- `compressIntakeRequests` gave a 9.1× ratio on our run (observed).

**Memory caps:**

| Cap | Value |
|---|---|
| Retry queue | 20 MiB per track |
| In flight | 80 KiB and 32 requests |
| Single event | 256 KiB |
| Pre-start API buffer | 500 calls |

## Batching and flush triggers

| Trigger | Value | Source |
|---|---|---|
| Time | 30 s after the first message (`FLUSH_DURATION_LIMIT`) | `src:browser-core/src/transport/flushController.ts#L15` |
| Message count | 50 (1 in a Worker environment) (`MESSAGES_LIMIT`) | same, L21 |
| Bytes | 16 KiB (`RECOMMENDED_REQUEST_BYTES_LIMIT`). Compressed bytes when compression is on. | `src:browser-core/src/transport/httpRequest.ts#L12` |
| Page may exit | `visibilitychange` → hidden, `beforeunload`, `pagehide`, page frozen | `src:browser-core/src/browser/pageMayExitObservable.ts` |
| Session expires | `session_expire` | `flushController.ts` |
| Event too large | Dropped with a console warning if it is 256 KiB or more (`MESSAGE_BYTES_LIMIT`) | `src:browser-core/src/transport/batch.ts#L14` |

- Views and other keyed events are **upserted**: only the newest version of a view sits in the batch.
- With `betaEnableViewUpdates`, a view already flushed becomes one aggregated `view_update` diff per batch. A full checkpoint is sent every 100 updates (`PARTIAL_VIEW_UPDATE_CHECKPOINT_INTERVAL`), and an ended view is always sent in full (`src:browser-rum-core/src/transport/startRumBatch.ts`).
- **Rate limit:** 3000 events per minute per event type (errors, actions, logs) (`src:browser-core/src/domain/eventRateLimiter/createEventRateLimiter.ts#L7`).

## Transport, retry and backoff

**Normal sends:**
- `fetch(url, {method: 'POST', body, mode: 'cors'})` with **no `keepalive`** (`httpRequest.ts#L183`).
- The body is a string or a `text/plain` Blob, chosen so there is no CORS preflight.

**Page-exit sends:**
- `navigator.sendBeacon` for every track that uses the batch (RUM, logs, telemetry).
- Payloads of 16 KiB or more are split at message boundaries. A single message over 16 KiB falls back to `fetch` (`splitPayloadForBeacon`, L101-L134).
- Observed: `_dd.api=beacon` on the exit batches.
- This corrects Step 4 TRN-c, which said "fetch with keepalive". v7.17.0 uses no keepalive at all.

**Replay segments:**
- Segments on exit: `flushSegment` uses `httpRequest.sendOnExit` (sendBeacon, falling back to fetch above the bytes limit) for every page-exit reason except `hidden`, and `send()` (fetch with retry) for `hidden`, because a hidden page is probably not closing ([segmentCollection.ts](https://github.com/DataDog/browser-sdk/blob/v7.17.0/packages/browser-rum/src/domain/segmentCollection/segmentCollection.ts#L113-L127)). Our capture saw fetch because `hidden` fired first.
- Replay image resources pending at exit are re-sent with `sendOnExit` except on `visibility_hidden` (`src:browser-rum/src/domain/segmentCollection/replayResourceCollection.ts`).

**Retry** (`src:browser-core/src/transport/sendWithRetryStrategy.ts`):
- Retried on status 0 while `navigator.onLine` is false, on 408, on 429, and on 5xx. An opaque response is never retried.
- When the transport is "down", requests queue in memory up to 20 MiB, and the head of the queue is retried with backoff starting at 1 s, doubling, capped at 60 s.
- On the first success, the whole queue drains.
- When the queue is full the payload is dropped and reported once as an SDK error.
- Retries add `_dd.retry_count` and `_dd.retry_after` (the last status) to the URL, RUM track only.
- `Retry-After` headers are ignored.

## What is lost and when

| Situation | Outcome |
|---|---|
| Page closes while requests are queued for retry | **Lost.** No IndexedDB or localStorage persistence of events. |
| Page closes with events in the batch | Sent by beacon. Best effort: the browser may drop beacons over its 64 KiB quota. |
| Tracking consent `not-granted` | Nothing is collected. Calls before init stay buffered (500 calls) until consent and init. |
| Session not sampled | Nothing is sent for the session's life. The decision sits in the cookie. |
| Event of 256 KiB or more | Dropped on the client |
| More than 3000 events per minute of one type | Dropped on the client |
| Intake | Rejects events over 1 MB, payloads over 5 MB, and events more than 24 h late (docs: [storage-and-retention.md](../apis/storage-and-retention.md)) |
