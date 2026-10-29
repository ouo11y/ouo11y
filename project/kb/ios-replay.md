# iOS session replay: native screenshot capture (sdk/ios + Expo module)

Status: filled in Phase 7 by `ios-replay`. Code: `sdk/ios` (Swift package `OuoReplay`),
`sdk/react-native/ios` + `android` + `src/replay.ts` (Expo module and JS bridge), consumer
`examples/ouo-mobile`. Contract: `docs/specs/mobile-replay.md`, decision: ADR-0006.

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
  gzip -> `POST {endpoint}/v1/replay/chunks` (the collector's `ouoreplay` receiver, port 4319 in
  the local stack) with `Authorization: Basic base64(projectId:projectToken)` (ADR-0007, Phase 8a),
  `content-type: application/json`, `content-encoding: gzip`, `x-ouo-session-id`, `x-ouo-seq`.
  Serial queue, in order, 3 attempts
  with 1 s / 2 s backoff (delay function injectable for tests), queue bounded at 2 MB dropping
  the oldest non-in-flight chunk. `ChunkTransport` protocol so tests capture requests without a
  server; `URLSessionTransport` (ephemeral session, 15 s timeout) in production.

## Masking class list and why RN text views matter

Default masked classes (`RedactionRules`), in four independent groups since Phase 7b:
`textClasses` (`maskText`): `UILabel`, `RCTTextView` (RN Paper text),
`RCTParagraphComponentView` / `RCTParagraphTextView` (RN Fabric text), the iOS 26+ bar item
wrapper; `inputClasses` (`maskInputs`): `UITextField`, `UITextView`, `RCTUITextField` /
`RCTUITextView` / `RCTTextInputComponentView` (RN inputs; the first two subclass UIKit's and
would match anyway); `imageClasses` (`maskImages`): `UIImageView`, `RCTImageView`,
`RCTImageComponentView`; `webViewClasses` (`maskWebViews`): `WKWebView`. React Native does **not** render `<Text>` with
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
  replay with the derived or explicit `replayEndpoint`, `projectId`, `projectToken` and the
  session id (Phase 8a; in 0.1.0 `replayEndpoint` defaulted to the OTLP host on port 8080, now
  to the OTLP host with 4318 -> 4319),
  passes `SessionManager.onRotate` to `sessionDidRotate` (the cold-start resolution reports the
  initial id too; same id is ignored), and `rum.flush()` awaits the native flush. Vitest cannot
  alias a bare `require`, hence `_setExpoModulesCore()` as the test hook.
- Monorepo Metro: `expo-modules-core` was added to the PEERS redirect list in
  `examples/ouo-mobile/metro.config.js`, otherwise the SDK's require resolves against
  `sdk/react-native/node_modules` (absent) and the bundle fails.

## What was verified where

| Check | Where | Result |
|---|---|---|
| `swift build` (Core + macOS stub) | this Mac, CLT only | passes |
| `sdk/ios/test.sh` (35 Swift Testing tests: chunk JSON vs spec fixture keys, flush triggers, seq persistence/reset, dedupe, planner cases, gzip + `gunzip`, uploader headers/order/retry/bound) | this Mac | 35 passed |
| Real upload through `URLSession` (`OUO_REPLAY_STUB_URL=http://localhost:8080`; Phase 7, when rum-api still took uploads directly. Since 8a the endpoint is the collector's replay receiver, `:4319`, with Basic auth; rum-api's sink needs the ingest token) | rum-api in compose | 2 chunks accepted; `GET /v1/sessions/<id>/replay` reports `kind: frames`, `chunk_count 2`, `frame_count 5`; `/replay/frames` returns the 5 frames in seq order |
| `npm run -w sdk/react-native build` + `test` | this Mac | 7 files, 56 tests (17 new replay tests) |
| `npx expo prebuild --platform ios --no-install`, `expo-modules-autolinking resolve -p apple/android` | examples/ouo-mobile | three ouo pods + `OuoReplayModule` resolved; Android project resolved |
| `npx expo export --platform ios` | examples/ouo-mobile | Hermes bundle with the replay code builds |
| Compiling the UIKit target, `pod install`, simulator run, masked-fields-are-black, Grafana playback | needs Xcode | **not done** (`project/kb/xcode-setup.md`) |

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

