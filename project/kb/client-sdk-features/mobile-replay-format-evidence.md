# Mobile session replay: wireframe-first vs video-first (evidence only)

Collected 2026-11-10. Evidence, not a recommendation. "Uncertain" marks claims not confirmed in a primary source.
Bracketed numbers [n] refer to the Sources list at the end. "Mktg" = vendor marketing claim, no method published.

Terms used below:
- **Wireframe**: the SDK walks the view tree (or draw commands) and sends structure: rectangles, text, images and styles. A player draws it again in the browser.
- **Screenshot/video**: the SDK grabs pixels, paints masks over them, and sends JPEG/WebP frames or an encoded video segment.
- **Draw-command**: the SDK records low-level drawing operations and replays them. It sits between the two: no pixels, but higher fidelity than rectangles.

## 1. Method per vendor and platform

| Vendor | iOS | Android | React Native | Flutter | Change over time |
|---|---|---|---|---|---|
| Sentry | Screenshot + view-hierarchy snapshot in the same frame, ~1 fps, encoded to video segments [1][2] | Same. PixelCopy (default) or Canvas strategy [3] | Uses the native iOS/Android SDKs, so screenshot/video [4] | Screenshot taken in Dart (`RenderRepaintBoundary.toImage`), masked from the widget tree [5][6] | Always video. In 2025 Sentry evaluated wireframe internally and rejected it for SwiftUI (see section 6) [7] |
| Datadog | Wireframe (shape/text/image), UIKit. SwiftUI experimental [8][9] | Wireframe. Compose needs a separate `session-replay-compose` module [8][9] | Wireframe from the native view hierarchy [9] | Wireframe from the widget tree, `SessionReplayCapture` root widget (Preview) [9] | Wireframe since the first SR module PRs (2022-06/07) [10] |
| PostHog | Wireframe by default. `screenshotMode` opt-in [11] | Wireframe by default. `screenshot` opt-in [11] | Always screenshot, not configurable [11] | Always screenshot, not configurable [11] | Started wireframe-first (Android PoC 2023-11). Screenshot mode added later. Blog says "most users now prefer" screenshot mode [12] |
| Microsoft Clarity | Draw-command capture ("low-level drawing commands"), played back as "walkthrough-style video" [13] | Same. Compose via `clarity-compose` [13] | Supported. Method assumed the same as native (uncertain) [13] | Supported, Flutter >= 3.32 [13] | No change found |
| FullStory | View-hierarchy / draw-instruction capture. "never captures screenshots" [14] | Same [14] | Same (uncertain per-framework detail) | Same. Claims native WebView capture incl. Flutter [14] | No change found |
| Smartlook (Cisco) | Native = periodic screenshots, masked per frame (default). Wireframe = schematic. Native mode records both, and the player toggles between them [15] | Same [15] | Wireframe on Android only (per RN reference, uncertain if current) [15] | Wireframe usable per Flutter docs (uncertain) [15] | 2.1 SDK reworked wireframe, added Compose [15] |
| UXCam | "UIWindow layer rendering" snapshots at key moments. Video rebuilt server-side. Optional "schematic" (wireframe-style) mode [16] | `View.draw()` snapshots [16] | Native bridge [16] | Platform channel to native [16] | No change found |
| Luciq (ex-Instabug) | Screenshots, on by default, auto-masking levels [17] | Screenshots. Navigation mode by default. "Video-like" interval mode (>=500 ms) is experimental [18] | Uncertain (assumed native) | Screenshots (Flutter setup page) [17] | Moving from per-navigation screenshots toward "video-like" interval capture [18] |
| Contentsquare | View hierarchy and lifecycle monitoring. Text masked as "la" runs, images as an "IMG" placeholder, so likely not pixels (method not stated explicitly, uncertain) [19] | Uncertain. "different approaches on Android and iOS" [20] | Supported [20] | Supported (changelog) | Uncertain |
| bitdrift | Wireframe ("optimized representations", categorized views, no text/images), UIKit + SwiftUI, custom categorizers [21][22] | Same, Views + Compose [21] | Not stated | Not stated | PR #93 (2024-11) added on-demand screenshot capture controlled by the server [23] |
| LogRocket | Shown as "Video" replay. Capture method not documented. Fonts can be uploaded for replay, which hints at reconstruction, not pixels (uncertain) [24] | Same [24] | Supported [24] | Supported [24] | Uncertain |
| Embrace | No visual screen replay found. Its "user session replay" is a timeline of technical events (uncertain) [25] | same | same | same | n/a |
| Grafana Faro | No mobile replay. Faro replay is web-only (rrweb, public preview) [26] | n/a | n/a | n/a | n/a |

