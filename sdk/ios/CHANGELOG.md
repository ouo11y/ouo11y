# Changelog: OuoReplay (Swift package `ouo11y-ios`)

Published to the read-only mirror `github.com/ouo11y/ouo11y-ios` with the plain tag `<version>`
when `ios-v<version>` is pushed here. `version.txt` holds the version (SwiftPM has none); the
release workflow refuses a tag that differs. Policy: [`docs/releasing.md`](../../docs/releasing.md).
New entries are written by release-please from conventional commits (`feat(ios): ...`).

## Unreleased

### Added

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
