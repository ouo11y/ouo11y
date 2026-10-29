# Appendix G: the open-source landscape beyond Sentry, PostHog and Luciq, and OpenTelemetry on mobile

Status: research, 2026-10-29. This appendix covers the open-source mobile SDKs of Embrace, Datadog, OpenReplay, Microsoft Clarity, LaunchDarkly Observability (formerly Highlight.io), Bugsnag and Firebase Performance, plus the OpenTelemetry mobile projects (`opentelemetry-android`, `opentelemetry-swift`, semantic conventions) and the vendor distributions built on them (Honeycomb, Splunk, Elastic, Grafana Faro). Sections 2 to 7 of the shared structure are applied per vendor in G.1 to G.7. Cross-vendor tables are in "Comparison".

Citation form: `repo/path:line @ sha12`. Inside a vendor subsection the sha is given once in its Sources line and omitted from each citation; long prefixes use the aliases defined there. `[docs only]` = README or docs claim not verified in code; `[commit message only]` = claim found only in a commit message. All repos were cloned blobless into a scratch directory and read at HEAD of the default branch on 2026-10-29.

## 1. Sources

| Vendor / project | Repo | Tag (latest) | HEAD sha12 | Licence | Open part |
|---|---|---|---|---|---|
| Embrace | embrace-io/embrace-android-sdk | 9.4.0 | e83c3b5feffb | Apache-2.0 | all |
| | embrace-io/embrace-apple-sdk | 7.0.0 | 612a2fdef639 | Apache-2.0 | all |
| | embrace-io/embrace-react-native-sdk | v7.2.0 | b8e3387f295e | Apache-2.0 | all |
| | embrace-io/embrace-flutter-sdk | 4.9.0 | 260943a58131 | Apache-2.0 | all |
| Datadog | DataDog/dd-sdk-ios | 3.21.0 | d61711956d28 | Apache-2.0 | all (incl. Session Replay) |
| | DataDog/dd-sdk-android | 3.16.0 | cc893d24377c | Apache-2.0 | all |
| | DataDog/dd-sdk-reactnative | 3.11.0 | 740f7bb57bf4 | Apache-2.0 | all |
| | DataDog/dd-sdk-flutter | datadog_session_replay v1.0.0-preview.17 | 0e5a78f8f489 | Apache-2.0 | all |
| OpenReplay | openreplay/ios-tracker | 1.0.26 | 29fe11bf90d5 | Elastic License 2.0 | source-available |
| | openreplay/android-tracker | v1.1.17 | bcaf0d38aba1 | no LICENSE file | source visible, unlicensed |
| | openreplay/openreplay (`tracker/tracker-reactnative`, `tracker/tracker-flutter`, `backend/`, `player/`) | v1.28.0 | 7d7bf61a5a9d | AGPL-3.0 default; RN folder ELv2; Flutter MIT | mixed |
| Microsoft Clarity | microsoft/clarity-apps | 3.0.9 | 41ef04cdefe1 | MIT (wrapper only) | iOS/Android are binaries |
| | npm `react-native-clarity` 4.9.2; pub.dev `clarity_flutter` 1.10.1; Maven `com.microsoft.clarity:clarity:3.10.0` | | | MIT | RN wrapper; Flutter full Dart source |
| LaunchDarkly (ex-Highlight) | launchdarkly/swift-launchdarkly-observability | 0.56.2 | e42fedb5ecb2 | Apache-2.0 | all except prebuilt tile-hash lib |
| | launchdarkly/observability-sdk (android, RN, Flutter, .NET) | android-0.69.1 | 15b2b9bad92c | Apache-2.0 (RN replay wrapper MIT) | all except prebuilt `.so` |
| OpenTelemetry | open-telemetry/opentelemetry-android | v1.8.0 | 909ca799fe8e | Apache-2.0 | all |
| | open-telemetry/opentelemetry-swift | 2.6.0 (+ unreleased main) | 8c24c12e0867 | Apache-2.0 | all |
| | open-telemetry/opentelemetry-swift-core | 2.6.0 | b0b9398b6cce | Apache-2.0 | all |
| | open-telemetry/semantic-conventions | v1.44.0 | fc53bc69024f | Apache-2.0 | |
| | open-telemetry/opentelemetry-specification (`oteps/`) | v1.62.0 | 36ccfcfb33ac | Apache-2.0 | |
| Honeycomb | honeycombio/honeycomb-opentelemetry-swift | 2.6.0 | c4ff59be11ab | Apache-2.0 | all |
| | honeycombio/honeycomb-opentelemetry-android | v1.0.0 | 586ddabdc0d1 | Apache-2.0 | all |
| Splunk | signalfx/splunk-otel-android | v2.4.0 | d647a836daad | Apache-2.0 shell | replay + `rum-common` are closed Maven artifacts |
| | signalfx/splunk-otel-ios | 2.4.3 | a1a7d0287074 | Apache-2.0 shell | replay is 14 closed xcframeworks |
| Elastic (EDOT) | elastic/apm-agent-android | v1.10.0 | 98758c97e097 | Apache-2.0 | all |
| | elastic/apm-agent-ios | 2.3.0 | d09f82cb70a4 | Apache-2.0 | all |
| Grafana Faro | grafana/faro-web-sdk | v2.13.0 | b2e64183d310 | Apache-2.0 | web only |
| Bugsnag | bugsnag/bugsnag-android-performance | v3.2.0 | 595e89eb519c | MIT | all |
| | bugsnag/bugsnag-cocoa-performance | v5.0.0 | b9ab2d589722 | MIT | all |
| | bugsnag/bugsnag-android / bugsnag-cocoa | v6.28.0 / v6.38.1 | 090262f358de / 0f6fe9cdd3fd | MIT | all |
| Firebase | firebase/firebase-ios-sdk (`FirebasePerformance/` only) | — | a05ee164071a | Apache-2.0 | all (backend closed) |

## 2-7. Per vendor

### G.1 Embrace

Sources: `embrace-io/embrace-android-sdk` 9.4.0 @ e83c3b5feffb, `embrace-io/embrace-apple-sdk` 7.0.0 @ 612a2fdef639, `embrace-io/embrace-react-native-sdk` v7.2.0 @ b8e3387f295e, `embrace-io/embrace-flutter-sdk` 4.9.0 @ 260943a58131. All Apache-2.0. Android paths below abbreviate `src/main/kotlin/io/embrace/android/embracesdk/` as `…/`.

**Platforms and embedded OTel.**

| SDK | Min | OTel inside | Cite |
|---|---|---|---|
| Android | minSdk 21 | Embrace's own `opentelemetry-kotlin` 0.9.0 (`io.opentelemetry.kotlin:*`). The default runtime is its "compat" mode wrapping opentelemetry-java; the pure-Kotlin mode is behind a remote/local flag that defaults to off | `embrace-android-sdk/gradle/libs.versions.toml:123-131`; `embrace-android-otel/…/internal/otel/OtelSdkInstance.kt:23-36`; `embrace-android-config/…/config/behavior/OtelBehaviorImpl.kt:21` |
| Apple | iOS 15, tvOS 15, macOS 13, watchOS 9 | `opentelemetry-swift-core` ≥ 2.1.1 (resolved 2.3.0), `OpenTelemetrySdk` only, no OTLP exporter bundled; KSCrash 2.6.0 | `embrace-apple-sdk/Package.swift:21-22,32-39,72`; `Package.resolved:13-18` |
| React Native | iOS 13 | JS uses only `@opentelemetry/api`; `react-native-tracer-provider` implements Tracer/Span as bridge calls into native. Pins native iOS 6.22.1 / Android 8.4.0 | `embrace-react-native-sdk/packages/core/package.json:71-75`; `packages/react-native-tracer-provider/src/EmbraceNativeTracer.ts:22,32,77`; `packages/core/RNEmbraceCore.podspec:23` |
| Flutter | Dart ≥ 3.0 | `EmbraceTracer implements APITracer` (third-party `dartastic_opentelemetry_api`), forwarded to native over method channels; pins native Android 8.4.0 / iOS 6.22.1 | `embrace-flutter-sdk/embrace/lib/src/otel/tracing/embrace_tracer.dart:10-19`; `embrace/pubspec.yaml:16`; `embrace_ios/ios/embrace_ios.podspec:18-20` |

**Signal → OTel mapping.** One attribute carries the schema: `emb.type = perf|ux|sys|state[.subtype]`, which "tells the backend that it can assume the data … follows a particular schema" (`embrace-android-instrumentation-schema/…/arch/schema/EmbType.kt:6-16`; Apple `Sources/EmbraceSemantics/EmbraceType.swift:91-103`). Internal names get an `emb-` prefix (`embrace-android-otel/…/otel/sdk/EmbraceExt.kt:16,21`). UX "events" are span events on the long-lived session span (`embrace-android-core/…/arch/destination/TelemetryDestinationImpl.kt:176-184`).

| Signal | OTel kind | Name / `emb.type` | Cite |
|---|---|---|---|
| Session part | span | `emb-session`, `ux.session`; `emb.session_part_id`, `emb.user_session_id`, `emb.cold_start`, `emb.clean_exit`, `emb.state` | `embrace-android-core/…/spans/CurrentSessionPartSpanImpl.kt:258-267`; Apple `Span/SpanSemantics+Session.swift:6,12-50` |
| Crash | log | `sys.android.crash`, `sys.android.native_crash`, `sys.android.react_native_crash`, `sys.ios.crash` (KSCrash or MetricKit payload) | `EmbType.kt:73-97`; Apple `Log/LogSemantics+Crash.swift:7` |
| ANR / hang | span + sample span events | `emb-thread-blockage`, `perf.thread_blockage`; iOS threshold 249 ms | `embrace-android-instrumentation-anr/…/blockage/ThreadBlockageOtelMapper.kt:23,34,51`; Apple `EmbraceConfiguration/HangLimits.swift:13,17` |
| App start | span tree | `emb-app-startup-cold` / `-warm` with children (`emb-process-init`, `emb-embrace-init`, `emb-activity-first-draw`, …; iOS `emb-app-pre-main-init`, `emb-app-first-frame-rendered`) | `…startup-trace/…/AppStartupTraceEmitter.kt:459-468`; Apple `Span/SpanSemantics+Startup.swift:12-21` |
| Network | span | `"METHOD /path"`, `perf.network_request`, standard `url.full`, `http.request.method`, `http.response.status_code`; W3C `traceparent` injection off by default | `…network-common/…/NetworkRequestDataSourceImpl.kt:82-89,174-185`; `EnabledFeatureConfig.kt:156` |
| Network body | log, encrypted with customer public key | `sys.network_capture` | `embrace-android-config/…/behavior/NetworkBehavior.kt:61-68` |
| Tap | span event | `emb-ui-tap`, `ux.tap`; `view.name`, `tap.coords` | `…taps/…/TapDataSource.kt:72`; `SchemaType.kt:103-116` |
| View | span | `emb-screen-view`, `ux.view`; iOS also `emb-view-did-load` … `-did-appear` (`perf.ui_load`) | `…instrumentation-view/…/ViewDataSource.kt:49`; Apple `Span/SpanSemantics+View.swift:6-19` |
| Breadcrumb, push, web view, low memory (iOS), low power | span events / spans | `emb-breadcrumb`, `emb-push-notification`, `emb-web-view`, `emb-device-low-memory`, `emb-device-low-power` | `SchemaType.kt:49-122,191-193`; Apple `SpanEvent/SpanEventSemantics+*.swift` |