Summary: video-first: Sentry, Luciq, UXCam (default), Smartlook (default), PostHog RN/Flutter. Wireframe-first: Datadog, PostHog native, bitdrift. Draw-command: Clarity, FullStory. Two vendors ship both modes: PostHog and Smartlook.

## 2. Published costs

Main thread and bandwidth figures are vendor numbers. Most vendors publish no battery numbers.

| Vendor / method | Wire bytes | CPU / memory / FPS / main thread | Method stated | Src |
|---|---|---|---|---|
| Sentry iOS, video | 10 KB/s (~600 KB/min) | FPS 55->53, mem 102->121 MB, CPU 4%->13%, ~25 ms main thread per capture, cold start +0.2 ms | iPhone 14 Pro, Pocket Casts, full masking, release build, same flow x10, median | [27] |
| Sentry Android, video | 7 KB/s (~420 KB/min) | FPS 55->54, mem 255->265 MB, CPU 36%->42%, 20 ms main thread, cold start +6 ms | Pixel 2 XL, Android 11, Pocket Casts, x10 median | [28] |
| Sentry iOS render step (V1 -> V2) | — | `drawHierarchy` render 149.8 ms avg / 155.3 ms p95 -> 25.4 / 30.3 ms. Dropped frames 9-10/s -> ~2/s | iPhone 8, iOS 15.7, Instruments, 120 samples | [29] |
| Sentry Flutter, video | n/a | iOS CPU 30.04%->31.92%, mem unchanged. Android mem 372.5->391.6 MB. "slow frames on older lower-end devices" | iPhone X iOS 16.7.10, Pixel Fold Android 15 | [30] |
| Datadog iOS, wireframe | ~12 KB/s avg (~720 KB/min). Image-heavy apps higher at first | Capture every 64-100 ms. "single screen capture takes 3 ms" on main thread. +~200 kB IPA | Method not on page (links to external benchmarks) | [31] |
| Datadog Android, wireframe | ~1.22 KB/s avg (~73 KB/min) | Same as above. AAR 480 kB | Same | [31] |
| PostHog screenshot mode | ~20 kB per screenshot (JPEG q=30%), captured only on interaction, off main thread | none | Blog statement, no benchmark | [12] |
| PostHog wireframe | none | Blog: "much less performance-intensive" (no data) | Mktg | [12] |
| Clarity, draw-command | ~10 KiB/s | Init 1-2 ms. P95 frame time +3-5%. APK +400 KB, IPA +900 KB | "representative set of applications" | [13] |
| Contentsquare iOS | Per minute: High <2 MB, Medium (default) <1 MB, Low <900 KB | Max CPU overhead <10%, RAM <5 MB. SwiftUI screens ~120% of UIKit data | iPhone 7, iOS 15.7.8, High quality, masking off | [19] |
| UXCam | 500 KB-2 MB compressed per "typical session" | Memory 20-40 MB rolling buffer. Battery "negligible impact in testing" (Mktg) | none | [16] |
| Luciq Android | WebP at 25% (NORMAL): ~104 screenshots per 1 MB session cap (~10 KB each). 1 FPS ≈ 1-2 min of activity | none | Doc estimate | [18] |
| bitdrift | none | none ("We don't ship videos", Mktg) | none | [21] |
| FullStory | none | Sync capture mode = most faithful animation, higher main-thread cost | Qualitative | [14] |

