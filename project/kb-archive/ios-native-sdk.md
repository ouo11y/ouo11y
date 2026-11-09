# The native iOS SDK (`OuoSDK`, W8)

Question: how does a UIKit or SwiftUI app without React Native get the same records as `@ouo11y/react-native`, with no third-party dependency (ADR-0016), and what had to be decided that the React Native SDK never faced? Part 1 (2026-10-30): sessions, OTLP export, lifecycle, `URLSession`, wiring of OuoCrash, OuoVitals and OuoReplay. Part 2: automatic screens, taps, SwiftUI masking, the example app and its suite.

## Shape

- One product, `OuoSDK`, on top of the four existing ones. `Ouo` (static, `@objc`) is the API; `Core` holds the state under one lock; the platform (UIKit notifications, OuoCrash, OuoVitals, OuoReplay, the `URLSession` hook) is injected through `Core.Hooks`, so everything but the UIKit glue runs under `swift test` on macOS and on the iOS simulator.
- Ports, not new rules: `SessionManager` is the React Native `SessionManager` made synchronous (the state is a local file, so the cold start reads it, ends the previous session and starts the next before `start` returns; no "pending start" juggling), `Vitals` is `vitals.ts` without the JS stall loop, `NativeReport` is `crash.ts` (`nativeCrashAttributes`, `formatNativeStack`, line for line), `RecentEvents` and `ScreenContext` are `recent.ts` and `errors/context.ts`, `Sampling` is `sampling.ts` (same FNV-1a over UTF-16 code units, vectors from Node in the tests).
- Rules the React Native SDK lacks and the spec has: `user_change` and `manual` session ends and `device.id` (session-lifecycle.md cases 8 to 10), as the browser SDK does them.
- Module `OuoSDK`, type `Ouo`: a type named like its module breaks module-qualified names (`Ouo.Ouo`) in `.swiftinterface` files, which an xcframework needs.

## OTLP without opentelemetry-swift

- OTLP/JSON by hand (`OTLP.swift`, ~100 lines): ids in lowercase hex, `timeUnixNano` and `intValue` as decimal strings, `eventName` plus the `event.name` attribute (the collector copies one into the other anyway). `JSONSerialization` raises an Objective-C exception (uncatchable from Swift, so a crash) on NaN or infinity: `AttributeValue(any:)` drops non-finite numbers and the encoder turns any left into strings.
- `NSNumber` keeps the type an app meant: `CFGetTypeID(n) == CFBooleanGetTypeID()` for booleans (Swift `true as NSNumber` is a `CFBoolean`), `CFNumberIsFloatType` for doubles. `value as? Bool` alone would turn the integer 1 from Objective-C into `true`.
- The outbox is the chunk uploader's folder queue, extracted as `DiskQueue` (OuoReplayCore): files `<ms>-<n>.<tag>` written before anything is sent, sent oldest first, bounded, retried. The OTLP files are the uncompressed JSON (the spec bounds OTLP in uncompressed bytes), gzipped when sent; chunks stay gzip on disk. Request URLs and the credential are built when a file is sent, so stored batches go with the running app's endpoint.
- One behaviour changed for both: while a retry waits, a new entry no longer triggers a send. With a batch a second, the old rule sent one request a second into an outage; now it is one per backoff (1 s doubling to 30 s for OTLP, 60 s for chunks), plus `drain` on foreground and `flush`.

## Things that could go wrong, and what decides them

