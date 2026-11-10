# React Native SDK (dd-sdk-reactnative): internals

- **SDK:** `@datadog/mobile-react-native` **3.11.0** (tag commit `740f7bb5`, 2026-10-20). Research date 2026-11-10.
- **Method:** read from source at the tag. No RN hands-on.
- **Shorthand:** `R:` = `https://github.com/DataDog/dd-sdk-reactnative/blob/3.11.0/`
- **Bundled native SDKs:** iOS **3.16.1** and Android **3.15.0**, not the latest native tags (`R:NATIVE_SDK_VERSIONS.md`, `R:packages/core/DatadogSDKReactNative.podspec`, `R:packages/core/android/build.gradle`).

## Architecture: thin JS layer over the native SDKs

**The bridge:**
- JS calls TurboModules `DdSdk`, `DdRum`, `DdLogs`, `DdTrace` and `DdFlags` (`R:packages/core/src/specs/NativeDdRum.ts`).
- The native side starts the real iOS or Android SDK and tags events `_dd.source = "react-native"`.
- **Batching, disk persistence, upload, retry and replay are all native.** Everything in [ios.md](ios.md) and [android.md](android.md) applies.

| Signal | Collected in | How |
|---|---|---|
| JS errors | JS | `ErrorUtils.setGlobalHandler` plus a `console.error` wrapper (`R:packages/core/src/rum/instrumentation/DdRumErrorTracking.tsx`) |
| Resources | JS | Patches `XMLHttpRequest.open` / `send`. A separate fetch proxy is used only with `trackFetchResources`. |
| Actions (taps) | JS | Wraps `onPress` by patching `React.createElement` and the JSX runtime, or with a Babel plugin |
| Views | JS, separate package | `@datadog/mobile-react-navigation` / react-native-navigation. None by default. |
| JS long tasks | Native | Frame callback on the JS thread; reported as `long_task` with `javascript` |
| Native crashes, ANRs, hangs, vitals | Native | Only if `nativeCrashReportEnabled` is set, and it is **off by default** in RN (on by default in native Android) |
| Session Replay | Native | Native recorder plus RN mappers (`ReactTextView`, `ReactImageView`, `ReactViewGroup`, `ReactEditText`, modal, SVG) through `ExtensionSupport` |

## Configuration defaults that differ from native

Sources: `R:packages/core/src/config/features/RumConfiguration.ts`, `CoreConfiguration.ts`.

| Option | RN default | Note |
|---|---|---|
| `trackingConsent` | `GRANTED` | Native iOS needs an explicit value |
| `trackInteractions`, `trackResources`, `trackErrors` | false, false, false | Constructor arguments. You must opt in. |
| `nativeCrashReportEnabled` | false | |
| `nativeViewTracking`, `nativeInteractionTracking` | false | |
| `longTaskThresholdMs` (JS) | 0 = off | Clamped to 100–5000 when set |
| `nativeLongTaskThresholdMs` | 200 | |
| `resourceTraceSampleRate` | 100 | Deterministic JS sampler with the Knuth factor, as on the browser and Android |
| `useAccessibilityLabel` | true | Action names |
| Logs `bundleLogsWithRum` / `bundleLogsWithTraces` | true / true | |
| Session Replay `replaySampleRate` | 100 | Privacy: text MASK_ALL, image MASK_ALL, touch HIDE |
| `enableCompositionTreeRecording` | false | iOS only, experimental CALayer tree (see [mobile-replay-wireframes.md](mobile-replay-wireframes.md)) |

## Reliability specific to RN

- **No JS-side batching.** Each call crosses the bridge immediately.
- Calls made before `initialize` go into a `BoundedBuffer` of **100** calls. Overflow is dropped and reported through telemetry (`R:packages/core/src/sdk/DatadogProvider/Buffer/BoundedBuffer.ts#L14`).
- A fatal JS error is passed to native before the JS context dies. Whether it always arrives was not verified.
- Native crashes are missed unless `nativeCrashReportEnabled: true`.
