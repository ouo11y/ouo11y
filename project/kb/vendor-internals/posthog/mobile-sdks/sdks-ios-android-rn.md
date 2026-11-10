# PostHog mobile SDKs: architecture, configuration, delivery

- **Versions:**
  - posthog-ios **3.94.3** (tag `3.94.3`)
  - posthog-android **3.76.1** (tag `android-v3.76.1`, core `com.posthog:posthog`)
  - posthog-react-native **4.85.4** with **@posthog/react-native-plugin 2.13.0**, both in the posthog-js monorepo at tag `posthog-js@1.447.6`
- **Date:** 2026-11-10.
- **Method: read from source only.** No simulator run was done; the hands-on was optional and time went to the web capture. Every claim below is read from code unless marked *(inferred)*.
- **Builds on:** [Step 4 posthog-mobile.md](../../../client-sdk-features/vendors/posthog-mobile.md).
- **Source keys:**
  - `ios:` = `https://github.com/PostHog/posthog-ios/blob/3.94.3/`
  - `and:` = `https://github.com/PostHog/posthog-android/blob/android-v3.76.1/`
  - `pj:` = `https://github.com/PostHog/posthog-js/blob/posthog-js@1.447.6/packages/`

## Corrections to Step 4

1. **`maxRetries` (default 3) does not bound event or replay delivery on iOS and Android.** It only bounds push-subscription retries (ios:PostHog/PostHogConfig.swift L90-98; and:posthog/src/main/java/com/posthog/PostHogConfig.kt L138-145). Native event queues retry retriable failures without limit; only `maxQueueSize` FIFO eviction bounds them. RN, by contrast, drops a batch after 3 failed retries (see Delivery).
2. **iOS replay sends no incremental mutations.** Every changed frame is a full snapshot (type 2) of the whole tree (ios:PostHog/Replay/PostHogReplayIntegration.swift L833-873). Android wireframe mode does send rrweb Mutation diffs.
3. **RN `captureLog` (default true) applies on iOS too.** The plugin maps it to `captureLogs` (pj:react-native-plugin/ios/PosthogReactNativePlugin.swift L434-435).
4. **Android minimum SDK conflict.** The build uses `MIN_SDK = 23` (and:buildSrc/src/main/java/PosthogBuildConfig.kt L39), but the README table says API 21. Replay needs API 26: `isSupported()` checks for O (and:posthog-android/src/main/java/com/posthog/android/replay/PostHogReplayIntegration.kt L3287-3288).

## 1. Architecture

### iOS

- **`PostHogSDK`** owns three queues: events (`queue`), replay (`replayQueue`) and logs (`logsQueue`) (ios:PostHog/PostHogSDK.swift L81-84, L295-306).
  - `capture` routes `$snapshot` to the replay queue (L1618-1704).
  - Properties are built in `buildProperties` (L700-810).
  - `flush()` flushes all three queues (L847-854).
  - The SDK flushes on entering the background (L370-371).
- **`PostHogQueue<Record>`** is one generic queue, parameterised by a `QueueEndpoint` with `.batch`, `.snapshot` and `.logs` factories (ios:PostHog/QueueEndpoint+Factories.swift L20-118).
- **`PostHogFileBackedQueue`** stores one file per record, named with a UUIDv7 so that lexical order is time order (ios:PostHog/PostHogFileBackedQueue.swift L99-118).
- **`PostHogReplayQueue`** wraps the snapshot queue plus a disk buffer, `posthog.replayBufferFolder`, used while a minimum-duration or trigger gate is pending. `migrateBufferToQueue` moves the buffer into the queue once the gate passes (ios:PostHog/Replay/PostHogReplayQueue.swift L65-90).
- **Integrations** (ios:PostHog/PostHogConfig.swift L593-640):
  - error-tracking autocapture
  - screen views
  - app lifecycle
  - tracing headers
  - replay, with URLSession network and console plugins
  - surveys
  - autocapture
  - rage click
  - push
