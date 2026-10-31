# 2026-10-31 Fix: the ingest-stub flake (`_uninstall` awaits the outbox drain)

Branch `claude/fix-ingest-stub-flake`, PR #124. Session-to-session fix of a CI flake in `sdk/react-native/test/ingest-stub.test.ts` ("the stub rejects a wrong token with 401", CI run 41146371544, PR #123). No env, no simulator, no new dependency.

## Cause

`afterEach` calls `_uninstall()`. Its provider shutdown exports what was recorded after the test's last `flush()`, which on a loaded machine is a vitals `ouo.stall` (`app_start`) log. The outbox persists it and starts sending it with the valid token, and `outbox.stop()` neither waited for nor cancelled that request. It reached the stub after the next test's `beforeEach` cleared `logged`, so the 401 test counted a 200. Shown with an instrumented copy of the test (every `Outbox.put` and the `afterEach` bounds logged) run 12 at a time: in the failing runs the put happened inside `_uninstall` and the 401 test logged `POST /v1/logs -> 200` with the valid credential.

## Fix

`_uninstall` awaits `outbox.drain()` for at most `UNINSTALL_DRAIN_TIMEOUT_MS` (2 s, `@internal`) before `outbox.stop()`. At least once (C11) holds: the batch is persisted before it is sent and stays for the next launch when the send does not finish. Uninstall cannot hang: offline, a drain stops at its first failure; a request that never answers is cut by the bound. The test's assertions are unchanged.

## Verified, and how

- New regression test in `test/ingest-stub.test.ts` (an event after `flush()`, then `_uninstall()`, the stub must already hold that `/v1/logs` request as a 200): fails every time without the fix (`expected [] to deeply equal [ 200 ]`), passes with it.
- New test in `test/delivery.test.ts`: with a `fetch` that never answers, `_uninstall` returns after about 2 s and the next launch sends the batch.
- The instrumented copy of the two original tests, 3 rounds of 12 in parallel: without the fix 2 late puts and 2 failed runs of 36; with it 6 late puts and 36 of 36 passed. The copy was not committed.
- `sdk/react-native`: `tsc --noEmit` clean, Vitest 21 files, 191 tests pass. `lychee --offline` clean.

## Left, and what the next agent must know

- Reviewer follow-up, not fixed here: a stopped outbox whose late send answers after a new `initRUM` on the same storage in the same process still writes its index (`forget` → `persistIndex`), which can overwrite the new outbox's saved index. Only tests and dev restarts init twice in one process; a fix would make `forget` write nothing once stopped, or give each outbox ownership of the key.
- macOS has no `timeout`: bound commands with `perl -e 'alarm 300; exec @ARGV' <cmd>`.