Session id: Apple 7.0 stamps semconv `session.id` (= user session id) plus `emb.user_session_id` and `emb.session_part_id` on every span and log (`Sources/EmbraceSemantics/CommonSemantics.swift:14-24`; `Sources/EmbraceOTelBridge/Processors/EmbraceSpanProcessor.swift:184`). Android 9.4 stamps only `emb.session_part_id`, `emb.user_session_id`, `emb.process_identifier` and `user.id` (`embrace-android-otel/…/otel/spans/EmbraceSpanProcessor.kt:21-31`); `session.id` not found in Android main code.

**OTLP to any collector.**
- Android: `Embrace.addSpanExporter` / `addLogRecordExporter` / `addSpanProcessor` take opentelemetry-kotlin types (`embrace-android-api/…/internal/api/OTelApi.kt:19-49`); the `embrace-android-otel-java` artifact adds `addJavaSpanExporter`, `addJavaLogRecordExporter`, `getJavaOpenTelemetry()` (`embrace-android-otel-java/…/otel/java/EmbraceOtelJavaExtensions.kt:20-55`). No OTLP exporter ships: the app adds `opentelemetry-exporter-otlp` itself, as Embrace's own RN module does (`embrace-react-native-sdk/packages/react-native-otlp/android/src/main/java/io/embrace/rnembraceotlp/RNEmbraceOTLPModuleImpl.kt:116-161`).
- Apple 7.0: `EmbraceIO.OTelOptions(resource:spanProcessors:spanExporters:logProcessors:logExporters:registersGlobalProviders:)` (`Sources/EmbraceIO/Options/EmbraceIO+OTelOptions.swift:15-86`); the 6.x `OpenTelemetryExport` type is gone from 7.0. Tracer/logger providers exposed (`Sources/EmbraceIO/Public/EmbraceIO+OTelProviders.swift:36-71`).
- Export-only mode (no Embrace backend) is supported on both:

```kotlin
// embrace-android-sdk/embrace-android-config/…/internal/config/ConfigServiceImpl.kt:85-95 @ e83c3b5feffb (abridged)
require(!id.isNullOrEmpty() || hasConfiguredOtlpExport()) {
    "No appId supplied in embrace-config.json. This is required if you want to " +
        "send data to Embrace, unless you configure an OTel exporter and add" +
        " embrace.disableMappingFileUpload=true to gradle.properties." }
override fun isOnlyUsingOtelExporters(): Boolean = appId.isNullOrEmpty()
```

  Apple: `EmbraceIO.Options.withLocalConfiguration(…, otel:)` builds options with `appId: nil`, and then no uploader is created (`Sources/EmbraceIO/Options/EmbraceIO+Options.swift:99-115`; `Sources/EmbraceCore/Internal/Embrace+Setup.swift:42-44`). On Android the OTel-only mode creates no disk persistence worker (`embrace-android-sdk/…/internal/instance/RealSdkInstanceFactory.kt:452-456`), so nothing survives process death.
- Caveat: external exporters receive spans only when they end (`EmbraceSpanProcessor.kt:36-38`), so taps and breadcrumbs (span events on `emb-session`) reach your collector only when the session part ends; in-progress state goes only to Embrace as `span_snapshots`.
- Flutter iOS: `addSpanExporter` is a no-op ("runtime addition is not supported") (`embrace-flutter-sdk/embrace_ios/ios/embrace_ios/Sources/embrace_ios/EmbracePlugin.swift:700-704`).

**Wire format to Embrace (not OTLP).** Gzip JSON envelope `{resource, metadata, version, type, data:{spans, span_snapshots}}`, whose own comment says it does "not map directly to an OTLP spec" (`embrace-android-payload/…/payload/Envelope.kt:16-30`; Apple `Sources/EmbraceCore/Payload/PayloadEnvelope.swift:7-28`), POSTed to `https://a-<appId>.data.emb-api.com/v2/{spans,logs,attachments}` (`embrace-android-payload/…/comms/api/Endpoint.kt:7-10`; `embrace-android-core/…/injection/DeliveryServiceFactories.kt:66`). On-disk cache: Android gzip files (max 500), session re-cached every 2 s, dead-process sessions resurrected on next launch; Apple CoreData, 7-day cache. Retries: Android 15 s·2ⁿ capped at 480 s with `Retry-After`; Apple 0.25 → 32 s, unlimited (`SchedulingServiceImpl.kt:298-302`; `EmbraceUpload+ExponentialBackoff.swift:13-14`).

**Session model.** A user session (default 30 min inactivity, 12 h max) made of linked "session part" spans, one per foreground/background phase; background capture off by default (`embrace-android-config/…/behavior/UserSessionBehaviorImpl.kt:14-19`; `…/session/orchestrator/SessionOrchestratorImpl.kt:317-330`; Apple `EmbraceConfiguration/EmbraceConfigurable/DefaultConfig.swift:19`).

**Session replay: none.** `git grep` for replay / screenshot / PixelCopy / drawHierarchy / UIGraphicsImageRenderer / layer.render across all four repos finds no visual capture; the only hit is an unused mock key `"screenshots_enabled": false` in a test app (`embrace-apple-sdk/Examples/EmbraceIOTestApp/EmbraceIOTestApp/Common/Swizzles/Mocks/MockData.swift:23`).

**Other.** NDK crashes with vendored libunwindstack (`embrace-android-instrumentation-crash-ndk/src/main/cpp/`); iOS crash reporter choice KSCrash / Crashlytics bridge / none (`Sources/EmbraceIO/Options/EmbraceIO+Options.swift:20-27`); experiments / feature-flag API (`embrace-android-api/…/api/ExperimentApi.kt:17-74`); memory leak detector; Gradle bytecode-instrumentation plugin.

**Performance.** Android has `embrace-macrobenchmark`, `embrace-microbenchmark` and `embrace-perfetto-analysis` modules (session, OTel init compat vs Kotlin, persistence) (`embrace-macrobenchmark/README.md:3-50`), but CI excludes them and results are git-ignored (`.gitignore:70-72`; `.github/workflows/ci-gradle.yml:128`); a baseline profile is committed. Apple: `XCTApplicationLaunchMetric` launch test with vs without the SDK; committed local baseline 2.360 s vs 2.317 s (+43 ms, +1.9 %, device not recorded) (`Examples/Benchmarks/Readme.md:19-24`; `Examples/Benchmarks/Benchmarks.xcodeproj/xcshareddata/xcbaselines/…plist`); a PR workflow reruns it on BrowserStack devices and fails on a Welch t-test regression > 5 % at α 0.05 (`.github/workflows/run-device-benchmarks.yml:3-24`; `bin/perfcomp.py:25-27`). No binary-size numbers committed (`Examples/AppSizeTester/README.md:1-9`).

### G.2 Datadog

Sources: `DataDog/dd-sdk-ios` 3.21.0 @ d61711956d28, `DataDog/dd-sdk-android` 3.16.0 (HEAD 3.17.0-SNAPSHOT) @ cc893d24377c, `DataDog/dd-sdk-reactnative` 3.11.0 @ 740f7bb57bf4, `DataDog/dd-sdk-flutter` (`datadog_session_replay` v1.0.0-preview.17) @ 0e5a78f8f489. All Apache-2.0. Aliases: `SRi/` = `dd-sdk-ios/DatadogSessionReplay/Sources`, `SRa/` = `dd-sdk-android/features/dd-sdk-android-session-replay/src/main/kotlin/com/datadog/android/sessionreplay`.

**Platforms.** iOS 15 / tvOS 15 / macOS 12 / watchOS 9, swift-tools 6.2, depends on KSCrash 2.5.1 and opentelemetry-swift-core ~2.5.0 (`dd-sdk-ios/Package.swift:1,11-15,57-58`). Android minSdk 23 (`dd-sdk-android/build-logic/src/main/kotlin/com/datadog/gradle/config/AndroidConfig.kt:18`). RN wraps the native pods/AARs (iOS 3.16.1, Android 3.15.0) (`dd-sdk-reactnative/packages/core/DatadogSDKReactNative.podspec:22-30`). Flutter: plugin over native RUM; replay in a preview package that captures in Dart (below).

**RUM model.** Application → Session → View → Action / Resource / Error / LongTask scopes (`dd-sdk-ios/DatadogRUM/Sources/RUMMonitor/Scopes/`).

| Item | iOS | Android |
|---|---|---|
| Session | 15 min inactivity, 4 h max (`dd-sdk-ios/DatadogRUM/Sources/RUMMonitor/Scopes/RUMSessionScope.swift:13,15`) | same (`dd-sdk-android/features/dd-sdk-android-rum/src/main/kotlin/com/datadog/android/rum/internal/domain/scope/RumSessionScope.kt:338-339`) |
| Long task | 100 ms, `CFRunLoopObserver` (`DatadogRUM/Sources/RUMConfiguration.swift:689`; `Instrumentation/LongTasks/LongTaskObserver.swift:14-34`) | 100 ms (`rum/internal/RumFeature.kt:987`) |
| Hang / ANR | app-hang watchdog thread + semaphore, **off by default** (`RUMConfiguration.swift:690`; `Instrumentation/AppHangs/AppHangsWatchdogThread.swift:26,53`) | watchdog 5 s, probe 500 ms; fatal ANR from `ApplicationExitInfo` (`rum/internal/anr/ANRDetectorRunnable.kt:154-155`; `RumFeature.kt:637`) |
| App start | TTID / TTFD, max 60 s (`Scopes/RUMAppLaunchManager.swift:12-14`) | TTID, first-draw reporter (`dd-sdk-android-rum-internal/.../startup/`) |
| Frozen frames | 700 ms via `CADisplayLink` (`RUMVitals/RenderLoop/ViewHitchesReader.swift:55`) | 700 ms via JankStats (`scope/RumViewScope.kt:1874`) |
| Crash | KSCrash (replaced PLCrashReporter in 3.5.0) (`dd-sdk-ios/CHANGELOG.md:191,199`) | JVM + NDK `sigaction` handler (`features/dd-sdk-android-ndk/src/main/cpp/utils/signal-monitor.c:22,57-62`) |
| Watchdog terminations | yes (`Instrumentation/WatchdogTerminations/`) | not found |

