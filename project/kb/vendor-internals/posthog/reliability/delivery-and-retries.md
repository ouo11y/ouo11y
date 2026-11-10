# PostHog delivery: batching, unload, retries, offline, quota, deletion

- **Versions:** posthog-js 1.447.6, plus the mobile SDKs listed in [../mobile-sdks/sdks-ios-android-rn.md](../mobile-sdks/sdks-ios-android-rn.md). That file holds the mobile delivery table; this file covers web in depth and compares.
- **Date:** 2026-11-10.
- **Source key:** `pj:` = `https://github.com/PostHog/posthog-js/blob/posthog-js@1.447.6/packages/`. "observed" = our capture runs (`examples/posthog-capture`).

## Web: the pipeline

```
capture() ─► before_send ─► RateLimiter (10/s, burst 100; skipped for $snapshot)
          ─► RequestQueue  (in memory, one bucket per url+batchKey, flush every 3 s)
          ─► request()     (gzip → fetch [keepalive ≤ ~51 KB budget] | XHR | sendBeacon)
          ─► on failure: RetryQueue (in memory, exponential backoff, online/offline aware)
pagehide ─► $pageleave + RequestQueue.unload() + RetryQueue.unload() via sendBeacon
```

| Mechanism | Detail | Source |
|---|---|---|
| Batch flush | Timer of `flush_interval_ms` (3000 default, clamped 250–5000) from the first enqueue. **No size trigger** | pj:browser/src/request-queue.ts L7, L24-40, L63-80 |
| Batching key | `batchKey` (for example `recordings`), else URL. Events and replay go in separate requests | request-queue.ts L98-130 |
| Transport | fetch first. `keepalive: true` while outstanding keepalive bytes stay under 0.8 × 64 KiB. XHR fallback | pj:browser/src/request.ts L54-61 |
| Unload | `pagehide` (or `unload`) → `$pageleave`, flush logs, `RequestQueue.unload()` and `RetryQueue.unload()` with transport `sendBeacon`. **Events are sent before recordings** ("events are more important, and recordings are bigger") | pj:browser/src/posthog-core.ts L1094-1099, L1460-1482; request-queue.ts L42-55 |
| Beacon size | When `sendBeacon` returns false (over the ~64 KiB quota), the batch is split in half recursively, then falls back to fetch without keepalive | request.ts L527-563 |
| Beacon encoding | gzip text/plain stays CORS-simple. If gzip fails on the beacon path, base64 form data | request.ts L650 |
| Replay at unload | A buffer held by a timing gate is parked in sessionStorage (`<name>_replay_pending_buffer`) for the next page in the tab | pj:…/lazy-loaded-session-recorder.ts L137-141, L2370 |

### Observed

- **Steady state.** Events are batched into `/i/v0/e/` every ~3 s, and replay into `/s/` every ~2–4 s.
- **Unload.** After `Page.navigate(about:blank)`, two requests arrived with `sec-fetch-mode: no-cors` (sendBeacon): `$$heatmap` to `/i/v0/e/` and a final `$snapshot` to `/s/`. Both were gzip, with no `beacon=1` parameter.
  - **`$pageleave` did not arrive** in that headless run.
  - A synthetic `pagehide` dispatch did produce `$pageleave` (fixture `web-unload-beacons.json`).
  - Unverified in a headed browser.

## Web: retries

| Rule | Value | Source |
|---|---|---|
| What is retried | Status 0 (network or CORS), 3xx, and 5xx. **4xx is not retried** (`statusCode !== 200 && (statusCode < 400 \|\| statusCode >= 500)`) | pj:browser/src/retry-queue.ts L94-106 |
| Max retries | 10. Status 0: 3 (`STATUS_CODE_ZERO_MAX_RETRIES`) | L11-15 |
| Backoff | `3000 × 2^n` ms, ±50% jitter, cap 30 min. The poll loop runs every 3 s, so delays round up to 3 s steps | L27-34, L44, L141-156 |
| `Retry-After` | Honoured: `max(backoff, Retry-After)` | L120-127; request.ts `readRetryAfter` |
| Marker | `?retry_count=N` on the URL | L86-88 |
| Offline | `navigator.onLine` false → queue held. The `online` event flushes immediately | L56-76 |
| Persistence | **None. The retry and request queues are in memory.** Page close sends what is left by beacon, once, best effort | L178-213 |

### Observed

**Forced 500s** (fixture `web-retry-500.json`):
- The same `$pageview` uuid was posted 3 times: t0, then t0+6.0 s with `retry_count=1`, then t0+15.0 s with `retry_count=2`.
- `sent_at` was refreshed on each attempt.
- The retry went to the original `/e/` URL, even after remote config had switched new events to `/i/v0/e/`.

**Offline 5 s:**
- Fetches failed with `ERR_INTERNET_DISCONNECTED`.
- After going back online, `/s/?retry_count=1` and `/i/v0/e/?retry_count=1` were delivered within 0.5–3.5 s.
- Nothing was lost (26 requests in total).

## Rate limits and quota

| Layer | Behaviour | Source |
|---|---|---|
| Client limiter | Token bucket of 10 events/s with burst 100. When an event is dropped, the client sends `$$client_ingestion_warning`. `$snapshot` skips the limiter | pj:browser/src/rate-limiter.ts L10-13; lazy-loaded-session-recorder.ts L2549 |
| Server quota, analytics | `200 {"status":"Ok"}`. Data is dropped silently, and the client cannot tell | ph:rust/capture/src/v0_endpoint.rs L51-58 (see [wire format](../wire-format/endpoints-and-payloads.md#3-limits-and-responses)) |
| Server quota, replay | `200 {"status":"Ok","quota_limited":["recordings"]}`. The client pauses that batch key for 60 s | rate-limiter.ts L154-171 |
| Remote config quota | `sessionRecording: false`, `quotaLimited: ["recordings"]`. Observed: the recorder script still loaded but did not start, and no `/s/` was sent | fixture-free run (run4), see [observed-capture.md](../web-sdk/observed-capture.md) |
| Mobile | iOS and Android honour 429 and `Retry-After`. iOS skips replay when remote config `quotaLimited` contains `mobile_recordings` | [mobile entry](../mobile-sdks/sdks-ios-android-rn.md#3-delivery-and-reliability) |

## Web vs mobile at a glance

| | Web | iOS | Android | RN |
|---|---|---|---|---|
| Persisted queue | no (memory) | yes, file per record | yes, file per record | yes (persisted array) |
| Survives app or page kill | beacon at pagehide only | yes | yes | yes |
| Retry cap | 10 (3 for network) | none | none | 3 then drop |
| Backoff | exp from 3 s, jitter, cap 30 min | linear 1 s steps, cap 30 s | exp, cap 30 s | fixed 3 s |
| 413 | not retried (4xx) | halve the batch | halve the batch | halve the batch |
| Replay separate queue | batchKey `recordings` | yes | yes | native |

## When data is deleted

- **On the client:**
  - Web queues are dropped at page close after one beacon attempt.
  - Native files are deleted after a 2xx or a non-retriable 4xx, or evicted FIFO beyond `maxQueueSize` (1000).
- **On the server:**
  - Events have no TTL in ClickHouse.
  - Recordings carry a retention period (30 d by default on cloud, 5 y self-hosted) that selects the S3 prefix, and deletion is crypto-shredding.
  - See [../storage/storage-and-ingestion.md](../storage/storage-and-ingestion.md#5-retention-and-deletion).