| Risk | Decision | Test |
|---|---|---|
| Threads | One lock in `Core`; never held while a hook, app code or `URLSession` runs; hooks called under it (`nextFrame`, timers) must call back asynchronously, and come back through the lock. Session changes go to OuoCrash and replay in order (a generation number; an older one after a newer is skipped) | `ConcurrentUseLosesNothing` (400 mixed calls from many threads, three runs), `SessionChangesAreDeliveredInOrder` |
| File I/O on the main thread | `context.json` (after every navigation, exception and, with part 2, tap) is snapshotted under the lock and written on a serial queue after it, newest wins: a hanging disk blocks neither the caller nor the next record. The cost: a crash within about a millisecond of the record can lose it, as the React Native SDK's asynchronous storage can. `session.json` stays synchronous (at most once a second and on session changes), and `start` reads it and the crash report on the calling thread, because the session must exist when `start` returns and the report decides how the previous session ended; the previous run's `context.json` is read on the queue. The export `URLSession` is made at the first send, on the outbox's queue: the first `URLSession` of a process costs about 8 ms (0.1 ms after), and `Core.init` on the main thread used to pay it | `ContextWritesDoNotBlockTheCaller` (fails when the write is made synchronous); measured `start` time in the summary |
| Launch kind (scenes, SwiftUI) | `applicationState` is `.background` in `didFinishLaunching` of every app with scenes, also on a tap: it marked every such session background and dropped app start and the first TTID (review of #123). The task role (`task_policy_get(TASK_CATEGORY_POLICY)`) is what iOS set when it launched the process: `TASK_FOREGROUND_APPLICATION` for the user; background, Darwin-background and non-UI roles are background launches; anything else counts as foreground | `LaunchKindFromTheTaskRole`; simulator runs of three app shapes (no scenes, a scene delegate, SwiftUI `App`) |
| The config changed after `start` | `start` copies it (`Settings`); network, timer and watchdog threads never read the app's object | `TheConfigIsCopiedAtStart` |
| App extensions | `start` returns false in an `.appex`: extensions have no `UIApplication`, which OuoCrash, OuoVitals and the lifecycle read | `StartRefusesInAnAppExtension` (calls `start` with a valid config and an `.appex` bundle) |
| Background launches | the session starts marked as in the background, so it ends with `background` unless the app opens in time; no app start; a session created by a record in the background is marked too | `BackgroundLaunchEndsWithBackground`, `ASessionCreatedInTheBackgroundIsMarkedSo`, `ABackgroundLaunchHasNoAppStart` |
| Before the first unlock | every file is written `completeUntilFirstUserAuthentication` (readable in a background launch after the first unlock even when the app's default is `complete`). Before it, `session.json` exists and cannot be read: the store says `unreadable` (not `missing`), nothing is saved over it, and the first save after it becomes readable (or `protectedDataDidBecomeAvailable`) ends its session as a cold start would and keeps its `device.id` and user. The first version treated it as a fresh install and overwrote it at the unlock: the old session never ended and `device.id` changed (review of #123). A batch the outbox folder refuses is sent once from memory (`DiskQueue.put`) | `AFileThatCannotBeReadYetIsAdoptedOnceItCan` (`chmod 000` for class C, fails without the `unreadable` case), `AdoptionHappensOnTheNextSaveAndKeepsAnIdentifiedUser`, `AnUnwritableOutboxSendsOnceFromMemory` (`chmod 555`), `ARefusedWriteIsSentOnceFromMemory` |
| Clock changes | `SteadyClock`: wall clock read once plus `CLOCK_MONOTONIC` (counts sleep on Darwin; `systemUptime` and `CLOCK_UPTIME_RAW` do not), both injectable. A clock change mid-run does not reorder records or expire the session; durations never go negative. The outbox has no age (N77): a jump forward drops nothing, and its names keep `put` order when the clock moves back | `TheDeviceClockChangingMidRunMovesNothing` (moves the wall clock back an hour and forward two), `NoNegativeDuration`, `AClockMovedForwardDropsNothing`, `AClockMovedBackKeepsTheOrder` |
| Ids after an adopted file | when a file that was unreadable at start (before the first unlock) is adopted mid-run, the current session switches to the stored anonymous `user.id`, and the resource to the stored `device.id`, after its `session.start` went out with the run's temporary ones. Rare (a background launch before the first unlock that lives until the unlock) and accepted: the device and the user stay right from then on | by reading (review of #123, round 2) |
| A crash right after a tap | the screen context (screen, last 20 events) is set in memory for the crash handler on the thread that changed it, before that call returns (`OuoCrash.setContext`, a double buffer in OuoCrashCore, as sentry-cocoa keeps its scope); the handler writes it into the report as base64, so a write that raced the crash cannot break the report's JSON. `context.json` (written on a queue) remains for terminations, which no handler sees. W8 part 2 | `TheCrashCarriesTheLastContextTheHostSet` (a real crash of the probe), `TapsAndScreensSetTheCrashContextAtOnce`, `ThePreviousCrashUsesTheHandlersContext` |
| A request the collector always answers 500 | N55: only 429, 502, 503 and 504 are retried (OTLP/HTTP, `DiskQueue.retryable`); a 500 (or 408, 501, any 4xx) is dropped after one attempt and counted as `rejected`, so the entries behind it go out at once, in the OTLP outbox and the replay chunk queue alike. One answered 503 every time still waits, retried, until the bound evicts it (no age since N77) | `AFiveHundredEveryTimeDoesNotBlockTheQueue`, `RetriesOnlyOTLPRetryableAnswers`, `RejectedChunksAreDroppedAndTheQueueContinues`; C11.3 on the simulator |
| Flush ordering | a flush a timer started holds the records it took until they are on disk; a caller's `flush` (background, `Ouo.flush`) waited for nothing and its drain could finish before that batch was written. Flushes are serialized | `BatchesOf64WrittenBeforeTheyAreSent` (it caught it, about one run in ten) |
| Offline | the outbox; the next launch, foreground, `flush` and the backoff send | `AnOfflineRunIsSentByTheNextLaunch`, `AnOutageIsNotHammered`, simulator run 5 |
| Kill mid-write | atomic writes (old file or new, never half); a request in flight stays on disk (at least once); the screen context is on disk at once after a navigation, tap or exception, so a crash right after carries them | `AKillMidUploadResendsTheChunk` (same queue), `ContextPersistence` |
| Kill before the first export | N52's `session_started_ms` in the crash report rebuilds a session the file never saw | `ACrashOfASessionTheFileNeverSawStillEndsFromItsStart` |
| Swizzling `resume` | the private task classes override `resume` at several levels and differ by OS: walk the hierarchy of a real data, download and upload task and swizzle each class with its own implementation (AFNetworking's approach); a task is claimed once (an associated object) since `resume` runs at several levels and again after `suspend` | `NetworkTests` on macOS and on the iOS 27 simulator |
| Trace headers | a task's request is immutable; `setValue(_:forKey: "currentRequest")` before the original `resume` replaces it (sentry-cocoa does this). KVC on a missing key raises an Objective-C exception, so `responds(to: "setCurrentRequest:")` first. An app's own `traceparent` is kept; `baggage` is merged, the session's keys replacing any the app set | `SpansHeadersAndEvents`, `IngestURLsAreNotTracedAndAnExistingTraceparentWins` |
| Completion | KVO on `state` (kept alive as an associated object of the task, released with it); fires once | same |
| `propagateTo` | prefixes matched at a boundary (`/`, `?`, `#`, end), so `https://api.example.com` does not leak the session id to `https://api.example.com.evil.net` or another port | `URLPrefixesMatchAtABoundary` |
| A refused `start` | validation before the once-flag: a bad config does not block the next, good `start` (a test caught the first version doing that) | `CallsBeforeStartDoNothing` |
| Frame times | a `CADisplayLink`'s `timestamp` is the frame already on screen, often earlier than the call that asked for the next one: the first simulator run measured Products' TTID at 1.3 ms and dropped Cart's as negative. `nextFrame` reports `targetTimestamp` (the frame that can show what was laid out), and the SDK converts it with its own steady clock, so a TTID never mixes two clocks | simulator run (C4 row), `Vitals` |
| Backups | `Application Support/ouo/sdk` is excluded: a restored backup must not carry `device.id` or a session to another device | by reading |

## Simulator: an app without an Xcode project

`project/agents/mobile-sdk/verify/w8-native-sim/` is a SwiftPM executable target that calls `UIApplicationMain`. `xcodebuild -scheme OuoSimApp -destination 'generic/platform=iOS Simulator'` (run from the package folder: `xcodebuild` has no `-packagePath`) builds the Mach-O; a folder `OuoSimApp.app` with it, an `Info.plist` and the `ouo11y-ios_OuoSDK.bundle` resource bundle, signed ad hoc (`codesign -s -`), installs and runs with `simctl`. Environment for the app goes through `SIMCTL_CHILD_*`. `simctl launch` of the running app brings it to the foreground; launching `com.apple.Preferences` sends it to the background. The package's own test schemes do not build for iOS because `OuoCrashTests` uses `Process`: run the iOS tests on a copy of the package without that target.

## Things to know for part 2

- The automatic screen tracking (UIKit swizzle, SwiftUI) calls `Core.trackScreen`: it already emits `navigation`, measures TTID and keeps the screen for errors and the context.
- `OuoVitals.nextFrame` is the "next frame drawn" primitive for TTID and TTFD.
- `Ouo.start` decides a launch for the user or in the background from the task role (`TASK_CATEGORY_POLICY`), on any thread; not from `applicationState`, which is `.background` in `didFinishLaunching` of every app with scenes.

## Part 2 (2026-10-31): screens, taps, SwiftUI, the native suite

- **SwiftUI on iOS 27 draws text and SF Symbols in `SwiftUI.CGDrawingView`** (a `UIView`), one per
  `Text`/`Image`, under `_UIHostingView<…>`; a `Button` adds `_UIShapeHitTestingView`. No replay
  rule masked it, so a SwiftUI app's text was readable in replay. It is masked under `maskText`
  except inside `UINavigationBar`, `UITabBar`, `UIToolbar` (iOS 26+ draws the bar glass with it).
  Found with the example's `dump` action (`OUO_ACTION=dump` writes the view classes). Images are
  in views too (the review of #127, on a probe app): `Image(uiImage:)`, a `Label`'s and a `List`
  row's symbol in `SwiftUI._UIGraphicsView` (it has `contents`), a large SF Symbol in
  `_TtC7SwiftUIP33_…_UIShapeHitTestingView` (a `ColorShapeLayer`, no `contents`; matched by name
  suffix): both masked under `maskImages` now, like sentry-cocoa. A SwiftUI toolbar item in a
  navigation bar draws its text in a `CGDrawingView` under `_TtGC7SwiftUI16UIKitBarItemHostVS_11BarItemView_`:
  masked; the bar exemption is for SwiftUI drawing outside such items only.
- **SwiftUI markers**: `.ouoMask()` / `.ouoUnmask()` put a plain `UIView` with an identifier behind
  the content (`UIViewRepresentable` in `.background`): the content is drawn in sibling views. The
  unmask marker has its own identifier, `ouo-unmask-area`, which only the modifier sets: rectangles
  masked by class inside its frame are left out (1 pt of slack), forced (`ouo-mask`) and cut-off
  ones stay. A plain `ouo-unmask` view still unmasks only its own subtree (the first version made
  any childless `ouo-unmask` view an area, which a React Native overlay could set).
- **SwiftUI taps** hit the drawing view: `ouo.ui.target` is `CGDrawingView` or `_UIShapeHitTestingView`.
  XCUITest finds SwiftUI controls by `.accessibilityIdentifier` (the accessibility tree), the SDK
  does not (the view tree).
- **Taps never read accessibility labels** (the review of #127): with the accessibility runtime on
  (VoiceOver, Voice Control, Switch Control, and the XCUITest runner) a `UIButton` reports its
  visible title as `accessibilityLabel` with the button trait; with it off, nil and no traits. A
  tap is named by `accessibilityIdentifier` (or `Ouo.trackTap`), else by the class of the touched
  control or view, the same with or without assistive technology. `AButtonTitleNeverLeaksIntoATap`
  runs on the iOS simulator.
- **Screens**: swizzling `viewWillAppear`/`viewDidAppear` on `UIViewController` itself is enough
  (subclasses call `super`). "In the main bundle" filters UIKit's and SwiftUI's controllers; a
  class name like `HomeViewController` is a poor screen name, so apps name screens with
  `OuoScreenNaming` (the example does).
- **The replay endpoint** is derived as OTLP port 4318 → 4319; an env's ports are arbitrary
  (`:20300`/`:20301`), so a native app pointed at an env must set `replayEndpoint` (the example reads
  `OUO_REPLAY`). The first suite run had no replay at all because of it.
- **A crash on a static screen**: replay sends no frame for an unchanged screen, so the open chunk's
  last frame can be seconds before the crash; recovery now ends the crashed session's chunk at the
  crash (the spec's C8 wording), from the crash report `OuoSDK` reads first.
- **Taps in the suite**: an `xcodegen` project (`tests/e2e/mobile-native/taps/project.yml`, an empty
  app and a UI test) built once with `build-for-testing`, run with `test-without-building` while the
  example runs: `XCUIApplication(bundleIdentifier:)`, `.activate()`, elements by identifier. It needs
  no simulator access grant and no person. `xcodegen generate --project <dir>` needs `<dir>` to exist.
- **No `timeout` on this Mac**: bound commands with `perl -e 'alarm N; exec @ARGV' cmd`.