**Session Replay iOS: wireframes ("semantic snapshot"), not pixels.**
1. Trigger: swizzled `CALayer` `display` / `draw` / `layoutSublayers` mark the screen dirty; a `ScreenChangeScheduler(minimumInterval: 0.1)` fires at most every 100 ms and only when something changed (`SRi/Feature/RecordingComponents.swift:89`; `SRi/Recorder/ScreenChangeMonitor/CALayerSwizzler.swift:13-36`; `SRi/Utilities/Schedulers/ScreenChangeScheduler.swift:11-16`). Default since Feb 2026.
2. `Recorder.captureNextRecord` on main: view-tree snapshot + touch snapshot (swizzled `UIApplication.sendEvent`) → processor (`SRi/Recorder/Recorder.swift:129-142`; `SRi/Recorder/TouchSnapshotProducer/UIApplicationSwizzler.swift:14-24`).
3. `ViewTreeRecorder` walks views with 19 `NodeRecorder`s: UIView, UILabel, UIImageView, UITextField, UITextView, UISwitch, UISlider, UISegmentedControl, UIStepper, UINavigationBar, UITabBar, UIPickerView, UIDatePicker, WKWebView, UIProgressView, UIActivityIndicator, UIHostingView, EmbeddedContent, Unsupported; apps add their own via `_additionalNodeRecorders` (`SRi/Recorder/ViewTreeSnapshot/ViewTreeSnapshotBuilder.swift:104-129`).
4. `SnapshotProcessor` (utility queue): new view → Meta + Focus + FullSnapshot; else an incremental record from a Heckel O(n) diff of wireframes by id (adds / removes / per-field updates); no periodic full snapshot on iOS (`SRi/Processor/SnapshotProcessor.swift:80-126`; `SRi/Processor/Diffing/Diff.swift:29-114`).
5. Wireframe types: `shape`, `text`, `image`, `placeholder`, `webview`, `embeddedContent` (`SRi/Models/SRDataModels.swift:3067-3076`).
6. Privacy, defaults text `maskAll`, images `maskAll`, touches `hide` (`SRi/SessionReplayConfiguration.swift:76-83`): text levels `maskSensitiveInputs` / `maskAllInputs` / `maskAll`, image levels `maskNonBundledOnly` / `maskAll` / `maskNone`, legacy `allow` / `mask` / `maskUserInput` (`dd-sdk-ios/DatadogInternal/Sources/Models/SessionReplay/SessionReplayConfiguration.swift:12-55`). Obfuscators: space-preserving `x`, fixed `***`, none (`SRi/Processor/Privacy/TextObfuscator.swift:21-55`). Masked images become placeholders "Content Image" (`SRi/Recorder/ViewTreeSnapshot/NodeRecorders/UIImageViewRecorder.swift:135,172-185`).
7. Images: separate upload, PNG ≤ 1000×1000 (WebP in the new layer pipeline), deduped by MD5 of a ≤ 100 px greyscale copy (`SRi/Recorder/Utilities/UIImage+SessionReplay.swift:31-42,90`; `SRi/Feature/ResourceAvailabilityStore.swift:12-66`).
8. Segment: JSON, zlib level 6, multipart `segment` part + `event` metadata part (with raw and compressed sizes) to `api/v2/replay`; storage 10 MB files, 12 h retention, upload delay 0.6-6 s (`SRi/Writers/SRCompression.swift:9-58`; `SRi/Feature/RequestBuilders/SegmentRequestBuilder.swift:76-109`; `SRi/Feature/SessionReplayFeature.swift:54-63`).
9. SwiftUI: `UIHostingViewRecorder` reflects the hosting view's renderer and decodes SwiftUI's private `DisplayList` (text, colours, images, shapes), but the `.swiftui` feature flag **defaults to false**, so SwiftUI screens are placeholders unless enabled (`SRi/Recorder/ViewTreeSnapshot/NodeRecorders/UIHostingViewRecorder.swift:26-74`; `.../SwiftUI/DisplayList.swift:14-40`; `SRi/SessionReplayConfiguration.swift:128-133`). An experimental `compositionTreeRecording` pipeline records the `CALayer` tree instead (`SRi/SessionReplayConfiguration.swift:117-123`, May 2026).

**Session Replay Android: same model.**
- Trigger: `OnDrawListener` on each decor view, debounced 64 ms; a "time bank" allows 100 ms of capture per second and skips frames beyond it, reported as `sr_skipped_frame` (`SRa/internal/recorder/ViewOnDrawInterceptor.kt:46-49`; `SRa/internal/recorder/Debouncer.kt:82-112`; `SRa/internal/recorder/RecordingTimeBank.kt:20-56`).
- Mapper lookup: first `MapperTypeWrapper` whose type `isAssignableFrom` the view; built-ins for TextView, EditText, Button, ImageView, CheckBox, RadioButton, SwitchCompat, SeekBar, ProgressBar, NumberPicker, WebView, ActionBarContainer… (`SRa/internal/recorder/TreeViewTraversal.kt:63-129`; `SRa/internal/DefaultRecorderProvider.kt:126-242`); Material extension adds Slider, TabView, CardView, Chip (`features/dd-sdk-android-session-replay-material/.../MaterialExtensionSupport.kt:76-79`).
- Compose: maps `AndroidComposeView` through `semanticsOwner.unmergedRootSemanticsNode`, switches on `Role`, and reads Compose internals (LayoutNode, background colour/shape) by reflection (`features/dd-sdk-android-session-replay-compose/.../semantics/AndroidComposeViewMapper.kt:43`; `.../RootSemanticsNodeMapper.kt:33-38`; `.../reflection/ComposeReflection.kt:22-53`).
- Processor: full snapshot on new view, orientation change, or every 3 s; otherwise `MutationResolver` (Heckel, field-level updates) (`SRa/internal/processor/RecordedDataProcessor.kt:98-141,186-191,226`; `SRa/internal/processor/MutationResolver.kt:18-320`).
- Schema (JSON Schema → generated models), `features/dd-sdk-android-session-replay/src/main/json/schemas/session-replay/`: record `type` Meta 4, Focus 6, ViewEnd 7, VisualViewport 8, FullSnapshot 10, Incremental 11; incremental `source` Mutation 0, Touch 2, ViewportResize 4, PointerInteraction 9; wireframe `shape | text | image | placeholder | webview | embedded_content` with `id, x, y, width, height, clip?`; segment `application.id, session.id, view.id, start, end, records_count, has_full_snapshot, source, records[]` (`mobile/full-snapshot-record-schema.json:17`; `mobile/mutation-data-schema.json:13`; `common/_common-segment-metadata-schema.json:7-25`).
- Compression: `Deflater(6)` with SYNC_FLUSH then FULL_FLUSH so segment parts concatenate (`SRa/internal/net/BytesCompressor.kt:18-31`); images WebP q 75, MD5-deduped, separate multipart (`SRa/internal/recorder/resources/WebPImageCompression.kt:27-62`; `SRa/internal/net/ResourcesRequestFactory.kt:95`).
- Privacy: `MASK_SENSITIVE_INPUTS` / `MASK_ALL_INPUTS` / `MASK_ALL` (default), images `MASK_NONE` / `MASK_LARGE_ONLY` (> 100×100 dp) / `MASK_ALL` (default), touches HIDE by default (`SRa/TextAndInputPrivacy.kt:21-31`; `SRa/ImagePrivacy.kt:19-31`; `SRa/SessionReplayConfiguration.kt:60,77-82`).

