# Producing and reading Sentry React Native vitals through the bridge (M3 quickstart)

Question: how does a small Expo app make each mobile vital appear in ouo through the Sentry bridge
on the iOS Simulator, reliably enough for a guide? Written 2026-10-28 by the M3 quickstart
session (`examples/quickstarts-mobile/tiny-shop-mobile-signals`). Expo 57.0.31, RN 0.86.3,
`@sentry/react-native` 8.32.0 (`@sentry/core` 10.76.2), collector 0.4.0, rum-api 0.5.0, grafana
0.5.0 (plugin 0.9.0), Xcode 27.0, iOS 27.0, iPhone 18 Pro simulator.

## Frozen frames need the main thread, and a late transaction end

- JavaScript work never freezes native frames. 3,000 and 12,000 `<Text>` rows in one ScrollView
  (Debug): 0 frozen, 1-2 slow, but JS stalls of 1.0 s and 10.9 s. React Native renders and lays
  out off the main thread; mounting thousands of views stays under 700 ms.
- A multiline `<TextInput editable={false}>` with a long `value` is laid out by UITextView on the
  main thread. 6,000 lines: about 1 s, 1 frozen + 1-2 slow frames, in Debug and Release.
  200,000 lines froze the main thread for about a minute.
- **End the transaction well after the freeze.** RN fetches the native frame counters (on the
  main queue) when the span ends. Ending it 1 s after the render effect: the fetch ran right after
  the block, before `CADisplayLink` reported the long frame: `frames_total 4`, slow 0, frozen 0
  for a 1.08 s window. Ending it 3 s later: frozen 1. A block long enough to time out the fetch
  drops the frames measurement completely (no `app.jank`, the `ouo.stall` still arrives).

## JS stalls

A 1 s busy loop inside a `ui.action` transaction kept open 500 ms past the loop gives one
`ouo.stall` of 950-1,000 ms. Without the extra wait the transaction ends inside the stall.

## App start numbers

- Debug: first launch after install `cold` 29 s (includes Metro bundling), warm 3.0-4.3 s
  (`simctl terminate` + launch). Release on the same Mac: cold 1.70 s after `simctl uninstall` +
  install, warm 1.53-1.75 s.
- Installing the Release build over the Debug build of the same version and build number gives a
  **warm** start, not cold.
- Debug builds report an "App Hang Fully Blocked 2.0-2.8 s" error at launch (sentry-cocoa sees the
  main thread wait for the bundle): the session turns `errored`. `enableAppHangTracking: !__DEV__`.

## Crashes

- `Sentry.nativeCrash()` in Release: `EXC_BAD_ACCESS`, `Attempted to dereference null pointer.`,
  mechanism `mach`, sent on the next launch with `session.end` reason `crash`; frames
  `at ? (TinyShop 0x... 0x100510000 + 213464) [in app]`, `ouo.sentry.debug_images` with debug ids.
- JS fatal (`setTimeout(() => { throw })`) in Release: the app closes; event (`onerror`, fatal) and
  `crashed` arrived on the next launch in this run (kb `sentry-react-native-demo.md` saw it before
  the process died).

## Bridge observations

- `app.screen.name` of `ui.action` windows is the bridge's "current screen", updated only by
  transactions. React Navigation drops empty back-navigation transactions, so after Cart → back →
  Products the next interactions are labelled `Cart` (seen in the plugin timeline).
- Vital records have an empty body (spec), so their Loki line is just the event name.
- N53 (transaction translated before its session): 0 of 10 launches lost app start / TTID.
- `upstream: none` with `service_name` per project in the trimmed quickstart collector config
  (`ouosentry` straight into the `logs` and `traces` pipelines, no routing connector when there is
  no replay) works with collector 0.4.0.
