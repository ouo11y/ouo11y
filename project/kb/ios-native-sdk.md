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
| Threads | One lock in `Core`; never held while a hook, app code or `URLSession` runs; hooks called under it (`nextFrame`, timers) must call back asynchronously, and come back through the lock | `ConcurrentUseLosesNothing` (400 mixed calls from many threads, three runs) |
| App extensions | `start` returns false in an `.appex`: extensions have no `UIApplication`, which OuoCrash, OuoVitals and the lifecycle read | `AppExtensionsAreRefused` |
| Background launches | the session starts marked as in the background, so it ends with `background` unless the app opens in time; no app start; a session created by a record in the background is marked too | `BackgroundLaunchEndsWithBackground`, `ASessionCreatedInTheBackgroundIsMarkedSo`, `ABackgroundLaunchHasNoAppStart` |
| Before the first unlock | every file is written `completeUntilFirstUserAuthentication` (readable in a background launch after the first unlock even when the app's default is `complete`); before it, nothing can be written: the session is not persisted (the next launch ends the one on disk) and a batch is sent once from memory | `ADiskFailureSendsOnceFromMemory`, `AnUnreadableFileIsAFreshStart` |
| Clock changes | `SteadyClock`: wall clock at launch plus `CLOCK_MONOTONIC` (counts sleep on Darwin; `systemUptime` and `CLOCK_UPTIME_RAW` do not). A clock change mid-run does not reorder records or expire the session; durations never go negative | `SteadyClockNeverGoesBack`, `NoNegativeDuration` |
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
- `Ouo.start` reads `applicationState` only on the main thread; called elsewhere it assumes a foreground launch.