- **iOS 27 requires the UIScene life cycle.** Apps without a scene manifest trap at launch inside `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`; a second launch of the same build shows a black window instead. Expo 57.0.27's prebuild template still has no scene delegate, but `expo/ios/AppDelegates/ExpoAppSceneDelegate.swift` exists for exactly this. `examples/ouo-mobile/plugins/withUIScene.js` adds the manifest, writes `SceneDelegate.swift` (`internal import Expo` to match the generated AppDelegate's access-level import), registers it in the pbxproj, makes the AppDelegate conform to `ExpoReactNativeFactoryProvider` and removes its own window creation. Drop the plugin when the Expo template catches up.
- **Do not `require("expo-modules-core")` from the SDK.** With the package symlinked from `sdk/react-native` (npm `file:` link), Metro resolves bare requires relative to the real path and reports "Requiring unknown module expo-modules-core", even though the native module is registered. `loadNativeReplayModule` now reads `globalThis.expo.modules.OuoReplay` first; the debug warning prints the underlying error and the list of registered native modules.
- **`expo prebuild` without `--clean` still deletes `ios/Pods` and the `.xcworkspace`**; run `pod install` again afterwards.
- **Over-masking:** UIKit navigation bars contain an empty `UIImageView` background, which the class rule redacted as a solid block. `ViewTreeBuilder` now reports image views with `image == nil` as `UIView`.
- Measured: first chunk for a static Products screen was 2 frames / 9.9 KB gzip (dedupe drops unchanged frames); JPEG at scale 1.14 of a 402×874 pt viewport is 460×1001 px, 9 to 23 KB each.
- Headless driving: `xcrun simctl install/launch/io screenshot` work without `xcode-select`; taps need the simulator panel, which does require `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. Xcode 27 has no `Simulator.app` under `Contents/Developer/Applications`; the device window lives in `DeviceHub.app`.
- **Header text on iOS 27 needed three things** (found with the debug class dump): React Native's inner `RCTParagraphTextView` draws the text while its `RCTParagraphComponentView` parent reports an empty frame inside navigation bars; the back-button title lives in `_TtCC5UIKit19NavigationButtonBar15ItemWrapperView`; and the planner must keep visiting children of zero-sized or off-screen nodes (UIKit does not clip subviews by default). Do **not** mask `_UIGraphicsView` / `CGDrawingView` by default: on iOS 26+ the bar's glass background is one of them.
- Swift `print` from the app is invisible to `log show`; the native logger uses `NSLog`, so `xcrun simctl spawn booted log show --predicate 'process == "mobilestore"'` shows `[ouo replay]` lines including the `redaction: unmatched content-like classes [...]` diagnostic.
- LogBox itself throws "An error was thrown when attempting to render log messages via LogBox" in the Expo 57 dev client on iOS 27; the SDK reports it as a non-fatal exception. The demo app silences LogBox with `EXPO_PUBLIC_QUIET_LOGBOX=1`.

## Phase 7b: masking opt-out (2026-10-08)

- `maskText` used to govern labels **and** inputs, so a host that wanted readable replays
  (`maskText: false`) silently unmasked every `TextInput`. `RedactionRules` now has
  `inputClasses` + `maskInputs` (default true) separate from `textClasses` + `maskText`;
  `masksAnything` includes it. The option is threaded through `OuoReplayConfig`, the Expo
  `StartOptions` record, `ReplayOptions.maskInputs` and `NativeStartOptions` in JS.
- Verified on the iOS 27 simulator with the demo's `replay: { enabled: true, maskText: false }`:
  labels, bar titles and the header badge readable, promo input black with text typed in
  (`project/agents/ios-replay/reports/12-frame-masktext-false.jpg`). The back chevron is a
  `UIImageView` and stays black while `maskImages` is on; hosts that want it visible can set
  `maskImages: false` or mark the bar `ouo-unmask`.
- Driving the simulator panel: screenshots lag one action behind taps; sleep ~1 to 2 s between a
  tap and the screenshot that should show its result, and ~7 s after the last action before
  fetching frames (5 s chunk flush plus the upload).
- rum-api session records carry `replay_duration_ms` / `replay_frame_count` from `meta.json`
  (`decorateReplay` reads the meta instead of only the cached kind).

## Phase 8a: project credential on chunk uploads (2026-10-10, ADR-0007 revised)

Revision 1 (same day) added `OuoReplayConfig.projectToken` and an `X-Ouo-Project-Token` header
to rum-api; the revised ADR-0007 makes the collector the only edge and the credential HTTP Basic.
What is true now:

- `OuoReplayConfig` takes `endpoint:` (the replay receiver base URL: `http://localhost:4319`
  locally, or the proxy host that routes `/v1/replay/*` in a deployment), `projectId:` and
  `projectToken:` (second and third initialiser parameters); the computed `authorization` is
  `ChunkUploader.basicAuthorization(projectId:projectToken:)` =
  `"Basic " + Data("\(id):\(token)".utf8).base64EncodedString()`. `ReplayRecorder` hands both ids
  to `ChunkUploader(endpoint:projectId:projectToken:...)`, which builds the header once and sets it
  through `makeRequest(url:authorization:sessionId:seq:gzipBody:)` on every request including
  retries (`ChunkUploader.authorizationHeader == "Authorization"`;
  `URLRequest.value(forHTTPHeaderField:)` is case-insensitive, so tests check either spelling).
