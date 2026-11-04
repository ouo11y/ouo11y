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
- **The SDK never stores the consent.** The app's consent manager is the record; the app passes its decision at every load. Cross-tab consent sync is the app's too.

## Consequences

- The browser core grows by 0.8 KB gzip (budget 44.2 to 45.0 KB).
- A grant that follows a revocation waits for the old instance to stop and the wipe to finish, so the new ids are not wiped with the old.
- Known gaps, written down rather than hidden: on React Native the native recorder's stop flushes the open chunk (recorded under consent) and the native crash handlers stay installed for the rest of the process after a revocation, because neither has a native "discard" call yet. The native iOS SDK (`sdk/ios`) has no consent API yet. Both are follow-ups (project/kb/consent.md).
- `docs/specs/session-lifecycle.md` gains the rule "no session before consent" and its test cases.
