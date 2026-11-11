# iOS SDK (dd-sdk-ios): internals and a simulator capture

- **SDK:** dd-sdk-ios **3.21.0** (tag commit `36ca2cfd`, 2026-10-29), through Swift Package Manager. Research date 2026-11-10.
- **Shorthand:** `ios:` = `https://github.com/DataDog/dd-sdk-ios/blob/3.21.0/`
- **Hands-on:**
  - A UIKit app ([examples/datadog-capture/ios](../../../../../examples/datadog-capture/ios/project.yml)) on an iOS 27.0 simulator named `step6-datadog`, deleted afterwards.
  - Every feature's `customEndpoint` pointed at the local capture server.
  - Taps came from a timer "autopilot" because the simulator panel was not available to this agent. So touch records were not exercised.
- Step 4 feature list: [datadog-mobile.md](../../../client-sdk-features/vendors/datadog-mobile.md).

## Architecture

**Modules:**
- `DatadogInternal` holds shared protocols, the message bus, network instrumentation and telemetry.
- `DatadogCore` is the core: storage, upload and context.
- Features are separate SPM products: `DatadogRUM`, `DatadogLogs`, `DatadogTrace`, `DatadogSessionReplay`, `DatadogCrashReporting` (PLCrashReporter), `DatadogWebViewTracking`, `DatadogFlags`, `DatadogProfiling` (`ios:Package.swift`).

**How features plug in:**
- Each feature conforms to `DatadogRemoteFeature` (it has storage and a `requestBuilder`) or to `DatadogFeature` (bus only).
- Features register with the core (`ios:DatadogInternal/Sources/DatadogFeature.swift`).
- They exchange context and messages on the core's message bus. For example, RUM publishes its view and session context, and Session Replay and Logs read it.

**Threads:**
- Writes are async on per-feature queues. Uploads run on a background upload worker per feature.
- Session Replay snapshots the view tree on the main thread, then processes on `com.datadoghq.session-replay.processors` (utility QoS) (`ios:DatadogSessionReplay/Sources/Feature/RecordingComponents.swift#L55`).
- Screen changes are aggregated and delivered at most every 0.1 s (`minimumDeliveryInterval: 0.1`, same file L89 and L161).

## Configuration (core)

`Datadog.Configuration(clientToken:env:site:service:version:bundle:batchSize:uploadFrequency:proxyConfiguration:encryption:serverDateProvider:batchProcessingLevel:backgroundTasksEnabled:remoteConfiguration:)` (`ios:DatadogCore/Sources/DatadogConfiguration.swift#L212`).

| Option | Default | Effect |
|---|---|---|
| `site` | `.us1` | Intake host. `customEndpoint` per feature overrides it. |
| `service` | bundle id | |
| `batchSize` | `.medium` | Mean file age before a batch is closed: small 3 s, medium 10 s, large 35 s (`ios:DatadogCore/Sources/PerformancePreset.swift#L52-L58`) |
| `uploadFrequency` | `.average` | Base upload delay: frequent 0.5 s, average 2 s, rare 5 s. Factors: initial ×5, min ×1, max ×10, change rate 0.1. Average therefore ranges 2–20 s, starting at 10 s (L61-L100). |
| `batchProcessingLevel` | `.medium` | Batches uploaded per cycle |
| `proxyConfiguration` | nil | `URLSessionConfiguration.connectionProxyDictionary` |
| `encryption` | nil | `DataEncryption` hook for on-disk batches |
| `serverDateProvider` | `DatadogNTPDateProvider` | NTP time sync (Kronos) used to correct `date` |
| `backgroundTasksEnabled` | false | Upload inside a `UIApplication` background task |
| `remoteConfiguration` | nil | CDN JSON fetched at start and cached |
| `trackingConsent` (on `initialize`) | **required argument** | `.granted`, `.notGranted` or `.pending` |

RUM, Logs and Session Replay options (sample rates, predicates, privacy levels) are listed in Step 4. Notable defaults read at this tag:

| Option | Default |
|---|---|
| `RUM.Configuration.sessionSampleRate` | 100 |
| `telemetrySampleRate` | 20 |
| `longTaskThreshold` | 0.1 s |
| `appHangThreshold` | nil (off) |
| `trackWatchdogTerminations` | false |
| `uiKitViewsPredicate` / `uiKitActionsPredicate` | nil (no automatic views or taps) |
| `SessionReplay.Configuration.replaySampleRate` | **100** (`.maxSampleRate`) |
| Replay privacy: `textAndInputPrivacyLevel` | `.maskAll` |
| Replay privacy: `imagePrivacyLevel` | `.maskAll` |
| Replay privacy: `touchPrivacyLevel` | `.hide` |
| Replay feature flag `.swiftui` | false |

Sources: `ios:DatadogRUM/Sources/RUMConfiguration.swift#L684-L706` and `ios:DatadogSessionReplay/Sources/SessionReplayConfiguration.swift#L76-L92`, #L131.

