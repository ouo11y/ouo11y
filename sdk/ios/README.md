# OuoReplay (sdk/ios)

Native session replay capture for iOS, the native half of ouo mobile replay (ADR-0006,
contract in `docs/specs/mobile-replay.md`). It snapshots the key window about once a second
and on touches, paints opaque rectangles over sensitive views **before the frame leaves the
device**, drops unchanged frames, and uploads gzip JSON frame chunks to rum-api
(`POST /v1/replay/chunks`, `kind: "frames"`) keyed by the host's `session.id` and authenticated
with the project token (`X-Ouo-Project-Token`, ADR-0007).

The React Native SDK (`sdk/react-native`) wraps this package through an Expo module; native
apps use it directly.

## Layout

| Target | Needs | Contents |
|---|---|---|
| `OuoReplayCore` | Foundation + zlib | `FrameChunk`/`Frame`/`Touch`/`Viewport` models (spec JSON keys), `ChunkBuilder` (5 s / 10 frames / explicit flush, monotonic `seq` via `SeqStore`), `FrameDeduper`, `RedactionPlanner` (geometry over a `ViewNode` tree), `Gzip` (RFC 1952 via zlib), `ChunkUploader` (URLSession, retry 3x with 1 s / 2 s backoff, 2 MB bounded queue) |
| `OuoReplay` | UIKit | `OuoReplayConfig`, the `OuoReplay` entry point, `ScreenCapturer` (drawHierarchy + redaction fill + downscale + JPEG), `TouchObserver` (observing gesture recognizer), `ReplayRecorder` (timer, touch-triggered captures, background/foreground). On macOS this target compiles to a stub that prints "iOS only" so `swift build` works with the Command Line Tools |

## Install

Swift Package Manager, local path in this repository:

```swift
.package(path: "../../sdk/ios"),
// ...
.product(name: "OuoReplay", package: "OuoReplay")
```

Minimum iOS 15. The package has no third-party dependencies (zlib is linked from the system).

Not yet consumable by URL: SwiftPM resolves a remote package only when `Package.swift` sits at
the root of the repository (or of a tagged mirror repository). `sdk/ios` is a subdirectory of
the monorepo, so `.package(url: "https://github.com/ZiadMansourM/ouo", ...)` does not work; a
`ouo-ios` mirror with its own tags is the usual answer (release process, not decided here).

## Usage

```swift
import OuoReplay

OuoReplay.start(OuoReplayConfig(
    endpoint: URL(string: "http://localhost:8080")!,   // rum-api base URL
    projectToken: "pt_dev_demo_0000000000000000",      // X-Ouo-Project-Token on every upload (ADR-0007)
    sessionId: { SessionStore.shared.currentId },       // called when a chunk opens
    frameInterval: 1.0,
    maskText: true, maskInputs: true, maskImages: true, maskWebViews: true,
    debug: false))

OuoReplay.pause()               // stops the timer, flushes
OuoReplay.resume()              // immediate frame, timer restarts
OuoReplay.isRecording           // Bool
OuoReplay.flush { }             // flush the open chunk and drain the upload queue
OuoReplay.sessionDidRotate(newId: "…")   // flushes the old session's chunk, seq restarts at 0
OuoReplay.stop()
```

SwiftUI: call `OuoReplay.start` from `App.init` or `.onAppear` of the root view; the capturer
finds the key window itself. UIKit: call it from `application(_:didFinishLaunchingWithOptions:)`.
All calls are safe from any thread; the capture runs on the main thread (UIKit requirement).

`OuoReplayConfig` also exposes `flushInterval` (5 s), `maxFramesPerChunk` (10), `jpegQuality`
(0.5), `maxLongestSide` (1000 px), `maxTouchCapturesPerSecond` (4), `maskClasses` (extra class
names) and `seqStore` (`UserDefaultsSeqStore` by default, `InMemorySeqStore` for tests).

## Masking and how to opt out

Redacted by default (spec rule 2), in four independent groups (`RedactionRules`):

| Option (default `true`) | Classes |
|---|---|
| `maskText` | `UILabel`, React Native text (`RCTTextView`, `RCTParagraphComponentView`, `RCTParagraphTextView`), iOS 26+ bar item wrapper (`_TtCC5UIKit19NavigationButtonBar15ItemWrapperView`) |
| `maskInputs` | `UITextField`, `UITextView`, `RCTUITextField`, `RCTUITextView`, `RCTTextInputComponentView` |
| `maskImages` | `UIImageView` (with an image), `RCTImageView`, `RCTImageComponentView` |
| `maskWebViews` | `WKWebView` |

Subclasses match through their superclass chain. Hidden views, views with alpha `<= 0.01`, and
views entirely outside the window are skipped together with their subtrees; visible rectangles
are clipped to the window and overlapping ones merged.

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

`ChunkUploader` POSTs `${endpoint}/v1/replay/chunks` with `X-Ouo-Project-Token` (the project
token from the config; rum-api answers 401 without it), `content-type: application/json`,
`content-encoding: gzip`, `x-ouo-session-id`, `x-ouo-seq`; sends chunks in order, retries
three times (1 s, 2 s), and drops the oldest queued chunk when more than 2 MB is waiting.
Touches cancelled by UIKit are reported as `ended` (rum-api accepts only
`began|moved|ended`).

## Build and test

```bash
cd sdk/ios
swift build            # macOS: Core builds fully, OuoReplay compiles to the stub
./test.sh              # Core tests (39), Swift Testing; works with the Command Line Tools only
OUO_REPLAY_STUB_URL=http://localhost:8080 OUO_PROJECT_TOKEN=pt_dev_demo_0000000000000000 ./test.sh --filter RealHTTP   # push real chunks to rum-api
```

`./test.sh` is `swift test` plus the framework search paths for Swift Testing, which the
Command Line Tools ship but SwiftPM does not look for; with Xcode installed it is plain
`swift test`. Why Swift Testing and not XCTest: the Command Line Tools do not include XCTest.

With Xcode:

```bash
xcodebuild -scheme OuoReplay -destination 'generic/platform=iOS Simulator' build
```

What needs Xcode: compiling the `OuoReplay` UIKit target for iOS, the simulator, and the
CocoaPods build of the Expo module (`kb/xcode-setup.md`).