- Why id + token cross the Expo bridge instead of a prebuilt header: one shape for native hosts
  and the bridge, and the two base64 encoders (JS `base64Encode`, Foundation) are checked against
  the same vectors (`demo:pt_dev_demo_…`, `web-store:pt_live_9f3c`, a non-ASCII pair) in
  `test/endpoints.test.ts` and `BasicAuthorizationValue`.
- Expo module: `StartOptions` has `@Field var projectId` and `@Field var projectToken`; `start`
  trims both and throws `ERR_OUO_REPLAY_CREDENTIAL` when either is empty (JS validates first, so
  this only catches a host that calls the native module directly). `scripts/sync-ios.mjs` is
  unchanged: it copies whatever is in `sdk/ios/Sources`, so the vendored pods pick up the new
  initialiser on the next `npm run build`; the Swift file list did not change, so the dev client
  only needs `npx expo run:ios --no-bundler` (no `pod install`).
- `RealHTTPAgainstStubWhenConfigured` reads `OUO_REPLAY_STUB_URL` (point it at `:4319`),
  `OUO_PROJECT_ID` (default `demo`) and `OUO_PROJECT_TOKEN` (default the development token).
- Verified: `sdk/ios/test.sh` 40 tests (`BasicAuthorizationValue`,
  `EveryRequestCarriesTheBasicCredential`), `xcodebuild -scheme OuoReplay -destination
  'generic/platform=iOS Simulator' build` succeeds, and the demo dev client was rebuilt and
  installed on the iOS 27 "iPhone 18 Pro" simulator with the new record. The live upload to the
  collector's replay receiver with `401`-on-wrong-token is the QA pass.
- **SwiftPM by URL.** `.package(url:)` needs `Package.swift` at the root of the fetched
  repository; `sdk/ios` is nested in the monorepo, so remote consumers cannot add it yet. A
  tagged mirror (for example `ouo11y-ios`, pushed from `sdk/ios` by the release workflow) is the
  usual fix; the release agent decides. Local-path consumption and CocoaPods vendoring are
  unaffected.

## N6: capture off the main thread (2026-10-23)

Problem (project/kb/sdk-overhead-ios.md): each capture held the main thread ~49 ms on the simulator.
Time Profiler attribution of the old `captureFrame` (baseline, one journey, all on main): render
80 % (`UIGraphicsImageRenderer imageWithActions`), `UIImage.jpegData` 16.5 %, 16x16 thumbnail 2.4 %,
view walk 0.5 %. The render's leaf frames were `decode_data`, `resample_*<half>`,
`RGBAf16_*`: on a wide-color screen `UIGraphicsImageRendererFormat` defaults to an
**extended-range 16-bit half-float** bitmap, so the snapshot was decoded, resampled and converted in
half floats, then the JPEG encoder converted it back to 8 bits.

