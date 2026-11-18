# Changelog: OuoReplay (Swift package `ouo11y-ios`)

Published to the read-only mirror `github.com/ouo11y/ouo11y-ios` with the plain tag `<version>`
when `ios-v<version>` is pushed here. `version.txt` holds the version (SwiftPM has none); the
release workflow refuses a tag that differs. Policy: [`docs/releasing.md`](../../docs/releasing.md).
New entries are written by release-please from conventional commits (`feat(ios): ...`).

## Unreleased

## [0.4.0](https://github.com/ouo11y/ouo11y/compare/ios-v0.3.0...ios-v0.4.0) (2026-11-18)


### ⚠ BREAKING CHANGES

* **react-native:** session replay over OTLP with pixel/frames and pixel/video on iOS and Android (ADR-0021) ([#184](https://github.com/ouo11y/ouo11y/issues/184))

### Added

* **ios:** a feedback frame follows the feedback, the plugin says screenshot ([93bc1bd](https://github.com/ouo11y/ouo11y/commit/93bc1bd0664ecc81b6759e83b15efb7504dc4a41))
* **react-native:** session replay over OTLP with pixel/frames and pixel/video on iOS and Android (ADR-0021) ([#184](https://github.com/ouo11y/ouo11y/issues/184)) ([edd3fa2](https://github.com/ouo11y/ouo11y/commit/edd3fa28889c4252de4c12e9a08c8091d177ca13))


### Fixed

* **ios:** disk queues keep no wall-clock age, names keep put order ([eda5e32](https://github.com/ouo11y/ouo11y/commit/eda5e3206601fc440a61a3dd96d442a92f005a3d))
* **sdk:** mobile delivery retries only 429 and 502-504, React Native outbox keeps no age ([1959cc0](https://github.com/ouo11y/ouo11y/commit/1959cc04057b84bd503f8d7ced31aeb3218b8e15))

## 0.3.0 (2026-10-31)

First version published to the mirror `ouo11y/ouo11y-ios` (0.2.0 was never tagged). Products
`OuoSDK`, `OuoReplay`, `OuoReplayCore`, `OuoCrash`, `OuoVitals`; iOS 15+. Every Objective-C call of
`OuoSDK` is compiled for iOS in CI (`OuoObjCSmoke`).

### Breaking

- Replay chunks are `frames` **schema 2** (below): they need rum-api >= 0.6.0 and collector
  >= 0.5.0, and plugin 0.10 to play them. Upgrade the server side first
  (`docs/operations/upgrade.md` section 4).
- API removed or changed in `OuoReplay` and `OuoReplayCore`:
  - `OuoReplayConfig.maxTouchCapturesPerSecond` is removed (W1).
  - `RedactionPlanner.rects(for:window:)` returns `[CGRect]?`: `nil` for a frame that must be
    dropped (masking fails closed, W1).
  - `OuoReplayConfig.maxFramesPerChunk` and `FrameDeduper` are removed, with
    `FrameComposer.thumbnail(of:side:)` (which existed only in the copy React Native 0.2.x
    vendored) (W3).
  - `ChunkBuilder.Config.maxFrames` is replaced by `maxImageBytes`: the init is now
    `init(flushInterval:maxImageBytes:platform:masked:mode:)` (W3).
  - `ChunkTransport.send(_:completion:)` and `URLSessionTransport.send` complete with
    `Result<ChunkResponse, Error>` instead of `Result<Int, Error>`, so custom transports must be
    updated (W3 delivery, W8).
  - `ChunkUploader.Config.maxAttempts` is removed (retries run until `maxAge`; the init takes
    `maxAge` and `hold`) and `ChunkUploader.UploadError` is removed (W3 delivery, W8).
- `OuoCrash.setSessionId(_:)` is now `setSession(_:startedAtMs:)` (N52). `OuoCrash` was never in an
  iOS release; this concerns only the copy React Native 0.2.x vendored.

### Added

- **`OuoSDK`, the SDK for native apps** (mobile SDK roadmap W8 part 1, ADR-0016): `Ouo.start(OuoConfig)`
  and a Swift and `@objc` API. A Swift session manager (session-lifecycle.md mobile rules: background
  timeout, inactivity, max duration, crash and termination on the next launch, `session.previous_id`,
  `user_change`, `manual`, `device.id`, N52's `session_started_ms`), an OTLP/JSON exporter for logs and
  traces (gzip, Basic credential, a durable outbox of 5 MB / 500 requests / 24 h), the app lifecycle
  (`app.lifecycle`, flush on background), a `URLSession` hook (client spans, `traceparent` and
  `baggage` to the listed origins, `http.request.failed`), OuoCrash (crashes, terminations and hangs
  with the error context), OuoVitals (app start, TTID, TTFD, frames) and OuoReplay (per sampled
  session) wired into it, `trackScreen`, `captureError`, `log`, `startSpan` / `withSpan`, and
  `PrivacyInfo.xcprivacy` ([69033f6](https://github.com/ouo11y/ouo11y/commit/69033f66dd0b61bd54a6646da88a373f7f26ff13)).
- **Screens, taps, SwiftUI and feedback in `OuoSDK`** (W8 part 2): screens from UIKit by
  themselves (a `viewWillAppear` / `viewDidAppear` swizzle on `UIViewController`; the app's
  controllers shown on their own or in a system container; TTID from `viewWillAppear`;
  `OuoScreenNaming`) and SwiftUI's `.ouoScreen("Name")`; `ui.tap` for every touch (OuoReplay's
  `TouchObserver`; named by `accessibilityIdentifier` or `Ouo.trackTap`, else the view type;
  accessibility labels are never read) with `OuoConfig.screens`, `taps` and the `tapLabels` kill
  switch; SwiftUI `.ouoMask()` and `.ouoUnmask()`; `Ouo.feedback` (C10, with a masked frame when
  replay records); the screen context kept in memory for the crash handler (`OuoCrash.setContext`),
  so a crash right after a tap carries it
  ([64d5056](https://github.com/ouo11y/ouo11y/commit/64d5056a33d67c9be447d2f39b9697fbffed64e2)).
- **SwiftUI masking**: replay masks SwiftUI text (`SwiftUI.CGDrawingView`) under `maskText`, and
  SwiftUI images and shapes (`SwiftUI._UIGraphicsView`, `…_UIShapeHitTestingView`) under
  `maskImages`. In system bars SwiftUI's drawing is chrome and not masked, except a SwiftUI toolbar
  item's (`UIKitBarItemHost`). An `ouo-unmask-area` view (`.ouoUnmask()`) leaves out the class
  masks inside its frame, never forced `ouo-mask` ones.
- The replay chunk a crash left open ends at the crash when `OuoSDK` knows it
  (`recoverPendingChunk(_:crash:)`, spec C8): an unchanged screen sends no frames, so its last frame
  could be seconds before the crash.
- **App hangs** (mobile SDK spec C3.1, roadmap W4): `OuoCrash.startHangTracking(onHang:)` runs a
  watchdog thread on `OuoVitals`' display link frames (`HangDetector`, sentry-cocoa's V2 rules: 2 s,
  fully and not fully blocking, one report per hang) and reports each hang once it is over as a
  `hang` report (crash report format: duration, fully blocking, the main thread's stack read at
  detection by `ouo_crash_main_thread_backtrace`). Not while inactive or under a debugger
  ([aa6da5a](https://github.com/ouo11y/ouo11y/commit/aa6da5aa7dd8275538ee13e7de9adc860ad69e03)).
- **Foreground terminations** (C3.2): `OuoCrash.install()` keeps `run.json` (`RunState`) current; the
  next launch's `takePendingReport()` returns a `termination` report (`Termination.decide`: active,
  no crash report, no `willTerminate`, debugger, update, OS update or reboot; cause `memory`,
  `watchdog` or `unknown`) when there is no crash report. `ErrorContext`: memory footprint,
  available memory and network type for error reports.
- **Durable chunk delivery** (W3): cut chunks wait in a folder queue (`OuoReplayConfig.outboxURL`)
  until the receiver accepts them, through an outage and a kill; one uploader per process;
  `holdUploads` with `OuoReplay.heldSessions` / `releaseHeld` for a next-launch keep or drop decision
  ([8f65408](https://github.com/ouo11y/ouo11y/commit/8f6540800034e658317f61dbfb674cc72be2bc89)).
  `DiskQueue` (OuoReplayCore) is that queue, now shared with the OTLP outbox, with an entry bound;
  while a retry waits, new entries no longer trigger a send (an outage costs one request per
  backoff); entries are written readable after the first unlock.
- `ReplayMode` (`session`, `navigation`, `auto`: navigation below 3.5 GiB of RAM) and
  `OuoReplay.screenDidChange()`.
- `ChunkSpool`: the open chunk is kept on disk (`Application Support/ouo/replay/open-chunk.jsonl`,
  excluded from backups) and sent on the next launch after a crash, watchdog kill or force quit;
  `OuoReplay.recoverPendingChunk(_:)` sends it without starting a recorder. Older than 24 h: dropped.
- `OuoCrash`: native crash capture (fatal signals, written as a crash report that the next launch reads
  and sends); replay capture off the main thread
  ([9fb3dc4](https://github.com/ouo11y/ouo11y/commit/9fb3dc4a6b4fd3cdecb5177e2ffc2d58eef9a840)).
- `OuoVitals` and `OuoVitalsCore`: app start (process start from `sysctl`, image load time for
  prewarmed launches, cold or warm per runtime) and `CADisplayLink` frame counters (total, slow,
  frozen, delay) for the mobile vitals spec (checklist G2,
  [8121faf](https://github.com/ouo11y/ouo11y/commit/8121faf6784f2276a64e75991c0b282010dc53f6)).
- `OuoVitals.nextFrame(_:)` (the time the next frame shows, `targetTimestamp`) and
  `OuoCrash.stackFields(_:)` made public.

### Changed

- **Replay tiles, `frames` schema 2** (ADR-0014, mobile SDK roadmap W3): a frame is a full image or
  the rectangles that changed since the last frame sent (64 px tiles, merged, each its own JPEG);
  a chunk starts with a full image, as do the frames after a resume or a screen change and any
  frame that changed over more than half its area. A static screen sends no image bytes. Chunks
  carry `mode` and are cut every 5 s, once their images pass 1 MiB, and when the viewport changes
  ([bf5c22d](https://github.com/ouo11y/ouo11y/commit/bf5c22d47925656414f9877b6ba448a32185f942)).
- **Production-safe capture** (mobile SDK roadmap W1, ADR-0006 rev 2): frames are taken by a main
  run-loop observer after the pass's UI work, at most one per `frameInterval`, never on touches;
  a due frame waits up to 1 s while 4 or more layer animations run; the main-thread capture time
  is bounded by a 100 ms per second time bank (the backoff for slow devices); one capture in flight
  ([986c37a](https://github.com/ouo11y/ouo11y/commit/986c37a2c175f85c922fdc383758d0066b84b012)).
- Masking fails closed: a frame in which a masked view is moving (an animated position, bounds or
  transform, a scroll in progress) is dropped before it is rendered, a view fading out stays
  masked, and a subtree the walk cut at its depth limit is masked whole (`RedactionPlanner.rects`
  under Breaking).
- The crash report carries `session_started_ms` (N52). `ChunkBuilder` clears the spool only after
  the cut chunk was handed to `onChunk`. `DiskQueue.put` sends a refused write once from memory
  itself (`sendIfRefused`), for chunks and OTLP alike.

### Compatibility

- Needs collector >= 0.5.0 and rum-api >= 0.6.0 (schema 2); see
  [`docs/compatibility.md`](../../docs/compatibility.md). SwiftPM:
  `.package(url: "https://github.com/ouo11y/ouo11y-ios.git", from: "0.3.0")`.

## 0.2.0 (never tagged: first published as part of 0.3.0)

First mirrored release. Products `OuoReplay` (UIKit capture) and `OuoReplayCore` (models,
chunking, upload), iOS 15+.

### Compatibility

- Frames replay chunks, `schema_version` 1, `POST /v1/replay/chunks` on the collector's replay
  receiver with HTTP Basic project credentials (ADR-0007). Needs collector >= 0.2.0 and
  rum-api >= 0.2.0; see [`docs/compatibility.md`](../../docs/compatibility.md).
