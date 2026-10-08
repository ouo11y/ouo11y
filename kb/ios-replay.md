# iOS session replay: native screenshot capture (sdk/ios + Expo module)

Status: filled in Phase 7 by `ios-replay`. Code: `sdk/ios` (Swift package `OuoReplay`),
`sdk/react-native/ios` + `android` + `src/replay.ts` (Expo module and JS bridge), consumer
`examples/mobile`. Contract: `docs/specs/mobile-replay.md`, decision: ADR-0006.

## Question

How is a React Native / native iOS screen turned into replay frames with sensitive views
redacted on the device, how do those frames reach rum-api in the same chunk pipeline as rrweb,
and what can be verified on a Mac without Xcode?

## Design

- **Two Swift targets.** `OuoReplayCore` is Foundation + zlib only: chunk models, `ChunkBuilder`,
  `SeqStore`, `FrameDeduper`, `RedactionPlanner`, `Gzip`, `ChunkUploader`. `OuoReplay` is the
  UIKit capture (`ScreenCapturer`, `TouchObserver`, `ReplayRecorder`, public `OuoReplay` enum)
  behind `#if canImport(UIKit)`, with a logging stub otherwise. Everything that has logic lives
  in Core and is tested on macOS; the UIKit layer is thin glue that could not be compiled here.
- **Capture loop** (`ReplayRecorder`): `Timer` on the main run loop in `.common` mode (keeps
  capturing while a scroll view tracks) at `frameInterval` (1 s); touch `began`/`ended` trigger
  an extra capture on the next run-loop turn, at most 4 per second (`moved` samples are recorded
  as touches but never trigger captures). `didEnterBackground` stops the timer and flushes;
  `didBecomeActive` restarts with an immediate `resume` frame unless the host paused. A `pause()`
  from the host survives a background/foreground cycle.
- **Frame pipeline**: `UIGraphicsImageRenderer` with `format.scale = min(screenScale,
  1000 / longestSidePoints)` so the frame is rendered once, directly at the final size;
  `window.drawHierarchy(in:afterScreenUpdates:false)` (falls back to `layer.render(in:)` if it
  returns false), then `UIColor.black` fills of the redaction rectangles in point coordinates,
  then `jpegData(compressionQuality: 0.5)`. `viewport.scale` in the chunk is that render scale
  (pixels per point); touches stay in points, the player multiplies.
- **Dedupe**: a 16x16 8-bit grayscale thumbnail of the rendered image (`CGContext` draw with low
  interpolation) is hashed with FNV-1a; equal to the previous kept frame means drop. Reset on
  resume and rotation so those always produce a frame.
- **Chunking**: `ChunkBuilder` opens a chunk on the first frame or touch and reserves `seq` and
  the session id at that moment (a rotation mid-chunk cannot relabel buffered frames, same rule
  as `sdk/browser/src/replay/chunker.ts`). Flush at 5 s (checked on every add and once per timer
  tick so touch-only chunks go out), at 10 frames, and on pause/background/rotation/flush.
  `sessionDidRotate(newId)` flushes then `seqStore.reset(newId)`.
- **Seq persistence**: `UserDefaultsSeqStore` stores `{session_id, seq}` under `ouo.replay.seq`;
  a different session id restarts at 0 automatically, so even a host that forgets to call
  `sessionDidRotate` gets correct numbering. Mobile cold starts always begin a new session
  (session spec), so "persist across restarts" matters only for warm relaunches within a session.
- **Upload** (`ChunkUploader`): JSON (`JSONEncoder`, sorted keys, snake_case `CodingKeys`) ->
  gzip -> `POST {endpoint}/v1/replay/chunks` with `content-type: application/json`,
  `content-encoding: gzip`, `x-ouo-session-id`, `x-ouo-seq`. Serial queue, in order, 3 attempts
  with 1 s / 2 s backoff (delay function injectable for tests), queue bounded at 2 MB dropping
  the oldest non-in-flight chunk. `ChunkTransport` protocol so tests capture requests without a
  server; `URLSessionTransport` (ephemeral session, 15 s timeout) in production.

## Masking class list and why RN text views matter