What changed (`ScreenCapturer.snapshot` / `compose`, `ReplayRecorder`, `FrameComposer` in Core):

- **Main thread keeps only** the view walk (`ViewTreeBuilder`, class names now cached per class) and
  `drawHierarchy(afterScreenUpdates: false)` into our own `CGContext`.
- **Capture queue** (serial, `.utility`): redaction planning, painting the rectangles
  (`FrameComposer.redact`, same color space as the snapshot), the dedupe thumbnail (taken from the
  redacted frame, before encoding, so dropped frames cost no JPEG), JPEG through ImageIO
  (`CGImageDestination`, thread-safe), `ChunkBuilder` and the uploader hand-off (JSON + gzip used to
  run on main every flush). The queue alone touches `ChunkBuilder` and `FrameDeduper`; touches,
  ticks, rotations and flushes are queued behind the captures already handed over. At most 2
  captures in flight: a slow device skips a capture instead of queueing bitmaps.
- **Bitmap format**: 8 bits per channel, `premultipliedFirst | byteOrder32Little` (Core Animation's
  layout), in **Display P3 when `traitCollection.displayGamut == .P3`**, else sRGB. Measured per
  variant in one run (signposts around drawHierarchy only, simulator): sRGB 41 ms, device RGB
  49 ms, Display P3 36 ms; the sRGB target spent most of drawHierarchy in
  `vTransformTRCParametric` (per-pixel color conversion). The JPEG carries the P3 profile
  (browsers color-manage it).
- **Integer downscale**: `FrameComposer.renderScale` picks `screenScale / n` that fits the
  1000 px cap. On 3x phones with ~874-956 pt screens that is 1.0 (402 x 874 px frames instead of
  460 x 1001 at 1.144): drawHierarchy at 1.0 took 21 ms vs 36 ms at 1.144 in the same run. The spec
  ("longest side at most 1000 px, scale chosen by the SDK") is unchanged; `viewport.scale` reports
  the scale as before.
- Not taken: `layer.render(in:)` was 5 ms in the same run but does not draw backdrop/glass
  materials (iOS 26+ bars), blurs or video. Sentry ships it only as an experimental option.
- Signposts: `OSSignposter(subsystem: "dev.ouo.replay", category: "capture")`, intervals
  `snapshot` (main) and `compose` (queue). Read with `xctrace record --instrument os_signpost` and
  `project/agents/ios-replay/perf/signposts.py`.

Measuring (scripts in `project/agents/ios-replay/perf/`, the sentry-mobile harness unchanged):

- `profile-runs.sh` runs the harness journey (`both-replay`: Sentry replay + ouo replay) with Time
  Profiler attached. Attach (not `--all-processes`): xctrace cannot symbolicate a process that
  started after recording began, and the recording must end before the app exits (80 s inside the
  95 s journey). XCUITest may launch the app twice: attach to the pid on *this* simulator once it
  survived 3 s; another simulator (other sessions, a stale app from Oct 17 on `ouo-perf`) may run
  `sentrydemo` too, and `pgrep` by name would pick it.
- `capture_stalls.py` groups main-thread samples naming each recorder's capture code into captures
  (samples < 50 ms apart; one capture shows 3-8 ms holes where the main thread is descheduled or
  blocked in drawHierarchy, two captures are >= 250 ms apart) and reports per-capture CPU (sum of
  1 ms samples) and wall span. Sentry's capture is `SentrySessionReplay.takeScreenshot` ->
  `SentryViewPhotographer.timedImage` (redaction regions + `SentryGraphicsImageRenderer` ->
  drawHierarchy, contiguous on main). With 4 ms grouping the same trace gives ~20 ms for Sentry
  because its captures split into fragments: that is how a smaller figure (18.5 ms) can come out of
  the same data. Compare SDKs only within one trace.
- `ScreenCapturer.capture(window:)` was inlined into `captureFrame` in Release: match the caller.