- **Vendored dependencies:** libwebp (`phlibwebp`) and PLCrashReporter (`PHPLCrashReporter`). There are no third-party runtime dependencies (ios:Package.swift L26-60).

### Android

- **Core module `posthog`** (JVM):
  - `PostHog.kt`, with the replay queue on the SNAPSHOT endpoint (L126, L237-241)
  - `internal/PostHogQueue.kt`, `internal/PostHogApi.kt` (OkHttp), `internal/PostHogRemoteConfig.kt`, `internal/PostHogSessionManager.kt`
  - rrweb model classes `internal/replay/RR*.kt`
  - `PostHogOkHttpInterceptor` (network plugin)
- **Android module `posthog-android`:**
  - `PostHogAndroid.kt` sets the storage directories (L192-197)
  - `replay/PostHogReplayIntegration.kt` (3,905 lines). Capture is driven by a `NextDrawListener` per decor view and throttled. Windows are tracked with `curtains` (L395-440, L833-840).
  - Lifecycle observer: `onStop` sends "Application Backgrounded" and flushes (internal/PostHogLifecycleObserverIntegration.kt L106-120).
  - Logcat capture, the native crash integration, element interactions and network status.
- **Runtime dependencies:** gson 2.10.1, okhttp 4.12.1, okio 3.11.0, androidx lifecycle-process 2.6.2, androidx core, and curtains (and:posthog/build.gradle.kts L104-111; and:posthog-android/build.gradle.kts L111-116).

### React Native

- **Pure-JS core.** `posthog-react-native` extends `PostHogCore` (pj:core/src/posthog-core-stateless.ts). It persists to a file (default) or memory, sends `/batch/`, and flushes on AppState change (pj:react-native/src/posthog-rn.ts L487, L602-635).
- **Native features come from the plugin.** Replay, native crashes and logcat come from `@posthog/react-native-plugin`. The plugin boots the native iOS and Android SDKs with the JS session id and distinct id, and sets `sdkName = "posthog-react-native"` (pj:react-native-plugin/ios/PosthogReactNativePlugin.swift L405-470; …/android/…/PosthogReactNativePluginModule.kt L115-247).
- **`$snapshot` events come from the native queues** to `/s/`. *(inferred: JS never sends snapshots itself)*
- **The plugin forces screenshot mode** on both platforms (iOS L410, Android L205).

## 2. Configuration relevant to RUM

### Transport and core

| Option | iOS | Android | RN | Effect |
|---|---|---|---|---|
| `host` | `https://us.i.posthog.com` | same | same | Ingestion host |
| `flushAt` | 20 (tvOS 5) | 20 | 20 | Flush when the queue reaches N |
| `flushIntervalSeconds` | 30 | 30 | `flushInterval` 10,000 ms | Timer flush |
| `maxQueueSize` | 1000 (tvOS 100) | 1000 | 1000 | Oldest record dropped beyond this |
| `maxBatchSize` | 50 | 50 | 100 | Events per request |
| `maxRetries` | 3 (push only) | 3 (push only) | `fetchRetryCount` 3, `fetchRetryDelay` 3000 ms | See Delivery |
| `dataMode` | `.any` (`.wifi` pauses the queue off Wi-Fi) | — | — | ios:PostHog/PostHogQueue.swift L494-511 |
| compression | gzip | gzip | `disableCompression` false | Whole-body gzip |
| request timeout | 10 s | OkHttp default *(inferred)* | 10,000 ms | |
| `captureApplicationLifecycleEvents` | true | true | `captureAppLifecycleEvents` true | Application Installed / Updated / Opened / Backgrounded |
| `captureScreenViews` | true | true | `autocapture.captureScreens` true | `$screen` events |
| `captureElementInteractions` | false | false | `captureTouches` false | Autocapture of taps |
| `personProfiles` | identifiedOnly | IDENTIFIED_ONLY | identified_only | |
| `optOut` | false | false | `defaultOptIn` true | |
| `encryption` | — | null (wraps queue file streams) | — | and:…/internal/PostHogQueue.kt L71 |