Observations:
- Per-second bandwidth falls in one band (7-12 KB/s) for Sentry video, Datadog iOS wireframe and Clarity draw commands.
- Datadog Android wireframe is one order lower (1.2 KB/s). No vendor says why its iOS and Android numbers differ by ~10x.
- For screenshot capture the main cost is rendering the view into a bitmap on the main thread. Sentry iOS V1 took ~150 ms on an iPhone 8, ~25 ms after a custom renderer [29]. Datadog quotes 3 ms per wireframe capture [31]. Different devices and methods, so this is not a like-for-like comparison.

## 3. Fidelity by UI case

| UI case | Wireframe (evidence) | Screenshot/video (evidence) |
|---|---|---|
| Custom drawing / Canvas (`draw(_:)`, `onDraw`) | Missing. Datadog: "views that use direct canvas drawing" unsupported on all platforms [9]. Sentry's doc: custom `draw(_:)` "may not be accurately represented" [7] | Pixels captured as drawn. Masking can miss it: PostHog shipped unmasked SwiftUI `Canvas`/`.drawingGroup()`/Swift Charts until a fix [32] |
| Metal / OpenGL / SurfaceView / TextureView | Not representable (no view content) | Android `SurfaceView` shows black/transparent unless the experimental `captureSurfaceViews` is on, which masks only at SurfaceView level [3]. iOS Metal: uncertain |
| Maps | Datadog: map widgets unsupported [9]. Contentsquare: placeholder, cannot unmask [19] | Captured as pixels (subject to SurfaceView limits on Android, uncertain per map SDK) |
| Video players | Datadog: unsupported [9]. Contentsquare: AVFoundation not collected [19] | Captured on iOS if rendered into the layer tree (uncertain). Android SurfaceView-based players black by default [3] |
| WebViews | Needs a separate web recorder bridged in. LogRocket needs the web SDK inside the WebView [24]. Contentsquare: extra steps [20]. FullStory claims native WebView capture [14] | Pixels captured. Sentry masks WebViews by default [3] |
| SwiftUI | Hard. Sentry: wireframe "not usable … due to unavailability of the view hierarchy in SwiftUI" [7]. Datadog SwiftUI experimental, blank screens without it [9]. PostHog: "not a 1:1 match" [12] | Pixels fine, but masking depends on detecting SwiftUI internals. iOS 26 Liquid Glass broke Sentry masking of `Text`/`Image`/`Label`/`List` [33] |
| Jetpack Compose | Needs a separate module (Datadog, Clarity), not 1:1 (PostHog) [9][13][12] | Pixels fine. Masking needs Compose semantics. Sentry: Compose hierarchies "take longer to snapshot initially" [28] |
| Flutter | Needs its own widget-tree walker (Datadog Preview, limits on canvas/text styling) [9] | Dart-side `toImage` (Sentry). PostHog RN/Flutter only support screenshot [5][11] |
| React Native | Native view hierarchy works (Datadog), same gaps as native [9] | Native screenshot. Sentry adds RN text/image classes to the mask rules [7] |
| Images | Sent as separate assets or placeholders. Datadog: vector images and SF Symbols unsupported, large images become placeholders [9] | Pixels. Masked by default at most vendors |
| Animations | Need presentation-layer geometry. Contentsquare: animations >35 ms may render partially [19] | Limited by frame rate (~1 fps Sentry default) [2]. Sentry V2: issues with "graphics-heavy animations" [29] |
| Fonts / text styling | Datadog: "advanced text styling" unsupported [9]. LogRocket: custom fonts need upload [24] | Pixels exact |
| Keyboard | Clarity, UXCam: keyboard not captured [13][16] | Same at Clarity/UXCam. Sentry: uncertain |
| System dialogs / chrome | Datadog: action bar, spinners, progress bars unsupported [9]. Clarity: notifications and nav bars not captured [13] | Luciq: `FLAG_SECURE` windows excluded [18]. Contentsquare: image picker, review prompt not collected [19] |

