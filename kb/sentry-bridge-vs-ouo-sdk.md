# What the Sentry bridge shows vs the ouo React Native SDK (measured 2026-10-17)

The same journey with real simulator taps in `examples/sentry-mobile` parallel mode (`OUO_SDK=1`):
`@sentry/react-native` 8.30.0 through the ouosentry bridge, and `@ouo/react-native` 0.2.0 in the same app.
Stack: released 0.2.0 images, isolated compose project `ouo-cmp`. Three runs:
1. ouo replay on, ouo navigation not wired.
2. ouo replay off, navigation wired.
3. ouo replay on, navigation wired.

Report with every number and the gap register: `agents/sentry-demo/reports/bridge-vs-sdk.html`. Tracker:
`tracker/roadmap.md`, "Bridge parity gaps".

## Answer in one paragraph

The bridge already gives a richer session than the ouo SDK on this journey: 93 timeline events against 9. It has:
- taps with component names
- every request (from replay breadcrumbs)
- console output and Sentry logs
- app lifecycle
- native crashes
- custom spans and app-start spans

What it loses is data Sentry does send:
- vitals: `app_start_cold` / `warm`, `time_to_initial_display`, frames, stalls
- error context: locale, network, memory, current screen, tags, breadcrumbs
- native crash addresses and debug images
- back navigation (the `navigation` breadcrumb has it)
- release, environment and device fields on log and session-only records
- the whole breadcrumb timeline for sessions without a replay

It also has one counting bug: `captureMessage(info)` becomes an exception, so the bridge reports 3 errors where
Sentry's own counter says 2. Only the ouo SDK can give a span for every request and the session id on backend
spans and logs. The ouo SDK itself misses:
- native crashes (the session shows "terminated, healthy")
- `Sentry.captureException` errors
- vitals
- custom spans
- logs
- tap targets

## Things that are easy to get wrong

- **Parallel mode breaks the bridge's backend traces.** ouo, initialised last, sets `traceparent`, so backend
  spans join only ouo's traces (bridge: 0 of 15 traces with backend spans). Demo the bridge with Sentry alone.
- **Sentry RN's `propagateTraceparent` defaults to false.** Without it the OTel backend does not join Sentry
  traces at all. Telling a client "DSN change only" is true for sessions, errors and replay, but not for backend
  correlation: that needs one line in `Sentry.init` (an app release).
- **Sentry's baggage has no session id.** Backend logs reach a bridged session only through trace ids
  (rum-api `/logs` trace join), so only for requests inside a sampled Sentry transaction. Sentry makes
  `http.client` spans only inside an active transaction.
- **Breadcrumbs only come from replay recordings** (spec section 9a). Every error event also carries the last 100
  breadcrumbs (`touch`, `fetch`, `xhr`, `navigation`, `ui.lifecycle`, `console`, app categories), which the
  bridge ignores today. With `replaysSessionSampleRate: 0.1` in production, 9 sessions in 10 get no taps or
  successful requests.
- **The RN SDK drops back-navigation transactions** that have no spans (Cart to Home), but sends a
  `navigation` breadcrumb `{from, to}`.
- **`captureMessage` events carry `exception.values[0].mechanism.synthetic: true`** with `level: info`. Sentry
  does not count them in the session's `errors`.
- **Native crash frames have only `instruction_addr`, `image_addr` and `package`.** Without the `debug_meta`
  images (with UUIDs) the stack can never be symbolicated. The bridge prints `at ? (path)` today.
- **Session duration semantics differ.** Sentry ends a session at the moment the app went to the background
  (sent on return); the ouo SDK ends it 30 s later. The same use reads 36.6 s in one and 67.3 s in the other.
- **Sentry log entries carry `sentry.release`, `sentry.environment`, `os.*` and `device.model` as attributes.** The
  bridge drops them as "on the resource", but the log resource never gets them.
- **The demo's parallel mode did not wire `navigationStateListener` or `RUMProvider`** before 2026-10-17. Earlier
  parallel runs had no ouo screens at all.
- **One run (the first launch after a fresh install on a new simulator) had a Sentry replay that stopped after 41 s
  of 128 s, with 0 touches,** while the ouo replay ran. The same journey with the ouo replay on again (run 3) was
  complete (90 s, 28 touches), so it is not attributed to the ouo replay. Rerun before claiming either way.

## How to rerun

- `examples/sentry-mobile` build flags: `OUO_SDK=1`, `OUO_REPLAY=0|1`, `SENTRY_DSN`, `BACKEND_URL`,
  `OUO_OTLP_ENDPOINT`, `OUO_REPLAY_ENDPOINT`.
- Use your own simulator (`xcrun simctl create`) and your own DSN port, so parallel sessions do not collide.
- Tap points for the 402x874 Home screen are in the report's "Reproduce" section. The status line grows to two
  lines after the first action and shifts buttons by about 12 pt, which is still inside each 37 pt button.
- Waiting on the simulator: foreground `sleep` longer than a few seconds is blocked in this harness. Use an
  `until` loop on elapsed time.
