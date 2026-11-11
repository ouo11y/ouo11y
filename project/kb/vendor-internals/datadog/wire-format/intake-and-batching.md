# Intake endpoints, parameters, headers, compression and limits

- **SDKs:** browser 7.17.0, iOS 3.21.0, Android 3.16.0. Research date 2026-11-10.
- **Shorthands:**
  - `src:` = `https://github.com/DataDog/browser-sdk/blob/v7.17.0/packages/`
  - `ios:` = `https://github.com/DataDog/dd-sdk-ios/blob/3.21.0/`
  - `A:` = `https://github.com/DataDog/dd-sdk-android/blob/3.16.0/`
- `observed:` rows come from [fixtures](fixtures/index.md).

## Hosts

| SDK | Host | Source |
|---|---|---|
| Browser | `https://browser-intake-<site, dots→dashes except TLD>`, e.g. `browser-intake-datadoghq.com`, `browser-intake-us5-datadoghq.com`, `browser-intake-datadoghq.eu` | `src:js-core/src/transport/endpointBuilder.ts` |
| Browser with `proxy` | `<proxy>?ddforward=<url-encoded /api/v2/<track>?<params>>` | same |
| Mobile | The site's intake base plus `/api/v2/<track>`, or the feature's `customEndpoint` used as-is | `ios:DatadogSessionReplay/Sources/Feature/RequestBuilders/SegmentRequestBuilder.swift` |

**Tracks** (paths): `/api/v2/rum` (RUM events and SDK telemetry), `/api/v2/logs`, `/api/v2/replay` (segments and replay image resources), `/api/v2/profile`, `/api/v2/spans` (mobile traces), plus `exposures`, `flagevaluation` and `debugger` (`TrackType` in `endpointBuilder.ts`).

## Browser: URL parameters (no auth headers)

The browser cannot set custom headers on `sendBeacon`, so everything goes in the query string (`buildEndpointParameters`, `src:js-core/src/transport/endpointBuilder.ts`):

| Parameter | Tracks | Value (observed) |
|---|---|---|
| `ddsource` | all | `browser` (or `flutter` / `unity`) |
| `dd-api-key` | all | The client token (`pub…`) |
| `dd-evp-origin` | all | `browser` |
| `dd-evp-origin-version` | all | `7.17.0` |
| `dd-request-id` | all | A random UUID per request (dedup on the server) |
| `dd-evp-encoding` | when compressed | `deflate` |
| `batch_time` | rum | Client time in ms when the URL was built |
| `_dd.api` | rum | `fetch` / `beacon` / `manual` |
| `_dd.retry_count`, `_dd.retry_after` | rum, on retry | Count and last failed status |
| `application.id` | rum, replica only | Dual shipping |

- `ddtags` is **no longer a URL parameter** in v7. Tags (`sdk_version`, `env`, `service`, `version`) are a `ddtags` string **inside each event** (observed).
- Headers are only what the browser adds: `content-type: text/plain;charset=UTF-8` (string body) or `text/plain` (Blob, when compressed), or `multipart/form-data; boundary=----WebKitFormBoundary…` for replay.
- There is no CORS preflight by design (`httpRequest.ts` comment).

## Mobile: headers and parameters

| Item | iOS (observed) | Android (source) |
|---|---|---|
| `DD-API-KEY` | client token | client token |
| `DD-EVP-ORIGIN` / `-VERSION` | `ios` / `3.21.0` | `android` / version |
| `DD-REQUEST-ID` | UUID | UUID |
| `DD-IDEMPOTENCY-KEY` | 40 hex chars on RUM (SHA-1 of the body) | SHA-1 of the body on RUM |
| `User-Agent` | `<App>/<ver> CFNetwork (<device>; iOS/<ver>)` | OkHttp UA with app and OS |
| `ddsource` query | `ios` on rum and logs; **none** on replay | `android` on every request |
| Retry marker | `ddtags=retry_count:N,retry_after:<code>` (query) | same |
| `Content-Encoding` | `deflate` (body), except replay | `gzip` (body, release builds), except replay |

