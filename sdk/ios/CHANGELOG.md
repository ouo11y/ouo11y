# Changelog: OuoReplay (Swift package `ouo11y-ios`)

Published to the read-only mirror `github.com/ouo11y/ouo11y-ios` with the plain tag `<version>`
when `ios-v<version>` is pushed here. `version.txt` holds the version (SwiftPM has none); the
release workflow refuses a tag that differs. Policy: [`docs/releasing.md`](../../docs/releasing.md).
New entries are written by release-please from conventional commits (`feat(ios): ...`).

## Unreleased

### Changed

- Production-safe capture (mobile SDK roadmap W1, ADR-0006 rev 2): frames are taken by a main
  run-loop observer after the pass's UI work, at most one per `frameInterval`, never on touches
  (`maxTouchCapturesPerSecond` is removed); a due frame waits up to 1 s while 4 or more layer
  animations run; the main-thread capture time is bounded by a 100 ms per second time bank (the
  backoff for slow devices); one capture in flight.
- Masking fails closed: a frame in which a masked view sits on a moving layer is dropped, and a
  subtree the walk cut at its depth limit is masked whole. `RedactionPlanner.rects` returns nil
  for a frame that must be dropped.
- `OuoCrash.setSessionId(_:)` is now `setSession(_:startedAtMs:)`: the crash report carries
  `session_started_ms` (N52).

### Added

- `ReplayMode` (`session`, `navigation`, `auto`: navigation below 3.5 GiB of RAM) and
  `OuoReplay.screenDidChange()`.
- `ChunkSpool`: the open chunk is kept on disk (`Application Support/ouo/replay/open-chunk.jsonl`)
  and sent on the next launch after a crash, watchdog kill or force quit.

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
