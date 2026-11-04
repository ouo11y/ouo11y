# ADR-0018 Consent: no session before consent, replay consent apart

Status: proposed (2026-11-04, JUHI gap P2, web roadmap package WB7)

## Context

A public portal (JUHI's client PWA) may not store an identifier on the device or send telemetry before the user agrees (ePrivacy art. 5(3), GDPR art. 6/7). Until now `initRUM` wrote `ouo.device`, `ouo.session` and `ouo.user` to `localStorage`, opened the IndexedDB outbox `ouo-delivery` and the replay BroadcastChannel, and sent `session.start` at once; the React Native SDK read and wrote AsyncStorage, installed native crash handlers and started the native recorder. The only way to wait was not to call `initRUM`, which loses every call the app makes before the banner is answered and leaves revocation to the app.

## Decision

- **`initRUM({ consent: "pending" | "granted" })`, default `"granted"`.** Existing apps see no change.
- **Pending means nothing installed.** The SDK validates its options and returns a gate. It stores nothing (no `localStorage`, IndexedDB, cookie or AsyncStorage), opens no BroadcastChannel, calls nothing in the native module, sends nothing, installs no instrumentation and has no session (`session.id()` is `""`). The gate's only path to any of that is the install that the grant runs.
- **Calls before the grant wait in memory.** `setUser`, `clearUser`, `captureError`, `addEvent`, `setRoute` (browser), `log.*` and `trackNavigation` (React Native, the last one only) are queued, at most 100, oldest dropped. They run at the grant in order and are stamped then: an event hours old would fall behind Loki's out-of-order window, and the session starts at the grant. Activity, taps and spans before the grant are not recorded.
- **`setConsent({ telemetry, replay })` and `getConsent()`.** Granting `telemetry` starts a session and runs the queue. `replay` is a separate switch on the recorder: without it rrweb is never loaded (browser) and the native recorder never starts (React Native), whatever sampling and the app's `replay.resume()` say. `replay` without `telemetry` means nothing.
- **Revoking `telemetry` stops and wipes.** Export stops at once: the delivery layer and the outbox are halted before the shutdown, so what is still batched is dropped, not sent or stored. The SDK then removes its own storage keys (only its own: an app may use `ouo.` keys) and the IndexedDB outbox, closes its channels, and on React Native deletes the stored requests and the replay chunks the device holds. A later grant starts a new device id and session.
- **Other tabs stop with a revocation.** Only the wipe removes `ouo.device`; a running browser tab that sees that `storage` event halts and shuts down without writing anything back or wiping again. A grant after a revocation resumes no persisted session that started before the revocation (one another tab wrote back while it stopped); it joins a session a tab granted again since started, so tabs granted one after the other share one new session. No second wipe at a grant: it would remove the ids a tab granted again just wrote, and that removal reads as a revocation there. Granting is per tab (the app's consent manager tells each tab).
- **The SDK never stores the consent.** The app's consent manager is the record; the app passes its decision at every load.
- **Nothing is written after shutdown.** The browser SDK's storage is closed when it shuts down (after the session's final persist, or before it at a revocation), and the recorder drops what rrweb emits after its stop (throttled callbacks fire from timers).

## Consequences

- The browser core grows by 0.9 KB gzip (budget 44.2 to 45.2 KB, measured 45.1): the gate, the wipe, `Delivery.halt`, the cross-tab revocation and the late-write guards.
- A grant that follows a revocation waits for the old instance to stop and the wipe to finish, so the new ids are not wiped with the old.
- Known gaps, written down rather than hidden: on React Native the native recorder's stop flushes the open chunk (recorded under consent), a chunk a crash left open in an earlier run is not deleted, and the native crash handlers stay installed for the rest of the process after a revocation, because none has a native "discard" call yet. A revocation does drop the pending crash report and the held replay chunks. The native iOS SDK (`sdk/ios`) has no consent API yet. Both are follow-ups (project/kb/consent.md).
- `docs/specs/session-lifecycle.md` gains the rule "no session before consent" and its test cases.