Sources: ios:PostHog/PostHogConfig.swift L25-518; and:…/PostHogConfig.kt L64-631; pj:core/src/posthog-core-stateless.ts L437-451.

### Session replay

| Option | iOS | Android | RN | Effect |
|---|---|---|---|---|
| enable | `sessionReplay` false | false | `enableSessionReplay` false | Off by default |
| `maskAllTextInputs` | true | true | true | |
| `maskAllImages` | true | true | true | Masked images keep their frame and drop `base64` |
| `maskAllSandboxedViews` | true | — | true (iOS) | Masks system pickers and similar views |
| `captureTouches` | true | true | true | Type 3, source 2 events |
| `captureNetworkTelemetry` | true (URLSession swizzle) | via `PostHogOkHttpInterceptor` | true (iOS) | `rrweb/network@1`: timing, status and size only |
| screenshot mode | `screenshotMode` false | `screenshot` false | **forced true** | Wireframe is the native default |
| scale | nil = 1 px per point (clamp 0.1–1.0 × native) | null = 1 px per dp | Android only | |
| quality | fixed 0.3 (WebP, JPEG fallback) | 30 (WebP) | 30 | |
| throttle | `throttleDelay` 1 s (min 0.05 s) | `throttleDelayMs` 1000 | 1000 | At most one frame per throttle interval |
| console | `captureLogs` false | `captureLogcat` true | `captureLog` true | `rrweb/console@1` |
| `sampleRate` | nil (remote, else 100%) | null | passed through | Deterministic per session id |

Remote config keys honoured on mobile: `endpoint`, `sampleRate`, `minimumDurationMilliseconds`, `linkedFlag`, `eventTriggers`, `consoleLogRecordingEnabled` (ios:PostHog/PostHogRemoteConfig.swift L339-409).

Sources: ios:PostHog/Replay/PostHogSessionReplayConfig.swift L16-142; and:…/replay/PostHogSessionReplayConfig.kt; pj:react-native/src/types.ts L170-290.

### Errors

| Option | iOS | Android | RN |
|---|---|---|---|
| exception autocapture | `errorTrackingConfig.autoCapture` false | false | per-option flags |
| native crashes | via PLCrashReporter when autoCapture is on | `captureNativeCrashes` false (NDK tombstones, API 31+) | via plugin |
| `inAppIncludes/Excludes`, `inAppByDefault` | yes, true | — | — |
| exception steps | 32 KB, on | same | — |

- **iOS crash flow:** a crash is written by PLCrashReporter and sent as a fatal `$exception` on the next launch (`$exception_source: "ios.crash_reporter"`, ios:PostHog/ErrorTracking/PostHogCrashReportProcessor.swift L25-40; PostHogSDK.swift L1636-1639).
- **Android uncaught exceptions:** the handler writes to the disk queue, calls `flush()` as a last chance, then chains to the previous handler (and:…/errortracking/PostHogErrorTrackingAutoCaptureIntegration.kt L260-284).
- **Android NDK crashes** are read from `ApplicationExitInfo` on the next start.

## 3. Delivery and reliability