## Storage, upload and retry

| Item | Value | Source |
|---|---|---|
| Location | `Library/Caches/com.datadoghq/v2/<sdk-instance-uuid>/<feature>/v2` (granted) and `.../intermediate-v2` (pending consent) | `ios:DatadogCore/Sources/Core/Storage/Directories.swift`; `Files/Directory.swift#L185` |
| Max batch file | 5 MB ("matches the server's 5 MB per-batch limit") | `PerformancePreset.swift#L103` |
| Max events per batch | 1000 | L108 |
| Max event | 1 MB (Session Replay: 10 MB) | L109; `ios:DatadogSessionReplay/Sources/SessionReplay.swift#L65` |
| Max directory | 512 MB per feature | L104 |
| Max batch age | 18 h (Session Replay records 12 h, replay resources 48 h) | L107; `SessionReplayFeature.swift#L58`; `ResourcesFeature.swift#L37` |
| Upload blockers | No network; battery ≤ 10 % and not charging; Low Power Mode | `ios:DatadogCore/Sources/Core/Upload/DataUploadConditions.swift#L20-L63` |
| Retried | 408, 429, 500, 502, 503, 504, 507, network errors | `ios:DatadogCore/Sources/Core/Upload/DataUploadStatus.swift#L39-L56` |
| Dropped (batch deleted) | 202 (success), 400, 401, 403, 413, unexpected codes | same |
| Compression | Whole body deflate, `Content-Encoding: deflate` (Session Replay compresses each segment instead) | `ios:DatadogInternal/Sources/Upload/URLRequestBuilder.swift#L167-L176` |

## What the simulator capture showed (observed)

Fixtures: [../wire-format/fixtures/ios/](../wire-format/fixtures/index.md).

**RUM request:**
- `POST /api/v2/rum?ddsource=ios`, `Content-Type: text/plain;charset=UTF-8`, `Content-Encoding: deflate`.
- NDJSON body: 2 632 B on the wire, 13 415 B inflated.
- Headers: `DD-API-KEY`, `DD-EVP-ORIGIN: ios`, `DD-EVP-ORIGIN-VERSION: 3.21.0`, `DD-REQUEST-ID`, `DD-IDEMPOTENCY-KEY` (40 hex chars, a SHA-1).
- `User-Agent: DDCapture/1.0 CFNetwork (iPhone; iOS/27.0)`.

**Logs request:** `/api/v2/logs?ddsource=ios`, `application/json`, deflate. The body is a **JSON array**, not NDJSON.

**Replay request:**
- `/api/v2/replay` with **no query string** and multipart.
- One request can carry **several `segment` parts**, named `file0`, `file1`, …. The `event` part is a **JSON array** of segment metadata.

**Events:**
- `view` and `view_update`: the mobile SDK sends partial updates by default.
- `vital`: `type: app_launch`, `name: time_to_initial_display`, `startup_type: cold_start`.
- `resource`: `type: native`, from URLSession.
- Also `long_task`, `error`, `action` (custom) and `telemetry`.
- RUM events carry `device`, `os` and `build_version`.
- The native resource's `_dd.trace_id` was a **128-bit** hex id (`6af290ad00000000…`, which looks like a 32-bit timestamp, zeros, then 64 random bits). The browser uses 64-bit ids, so the two SDKs differ.

**Upload timing:** with `batchSize: .small` and `uploadFrequency: .frequent`, the first upload arrived about 18 s after launch. Later uploads came every few seconds.

**Replay records:** see [mobile-replay-wireframes.md](mobile-replay-wireframes.md). With default privacy, text became `x` runs, the text field became `***`, and the SF Symbol image became a placeholder labelled "Image".

**Replay bandwidth:** 4 requests, 8 121 B, over 14.4 s of replay. About **34 KB/min** for a simple static screen. Docs give 12 KB/s on average for real apps.

**Offline and kill test:**
1. Stopped the capture server.
2. Launched the app with the autopilot and let it run 25 s, so every upload failed.
3. Killed the app (`simctl terminate`).
4. Restarted the server and launched the app again without the autopilot.

**Result:**
- The first requests after relaunch carried the **killed session's** data: RUM, logs and 6 replay requests, all with the old `session.id`.
- Then a **new session** started. A relaunch within 1 minute did not continue the old session.
- So batches written to disk survive a crash or kill and are sent on the next launch, within the 18 h (replay 12 h) age limit.
- No retry markers were present: the first try in the new process is not a retry.

## Session lifecycle

- `sessionTimeoutDuration = 15 * 60`, `sessionMaxDuration = 4 * 60 * 60` (`ios:DatadogRUM/Sources/RUMMonitor/Scopes/RUMSessionScope.swift#L13-L15`).
- `_dd.session.session_precondition: user_app_launch` on the first session (observed).
- Sampling is decided per session id. Session Replay and traces are sampled relative to RUM (Step 4).
