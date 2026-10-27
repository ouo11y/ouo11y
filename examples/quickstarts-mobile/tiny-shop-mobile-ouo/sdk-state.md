# The state of the ouo mobile SDK (2026-10-28)

The question: after the mobile quickstarts, where does `@ouo11y/react-native` (with its iOS half,
`sdk/ios`) stand next to the Sentry path, where the same Tiny Shop Mobile app keeps
`@sentry/react-native` and the ouo collector's Sentry bridge takes its traffic (quickstarts M1 to
M4 in [the index](../index.md))?

Measured with `@ouo11y/react-native` **0.2.1 from npm** in this quickstart, on the iOS 27.0
simulator (iPhone 18 Pro, Xcode 27.0), Expo SDK 57 / React Native 0.86.3, against collector 0.4.0,
rum-api 0.5.0, grafana 0.5.0, with real XCUITest taps, Debug and Release builds. Device numbers are
not re-measured here: they come from the N22 iPhone run and the B3 benchmark
([docs/benchmarks.md](../../../docs/benchmarks.md),
[2026-10-23 simulator report](../../../project/reports/benchmarks/2026-10-23-ouo-0.2.0-vs-sentry-8.32.0-sim/report.html)).
Sentry-path cells cite where the bridge was last verified; M1 to M4 re-verify them this week.

**works**: does the job in this app as a team would need it. **partial**: works with a gap a
team would hit. **missing**: not there.

## Feature by feature

