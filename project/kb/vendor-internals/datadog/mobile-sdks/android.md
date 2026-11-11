# Android SDK (dd-sdk-android): internals

- **SDK:** dd-sdk-android **3.16.0** (tag commit `dad23122`, 2026-10-29). Research date 2026-11-10.
- **Method:** read from source at the tag only. No Android hands-on: the Android emulator is reserved for another agent.
- **Shorthands:**
  - `A:` = `https://github.com/DataDog/dd-sdk-android/blob/3.16.0/`
  - `C/` = `dd-sdk-android-core/src/main/kotlin/com/datadog/android/`
  - `RUM/` = `features/dd-sdk-android-rum/src/main/kotlin/com/datadog/android/rum/`
  - `SR/` = `features/dd-sdk-android-session-replay/src/main/kotlin/com/datadog/android/sessionreplay/`
- Step 4 feature list: [datadog-mobile.md](../../../client-sdk-features/vendors/datadog-mobile.md).

## Architecture

**Modules** (`A:settings.gradle.kts`):
- Core: `dd-sdk-android-core`, `-internal`.
- Features: `-rum`, `-logs`, `-trace` (plus `-trace-otel`), `-ndk`, `-webview`, `-session-replay`, `-session-replay-material`, `-session-replay-compose`, `-flags`, `-profiling`.
- Integrations: OkHttp, Cronet, Apollo, Coil, Fresco, Glide, Compose, Rx, SQLDelight, Timber and others.

**How features plug in:**
- A feature implements `Feature` (`name`, `onInitialize`, `onStop`) or `StorageBackedFeature` (adds `requestFactory` and `storageConfiguration`).
- It registers through `FeatureSdkCore.registerFeature`. Each feature gets its own file storage (`A:C/api/feature/Feature.kt`, `StorageBackedFeature.kt`; `A:C/core/internal/SdkFeature.kt#L329-L338`).

**Threads** (`A:C/core/internal/CoreFeature.kt#L697-L736`):
- One `upload` scheduled thread.
- A back-pressured `storage` executor that does all disk writes: capacity 1024, policy `IGNORE_NEWEST` by default.
- A single `context` thread.
- On stop, the SDK drains for up to 10 s.

## Configuration (core)

`Configuration.Builder(clientToken, env, variant, service)` (`A:C/core/configuration/Configuration.kt`):

| Option | Default | Effect |
|---|---|---|
| `setBatchSize` | MEDIUM | Batch window: SMALL 3 s, MEDIUM 10 s, LARGE 35 s |
| `setUploadFrequency` | AVERAGE | Base step: FREQUENT 0.5 s, AVERAGE 2 s, RARE 5 s. Delay bounds are ×1 / ×5 (start) / ×10. |
| `setBatchProcessingLevel` | MEDIUM | Batches per upload cycle: 1 / 20 / 100 |
| `useSite` | US1 | |
| `setProxy` | none | OkHttp proxy and authenticator |
| `setEncryption` | null | Encrypted batch files |
| `setPersistenceStrategyFactory` | null (files) | Replace file storage |
| `setCrashReportsEnabled` | **true** | JVM crash handler |
| `setBackpressureStrategy` | 1024 / IGNORE_NEWEST | |
| `setUploadSchedulerStrategy` | default | Custom upload timing |
| `setFirstPartyHosts` | empty | Hosts get DATADOG + TRACECONTEXT headers (B3 and B3MULTI optional) |
| `setUseDeveloperModeWhenDebuggable` | false | Debug builds: sample 100, SMALL batches, FREQUENT uploads |

RUM defaults (`A:RUM/internal/RumFeature.kt#L983-L1027`):

| Option | Default |
|---|---|
| sessionSampleRate | 100 |
| telemetrySampleRate | 20 |
| trackUserInteractions | **on** |
| view tracking | `ActivityViewTrackingStrategy` |
| long tasks | 100 ms |
| trackFrustrations | true |
| trackBackgroundEvents | false |
| trackNonFatalAnrs | only below Android 11 |
| vitals | AVERAGE = 500 ms |
| slow frames | 16.67 ms / frozen 700 ms, 1000 records per view |

**Session Replay defaults** (`A:SR/SessionReplayConfiguration.kt#L52-L87`):

| Option | Default |
|---|---|
| sample rate | 100 |
| textAndInputPrivacy | MASK_ALL |
| imagePrivacy | MASK_ALL |
| touchPrivacy | HIDE |
| startRecordingImmediately | true |
| dynamicOptimizationEnabled | true |

**Trace sampling** (OkHttp `TracingInterceptor`): rate 100, injection `SAMPLED`. The effective rate is combined with the RUM session rate and reported as `_dd.rule_psr`.

## Storage, upload and retry