**Wire size (estimate computed here).** Synthetic JSON built from the schema fields, compressed with zlib level 6 as the SDK does: text wireframe ≈ 386 B, shape ≈ 191 B, image ≈ 164 B (pixels travel separately), placeholder ≈ 108 B; a Meta + Focus + FullSnapshot of 50 wireframes ≈ 13.4 KB raw → 1.6 KB compressed; one text update ≈ 162 B; 10 full snapshots of the same screen in one segment (Android's 3 s cadence over 30 s) 130 KB raw → 2.9 KB, because one deflate stream spans the segment. No size figures are committed in either repo; the SDKs only report `raw_segment_size` / `compressed_segment_size` at runtime (`SRi/Feature/RequestBuilders/SegmentRequestBuilder.swift:91-92`).

**React Native replay.** Native SR plus RN-specific mappers: Android `ReactTextView`, `ReactEditText`, `ReactViewGroup`, `ReactImageView`, `ReactModalHostView`, SVG; iOS `RCTTextViewRecorder` (Fabric `RCTParagraphComponentView` under `RCT_NEW_ARCH_ENABLED`) (`dd-sdk-reactnative/packages/react-native-session-replay/android/src/main/kotlin/com/datadog/reactnative/sessionreplay/ReactNativeSessionReplayExtensionSupport.kt:38-43`; `.../ios/Sources/RCTFabricWrapper.mm:9-35`). No JS-side capture.

**Flutter replay (preview).** Dart walks the Element tree with per-widget recorders (Text, Image, Icon, EditableText, Container, CustomPaint, Material/Cupertino controls), every 100 ms gated on a new frame, diffs in an Isolate, and hands records to the native SDK as embedded-slot content via ffigen / jnigen (`dd-sdk-flutter/packages/datadog_session_replay/lib/src/capture/recorder.dart:79-203`; `lib/src/datadog_session_replay.dart:21,158-205`; `lib/src/processor/processor.dart:97-101`).

**Transport.** NDJSON / JSON batches per feature to `/api/v2/{rum,logs,spans,replay,profile}`, deflate (iOS) / gzip (Android, skipping multipart), on-disk batches (5 MB, 1000 events, 18 h, 512 MB), retries on 408/429/5xx, no upload under 10 % battery or low-power mode (`dd-sdk-ios/DatadogInternal/Sources/Upload/URLRequestBuilder.swift:165-175`; `dd-sdk-ios/DatadogCore/Sources/PerformancePreset.swift:130-136`; `dd-sdk-ios/DatadogCore/Sources/Core/Upload/DataUploadStatus.swift:39-53`; `.../Upload/DataUploadConditions.swift:14-27`; `dd-sdk-android/dd-sdk-android-core/.../persistence/file/FilePersistenceConfig.kt:22-27`).

**OpenTelemetry: API only, no OTLP.** iOS `OTelTracerProvider: OpenTelemetryApi.TracerProvider` (`dd-sdk-ios/DatadogTrace/Sources/OpenTelemetry/OTelTracerProvider.swift:11-36`); Android `dd-sdk-android-trace-otel` with `OtelTracerProvider` and `DatadogOpenTelemetry : OpenTelemetry` (`features/dd-sdk-android-trace-otel/src/main/kotlin/com/datadog/android/trace/opentelemetry/OtelTracerProvider.kt:25-42`). Spans created through the OTel API are exported to Datadog's `/api/v2/spans`; `grep -i otlp` over both trace modules returns nothing; no OTel logs or metrics API. Propagation: `datadog`, `b3`, `b3multi`, `tracecontext`; first-party default `datadog + tracecontext` (`dd-sdk-ios/DatadogInternal/Sources/NetworkInstrumentation/TracingHeaderType.swift:16-20`; `FirstPartyHosts.swift:30`).

**Performance.** iOS `BenchmarkTests` and Android `sample/benchmark` + `tools/benchmark` run baseline (SDK not initialised) vs instrumented scenarios (SR, SR SwiftUI, RUM auto, logs, profiling) in Datadog Synthetics, sampling CPU (`task_info`, `/proc/self/stat`), memory (`TASK_VM_INFO`, `VmRSS`) and FPS (`CADisplayLink`, Choreographer), and export them with the **OTel metrics SDK** to Datadog (`dd-sdk-ios/BenchmarkTests/Runner/Scenarios/SyntheticScenario.swift:21-133`; `BenchmarkTests/Runner/BenchmarkVitals.swift:29-77`; `dd-sdk-android/tools/benchmark/src/main/java/com/datadog/benchmark/internal/reader/CPUVitalReader.kt:45-48`). Committed numbers `[docs only]`: Android core on Pixel 6, CPU 26.8 % vs 25.2 %, TTID 243 vs 229 ms, APK +552 KB (`dd-sdk-android/docs/sdk_performance.md:59-126`); Android SR on Galaxy S23 (debug build): janky frames 3.16 % → 3.88-5.62 % (Views) and 2.94 % → 6.21-6.93 % (Compose), CPU +0-7 pts (Views) and +3-12 pts (Compose), memory up to +55 MB (`:171-289`); iOS IPA 22.2 → 23.6 MB on iPhone 13 (`dd-sdk-ios/docs/sdk_performance.md:128-130`).

**Other.** Logs, traces, WebView bridge (`DatadogEventBridge`), feature flags (`DatadogFlags`, OpenFeature), continuous profiling (iOS Mach sampler → pprof; Android `ProfilingManager`/Perfetto), heatmaps flag in SR.

### G.3 OpenReplay

Repos: `openreplay/ios-tracker` 1.0.26 @ 29fe11bf90d5, `openreplay/android-tracker` v1.1.17 @ bcaf0d38aba1, `openreplay/openreplay` v1.28.0 @ 7d7bf61a5a9d (`tracker/tracker-reactnative`, `tracker/tracker-flutter`, `backend/`, `player/`).

**Licences (mixed, read carefully).** iOS tracker: Elastic License 2.0 (`ios-tracker/LICENSE.md:1`). Android tracker: no LICENSE file in the repo (root listing @ bcaf0d38aba1). RN tracker: `package.json` says MIT (`openreplay/tracker/tracker-reactnative/package.json:48`) but the folder's LICENSE file is ELv2 (`.../tracker-reactnative/LICENSE:1`). Flutter tracker: MIT (`.../tracker-flutter/openreplay/LICENSE`). Backend and player: AGPL-3.0 by default, `ee/` under its own licence (`openreplay/LICENSE:4-7`). None is safely reusable as code in ouo; ideas only.

**Platforms.** iOS 13+ Swift package (`ios-tracker/Package.swift:8-9`); Android minSdk 21 (`android-tracker/tracker/build.gradle.kts:13`); RN wraps both native trackers (`tracker-reactnative/android/build.gradle:111` → `android-tracker:v1.1.14`, `openreplay-react-native.podspec:18` → `Openreplay 1.0.25`); Flutter captures in Dart and encodes in native (`tracker-flutter/openreplay/lib/src/native.dart:28-45`).

**Replay technique: periodic full-window JPEG screenshots, no diffing on native, solid/blur masks over opt-in views.**

| Step | iOS | Android | Flutter |
|---|---|---|---|
| Trigger | `Timer` every `captureRate` s (`ScreenCapture.swift:107-114`); rate = 1/fps from the `/v1/mobile/start` reply (`ORTracker.swift:267-269`) | coroutine loop every `screenshotFrequency.millis / fps` (`ScreenshotManager.kt:140-151`); defaults 1000 ms / 1 fps (`OROptions.kt:3-5,36-38`) | post-frame callback, throttled to `captureRate` (default 333 ms) plus a 10 s heartbeat (`screenshot_manager.dart:31,50,136-157`) |
| Capture | `drawHierarchy(afterScreenUpdates:false)` at scale 1.25 on main thread (`ScreenCapture.swift:55,151-157`) | `PixelCopy.request` on the window, `View.draw` canvas fallback (`ScreenshotManager.kt:726,759-764`) | `RenderRepaintBoundary.toImageSync(pixelRatio)` sized so the long edge is 720 px (`screenshot_manager.dart:176,231-236`; `options.dart:30`) |
| Masking | only views registered via `addIgnoredView`, `.sensitive()` SwiftUI modifier or `SensitiveTextField`; blur + stripes or solid blue box (`ScreenCapture.swift:191-246,410-436`; `ORTracker.swift:172-174`) | only views passed to `sanitizeView` / `SanitizableViewGroup`, incl. inside Compose (`ORTracker.kt:588-592`; `ScreenshotManager.kt:405-450,497-541`) | `ORSanitizedView` widget + platform views masked by default (`sanitized.dart:11-28`; `options.dart:32`) |
| Encode | JPEG q 0.4/0.5/0.6 for low/standard/high (`ORTracker.swift:271-281`) off-main (`ScreenCapture.swift:167-188`) | JPEG q 40/50/60, short side 480/720/1080 (`ORTracker.kt:682-699`; `ScreenshotManager.kt:599-635`) | native JPEG, frame skipped if 64-bit hash equals previous (`OpenreplayPlugin.swift:75-87`; `options.dart:31`) |
| Dedupe | none | none | hash dedupe (above) |
| Batch | 20 frames by default (10/20/30) (`OROptions.swift:103-107`) | folder of 10 JPEGs then archive (`ScreenshotManager.kt:231-250`) | batch + 5 s flush floor (`screenshot_manager.dart:39`) |
| Container | "frames": `[u64 LE ts][u32 LE size][jpeg]`… gzipped, or legacy tar.gz of `<firstTs>_1_<ts>.jpeg` (`ScreenCapture.swift:330-380`; `ScreenshotArchiveFormat.kt:11-29`) | same | same layout, gzipped (`screenshot_manager.dart:310-337`) |
| Upload | multipart to `/v1/mobile/images` (`NetworkManager.swift:7`) | same (`NetworkManager.kt:30`) | same |

Text input values are not in the screenshot path; the analytics listener sends `***` for secure fields (`Analytics.swift:69-81`; Android `Analytics.kt:321,341-345`). Masking of what is *drawn* is opt-in: an un-annotated `UILabel` with an e-mail address goes out in clear. This is the main privacy difference from Sentry, Datadog and PostHog, which mask text by default.

**RUM data with the replay.** A binary message stream: each message is `varint type, varint timestamp, size-prefixed body` (`ORMessages.swift:47-49`; varint writer `Data.swift:198-205`). Mobile types 92-109: metadata, event, userID, screen changes, crash, view component, click, input, performance, log, network call, swipe, batch meta, GraphQL (`ORMessages.swift:6-21`). Batches up to 500 KB, flushed every 5 s, gzip + `Content-Encoding: gzip` to `/v1/mobile/i` (`MessageCollector.swift:16,39`; `NetworkManager.swift:5,165-174`). Performance messages: main-thread CPU every 5 s, memory every 10 s, background on/off (`PerformanceListener.swift:67,72,52,83,125,131`). Crashes: `NSSetUncaughtExceptionHandler` only, no signal handler (`Crash.swift:28`), so Swift traps and EXC_BAD_ACCESS are not captured. Network: manual `NetworkListener(request:)` / `(task:)`, with header/body key redaction (`NetworkListener.swift:11-13,28-38`). Taps: opt-in `UIWindow.sendEvent` swizzle (`ORTracker.swift:260-262`; `Analytics.swift:266-285`). Conditional recording: `coldStart` buffers 2 × 30 s rings for frames and messages and only uploads when a condition fires (`ORTracker.swift:116-137`; `ScreenCapture.swift:257-293`).

**Server and player.** The image service appends every uploaded frame record to one `replay.frames` file per session and at session end streams it zstd-compressed to object storage as `<sid>/replay.frames.zst` (`openreplay/backend/pkg/images/service/image.go:84-129,137`). The web player downloads that one object, unpacks zstd, parses the records and shows the last frame at or before the playhead (`openreplay/player/src/mobile/managers/SnapshotManager.ts:29-51`); touches and RUM messages are overlaid from the message stream (`player/src/mobile/managers/TouchManager.ts`). No video encoding anywhere: an image-sequence ("flip-book") player.

**Versus Sentry.** Same family (screenshot + mask), but OpenReplay sends independent JPEGs at 1-3 fps with no video codec, so bytes scale linearly with time even when the screen is static (no dedupe on iOS/Android); Sentry encodes 1 fps frames into MP4 segments and masks text/images by default (appendices A, B). Estimate (not measured): a 1.25×-scale iPhone frame at q 0.5 is roughly 15-40 KB, by analogy with ADR-0006's 20-40 KB at half of native (≈1.5×) resolution and the same quality. iOS starts at 0.33 s per frame before the server's `fps` replaces it (`ScreenCapture.swift:56`; the server default was not found), Android defaults to 1 fps, Flutter to 3 fps with dedupe. That gives ≈ 0.9-2.4 MB per minute at 1 fps and ≈ 2.7-7.2 MB at 3 fps, and gzip barely shrinks JPEG.

### G.4 Microsoft Clarity

Sources: `microsoft/clarity-apps` 3.0.9 @ 41ef04cdefe1 (MIT), npm `react-native-clarity` 4.9.2, pub.dev `clarity_flutter` 1.10.1, Maven `com.microsoft.clarity:clarity:3.10.0` AAR.

- **Native iOS and Android are closed binaries.** The GitHub repo holds only a `Package.swift` with a `binaryTarget` pointing at `Clarity-4.1.2.xcframework.zip` (`clarity-apps/Package.swift:16-20 @ 41ef04cdefe1`; repo has 7 files). Android is an obfuscated AAR (1.05 MB, 734 classes, class names like `protomodels/mutationpayload/A.class`).
- **React Native is a thin wrapper** over those binaries: `implementation "com.microsoft.clarity:clarity:3.10.0"` (`react-native-clarity/android/build.gradle:76`), `s.dependency "Clarity", '4.1.2'` (`react-native-clarity.podspec:19`).
- **Flutter is full Dart source (MIT, 199 files)** and shows the technique: **draw-command capture**, a third family next to screenshots and wireframes.
  - Every ~1 s, if a frame was painted since the last capture, it re-paints the root `RenderView` into its own `SnapshotPaintingContext` (`clarity_flutter/lib/src/observers/snapshot_capturer.dart:93-107,163-167,250-266`), whose `SnapshotCanvas implements ui.Canvas` records `drawRect`, `drawRRect`, `drawImageRect`, paths, clips, transforms… as display commands (`helpers/snapshot_canvas.dart:20,162,192,326`; `models/display/*.dart`).
  - Text is not rasterised: `drawParagraph` is a no-op (`snapshot_canvas.dart:251`) and paragraphs are recorded structurally (`models/display/draw_render_paragraph.dart`, `models/text/*`), fonts and images uploaded once as hashed assets (`managers/asset_manager.dart`, `font_manager.dart`; `xxh3` dependency `pubspec.yaml:37-38`).
  - Masking modes `strict` (default) / `balanced` (PII regex) / `relaxed`, plus `ClarityMask` / `ClarityUnmask` widgets (`models/masking.dart:7`; `utils/masking_utils.dart:20-32`; `models/project_config.dart:33`).
  - Payload: protobuf `MutationPayload` (`models/generated/MutationPayload.pb.dart`) inside a JSON envelope, gzip, sent to `clarity.ms` (`helpers/services/ingest_service.dart:63,165`); serialization and upload in worker isolates (`managers/upload_manager.dart:43`).
  - The Android AAR has `models/display/common/SkiaPictureHeader` and `models/observers/FramePicture` classes (binary class-name inspection only), consistent with the native SDKs recording Skia pictures `[docs only]` for the rest.
- **No OTel**, no export; data goes to Microsoft only (`clarity.ms`, `ingest_service.dart:149`). Free product `[docs only]`.

### G.5 OpenTelemetry on mobile, and the vendors built on it

Sources (HEAD of default branch, 2026-10-29): `open-telemetry/opentelemetry-android` v1.8.0 @ 909ca799fe8e, `open-telemetry/opentelemetry-swift` 2.6.0 (+ unreleased main) @ 8c24c12e0867, `open-telemetry/opentelemetry-swift-core` 2.6.0 @ b0b9398b6cce, `open-telemetry/semantic-conventions` v1.44.0 @ fc53bc69024f, `open-telemetry/opentelemetry-specification` v1.62.0 @ 36ccfcfb33ac, `honeycombio/honeycomb-opentelemetry-swift` 2.6.0 @ c4ff59be11ab, `honeycombio/honeycomb-opentelemetry-android` v1.0.0 @ 586ddabdc0d1, `signalfx/splunk-otel-android` v2.4.0 @ d647a836daad, `signalfx/splunk-otel-ios` 2.4.3 @ a1a7d0287074, `elastic/apm-agent-android` (EDOT) v1.10.0 @ 98758c97e097, `elastic/apm-agent-ios` (EDOT) 2.3.0 @ d09f82cb70a4, `grafana/faro-web-sdk` v2.13.0 @ b2e64183d310. All Apache-2.0.

#### opentelemetry-android ("the Android agent")

- Status: BOM `1.8.0-alpha`; only `android-agent`, `session`, `agent-api`, `instrumentation/android-instrumentation` publish without `-alpha` (`opentelemetry-android/buildSrc/src/main/kotlin/otel.publish-conventions.gradle.kts:8-12`, `session/gradle.properties:1`). minSdk 23 (`gradle.properties:24`).
- Entry point `OpenTelemetryRumInitializer.initialize(context) { … }` (`android-agent/.../OpenTelemetryRumInitializer.kt:45-47`); OTLP/HTTP only for spans, logs, metrics, paths appended to `baseUrl` (`:114-157`; `HttpEndpointConnectivity.kt:30,48,66`). Disk buffering from contrib `opentelemetry-disk-buffering` (10 MiB, 18 h max age), on by default in the agent DSL (`core/.../DiskBufferingConfig.kt:13-27`; `DiskBufferingConfigurationSpec.kt:23`).
- Instrumentation (default-on in the agent: activity, anr, crash, fragment, network, slowrendering, startup, sessions, screen-orientation, `android-agent/build.gradle.kts:24-32`):

| Signal | Module | Emits |
|---|---|---|
| JVM crash | `crash` | `app.crash` event (`instrumentation/crash/.../CrashReporter.kt:110`) |
| Native crash | `native-crash` (development) | signal handler, persisted, sent as `app.crash` next launch (`native-crash/README.md:3-9`) |
| ANR | `anr` | `device.anr`, main thread polled every 1 s (`anr/.../AnrWatcher.kt:24`) |
| Jank | `slowrendering` | `app.jank`, frozen ≥ 700 ms (`SlowRenderingInstrumentation.kt:20`; `EventJankReporter.kt:12`) |
| Lifecycle / start | `activity`, `fragment`, `startup` | `Created`/`Resumed` spans, `AppStart` span (`ActivityTracer.kt:52,75`; `AppStartupTimer.kt:49`) |
| HTTP | `okhttp3`, `okhttp3-websocket`, `httpurlconnection` (opt-in) | client spans |
| Taps | `view-click`, `compose/click` (opt-in) | `app.screen.click`, `app.widget.click` (`ViewClickEventGenerator.kt:17-27`) |
| Device | `network`, `screen-orientation`, `power-save-mode`, `thermal` | `network.change`, `device.*` events |

- Sessions: `SessionManager` with `backgroundInactivityTimeout = 15.minutes`, `maxLifetime = 4.hours`, optional user-inactivity timeout (`android-agent/.../session/SessionConfig.kt:13-15`; `SessionManager.kt:127-133`); `session.id` on every span and log record (`core/.../SessionIdSpanAppender.kt:25-33`, `SessionIdLogRecordAppender.kt:21`); `session.start` (with `session.previous_id`) / `session.end` events (`SessionIdEventSender.kt:28-38`); session-ratio sampler (`SessionIdRatioBasedSampler.kt:44`). Default storage is in memory: a cold start always starts a new session. No `rum.session.id` in current code.
- Session replay: none. The roadmap lists it and names "privacy concerns and the absence of an appropriate OTLP style data model" as blockers (`docs/ROADMAP.md:228-237`) `[docs only]`.

#### opentelemetry-swift (+ -core)

- Split and re-merge: at 2.6.0 the API/SDK live in `opentelemetry-swift-core` (`opentelemetry-swift-core/Package.swift:17-20`, iOS 12, swift-tools 6.0); commit `4481533` (2026-10-08, "Move OpenTelemetry-swift-core content to the main repo (#1220)") moved them back into `opentelemetry-swift` on main with swift-tools 6.2 and iOS 15 (`opentelemetry-swift/Package.swift:1,11,17,22`); not yet tagged. The -core README says development is paused (`opentelemetry-swift-core/README.md:4`) `[docs only]`.
- Exporters: OTLP HTTP (default `http://localhost:4318/v1/traces`, `Sources/Exporters/OpenTelemetryProtocolHttp/trace/OtlpHttpTraceExporter.swift:16`) and gRPC, persistence decorators, Stdout, InMemory, Prometheus, Zipkin, Jaeger.
- Instrumentation: `URLSessionInstrumentation`, `NetworkStatus`, `SignPostIntegration`, `ResourceExtension`, `MetricKitInstrumentation` (crash/hang diagnostics delivered on next launch, `MetricKitInstrumentation.swift:390,410,438`), `Sessions` (since 2.1.0: `sessionTimeout = 30 * 60`, no max lifetime, `session.id` / `session.previous_id`, `session.start` / `session.end`, `Sources/Instrumentation/Sessions/SessionConfig.swift:46`; `SessionSpanProcessor.swift:32,34`; `SessionConstants.swift:19,21`), and `Crash` on KSCrash 2.6 merged 2026-10-14, unreleased (`Package.swift:373,394`). No UIKit lifecycle, tap, screen or live hang instrumentation (not found in code).

#### Semantic conventions for the client (v1.44.0)

Everything here is `stability: development`:
- `session.id`, `session.previous_id` (`semantic-conventions/model/session/registry.yaml:4-13`); events `session.start`, `session.end` (`model/session/events.yaml:4-39`).
- `app.installation.id`, `app.build_id`, `app.crash.id`, `app.screen.{id,name,coordinate.x,coordinate.y}`, `app.widget.{id,name}`, `app.jank.{frame_count,threshold,period}` (`model/app/registry.yaml:9-121`); events `app.crash`, `app.screen.click`, `app.widget.click`, `app.jank` (`model/app/events.yaml:2,48,72,94`).
- `device.{id,manufacturer,model.identifier,model.name}` (`model/device/registry.yaml:8-52`); event `device.app.lifecycle` carrying `ios.app.state` (active/inactive/background/foreground/terminate) or `android.app.state` (created/background/foreground) (`model/device/events.yaml:2-23`; `model/ios/registry.yaml:8-43`; `model/android/registry.yaml:8-43`).
- `os.*`, `browser.*`, `browser.web_vital` event. `client.address` / `client.port` are stable but are network-peer attributes, not RUM (`model/client/registry.yaml:4-13`).
- Missing: no screen-view / navigation event, no app-start span convention, nothing on session replay.
- Owner: area "Semantic Conventions: Client Instrumentation" (app, enduser, device, mobile, session), `accepting_contributions, active` (`areas.yaml:83-98`). OTEP 4665 ("Allow multiple Resources in an SDK", merged) cites the Client/Browser SIG's need to model a "User Session" shorter-lived than the SDK as a motivation (`opentelemetry-specification/oteps/entities/4665-multiple-resource-in-sdk.md:20-22`). There is no session or replay OTEP.

#### Vendors on OTel

| Project | Built on | OTLP to any collector | Session | Crash | Replay |
|---|---|---|---|---|---|
| Honeycomb Swift | otel-swift + core 2.5.1 (`honeycomb-opentelemetry-swift/Package.swift:20-25`) | yes; default `https://api.honeycomb.io:443`, overridable, API key only required for Honeycomb hosts (`HoneycombOptions.swift:18,363,593`) | OTel `Sessions`, 4 h default (`HoneycombOptions.swift:262`) | `NSSetUncaughtExceptionHandler` only (`HoneycombUncaughtExceptions.swift:10`) + MetricKit | no |
| Honeycomb Android | otel-android 1.0.1 (`gradle/libs.versions.toml:23-24`) | yes, overridable (`HoneycombOptions.kt:22,330`) | inherited | otel-android `crash`, `anr` | no |
| Splunk Android | OTel Java SDK + OTLP marshalers, not otel-android (`buildSrc/.../Dependencies.kt:89-99`) | OTLP protobuf; custom URL accepted but must contain `auth=` (`EndpointConfiguration.kt:40-70`) | own, 15 min bg / 4 h, `session.id` + legacy `splunk.rumSessionId` (`SplunkSessionManager.kt:233-234`; `StandardAttributes.kt:51`) | own JVM crash + ANR | **closed**: `com.splunk.android:sr-instrumentation-session-recording-*:1.1.7` (`Dependencies.kt:82-88`); core also needs closed `rum-common-*` (`:71-79`) |
| Splunk iOS | otel-swift-core 2.3.0 + own OTLP JSON/protobuf encoder (`splunk-otel-ios/Package.swift:30-38`) | yes, `EndpointConfiguration(trace:sessionReplay:)` | own, 15 min / 4 h, remote-overridable (`ConfigurationDefaults.swift:33,35`) | vendored PLCrashReporter | **closed**: 14 `Cisco*` xcframeworks (Screenshot, Wireframe, VideoEncoder…) from `sdk.smartlook.com` (`Package.swift:750-860`) |
| Elastic EDOT Android | OTel Java 1.67 + experimental otel-android 1.8.0 adapter (`gradle/libs.versions.toml:2-20`) | yes, HTTP or gRPC (`ExportProtocol.kt:25-26`) | own, 30 min idle / 4 h (`SessionManager.kt:50-51`) | own JVM handler | no |
| Elastic EDOT iOS | otel-swift ≥ 2.4.1 + PLCrashReporter (`apm-agent-ios/Package.swift:23-27`) | yes, HTTP or gRPC (`AgentConfiguration.swift:7-8`) | own, 30 min idle (`Session/SessionManager.swift:26`) | PLCrashReporter → `app.crash` (`CrashManager.swift:27,78`); emits semconv `device.app.lifecycle` (`ApplicationLifecycleInstrumentation.swift:21,104`) | no |
| Grafana Faro | browser only; README: React Native "No" (`faro-web-sdk/README.md:85`) | experimental `transport-otlp-http` | 15 min / 4 h (`packages/web-sdk/src/instrumentations/session/sessionManager/sessionConstants.ts:4-5`) | JS errors | web only, experimental rrweb fork; RN packages only on unmerged branches (`origin/feat/react-native-support`, last commit 2026-01-09) |

### G.6 LaunchDarkly Observability (formerly Highlight.io): OTel telemetry + rrweb-compatible screenshot replay

Not in the original brief, found while checking Highlight.io's mobile status: Highlight's mobile work now lives at LaunchDarkly and is open source.

Sources: `launchdarkly/swift-launchdarkly-observability` 0.56.2 @ e42fedb5ecb2 (Apache-2.0, NOTICE credits opentelemetry-swift), `launchdarkly/observability-sdk` monorepo @ 15b2b9bad92c (Apache-2.0; tags `launchdarkly-observability-android-0.69.1`, `observability-react-native-0.19.0`, `session-replay-react-native-0.24.3` (MIT), `launchdarkly_flutter_observability-1.0.2`). Aliases: `S/` = swift repo, `OT/` = `S/Sources/LaunchDarklyOtel`, `SR/` = `S/Sources/LaunchDarklySessionReplay`, `OB/` = `S/Sources/LaunchDarklyObservability`, `A/` = `observability-sdk/sdk/@launchdarkly/observability-android/lib/src/main/kotlin/com/launchdarkly/observability`.

**Platforms.** iOS 15 / tvOS 15 Swift package with products `LaunchDarklyOtel` (pipeline only, "installing no swizzles or crash handlers, so it can run beside another observability SDK"), `LaunchDarklyObservability`, `LaunchDarklySessionReplay`, `LaunchDarklyKSCrash` (`S/Package.swift:7-29`). Android minSdk 23 (`observability-android/lib/build.gradle.kts:119`). RN, Flutter and .NET MAUI wrap the native SDKs for replay. Runs as a plugin of the LaunchDarkly flags client, which is a hard dependency (`S/Package.swift:32`).

**Telemetry: real OTel SDK, OTLP/HTTP JSON to a configurable endpoint.**
- iOS: `opentelemetry-swift-core` ≥ 2.5.0 (`S/Package.swift:31`) with `TracerProviderBuilder`, `MeterProviderSdk` (`OT/Traces/TracerDecorator.swift:15`; `OT/Metrics/CustomMeter.swift:22`), but its own in-memory `EventQueue`/`BatchWorker` (4 s interval, 100 items, backoff 2-60 s) instead of the SDK batch processors, no disk buffer (`OT/Transport/BatchWorker.swift:9-46`).
- Wire: OTLP/HTTP JSON, always gzip, `/v1/{traces,logs,metrics}` (`OT/OtlpClient/OtlpHttpClient.swift:51-91`; `OT/Constants/OTelPath.swift:2-4`); default `https://otel.observability.app.launchdarkly.com:4318`, overridable, with `customHeaders` (`OT/API/ObservabilityOptions.swift:11-12,275,357-358`). The mobile key is stamped as resource attribute `highlight.project_id` (`OT/Plugin/ObservabilityPlugin.swift:118`).
- Session: `session.id`, 28-char random id, new session after ≥ 15 min in background, no max lifetime on iOS (`OT/API/SemanticConvention.swift:2`; `OT/Session/SessionManager.swift:80-84`); Android uses otel-android `session` with 15 min / 4 h (`A/client/ObservabilityService.kt:113-114,244-246`).
- Instrumentation: taps (swizzled `UIWindow.sendEvent` → `click` span), screens (swizzled `viewDidAppear` → `screen_view` span), `app_launch` / `app_foreground` / `app_background` spans, URLSession (vendored from otel-swift, old `http.method`/`http.url` semconv, off by default), CPU/memory metrics; crashes from MetricKit or KSCrash as FATAL log records, off by default; no hang/ANR detection (`OT/API/ObservabilityOptions.swift:121-128,200-206,351`; `OB/UIInteractions/UIWindowSwizzleSource.swift:22-37`; `S/Sources/LaunchDarklyKSCrash/LDCrashFilter.swift:54-67`). Android: OTel Java 1.51.0 + otel-android 0.11.0-alpha `core`/`session`/`crash` (`observability-android/lib/build.gradle.kts:76-90`); no HTTP instrumentation.
- React Native telemetry is pure JS OTel (`@opentelemetry/sdk-trace-web`, OTLP HTTP exporters) but stamps `highlight.session_id`, not `session.id` (`observability-react-native/package.json:45,54`; `src/client/InstrumentationManager.ts:286`).

**Replay iOS: screenshots, tile diff, emitted as rrweb DOM events.**

| Step | Detail | Cite |
|---|---|---|
| Trigger | `CADisplayLink`, throttled to `frameRate` (default 1 fps), one capture in flight | `SR/ScreenCapture/CaptureManager.swift:98-99,130-140`; `SR/API/SessionReplayOptions.swift:81` |
| Capture | `UIGraphicsImageRenderer` over all windows, `drawHierarchy(afterScreenUpdates:false)` or `layer.render(in:)` | `SR/ScreenCapture/WindowCaptureManager.swift:53-57` |
| Masking | default: text inputs and keyboard masked; labels, images, web views not (opt-in); class / accessibility-id lists; SwiftUI `ldMask()` / `ldUnmask()` / `ldIgnore()`; SwiftUI text found via private classes `_UIGraphicsView`, `SwiftUI.CGDrawingView`; solid grey fill | `SR/API/SessionReplayOptions.swift:22-32`; `SR/ScreenCapture/MaskingPolicy.swift:36-54,141-186`; `SR/API/View+ldMask.swift:5-17` |
| Leak guard | masks collected before render and again next tick; frame dropped if count or positions differ | `SR/ScreenCapture/ImageCaptureService.swift:68-106` |
| Diff | 64-px tiles hashed with a NEON 128-bit hash (prebuilt `SessionReplayC.xcframework` binary target; C source only in git history), unchanged frame dropped, else one bounding rect of changed tiles; keyframe every 10 frames; "backtracking" sends only removes when the screen returns to an earlier state | `S/Package.swift:43-46`; `SR/ScreenCapture/TileDiffManager.swift:52-115`; `SR/ScreenCapture/ExportDiffManager.swift:41-47` |
| Encode | JPEG q 0.3, scale 1.0 | `SR/API/SessionReplayOptions.swift:81-83` |
| Format | rrweb Meta + FullSnapshot (`html > body > img` per tile) + Custom "Viewport"; incrementals are rrweb Mutation `adds`/`removes` of `<img>` nodes; new FullSnapshot when ~9 MB of data-URLs accumulate; touches as rrweb MouseInteraction; semantic events as rrweb Custom (Click, Navigate, Foreground…) | `SR/Exporter/RRWebEventGenerator.swift:17,145-151,195-227,402-488`; `SR/RRWeb/RRWebTypes.swift:69-88` |
| Transport | **not OTel**: Highlight-legacy GraphQL `initializeSession` then `PushPayload(session_secure_id, events…)`, gzip; `session_secure_id` = OTel `session.id` | `SR/Operations/InitializeSessionOperation.swift:105-135`; `SR/Operations/PushPayloadOperation.swift:112-138`; `SR/Exporter/SessionReplayExporter.swift:136` |

The tile node, verbatim:

```swift
// swift-launchdarkly-observability/Sources/LaunchDarklySessionReplay/ScreenCapture/ExportFrame.swift:19-30 @ e42fedb5ecb2
func tileEventNode(id: Int, mimeType: String) -> EventNode {
    let style = "position:absolute;left:\(Int(rect.minX))px;top:\(Int(rect.minY))px;pointer-events:none;"
    return EventNode(id: id, type: .Element, tagName: "img",
        attributes: ["src": .imageDataURL(mimeType: mimeType, data: data),
                     "width": "\(Int(rect.width))", "height": "\(Int(rect.height))",
                     "style": .text(style)])
```

**Replay Android** mirrors iOS: `PixelCopy` on API ≥ 26 with `View.draw` fallback, SurfaceViews composited separately, a Choreographer `FrameSynchronizer` aligning masks with the frame, 1 fps coroutine loop, JPEG 0.3, keyframe every 15 frames, Compose masking by reading `SemanticsOwner` reflectively (inputs and `Password` always masked), JNI tile hash in a prebuilt `libsession_replay_c.so`, same rrweb `<img>` format and GraphQL transport (`A/replay/capture/ImageCaptureService.kt:240-306`; `A/replay/capture/FrameSynchronizer.kt:25-50`; `A/replay/ReplayOptions.kt:18-35`; `A/replay/masking/ComposeMaskTarget.kt:40-97`; `A/replay/exporter/RRWebEventGenerator.kt:87-96`).

**React Native / Flutter / MAUI replay** all delegate to native: RN pod `LaunchDarklySessionReplay ~> 0.56.2` and Android `0.69.0` (`react-native-ld-session-replay/SessionReplayReactNative.podspec:27`; `android/build.gradle:100`); Flutter captures in Dart with `RenderRepaintBoundary.toImage` and hands frames to the native `ImageCaptureServicing`, so diff, rrweb and transport are native (`sdk/flutter/packages/observability/lib/src/platform/io/native_session_replay_capture.dart:92,120-134`); .NET MAUI binds the native SDKs (`sdk/@launchdarkly/mobile-dotnet/observability/LDObservability.csproj:3,12-13`).

**Performance.** No benchmark results published; a `CompressionBenchmarkRunner` measures bytes and capture time over saved frames but no results are committed (`SR/BenchMark/CompressionBenchmarkRunner.swift:7-33`). Only commit-message claims: tile hash "20x" faster (iOS `80e0cf8`), C/NEON hashing "100x on Pixel 8" (Android `e7c78abd`), PushPayload encoding of an 8 MB payload 17 ms → 4 ms and peak 17 → 8 MB on simulator (`49a55b8`) `[commit message only]`.

### G.7 Bugsnag (Insight Hub) and Firebase Performance

Sources: `bugsnag/bugsnag-android-performance` v3.2.0 @ 595e89eb519c (MIT), `bugsnag/bugsnag-cocoa-performance` v5.0.0 @ b9ab2d589722 (MIT), `bugsnag/bugsnag-android` v6.28.0 @ 090262f358de (MIT), `bugsnag/bugsnag-cocoa` v6.38.1 @ 0f6fe9cdd3fd (MIT), `firebase/firebase-ios-sdk` @ a05ee164071a, `FirebasePerformance/` only (Apache-2.0). Abbreviations: `BAP-I` = `bugsnag-android-performance/bugsnag-android-performance-impl/src/main/kotlin/com/bugsnag/android/performance/internal`, `BCP` = `bugsnag-cocoa-performance/Sources/BugsnagPerformance`, `FP` = `firebase-ios-sdk/FirebasePerformance/Sources`.

**Bugsnag Performance: OTLP on the wire, no OTel SDK inside.**
- No `opentelemetry` dependency on either platform; tracer, span and sampler are Bugsnag's own classes (`bugsnag-android-performance/gradle/libs.versions.toml`, `bugsnag-cocoa-performance/Package.swift`, grep empty).
- Payload is an OTLP/HTTP JSON `ExportTraceServiceRequest` (`resourceSpans[].scopeSpans[].spans[]`, hex ids, `startTimeUnixNano` strings) (`BAP-I/TracePayload.kt:129-155`, `BAP-I/SpanImpl.kt:208-236`; `BCP/Private/OtlpTraceEncoding.mm:153-175`), gzip above a size threshold, plus `Bugsnag-Api-Key`, `Bugsnag-Integrity`, `Bugsnag-Span-Sampling`, `Bugsnag-Sent-At` headers (`BAP-I/TracePayload.kt:98-116`).
- Endpoint default `https://otlp.bugsnag.com/v1/traces`, public and overridable (`bugsnag-android-performance-api/.../PerformanceConfiguration.kt:17,181`; iOS `BCP/Public/BugsnagPerformanceConfiguration.mm:151-153`). So a stock OTel Collector OTLP/HTTP receiver should accept it (inference, not tested here); attributes are `bugsnag.*`.
- Span names: `[AppStart/AndroidCold|Warm|Hot]`, `[AppStart/iOSCold|Warm]`, `[AppStartPhase/…]`, `[ViewLoad/Activity|Fragment|Compose|UIKit…]<name>`, `[HTTP/<verb>]`, `FrozenFrame` (`BAP-I/SpanFactory.kt:140,208,298,326`; `BCP/Private/SpanFactory/AppStartup/AppStartupSpanFactoryImpl.mm:20`).
- App start origin: iOS uses the kernel process start time from `sysctl(KERN_PROC_PID)` `p_starttime` and detects prewarm via `ActivePrewarm` (`BCP/Private/Instrumentation/AppStartupInstrumentation/System/AppStartupInstrumentationSystemUtilsImpl.mm:17-34`); Android starts at its auto-registered `ContentProvider` init, not at process fork (`BAP-I/startup/BugsnagPerformanceProvider.kt:8-30`, `BAP-I/AppStartTracker.kt:21-29`).
- Frames: Android `OnFrameMetricsAvailableListener`, slow ≥ deadline × 1.05, frozen ≥ 700 ms (`BAP-I/framerate/FramerateCollector.kt:34-47`); iOS `CADisplayLink`, slow ≥ 1.3 × frame duration, frozen ≥ 0.7 s (`BCP/Private/FrameRateMetrics/FrameMetricsCollector.mm:17-18,141-149`).
- Sampling: deterministic on trace id, `p` stored in `bugsnag.sampling.p`, server can lower it via `Bugsnag-Sampling-Probability` response header (`BAP-I/SpanImpl.kt:198,420-426`; `BCP/Private/Sampler.h:29-41`).
- Crash SDKs: Android ANR = native `SIGQUIT` handler that re-raises to ART's Signal Catcher with `tgkill` (`bugsnag-android/bugsnag-plugin-android-anr/src/main/jni/anr_handler.c:345-458`, `anr_google.c:6-41`); iOS app hangs = main run-loop observer + watchdog semaphore, default fatal-only at 2 s (`bugsnag-cocoa/Bugsnag/Helpers/BSGAppHangDetector.m:68-107`). Crash payload is Bugsnag event JSON, not OTel.
- No session replay in either performance SDK (grep `replay` empty).

**Firebase Performance (iOS).**
- App start trace `_as` with stages `_astui`, `_astfd`, `_asti`; start time is `[NSDate date]` in `+load`, which the code itself calls an approximation (`FP/AppActivity/FPRAppActivityTracker.m:39-42,88-90`).
- Screen traces `_st_<ViewController>` with counters `_fr_tot`, `_fr_slo` (> 1/59 s) and `_fr_fzn` (> 700 ms) from `CADisplayLink`, driven by swizzled `viewDidAppear:` (`FP/AppActivity/FPRScreenTraceTracker.m:23-33,153,321-325`).
- Network by swizzling `NSURLSession` factory methods (`FP/Instrumentation/Network/FPRNSURLSessionInstrument.m:192-296`).
- Transport: nanopb protobuf `PerfMetric` through GoogleDataTransport, random per-install sampling from Remote Config plus a token bucket (`FirebasePerformance/ProtoSupport/Protos/perf_metric.proto:36-66`; `FP/Loggers/FPRGDTLogger.m:36-41`; `FP/Loggers/FPRGDTLogSampler.m:125-132`). Google endpoint only.
- No replay, no OTel.


## Comparison

### Replay capture technique per vendor and platform

Four families exist, not two: **screenshot video** (frames encoded with a video codec), **screenshot frames** (independent or tile-diffed still images), **wireframe** (view hierarchy serialised to geometry + text + image references), and **draw commands** (the renderer's own drawing operations recorded and replayed). Rows for Sentry and PostHog summarise appendices A-E and ADR-0006 (`docs/adr/0006-mobile-replay-native-screenshots.md`), not this appendix's own reading.

| Vendor | iOS | Android | React Native | Flutter | Masking default |
|---|---|---|---|---|---|
| Sentry (App. A-C) | screenshot video | screenshot video | native SDKs | native SDKs | text + images masked |
| PostHog (App. D-E) | wireframe by default, screenshot opt-in (SwiftUI needs screenshot) | wireframe by default, screenshot opt-in (Compose needs screenshot) | native SDKs forced to screenshot | Dart `toImage` frames, native uploads | text inputs + images masked |
| Datadog | wireframe (UIKit; SwiftUI DisplayList behind a flag that defaults off; experimental CALayer-tree pipeline) | wireframe (Views + Compose semantics) | native wireframe + RN mappers (Fabric ok) | Dart Element-tree wireframes (preview) | all text, all images, touches hidden |
| OpenReplay | JPEG frames, timer, 1/fps from server, scale 1.25, no dedupe | JPEG frames, 1 fps, short side 480-1080, no dedupe | native trackers | Dart `toImageSync` frames, hash dedupe | **opt-in only** (only registered views) |
| LaunchDarkly (ex-Highlight) | JPEG tiles, 1 fps, tile-hash diff, as rrweb `<img>` mutations | same (PixelCopy) | native | Dart `toImage` → native diff | text inputs only; labels and images opt-in |
| Microsoft Clarity | closed binary | closed binary (Skia picture classes) | wraps binaries | **draw commands** (open Dart) | strict (all text) |
| Splunk | closed Cisco/Smartlook binary (Screenshot, Wireframe, VideoEncoder targets) | closed Maven `sr-*` | not studied | not studied | — |
| Embrace, Bugsnag, Firebase, otel-android, otel-swift, Honeycomb, Elastic | none | none | none | none | — |

### OpenTelemetry support

| Vendor | OTel SDK in process | OTLP to an arbitrary collector | Session attribute | Own wire format |
|---|---|---|---|---|
| opentelemetry-android | yes (Java SDK) | yes, OTLP/HTTP, disk buffering | `session.id` (+ `session.start`/`end`) | — |
| opentelemetry-swift | yes | yes, OTLP HTTP/gRPC | `session.id` (`Sessions` module) | — |
| Honeycomb | yes (wraps the two above) | yes, endpoint overridable | `session.id` | — |
| Elastic EDOT | yes | yes, HTTP or gRPC | `session.id` | — |
| Splunk | yes (Java SDK / swift-core) | OTLP, but Android custom URLs must contain `auth=` | `session.id` + legacy `splunk.rumSessionId` | — (replay: separate OTLP logs endpoint) |
| Embrace | yes (opentelemetry-kotlin compat / swift-core) | yes, through app-registered exporters; export-only mode with no app id | iOS `session.id`; Android `emb.*` only | proprietary gzip JSON envelope |
| LaunchDarkly | yes (swift-core / Java 1.51 + otel-android) | yes, OTLP/HTTP JSON, endpoint + headers configurable | `session.id` (RN JS: `highlight.session_id`) | replay via Highlight GraphQL `PushPayload` |
| Bugsnag Performance | **no** (own tracer) | emits OTLP/HTTP JSON traces; endpoint overridable | `bugsnag.*` | it *is* OTLP JSON |
| Datadog | tracing **API** only | **no** (`/api/v2/spans`) | RUM JSON `session.id` field | proprietary |
| OpenReplay, Clarity, Firebase | no | no | — | proprietary |
| Grafana Faro | web only; RN unmerged | experimental OTLP transport | 15 min / 4 h | Faro protocol |

### Building blocks for ouo (Apache-2.0)

| Candidate | Licence | Use |
|---|---|---|
| opentelemetry-android | Apache-2.0 | direct dependency for the Android SDK: sessions, crash, ANR, jank, OTLP, disk buffering |
| opentelemetry-swift | Apache-2.0 | direct dependency for iOS; `Sessions` module released; KSCrash `Crash` module unreleased; SwiftPM layout in flux |
| LaunchDarkly Swift / Android replay | Apache-2.0 | closest design to ouo's: screenshot replay emitted as rrweb, so ouo's rrweb player can play it. Tile-hash C ships as a binary; its older source is in git history |
| Datadog SR (schema, mappers, diff) | Apache-2.0 | reference if ouo ever adds a wireframe mode; the schema is Datadog's, not rrweb |
| Embrace | Apache-2.0 | reference for mapping crash / ANR / start / taps onto OTel spans and logs, and for an "export-only" mode |
| clarity_flutter | MIT | reference for draw-command capture on Flutter |
| Bugsnag | MIT | app-start origin via `sysctl`, ANR via `SIGQUIT`, frame thresholds |
| OpenReplay | ELv2 / AGPL / unlicensed | ideas only, no code |
| Splunk replay, Clarity native | closed | nothing to reuse |

### Performance claims and how they were measured

| Vendor | Claim | Method | Where |
|---|---|---|---|
| Datadog Android | CPU 26.8 % vs 25.2 %, TTID 243 vs 229 ms, APK +552 KB; SR janky frames 3.2 % → 3.9-5.6 % (Views), 2.9 % → 6.2-6.9 % (Compose), memory up to +55 MB | baseline vs instrumented benchmark app in Synthetics; `/proc` CPU/RSS, Choreographer FPS; exported with the OTel metrics SDK | `dd-sdk-android/docs/sdk_performance.md:59-289` `[docs only]`; harness `tools/benchmark/` |
| Datadog iOS | IPA 22.2 → 23.6 MB; SR graphs only | Synthetics scenarios, `task_info` CPU/memory, `CADisplayLink` FPS | `dd-sdk-ios/docs/sdk_performance.md:128-130` `[docs only]`; `BenchmarkTests/` |
| Embrace iOS | launch 2.360 s vs 2.317 s (+1.9 %) | `XCTApplicationLaunchMetric`, with vs without SDK; PR gate on BrowserStack, Welch t-test, 5 % threshold | `embrace-apple-sdk/Examples/Benchmarks/`, `.github/workflows/run-device-benchmarks.yml` |
| Embrace Android | none committed | macro/micro benchmarks + Perfetto analyser, excluded from CI | `embrace-android-sdk/embrace-macrobenchmark/README.md` |
| LaunchDarkly | hash "20x", "100x on Pixel 8", encode 17 → 4 ms | none committed | `[commit message only]` |
| Bugsnag Android | none in README | `benchmarks/` microbenchmark (`SpanBenchmark.kt`) run on BitBar from a Buildkite pipeline | `bugsnag-android-performance/benchmarks/src/androidTest/java/com/bugsnag/benchmarks/SpanBenchmark.kt`; `.buildkite/pipeline.benchmark.yml:19-24` |
| OpenReplay, Clarity, otel-android, Honeycomb, Elastic, Splunk | none found | — | (grep for benchmark files in each repo empty) |

Derived estimates for wire size: Datadog wireframes ≈ 1.6 KB per compressed 50-node full snapshot (G.2); OpenReplay 30-60 KB per JPEG frame with no codec or dedupe on native (G.3); LaunchDarkly sends only the bounding rect of changed 64-px tiles at q 0.3 and nothing for an unchanged screen (G.6).

## 8. Blog-to-code grounding

| Claim | Where it is in code |
|---|---|
| Embrace "OpenTelemetry-native" | true for the in-process pipeline (opentelemetry-kotlin / swift-core, `addSpanExporter`, `OTelOptions`), false for its own backend wire format (`Envelope.kt:16-30`, "does not map directly to an OTLP spec") (G.1) |
| Datadog "OpenTelemetry support" on mobile | OTel tracing API implemented (`OTelTracerProvider.swift:11-36`, `OtelTracerProvider.kt:25-42`); no OTLP exporter anywhere (G.2) |
| Datadog Session Replay is not video | wireframe records, Heckel diff, images uploaded separately (`SRDataModels.swift:3067-3076`, `MutationResolver.kt`) (G.2) |
| Datadog SwiftUI replay | code exists (`UIHostingViewRecorder.swift`) but the flag defaults to false (`SessionReplayConfiguration.swift:128-133`) (G.2) |
| Splunk "mobile session replay" | only proxy / wrapper targets are open; the recorder is a Cisco/Smartlook binary (`splunk-otel-ios/Package.swift:750-860`) (G.5) |
| otel-android: session replay "planned" | roadmap only; blocked on a data model (`docs/ROADMAP.md:228-237`) (G.5) |
| Embrace iOS launch overhead | committed baseline +43 ms (G.1) |
| Bugsnag "OTLP" | wire is OTLP/HTTP JSON (`TracePayload.kt:129-155`); there is no OTel SDK inside (G.7) |

## 9. Questions asked and answers

1. **Does any open-source OTel-based mobile SDK ship session replay?** Not as pure OTel. LaunchDarkly is OTel for telemetry but sends replay over Highlight's GraphQL (`SR/Operations/PushPayloadOperation.swift:112-138`); Splunk's recorder is closed (`splunk-otel-ios/Package.swift:839-845`); otel-android has none (`docs/ROADMAP.md:228-237`).
2. **Is there an open mobile replay that produces rrweb events?** Yes: LaunchDarkly encodes JPEG tiles as rrweb `<img>` nodes with absolute positions and rrweb Mutation adds/removes (`swift-launchdarkly-observability/Sources/LaunchDarklySessionReplay/ScreenCapture/ExportFrame.swift:19-30 @ e42fedb5ecb2`; `Exporter/RRWebEventGenerator.swift:402-488`). An rrweb player replays it without changes.
3. **Is Embrace really OTel-native?** In process yes; on the wire to Embrace no (`embrace-android-payload/…/payload/Envelope.kt:16-30 @ e83c3b5feffb`). Raw OTLP needs exporters you add (`OTelApi.kt:19-49`).
4. **Can Embrace run with no Embrace backend?** Yes, no app id + an OTel exporter (`ConfigServiceImpl.kt:85-95 @ e83c3b5feffb`; Apple `EmbraceIO+Options.swift:99-115 @ 612a2fdef639`), but on Android nothing is persisted to disk in that mode (`RealSdkInstanceFactory.kt:452-456`).
5. **Is Embrace's session an OTel span?** Yes: one `emb-session` span per foreground/background "session part", with UX events as span events on it (`CurrentSessionPartSpanImpl.kt:258-267`; `TelemetryDestinationImpl.kt:176-184`), so OTLP consumers see taps only when the part ends (`EmbraceSpanProcessor.kt:36-38`).
6. **Does Datadog mobile export OTLP?** No. It implements the OTel tracing API and ships spans to `/api/v2/spans` (`dd-sdk-ios/DatadogTrace/Sources/OpenTelemetry/OTelTracerProvider.swift:11-36 @ d61711956d28`).
7. **How often does Datadog capture?** iOS: at most every 100 ms, only after a `CALayer` change (`RecordingComponents.swift:89`); Android: 64 ms debounce after `onDraw`, capped at 100 ms of work per second (`Debouncer.kt:110`; `RecordingTimeBank.kt:20-41`), full snapshot every 3 s (`RecordedDataProcessor.kt:226 @ cc893d24377c`).
8. **Does Datadog Flutter have replay?** Yes, in preview: Dart Element-tree wireframes handed to the native SDK (`dd-sdk-flutter/packages/datadog_session_replay/lib/src/capture/recorder.dart:79-203 @ 0e5a78f8f489`).
9. **What does OpenReplay mask by default?** Nothing drawn on screen; only views the app registers (`ios-tracker/Sources/OpenReplay/ScreenCapture/ScreenCapture.swift:116-128,191-246 @ 29fe11bf90d5`); secure text fields are `***` only in input events (`Listeners/Analytics.swift:69-81`).
10. **How does OpenReplay's player show mobile sessions?** It downloads one zstd file of `[ts][size][jpeg]` records and shows the last frame at or before the playhead (`openreplay/backend/pkg/images/service/image.go:108-137 @ 7d7bf61a5a9d`; `player/src/mobile/managers/SnapshotManager.ts:29-51`).
11. **Is Clarity's mobile capture open?** Only on Flutter (MIT Dart, draw-command capture: `clarity_flutter/lib/src/helpers/snapshot_canvas.dart:20`); iOS and Android are binaries (`clarity-apps/Package.swift:16-20 @ 41ef04cdefe1`).
12. **Which session attribute does the ecosystem use?** `session.id` / `session.previous_id` with `session.start` / `session.end` events, all `development` (`semantic-conventions/model/session/registry.yaml:4-13 @ fc53bc69024f`); used by otel-android, otel-swift, Honeycomb, Splunk, Elastic, LaunchDarkly native, Embrace iOS.
13. **Which session timeouts?** 15 min background / 4 h max: otel-android, Datadog, Splunk, Faro, LaunchDarkly Android. 30 min idle: otel-swift, Elastic, Embrace (12 h max). See G.1, G.2, G.5.
14. **Is there a semconv for app start or screen views?** No. Only `app.screen.*` / `app.widget.*` attributes, click / jank / crash events and `device.app.lifecycle` (`model/app/events.yaml:2-94`; `model/device/events.yaml:2-23 @ fc53bc69024f`).
15. **Does otel-swift catch crashes?** In releases only via MetricKit (next launch); a KSCrash module is on main, unreleased (`opentelemetry-swift/Package.swift:373,394 @ 8c24c12e0867`).
16. **Is opentelemetry-swift-core the future?** No: its content moved back into opentelemetry-swift on 2026-10-08 (commit `4481533`), untagged; -core development is paused (`opentelemetry-swift-core/README.md:4`) `[docs only]`.
17. **Does Grafana Faro have mobile?** No; RN packages exist only on unmerged branches (`faro-web-sdk/README.md:85 @ b2e64183d310`; branch `origin/feat/react-native-support`).
18. **Can Bugsnag Performance feed an OTel Collector?** Probably: OTLP/HTTP JSON with an overridable endpoint (`PerformanceConfiguration.kt:17,181 @ 595e89eb519c`). Not tested end to end.
19. **What is the most precise app-start origin?** Kernel process start time via `sysctl(KERN_PROC_PID)` on iOS (Bugsnag, `AppStartupInstrumentationSystemUtilsImpl.mm:17-28 @ b9ab2d589722`); Firebase uses `+load` time and says it is an approximation (`FPRAppActivityTracker.m:88-90`).
20. **Which frozen-frame threshold is standard?** 700 ms everywhere: Datadog, otel-android, Bugsnag, Firebase (G.2, G.5, G.7).

## 10. Takeaways for ouo

1. **Nobody has OTel-native mobile replay, and ouo's rrweb choice lines up with the one open design that comes close.** LaunchDarkly (Apache-2.0) shows that screenshot replay can be expressed as plain rrweb: JPEG tiles as absolutely positioned `<img>` nodes, rrweb Mutation adds/removes for changed tiles, a keyframe every 10-15 frames, a new FullSnapshot after ~9 MB. ouo's Grafana rrweb player could then play mobile and web with one renderer, instead of the separate frame player ADR-0006 planned. Worth an ADR revision: compare "frames chunk kind" (ADR-0006) with "rrweb `<img>` tiles" on bytes and player complexity before building the Android side.
2. **Take tile-diff, not whole-frame dedupe.** ADR-0006 dedupes identical frames. LaunchDarkly hashes 64-px tiles and sends only the bounding rect of changed tiles, plus "backtracking" removes when a screen returns to an earlier state. OpenReplay shows the cost of not diffing: full JPEGs at 1-3 fps whether or not anything changed.
3. **Build on opentelemetry-android and opentelemetry-swift, using their session semantics as they are.** Use `session.id`, `session.previous_id`, `session.start` / `session.end`, `app.*` and `device.app.lifecycle` from semconv v1.44 (development). otel-android already gives sessions (15 min background / 4 h max; ouo's web default is 30 min inactivity per `project/kb/competitors.md`, so pick one rule for web and mobile), crash, ANR, jank, OTLP and disk buffering. otel-swift is weaker: no lifecycle, taps, screens or released crash capture, and its package layout just changed (-core merged back, Swift 6.2, untagged). Pin a version and expect to add lifecycle, screen and tap instrumentation ourselves. Honeycomb's Swift code (Apache-2.0) shows how.
4. **Copy Embrace's span mapping, not its wire format.** Session part as a span, crashes as logs with a typed attribute, ANR as a span with sample events, cold/warm start span trees: these map RUM onto OTel cleanly. But UX events that are span events on a long-lived session span reach the collector only when the span ends. ouo should emit taps and screen views as their own log events (semconv `app.screen.click` style), so they arrive within a batch interval.
5. **Mask by default.** Datadog and Clarity mask all text by default, and LaunchDarkly masks inputs and drops any frame whose mask geometry moved between passes. OpenReplay's opt-in masking is the anti-pattern. ADR-0006's defaults (inputs, labels, images, web views masked) are in the safe camp. Add LaunchDarkly's two-pass mask check.
6. **Bound the capture cost explicitly.** Datadog Android's time bank (100 ms of capture per second, skip and report beyond it) and change-driven triggers (iOS `CALayer` swizzle at most every 100 ms) are cheap guards worth copying. Datadog's own numbers show replay costs real jank (Compose janky frames 2.9 % → 6.9 %). ouo should measure the same way: baseline vs instrumented app, CPU, memory, FPS / janky frames, and report through its own OTel pipeline as Datadog does.
7. **Nothing to reuse from OpenReplay, Splunk replay or Clarity native.** Their licences (ELv2, AGPL, unlicensed) or closed binaries rule them out; ideas only.
8. **Competitive gap is real.** Datadog uses OTel as an API only; Embrace's backend format is proprietary; Splunk's replay is closed. "Native SDKs that export OTLP for all signals, including replay, to your own collector" is something none of the studied vendors offers today.