| Feature | ouo SDK 0.2.1 | Sentry path (bridge) | How it was verified | Open |
|---|---|---|---|---|
| **Install** | **works**, two commands, no config plugin: `npx expo install @ouo11y/react-native @react-native-async-storage/async-storage` and `initRUM` in one file; the iOS module autolinks. Needs a development build (Expo Go: JS telemetry only). The SDK README misleads in three places: `npm install` (gives async-storage 3.x, Expo 57 wants 2.2.0), the Expo snippet passes `Device.modelId` (wins over the SDK's own reading, so the simulator reports `arm64`), and monorepo-only steps (Metro config, `npm run build` before `pod install`) read as if they applied | works: `@sentry/react-native` + its Expo plugin (`disableAutoUpload: true` so the build never calls sentry.io), DSN pointed at the bridge, `propagateTraceparent: true` for backend traces (not the default) | this run, from an empty folder (the guide) and from a clean copy of `result/` (`npm ci`) | Found 1, 2, 3 (summary) |
| **Sessions** (healthy / errored / crashed, rotation after 30 s in background, `previous_id`) | **works** | works (Sentry sessions; Sentry ends a session when the app goes to the background, ouo 30 s later: durations differ) | this run: sessions `errored` (failed request + handled error), `crashed` (JS fatal, native crash, `crash_count 1`), `healthy`; rotation with `session.previous_id` | — |
| **JS errors** (handled, unhandled, fatal, rejections) | **works**: `captureError` → errored; uncaught → fatal, `session.end` reason `crash`; one error = one record (Q1 fixed) | works (A1–A3, mechanisms mapped; `captureMessage` no longer counts as an error) | this run, Debug and Release | Q1 web part only |
| **Native crash (iOS)** | **works**: signal + `NSException` handlers, report on disk, sent on the next launch, session ended at the crash time. Needs a local native module to trigger one on purpose (no `nativeCrash()` helper, Sentry has one). A crash in the first second loses the session start (N52) | works (A7: frames and debug images kept) | this run: `SIGSEGV` from `modules/tiny-crash`, Debug and Release; N22 on the iPhone (2026-10-23) | N52 |
| **Traces, app to backend** | **works**: a span per `fetch`/XHR with `traceparent` + `baggage`; one trace from the tap's `place order` span to the API's `charge card`, no orphan parent | partial: only with `propagateTraceparent: true`, and only requests inside a Sentry transaction get a real parent (N24) | this run: Tempo trace, 9 spans, one trace id | — |
| **`session.id` on backend spans** | **works** (baggage `session.id`, `user.id` + `BaggageSpanProcessor`) | missing: Sentry's baggage has no session id; backend logs reach a bridged session only through trace ids | this run: `session.id` on all 9 spans | — |
| **Custom spans** | **works**: `rum.withSpan`, `rum.startSpan({ parent })`. No async context in Hermes: after an `await` the parent must be passed by hand | works (Sentry spans → OTel spans) | this run: `save receipt` child of `place order` after the `await` | — |
| **Logs** | **works**: `rum.log.*` → Loki `log` records with severity and trace id, readable body | works (`Sentry.logger.*` → the same `log` record) | this run: `checkout started with 3 items`, `order … placed` in Loki and rum-api `/logs` | — |
| **Vitals** (cold/warm start, TTID, slow/frozen frames, stalls) | **works** on iOS with the native module (`ouo.app.start`, `ouo.screen.display`, `app.jank`, `ouo.stall`); nothing without it (Expo Go, Android) | works (A4: transaction `measurements` in the same format) | this run: cold start 1.95–2.2 s Release on a busy host (simulator-only), TTID per screen, jank per screen | Android |
| **Taps and timeline** | **partial**: `ui.tap` named by `testID` / accessibility label (never the text), `navigation`, `http.request`, `app.lifecycle`. Taps outside React Native's responder system are missing: 8 of 20 taps in this run (the native-stack header's Back button) | works for what Sentry's touch breadcrumbs see (also JS-side); from error breadcrumbs too (A11) | this run: 12 `ui.tap` of 20 real taps; replay recorded 40 touches | new, low (summary) |
| **Readable Loki lines** | **partial**: `exception`, `navigation`, `session.start`/`end` have only the event name as body; vitals an empty body (by the vitals spec). The quickstart rule "a Loki line says what happened" is not met | not compared here (M1 checks the bridge's) | this run, Loki | new (summary) |
| **Replay: capture and masking** | **partial, privacy bug**: JPEG frames (on change, at most 1/s, plus one per touch), taps drawn, masking on by default. **A frame captured at a touch can show a text input unmasked** (`maskInputs: true`, `maskText: false`): typed `SECRET42` readable on the Back-tap frame, masked on the timer frames around it. Replay works in Debug and Release builds | works: Sentry's H.264 video segments (`replay_video`), its own masking | this run, Debug and Release, frames read back from rum-api | new, **P0** (summary) |
| **Replay: cost** | **partial**: on the wire **250 KB/min** of replay in this run (gzip chunks, 57 frames in 109 s, ~8 KB a frame; whole app 337 KB/min out, simulator, labels unmasked). B3 simulator at defaults: ouo 416 KB/min vs Sentry 135 KB/min; at matched quality 649 vs 379 (N50). Main thread per capture on the iPhone: ouo 44–45 ms vs Sentry 22 ms (N51). JPEG frames cost more bytes than Sentry's 5 s H.264 segments for the same pixels; video costs encoder CPU instead | works, cheaper on the wire and on the main thread | this run (`nettop` on the app process + rum-api chunk bytes); B3 2026-10-23 (simulator, N = 10); N22 2026-10-23 (iPhone) | N50, N51, B3 rerun |
| **Offline** | **missing**: OTLP retries in memory only; a run without network is lost (spans, logs, replay) | works: sentry-cocoa keeps up to 30 envelopes on disk (535 KB in B3) and sends them next launch | B3 offline cell 2026-10-23 (ouo 0 KB on disk) | N49 |
| **Compression** | **partial**: replay chunks gzip (≈3× smaller); OTLP JSON uncompressed (B3: wire = decoded, 67 KB per run at T2) | works: envelopes gzip | B3 2026-10-23; this run's split (≈85 KB/min of OTLP + API) | N48 (the RN gzip item; the id is used twice) |
| **Sampling** | works in the SDK (not exercised here): `session.sampleRate`, `replay.sampleRate`, `replay.onErrorSampleRate`, deterministic per session id, same rule as rum-api's cap. On-error replay starts at the error (no buffer before it, Sentry keeps one) | works: Sentry's rates, on-error replay with a buffer | SDK unit tests (8b, 2026-10-23); not run here | — |
| **Android** | **missing**: the JS telemetry has no iOS dependency but was never run on Android; the Android module is a no-op (no replay, native crash, app start, frames) | untested end to end (B6: no Android toolchain on this Mac) | — | Phase 10, B6 |
| **Expo / bare React Native** | partial: Expo dev builds work (this run). Bare apps need `expo-modules-core` (`npx install-expo-modules`) for the native half; without it JS telemetry only. Expo Go: JS only | works in both | this run (Expo); bare: README only, not run | — |
| **Source maps (JS)** | **missing** for React Native: Release stacks are `app:///main.jsbundle:87141:26`, and React Native's own frames are tagged `[in app]` (one bundle). rum-api's source-map store reads Hermes maps, but the SDK sends no debug ids | missing in ouo too: the bridge does not copy Sentry's `debug_meta` source-map images (N41) | this run (Release exceptions in Loki) | N41, A10 RN part |
| **Native symbolication** | partial: addresses + binary images with UUIDs in the report; symbolicate by hand with `atos` and the dSYM | partial: same data (A7), same manual step | this run (stack in Loki) | unscheduled (checklist 7) |
| **Identity and metadata** | works: anonymous persisted `user.id`, `setUser`, release, environment, OS, device (`ouo.device.simulator` on the simulator). `ouo.sdk.version` says `0.2.0` in 0.2.1; a fatal before `rum.ready` carries a temporary `user.id` | works | this run | new, low (summary) |
| **Running next to Sentry** | works: `forwardSentryErrors`, rejection hand-off, both crash handlers chained, one `traceparent` | — | G6 (2026-10-23), not run here (M5 has no Sentry) | N7, N9 |

## Verdict

**What a team could ship today with the ouo SDK.** An iOS app built with Expo (a development or
store build) that wants sessions with health, JS and native crashes, errors with stacks, one trace
from a tap to its backend with the session id on every backend span, logs, app start and screen
timings, and taps on a timeline, on users with a decent network. That part is solid on the
simulator and the crash flows passed on a real iPhone (N22). The session-to-backend link
(`session.id` in baggage) is something the Sentry path cannot give.

Replay is not shippable as is: the input-masking leak on touch frames is a privacy bug, and on a
real phone the capture still holds the main thread twice as long as Sentry's (N51) and sends about
twice the bytes (N50). A team that needs replay today should keep Sentry's.

**What blocks path 1 (replacing Sentry).**

1. The replay masking leak (new, privacy).
2. No offline buffer (N49): mobile users lose connectivity; Sentry keeps their data, ouo drops it.
3. No Android (Phase 10); the founder's prospects add Android later.
4. Replay cost on the device: main thread (N51), bytes (N50).
5. No React Native source maps (N41): Release stacks are bundle offsets.
6. A crash in the first second loses the session start (N52); OTLP not gzipped (N48).

**The order I would close them in.**

1. **Masking leak.** Small and urgent: take the view tree and the pixels from the same committed
   frame (or skip touch-triggered captures while a transition or the keyboard animates), and add a
   test that types into a field and taps Back.
2. **Offline buffer (N49) with gzip OTLP (N48).** Both live in the exporter; persisting gzip
   bodies makes the buffer smaller.
3. **N52**, the early crash: carry `session.start` in the crash report.
4. **React Native source maps (N41):** debug ids from the SDK, the store already reads Hermes maps.
5. **Replay cost (N51 then N50)**, on the iPhone, within the phone budget: the renderer first,
   then frame deltas or video.
6. **Android (Phase 10)**: last, per the founder's focus order; the JS half should mostly work,
   the native half (crash, vitals, replay) is new work.
7. Polish: readable Loki bodies, the SDK README fixes, `ouo.sdk.version`, a `nativeCrash()` test
   helper, taps from native header buttons.