Simulator result (iOS 27, M5 Mac shared with other sessions; 3 interleaved rounds each; medians
per round): ouo main-thread CPU per capture 36 / 37 / 50 ms -> 16 / 21 / 21.5 ms; wall 39 / 41 / 51
-> 19 / 24 / 23.5 ms; Sentry in the same traces 32-45 ms. Main-thread total over the 80 s
recording 2.9-3.7 s -> 2.1-2.4 s although more frames are captured (no longer skipped behind a
busy main thread). Capture-queue `compose` 2.6 ms median. Device numbers: report
`project/agents/ios-replay/reports/n6-g1-replay-crashes.html`.

## W1: production-safe capture (2026-10-29)

What changed is in ADR-0006 revision 2 and `docs/specs/mobile-replay.md` (capture rules 1-8). What
was learned on the iOS 27 simulator (`examples/ouo-mobile`, Release build, scripted journey):

- **`drawHierarchy(afterScreenUpdates: false)` trails the model.** It reads what the screen last
  showed. The first W1 build captured at the first idle pass after a react-native-screens push and
  3 of 15 frames showed the transition's last frame (the incoming screen with rounded corners, a
  sliver of the old one). A diagnostic log at each decision showed those captures had 0 layer
  animations and no `transitionCoordinator`: UIKit had finished, the screen had not. Fix: wait
  `settleTime` (0.25 s) after the last pass that saw motion. After it, 0 of 26 frames over two runs
  showed a transition.
- **What a push looks like to the walk** (iOS 27, react-native-screens): 4 animation keys on view
  layers (`UIPacingAnimationForAnimatorsKey` + `position` on one view, `opacity` on two) and a
  `transitionCoordinator` on the stack; both appear on the same passes. The coordinator is the
  direct signal for "no capture during a transition" and is checked before the walk.
- **Render variants, simulator, `snapshot` signpost (walk + render) median per capture, two runs
  each, interleaved**: 1:1 at 3x 27-31 ms, 1x with `interpolationQuality = .none` 26-31 ms, 1x
  default (before W1) 31-34 ms. The simulator does not decide this (N51: 21 ms there, 45 ms on the
  phone); 1:1 was kept because it is exactly the render Sentry measured at 22 ms on the same phone.
  Capture-queue `compose` goes from ~3 ms to ~6 ms (the downscale moved there).
- **Navigation mode** on the journey: 10 frames for 9 screen changes plus launch, every one settled;
  session mode 13-15 kept frames per 42 s run (dedupe drops the static ones).
- **Spool recovery, verified by `kill -9`** of the app 4 s after launch (chunk not yet cut, spool file
  68 KB): after relaunch rum-api had the killed session's 3 frames, `ended_at` = its last frame.
- **Measuring on a simulator**: `xctrace record --template "Time Profiler" --instrument os_signpost
  --device <udid> --attach <pid>`, the pid from `pgrep -f "<udid>/.*/mobilestore.app/mobilestore$"`
  (attaching by name or by `launchctl list` pid fails). Signposts: `snapshot` (main, includes
  `walk`), `walk`, `compose` (queue); a `snapshot` of < 2 ms is a walk-only pass (deferred).
- **npm inside `.claude/worktrees/*`** fails with `call config.load() before reading values` when
  the main checkout above holds a conflicted `package.json` (npm reads the outer workspace's members;
  also in [funnels.md](funnels.md)). `npm_config_prefix` in the environment does not help; `npm
  --prefix <checkout>` does, so a wrapper on `PATH` that adds `--prefix` (the checkout root for
  workspace members, the example's own folder for standalone examples) gets `ouo-env up` and
  `build-ios.sh` through.
- **Review round 1 (PR #109) found what the simulator journey could not show**: a view animating
  `alpha` to 0 has model alpha 0 at once, so a walk that skips transparent views stops masking it
  while it is still fading on screen; a scroll moves content without any layer animation and the
  screen shows the previous offset, so a scroll view being dragged or decelerating counts as
  moving; animation keys are not key paths (`(layer.animation(forKey:) as? CAPropertyAnimation)?
  .keyPath`); transitions must be reported on every pass, or one that ends between due passes
  skips the settle; while a frame waits, `isDue` must stay false (one wake time in the pacer),
  otherwise every pass walks the tree.
- **Forward fit with ADR-0014**: its `buffer` mode keeps an on-disk ring of the last 30 s. When it
  lands, `ChunkSpool` should become the one-entry case of that ring, not a second on-disk format.

