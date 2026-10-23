# ouo React Native SDK: closing the gaps to the Sentry bridge (2026-10-23)

Checklist section 3 (G2 to G6) and Q1, in `sdk/react-native/src`. The gap list is in
[sentry-bridge-vs-ouo-sdk.md](sentry-bridge-vs-ouo-sdk.md); the formats are
`docs/specs/sentry-bridge.md` section 9a (timeline) and `docs/specs/mobile-vitals.md` (vitals).

## Things that are easy to get wrong

- **Hooking Sentry.** `client.on("beforeSendEvent", (event, hint) => …)` (@sentry/core 10.76.0
  `Client.sendEvent`) fires once per event Sentry actually sends: after event processors,
  `beforeSend` and `sampleRate`. `preprocessEvent` fires earlier for every captured event,
  including dropped ones. `hint.originalException` is the thrown object, which is what makes
  identity de-duplication with ouo's own hooks work. `on()` returns the unsubscribe function.
  The real `Sentry.getClient()` type is assignable to the SDK's `SentryClientLike` (checked with
  `tsc` in an app with @sentry/react-native 8.30.0).
- **Sentry RN mechanisms**: global handler fatal `onerror` (handled false), global handler
  non-fatal `generic` (handled true), rejections `onunhandledrejection`. A non-fatal through the
  global handler has the same mechanism as `captureException`, so skipping by mechanism is not
  enough: skip by `originalException` identity. `captureMessage` carries one exception value
  with `mechanism.synthetic: true` and `level: info`.
- **React Native dev handler and a fatal.** After ouo's handler, the previous handler prints the
  fatal again through `console.error` (`Error: <message>` plus a component stack), so the
  crashed session got a second, non-fatal `exception` stamped after its `session.end` (QA R2-4).
  React dev can also re-throw a render error as a new Error object with the same message (the
  `crash_count 2`). Identity de-duplication does not catch either; the SDK drops, for 5 s after
  a fatal, same type+message fatals and console lines containing the fatal message.
- **expo-device on the simulator.** `modelId` comes from `uname().machine`, which is `arm64` on
  the iOS simulator; `isDevice` is false. sentry-cocoa reads `SIMULATOR_MODEL_IDENTIFIER`
  instead. The SDK reads expo-device's constants from `globalThis.expo.modules.ExpoDevice` (no
  import), drops a CPU name on the simulator and sets `ouo.device.simulator = true`.
- **`performance.rnStartupTiming.startTime` is not the process start.** React Native 0.86 fills
  it from `APP_STARTUP_START`, which only the old bridge (`RCTCxxBridge`) logs; bridgeless falls
  back to the runtime init time. It misses pre-main and the app delegate, so it is not the cold
  start of the vitals spec (process start, `sysctl kp_proc.p_starttime`). The SDK uses the
  native `getAppStartInfo()` instead of emitting a shorter number.
- **No async context in Hermes.** OTel's default context manager is a no-op, so
  `context.with(...)` did nothing before this change. The SDK installs a synchronous stack
  context manager: the `withSpan` span is active until the callback's first `await`. fetch and
  XHR read `context.active()` synchronously when the request starts, so requests issued before
  the first await become children; later ones need `startSpan(name, { parent })`.
- **Tap targets.** RN's synthetic touch event has the touched host view's fiber as
  `event._targetInst`; walking `.return` with `memoizedProps` and `elementType.displayName`
  gives the same labels Sentry's TouchEventBoundary uses (`sentry-label`, `accessibilityLabel`,
  `aria-label`, `testID`). Function component names in release bundles are minified, so only
  `displayName` is used. Sentry's breadcrumb message has the label alone; its replay copy has
  the joined path, which is why the bridge has both `ouo.ui.target` and `ouo.ui.path`.
- **App state on iOS** goes `active -> inactive -> background` and back `background -> active`
  (sometimes through `inactive`). sentry-cocoa's breadcrumbs map to `foreground`, `inactive`,
  `background`; the SDK emits `app.lifecycle` for each change, the background one before the
  flush and the foreground one after the session manager (so it lands in a rotated session).
- **Stack strings.** Hermes prints `at fn (address at /…/App.app/main.jsbundle:1:2345)`, `at
  apply (native)`, `InternalBytecode.js`; JSC prints `fn@/…:1:2` and `[native code]`; Metro dev
  URLs look like `http://host:8081/index.bundle//&platform=ios&dev=true…:51234:17` (no `?`).

## Native hooks (iOS, done 2026-10-23)

The JS side reads `getAppStartInfo()` and `getFrameStats()` from the `OuoReplay` Expo module
(`src/vitals.ts`, `NativeVitalsModule`). The iOS side is the `OuoVitals` target of `sdk/ios`;
contract, measurement rules and quirks are in [ios-vitals.md](ios-vitals.md). Still open: Android,
and the optional `SIMULATOR_MODEL_IDENTIFIER` constant for `device.model.identifier` on the
simulator (expo-device returns `arm64` there).
