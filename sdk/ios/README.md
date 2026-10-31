# ouo11y-ios (sdk/ios)

The ouo SDK for iOS. Two ways in:

- **Native apps** (UIKit or SwiftUI, Swift or Objective-C): the `OuoSDK` product, one entry point
  (`Ouo.start`) for sessions, crashes, hangs, terminations, vitals, network spans, replay and the
  span and log API, sent as OTLP/JSON to the ouo collector (docs/specs/mobile-sdk.md, ADR-0016).
  See "OuoSDK" below.
- **React Native**: `@ouo11y/react-native` (`sdk/react-native`) wraps `OuoReplay`, `OuoCrash` and
  `OuoVitals` through an Expo module; its JavaScript owns the session and the export.

`OuoReplay` is the native half of ouo mobile replay (ADR-0006, contract in
`docs/specs/mobile-replay.md`). It snapshots the key window at most once a second after the run
loop's UI work (or once per screen in `navigation` mode), paints opaque rectangles over sensitive
views **before the frame leaves the device** and drops the frame when a masked view is moving
(masking fails closed), drops unchanged frames, keeps the open chunk on disk so a crash does not
lose it, and uploads gzip JSON frame chunks to the ouo collector's replay receiver
(`POST /v1/replay/chunks`, `kind: "frames"`) keyed by the host's `session.id` and authenticated
with the project credential as HTTP Basic (`Authorization: Basic base64("<projectId>:<projectToken>")`,
ADR-0007).

## OuoSDK: native apps

```swift
import OuoSDK

// application(_:didFinishLaunchingWithOptions:), or App.init, on the main thread:
let config = OuoConfig(endpoint: URL(string: "https://otel.example.com")!,   // OTLP/HTTP base URL
                       projectId: "mobile-store", projectToken: "pt_live_...", serviceName: "mobile-store")
config.environment = "production"
config.propagateTo = ["https://api.example.com"]   // traceparent + baggage (session.id) to these origins
config.replaySampleRate = 0.1                      // replay for 10 % of sessions (default 0: off)
Ouo.start(config)

// UIKit screens and taps are recorded by themselves. SwiftUI:
//   SomeView().ouoScreen("Cart")       // a screen: navigation + TTID
//   Text(card).ouoMask()               // replay masks it whatever the options
//   Text(total).ouoUnmask()            // replay shows it whatever the options
Ouo.trackScreen("Cart")                // a screen the SDK cannot see
Ouo.trackTap("pay")                    // a tap the SDK cannot name (SwiftUI controls)
Ouo.reportFullyDisplayed()             // TTFD of the current screen
Ouo.setUser("user-42")                 // clearUser() at logout, endSession()
Ouo.captureError(error)                // handled exception with stack, screen and last events
Ouo.addEvent("checkout", attributes: ["items": 3])
Ouo.log(.info, "cart loaded", attributes: ["count": 3])
Ouo.withSpan("checkout") { _ in api.pay() }   // requests and logs inside join the trace
Ouo.feedback("the cart is slow", contact: "ada@example.com", screenshot: true)
Ouo.flush { }
```

Objective-C: `[Ouo start:config]`, `[Ouo captureError:error attributes:nil]`,
`[Ouo captureException:exception attributes:nil]`, `[Ouo log:OuoLogLevelInfo message:@"…" attributes:nil]`,
`[Ouo withSpan:@"checkout" attributes:nil block:^(OuoSpan *span) { … }]`.

What it records, in the spec's names (docs/specs/mobile-sdk.md):

