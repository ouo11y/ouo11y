# Sentry React Native SDK: configuration reference

@sentry/react-native 8.34.0 (tag, 2026-11-05), @sentry/core 10.78.0, sentry-cocoa 9.33.0, sentry-android 8.62.0. Research date 2026-11-10. Method: source read at the tag; docs accessed 2026-11-10.

Notes:
- sentry-java was read at **8.63.0** (local clone); RN pins 8.62.0. Defaults quoted from 8.63.0 are *uncertain* for 8.62.0.
- "Where": **JS** = JS layer only; **iOS** / **Android** = forwarded to and read by that native SDK. "Default" is the effective default after RN's own defaults ([sdk.tsx#L49-L66](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L49-L66)); "native default" means RN sets nothing and the native SDK default applies.
- "no reader found" means the key is declared in `options.ts` but grep over the RN JS/iOS/Android sources and the native dictionary parsers found no code that reads it.
- Feature-level summary per platform: [sentry-mobile.md](../../../../client-sdk-features/vendors/sentry-mobile.md). Architecture: [architecture.md](architecture.md). Reliability: [reliability.md](reliability.md).

## 1. `BaseReactNativeOptions` (options.ts)

Source file: [options.ts](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts).

### 1.1 Native bridge and init

| Option | Default | Effect | Where | Source |
|---|---|---|---|---|
| `enableNative` | true (false if the RNSentry module is missing) | Native transport, scope sync, device context, offline cache | JS | [options.ts#L25](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L25), [sdk.tsx#L90-L91](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L90-L91) |
| `enableNativeCrashHandling` | true | iOS: false sets `enableCrashHandler = NO`. Android: false removes UncaughtExceptionHandler, ANR and NDK integrations | iOS, Android | [options.ts#L31](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L31), [RNSentryStart.m#L156-L163](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L156-L163), [RNSentryStart.java#L252-L262](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L252-L262) |
| `autoInitializeNativeSdk` | true; forced false in release builds when `sentry.options.json` is bundled and the key is not set | false: JS does not call native init | JS | [options.ts#L44](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L44), [sdk.tsx#L167-L177](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L167-L177) |
| `enableNativeNagger` | true, except web, Windows, Expo Go | Dev alert if native init fails | JS | [options.ts#L47](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L47), [options.ts#L832-L849](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L832-L849) |
| `onReady` | undefined | Called after native init with `{didCallNativeInit}` | JS | [options.ts#L146](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L146), [client.ts#L284-L287](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L284-L287) |
| `onNativeLog` | console handler when `debug` | Native SDK debug logs forwarded to JS | JS | [options.ts#L738](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L738), [client.ts#L231-L234](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L231-L234) |
| `spotlight` | undefined | JS integration in `__DEV__`; natives enable Spotlight with URL | JS, iOS, Android | [options.ts#L486](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L486), [RNSentryStart.m#L165-L181](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L165-L181), [RNSentryStart.java#L215-L225](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L215-L225) |
| `enableTurboModuleTracking` | false | Installs native TurboModule perf logger; no production sink yet, emits nothing | iOS, Android | [options.ts#L560](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L560), [RNSentry.mm#L221-L222](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentry.mm#L221-L222), [RNSentryModuleImpl.java#L243-L259](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryModuleImpl.java#L243-L259) |

### 1.2 Sessions, crashes, hangs

| Option | Default | Effect | Where | Source |
|---|---|---|---|---|
| `enableAutoSessionTracking` | native default true (iOS [Options.swift#L302](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L302), Android [SentryOptions.java#L300](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryOptions.java#L300)) | Release health sessions. On web it gates `browserSessionIntegration` | iOS, Android (web: JS) | [options.ts#L50](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L50), [Options+Dictionary.swift#L145](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L145), [RNSentryStart.java#L123-L125](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L123-L125) |
| `sessionTrackingIntervalMillis` | native default 30000 (iOS [Options.swift#L316](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L316), Android [SentryOptions.java#L306](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryOptions.java#L306)) | Background time after which the session ends | iOS, Android | [options.ts#L53](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L53), [Options+Dictionary.swift#L161](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L161), [RNSentryStart.java#L126-L128](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L126-L128) |
| `enableNdk` | true | sentry-native crash capture | Android | [options.ts#L60](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L60), [RNSentryStart.java#L169-L171](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L169-L171) |
| `enableNdkScopeSync` | native default true ([SentryAndroidOptions.java#L198](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-core/src/main/java/io/sentry/android/core/SentryAndroidOptions.java#L198)) | Java scope → NDK | Android | [options.ts#L91](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L91), [RNSentryStart.java#L132-L134](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L132-L134) |
| `enableTombstone` | false | ApplicationExitInfo native crash (Android 12+) | Android | [options.ts#L70](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L70), [RNSentryStart.java#L175-L177](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L175-L177) |
| `enableHistoricalTombstoneReporting` | false | Report older tombstones too (no scope data) | Android | [options.ts#L84](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L84), [RNSentryStart.java#L178-L181](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L178-L181) |
| `enableAnrFingerprinting` | true | System-frame-only ANRs grouped into one issue | Android | [options.ts#L104](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L104), [RNSentryStart.java#L182-L184](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L182-L184) |
| `anrProfilingSampleRate` | undefined (off) | Profile main thread during ANR | Android | [options.ts#L119](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L119), [RNSentryStart.java#L185-L188](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L185-L188) |
| `enableNdkAppHangTracking` / `ndkAppHangTimeoutIntervalMillis` | false / 5000 | sentry-native heartbeat app-hang detection | Android | [options.ts#L256-L267](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L256-L267), [RNSentryStart.java#L189-L195](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L189-L195) |
| `enableWatchdogTerminationTracking` | true (also native default) | iOS OOM / watchdog kill heuristic | iOS | [options.ts#L164](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L164), [Options+Dictionary.swift#L153](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L153) |
| `enableAppHangTracking` / `appHangTimeoutInterval` | native default true / 2 s | UI-thread hang events | iOS | [options.ts#L199-L212](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L199-L212), [Options+Dictionary.swift#L245-L252](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L245-L252) |
| `enableJsHangTracking` / `jsHangTimeoutInterval` | false / 2 s (min 0.25) | JS-thread hang → error event created by native; JS `beforeSend` not applied; off in `__DEV__`. Stripped from the native options dict, started via `startJsHangTracking` | JS → iOS | [options.ts#L231-L244](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L231-L244), [wrapper.ts#L347-L356](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L347-L356) |
| `enableMetricKit` / `enableMetricKitRawPayload` | false / false | MetricKit diagnostics (may duplicate app hangs) | iOS | [options.ts#L369-L380](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L369-L380), [Options+Dictionary.swift#L322-L330](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L322-L330) |
| `enableMemoryIntrospection` | false | Memory near crash site in crash events | iOS | [options.ts#L395](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L395), [Options+Dictionary.swift#L356](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L356) |
| `attachThreads` | native default false ([SentryOptions.java#L290](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryOptions.java#L290)) | All threads on Android events | Android | [options.ts#L126](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L126), [RNSentryStart.java#L138-L142](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L138-L142) |
| `attachAllThreads` | false (documented) | Documented as "all threads on iOS events". **No reader found**: not in `Options+Dictionary.swift` nor in RN iOS code. Inferred no-op; *uncertain* | iOS (intended) | [options.ts#L134](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L134) |
| `patchGlobalPromise` | true | Promise polyfill for rejection tracking when Hermes tracker is absent | JS | [options.ts#L181](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L181) |

### 1.3 Breadcrumbs (native)

| Option | Default | Effect | Where | Source |
|---|---|---|---|---|
| `enableNetworkBreadcrumbs` | true | Native per-request breadcrumbs (deduped against JS ones when merged into JS events) | iOS | [options.ts#L280](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L280), [Options+Dictionary.swift#L113](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L113) |
| `enableAutoBreadcrumbTracking` | true | System event breadcrumbs | iOS | [options.ts#L306](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L306), [Options+Dictionary.swift#L300](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L300) |
| `enableNetworkEventBreadcrumbs` | true | Connectivity breadcrumbs | Android | [options.ts#L294](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L294), [RNSentryStart.java#L196-L199](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L196-L199) |
| `enableActivityLifecycleBreadcrumbs`, `enableAppLifecycleBreadcrumbs`, `enableSystemEventBreadcrumbs`, `enableAppComponentBreadcrumbs` | true each | Native lifecycle/system breadcrumbs | Android | [options.ts#L317-L351](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L317-L351), [RNSentryStart.java#L200-L214](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L200-L214) |

### 1.4 Attachments

| Option | Default | Effect | Where | Source |
|---|---|---|---|---|
| `attachScreenshot` | false | JS `Screenshot` integration (bridge call per JS error) and native screenshots on native events | JS, iOS, Android | [options.ts#L407](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L407), [default.ts#L110-L112](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/default.ts#L110-L112), [Options+Dictionary.swift#L202](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L202), [RNSentryStart.java#L143-L145](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L143-L145) |
| `screenshot.maskAllText` / `.maskAllImages` | true / true. Android: RN turns masking on although the native Android default is off; masking needs `sentry-android-replay` | Mask error screenshots | iOS, Android | [options.ts#L416-L441](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L416-L441), [RNSentryStart.m#L86-L136](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L86-L136), [RNSentryStart.java#L392-L440](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L392-L440) |
| `screenshot.maskedViewClasses` / `.unmaskedViewClasses` | undefined | Native class names | iOS, Android | same |
| `beforeScreenshot` | undefined | Return false to skip the JS screenshot. Function: never sent to native | JS | [options.ts#L493](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L493) |
| `attachViewHierarchy` | false | JS `ViewHierarchy` integration + native | JS, iOS, Android | [options.ts#L448](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L448), [Options+Dictionary.swift#L206](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L206), [RNSentryStart.java#L150-L152](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L150-L152) |
| `reportAccessibilityIdentifier` | true | accessibilityIdentifier in view hierarchy (not gated by `sendDefaultPii`) | iOS | [options.ts#L462](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L462), [Options+Dictionary.swift#L210](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L210) |

### 1.5 Tracing and performance

| Option | Default | Effect | Where | Source |
|---|---|---|---|---|
| `enableAutoPerformanceTracing` | true | Gates `AppRegistry`, `ReactNativeTracing`, `ExpoRouter`. iOS: sets hybrid mode for app start and frames | JS, iOS | [options.ts#L152](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L152), [default.ts#L152-L155](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/default.ts#L152-L155), [RNSentryStart.m#L276-L281](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L276-L281) |
| `enableAppStartTracking` | true | `AppStart` integration (needs tracing + native) | JS | [options.ts#L503](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L503) |
| `enablePreWarmedAppStartTracing` | true | Measure pre-warmed starts | iOS | [options.ts#L515](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L515), [Options+Dictionary.swift#L222](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L222) |
| `enableNativeFramesTracking` | true | `NativeFrames` integration | JS (+ native frames tracker) | [options.ts#L523](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L523) |
| `enableStallTracking` | true | JS event-loop stall measurements | JS | [options.ts#L530](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L530) |
| `enableUserInteractionTracing` | false | `ui.action` spans. The key is also read by the iOS parser, but native tracing is off (inferred no effect there) | JS | [options.ts#L567](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L567), [Options+Dictionary.swift#L214](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L214) |
| `enableCaptureFailedRequests` | false | JS `HttpClient` integration. iOS: forced `NO` natively. Android: key not mapped | JS | [options.ts#L471](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L471), [RNSentryStart.m#L231-L232](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L231-L232) |
| `propagateTraceparent` | false | Add W3C `traceparent` to outgoing requests | JS | [options.ts#L697](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L697) |
| `profilesSampleRate` | undefined | Hermes profiler per transaction. Not read by either native options parser | JS | [options.ts#L573](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L573), [default.ts#L116-L118](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/default.ts#L116-L118) |

### 1.6 Replay (top-level keys)

| Option | Default | Effect | Where | Source |
|---|---|---|---|---|
| `replaysSessionSampleRate` | undefined (native default 0) | Any number auto-adds `mobileReplayIntegration`. Mapped to native `sessionReplay.sessionSampleRate` | JS, iOS, Android | [options.ts#L579](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L579), [default.ts#L176-L192](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/default.ts#L176-L192), [RNSentryReplay.mm#L16-L33](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplay.mm#L16-L33), [RNSentryStart.java#L453-L465](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L453-L465) |
| `replaysOnErrorSampleRate` | undefined (native default 0) | Mapped to iOS `sessionReplay.errorSampleRate` (dictionary key), Android `setOnErrorSampleRate` | JS, iOS, Android | [options.ts#L586](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L586), [RNSentryReplay.mm#L34](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplay.mm#L34) |
| `replaysSessionQuality` | `'medium'` | Replay quality. Read on iOS only; no Android reader found (inferred: Android uses its native default) | iOS | [options.ts#L602](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L602), [RNSentryReplay.mm#L27](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplay.mm#L27), [L35](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplay.mm#L35) |

### 1.7 Transport, queue, cache

| Option | Default | Effect | Where | Source |
|---|---|---|---|---|
| `maxQueueSize` | 30 (`DEFAULT_BUFFER_SIZE`); falls back to deprecated `transportOptions.bufferSize` | JS: size of the `NativeTransport` PromiseBuffer and (via `transportOptions.bufferSize`) of the @sentry/core client processing buffer. Android: `setMaxQueueSize`. iOS: not read | JS, Android | [options.ts#L400](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L400), [sdk.tsx#L87-L88](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L87-L88), [sdk.tsx#L155-L160](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L155-L160), [core client.ts#L241](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/client.ts#L241), [RNSentryStart.java#L166-L168](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L166-L168) |
| `maxCacheItems` | native default 30 (iOS [Options.swift#L173](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L173), Android [SentryOptions.java#L206](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryOptions.java#L206)) | Max envelopes in the disk cache | iOS, Android | [options.ts#L188](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L188), [Options+Dictionary.swift#L117](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L117), [RNSentryStart.java#L111-L113](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L111-L113) |
| `shutdownTimeout` | unset; JS fatal handler uses 2000 ms; native default 2 s ([Options.swift#L70](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L70), [SentryOptions.java#L123](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryOptions.java#L123)) | JS: flush wait before RN's fatal handler. iOS: ms → `shutdownTimeInterval` s. Android: `setShutdownTimeoutMillis` | JS, iOS, Android | [options.ts#L594](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L594), [reactnativeerrorhandlers.ts#L235](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/reactnativeerrorhandlers.ts#L235), [RNSentryStart.m#L213-L220](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L213-L220), [RNSentryStart.java#L129-L131](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L129-L131) |
| `transportOptions.bufferSize` | — | Deprecated alias of `maxQueueSize` | JS | [options.ts#L793-L798](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L793-L798) |

### 1.8 Logs and misc

| Option | Default | Effect | Where | Source |
|---|---|---|---|---|
| `logsOrigin` | `'all'` | `'native'`: JS logs disabled; `'js'`: native `enableLogs` set false | JS, iOS, Android | [options.ts#L707](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L707), [client.ts#L76-L80](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L76-L80), [wrapper.ts#L295-L297](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L295-L297) |
| `enableAutoConsoleLogs` | true | `console.*` → logs when `enableLogs` | JS | [options.ts#L719](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L719), [default.ts#L104-L109](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/default.ts#L104-L109) |
| `sendDefaultPii` | false | JS: `infer_ip` setting, IP on sessions. Natives: their PII gates | JS, iOS, Android | [options.ts#L141](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L141), [client.ts#L58-L68](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L58-L68), [Options+Dictionary.swift#L174](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L174), [RNSentryStart.java#L153-L155](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L153-L155) |
| `initialScope` | undefined (deprecated) | Initial JS scope | JS | [options.ts#L170](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L170) |
| `useThreadsForMessageStack` | false (deprecated) | **No reader found** in RN JS/iOS/Android code. Inferred no-op; *uncertain* | — | [options.ts#L683](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L683) |

## 2. `_experiments`

| Option | Default | Effect | Where | Source |
|---|---|---|---|---|
| `replaysSessionSampleRate`, `replaysOnErrorSampleRate` | undefined | Deprecated. Copied to the top-level keys only if both top-level keys are unset | JS → natives | [options.ts#L615-L622](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L615-L622), [default.ts#L182-L186](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/default.ts#L182-L186) |
| `enableUnhandledCPPExceptionsV2` | false | Hook `__cxa_throw` for C++ exceptions | iOS | [options.ts#L634](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L634), [RNSentryStart.m#L183-L190](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L183-L190) |
| `profilingOptions.profileSessionSampleRate` | undefined (off) | UI profiling per session | iOS, Android | [options.ts#L772](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L772), [RNSentryExperimentalOptions.m#L44](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryExperimentalOptions.m#L44), [RNSentryStart.java#L285-L299](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L285-L299) |
| `profilingOptions.lifecycle` | `'manual'` | JS uses it in `uiProfilingIntegration`; **both natives are forced to MANUAL** and JS calls start/stop | JS (native always manual) | [options.ts#L781](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L781), [RNSentryExperimentalOptions.m#L49-L50](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryExperimentalOptions.m#L49-L50), [RNSentryStart.java#L301-L302](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L301-L302) |
| `profilingOptions.startOnAppStart` | false | iOS `profileAppStarts`, Android `setStartProfilerOnAppStart` | iOS, Android | [options.ts#L790](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L790), [RNSentryExperimentalOptions.m#L55](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryExperimentalOptions.m#L55), [RNSentryStart.java#L305-L318](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L305-L318) |
| `androidProfilingOptions` | undefined | Deprecated alias of `profilingOptions` | as above | [options.ts#L655](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L655), [wrapper.ts#L361-L369](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L361-L369) |
| `enableStandaloneAppStartTracing` | false | App start as its own `app.start` transaction | JS | [options.ts#L674](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L674), [default.ts#L131-L139](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/default.ts#L131-L139) |
| other browser `_experiments` | — | Type allows the @sentry/browser `_experiments` subset | JS | [options.ts#L607-L608](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L607-L608) |

Profiling options are taken out of `_experiments` before the JS → native call and only forwarded when `uiProfilingIntegration` is installed ([client.ts#L242-L256](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L242-L256)).

## 3. Inherited @sentry/core `Options` that matter on RN

Source: [types/options.ts](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts). `ReactNativeOptions` omits `_experiments`, `dataCollection`, `sendDefaultPii` from core; `ReactNativeClientOptions` also omits `tunnel` ([options.ts#L809-L817](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L809-L817)).

| Option | Default on RN | Effect | Where | Source |
|---|---|---|---|---|
| `dsn` | — | Trimmed before native init; no DSN → native not started | JS, iOS, Android | [types/options.ts#L207](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts#L207), [wrapper.ts#L317-L328](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L317-L328) |
| `debug` | false | Debug logs; JS also forwards native logs | JS, iOS, Android | [L173](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts#L173) |
| `enabled` | true | | JS, iOS | [L182](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts#L182) |
| `release` | JS: undefined on mobile (Release integration fills from native `bundleId@version+build`) | | JS, iOS, Android | [release.ts#L24-L28](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/utils/release.ts#L24-L28) |
| `dist` | from native build number | | JS, iOS, Android | [release.ts#L35-L54](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/release.ts#L35-L54) |
| `environment` | `development` if `__DEV__` else `production` (core default would be `production`) | Passed to natives too | JS, iOS, Android | [sdk.tsx#L183-L185](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L183-L185), [environment.ts#L146-L148](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/utils/environment.ts#L146-L148) |
| `sampleRate` | 1.0 | JS sampling of JS errors; natives sample native events. JS envelopes are not re-sampled natively | JS, iOS, Android | [L309](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts#L309), [RNSentryStart.java#L102-L104](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L102-L104) |
| `tracesSampleRate`, `tracesSampler` | undefined | JS tracing only; removed/nulled natively | JS | [L271](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts#L271), [RNSentry.mm#L183-L185](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentry.mm#L183-L185) |
| `attachStacktrace` | **true** (core default false) | | JS, iOS, Android | [sdk.tsx#L58](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L58) |
| `sendClientReports` | true | Both JS and natives emit client reports | JS, iOS, Android | [sdk.tsx#L56](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L56) |
| `maxBreadcrumbs` | 100 | Both sides | JS, iOS, Android | [breadcrumbs.ts#L10](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/breadcrumbs.ts#L10) |
| `beforeSend`, `beforeSendTransaction`, `beforeSendSpan`, `beforeBreadcrumb`, `beforeSendLog`, `beforeSendMetric` | undefined | **JS only.** All functions are stripped before native init | JS | [wrapper.ts#L192-L201](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L192-L201) |
| `ignoreErrors` | [] | JS inbound filter; also strings and RegExp sources forwarded as `ignoreErrorsStr` / `ignoreErrorsRegex` and applied to native events | JS, iOS, Android | [wrapper.ts#L333-L343](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L333-L343), [RNSentry.mm#L231-L295](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentry.mm#L231-L295), [RNSentryModuleImpl.java#L1659-L1663](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryModuleImpl.java#L1659-L1663) |
| `ignoreTransactions`, `ignoreSpans`, `allowUrls`, `denyUrls` | [] | | JS | [L360-L371](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts#L360-L371), [L481-L493](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts#L481-L493) |
| `tracePropagationTargets` | **`[/.*/]`** on native platforms | Trace headers on all requests | JS | [reactnativetracing.ts#L72-L77](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnativetracing.ts#L72-L77) |
| `strictTraceContinuation`, `orgId` | false / undefined | | JS, iOS, Android | [L549](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts#L549), [RNSentryStart.m#L199-L211](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L199-L211) |
| `enableLogs` | core default **true** ([client.ts#L266](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/client.ts#L266), [logs/internal.ts#L87](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/logs/internal.ts#L87)). RN treats unset as off for console capture, native logs and its 5 s timer | See note below | JS, iOS, Android | [client.ts#L76-L107](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L76-L107) |
| `enableMetrics` | true | JS metrics | JS | [L607](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts#L607) |
| `normalizeDepth` / `normalizeMaxBreadth` | 3 / 1000 | | JS | [L326-L338](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts#L326-L338) |
| `maxValueLength` | no default stated | | JS | [L314](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/types/options.ts#L314) |
| `parentSpanIsAlwaysRootSpan` | **true** on RN | | JS | [client.ts#L71-L72](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L71-L72) |
| `integrations`, `defaultIntegrations` | see [architecture.md](architecture.md) | `defaultIntegrations: false` also drops auto replay / UI profiling integrations | JS | [sdk.tsx#L187-L193](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L187-L193) |
| `transport`, `transportOptions`, `stackParser` | native transport / defaultStackParser | | JS | [sdk.tsx#L149-L162](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L149-L162) |
| `tunnel` | — | Omitted from client options type; native transport sends to the DSN host (inferred: no tunnel support with native transport) | — | [options.ts#L816](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L816) |

Note on `enableLogs` (inferred from source, not run): RN copies `enableLogs`, may set it false for `logsOrigin: 'native'`, calls the core constructor (which backfills `?? true` on the same options object), and then restores the original value ([client.ts#L76-L107](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L76-L107), [core client.ts#L235](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/client.ts#L235), [L266-L271](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/client.ts#L266-L271)). With `enableLogs` unset, explicit `Sentry.logger.*` calls are therefore still captured in JS (core's capture defaults to true) and flushed by core's 5 s / 800 KB timer, while console capture, the log enricher and native logs stay off. *Uncertain* until observed.

## 4. `mobileReplayIntegration` options

Source: [replay/mobilereplay.ts#L47-L318](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L47-L318). Defaults object at [L305-L318](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L305-L318).

| Option | Default | Effect | Where | Source |
|---|---|---|---|---|
| `maskAllText` | true | iOS adds `RCTTextView`, `RCTParagraphComponentView` to masked classes | iOS, Android | [L53](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L53), [RNSentryReplay.mm#L73-L76](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplay.mm#L73-L76) |
| `maskAllImages` | true | iOS adds `RCTImageView`, `RCTImageComponentView` | iOS, Android | [L60](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L60), [RNSentryReplay.mm#L65-L72](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplay.mm#L65-L72) |
| `maskAllVectors` | true | iOS masks `RNSVGSvgView` | iOS, Android | [L68](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L68), [RNSentryReplay.mm#L62-L64](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplay.mm#L62-L64) |
| `enableViewRendererV2` | true | Faster iOS renderer | iOS | [L96](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L96) |
| `enableExperimentalViewRenderer` | false (deprecated) | Alias, used when V2 unset | iOS | [L81](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L81), [L320-L328](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L320-L328) |
| `enableFastViewRendering` | false | Faster, incomplete rendering | iOS | [L110](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L110) |
| `includedViewClasses` / `excludedViewClasses` | undefined | Limit view traversal | iOS | [L124-L138](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L124-L138) |
| `maskedViewClasses` / `unmaskedViewClasses` | undefined | Native class names | iOS, Android | [L150-L162](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L150-L162) |
| `screenshotStrategy` | `'pixelCopy'` | `'canvas'` always masks | Android | [L175](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L175) |
| `captureSurfaceViews` | false | SurfaceView content (pixelCopy only) | Android | [L189](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L189) |
| `beforeErrorSampling` | undefined | false → no replay link/flush for this error | JS | [L200](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L200), [L454-L470](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L454-L470) |
| `networkDetailAllowUrls` | [] | Capture headers/bodies for these URLs. Capture in JS; natives receive string sources only to emit the rrweb options event | JS (+ native flag) | [L229](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L229) |
| `networkDetailDenyUrls` | [] | Exclusions | JS (+ native flag) | [L238](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L238) |
| `networkCaptureBodies` | true | Bodies for allow-listed URLs, ~150 KB cap | JS | [L255](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L255) |
| `networkRequestHeaders` / `networkResponseHeaders` | [] | Extra headers beyond content-type, content-length, accept; auth headers always stripped | JS | [L266-L274](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L266-L274) |
| `avoidForegroundResumeHang` / `avoidForegroundResumeHangDelayMs` | false / 1000 | Stop before background, restart in **buffer** mode after foreground (session replays downgrade) | JS → iOS | [L291-L302](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L291-L302) |

Quality and sample rates are top-level options (section 1.6), not integration options.

## 5. Tracing integration options

`reactNativeTracingIntegration` ([reactnativetracing.ts#L13-L83](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnativetracing.ts#L13-L83)), all JS:

| Option | Default | Source |
|---|---|---|
| `idleTimeoutMs` | 1000 | [L20](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnativetracing.ts#L20), [span.ts#L46-L49](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/span.ts#L46-L49) |
| `finalTimeoutMs` | 600000 (the doc comment says `60_0000`) | [L28](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnativetracing.ts#L28) |
| `traceFetch` | false (true on web or with `expo/fetch`) | [L38](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnativetracing.ts#L38) |
| `traceXHR` | true | [L45](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnativetracing.ts#L45) |
| `enableHTTPTimings` | true on RN 0.83+ (not for `expo/fetch`) | [L55](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnativetracing.ts#L55) |
| `beforeStartSpan` | undefined | [L61](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnativetracing.ts#L61) |
| `shouldCreateSpanForRequest` | `() => true` (dev server excluded) | [L69](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnativetracing.ts#L69) |

`reactNavigationIntegration` ([reactnavigation.ts#L142-L218](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/reactnavigation.ts#L142-L218)), all JS:

| Option | Default |
|---|---|
| `routeChangeTimeoutMs` | 1000 |
| `enableTimeToInitialDisplay` | false |
| `ignoreEmptyBackNavigationTransactions` | true |
| `enableTimeToInitialDisplayForPreloadedRoutes` | false |
| `useDispatchedActionData` | false |
| `useFullPathsForNavigationRoutes` | false |
| `enablePrefetchTracking` | false |

## 6. Feedback integration (top-level)

`feedbackIntegration({...})` ([feedback/integration.ts#L18-L56](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/feedback/integration.ts#L18-L56)), JS only:

| Option | Default | Source |
|---|---|---|
| `buttonOptions`, `screenshotButtonOptions` | {} | [L49-L50](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/feedback/integration.ts#L49-L50) |
| `colorScheme` | `'system'` | [L51](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/feedback/integration.ts#L51) |
| `themeLight`, `themeDark` | {} | [L52-L53](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/feedback/integration.ts#L52-L53) |
| `enableShakeToReport` | false (native shake detection) | [L33](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/feedback/integration.ts#L33) |
| form props: `showBranding` true, `isEmailRequired` false, `shouldValidateEmail` true, `isNameRequired` false, `showEmail` true, `showName` true, `enableScreenshot` false, `enableTakeScreenshot` false, labels | as listed | [feedback/defaults.ts#L61-L89](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/feedback/defaults.ts#L61-L89) |

## 7. `ReactNativeWrapperOptions` (`Sentry.wrap`)

| Option | Effect | Source |
|---|---|---|
| `profilerProps` | Props for the root React profiler | [options.ts#L821](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L821) |
| `touchEventBoundaryProps` | Props for the root `TouchEventBoundary` (e.g. `enableRageTapDetection` default true) | [options.ts#L824](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L824), [touchevents.tsx#L130-L138](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/touchevents.tsx#L130-L138) |

## 8. `sentry.options.json` and the Expo plugin

- `sentry.options.json` at the project root holds the same keys as `Sentry.init` (JSON only, so no functions). It is read by native before JS (`RNSentrySDK.start()` / `RNSentrySDK.init(this)`) and also bundled into JS as `__SENTRY_OPTIONS__`, under the options passed to `Sentry.init` ([sdk.tsx#L82-L85](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L82-L85), [RNSentrySDK.m#L24-L79](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentrySDK.m#L24-L79)). Env overrides `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_DIST` are applied on both sides ([sentryOptionsSerializer.ts#L116-L140](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tools/sentryOptionsSerializer.ts#L116-L140), [sentry-xcode.sh#L107-L130](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/scripts/sentry-xcode.sh#L107-L130)). `SENTRY_COPY_OPTIONS_FILE=false` disables the iOS copy.
- Expo plugin props ([withSentry.ts#L15-L24](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/plugin/src/withSentry.ts#L15-L24)):

| Prop | Default | Effect |
|---|---|---|
| `organization`, `project`, `url` | env fallback, `https://sentry.io/` | written to `sentry.properties` for uploads |
| `authToken` | — | deleted from config; warns to use `SENTRY_AUTH_TOKEN` |
| `useNativeInit` | false | adds native init calls (iOS AppDelegate, Android MainApplication) |
| `disableAutoUpload` | false | `SENTRY_DISABLE_AUTO_UPLOAD=true` in build phases |
| `options` | — | written to `sentry.options.json` |
| `experimental_android` | — | Sentry Android Gradle Plugin config |

<a id="how-options-reach-native"></a>
## 9. How options reach native

### 9.1 JS side (`NATIVE.initNativeSdk`)

Read in [wrapper.ts#L289-L379](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L289-L379) and [client.ts#L229-L274](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L229-L274):

1. Input: all client options, plus `defaultSidecarUrl`, `devServerUrl`, `mobileReplayOptions` (with RegExp → string), resolved `profilingOptions`; `_experiments` minus profiling keys.
2. `enableLogs` (only if defined) becomes `enableLogs && logsOrigin !== 'js'` ([L295-L297](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L295-L297)).
3. Stops if `enableNative` false or `autoInitializeNativeSdk` false or DSN empty. Trims DSN whitespace ([L300-L328](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L300-L328)).
4. `ignoreErrors` split into `ignoreErrorsStr` and `ignoreErrorsRegex` (RegExp `.source`) ([L333-L343](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L333-L343)).
5. Removed keys: `integrations`, `ignoreErrors`, `logsOrigin`, `profilingOptions`, `androidProfilingOptions`, `enableJsHangTracking`, `jsHangTimeoutInterval` ([L347-L356](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L347-L356)).
6. **Every function-valued key is dropped** (`beforeSend`, `beforeSendTransaction`, `beforeBreadcrumb`, `tracesSampler`, `beforeScreenshot`, `onReady`, `transport`, `stackParser`, ...) because a JS function would cross as a native callback and crash the native hook ([L187-L201](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L187-L201), [L359](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L359)). Consequence: **JS `beforeSend` never runs on native-created events** (native crashes, app hangs, ANRs, JS hang events, native HTTP errors). The `enableJsHangTracking` doc comment states this ([options.ts#L219-L220](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/options.ts#L219-L220)).
7. `profilingOptions` re-inserted under `_experiments.profilingOptions`; `sdkVersion` = JS SDK version (used for the `:ota` package) ([L361-L371](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L361-L371)).

### 9.2 iOS mapping

| Step | What happens | Source |
|---|---|---|
| `prepareOptions` | Sets native `beforeSend` (drops `Unhandled JS Exception` and `ExceptionsManager.reportException` duplicates, applies `ignoreErrors*`, tags origin); removes `tracesSampleRate`, `tracesSampler`, `enableTracing`, `enableTurboModuleTracking` | [RNSentry.mm#L137-L195](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentry.mm#L137-L195) |
| `RNSentryReplay updateOptions` | If either replay rate key exists: builds `sessionReplay` dict: `sessionSampleRate`, `errorSampleRate`, `quality`, mask flags, class lists, network detail lists, `sdkInfo` (JS name) | [RNSentryReplay.mm#L14-L56](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryReplay.mm#L14-L56) |
| `optionsFromDictionary` | sentry-cocoa parses the known keys (list in source) | [Options+Dictionary.swift#L31-L360](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options+Dictionary.swift#L31-L360) |
| RN post-parse | `screenshot.*`, `<Sentry.Mask>` class for screenshots, breadcrumb filter for DSN/dev server URLs, `enableNativeCrashHandling` → `enableCrashHandler`, `spotlight`, `_experiments` (C++ exceptions, UI profiling), `strictTraceContinuation`, `orgId`, `shutdownTimeout` ms → s | [RNSentryStart.m#L86-L220](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L86-L220) |
| React defaults | `enableCaptureFailedRequests = NO`, `tracesSampleRate = nil`, `tracesSampler = nil` | [RNSentryStart.m#L229-L239](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L229-L239) |
| React finals | wraps user native `beforeSend`; hybrid mode for app start and frames from `enableAutoPerformanceTracing` | [RNSentryStart.m#L245-L282](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L245-L282) |
| Start | SDK name, packages, `SentrySDK.start`, replay `postInit` only if a replay rate > 0, `SentryHybridSdkDidBecomeActive` | [RNSentryStart.m#L47-L69](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L47-L69) |

Keys sent by JS that the iOS parser does not read (grep; inferred no effect on iOS): `maxQueueSize`, `profilesSampleRate`, `propagateTraceparent` (cocoa key is `enablePropagateTraceparent`), `attachAllThreads`, `useThreadsForMessageStack`, `enableNdk*`, Android breadcrumb flags.

### 9.3 Android mapping

| Step | What happens | Source |
|---|---|---|
| `getSentryAndroidOptions` | Explicit `hasKey` mapping for: debug, dsn, sampleRate, sendClientReports, maxBreadcrumbs, maxCacheItems, environment, release, dist, enableAutoSessionTracking, sessionTrackingIntervalMillis, shutdownTimeout, enableNdkScopeSync, attachStacktrace, attachThreads, attachScreenshot (+ masking), attachViewHierarchy, sendDefaultPii, strictTraceContinuation, orgId, maxQueueSize, enableNdk, enableLogs, tombstone flags, ANR fingerprinting/profiling, NDK app hang, breadcrumb flags, spotlight, replay, profiling, breadcrumb URL filter, crash handling | [RNSentryStart.java#L87-L264](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L87-L264) |
| Replay | `SentryReplayOptions(false, sdk=JS name)`; `setSessionSampleRate` / `setOnErrorSampleRate` from the top-level keys (null if absent); mask flags, classes, `captureSurfaceViews`, `screenshotStrategy`, network detail lists; mask container classes | [RNSentryStart.java#L444-L550](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L444-L550) |
| Profiling | `profileSessionSampleRate`, lifecycle forced `MANUAL`, `startOnAppStart` | [RNSentryStart.java#L266-L318](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L266-L318) |
| React defaults | SDK name `sentry.java.android.react-native`, native SDK name, packages, `tracesSampleRate`/`tracesSampler` null, ignore `JavascriptException` | [RNSentryStart.java#L329-L359](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L329-L359) |
| React finals | wraps native `beforeSend` to tag origin | [RNSentryStart.java#L366-L378](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L366-L378) |

Keys the Android mapping does not read (grep; inferred native default applies): `enableCaptureFailedRequests`, `enableAutoPerformanceTracing`, `enableUserInteractionTracing`, `profilesSampleRate`, `replaysSessionQuality`, `propagateTraceparent`, `tracePropagationTargets`, all iOS-only keys. There is no RN option for Android `anrEnabled` (native default true) or `anrTimeoutIntervalMillis` (native default 5000) ([SentryAndroidOptions.java#L36-L39](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-core/src/main/java/io/sentry/android/core/SentryAndroidOptions.java#L36-L39)); set them through native init.

### 9.4 Specific options

| Option | Handling |
|---|---|
| `tracesSampleRate` | JS only. Removed on iOS, nulled on both. Native has no traces. |
| `replaysSessionSampleRate` / `replaysOnErrorSampleRate` | Top-level JS keys → iOS `sessionReplay.sessionSampleRate` / `errorSampleRate` dict keys; Android `SentryReplayOptions.setSessionSampleRate` / `setOnErrorSampleRate`. Sampling decisions are native. |
| `profilesSampleRate` | JS Hermes profiler only. Not forwarded meaningfully. |
| `_experiments.profilingOptions` | Native UI profiling; lifecycle always manual natively; JS starts/stops. Ignored without `uiProfilingIntegration`. |
| `enableAutoSessionTracking`, `sessionTrackingIntervalMillis` | Pass through; native defaults true / 30000. |
| `attachScreenshot`, `attachViewHierarchy` | Both sides: JS integration for JS errors, native option for native events. |
| `enableAppHangTracking`, `enableWatchdogTerminationTracking` | iOS only. |
| `enableNdk` | Android only, default true. |
| ANR | No `enableAnr` RN option exists. ANR stays on unless `enableNativeCrashHandling: false`, which removes `AnrIntegration` on Android. |

### 9.5 Default mismatches RN vs native

| Option | RN | Native | Source |
|---|---|---|---|
| `attachStacktrace` | true (set by RN) | @sentry/core JS default false; iOS true ([Options.swift#L322](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L322)), Android true ([SentryOptions.java#L297](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryOptions.java#L297)) | [sdk.tsx#L58](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L58) |
| `enableCaptureFailedRequests` | false (iOS forced false) | iOS true | [RNSentryStart.m#L231-L232](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L231-L232) |
| traces | JS | off natively | as above |
| `maxQueueSize` | 30 in JS | core JS default 64 ([transports/base.ts#L21](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/transports/base.ts#L21)); Android equals `maxCacheItems` 30 | [SentryOptions.java#L209](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryOptions.java#L209) |
| Android screenshot masking | on | off in native Android until next major | [RNSentryStart.java#L392-L395](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L392-L395) |
| `environment` | `development`/`production` by `__DEV__` | iOS `production` ([Options.swift#L865](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Options.swift#L865)); RN passes its value to native, so both sides match after JS init | [environment.ts#L146-L148](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/utils/environment.ts#L146-L148) |
| `idleTimeout` | 1000 ms | native idle transactions 3 s (from [sentry-mobile.md](../../../../client-sdk-features/vendors/sentry-mobile.md), PERF-k) | [span.ts#L46-L49](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/span.ts#L46-L49) |
| replay on-error buffer | — | native 30 s; RN docs say up to one minute (see [sentry-mobile.md](../../../../client-sdk-features/vendors/sentry-mobile.md), RPL-c) | |
