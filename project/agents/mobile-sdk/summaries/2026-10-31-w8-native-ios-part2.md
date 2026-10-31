# 2026-10-31 W8 part 2: screens, taps, SwiftUI masking, the native example and its suite

Branch `claude/w8-native-ios-part2` (cut from `origin/main` at 69033f6, part 1), work package W8 of [roadmap.md](../../../kb/mobile-sdk-research/roadmap.md) (§3, §10). Env `w8-native-ios-part2`, simulator `ouo-w8p2` (B9ADE0EA-EF3F-46D4-8FC0-E9B5E26EE3FC, iPhone 18 Pro, iOS 27.0). Design notes and the risk table: [ios-native-sdk.md](../../../kb/ios-native-sdk.md).

## What was done

- **Screens (C7, C4)**: `viewWillAppear(_:)` and `viewDidAppear(_:)` swizzled on `UIViewController` (every subclass reaches them through `super`). A screen is a controller of the app (its class in the main bundle) shown on its own or in a navigation, tab bar, split or page controller; named after its class, or `OuoScreenNaming.ouoScreenName` (nil opts out). TTID runs from `viewWillAppear` to the next frame after `viewDidAppear`. SwiftUI: `.ouoScreen("Name")`. Config `screens` (default on).
- **Taps (C6)**: OuoReplay's `TouchObserver` (made public; it never cancels or delays the app's touches) on every window that becomes key. At a one-finger touch start the touched view chain and the screen are read; at the end, the gesture (swipe at 10 points, long press at 500 ms). Target: a test id (`accessibilityIdentifier`, not the `ouo-mask` markers), else a control's accessibility label, never the label of a view that shows text (rule 6); path, view type (accessibility role, else the class). `taps` and the `tapLabels` kill switch; `Ouo.trackTap` for what the SDK cannot name (SwiftUI controls are not views: their touches carry the hosting view's class).
- **SwiftUI masking**: `.ouoMask()` and `.ouoUnmask()`, marker views behind the content. A childless `ouo-unmask` marker unmasks the masked rectangles inside its area (four lines in the planner). On the simulator SwiftUI draws text and symbols in `SwiftUI.CGDrawingView`, which no rule masked: replay of a SwiftUI app showed its text. It is masked now under `maskText`, except inside system bars, where iOS 26+ draws the navigation bar's glass with the same class (why it had been left out).
- **The crash-time context** (round-2 review note 1): on every change the screen context is set in memory for the crash handler (`OuoCrash.setContext`, a double buffer in OuoCrashCore, as sentry-cocoa keeps its scope) on the thread that changed it, before the call returns; the handler writes it into the report as base64 (a write racing the crash cannot break the report's JSON). The next launch prefers it to `context.json`, which terminations still use. A crash in a tap handler keeps the tap.
- **Feedback (C10)**: `Ouo.feedback(message, contact:, screenshot:)`, the React Native record (trimmed, cut at 4096 bytes, id, `ouo.last_events`, `ouo.feedback.screenshot` when replay records this session, which takes a frame of the screen).
- **The example** `examples/ouo-ios`: Home (UIKit), Products (SwiftUI), Cart (UIKit), a scene delegate (the shape of a new Xcode project), a SwiftPM executable wrapped into an `.app` by `scripts/build.sh`; journeys by `OUO_ACTION`.
- **The native suite** `tests/e2e/mobile-native`: `run.sh` (the launches), `check.mjs` (the check ids of the spec, rum-api and Tempo), `proxy.mjs` (C11.2 on the wire), `taps/` (an `xcodegen` UI test that taps, long-presses and swipes by accessibility identifier, as W5 did). Run by hand: CI wiring is N78.
- **The Objective-C smoke**: target `OuoObjCSmoke` calls every public Objective-C method; CI's iOS build now builds the package scheme, so it compiles there.
- **B3 cells for the native app**: `examples/ouo-ios/scripts/bench.sh` (`none` against `ouo`, alternating per round, `sample.py` from the host) and `bench.py` (paired medians).
- **Review notes from #123 round 2**: 1 above; 2 and 3 in the kb (ids after an adopted file; the stale `applicationState` line).

## Verified, and how

- **The native suite** (`tests/e2e/mobile-native/run.sh w8-native-ios-part2 <udid>`): **18 of 18 checks pass** (C1.1, C2.1–C2.3, C3.1, C3.2, C4.1, C4.2, C5.1, C6.1, C7.1, C8.1–C8.3, C9.1, C10.1, C11.1, C11.2), maturity row C1–C11 at L2 by the suite. C6.1 by real taps from the XCUITest runner: `Tap open-products (button) on Home`, `Long press checkout (button) on Cart`, `Swipe cart-items (UIScrollView) on Cart` (and the SwiftUI button as `CGDrawingView`). Earlier runs failed and were fixed: screens named after their classes (the example now names them with `OuoScreenNaming`), no replay (an env's replay port is not OTLP's plus one: the example takes `OUO_REPLAY`), and C8.3, which found that the recovered chunk ended at its last frame, 3.1 s before the crash on a static screen (now it ends at the crash, as the spec says).
- **A replay frame of the SwiftUI screen**, composited from the frames rum-api serves: its texts and the button are black, the `.ouoUnmask()` total is readable, the bar items are masked. The SF Symbol is readable: SwiftUI images are not masked by default (N79).
- `sdk/ios/test.sh`: 34 OuoVitals, 77 OuoSDK, 92 Core, 24 crash, all pass. New: 11 interaction tests (tap rules, rule 6, screens, feedback, the crash context set before the call returns, TTID from `viewWillAppear`, the handler's context winning), 2 planner tests (unmask region, SwiftUI drawing outside bars), 1 spool test (a chunk ends at its session's crash), 1 crash test (a real crash of the probe carries the context it set).
- The iOS simulator test run and CI's iOS build: 34, 77 and 91 pass on the iOS 27 simulator (`xcodebuild test`, without `OuoCrashTests`); `xcodebuild -scheme ouo11y-ios-Package -destination 'generic/platform=iOS Simulator' build` (CI's new command) exits 0; `lychee --offline` 0 errors.
- `swift build` on macOS and the iOS build compile `OuoObjCSmoke` (every public Objective-C call).

## B3 (simulator)

`examples/ouo-ios/scripts/bench.sh w8-native-ios-part2 <udid> <out> 10`: 10 rounds, `none` and `ouo` alternating, 40 s of the `bench` journey each (a screen change every 2 s), sampled from the host. Paired median delta `ouo` − `none` (IQR):

- CPU over the run: +5.1 pp (5.0 to 5.4); `none` 1.9 %, `ouo` 7.0 %. Replay is on in `session` mode with the screen changing every 2 s; React Native's T3 cell was +4.6 pp.
- Steady memory: +1.1 MB (0.6 to 1.4). Peak: +24.7 MB (24.4 to 25.1), the 1:1 capture bitmap, as in React Native's cells.
- App start (process start to Home's first `viewDidAppear`): +16 ms (−4 to +40), 301 against 316 ms.
- `Ouo.start` on the main thread: 13.6 ms median, 17.7 ms at most (part 1 measured about 20 ms before the export `URLSession` became lazy).

No gate is applied (there is no previous native release to compare with), so C12 stays L1. A device run is the founder's call under the phone budget.

## Plan and what is left

- **N78**: the native suite in CI.
- SwiftUI taps are named after the hosting view; reading SwiftUI's accessibility elements at a touch would name them, at a cost not measured.
- The phone: B3 on a device (start cost, CPU) is the founder's call under the phone budget.
- Env `w8-native-ios-part2` and simulator `ouo-w8p2` stay up until the PR merges.
