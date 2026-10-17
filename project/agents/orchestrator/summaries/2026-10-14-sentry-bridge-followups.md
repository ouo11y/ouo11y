# 2026-10-14 Sentry bridge follow-ups F1 to F4

## Asked

After S4, the founder asked for four more things:

- Sentry log items in Loki.
- Many traces that reach the backend, with "Open in Explore" working, using manual Sentry instrumentation where needed.
- Masking turned off in the demo SDK, so they can review the recordings themselves.
- More events on the timeline.

## Done

The work is on branch `claude/sentry-bridge-design` (PR #16).

- **Collector, `ouosentryreceiver`:**
  - `logs.go`: the `log` item becomes `log` session events. Console capture becomes `console` events. Attributes are typed. Entries wait for their session for up to `log_hold`, then expire on a 5 s ticker and are flushed at shutdown.
  - `breadcrumbs.go`: replay breadcrumbs become `http.request`, `console`, `app.lifecycle`, `ui.tap` and `breadcrumb` events.
  - `state.go`:
    - Session rule 4 resolves by trace id. A trace id can map to several sessions; the item's time decides.
    - Console lines are de-duplicated per session.
    - Device matching for replay segments is stricter.
  - `replay.go`: `masked` is taken from the recording's `options` event.
- **Demo app, `examples/sentry-mobile`:**
  - SDK options: `enableLogs`, `propagateTraceparent`, and masking off.
  - Four flows (`browse-catalog`, `search`, `checkout`, `checkout-fail`), each with manual spans and run through `startNewTrace`.
  - `Sentry.logger` calls.
  - `journey.sh --shop-rounds N`.
- **Plugin:** timeline titles for the new event names (`NAMED` in `Timeline.tsx`) and a test for them.
- **Verifier:** checks for logs, console de-duplication, breadcrumb requests, and app and backend joined in one trace. App spans are now checked separately from backend spans.
- **Docs:** spec sections 7a, 8 (rule 4 and the replay device check), 9 and 9a, 12 and 13; kb log and breadcrumb facts; demo README; a report section and screenshots; tracker F1 to F4.

## Verified, and how

Everything ran in the isolated stack `ouo-sb`. The stacks `ouo` and `ouo-8a` were not touched.

- **Live run, `journey.sh --shop-rounds 3`.** `verify-bridge.py` passed 26 of 26 checks:
  - 30/30 logger entries in Loki.
  - 51/51 log and console records have a session.
  - 21 console lines from 20 log entries plus 18 breadcrumbs.
  - 45/45 answered requests.
  - 29/29 transactions in Tempo.
  - 27/27 backend calls joined into one trace.
  - 25/25 mp4 segments byte-identical and decoded.
- **Forwarding:** `sentrytap compare` matched 79 of 79 requests byte-identical.
- **Grafana, by hand:** the timeline has 127 events, and clicking an event seeks the unmasked replay. "Open in Explore" shows the app span with the backend's `GET`, `inventory.lookup` and `db.query` spans under it.
- **Tests:**
  - Go: unit tests plus golden `shop` (79 real requests), with `-race`.
  - Mutation checks: the trace rule and the replay device fix each break a test when reverted.
  - Plugin: 101 Jest tests, typecheck and lint.

## Found on real traffic

- **Console output arrives twice.** `enableLogs` in RN 8.30 also captures `console.*`, and the same lines are replay breadcrumbs. Fixed by de-duplicating them.
- **Log entries carry `sentry.replay_id` on iOS RN.** This resolves 50 of the 51.
- **Flows share a trace id without `startNewTrace`.** Root spans reuse the scope's trace id until the next navigation. Fixed in the demo.
- **Wrong replay attached after a restart.** After a collector restart, held segments of a session the bridge never saw claimed the device's next session through the 1 min start tolerance, and the real replay was dropped (19 `replay_conflict`). Fixed: a segment may start at most 10 s before its session. A regression test covers it.

## Dependencies added

`@sentry/core` 10.76.0 is now a direct dependency of `examples/sentry-mobile`. It is the exact version `@sentry/react-native` 8.30.0 already pins and installs, and there is a single copy. It is needed because React Native does not re-export `startNewTrace`.

## Left

- Breadcrumb events exist only for sessions with a replay. sentry-cocoa leaves some breadcrumbs out of the recordings.
- Backend spans carry no `session.id`, because Sentry baggage has no session. The trace id links them instead.
- The open items from the build summary still stand: real sentry.io, Android, single replica.