## Bodies

| Track | Browser | iOS | Android |
|---|---|---|---|
| rum | NDJSON (`\n` between events); optionally deflate | NDJSON + deflate (observed: 2 632 B wire, 13 415 B raw) | NDJSON + gzip |
| logs | NDJSON | **JSON array** + deflate (observed) | JSON array + gzip |
| replay | multipart: `segment` (deflate, filename `<session>-<start>`, `application/octet-stream`) + `event` (JSON object, `application/json`, filename `blob`). **One segment per request.** | multipart: N × `segment` (`file0`…) + `event` (JSON **array**). Several segments per request (observed 2). | as iOS |
| replay images | multipart `image` (named by hash) + `event` `{application:{id}, type:"resource"}` | separate resources feature | multipart `image` (WebP) + `event` |

The replay `event` metadata is the segment without `records`, plus `raw_segment_size` and `compressed_segment_size`:

```json
{"raw_segment_size":7272,"compressed_segment_size":2498,"start":1794280527163,"end":1794280531689,
 "creation_reason":"init","records_count":38,"has_full_snapshot":true,"index_in_view":0,"source":"browser",
 "application":{"id":"…"},"session":{"id":"…"},"view":{"id":"…"}}
```

**Compression:**
- The browser's deflate worker emits a zlib (RFC 1950) stream. Node's `inflateSync` decodes it with `Z_SYNC_FLUSH`.
- The **segment JSON is followed by `\n` before compression** on every platform ("Session Replay BE accepts compressed segment data followed by newline character", `ios:…/SegmentRequestBuilder.swift`).
- Observed ratios:
  - Browser segments: 2.9× (7 272 → 2 498 B).
  - Browser RUM batch: 9.1×.
  - iOS RUM: 5.1×.
  - iOS segment: 4.8×.

## Size limits

| Limit | Browser | iOS / Android | Server (docs) |
|---|---|---|---|
| Request | 16 KiB target (`RECOMMENDED_REQUEST_BYTES_LIMIT`), beacon split below it | 5 MB batch file | 5 MB payload |
| Event | < 256 KiB (`MESSAGE_BYTES_LIMIT`) | 1 MB (replay 10 MB) | 1 MB |
| Events per request | 50 | 1000 | — |
| Replay segment | 5 s or 60 000 B (`SEGMENT_DURATION_LIMIT`, `SEGMENT_BYTES_LIMIT`, `src:browser-rum/src/domain/segmentCollection/segmentCollection.ts#L15-L20`) | per view snapshot cadence | — |
| Late arrival | — | 18 h max batch age (RUM 24 h on Android) | 24 h ingestion delay |

Server limits: docs "RUM technical limitations", <https://docs.datadoghq.com/real_user_monitoring/> (accessed 2026-11-10). See [storage-and-retention.md](../apis/storage-and-retention.md).

## Responses

- The intake answers **202 Accepted**. Our capture server mimicked that.
- Mobile treats 202 as success. Browser treats anything not retryable as success.
- Retry rules per SDK are in [reliability-and-footprint.md](../browser-sdk/reliability-and-footprint.md), [ios.md](../mobile-sdks/ios.md) and [android.md](../mobile-sdks/android.md).

## Consequences for an ouo bridge or proxy

- **An ingest proxy is officially supported** (`proxy` / `customEndpoint`). To capture Datadog SDK traffic with our collector we would need:
  - A receiver that understands `ddforward` (browser) or `/api/v2/{rum,logs,replay}` (mobile).
  - Decoding for deflate or gzip, NDJSON or JSON arrays, and multipart.
- With a proxy, the browser **turns off `view_update` by default**. A receiver must still handle `view_update` from mobile and from browsers that opt in. Each partial update has to be merged into the stored view by `view.id` and `_dd.document_version`.
- `dd-request-id` / `DD-IDEMPOTENCY-KEY` give natural dedup keys for retries.