| Capability | Records |
|---|---|
| C1 sessions | `session.start` / `session.end` (`background` after 30 s in the background, `inactivity` 30 min, `max_duration` 4 h, `crash`, `terminated`, `user_change`, `manual`), `session.previous_id`, `device.id`, `app.lifecycle`; sampling per session id (`sessionSampleRate`, rum-api's rule) |
| C2 errors and crashes | `exception`: `captured` (`captureError`), `native` (signals, uncaught NSExceptions, sent by the next launch as a fatal exception of the crashed session, which ends with `crash` at the crash time); each with `ouo.last_events`, `app.screen.name`, `ouo.device.locale`, memory and network type |
| C3 hangs and terminations | `hang` (2 s, OuoCrash's watchdog), `termination` (killed in the foreground without a crash report, cause `memory`, `watchdog` or `unknown`) |
| C4 vitals | `ouo.app.start` (cold, from the process start to the first frame), `ouo.screen.display` (TTID, TTFD), `app.jank` per screen window |
| C5 network | one CLIENT span per `URLSession` request, `http.request.failed` (5xx, network errors), `http.request`; `traceparent` and `baggage` only to `propagateTo` |
| C6 interactions | `ui.tap` per touch: `ouo.ui.target` (a test id, a control's accessibility label; never text a view shows), `ouo.ui.path`, `ouo.ui.view_type`, `ouo.ui.gesture` (`tap`, `long_press`, `swipe`), `app.screen.name`, a readable body; `taps` and the `tapLabels` kill switch |
| C7 screens | `navigation` per screen change: every view controller of the app shown on its own or in a navigation, tab bar, split or page controller (named after its class, or `OuoScreenNaming`), SwiftUI's `.ouoScreen`, `trackScreen` |
| C8 replay | `OuoReplay` for the sampled sessions, rotated with the session; SwiftUI text and symbols masked (`SwiftUI.CGDrawingView`, not inside system bars), `.ouoMask()` / `.ouoUnmask()` |
| C10 feedback | `feedback` with message, contact, id, `ouo.last_events`, and a masked frame of the screen when replay records |
| C9 spans and logs | `startSpan`, `withSpan`, `log` |
| C11 delivery | OTLP/JSON, gzip, Basic credential; every batch on disk before it is sent (`Application Support/ouo/sdk/otlp`, 5 MB, 500 requests, 24 h), retried with backoff, `Retry-After`, sent on the next launch, on foreground and on `flush`; at least once |

Rules worth knowing:

- **Threads**: every call is safe from any thread; call `start` early, on the main thread. It
  reads the previous session and crash report there (the session must exist when it returns); the
  `config` is copied, later changes to it are not seen. On the main thread afterwards: the lifecycle
  notifications, the display link and `session.json` (at most once a second and on session
  changes); the screen context the next launch reports a crash with is written on a queue.
- **Times** come from a monotonic clock anchored at launch: changing the device clock mid-run does
  not reorder records or end the session.
- **Files** (`Application Support/ouo/sdk`, excluded from backups) are written atomically and
  readable after the first unlock, so a background launch of a locked device works; before the first
  unlock nothing can be stored, and a batch is sent once from memory.
- **App extensions** are refused (`start` returns false): they have no `UIApplication`.
- **Background launches** (a push, a fetch) start a session that ends with `background` unless the
  app is opened in time, and measure no app start.
- **SwiftUI images are not masked by default** (checklist N79): SwiftUI draws them in the hosting
  view's own layer, which the masking walk does not see. Put `.ouoMask()` on images that can show
  user content. SwiftUI text is masked.
- **Taps in SwiftUI**: a SwiftUI control is not a `UIView`, so a touch on it is named after the
  hosting view (`ouo.ui.view_type` and target `_UIHostingView…`). Call `Ouo.trackTap("name")` in
  its action for a named step.
- **A crash right after a tap** carries that tap: the screen context is handed to the crash
  handler in memory on every change, and the handler writes it into the report.
- **`URLSession`**: `-[NSURLSessionTask resume]` is swizzled, so every session and API is seen
  (completion handlers, delegates, `async`); the trace headers are set through the task's
  `currentRequest` before it starts (what sentry-cocoa does). Background sessions run out of process
  and are not traced. The SDK's own uploads are never traced.
- **Privacy manifest**: `PrivacyInfo.xcprivacy` ships with `OuoSDK` (no tracking; crash,
  performance, diagnostic, product interaction data and an install id, not linked to the user;
  `UserDefaults` CA92.1, system boot time 35F9.1). An app that calls `setUser` sends its user id
  with every record: it declares User ID, linked to the user, in its own manifest.
- **Request URLs**: `url.full` is the whole URL, query string included, as the React Native SDK
  sends it. Keep secrets out of query strings, or list such URLs in `ignoreUrls`.
- **Launch kind**: a launch for the user or in the background is read from the process's task role
  (`TASK_CATEGORY_POLICY`), not from `applicationState`, which is `.background` in
  `didFinishLaunching` of every app with scenes (SwiftUI `App`, new Xcode projects).
- **Before the first unlock**: a background launch after a reboot cannot read `session.json`. It is
  not treated as a fresh install: nothing is written over it, and once the device unlocks (or the
  next save finds it readable) its session ends as a cold start would end it and its `device.id`
  and user are kept.

## Layout

| Target | Needs | Contents |
|---|---|---|
| `OuoReplayCore` | Foundation + zlib + CoreGraphics/ImageIO | `FrameChunk`/`Frame`/`Touch`/`Viewport` models (spec JSON keys), `ChunkBuilder` (5 s / 1 MiB of images / size change / explicit flush, a full image first, monotonic `seq` via `SeqStore`), `TileDiffer` (64 px tile hashes against the last frame sent: unchanged, full image or merged patch rectangles, ADR-0014), `RedactionPlanner` (geometry over a `ViewNode` tree), `FrameComposer` (redaction fill, full or patch JPEGs, render scale; thread-safe), `CapturePacer` (when a frame is due: interval or screen change, animation deferral, 100 ms/s time bank), `ChunkSpool` (the open chunk on disk, recovered on the next launch), `Gzip` (RFC 1952 via zlib), `DiskQueue` (a folder of requests written before they are sent, bounded, retried with backoff and `Retry-After`; the OTLP outbox uses it too), `ChunkUploader` (the replay chunk queue on a `DiskQueue`, held chunks for the keep/drop decision) |
| `OuoReplay` | UIKit | `OuoReplayConfig`, the `OuoReplay` entry point, `ScreenCapturer` (main thread: view walk + drawHierarchy into an 8-bit bitmap; capture queue: `FrameComposer`), `TouchObserver` (observing gesture recognizer), `ReplayRecorder` (main run-loop observer, keep-alive tick, one capture in flight, background/foreground, the serial capture queue). On macOS this target compiles to a stub that prints "iOS only" so `swift build` works with the Command Line Tools |
| `OuoCrashCore` | C | Async-signal-safe native crash handlers: one JSON report written at crash time (frames, binary images, signal or exception), previous handlers chained |
| `OuoVitalsCore` | C | Process start (`sysctl` `kp_proc.p_starttime`) and the image load time (a constructor before `main`, used for prewarmed launches) |
| `OuoVitals` | UIKit (counters without it) | Mobile vitals (`docs/specs/mobile-vitals.md`): `beginRuntime(at:)` (cold or warm start), `startFrameTracking()` / `frameStats()` (`CADisplayLink`: total, slow, frozen, delay), `HangDetector` (app hang rules on the same frames) and `startHangTracking` (its watchdog thread). See `project/kb/ios-vitals.md` |
| `OuoSDK` | the four above | `Ouo.start` and the public API (Swift and `@objc`), `SessionManager` (session-lifecycle.md mobile rules, `session.json`), `Core` (records, error context, the timeline buffer), `Exporter` (OTLP/JSON batches into a `DiskQueue`), the `URLSession` hook, `Vitals`, the UIKit lifecycle, `PrivacyInfo.xcprivacy` |
| `OuoCrash` | Foundation, `OuoVitals` | `OuoCrash.install()`, the uncaught `NSException` handler, `setSession(_:startedAtMs:)` (the session and its start go into the report), `takePendingReport()` (the host sends it on the next launch; the React Native SDK does): the crash report, else a `termination` report when the previous run was killed while active (`RunState`, `Termination`); `startHangTracking(onHang:)` (one `hang` report per app hang); `ErrorContext` (memory, network type). Tested on macOS by crashing `OuoCrashProbe` (`project/kb/ios-native-crashes.md`, `project/kb/ios-hangs-terminations.md`) |

## Install

Swift Package Manager, local path in this repository:

```swift
.package(path: "../../sdk/ios"),
// ...
.product(name: "OuoReplay", package: "ios")   // identity = last path component; "ouo11y-ios" from the mirror
```

Minimum iOS 15. The package has no third-party dependencies (zlib is linked from the system).

Not yet consumable by URL: SwiftPM resolves a remote package only when `Package.swift` sits at
the root of the repository (or of a tagged mirror repository). `sdk/ios` is a subdirectory of
the monorepo, so `.package(url: "https://github.com/ouo11y/ouo11y", ...)` does not work; a
`ouo11y-ios` mirror with its own tags is the usual answer (release process, not decided here).

## Usage

```swift
import OuoReplay

OuoReplay.start(OuoReplayConfig(
    endpoint: URL(string: "http://localhost:4319")!,   // collector replay receiver; chunks go to /v1/replay/chunks
    projectId: "demo",                                 // user name of the Basic credential (ADR-0007)
    projectToken: "pt_dev_demo_0000000000000000",      // password of the Basic credential; public by nature
    sessionId: { SessionStore.shared.currentId },       // called when a chunk opens
    mode: .auto,                                       // .session, .navigation, or .auto (navigation below 3.5 GiB RAM)
    frameInterval: 1.0,
    maskText: true, maskInputs: true, maskImages: true, maskWebViews: true,
    debug: false))

OuoReplay.pause()               // stops capturing, flushes
OuoReplay.resume()              // immediate frame, capture restarts
OuoReplay.screenDidChange()     // a new screen: its frame in navigation mode
OuoReplay.recoverPendingChunk(config)  // send the chunk a crash left open; `start` does it too, call it
                                       // first when you decide per session whether to record
OuoReplay.isRecording           // Bool
OuoReplay.flush { }             // flush the open chunk and drain the upload queue
OuoReplay.sessionDidRotate(newId: "…")   // flushes the old session's chunk, seq restarts at 0
OuoReplay.stop()
```

SwiftUI: call `OuoReplay.start` from `App.init` or `.onAppear` of the root view; the capturer
finds the key window itself. UIKit: call it from `application(_:didFinishLaunchingWithOptions:)`.
All calls are safe from any thread; the capture runs on the main thread (UIKit requirement).

`OuoReplayConfig` also exposes `flushInterval` (5 s; a chunk is also cut once its images pass 1 MiB), `jpegQuality`
(0.5), `maxLongestSide` (1000 px), `maskClasses` (extra class names), `spoolURL` (the open
chunk's file, `Application Support/ouo/replay/open-chunk.jsonl`), `seqStore` (`UserDefaultsSeqStore` by default, `InMemorySeqStore` for tests) and the
computed `authorization` (the header value the uploader sends). The endpoint is the replay
receiver's base URL: port 4319 next to the collector's OTLP 4318 in the local stack, or the proxy
host (`https://otel.example.com`) that routes `/v1/replay/*` to it in a deployment.

## Masking and how to opt out

Redacted by default (spec capture rule 4), in four independent groups (`RedactionRules`):

| Option (default `true`) | Classes |
|---|---|
| `maskText` | `UILabel`, React Native text (`RCTTextView`, `RCTParagraphComponentView`, `RCTParagraphTextView`), iOS 26+ bar item wrapper (`_TtCC5UIKit19NavigationButtonBar15ItemWrapperView`) |
| `maskInputs` | `UITextField`, `UITextView`, `RCTUITextField`, `RCTUITextView`, `RCTTextInputComponentView` |
| `maskImages` | `UIImageView` (with an image), `RCTImageView`, `RCTImageComponentView` |
| `maskWebViews` | `WKWebView` |

Subclasses match through their superclass chain. Hidden views, views with alpha `<= 0.01`, and
views entirely outside the window are skipped together with their subtrees; visible rectangles
are clipped to the window and overlapping ones merged.

Masking fails closed (capture rule 5): when a masked view is moving (a screen sliding in, a view
animating its position or transform, a list being scrolled), the whole frame is dropped instead of
painting a rectangle where the view may no longer be; a view fading out stays masked until it is
gone; a subtree deeper than the walk's limit (64) is masked whole.

The default is privacy first: everything that can carry user content is black until the host
opts in to visibility (Sentry's mobile replay ships the same default). To opt out:

- `maskText: false` makes labels, paragraphs and bar titles readable. Inputs stay black because
  they are governed by `maskInputs`, not `maskText`.
- `maskImages: false` shows images; `maskWebViews: false` shows web views.
- `maskInputs: false` shows typed text. Only set it if you really mean it.
- `maskClasses: ["MyChartView"]` (`RedactionRules.extraClasses`) masks additional class names.

Per-view overrides through `accessibilityIdentifier` (React Native `testID`), honoured whatever
the options above say:

- `ouo-mask`: the view is redacted whatever its class; the rectangle covers its subtree.
- `ouo-unmask`: the view and its whole subtree are left visible.

Rectangles are filled with opaque black on the rendered image, then the image is downscaled so
its longest side is at most 1000 px and encoded as JPEG (quality 0.5). The chunk's `masked`
flag is `true` when any rule (including `extraClasses`) is active.

## Chunks and upload

`ChunkBuilder` opens a chunk on the first frame or touch (reserving `seq` and the session id at
that moment, so a rotation mid-chunk never relabels frames), and flushes after 5 s, at 10
frames, or on `pause` / background / rotation / `flush`. Frames whose 16x16 grayscale
thumbnail hashes (FNV-1a) like the previous one are dropped; `resume` and rotation reset the
reference so the next frame is always sent.

`ChunkUploader` POSTs `${endpoint}/v1/replay/chunks` with `Authorization: Basic
base64("<projectId>:<projectToken>")` (`ChunkUploader.basicAuthorization(projectId:projectToken:)`,
standard base64 of the UTF-8 bytes; the collector's `basicauth` answers 401 without a valid pair),
`content-type: application/json`, `content-encoding: gzip`, `x-ouo-session-id`, `x-ouo-seq`; sends
chunks in order from a folder on disk (`DiskQueue`), retries 408, 429, 5xx and network errors with
a backoff from 1 s to 60 s (at least `Retry-After`), on `drain` and on the next launch, and drops
the oldest queued chunk beyond 10 MB or 24 h.
Touches cancelled by UIKit are reported as `ended` (rum-api accepts only
`began|moved|ended`).

## Build and test

```bash
cd sdk/ios
swift build            # macOS: Core builds fully, OuoReplay compiles to the stub
./test.sh              # every test target, Swift Testing; works with the Command Line Tools only
eval "$(../../deploy/envs/ouo-env env <env>)" && OUO_E2E_NATIVE=1 swift test --filter RealCollector   # OuoSDK into rum-api
OUO_REPLAY_STUB_URL=http://localhost:4319 OUO_PROJECT_ID=demo OUO_PROJECT_TOKEN=pt_dev_demo_0000000000000000 ./test.sh --filter RealHTTP   # push real chunks to the collector
```

`./test.sh` is `swift test` plus the framework search paths for Swift Testing, which the
Command Line Tools ship but SwiftPM does not look for; with Xcode installed it is plain
`swift test`. Why Swift Testing and not XCTest: the Command Line Tools do not include XCTest.

With Xcode:

```bash
xcodebuild -scheme OuoSDK -destination 'generic/platform=iOS Simulator' build   # every UIKit target
```

What needs Xcode: compiling the `OuoReplay` UIKit target for iOS, the simulator, and the
CocoaPods build of the Expo module (`project/kb/xcode-setup.md`).
