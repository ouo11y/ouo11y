# Funnels: what was non-obvious

Context: funnel reports (N46, ADR-0012, `docs/specs/funnels.md`), 2026-10-24.

- **Labels vs metadata in Loki.** `service_name`, `deployment_environment_name`, `ouo_platform`,
  `ouo_project_id` and `event_name` are stream labels (`deploy/compose/loki/config.yaml`,
  `otlp_config`), so funnel filters go in the selector; `service_version`, `session_id`,
  `user_id`, `url_path` and `ouo_event_custom` are structured metadata, filtered after a `|`.
- **`sum by (url_path)` works on structured metadata** in Loki 3: one instant query
  `sum by (url_path) (count_over_time({event_name="navigation"} [3600s]))` lists every path with
  its count. rum-api's `GET /v1/funnels/steps` uses it (`loki.Client.Counts`), much cheaper than
  pulling the events.
- **One query per step kind, not per step.** Pages: `{event_name="navigation"} | url_path=~"/|/products/.*"`
  (Loki regex filters are fully anchored); events: `{event_name=~"add_to_cart|order_paid"}`.
  Escape values with `regexp.QuoteMeta`, then `strconv.Quote`.
- **POST is a read.** `readAuth` only covered GET / DELETE / HEAD; `POST /v1/funnels/query` had
  to be added explicitly, or the read token would not protect it.
- **Custom events** from `rum.addEvent` carry `ouo.event.custom=true` (`ouo_event_custom` in
  Loki); OTel `logger.emit` records without `event.name` are not events and cannot be steps.
- **Grafana `Combobox` in jsdom** needs a canvas: mock `HTMLCanvasElement.prototype.getContext`
  with a `measureText` (see `plugins/ouo11y-rum-app/src/pages/Funnels.test.tsx`).
- **Generating sessions with a known answer**: Playwright, one browser context per session (fresh
  storage = new session and user), leave through `about:blank` so the SDK flushes at pagehide.
  Personas with a fixed depth give the exact per-step count to compare with
  (`examples/quickstarts/tiny-shop-funnels/result/generate-sessions/generate.mjs`); it matched
  rum-api exactly on three stacks.
- **npm inside some agent worktrees** fails with "Exit prior to config file resolving / call
  config.load() before reading values" for any command, `npm --version` included, while it works
  in the main checkout. Workaround: run from outside, `cd /tmp && npm --prefix <dir> ...`, and call
  `node_modules/.bin/{jest,tsc,eslint}` directly. `ouo-env up` runs `npm run build` in the checkout
  and hits it too: build the plugin first and write `git rev-parse HEAD` to
  `plugins/ouo11y-rum-app/dist/.ouo-env-built` so it skips the build. Cause not found.

## Funnels and user steps on mobile (W5, 2026-10-30)

Context: roadmap W5, spec C6 and C7 (`docs/specs/mobile-sdk.md`), quickstart
`examples/quickstarts-mobile/tiny-shop-mobile-funnels`.

- **Screens are page steps with no backend change.** The React Native SDK's `navigation` records
  carry `url.path` = `/` + the active route names, like the browser's paths, so rum-api's page
  steps match them as they are. `ouo.navigation.kind = screen` (the bridge's value) tells them
  apart from browser `load` / `push` / `replace` / `pop`; the plugin shows `Navigation (screen)`.
  Every product is one route, so `/Product` is one step for all products: an event carries the id.
- **Touches in React Native.** A plain `View`'s `onTouchStart`, `onTouchEnd` and `onTouchCancel`
  bubble from the touched host view without taking the responder, so `RUMProvider` sees every
  touch without changing what the app does. A scroll view that takes a touch over makes React
  Native send `touchcancel`: that is the end of a swipe. The event's `_targetInst` is the touched
  host fiber.
- **What a fiber walk can name.** `Pressable` passes `testID` and `role` / `accessibilityRole` down
  to its `View` and host view, so the same label appears on several fibers in a row: "the control"
  is the run of fibers that carry the target's label, and its view type is its role, else the
  outermost named component of that run (`Pressable`, `TouchableOpacity`), else the host type
  (`RCTView`). An ancestor's role (a screen with `role="list"`) is outside the control and is not
  used.
- **Gesture thresholds**: 500 ms is React Native's `delayLongPress` default; 10 points is about
  UIKit's pan slop. A move wins over a hold (a slow drag is a swipe).
- **Keep the open touch per instance, not in a closure.** A long press often re-renders the tree
  before the finger lifts; a closure variable of the render that saw the start is gone by then. A
  `WeakMap` keyed by the RUM instance also stops a nested provider from counting the touch twice;
  a touch older than 10 s is dropped so a lost `touchend` cannot block the next ones.
- **Stamp at the start, emit at the end.** The record needs the gesture, known only at the end,
  but the plugin pairs `ui.tap` with the replay's touch by the start time (`TAP_MATCH_MS`), so the
  record's timestamp is the touch start.
- **Driving a simulator app without a dialog.** `xcrun simctl openurl` to an app that is not
  running shows iOS's "Open in …?" confirmation, so deep links cannot drive unattended cold
  launches. `xcrun simctl launch --terminate-running-process <udid> <bundle> -journey a,b -pace 900`
  works: iOS puts `-key value` launch arguments in the `NSArgumentDomain` of the user defaults,
  and React Native's built-in `Settings.get("journey")` reads them synchronously at start. Every
  `simctl launch` is a cold start, so a new session (session-lifecycle, mobile rule 1).
- **Real taps on any installed app, with no Xcode project of its own.** A UI test bundle can
  drive another app: `XCUIApplication(bundleIdentifier: "dev.ouo.tinyshop.m6")`, elements by
  `testID` (React Native's accessibility identifier) through
  `app.descendants(matching: .any).matching(identifier:)`, `.tap()`, `.press(forDuration: 0.9)`,
  `.swipeUp()`, `XCUIDevice.shared.press(.home)` to send the app to the background. A throwaway
  runner is a `project.yml` for `xcodegen` with an empty SwiftUI app and a `bundle.ui-testing`
  target (`TEST_TARGET_NAME: Runner`, `CODE_SIGNING_ALLOWED: NO`), run with
  `xcodebuild test -scheme RunnerUITests -destination 'id=<udid>'`. It needs no simulator access
  grant and no idb; the W5 summary has the test. On a three-row list that does not scroll, a
  swipe that starts on a row still ends in that row's `onPress` (React Native's behaviour, not
  the SDK's), and the SDK records it as `swipe` by its motion.
- **Generator timing on the simulator**: a Release build starts and reaches the first screen in
  about 1 s on an M-series Mac; 4 s plus one pace per step left every session's records exported
  before the next launch stopped the app (30 of 30 sessions, see the W5 summary).
- **npm in this worktree** failed the same way as above; the cause this time was visible: npm
  walks up from the worktree into the shared main checkout's `package.json` (workspaces) and
  reads its workspace `package.json` files, which held merge-conflict markers. `--prefix` from
  outside avoids the walk.