| Aspect | iOS | Android | RN |
|---|---|---|---|
| Storage | Application Support, one file per record (UUIDv7 name). Folders `posthog.queueFolder.<uuid>`, `posthog.replayFolder.<uuid>`, `posthog.replayBufferFolder`, `posthog.logsFolder` (ios:PostHog/PostHogStorage.swift L20-26, L232-238) | `cacheDir/posthog-disk-queue/<token>/`, `posthog-disk-replay-queue/`, `posthog-disk-logs-queue/`, files `<uuid>.event`, optionally encrypted (and:…/PostHogAndroid.kt L192-197; …/internal/PostHogQueue.kt L60-96) | Persisted array per queue, not file per event (pj:core/src/posthog-core-stateless.ts L1295-1311) |
| Flush triggers | depth ≥ flushAt, timer, reachability regained, background, manual | timer, network available, `onStop`, flushAt | flushAt, AppState change, timer |
| Retriable | network error, 408, 429, 500, 502, 503, 504, any 3xx | IOException, 408, 429, 500, 502, 503, 504 | network, 408, 429, ≥500 |
| Backoff | **linear** `min(n × 1 s, 30 s)`, or `Retry-After` when larger (unbounded for events and replay, clamped to 300 s for logs) | **exponential** `min(2^(n-1) s, 30 s)`, or `Retry-After` | fixed 3 s × 3 attempts |
| Retry limit | none, files kept until sent or evicted | none | **batch dropped after 3 retries** for non-network errors |
| 413 | halve the batch cap and flushAt, retry the same records. A single record is deleted | same. The code comments this as a workaround because PNG images exceed the Kafka limit | `maxBatchSize = floor(n/2)` |
| Other 4xx | delete | delete | drop |
| Offline | queue paused while unreachable | waits for the network callback | — |
| App kill | files stay on disk and are sent next launch *(inferred from the file queue)* | same | persisted queue |
| Quota | remote config `quotaLimited` contains `mobile_recordings` → replay not started | — | — |

Sources: ios:PostHog/PostHogQueue.swift L156-235, L334-369, L448-511; ios:PostHog/QueueEndpoint+Factories.swift L10-37; ios:PostHog/PostHogSDK.swift L25-26; and:…/internal/PostHogQueue.kt L99-112, L300-303, L371-408, L516-566; and:…/internal/EndpointSpec.kt L129-133; pj:core/src/utils/index.ts L88-108; pj:core/src/posthog-core-stateless.ts L1717-1747.

## 4. Event properties (mobile)

- **iOS context** (ios:PostHog/PostHogContext.swift):
  - App: `$app_name`, `$app_version`, `$app_build`, `$app_namespace`
  - Distribution: `$is_testflight`, `$is_sideloaded`
  - Device: `$device_manufacturer`, `$device_model`, `$device_type`, `$device_name`, `$is_emulator`
  - OS: `$os_name`, `$os_version`
  - Screen: `$screen_width`, `$screen_height`
  - Locale and network: `$locale`, `$timezone`, `$network_wifi`, `$network_cellular`
  - SDK: `$lib`, `$lib_version`
- **iOS SDK-level properties** (PostHogSDK.swift L700-810): `$session_id`, `$screen_name`, `$is_identified`, `$process_person_profile`, `$active_feature_flags`, `$feature/<key>`.
- **Android** (and:posthog-android/src/main/java/com/posthog/android/internal/PostHogAndroidContext.kt L50-107):
  - The same app, device, OS and locale set as iOS.
  - Screen dimensions in dp, plus `$screen_density`.
  - Network: `$network_carrier`.
  - User agent: `$user_agent`, `$raw_user_agent`.
- **`$window_id`** is set only on `$snapshot` events and equals `$session_id`. A `$snapshot` without a session id is dropped (PostHogSDK.swift L766-771, L1685-1688).

## 5. Binary size and minimum OS

- **Minimum OS:**
  - iOS 13, tvOS 13, macOS 10.15, watchOS 6, visionOS 1.0 (ios:Package.swift L6-8)
  - Android API 23 (API 26 for replay)
  - RN replay needs Android API 26+ and iOS 13+, and does not work in Expo Go (docs, accessed 2026-11-10, via Step 4)
- **Binary size:** none of the READMEs or CHANGELOGs states a figure, and no release asset size was found. **Unverified; Step 5 should measure it.** The iOS SDK vendors libwebp and PLCrashReporter, which adds to its size *(inferred)*.