## 4. Privacy

How masking works:
- **Video (Sentry)**: a view-hierarchy pass on the main thread finds sensitive views (class names plus SwiftUI layer-type filters). Blocks are painted over them in the control's dominant colour, before encoding [2][7].
  - Android has two strategies [3]:
    - PixelCopy (default): screenshot is asynchronous, so masks can misalign.
    - Canvas: redraws the screen and masks text/bitmap draw operations. It always masks all text, inputs and images.
- **Wireframe (Datadog)**: text becomes "x" runs, inputs become `***`, images become "Image" placeholders. `mask_all` is the default for text, images and touches. Masked values are never collected [34].
  - bitdrift/Smartlook wireframes describe themselves as never containing text or images [15][22].
- **Defaults**: Sentry masks all text, images and WebViews [2][3]. PostHog "restrictive with automatic masking" [11]. Contentsquare masks all [19]. Luciq has screenshots on and auto-masking levels [17].

Failure modes, from vendor trackers and changelogs:
- **Screenshot masking misses**: unclipped images, layer shadows and button titles drawn outside a view's bounds stayed visible (PostHog iOS) [32].
  - SwiftUI `Canvas` and Swift Charts were unmasked [32].
  - Animated or highlighted `UIImageView` images were unmasked [32].
- **OS changes**:
  - iOS 26 / Xcode 26 Liquid Glass broke SwiftUI masking at Sentry. Sentry's defensive fix disables replay on that combination unless the app overrides it (sentry-cocoa #6389, #6390, 2025-10-09) [33].
  - Sentry tracks re-verification of masking on each OS ("Verify Session Replay and screenshot masking on xOS 27", #8126, 2026-06) [35].
  - Sentry's design doc: class and layer rules "require regular review on new OS releases" [7].
- **Fail-closed designs**:
  - PostHog drops a frame whose masked render fails instead of sending it unmasked [32].
  - PostHog skips snapshots while a masked view awaits layout [32].
  - Sentry evaluated a "defensive-unredacting" mode (mask all, unmask what is proven safe) and found it impractical [7].
- **Async capture**: Sentry PixelCopy masks can misalign [3]. Luciq warns its video-like mode "may capture sensitive UI unmasked in some cases" [18].
- **Wireframe failure mode** is different: unmasked mode sends text as data. Default masking happens before capture, and pixels from arbitrary drawn content are never collected.
  - Sentry's doc: "No sensitive content is ever captured" with wireframes [7].
  - Residual risk: text in custom-drawn views is simply missing, and text in unmasked mode is shipped as a string. Not measured anywhere.
- **Tracker counts as a signal** (GitHub issue search, keywords "replay mask", 2026-11-10):
  - sentry-cocoa 31, sentry-java 16, sentry-react-native 32, sentry-dart 22
  - posthog-ios 22, posthog-android 9
  - These include feature requests and tasks, not only leaks.

## 5. Player and storage

- **Both formats in one player is done in practice**:
  - Sentry wraps video in rrweb events: `RRWebVideoEvent` (tag `video`, `segmentId`, `size`, `encoding`, `container`, `frameRate`). Breadcrumbs and touches travel as rrweb events alongside it [36].
  - PostHog keeps the rrweb schema for both modes. Its `RRWireframe.type` is `text|image|rectangle|input|div|screenshot`, and a screenshot is a wireframe node with a `base64` image [37][12]. PostHog transforms mobile wireframes to rrweb HTML server-side or in the player [12].
  - Smartlook's player toggles between native and wireframe for the same session [15].
- **Search and index**: wireframes carry text and view metadata as data, so text and element search is possible when not masked. Sentry's doc lists "structured data enables querying and analysis" as a wireframe benefit [7]. No vendor publishes a text-search feature built on mobile wireframes (uncertain).
  - Video needs OCR for the same thing. Not observed at any vendor.
- **Compression**:
  - Sentry's doc: wireframe frames compress better as video (flat colours), and moving to structured change events would be "orders of magnitude smaller" (claim, not measured) [7].
  - Measured numbers do not show a consistent gap: Datadog iOS wireframe 12 KB/s vs Sentry iOS video 10 KB/s; Datadog Android wireframe 1.2 KB/s vs Sentry Android video 7 KB/s [27][28][31].
- **Asset storage**: wireframe vendors upload images separately. Datadog and Clarity note higher initial traffic for image-heavy apps and delayed image availability [9][13][31]. Video embeds images per frame.
- **Rendering**: wireframe playback needs a browser-side renderer per wireframe schema. Video needs an HTML5 `<video>` element plus an event overlay.

## 6. Engineering effort signals

Timelines, from first replay PR to milestone:

| Vendor | First replay PR | Public milestone | Elapsed |
|---|---|---|---|
| Datadog | 2022-06-20 (android), 2022-07-11 (ios) [10] | Beta blog 2023-08-03 [38] | ~13 months |
| PostHog | Android wireframe PoC 2023-11-28 [10] | Betas 2024-04, GA blog 2024-10-16 [12] | ~11 months |
| Sentry | cocoa 2024-02-12, RN alpha 2024-03-25, Flutter-Android 2024-05-06 (sentry-java item types 2022-12) [10] | Open beta 2024-07-18 [39], GA 2025-01-14 [40] | ~11 months to GA from the cocoa PR |
| Sentry iOS perf rework | — | View Renderer V2, 2025-08 [29] | ~6 months after GA |

Issue counts (GitHub search `is:issue`, 2026-11-10; keyword hits, so rough):

| Repo | "replay" | Toolkit-specific | Labelled "Replays" |
|---|---|---|---|
| sentry-cocoa | 183 | "replay swiftui" 25 | 70 |
| sentry-java | 113 | "replay compose" 22 | 46 |
| sentry-react-native | 178 | — | 40 |
| sentry-dart | 105 | — | 35 |
| dd-sdk-ios | "session replay" 20 | "swiftui" 14 | — |
| dd-sdk-android | "session replay" 21 | "compose" 7 | — |
| dd-sdk-reactnative | "session replay" 42 | — | — |
| dd-sdk-flutter | "session replay" 19 | — | — |
| posthog-ios | 65 | "swiftui" 16 | — |
| posthog-android | 37 | "compose" 6 | — |
| posthog-flutter | 54 | — | — |
| posthog-js (RN, keyword) | 88 | — | — |
| bitdrift capture-sdk | 4 | — | — |
| microsoft/clarity-apps | 13 | — | — |

Caveats on the counts:
- Sentry uses GitHub for internal tasks too, and Datadog routes many reports through support.
- Counts reflect process as much as bug rate.

Which method needs per-UI-toolkit work:
- **Wireframe**: needs a mapper per toolkit (UIKit, SwiftUI, Android Views, Compose, Flutter widgets). Datadog ships a separate Compose module and an experimental SwiftUI mode [9]. Clarity ships `clarity-compose` [13]. PostHog: SwiftUI/Compose "not a 1:1 match" [12].
  - Sentry's internal doc lists "heuristic complexity", "maintenance burden" and "SwiftUI challenges" as wireframe disadvantages [7].
  - Custom views need categorizers (bitdrift) [22].
- **Screenshot**: pixel capture is toolkit-agnostic. Masking still needs per-toolkit detection: SwiftUI layer classes, RN classes and Compose semantics are listed explicitly in Sentry's redaction builder [7]. It also breaks on OS rendering changes (Liquid Glass) [33].
  - Sentry is exploring accessibility-tree and on-device ML region detection to reduce this [7].
  - Performance work is per platform: renderer rewrite on iOS [29], PixelCopy vs Canvas on Android [3].
- **Cross-platform frameworks**:
  - Video vendors reuse native capture for RN (Sentry) or do a Dart-side screenshot for Flutter (Sentry, PostHog).
  - Wireframe vendors need a Flutter widget-tree walker (Datadog, still Preview) [9].
  - PostHog chose screenshot-only for RN and Flutter [11].

## Sources

Dates are publication or last-modified where shown. Otherwise "accessed 2026-11-10".

1. Sentry, Session Replay for Mobile (product docs), https://docs.sentry.io/product/explore/session-replay/mobile — accessed 2026-11-10
2. Same page (capture rate, masking description, defaults) — accessed 2026-11-10
3. Sentry Android Session Replay setup (PixelCopy/Canvas, captureSurfaceViews), https://docs.sentry.io/platforms/android/session-replay — accessed 2026-11-10
4. Sentry React Native Session Replay, https://docs.sentry.io/platforms/react-native/session-replay — accessed 2026-11-10
5. Sentry Flutter Session Replay, https://docs.sentry.io/platforms/flutter/session-replay/ — accessed 2026-11-10
6. getsentry/sentry-dart `packages/flutter/lib/src/screen_capture/recorder.dart` (main branch), https://github.com/getsentry/sentry-dart — accessed 2026-11-10
7. getsentry/sentry-cocoa `develop-docs/VIEW_MASKING_STRATEGIES.md` (last commit 2025-11-21), https://github.com/getsentry/sentry-cocoa/blob/main/develop-docs/VIEW_MASKING_STRATEGIES.md
8. Datadog, Mobile Session Replay, https://docs.datadoghq.com/session_replay/mobile/ — accessed 2026-11-10
9. Datadog, Session Replay troubleshooting (mobile limits), https://docs.datadoghq.com/session_replay/mobile/troubleshooting/ — accessed 2026-11-10
10. GitHub search, earliest merged PR with "replay" in title: DataDog/dd-sdk-android #953 (2022-06-20), dd-sdk-ios #924 (2022-07-11), dd-sdk-reactnative #559 (2023-11-27), PostHog/posthog-android #69 (2023-11-28), posthog-ios #115 (2024-03-11), posthog-flutter #116 (2024-09-22), getsentry/sentry-cocoa #3625 (2024-02-12), sentry-react-native #3714 (2024-03-25), sentry-dart #2032 (2024-05-06), sentry-java #2441 (2022-12-23) — queried 2026-11-10
11. PostHog, Mobile session replay docs, https://posthog.com/docs/session-replay/mobile — accessed 2026-11-10
12. PostHog blog, "How we built mobile replay (and why it took so long)", https://posthog.com/blog/mobile-session-replay — 2024-10-16
13. Microsoft Clarity, Mobile SDK overview, https://learn.microsoft.com/en-us/clarity/mobile-sdk/mobile-sdk-overview — updated 2026-10-20
14. FullStory help, Intro to Fullstory for Mobile Apps, https://help.fullstory.com/hc/en-us/articles/4414642861463 ; developer docs https://developer.fullstory.com/mobile/getting-started/ — accessed 2026-11-10
15. Smartlook, Rendering modes, https://mobile.developer.smartlook.com/docs/rendering-modes ; SDK 2.1 changelog https://mobile.developer.smartlook.com/changelog/smartlook-analytics-21-release — accessed 2026-11-10
16. UXCam, How Session Recording Works, https://developer.uxcam.com/docs/how-session-recording-works — accessed 2026-11-10
17. Luciq, iOS Session Replay setup, https://docs.luciq.ai/ios/setup-luciq-for-ios/setup-session-replay — accessed 2026-11-10
18. Luciq, Android Video-Like Replay, https://docs.luciq.ai/android/set-up-luciq-for-android/set-up-session-replay/video-like-replay — accessed 2026-11-10
19. Contentsquare, iOS Session Replay (classic), https://docs.contentsquare.com/en/ios/session-replay/ — modified 2026-10-14
20. Contentsquare support FAQ / Android session replay, https://support.contentsquare.com/hc/en-us/articles/37271667148561 ; https://docs.contentsquare.com/en/android/session-replay/ — accessed 2026-11-10
21. bitdrift blog, "Mobile session replay", https://blog.bitdrift.io/post/mobile-session-replay — 2026-02-19
22. bitdrift SDK docs, Automatic instrumentation / Session Replay, https://docs.bitdrift.io/sdk/features/automatic-instrumentation ; source https://github.com/bitdriftlabs/capture-sdk/tree/main/platform/swift/source/replay — accessed 2026-11-10
23. bitdriftlabs/capture-sdk PR #93 "use new apis for screen capture, add support for screenshot capture", https://github.com/bitdriftlabs/capture-sdk/pull/93 — 2024-11-01
24. LogRocket, Mobile Feature Support, https://docs.logrocket.com/docs/mobile-feature-support — accessed 2026-11-10
25. Datadog integration page describing Embrace, https://docs.datadoghq.com/integrations/embrace-mobile — accessed 2026-11-10 (no Embrace primary doc found; uncertain)
26. Grafana Cloud Frontend Observability session replay docs, https://grafana.com/docs/grafana-cloud/monitor-applications/frontend-observability/session-replay/ ; npm `@grafana/faro-instrumentation-replay` — accessed 2026-11-10
27. Sentry iOS Replay performance overhead, https://docs.sentry.io/platforms/apple/guides/ios/session-replay/performance-overhead — accessed 2026-11-10
28. Sentry Android Replay performance overhead, https://docs.sentry.io/platforms/android/session-replay/performance-overhead/ — accessed 2026-11-10
29. Sentry blog, "Boosting Session Replay performance on iOS with View Renderer V2", https://blog.sentry.io/boosting-session-replay-performance-on-ios-with-view-renderer-v2 — 2025-08-06
30. Sentry Flutter Replay performance overhead, https://docs.sentry.io/platforms/dart/guides/flutter/session-replay/performance-overhead/ — accessed 2026-11-10
31. Datadog, Mobile Session Replay impact on app performance, https://docs.datadoghq.com/session_replay/mobile/app_performance — accessed 2026-11-10
32. PostHog/posthog-ios CHANGELOG.md (entries 9b7e911, 91dffb3, 6c921e2, 6e52f5c, 910b82c), https://github.com/PostHog/posthog-ios/blob/main/CHANGELOG.md — accessed 2026-11-10
33. getsentry/sentry-cocoa #6389 (PR, PII-leak detection disabling replay) and #6390 (Liquid Glass masking), https://github.com/getsentry/sentry-cocoa/issues/6390 — 2025-10-09
34. Datadog, Mobile Session Replay privacy options, https://docs.datadoghq.com/session_replay/mobile/privacy_options/ — accessed 2026-11-10
35. getsentry/sentry-cocoa #8126 "Verify Session Replay and screenshot masking on xOS 27", https://github.com/getsentry/sentry-cocoa/issues/8126 — 2026-06-19
36. getsentry/sentry-java `sentry/src/main/java/io/sentry/rrweb/RRWebVideoEvent.java`, https://github.com/getsentry/sentry-java — accessed 2026-11-10
37. PostHog/posthog-ios `PostHog/Replay/RRWireframe.swift`, https://github.com/PostHog/posthog-ios — accessed 2026-11-10
38. Datadog blog, Mobile Session Replay, https://www.datadoghq.com/blog/mobile-session-replay/ — 2023-08-03
39. Sentry blog, "Announcing Session Replay for Mobile in open beta", https://blog.sentry.io/announcing-session-replay-for-mobile-in-open-beta — 2024-07-18
40. Sentry blog, "Session Replay for Mobile is now generally available", https://blog.sentry.io/session-replay-for-mobile-is-now-generally-available-see-what-your-users-see — 2025-01-14

Not confirmed (uncertain): New Relic mobile session replay method (docs fetch failed); Heap mobile replay (routes to Contentsquare); LogRocket and Contentsquare exact capture mechanism; Metal/OpenGL behaviour under screenshot capture on iOS; keyboard capture in Sentry/PostHog screenshot modes.
