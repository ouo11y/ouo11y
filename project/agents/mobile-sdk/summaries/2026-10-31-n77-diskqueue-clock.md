# 2026-10-31 N77: the iOS disk queues do not trust the wall clock

Branch `claude/ios-n77-diskqueue`, checklist N77 (found in the W8 part 1 review, #123). Env `ios-n77-diskqueue`, simulator `ouo-n77-n76` (F93D8F09-8AE9-45DF-A577-3ED43108C897, iPhone 18 Pro, iOS 27).

## What was done

- **No age bound** in `DiskQueue` (`sdk/ios/Sources/OuoReplayCore/DiskQueue.swift`): `Config.maxAge` is gone, entries are dropped only by the byte and entry bounds (oldest first, never the newest nor the one in flight), by a final status, or when unreadable. The same for what feeds it: `ChunkUploader.Config.maxAge` is gone (queued and held replay chunks) and `ChunkSpool.recover` no longer drops an open chunk that started more than 24 h ago. The OTLP outbox (`Exporter.outbox`) keeps 5 MB and 500 requests.
- **Names keep the order of `put`**: the stamp in `<stamp>-<counter>.<tag>` is `max(wall clock, newest stamp in the folder + 1)`, so a clock moved back does not put a new entry before older ones (in this process or the next, whose counter starts again), and the bound still drops the real oldest. `Entry.queuedAt` (and `HeldSession.firstAt` / `lastAt`) are that stamp: the queue time unless the clock moved back.
- Specs: `mobile-sdk.md` C11 and `mobile-replay.md` "Delivery" say no age, and why; the iOS and React Native READMEs and the stand-in's comment follow.
- New checklist item **N81**: the React Native JS outbox (`outbox.ts`, AsyncStorage) still drops requests older than 24 h by `Date.now()`; the same fix applies there.

## Why bounds only, not a monotonic age

An age has to be measured across processes and reboots (entries outlive both). The wall clock is the user's to move (the bug: a day forward dropped the whole queue; back, it kept entries longer). A monotonic clock (`mach_continuous_time`, `systemUptime`) restarts at boot, and `kern.boottime` moves with the wall clock, so "boot time + uptime" is the wall clock again. A correct age would need a boot session id per entry and would still know nothing across a reboot. The age bought nothing the bounds do not: the disk is capped by bytes and entries, and data too old to ingest is the backend's call (the collector answers 2xx, Loki and Mimir reject old samples behind it). Sentry keeps 30 envelopes and no age.

## Verified, and how

- `sdk/ios/test.sh` (Xcode): all suites pass (34 + 77 + 94 + 24 tests). New: `DiskQueueTests.AClockMovedForwardDropsNothing` (two days forward: both entries kept, the next process sends them then its own), `AClockMovedBackKeepsTheOrder` (two days back: the new entry sorts last in this process and the next, the bound drops the real oldest, back on time names follow the clock), `ChunkUploaderTests.AClockMovedForwardKeepsTheChunks` (was `ChunksOlderThanMaxAgeAreDroppedUnsent`), `ChunkSpoolTests.AClockMovedForwardKeepsTheSpool` (was `StaleSpoolIsDropped`).
- Native conformance suite (`tests/e2e/mobile-native/run.sh`) against env `ios-n77-diskqueue` on the simulator above: 17 of 18 pass, C11.1 (offline run, then the next launch delivers) and C11.2, C8.1, C8.3 (replay chunks through the queue) among them. C8.2 failed on the toolbar-title area only (mean 0.44; text, input, SwiftUI text and image 0.004): the example noted that area at x 30 pt mid push animation (the taps run of the same suite noted it at x 152 pt, its place), so the pixels were read beside the title. A harness timing problem of `Area` in `examples/ouo-ios`, not the queue.
- `lychee --offline` with the AGENTS.md flags: clean.

## What the next session must know

- The shared checkout `/Users/ziadhassanin/Desktop/personal/ouo` was mid-merge (conflict markers in its workspace `package.json` files) during this run, and npm walks up into it from any worktree below and fails with "call config.load() before reading values". `ouo-env up` was run with an `npm` shim on `PATH` that adds `--prefix "$(pwd)"`, which stops the walk.
- API removed in `OuoReplayCore` (0.x): `DiskQueue.Config.maxAge` and `ChunkUploader.Config.maxAge`, `ChunkSpool.maxAge`. No caller in the repo passed them.

## Review (ADR-0013, PR #137)

Round 1, `Review: changes needed`, all answered:

1. Stale 24 h text: `ChunkUploader` doc comments, `project/kb/mobile-delivery.md`, `project/kb/ios-native-sdk.md`, the N55 line: fixed.
2. The age was the only escape from N55's head-of-line block (a request answered 5xx every time): now the bound is, so on a quiet app 500 batches or 5 MB (OTLP), 10 MB (replay). Written in both specs, the kb and N55, which says this makes it more pressing. Kept bounds only: a wall-clock age as the escape is the bug, and the real fix is N55's narrower retry set.
3. `put` lists the folder once (stamp and bound from the same listing) instead of twice.
4. The doc comment says the stamp alone orders the names and the counter stays for the files already on devices.
5. "Within a folder" in the spec and the doc comment (a released held chunk keeps its name).
6. `HeldSession.firstAt` / `lastAt` (`firstChunkAt` / `lastChunkAt`) are the stamps: doc comment and `mobile-replay.md` say they can lie ahead of a clock moved back.
