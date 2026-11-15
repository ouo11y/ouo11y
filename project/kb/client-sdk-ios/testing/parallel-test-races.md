# Parallel races in the sdk/ios tests

Swift Testing runs every test of a target at once. On GitHub's 3-core `macos-latest` that exposed races the founder's Mac rarely hit; CI ran the suite `--no-parallel` until they were fixed (2026-11-15).

| Test | Cause | Fix |
|---|---|---|
| `CoreTests.APreviousCrashIsSentWithThePersistedContext` | The first Core (the "crashed run") is never closed. Its exporter batches after 1 s of real time and writes its own `session.start` into `<dir>/otlp`, the outbox the second Core drains. The sink sorts by time, so `logs.first { session.start }` was the first run's, which has no `session.previous_id`. Sending a dead run's outbox is the product working. | Look up this run's `session.start` by `c2.sessionId`. |
| `RobustnessTests.ContextWritesDoNotBlockTheCaller` | The calls ran on `DispatchQueue.global()`, whose width is the core count. With other tests blocking GCD workers, the block could wait more than the 2 s bound to start. Nothing in `Core` blocked. | A `Thread` of its own; the bound is 30 s, because the gate stays shut until the calls return and the bound only ends a deadlock. |
| `ReplayDeliveryTests.AnEvictedChunkMarksItsStreamPartialAndStartsANewSegment` | `DiskQueue.put` evicts before it returns, but `onLoss` reaches the stream later on the delivery's queue. A loss reported before one of the loop's looks was already answered by that look's keyframe, so the final look needed none. | Count reported losses; wait until reported == `stats.evicted`, add one more chunk (it evicts), wait again, then look. No look runs between the last eviction and its report. |
| `ReplayDeliveryTests.AnyOtherStatusIsDeletedAndCounted` (found while fixing the others, 1 run in 30) | The response-table helper slept 30 ms for the `onLoss` callbacks; under load they came later. | Wait until one callback per chunk counted lost has run; the 30 ms stays only to give a callback that must not come (an end record's) its chance, which cannot fail a correct run. |

## Rules that follow

- Two Cores on one folder share `session.json`, `context.json` and the outbox. Give each test Core its own `tempDir()` unless the test is about the next launch; then look records up by session id, never by "first of its name".
- Wait on the condition (`eventually`, a semaphore the code signals), not a sleep. A bound on a wait only ends a deadlock: make it generous (30 s).
- Do not run the code under test on `DispatchQueue.global()` when the test measures that it does not block: use a `Thread`.
- Asynchronous callbacks (`onLoss`, `Sink` completions, `Exporter` timers) can land between any two lines of the test. Before asserting on what a callback changes, wait until every callback that was started has run (count them).

Reproduce: `cd sdk/ios && sh test.sh --skip-build` in a loop after one build (`swift build --build-tests`).
