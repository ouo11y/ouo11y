# 2026-11-15: sdk/ios tests reliable in parallel again

PR #198 moved CI to GitHub's 3-core `macos-latest` and ran the iOS suite `--no-parallel` because timing races failed there. This run fixes the races and puts CI back on the parallel run.

## What was done

Test code only; no SDK source changed. Each race and its fix is in [parallel-test-races.md](../../../kb/client-sdk-ios/testing/parallel-test-races.md).

- `CoreTests.APreviousCrashIsSentWithThePersistedContext`: the never-closed first Core's 1 s batch (its own `session.start`) lands in the outbox both Cores share and the second Core sends it; the test picked the first `session.start` by time. It now looks up the new run's start by `c2.sessionId`. The `session.previous_id` assertion is unchanged.
- `RobustnessTests.ContextWritesDoNotBlockTheCaller`: the calls ran on `DispatchQueue.global()`, which can wait seconds for a worker on a busy machine. They now run on their own `Thread`; the deadlock bound is 30 s (the gate stays shut until the calls return, so the check is the same).
- `ReplayDeliveryTests.AnEvictedChunkMarksItsStreamPartialAndStartsANewSegment`: a loss reported before one of the loop's looks was already answered by that look's keyframe. The test now waits until every eviction is reported, adds one chunk that evicts, waits for that report, then looks.
- `ReplayDeliveryTests` response-table helper (`AnyOtherStatusIsDeletedAndCounted` failed once in 30 runs): it slept 30 ms for the `onLoss` callbacks; it now waits for one callback per chunk counted lost.
- `.github/workflows/ci.yml` and `release-ios.yml`: `sh sdk/ios/test.sh` without `--no-parallel`.
- kb: new area `project/kb/client-sdk-ios/` with the races and the rules that follow.

## Verified and how

- Before the fixes, the first local parallel run failed `ReplayDeliveryTests.swift:230` (the keyframe race).
- After the first three fixes, 30 parallel runs of `sh sdk/ios/test.sh --skip-build`: 1 failure, the fourth race above.
- After all four, 30 more parallel runs: 30 passed (150 test runs across the 5 targets, 0 failures).
- Three loops of 10 started at once on the rebased tree: 30 passed, but SwiftPM's `.build` lock made them mostly take turns, so this is not a load test. The 3-core CI run is the real check.
- CI on `macos-latest` in parallel: on the PR.

## What is left

- Other two-Core tests (`ATerminationReport`, `ThePreviousCrashUsesTheHandlersContext`) share a folder with a live first Core too. They select records the first Core never emits, so they are safe; did not change them.
