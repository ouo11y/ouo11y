# Changelog: OuoReplay (Swift package `ouo11y-ios`)

Published to the read-only mirror `github.com/ouo11y/ouo11y-ios` with the plain tag `<version>`
when `ios-v<version>` is pushed here. `version.txt` holds the version (SwiftPM has none); the
release workflow refuses a tag that differs. Policy: [`docs/releasing.md`](../../docs/releasing.md).
New entries are written by release-please from conventional commits (`feat(ios): ...`).

## Unreleased

### Added

- **W8 part 2** (`OuoSDK`): screens from UIKit by themselves (a `viewWillAppear` / `viewDidAppear`
  swizzle on `UIViewController`; the app's controllers shown on their own or in a system container;
  TTID from `viewWillAppear`; `OuoScreenNaming`), SwiftUI's `.ouoScreen("Name")`; `ui.tap` for every
  touch (OuoReplay's `TouchObserver`; named by `accessibilityIdentifier` or `Ouo.trackTap`, else the
  view type; accessibility labels are never read, since assistive technologies fill them with the
  visible title) with `taps` and the `tapLabels` kill switch; SwiftUI `.ouoMask()` and
  `.ouoUnmask()`; `Ouo.feedback` (C10, with a masked frame when replay records); the screen context
  in memory for the crash handler (`OuoCrash.setContext`), so a crash right after a tap carries it.
- Replay masks SwiftUI text (`SwiftUI.CGDrawingView`) under `maskText`, and SwiftUI images and
  shapes (`SwiftUI._UIGraphicsView`, `…_UIShapeHitTestingView`) under `maskImages`. In system bars
  SwiftUI's drawing is chrome and not masked, except a SwiftUI toolbar item's (`UIKitBarItemHost`).
  An `ouo-unmask-area` view (SwiftUI's `.ouoUnmask()`) leaves out the class masks inside its frame,
  never forced `ouo-mask` ones.
- The `OuoObjCSmoke` target: every Objective-C call of `OuoSDK`, compiled for iOS in CI.
- The replay chunk a crash left open ends at the crash when `OuoSDK` knows it
  (`recoverPendingChunk(_:crash:)`), as the spec's C8 says: an unchanged screen sends no frames, so
  its last frame could be seconds before the crash.

- **`OuoSDK`, the SDK for native apps** (mobile SDK roadmap W8 part 1, ADR-0016): `Ouo.start(OuoConfig)`
  and a Swift and `@objc` API. A Swift session manager (session-lifecycle.md mobile rules: background
  timeout, inactivity, max duration, crash and termination on the next launch, `session.previous_id`,
  `user_change`, `manual`, `device.id`, N52's `session_started_ms`), an OTLP/JSON exporter for logs and
  traces (gzip, Basic credential, a durable outbox of 5 MB / 500 requests / 24 h), the app lifecycle
  (`app.lifecycle`, flush on background), a `URLSession` hook (client spans, `traceparent` and
  `baggage` to the listed origins, `http.request.failed`), OuoCrash (crashes, terminations and hangs
  with the error context), OuoVitals (app start, TTID, TTFD, frames) and OuoReplay (per sampled
  session) wired into it, `trackScreen`, `captureError`, `log`, `startSpan` / `withSpan`, and
  `PrivacyInfo.xcprivacy`.
- `DiskQueue` (OuoReplayCore): the folder queue the chunk uploader used, now shared with the OTLP
  outbox, with an entry bound. While a retry waits, new entries no longer trigger a send (an outage
  costs one request per backoff); entries are written readable after the first unlock.
- `OuoVitals.nextFrame(_:)` (the time the next frame shows, `targetTimestamp`) and
  `OuoCrash.stackFields(_:)` made public.

### Removed

- `ChunkUploader.UploadError` (unused since the queue moved to `DiskQueue`). `DiskQueue.put` sends a
  refused write once from memory itself (`sendIfRefused`), for chunks and OTLP alike.

- **App hangs** (mobile SDK spec C3.1, roadmap W4): `OuoCrash.startHangTracking(onHang:)` runs a
  watchdog thread on `OuoVitals`' display link frames (`HangDetector`, sentry-cocoa's V2 rules: 2 s,
  fully and not fully blocking, one report per hang) and reports each hang once it is over as a
  `hang` report (crash report format: duration, fully blocking, the main thread's stack read at
  detection by `ouo_crash_main_thread_backtrace`). Not while inactive or under a debugger.
- **Foreground terminations** (C3.2): `OuoCrash.install()` keeps `run.json` (`RunState`) current; the
  next launch's `takePendingReport()` returns a `termination` report (`Termination.decide`: active,
  no crash report, no `willTerminate`, debugger, update, OS update or reboot; cause `memory`,
  `watchdog` or `unknown`) when there is no crash report.
