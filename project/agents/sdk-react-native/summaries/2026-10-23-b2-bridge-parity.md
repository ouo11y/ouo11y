# 2026-10-23 batch 2: RN SDK bridge parity (G2 to G6, Q1)

Session `b2-rn-sdk-gaps`, branch `claude/b2-rn-sdk-gaps-5a7301` (on origin/main 3ca7bea, #43). Paths:
`sdk/react-native` JS/TS (src, test, README, CHANGELOG), this folder, kb, checklist. Native
(`sdk/react-native/ios`), `examples/`, the plugin, rum-api and the collector were not touched.

## What was done

- **G6** `errors.forwardSentryErrors: Sentry.getClient()` (opt-in): the client's `beforeSendEvent`
  hook turns every error event Sentry sends into an `exception` (`ouo.exception.kind = sentry`,
  `ouo.sentry.event_id`, `ouo.sentry.mechanism`, handled from Sentry's mechanism). Skipped: Error
  objects ouo reported already (identity via `hint.originalException`), mechanisms `onerror` /
  `onunhandledrejection`, `captureMessage` (synthetic, level below error), transactions.
- **G5** device model from expo-device's native constants (`globalThis.expo.modules.ExpoDevice`,
  no import, no app code; `ouo.device.simulator` on the simulator, where `modelId` is `arm64`).
  Trace id on errors (`ouo.exception.trace_link`: `span`, `active_span`, `failed_request`).
  Stack normalisation (`src/errors/stack.ts`): `app:///<bundle>:l:c`, bridge frame form,
  `[in app]`.
- **G4** `ui.tap` from `RUMProvider` touches (fiber walk like Sentry's TouchEventBoundary, context
  providers skipped, text never read) and `rum.trackTap`; `app.lifecycle` (`foreground`,
  `inactive`, `background`); `http.request` (1 to 499) with the span's trace id. Same names,
  attributes and bodies as the bridge (spec 9a). `timeline` option to switch each off.
- **G3** `rum.startSpan`, `rum.withSpan` (synchronous context manager `src/telemetry/context.ts`),
  `rum.log(level, …)` / `rum.log.info(…)` as `log` records like the bridge's `Sentry.logger.*`.
- **G2** per `docs/specs/mobile-vitals.md`: `ouo.stall` (50 ms JS loop) and `ouo.screen.display`
  (TTID from the navigation to the second animation frame) measured in JS; `ouo.app.start` and
  `app.jank` read the Expo module's `getAppStartInfo()` / `getFrameStats()` when they exist
  (they do not yet; nothing is emitted without them). Windows: `app_start`, then per screen.
- **Q1** one fatal is one exception (`src/errors/dedupe.ts`: identity across hooks; for 5 s after a
  fatal, same-message fatals and console echoes are dropped); dev builds no longer trace Metro's
  `/symbolicate` and `/__sentry/…` (they were records after the crashed session's `session.end`).
  "Resource attributes in the custom-event timeline" is rum-api's, not touched.
- README (API, errors, Next to Sentry, Spans and logs, Timeline, Vitals, Device, Events),
  CHANGELOG `## Unreleased`, kb `rn-sdk-bridge-parity.md` (new), update line in
  `sentry-bridge-vs-ouo-sdk.md`. Version: release-please bumps 0.2.0 -> 0.3.0 from the `feat`
  PR title; `package.json` is not edited by hand. No dependency added.

## Verified, and how

- `npm run -w sdk/react-native typecheck`, `test` (119 tests, 16 files; 88 before), `build`. New:
  `test/parity.test.ts` (end to end through `initRUM`: G3, G4, G5, G6, Q1), `stack`, `taps`,
  `vitals`, `resource`. A mutation check (disabling the fatal-echo rule) fails the Q1 test.
- Simulator `ouo-b2-rn` (iPhone 18 Pro, iOS 27, own device), env `b2-rn-sdk-gaps`: a scratch copy
  of `examples/ouo-mobile` in the session scratchpad (example untouched) with
  `@sentry/react-native` 8.30.0 (real `Sentry.init`, DSN to a closed port), no `device` option,
  a scripted walk, and real UIKit taps from a throwaway XCUITest. Results:
  - rum-api / plugin session a9dafad5: `http.request` x11 with trace and span ids, `log` x3
    (INFO, WARN, trace id of `parity.checkout`), `ouo.stall` (350-384 ms), `ouo.screen.display`
    per screen, `app.lifecycle` inactive / background / foreground, `exception` kind `captured`
    with `trace_link failed_request`, `exception` kind `sentry` with Sentry's event id,
    `captureMessage` not forwarded; device "Apple Simulator iOS", `ouo.device.simulator true`.
  - Tempo trace 48a887c7…: `parity.checkout` root -> `HTTP GET` child -> demo-backend spans.
  - Real taps: `ui.tap` targets `product-p-1001`, `btn-Chaos`, `btn-Parity: log`, path e.g.
    `Text > btn-Chaos > View > DebugContainer > Animated(Anonymous) > Screen`.
  - Crash flow (dev): session b6d80d68 `crashed`, `crash_count 1`, `error_count 0`, timeline ends
    with `session.end` (before the fix: 4 `/symbolicate` requests after it, and QA's second
    exception).
  - Loki through Grafana's datasource proxy: every new event name present.
- The simulator panel was never granted to this session; taps went through XCUITest instead.

## Left / next agent must know

- **Native hooks (next iOS session)**: `getAppStartInfo()` and `getFrameStats()` in the OuoReplay
  module, details in the kb entry and the shared note `b2-rn-sdk-gaps.md`. Until then no
  `ouo.app.start`, `app.jank` or first-screen TTID.
- rum-api lists vitals as log lines in `/logs` and the plugin shows them as generic events: spec
  sections 7 and 8 (rum-api `timelineOnly`, `/vitals`, plugin display) are other sessions' work.
- Observation, not fixed: a `terminated` session ends at its last persisted activity, so records
  without activity (lifecycle, a late TTID) can sort after its `session.end`. Pre-existing rule.
- Metro with a `file:` linked SDK can keep serving a stale `dist` after a rebuild: restart it with
  `--clear` (cost an hour of false "context filter does not work").
- Env `b2-rn-sdk-gaps` and simulator `ouo-b2-rn` torn down at the end of the run (see below).
