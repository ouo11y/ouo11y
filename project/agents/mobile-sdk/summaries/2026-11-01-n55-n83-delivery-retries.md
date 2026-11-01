# 2026-11-01 N55 and N83: mobile delivery retries only what can succeed, and keeps no age

Branch `claude/n55-delivery-retries`, checklist N55 and N83. Env `n55-delivery-retries`, simulator `ouo-n55-native` (3C751982-1F7B-4027-B215-F5A0CCC67E4F, iPhone 18 Pro, iOS 27), created and deleted by this run.

## What was done

- **C11 changed** (`docs/specs/mobile-sdk.md`, ADR-0015's rule: the spec and a matching check in the same PR). Retry network errors and OTLP/HTTP's retryable answers, 429, 502, 503 and 504, with backoff and `Retry-After`. Any other answer is final: 2xx is sent, the rest (a 4xx, 408 included, 500, 501, 505, a 3xx) is dropped and counted as rejected. Before, both platforms retried 408 and every 5xx, so a request the collector answered 500 to every time blocked the FIFO queue behind it until the bound evicted it. `mobile-replay.md` "Delivery" follows.
- **New check C11.3** in both suites: the collector answers the first OTLP request 500 every time it is sent and the second 503 once; the 500 must be sent once, the 503 again until accepted, and a later record must reach rum-api in the same run. The React Native suite's stand-in injects the faults in its `fetch` wrapper (`OUO_E2E_REJECT=1`, a new `reject` device); the native suite's `proxy.mjs` after `POST /__reject`, with a new `reject` action in `examples/ouo-ios`. Both log a hash of each OTLP request's uncompressed body so a resend is told apart from a new request.
- **iOS** (`sdk/ios/Sources/OuoReplayCore/DiskQueue.swift`): `DiskQueue.retryable(_:)` holds the set; `finish` uses it. That covers the OTLP outbox (`OuoSDK.Exporter`) and the replay chunk queue (`ChunkUploader`), on the native SDK and in the React Native Expo module (which vendors `OuoReplayCore`).
- **React Native** (`sdk/react-native/src/transport/outbox.ts`): `retryable` narrowed the same way. **N83**: `maxAgeMs`, `DEFAULT_OUTBOX_MAX_AGE_MS` and the item's `at` are gone; the outbox has the bounds only (5 MB, 500 requests). Its order was already the index array's, never the clock's; an index written by an older version (items with `at`) is read as is.
- Docs: both READMEs, `types.ts` (stale "24 hours" on `keepAtNextLaunch` and `OfflineOptions` too), the stand-in's chunk rule, the native suite README, kb `mobile-delivery.md`, `ios-native-sdk.md`, `mobile-conformance.md`.
- **Android** (W9 part 1 merged while this PR was open): `sdk/android` `DiskQueue.kt` had the old rule; it gets `DiskQueue.retryable` and the same narrowing, with `DeliveryAndPacingTest.aFiveHundredIsFinalAndDoesNotBlock` (`./gradlew :replay-core:test`, 18 tests pass). The Android suite does not run C11.3 yet, so the matrix's React Native Android C11 cell is L1 until checklist **N89**.
- New checklist item **N88** (N85 to N87 were taken by W9 the same day): the browser SDK still retries 408 and every 5xx.

## Why the narrow set is safe with this backend

The collector's OTLP receiver answers 503 for a non-permanent pipeline error (with `Retry-After` only when the error carries `RetryInfo`), 500 for a permanent one and 400 for a body it cannot decode; the `ouoreplay` receiver answers 429 or 503 (with `Retry-After`) for retryable consumer errors and 500 only for permanent ones (`statusFromConsumerError`). A proxy in front (Traefik in `ouo-env`, a load balancer) answers 502 to 504 when the collector is down. So a 500 from this stack never gets better on a retry. What is left of head-of-line blocking: a request answered 429 or 502 to 504 every time still waits, retried, until the bound evicts it.

## Verified, and how

- `sdk/ios/test.sh` (Xcode): all suites pass (34 + 77 + 98 + 24 tests). New: `DiskQueueTests.RetriesOnlyOTLPRetryableAnswers`, `AFiveHundredEveryTimeDoesNotBlockTheQueue` (a transport that answers 500 to one tag every time: it is sent once, `rejected` 1, the two behind it sent). Changed: `ChunkUploaderTests.RejectedChunksAreDroppedAndTheQueueContinues` (400, 408, 304 and 500 final, 503 retried), `SendsInOrderAndRetriesWithBackoff` (502 instead of 500).
- `sdk/react-native`: `npm run typecheck` clean, `vitest run` 197 tests pass. New in `test/delivery.test.ts`: the retryable set, a 500 every time tried once and not blocking, 502/503/504 retried with backoff, N83 a clock moved two days forward drops nothing, moved back keeps `put` order (the bound drops the oldest), an old index with `at` is sent whatever its age. Removed: the 24 h test.
- React Native conformance suite against env `n55-delivery-retries`: 19 of 19 required checks pass (C11.3 detail: the 500 body sent 1 time, the 503 body `[503, 200]`, `/Products` after them in rum-api). Negative control: with the bundle's `retryable` patched back to the old rule, the `reject` launch sent the 500 body four times in 3 s and nothing behind it.
- Native iOS conformance suite (`tests/e2e/mobile-native/run.sh`) against the same env on the simulator above: 19 of 19 checks pass, every capability L2 (C8.2 pixels all 0.004). C11.3 on the wire: `logs` 500 (injected), `logs` 503 (injected), the same body again 200, the next `logs` 200; `reject-step` in rum-api. About 7 minutes with the builds.
- `lychee --offline` with the AGENTS.md flags: clean.

## What the next session must know

- The shared checkout `/Users/ziadhassanin/Desktop/personal/ouo` is still mid-merge; `ouo-env up` needs an `npm` shim on `PATH` that adds `--prefix <worktree>` (as in N77). `npm_config_prefix` in the environment does not stop npm's walk up; the flag does.
- The scratchpad folder is shared by sibling agents of one parent session: name files with the task (`n55-…`), another agent's output landed in a file named `native-run.log`.
- `OuoReplayCore`: `DiskQueue.retryable(_:)` is new (internal; tests reach it with `@testable`). The React Native `Outbox` no longer takes `maxAgeMs` (internal).
