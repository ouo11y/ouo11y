# Consent gate (ADR-0018, JUHI P2, 2026-11-04)

What was learnt building `consent: "pending"` / `setConsent` in `@ouo11y/browser` and `@ouo11y/react-native`.

## Design that made "nothing before consent" provable

- The gate (`src/consent.ts` in both SDKs) sits in front of an `install()` that holds all of the old `initRUM` body. Pending means `install` never ran, so there is no code path to storage, IndexedDB, BroadcastChannel, the native module or the network. Spying on each API in a test (Vitest) and in real browsers (`sdk/browser/e2e/consent.spec.ts`, an `addInitScript` probe wrapping `Storage.prototype`, `IDBFactory.prototype.open/deleteDatabase`, `Document.prototype.cookie`, `BroadcastChannel`, `sendBeacon`) shows zero calls. Adding flags inside each subsystem would have needed a proof per subsystem.
- Validation (`deriveIngestUrls`, `requireCredentials`) still runs at `initRUM`, so a misconfigured app still throws at its first run, consent or not.

## Non-obvious points

- **Queued calls are stamped at the grant, not when made.** A banner can stay unanswered for hours; Loki rejects lines older than its out-of-order window, and a session whose events predate its own `session.start` reads wrong on the timeline. Order is kept.
- **Revocation: halt before shutdown.** `shutdown()` flushes first and the providers' shutdown flushes again. `Delivery.halt()` (browser) and `Outbox.clear()` (RN) go first, so those flushes drop instead of sending or storing.
- **Wipe after the old instance stopped.** `SessionManager.stop()` persists the session; wiping first would let it write `ouo.session` back. A grant right after a revocation waits on the same promise chain, otherwise the wipe deletes the new instance's ids.
- **Only the SDK's own keys.** The demo app stores `ouo.demo.user_id`; a prefix wipe (`ouo.*`) deleted it. The browser removes `ouo.device`, `ouo.session`, `ouo.user`, `ouo.probe`; RN its fixed list plus the outbox's index-listed `ouo.outbox.<id>` keys (AsyncStorage has no key listing in the SDK's storage interface).
- **`indexedDB.deleteDatabase` while a connection is open** works here because `openDatabase` sets `db.onversionchange = () => db.close()` (other tabs too). A delete with a connection that never closes fires `blocked` and waits; the wipe gives up waiting after 3 s.
- **The OTel fetch instrumentation leaves its wrapper on `fetch` after `disable()`** (it only flips `_isEnabled`). After a revocation the wrapper is inert: no span, no `traceparent` (the propagator is disabled too). Tests assert the absence of `traceparent`, not `fetch` identity.
- **Browser replay consent is the recorder's pause**, applied before `recorder.start()` so rrweb is never imported. The gate keeps the app's own `replay.pause()` apart, so `resume()` cannot override missing consent. No change to `recorder.ts` (PR #152 rewrites that file).
- **RN replay consent is a fourth hold in the replay controller** (`allowed`, folded into `stopped()` with `userPaused`); without it `startNative` only records `pendingStart`, so the native recorder never starts. A `pause()` / `hideScreen()` made before the grant is applied before `replay.start()`.
- **RN `ready`**: the gate's `ready` resolves when the first granted instance's `ready` resolves (or at uninstall).
- **Demo verification gotcha**: the replay endpoint is derived (4318 → 4319) only when the OTLP endpoint uses port 4318. On an isolated stack with other ports set `VITE_OUO_REPLAY_ENDPOINT`, or chunks go to the OTLP port and fail CORS.
- **`?consent=pending` in ouo-web is read at page load only**: a full reload without it starts granted. A real app reads its CMP on every load.

- **rrweb emits after its stop.** Its throttled mousemove / scroll callbacks fire from a `setTimeout` after `stopFn()`; the event reached the chunker, whose `nextSeq()` force-persists `ouo.session`, after the wipe (Firefox flake, review round 1). The recorder now wraps `stopFn` to clear a `live` flag the emit checks, and `install()` hands the session manager a storage that is closed at shutdown (a plain "stopped" flag in `SessionManager.stop()` would break bfcache: `pagehide` calls `stop()` and the page can come back).
- **Cross-tab revocation** is detected by the `storage` event for `ouo.device` with `newValue === null` (only the wipe removes it; `localStorage.clear()` sends `key: null`). The other tab stops without wiping, otherwise its late wipe would remove the ids of a tab that re-granted meanwhile (and that removal would revoke that tab in turn). For the same reason a grant never wipes (round 2 found a pre-grant wipe cascading across tabs granted one after the other): instead the gate remembers when it revoked and `SessionManager({ notBefore })` resumes no persisted session that started before it, while joining one a re-granted tab started since.
- **RN `takePendingCrash()` twice is safe**: a second call returns nil unless a new `report.json` exists, so the wipe calls it at every revocation; at a refusal it also consumes the previous run's state (no termination reported later).

## Remainder (not in this PR)

- RN native: a `discard()` in `OuoReplayModule` (Swift and Kotlin) that drops the open chunk and the disk queue instead of flushing them at revocation, and the chunk a crash left open in an earlier run (today only `recoverPendingChunk`, which sends it); a way to stop the crash / hang handlers (signal handlers cannot be safely removed; at least clear the crash session so a crash after revocation is not reported at the next granted launch).
- Native iOS SDK (`sdk/ios`, `Ouo.start`): the same API (`consent: .pending`, `Ouo.setConsent(telemetry:replay:)`), gating `SessionManager` persistence, `OuoCrash.install`, `OuoReplay.start`, the exporter's disk queue; wipe of its files under Application Support. Not started: it is its own reviewable PR.
- Android native SDK (#151 in flight) likewise.