| Item | Value | Source |
|---|---|---|
| Location | `cacheDir/datadog-<instanceId>/<feature>-v2` (granted) and `<feature>-pending-v2` | `A:C/core/internal/persistence/file/advanced/FeatureFileOrchestrator.kt#L76-L78` |
| File format | TLV blocks: 2-byte type (event `0x00`, meta `0x01`), 4-byte length | `A:C/core/internal/persistence/file/batch/PlainBatchFileReaderWriter.kt` |
| Max batch | 5 MB, 1000 items, 1 MB per event | `A:C/core/internal/persistence/file/FilePersistenceConfig.kt#L22-L24` |
| Max age | 18 h; RUM overrides to **24 h**; Session Replay records 12 h; replay resources 48 h | same #L25; `A:RUM/internal/RumFeature.kt#L421-L423`; `A:SR/internal/SessionReplayFeature.kt#L505-L510`; `ResourcesFeature.kt#L65-L70` |
| Disk cap | 512 MB per orchestrator | `FilePersistenceConfig.kt#L26` |
| Rotation | Write while the file is younger than 0.95 × window; upload when older than 1.05 × window | `BatchFileOrchestrator.kt` |
| Upload conditions | Network available; battery full, charging, external power or > 10 %; not in power-save mode | `A:C/core/internal/data/upload/DataUploadTask.kt` |
| Backoff | After a 202, the delay drops to the minimum. Otherwise it grows ×1.10 up to the maximum. An `IOException` waits a fixed 60 s. | `DefaultUploadSchedulerStrategy.kt#L26-L65` |
| Retried | 408, 429, 500, 502, 503, 504, 507, network and DNS errors | `DataOkHttpUploader.kt#L211-L234` |
| Dropped | 400, 401, 403, 413, redirects, unknown codes | same |
| Consent | NOT_GRANTED writes nothing. PENDING data moves to granted, or is deleted. | `ConsentAwareStorage.kt` |
| App kill | Events already on disk are sent on the next launch within the age limit. Events still in the in-memory executor queue are lost. No dedicated kill hook was found. | inference from the above |

## Wire format

| Track | Endpoint | Body | Compression |
|---|---|---|---|
| RUM | `/api/v2/rum?ddsource=android` | NDJSON, `text/plain;charset=UTF-8` | gzip, `Content-Encoding: gzip` (release builds) |
| Logs | `/api/v2/logs?ddsource=android` | JSON array, `application/json` | gzip |
| Traces | `/api/v2/spans` | NDJSON | gzip |
| Replay | `/api/v2/replay` | multipart: `segment` parts (`file<i>`), each a zlib-deflated segment JSON plus `\n`; an `event` part with a JSON array of metadata | per segment (deflate level 6), no body gzip |
| Replay images | `/api/v2/replay` | multipart `image` part plus `event` `{type: resource, application_id}` | WebP |

- Headers: `DD-API-KEY`, `DD-EVP-ORIGIN`, `DD-EVP-ORIGIN-VERSION`, `DD-REQUEST-ID`. RUM adds `DD-IDEMPOTENCY-KEY`, the SHA-1 of the body.
- Retries add `ddtags=retry_count:N,retry_after:<previous status>` to the URL.
- Sources: `A:C/api/net/RequestFactory.kt#L38-L78`, `A:RUM/internal/net/RumRequestFactory.kt`, `A:SR/internal/net/SegmentRequestBodyFactory.kt`.
- Same layout as iOS (observed there). The differences are the compression (gzip vs deflate) and that iOS sends no `ddsource` on replay.

## Sessions and sampling

- 15 min inactivity, 4 h maximum (`A:RUM/internal/domain/scope/RumSessionScope.kt#L338-L339`).
- **Deterministic sampling.** Take the last UUID group as hex, multiply by 1111111111111111111, and keep the session if the result is below `MAX_ULONG × rate / 100`.
  - This is the same formula as the browser (`A:dd-sdk-android-internal/.../SessionSamplingIdProvider.kt`, `A:C/core/sampling/DeterministicSampler.kt`).
- Session Replay uses the combined rate `rum × sr / 100` (`A:SR/internal/SessionReplayFeature.kt#L356-L367`).

## Session Replay recorder

**Capture:**
- Triggered by `ViewTreeObserver.OnDrawListener` and debounced to 64 ms.
- With dynamic optimization, capture time is limited to 100 ms per second (`RecordingTimeBank`).
- The tree walk runs on the main thread. Records are built on the `sr-event-processing` thread.
- A full snapshot is taken on a new view, a rotation, or every 3 s. Otherwise mutations are sent (`A:SR/internal/processor/RecordedDataProcessor.kt#L101`, #L226).

**Touches:** sampled every 16 ms and flushed every 160 ms.

**Images:**
- WebP quality 75. The id is the MD5 of the compressed bytes.
- Sent hashes are remembered for 30 days. There is a 4 MB LRU cache.

**Mappers:**
- Core: TextView, EditText, Button, ImageView, CheckBox, RadioButton, Switch, SeekBar, ProgressBar, NumberPicker, WebView, ActionBar.
- Material module: Card, Chip, Slider, Tab.
- Compose module: semantics-based mappers.