Default masked classes (`RedactionRules`): `UITextField`, `UITextView`, `UILabel`,
`RCTTextView` (RN Paper text), `RCTParagraphComponentView` (RN Fabric text),
`RCTUITextField` / `RCTUITextView` / `RCTTextInputComponentView` (RN inputs; the first two
subclass UIKit's and would match anyway), `UIImageView`, `RCTImageView`,
`RCTImageComponentView`, `WKWebView`. React Native does **not** render `<Text>` with
`UILabel`: Paper draws text in `RCTTextView` and Fabric in `RCTParagraphComponentView`
(both `UIView` subclasses drawing an `NSAttributedString` themselves). Masking only UIKit
classes would leave every RN label unredacted, which is why those two names are in the list.
Matching looks at the view's class and its superclass chain (`ViewNode.superclassNames`),
so app subclasses are covered. `accessibilityIdentifier` (`testID` in RN) `ouo-mask`
forces, `ouo-unmask` skips the subtree. Hidden / alpha <= 0.01 / offscreen subtrees are skipped,
rects are clipped to the window and merged when overlapping.

## gzip approach

`import zlib` works on macOS and iOS with the Command Line Tools (the SDK ships a zlib
module map); link with `-lz` (`linkerSettings: [.linkedLibrary("z")]`, `s.libraries = 'z'` in
the pod). `deflateInit2_` with `windowBits = 15 + 16` makes zlib emit the gzip header, CRC32
and ISIZE trailer, so the stream is what `gunzip`, Go's `compress/gzip` (rum-api) and browsers
expect. `NSData.compressed(using: .zlib)` was rejected: it produces a raw deflate stream
without header or trailer. Decompression uses `inflateInit2_` with `15 + 32` (auto-detect
gzip/zlib). The test writes a file and runs `/usr/bin/gunzip -c` on it.

## Expo module bridge

- `expo-module.config.json`: `platforms: ["apple", "android"]` (`ios` is the legacy alias; the
  config reader accepts both), `apple.modules: ["OuoReplayModule"]`, `apple.swiftModuleName:
  "OuoReactNative"` (singular key; otherwise the generated `ExpoModulesProvider.swift` imports
  every pod's module), `android.modules: ["dev.ouo.replay.OuoReplayModule"]`.
- Autolinking finds **every** `*.podspec` in the package's top-level dirs, so three podspecs in
  `sdk/react-native/ios` become three `:path` pods: `OuoReplayCore` (sources
  `OuoReplayCore/**/*.swift`, `libraries z`), `OuoReplay` (depends on Core, `UIKit`),
  `OuoReactNative` (`*.swift` = the module, depends on `ExpoModulesCore` + `OuoReplay`). Separate
  pods keep separate Swift modules, so `import OuoReplayCore` in the package sources stays
  valid under CocoaPods.
- **Vendoring**: CocoaPods cannot glob outside the podspec directory (`..` patterns and
  symlinked directories are not followed by its `**/*` file list), so
  `scripts/sync-ios.mjs` copies `sdk/ios/Sources/{OuoReplayCore,OuoReplay}` into
  `sdk/react-native/ios/` on every `npm run build`. The copies are gitignored
  (`sdk/react-native/ios/.gitignore`); `sdk/ios` is the only source of truth.
- Module/type name clash: the Swift module `OuoReplay` contains an enum `OuoReplay`; the Expo
  module uses the fully qualified `OuoReplay.OuoReplay.start(...)` to avoid ambiguity.
- `UIGestureRecognizer` subclasses must `import UIKit.UIGestureRecognizerSubclass` to override
  `touches*`; the observer stays in `.possible`, `cancelsTouchesInView = false`,
  `delaysTouchesBegan/Ended = false`, recognises simultaneously with everything and never
  requires failure, so the app's gestures are untouched (Sentry's design). Cancelled touches
  are reported as `ended` because rum-api accepts only `began|moved|ended`.
- JS: `src/replay.ts` loads `expo-modules-core` through a guarded bare `require` (Metro bundles
  it; Node, Vitest, bare RN hosts fall into the catch), `requireNativeModule("OuoReplay")`
  throws in Expo Go and on web -> inert controller that warns once in debug. `initRUM` starts
  replay with `replayEndpoint` (default: OTLP scheme + host, port 8080) and the session id,
  passes `SessionManager.onRotate` to `sessionDidRotate` (the cold-start resolution reports the
  initial id too; same id is ignored), and `rum.flush()` awaits the native flush. Vitest cannot
  alias a bare `require`, hence `_setExpoModulesCore()` as the test hook.
- Monorepo Metro: `expo-modules-core` was added to the PEERS redirect list in
  `examples/mobile/metro.config.js`, otherwise the SDK's require resolves against
  `sdk/react-native/node_modules` (absent) and the bundle fails.

## What was verified where

| Check | Where | Result |
|---|---|---|
| `swift build` (Core + macOS stub) | this Mac, CLT only | passes |
| `sdk/ios/test.sh` (35 Swift Testing tests: chunk JSON vs spec fixture keys, flush triggers, seq persistence/reset, dedupe, planner cases, gzip + `gunzip`, uploader headers/order/retry/bound) | this Mac | 35 passed |
| Real upload through `URLSession` (`OUO_REPLAY_STUB_URL=http://localhost:8080`) | rum-api in compose | 2 chunks accepted; `GET /v1/sessions/<id>/replay` reports `kind: frames`, `chunk_count 2`, `frame_count 5`; `/replay/frames` returns the 5 frames in seq order |
| `npm run -w sdk/react-native build` + `test` | this Mac | 7 files, 56 tests (17 new replay tests) |
| `npx expo prebuild --platform ios --no-install`, `expo-modules-autolinking resolve -p apple/android` | examples/mobile | three ouo pods + `OuoReplayModule` resolved; Android project resolved |
| `npx expo export --platform ios` | examples/mobile | Hermes bundle with the replay code builds |
| Compiling the UIKit target, `pod install`, simulator run, masked-fields-are-black, Grafana playback | needs Xcode | **not done** (`kb/xcode-setup.md`) |

## Gotchas

- Swift Testing, not XCTest: the Command Line Tools ship `Testing.framework` under
  `Library/Developer/Frameworks` and `lib_TestingInterop.dylib` under `Library/Developer/usr/lib`
  but no XCTest; `swift test` finds neither without `-F`/`-rpath` flags (`sdk/ios/test.sh`).
- `swift-tools-version:5.9` keeps the package in Swift 5 language mode; Swift 6 strict
  concurrency would flag the main-thread-only recorder.
- `UIScreen.main` is deprecated on iOS 16+ but still works; the recorder only uses it for the
  initial viewport before the first capture replaces it with the window bounds.
- `expo prebuild` rewrites the app's `ios`/`android` npm scripts to `expo run:*`; kept.

## Native verification findings (2026-10-08, Xcode 27 / iOS 27 simulator)

- **iOS 27 requires the UIScene life cycle.** Apps without a scene manifest trap at launch inside `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`; a second launch of the same build shows a black window instead. Expo 57.0.27's prebuild template still has no scene delegate, but `expo/ios/AppDelegates/ExpoAppSceneDelegate.swift` exists for exactly this. `examples/mobile/plugins/withUIScene.js` adds the manifest, writes `SceneDelegate.swift` (`internal import Expo` to match the generated AppDelegate's access-level import), registers it in the pbxproj, makes the AppDelegate conform to `ExpoReactNativeFactoryProvider` and removes its own window creation. Drop the plugin when the Expo template catches up.
- **Do not `require("expo-modules-core")` from the SDK.** With the package symlinked from `sdk/react-native` (npm `file:` link), Metro resolves bare requires relative to the real path and reports "Requiring unknown module expo-modules-core", even though the native module is registered. `loadNativeReplayModule` now reads `globalThis.expo.modules.OuoReplay` first; the debug warning prints the underlying error and the list of registered native modules.
- **`expo prebuild` without `--clean` still deletes `ios/Pods` and the `.xcworkspace`**; run `pod install` again afterwards.
- **Over-masking:** UIKit navigation bars contain an empty `UIImageView` background, which the class rule redacted as a solid block. `ViewTreeBuilder` now reports image views with `image == nil` as `UIView`.
- Measured: first chunk for a static Products screen was 2 frames / 9.9 KB gzip (dedupe drops unchanged frames); JPEG at scale 1.14 of a 402×874 pt viewport is 460×1001 px, 9 to 23 KB each.
- Headless driving: `xcrun simctl install/launch/io screenshot` work without `xcode-select`; taps need the simulator panel, which does require `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. Xcode 27 has no `Simulator.app` under `Contents/Developer/Applications`; the device window lives in `DeviceHub.app`.
- **Header text on iOS 27 needed three things** (found with the debug class dump): React Native's inner `RCTParagraphTextView` draws the text while its `RCTParagraphComponentView` parent reports an empty frame inside navigation bars; the back-button title lives in `_TtCC5UIKit19NavigationButtonBar15ItemWrapperView`; and the planner must keep visiting children of zero-sized or off-screen nodes (UIKit does not clip subviews by default). Do **not** mask `_UIGraphicsView` / `CGDrawingView` by default: on iOS 26+ the bar's glass background is one of them.
- Swift `print` from the app is invisible to `log show`; the native logger uses `NSLog`, so `xcrun simctl spawn booted log show --predicate 'process == "mobilestore"'` shows `[ouo replay]` lines including the `redaction: unmatched content-like classes [...]` diagnostic.
- LogBox itself throws "An error was thrown when attempting to render log messages via LogBox" in the Expo 57 dev client on iOS 27; the SDK reports it as a non-fatal exception. The demo app silences LogBox with `EXPO_PUBLIC_QUIET_LOGBOX=1`.