- `ErrorContext`: memory footprint, available memory and network type for error reports.

### Changed

- Replay chunks are `frames` schema 2 (ADR-0014, mobile SDK roadmap W3): a frame is a full image or
  the rectangles that changed since the last frame sent (64 px tiles, merged, each its own JPEG);
  a chunk starts with a full image, as do the frames after a resume or a screen change and any
  frame that changed over more than half its area. A static screen sends no image bytes. Chunks
  carry `mode` and are cut every 5 s, once their images pass 1 MiB, and when the viewport changes;
  `maxFramesPerChunk` and `FrameDeduper` are removed. Needs rum-api and a collector that read
  schema 2 (`docs/operations/upgrade.md` section 4).
- `ChunkBuilder` clears the spool only after the cut chunk was handed to `onChunk`.

- Production-safe capture (mobile SDK roadmap W1, ADR-0006 rev 2): frames are taken by a main
  run-loop observer after the pass's UI work, at most one per `frameInterval`, never on touches
  (`maxTouchCapturesPerSecond` is removed); a due frame waits up to 1 s while 4 or more layer
  animations run; the main-thread capture time is bounded by a 100 ms per second time bank (the
  backoff for slow devices); one capture in flight.
- Masking fails closed: a frame in which a masked view is moving (an animated position, bounds or
  transform, a scroll in progress) is dropped before it is rendered, a view fading out stays
  masked, and a subtree the walk cut at its depth limit is masked whole. `RedactionPlanner.rects` returns nil
  for a frame that must be dropped.
- `OuoCrash.setSessionId(_:)` is now `setSession(_:startedAtMs:)`: the crash report carries
  `session_started_ms` (N52).

### Added

- `ReplayMode` (`session`, `navigation`, `auto`: navigation below 3.5 GiB of RAM) and
  `OuoReplay.screenDidChange()`.
- `ChunkSpool`: the open chunk is kept on disk (`Application Support/ouo/replay/open-chunk.jsonl`,
  excluded from backups) and sent on the next launch after a crash, watchdog kill or force quit;
  `OuoReplay.recoverPendingChunk(_:)` sends it without starting a recorder. Older than 24 h: dropped.

- `OuoVitals` and `OuoVitalsCore`: app start (process start from `sysctl`, image load time for
  prewarmed launches, cold or warm per runtime) and `CADisplayLink` frame counters (total, slow,
  frozen, delay) for the mobile vitals spec (checklist G2).

## 0.2.0 (not yet tagged)

First mirrored release. Products `OuoReplay` (UIKit capture) and `OuoReplayCore` (models,
chunking, upload), iOS 15+.

### Compatibility

- Frames replay chunks, `schema_version` 1, `POST /v1/replay/chunks` on the collector's replay
  receiver with HTTP Basic project credentials (ADR-0007). Needs collector >= 0.2.0 and
  rum-api >= 0.2.0; see [`docs/compatibility.md`](../../docs/compatibility.md).
