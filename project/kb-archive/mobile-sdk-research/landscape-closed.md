# Appendix H: closed mobile RUM / replay vendors and the product feature matrix

Written 2026-10-29. Covers vendors whose native SDKs are closed or whose product is studied from documentation: UXCam, Smartlook, Fullstory, LogRocket, Amplitude, Mixpanel, Contentsquare (with Heap and Hotjar), Dynatrace, New Relic, Splunk RUM / AppDynamics, Firebase, BugSnag, Glassbox, Quantum Metric, Medallia DXA, Userback, Shake, Bugfender, Microsoft App Center. It also holds the cross-vendor **feature matrix** (§6.1), which includes Sentry, PostHog, Luciq, Embrace, Datadog and OpenReplay. Those rows come from docs; Appendices A–G hold the code-grounded detail.

Provenance labels:
- `[docs only]`: vendor documentation or changelog, URL given.
- `[blog only]`: vendor blog or marketing page.
- `[code]`: open wrapper or open SDK source, cited as `repo/path:line @ sha`.
- `[header]`: public Swift interface or header shipped inside a published package (read, never run).
- `[3rd party]`: press, a patent, or a competitor page.

Where a vendor publishes the same fact in two places that disagree, both are quoted.

---

## 1. Sources

### 1.1 Repositories read (shallow clones in the scratchpad, nothing built or run)

| Repo | Commit | License | What it is |
|---|---|---|---|
| newrelic/newrelic-ios-agent | `4e9c85e9e34475082808bd3a421006e2bf7b45e5` (2026-10-27) | Apache-2.0 | Full iOS agent including `Agent/SessionReplay/` |
| newrelic/newrelic-android-agent | `48198a29df0c29bc2606482c508e7676051bf231` (2026-10-21) | Apache-2.0 | Full Android agent including `sessionReplay/` and `performance.md` |
| mixpanel/mixpanel-ios-session-replay-package | `8ce38fc53ed1babc395865d0e8f058c0a73d3442` (2.0.0) | Apache-2.0 | Full iOS replay source (7.8k lines Swift) |
| mixpanel/mixpanel-flutter-session-replay | `7ced8fcff0c48a208831a009abacad836a2343e2` (0.1.0-beta.4) | Apache-2.0 | Flutter replay, pure Dart capture |
| mixpanel/mixpanel-react-native-session-replay | `5b08d993a3f931bb33283efb04eeac836daf5d6e` | MIT | RN bridge to native replay SDKs |
| amplitude/AmplitudeSessionReplay-iOS | `d68813b483478ce04b4362d7b093a9f6b40aea19` (0.16.0, 2026-10-24) | MIT wrapper; core is a **binary** xcframework | Read `Package.swift` and the shipped `.swiftinterface` only |
| amplitude/AmplitudeSessionReplay-Android | `3af13ddb3ec5bfe8a1d908a914ff4d94b2328aa6` | none | README only (issue tracker) |
| uxcam/flutter-plugin | `1ff567a844f777fb92b129f07bfbe6b7e5bfd54d` (2.10.3) | BSD-3-Clause | Flutter plugin over the closed native SDK |
| uxcam/react-native-ux-cam | `4e8c0d92d204d122fb18ab2ccf19b996060f26f6` (6.0.25) | BSD-3-Clause | RN wrapper |
| uxcam/uxcam-ios | `5a48d6788392e0dcb551fbd508bf2e7962b231f9` | n/a | SwiftPM shell around a binary `UXCam.xcframework.zip` |
| fullstorydev/fullstory-react-native | `6464975f21e25376ce849ced598ae47253d2a8b5` (1.10.3) | MIT | RN wrapper and babel plugins |
| fullstorydev/fullstory-swift-package-ios | `02802f49ef50103a61cd9c2f349d16cae39e76d5` | n/a | SwiftPM shell around a binary xcframework |
| LogRocket/logrocket-ios-swift-package | `d2b84ff447e323a2bba775f563b64496dcd30980` | n/a | SwiftPM shell around a binary xcframework (3.15.0) |
| signalfx/splunk-otel-ios | `99e4b0549b3460bf4f4f570fea5e02b34d56d4c8` | Apache-2.0 | OTel-based iOS agent; replay pulled as binaries (read `Package.swift` only) |

### 1.2 Main documentation entry points

- UXCam: https://developer.uxcam.com/docs/how-session-recording-works, https://developer.uxcam.com/docs/understanding-occlusion, https://help.uxcam.com/en/articles/10426267-sdk-integration-faqs, https://developer.uxcam.com/docs/ios-changelog
- Smartlook: https://mobile.developer.smartlook.com/docs/rendering-modes, https://mobile.developer.smartlook.com/reference/ios-preferences-state, https://www.smartlook.com/pricing/ (end of life)
- Fullstory: https://developer.fullstory.com/mobile/getting-started/, https://help.fullstory.com/hc/en-us/articles/4414642861463, https://www.fullstory.com/blog/mobile-app-analytics-privacy/
- LogRocket: https://docs.logrocket.com/docs/introduction-to-logrocket-mobile, https://docs.logrocket.com/docs/performance-impact-of-the-mobile-sdk, https://docs.logrocket.com/docs/mobile-feature-support
- Amplitude: https://amplitude.com/docs/session-replay/session-replay-ios-plugin, https://amplitude.com/docs/session-replay/session-replay-android-plugin, https://amplitude.com/blog/session-replay-mobile
- Mixpanel: https://docs.mixpanel.com/docs/session-replay/implement-session-replay/session-replay-ios, https://docs.mixpanel.com/changelogs/2025-08-13-mobile-sr
- Contentsquare: https://docs.contentsquare.com/en/csq-sdk-android/experience-analytics/session-replay/, https://docs.contentsquare.com/en/csq-sdk-android/experience-analytics/impact-on-performance/, https://docs.contentsquare.com/en/csq-sdk-flutter/experience-analytics/session-replay/
- Dynatrace: https://docs.dynatrace.com/docs/observe/digital-experience/session-replay/session-replay-ios, https://docs.dynatrace.com/docs/observe/digital-experience/session-replay/session-replay-android
- New Relic: https://docs.newrelic.com/docs/mobile-monitoring/mobile-monitoring-ui/mobile-session-replay/introduction (and the `set-up-session-replay`, `configure-privacy-settings` and `additional-information` pages in the same directory)
- Splunk / AppDynamics: https://help.splunk.com/en/splunk-observability-cloud/monitor-end-user-experience/real-user-monitoring/replay-user-sessions/record-ios-sessions, https://help.splunk.com/en/appdynamics-on-premises/end-user-monitoring/26.3.0/end-user-monitoring/mobile-real-user-monitoring/overview-of-the-controller-ui-for-mobile-rum/session-replay-for-mobile-rum
- Medallia DXA: https://developer.medallia.com/medallia-dxa/docs/session-replay-5.md, https://developer.medallia.com/medallia-dxa/docs/mobile-sdk-overview
- Quantum Metric: https://quantummetric.com/platform/performance, patent US11574114 (https://patents.google.com/patent/US11574114)
- Firebase: https://firebase.google.com/docs/crashlytics, https://firebase.google.com/docs/perf-mon
- BugSnag: https://docs.bugsnag.com/performance/
- App Center: https://learn.microsoft.com/en-us/appcenter/retirement

### 1.3 Open-source status at a glance

| Vendor | Native SDK | RN / Flutter wrappers | Replay viewer |
|---|---|---|---|
| UXCam | closed binary [code: uxcam-ios Package.swift:40-42 @ 5a48d67] | open, BSD-3 (RN, Flutter, Cordova, Unity, KMP) | closed |
| Smartlook | closed | RN on npm `react-native-smartlook-analytics` (MIT, no current repo; the 2020 repo is archived); Flutter on pub.dev | closed |
| Fullstory | closed binary [code: fullstory-swift-package-ios Package.swift:13-15 @ 02802f4] | open, MIT (RN, babel plugins, Flutter; Flutter repo "being archived") | closed |
| LogRocket | closed binary [code: logrocket-ios-swift-package Package.swift:16-18 @ d2b84ff] | RN and Flutter MIT on npm and pub.dev, no source repo found | closed |
| Amplitude | iOS: MIT wrapper around a **binary** core [code: AmplitudeSessionReplay-iOS Package.swift:32 @ d68813b]; Android closed | RN replay plugin MIT (Amplitude-TypeScript monorepo) [docs only] | closed |
| Mixpanel | **open**, Apache-2.0 (iOS full source; Android in mixpanel-android) | open (RN MIT, Flutter Apache-2.0) | closed |
| New Relic | **open**, Apache-2.0, replay included | open | closed |
| Splunk RUM | OTel agent open (Apache-2.0); **replay core is closed binaries from Smartlook's CDN** [code: splunk-otel-ios Package.swift:764-855 @ 99e4b05] | RN, Flutter open; replay binary inside | closed |
| Contentsquare / Heap | closed | RN bridge MIT on npm | closed |
| Dynatrace, AppDynamics, Glassbox, Quantum Metric, Medallia DXA | closed | Quantum Metric RN library on npm; others nf | closed |
| Firebase | open, Apache-2.0 | open | n/a (no replay) |
| BugSnag | open, MIT | open | n/a |
| Shake, Bugfender | closed binary ("modification are not allowed" license) | wrappers on GitHub | n/a |
| Userback | MIT wrappers (widget-ios, -android, -react-native) | open | n/a |

---

## 2. Platforms and languages

`y` = supported, `R` = supported **with session replay**, `-` = not supported, `?` = not found. ObjC and Java are `y` when the public API is callable from them (an ObjC header, `@objc` interface, or a Java wrapper calling it).

| Vendor | iOS Swift | iOS ObjC | SwiftUI | Android Kotlin | Android Java | Compose | React Native | Flutter | Others | Source |
|---|---|---|---|---|---|---|---|---|---|---|
| UXCam | R | R ¹ | R | R | R ¹ | R | R | R | Xamarin, MAUI, Cordova, Ionic, Capacitor, Unity, KMP, NativeScript | [docs only] https://help.uxcam.com/en/articles/10426267-sdk-integration-faqs |
| Smartlook (EOL) | R | R | R (wireframe 2.1) | R | R | R | R (wireframe Android only) | R (iOS 13+, API 21+) | Ionic, Cordova, Unity | [docs only] https://mobile.developer.smartlook.com/docs/rendering-modes |
| Fullstory | R | R ² | R | R | R | R (Compose 1.0–1.9) | R | R (Flutter 3.32+, early access) | Cordova/Capacitor via the browser API | [docs only] https://developer.fullstory.com/mobile/getting-started/ |
| LogRocket | R | ? | R (`lrHide()`) | R | R | R (1.8–1.10) | R (incl. Expo, New Arch) | R | Ionic (marketing only) | [docs only] https://docs.logrocket.com/docs/introduction-to-logrocket-mobile |
| Amplitude | R (iOS 13+) | R ³ | R | R (API 21+) | R | alpha | R | R (early access) | Segment plugins | [docs only] + [header] |
| Mixpanel | R (2.x: iOS 15+, 1.x: iOS 13+) | partial ⁴ | R | R (API 21+) | R | R | R (RN 0.76+) | R (beta, 3.38+) | - | [docs only] + [code] |
| Contentsquare | R (iOS 13+) | R | R | R (API 23+) | R | R | R | R | Cordova, Capacitor | [docs only] https://docs.contentsquare.com/en/csq-sdk-ios/experience-analytics/compatibility/ |
| Dynatrace | R | R | R | R | R | R (8.325+) | y (no replay) | y (no replay) | Cordova, Xamarin, MAUI (no replay) | [docs only] |
| New Relic | R | R | R | R | R | R | R | y (replay "planned") | Cordova, Capacitor, MAUI, Unity, Unreal | [docs only] + [code] |
| Splunk RUM / AppD | R | R | R | R | R | R | R | R | - | [docs only] |
| Glassbox | R | ? | ? | R | R | R | R | R | Xamarin, Cordova, Ionic, Capacitor | [blog only] https://www.glassbox.com/platform/mobile-app-analytics/ |
| Quantum Metric | R | ? | ? | R | R | ? | R | R | Cordova, Ionic | [blog only] https://www.quantummetric.com/platform/mobile-app-analytics |
| Medallia DXA | R (iOS 13+) | ? | R | R (works on API 29+) | R | R | R | R | - | [docs only] https://developer.medallia.com/medallia-dxa/llms.txt |
| Firebase | y | y | y | y | y | y | - (no first-party) | y | Unity, C++ | [docs only] |
| BugSnag | y | y | y | y | y | y | y | y | Unity, .NET | [docs only] |
| Shake | y | y | y (no masking) | y | y | y | y | y | Web | [docs only] |
| Userback | y (iOS 15+) | ? | ? | y (API 21+) | ? | ? | y | - | - | [docs only] |
| Bugfender | y | y | ? | y | y | ? | y | y | MAUI, Unity, Capacitor, Cordova | [docs only] |

Footnotes:
1. The UXCam RN bridge imports `<UXCam/UXCam.h>` from Objective-C++ [code: react-native-ux-cam uxcam-react-wrapper/ios/RNUxcam/RNUxcam.mm:2-4 @ 4e8c0d9]. The Android bridge is Java (`RNUxcamModuleImpl.java`), so the native APIs are ObjC- and Java-callable.
2. Fullstory RN imports `<FullStory/FS.h>` [code: fullstory-react-native ios/FullStory.h:2 @ 6464975].
3. Every public type in the Amplitude replay module is `@objc` (`AMPSessionReplay`, `AMPSessionReplayPlugin`) [header: AmplitudeSessionReplay.framework/Modules/AmplitudeSessionReplay.swiftmodule/arm64-apple-ios.swiftinterface:68,125 @ d68813b].
4. `MPSessionReplay` is a Swift `open class` with no `@objc` [code: mixpanel-ios-session-replay-package MixpanelSessionReplay/MixpanelSessionReplay/MPSessionReplay.swift:15 @ 8ce38fc].

---

## 3. RUM (what each closed vendor captures besides replay)

| Vendor | Crashes | ANR / hangs | App start | Slow / frozen frames | Screens | Network | Frustration signals | Source |
|---|---|---|---|---|---|---|---|---|
| UXCam | y (uploaded next launch) | y; "UI freeze" threshold 1 s Android, 2 s iOS/RN | nf | nf | y | contradictory: iOS changelog 3.4.0 adds network logs, FAQ says "not supported" | rage taps, unresponsive taps, rage quits | [docs only] https://developer.uxcam.com/docs/crashes-anrs |
| Smartlook | y (stack traces, Gradle crash plugin) | nf | nf | nf | y | Android OkHttp interceptor; manual on iOS | rage clicks | [docs only] https://mobile.developer.smartlook.com/reference/android-network-tracking-interception |
| Fullstory | y (`nativemobile.event.crash`) | nf | nf | nf | y (pages) | y (URL, method, status, timing; headers and bodies from 1.66) | error clicks, force restart | [docs only] https://help.fullstory.com/hc/en-us/articles/6505196019351 |
| LogRocket | y (JVM, NSException, Mach, C++) | nf | y | nf | y | y | rage clicks, CPU, memory | [docs only] https://docs.logrocket.com/docs/mobile-feature-support |
| Amplitude | nf | nf | nf | nf | y (analytics) | nf | rage/dead clicks (all plans) | [docs only] https://amplitude.com/docs/session-replay |
| Mixpanel | nf (console errors with stack) | nf | nf | nf | y | y (off by default) | rage / dead taps | [docs only] https://docs.mixpanel.com/docs/session-replay |
| Contentsquare | y (JVM; "C or C++ are not supported") | nf | nf | nf | y | API errors (HTTP ≥400) | zone heatmaps | [docs only] https://docs.contentsquare.com/en/csq-sdk-android/experience-analytics/error-analysis/ |
| Dynatrace | y | y (Android 11+) | y (thresholds) | nf | y (user actions) | y | n/a | [docs only] https://docs.dynatrace.com/docs/observe/digital-experience/mobile-applications |
| New Relic | y + handled exceptions | y | y | nf | y | y | n/a | [docs only] https://docs.newrelic.com/docs/mobile-monitoring/mobile-monitoring-ui/application-not-responding |
| Splunk RUM | y | y | y | y (SlowFrameDetector) | y | y | n/a | [code] signalfx/splunk-otel-android `integration/` modules, per the docs subagent |
| Medallia DXA | y (on by default) | nf | nf | nf | y | HTTP errors | DX score | [docs only] https://developer.medallia.com/medallia-dxa/docs/crash-reporter-2.md |
| Quantum Metric | y | nf | load times | nf | y | API lag, slow APIs | heatmaps | [blog only] https://www.quantummetric.com/platform/mobile-app-analytics |
| Glassbox | y | nf | nf | nf | y | y | interaction maps | [blog only] https://www.glassbox.com/blog/glassbox-for-mobile-apps/ |
| Firebase | y (Crashlytics, NDK) | y (Android 11+, next launch) | y | y (screen rendering) | y | y | n/a | [docs only] https://firebase.google.com/docs/perf-mon |
| BugSnag | y | y (ANR, app hangs) | y | y (slow >16 ms, frozen >700 ms) | y | y | n/a | [docs only] https://docs.bugsnag.com/performance/system-metrics/rendering-metrics/ |

Takeaway: the product-analytics replay vendors (UXCam, Fullstory, Amplitude, Mixpanel, Contentsquare, Smartlook) document **no app-start or frame metrics**. The APM vendors (Dynatrace, New Relic, Splunk, Firebase, BugSnag) document both.

---

## 4. Session replay

### 4.1 Per-vendor technique

| Vendor | Technique (taxonomy §4.3) | Native vs RN vs Flutter | Masking default and APIs | Cadence and sampling | Source |
|---|---|---|---|---|---|
| UXCam | **Screenshot video**. The docs disagree on where the video is built: on device per the FAQ ("timed screenshots captured by the SDK", encoded to video) vs server side per the dev docs ("Video is reconstructed server-side"). The "schematic" wireframe opt-in was deprecated in iOS 3.8.0 (Apr 2026). | RN and native capture is done by the native SDK. **Flutter is a hybrid**: native asks Dart over a MethodChannel; Dart answers with occlusion rects and, optionally, raw RGBA pixels of the Flutter layer tree from `rootLayer.toImage`. See §4.2. | Only passwords and card/SSN fields are masked by default. APIs: `occludeSensitiveScreen`, `occludeSensitiveView`, `occludeAllTextFields`, blur (radius 20) and overlay; dashboard rules override the SDK; "AI Occlusion" since 3.7.1. | fps nf; 4 quality levels, default Low; Wi-Fi-only upload by default; random sampling plus rules; upload on background. | [docs only] https://developer.uxcam.com/docs/how-session-recording-works, https://help.uxcam.com/en/articles/10426267-sdk-integration-faqs; [code] §4.2 |
| Smartlook (EOL) | **Hybrid, selectable**. `renderingMode` = native (default) / wireframe / noRendering. In native mode, frames are captured and assembled **and** a wireframe is recorded in parallel; the player can switch between them. | RN wireframe is Android-only; not on Cordova. Flutter wireframe from 4.1.0 needs `SmartlookRecordingWidget`. Whether Flutter capture runs in Dart or native: nf. | Android `EditText` and `WebView` sensitive by default; `isSensitive` per instance or class, XML tag, Compose `Modifier.smartlook(isSensitive=…)`, `RecordingMask` (COVERING / ERASING), all on device. | "default frame rate used by the SDK is 2 frames per second" (range 2–10, adaptive, remotely settable); Wi-Fi only by default. | [docs only] https://mobile.developer.smartlook.com/reference/ios-preferences-state |
| Fullstory | **Wireframe / vector from draw operations**. It "never captures screenshots"; the keyboard is mocked in playback. Async (default) or sync capture mode with a remotely overridable scan interval. | Flutter: the Dart plugin feeds the native SDK and gives "visual wireframe replay"; shaders render as black boxes; images are opt-in (`captureImages: true`). RN annotates the native views (`fsClass`, `fsAttribute`, `fsTagName`) [code: fullstory-react-native src/fullstoryInterface.ts:26-29 @ 6464975]. | **Private by default** ("requires Private by Default"): all text and images masked at source. `FS.mask` / `unmask` / `exclude`, `fs-*` classes, Flutter `FSMask` widgets, Compose modifiers; selector rules in the web UI with preview; server-side redaction. | "scanned periodically"; no fps given. | [docs only] https://help.fullstory.com/hc/en-us/articles/4414642861463, https://help.fullstory.com/hc/en-us/articles/35177087456535, https://help.fullstory.com/hc/en-us/articles/27461129353239 |
| LogRocket | **Hybrid**: view capture with bitmaps, falling back to wireframe for the rest of the elements when capture exceeds its timeout (`viewCaptureAdditionalWireframeDuration`). The player flags wireframe sessions. Marketed as "video replay". | Flutter: `LogRocketWidget` with `screenshotSimilarityThreshold=0.01`, which points to image diffs. Dart vs native: nf. | Tag-based: `lr-hide` redacted, `lr-show` allowed, `redactView` / `allowView`, `textSanitizer` EXCLUDED draws black bars; Compose secure fields auto-sanitised from 2.3.3. Masking default nf. | "on average just once per second"; idle throttling since 3.0.1; conditional recording is a paid add-on. | [docs only] https://docs.logrocket.com/docs/performance-impact-of-the-mobile-sdk, https://docs.logrocket.com/reference/flutter-view-capture.md |
| Amplitude | **Hybrid** (docs say view tree; the shipped interface handles images). The docs: "full snapshot of the app's view tree", then "each view change as a diff". The same page says `quality` "Controls capture and encoding quality (for example, frame rate and image resolution)". The interface imports AVFoundation, IOSurface and Metal and exposes `CGImage.cropping`. WebViews are recorded by an injected rrweb recorder (`webview.js`, 195 kB). | RN uses the native libraries; Flutter technique nf. | `MaskLevel` light / **medium (default)** / conservative; `amp_isBlocked`, SwiftUI `amp_setBlocked`; Remote Config can override. | `sampleRate` default **0**; `quality` default `.high`, `.automatic` picks by device. | [docs only] https://amplitude.com/docs/session-replay/session-replay-ios-plugin; [header] swiftinterface:5,14,16,22,28,38,46-49,79 @ d68813b |
| Mixpanel | **Screenshot frames** (JPEG at quality 0.4, embedded as base64 `<img>` in rrweb-style events). An optional **wireframe beta** (1.6.0, Sep 2026) emits a structured element list next to each screenshot for "Mixpanel Agent", not as a replacement. | RN wraps the native SDKs. **Flutter captures in Dart** (`RepaintBoundary.toImage`) and encodes JPEG natively. See §4.2. | `autoMaskedViews` default image, text, web, map; inputs always masked; `mpReplaySensitive`, `addSensitiveView`; Flutter `MixpanelMask` / `MixpanelUnmask`. | Capture on touch / screen change, rate-limited to one frame per **500 ms**; `recordingSessionsPercent` default 100; flush every 10 s; `wifiOnly` default **true**. | [code] §4.2; [docs only] https://docs.mixpanel.com/docs/session-replay/implement-session-replay/session-replay-ios |
| Contentsquare (+ Heap) | **Wireframe / view-hierarchy** reconstruction. Masked elements are shown as pixelated or blurred images; text is replaced by asterisks or same-length characters. | RN delegates to native. Flutter "rebuilds the app's tree structure" in the SDK: every 200 ms at High, only when interaction stops at Low. Heap mobile replay **is** the Contentsquare SDK plus a bridge. Hotjar has no native SDK (its recordings page redirects to Contentsquare). | Everything masked by default; inputs always masked; APIs by instance, type and parent, Compose `CsqMask`; remote Data Masking tab outranks code. | High / Medium / Low (fps not published), separate for Wi-Fi and cellular; degrades to 1 fps under main-thread load; percent of sessions plus event-triggered replay. | [docs only] https://docs.contentsquare.com/en/csq-sdk-android/experience-analytics/session-replay/, https://docs.contentsquare.com/en/csq-sdk-flutter/experience-analytics/session-replay/, https://developers.heap.io/docs/syncing-heap-data-to-contentsquare |
| Dynatrace | **Event plus image reconstruction**, "video-like"; exact capture method nf. Image upload can be limited to Wi-Fi. | **Native only**: no replay on RN, Flutter, Cordova, Xamarin, tvOS or iPadOS. | Masking levels **Safest (default)** / Safe / Custom; iOS `MaskingConfiguration`, Android `addMaskedView`, Compose `dtMask()`. | 0–100% full sessions plus **"Session Replay on crashes"** (100% of crash sessions). | [docs only] https://docs.dynatrace.com/docs/observe/digital-experience/session-replay/session-replay-ios |
| New Relic | **Wireframe / DOM in rrweb format**. The agent "transforms the viewport into HTML"; full and incremental rrweb snapshots; "not pixel perfect"; camera, map and video views become placeholders; unmasked images are inlined as PNG data URIs. | Native and RN Views; Flutter, MAUI, Cordova, Capacitor and WebViews "planned". | Default strategy masks all text and images; Custom has 4 toggles (app text, user input, images, touches) delivered from the server; `nr-mask` / `nr-unmask` / `nr-block` via `accessibilityIdentifier`; class rules on the server. | iOS frame tick every **1 s**; uploads gzipped JSON every 1 min; session and **error** sample rates (error mode keeps a 15 s ring buffer in code, 30 s per docs); 4 h cap. | [code] §4.2; [docs only] https://docs.newrelic.com/docs/mobile-monitoring/mobile-monitoring-ui/mobile-session-replay/introduction |
| Splunk RUM / AppDynamics | **Hybrid, the Smartlook engine**. NATIVE mode "periodically captures the screen", redacts on device and compiles a video, with a wireframe recorded at the same time; WIREFRAME_ONLY sends JSON. The iOS agent pulls `cisco-video-encoder`, `cisco-screenshot` and `cisco-wireframe` binaries from `sdk.smartlook.com/cisco-session-replay/`. | Same engine on RN and Flutter (binary vendored). | `UITextView`, `UITextField`, `WKWebView` and `EditText` sensitive by default; per instance, class, XML tag `sr_sensitivity`, `RecordingMask`. | "at its own rate", publishes "several times per minute"; Flutter `samplingRate` default 0.2. | [docs only] https://help.splunk.com/en/splunk-observability-cloud/monitor-end-user-experience/real-user-monitoring/replay-user-sessions/record-ios-sessions; [code] splunk-otel-ios Package.swift:806,813,820 @ 99e4b05 |
| Medallia DXA | **Screen video**: "records video of the entire screen", default **6 fps**, encrypted on device; pauses when CPU is above 70%. | nf | Inputs and webviews masked by default (the rest unmasked); live config can mask screens by name. | Random or weighted sampling in the portal; `setRetention` forces a session in or out. | [docs only] https://developer.medallia.com/medallia-dxa/docs/session-replay-5.md |
| Quantum Metric | **Wireframe / DOM**: "We translate native app views into HTML (DOM)"; the patent describes view-to-document mapping with diffs; plays in the web replay engine. | nf | RN `QuantumComponent` masks or encrypts text; native default nf. | nf | [blog only] https://quantummetric.com/platform/performance; [3rd party] https://patents.google.com/patent/US11574114 |
| Glassbox | "video-like session replays"; method undisclosed. A 2019 press report described screenshots. | nf | "PII masked by default", rules changed "without redeploying". | nf | [blog only] https://www.glassbox.com/blog/glassbox-for-mobile-apps/; [3rd party] AppleInsider 2019 |
| Shake | Not replay: screenshot plus optional 15 s auto screen recording (off by default, OS permission prompt); session replay is web only. | same | `addPrivateView` removes views from screenshots but "won't delete sensitive views from auto screen recording". | n/a | [docs only] https://docs.shakebugs.com/docs/react/configuration-and-data/auto-screen-recording |
| Userback | Not replay: annotated screenshot plus console, network and device data; replay works only for web-view apps. | same | nf | n/a | [docs only] https://docs.userback.io/docs/ios-android |
| Firebase, BugSnag, Bugfender, App Center | **No replay.** | | | | [docs only] |

### 4.2 Code-grounded notes

**Mixpanel iOS: screenshot frames inside rrweb events**
- Frames: `view.drawHierarchy(in:afterScreenUpdates:false)` [code: mixpanel-ios-session-replay-package MixpanelSessionReplay/MixpanelSessionReplay/Tracking/ScreenRecorder.swift:200 @ 8ce38fc].
- Encoding: JPEG at quality 0.4 (`ScreenRecorder.swift:236`, `Utils/Constants.swift:151`).
- Wire: the frame is embedded as `data:image/jpeg;base64,…` in an rrweb-style node (`Utils/MPSessionReplayEncoder.swift:92`), and the batch is gzipped (`Network/FlushRequest.swift:41`).
- Rate limit: a capture runs only if the screen is dirty and 500 ms have passed since the last one (`MPSessionReplayInstance.swift:341-345`, `Constants.swift:139`).
- Defaults: `wifiOnly = true` (`Models/MPSessionReplayConfig.swift:71`), `recordingSessionsPercent = 100` (`:81`), `autoMaskedViews = [.image, .text, .web, .map]` (`:102`).
- Wireframes are an extra `mp_wireframe` custom event and are off when `wireframesOptions == nil` (`:211`, `Wireframe/WireframeEmitter.swift:15`). CHANGELOG 1.6.0: "wireframes (beta)".

**Mixpanel Flutter: captured in Dart**
- Capture: `boundary.toImage(pixelRatio: 1.0)` [code: mixpanel-flutter-session-replay lib/src/internal/screenshot_capturer.dart:127 @ 7ced8fc].
- Encoding: RGBA is handed over a MethodChannel to `Bitmap.compress` / `UIImage.jpegData` (`lib/src/internal/native_image_compressor.dart:3-6`).
- Minimum interval: 500 ms (`lib/src/internal/capture/capture_scheduler.dart:30`).
- rrweb events are built in Dart (`lib/src/internal/upload/rrweb_event.dart`).
- **RN, by contrast, delegates to the native SDKs**: `MixpanelSessionReplay 2.0.0` [code: mixpanel-react-native-session-replay MixpanelReactNativeSessionReplay.podspec:18 @ 5b08d99] and `mixpanel-android-session-replay:1.6.0` (`android/build.gradle:87`).

**New Relic iOS / Android: rrweb wireframe, open source**
- iOS: rrweb models live in `Agent/SessionReplay/RRWebModels/` (`RRWebFullSnapshotEvent.swift`, `RRWebIncrementalSnapshotEvent.swift`), with per-view captors under `ViewCaptors/` (`UILabelThingy.swift`, `UIImageViewThingy.swift`, …) and SwiftUI support under `SwiftUI/` [code: newrelic-ios-agent @ 4e9c85e].
- iOS cadence: a 1 s repeating `DispatchSourceTimer` calls `sessionReplay.takeFrame()` (`Agent/SessionReplay/SessionReplayManager.swift:122,224`). Uploads are gzipped JSON (`:372`).
- iOS recording modes (`SessionReplayRecordingMode.swift:12-18`):
  - `error`: "Records frames in a 15-second circular buffer", switching to full mode on an error.
  - `full`
  - `off`
- Masking toggles come from the harvester's server config: `mask_application_text`, `mask_user_input_text`, `mask_all_images`, `mask_all_user_touches`. When absent they default to YES, YES, YES and NO (`Agent/Harvester/DataStore/NRMAHarvesterConfiguration.h:55-58`, `.m:256,264,271,280`).
- Unmasked images are inlined as `data:image/png;base64` (`ViewCaptors/UIImageViewThingy.swift:134`).
- Android mirrors iOS:
  - `sessionReplay/viewMapper/Compose*Thingy.kt` and `compose/` (Compose semantics tree)
  - `capture/ViewDrawInterceptor.java`
  - `models/IncrementalEvent/RRWebIncrementalEvent.java`
  - `agent-core/.../CrashSessionReplayHandler.java` [code: newrelic-android-agent @ 48198a2]

**Amplitude iOS: binary core, hybrid hints**
- `Package.swift:32` declares `.binaryTarget(name: "AmplitudeSessionReplay", path: "Frameworks/AmplitudeSessionReplay.xcframework")`. The `Sources/` wrapper is an empty file ("Empty Swift file so that AmplitudeSessionReplayWrapper builds").
- The public `.swiftinterface` declares:
  - `QualityProfile` low / medium / high / `automatic` (`:28-31`)
  - `UIView.amp_isBlocked` (`:38`)
  - `MaskLevel` light / medium / conservative (`:46-49`)
  - `Config(sampleRate: 0.0, maskLevel: .medium, quality: .high, enableRemoteConfig: true, captureWebViews: false …)` (`:79`)
- It also imports AVFoundation, IOSurface and Metal (`:5,14,16`). That is consistent with image or video processing, but not proof.

**UXCam Flutter: hybrid split between Dart and native**
- The native SDK (`com.uxcam:uxcam:3.11.3` [code: uxcam flutter-plugin android/build.gradle:44 @ 1ff567a]; pod `UXCam ~> 3.11.1`, `ios/flutter_uxcam.podspec:19`) calls the Dart side on `MethodChannel('uxcam_occlusion_request')` (`lib/src/widgets/occlusion_registry.dart:38`).
- Dart returns occlusion rects (`:126`). Optionally it also renders the root layer with `rootLayer.toImage(...)` and returns `rawRgba` bytes (`:156-163`).
- So Flutter pixels come from the Flutter engine. Recording, encoding and upload stay native.

**Splunk iOS: Smartlook's binaries**
- `splunk-otel-ios/Package.swift:764-855 @ 99e4b05` downloads static libraries from `https://sdk.smartlook.com/cisco-session-replay/ios/2.0.0/…`, among them `cisco-video-encoder`, `cisco-screenshot` and `cisco-wireframe`.
- That explains why Splunk's NATIVE / WIREFRAME_ONLY modes match Smartlook's `renderingMode`.
- Smartlook's end-of-life page names Splunk DXA as the successor (§9 Q3).

### 4.3 Replay technique taxonomy (for the comparison)

| Class | Definition | Who (mobile) | Claimed trade-offs (vendor's own words where available) |
|---|---|---|---|
| **Screenshot video** | Periodic or change-driven bitmaps of the window, masked by painting over view rects, then encoded on device into a video codec (H.264 / HEVC) and uploaded as segments | Sentry (iOS, Android, RN, Flutter), UXCam (on-device or server-side encoding; docs disagree), Medallia DXA ("video of the entire screen", 6 fps), Smartlook / Splunk native mode (frames "assembled"; the Splunk binary ships a `cisco-video-encoder`), Dynatrace (likely; "video-like") | High fidelity, including custom drawing, maps and games. Sentry documents CPU 4–13% and "can cause visible frame drops" on iPhone 8 and older (https://docs.sentry.io/platforms/apple/guides/ios/session-replay/performance-overhead/). Privacy depends on rect masking being aligned. Sentry Android says PixelCopy "may result in masking misalignments". |
| **Screenshot frames** | Same bitmaps, but sent as individual compressed images (JPEG / WebP), usually inside a JSON or rrweb envelope and often change-triggered | Mixpanel (JPEG q0.4, ≥500 ms apart, rrweb img node), OpenReplay (JPEG batches of 10/20/30 in a gz archive), Luciq (screenshot "with every screen transition"), PostHog screenshot mode and RN/Flutter (rrweb img), LogRocket Flutter (likely) | Simple to build and play back (an `<img>` in rrweb). Bytes scale with frames, not change size. Mixpanel limits it with Wi-Fi-only upload by default; Luciq caps it at 2 MB of screenshots per session. |
| **Wireframe / vector** | Walk the view tree (or the Compose / SwiftUI / Flutter semantics or render tree), serialise frames, text, colours and image placeholders, diff against the previous frame; the player rebuilds HTML or canvas | PostHog native default, Datadog, Fullstory ("never captures screenshots"), New Relic (rrweb), Quantum Metric (HTML DOM), Contentsquare (incl. Flutter tree rebuild), Smartlook / Splunk wireframe mode, Amplitude (per docs: view-tree snapshot plus diffs) | Fullstory: "as little as tens of kilobytes per minute", "an order of magnitude less bandwidth" than screenshots (https://www.fullstory.com/blog/mobile-app-analytics-privacy/). New Relic: "not pixel perfect", with camera, map and video shown as placeholders. Fullstory Flutter: shaders render as black boxes. Privacy is strongest because text can be masked before it leaves the tree. |
| **Hybrid** | Both at once, or per region: wireframe with bitmaps for parts the tree cannot describe, or a parallel wireframe track next to screenshots | Smartlook / Splunk native (screenshots **and** wireframe recorded together, switchable in the player), LogRocket (view capture with bitmaps, wireframe fallback past a timeout), Amplitude (view-tree diffs, but quality controls "frame rate and image resolution"), Mixpanel with wireframes beta (screenshot plus structured wireframe), UXCam Flutter (Dart pixels, native video) | Combines the fidelity of images with the searchability and privacy of structure. Costs two capture paths. LogRocket shows the player warning when it degraded to wireframe. |

---

## 5. Transport and OpenTelemetry

| Vendor | Replay transport (documented) | OTel position | Source |
|---|---|---|---|
| UXCam | Upload on background; Wi-Fi only by default with an optional cellular cap; crashed sessions sent on next launch | none found | [docs only] https://help.uxcam.com/hc/en-us/articles/360031618711 |
| Smartlook | Wi-Fi only by default | none documented. A fork named "MRUM OpenTelemetry API for Swift" exists at github.com/smartlook/opentelemetry-swift; its successor, Splunk, is OTel-native | [docs only], [code] |
| Fullstory | proprietary | OTel only for "Subtext" (web: session id in baggage); mobile none | [docs only] https://subtext.fullstory.com/docs/integrations/opentelemetry |
| LogRocket | proprietary, about 15 KB/s | none | [docs only] |
| Amplitude | batched and compressed on a background queue | none | [docs only] |
| Mixpanel | gzipped rrweb-style JSON to `api.mixpanel.com/record?format=gzip`, every 10 s, queue limit 1000 | none (OpenFeature for flags is not OTel) | [code] FlushRequest.swift:41,74; Constants.swift:139-143 |
| Contentsquare | proprietary; quality set separately for Wi-Fi and cellular | none | [docs only] |
| Dynatrace | proprietary agent protocol | backend **ingests OTLP** (`/api/v2/otlp/v1/{traces,metrics,logs}`); mobile agent not OTel | [docs only] https://docs.dynatrace.com/docs/ingest-from/opentelemetry/otlp-api |
| New Relic | gzipped rrweb JSON, uploaded every 1 min | backend **ingests OTLP**; mobile agent proprietary | [docs only] https://docs.newrelic.com/docs/opentelemetry/best-practices/opentelemetry-otlp; [code] |
| Splunk RUM | replay through Smartlook-built binaries; RUM spans over OTLP/HTTP-protobuf (agent 2.0 dropped Zipkin) | **SDK built on OTel** (`opentelemetry-swift-core`); custom OTLP JSON encoding replaced the exporter package | [code] splunk-otel-ios Package.swift:30-37 @ 99e4b05; [docs only] |
| BugSnag | spans | **SDK emits OTLP** (`OtlpUploader.mm`, `OtlpTraceEncoding.mm` in bugsnag-cocoa-performance) | [docs only] https://docs.bugsnag.com/performance/ |
| Firebase | Google transport | none | [docs only] |
| App Center | retired | Microsoft's replacement for analytics and diagnostics is **the OTel mobile SDKs → OTel Collector → `azuremonitorexporter`** (Azure Monitor mobile, public preview since 2026-04-15) | [docs only] https://learn.microsoft.com/en-us/appcenter/retirement |
| Glassbox, Quantum Metric, Medallia DXA, Shake, Userback, Bugfender | proprietary | none found | [docs only] / [blog only] |

**None of the closed replay vendors exports replay over OTel.**
- Two APM vendors run their mobile RUM on OTel: Splunk (and Embrace, from the open-SDK set).
- One crash vendor emits OTLP spans: BugSnag.
- Two backends accept OTLP but ship proprietary mobile agents: New Relic and Dynatrace.

---

## 6. Other features

### 6.1 Feature matrix (all vendors)

Cell values: `yes` / `partial` / `no` / `unknown`. `no` means the vendor's docs and marketing show no such feature after a search. `unknown` means not determinable or contradictory. Replay technique codes: **SV** screenshot video, **SF** screenshot frames, **WF** wireframe / vector, **HY** hybrid.

| Vendor | Crash reporting | Perf monitoring | Session replay (technique) | Interaction timeline | Replay linked to issues | Journey / funnel analysis | In-app bug report / feedback | OTel export | Open-source SDK | iOS Swift | iOS ObjC | Android Kotlin | Android Java | React Native | Flutter |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Sentry | yes | yes | yes (SV) | yes | yes | no ᵃ | yes ᵇ | partial ᶜ | yes (MIT) | yes | yes | yes | yes | yes | yes |
| PostHog | partial ᵈ | partial ᵉ | yes (WF native default; SF on RN, Flutter, SwiftUI, Compose) | partial | yes | yes ᶠ | partial (surveys) | partial ᶜ | yes (MIT) | yes | partial | yes | yes | yes | yes |
| Luciq | yes | yes | yes (SF) | yes | yes | yes ᵍ | yes | no | partial ʰ | yes | yes | yes | yes | yes | yes |
| Embrace | yes | yes | no ⁱ | yes | no | partial ʲ | no | yes ᵏ | yes (Apache-2.0) | yes | unknown | yes | yes | yes | yes |
| Datadog | yes | yes | yes (WF) | yes | yes | yes ˡ | no | partial ᵐ | yes (Apache-2.0) | yes | yes | yes | yes | yes | yes |
| OpenReplay | partial | partial | yes (SF) | yes | partial | unknown ⁿ | no | no | partial ᵒ | yes | yes | yes | unknown | yes | yes (beta) |
| UXCam | yes | partial ᵖ | yes (SV) | yes | yes | yes | no | no | partial ʰ | yes | yes | yes | yes | yes | yes |
| Smartlook (EOL 2027-09-30) | yes | partial | yes (HY) | yes | yes | yes | no | no | partial | yes | yes | yes | yes | yes | yes |
| Fullstory | partial ᵠ | partial | yes (WF) | yes | partial ᵠ | yes | no | no | partial ʰ | yes | yes | yes | yes | yes | yes |
| LogRocket | yes | partial | yes (HY) | yes | partial | yes | partial (surveys) | no | partial | yes | unknown | yes | yes | yes | yes |
| Amplitude | no | no | yes (HY ʳ) | yes | partial | yes | partial (Guides & Surveys) | no | partial ˢ | yes | yes | yes | yes | yes | yes (early access) |
| Mixpanel | no | no | yes (SF; WF beta) | yes | partial | yes | no | no | yes (Apache-2.0) | yes | partial | yes | yes | yes | yes (beta) |
| Contentsquare / Heap | partial ᵗ | partial | yes (WF) | yes | yes | yes | partial (iOS surveys beta) | no | partial | yes | yes | yes | yes | yes | yes |
| Dynatrace | yes | yes | yes (unknown, "video-like"; native only) | yes | yes ᵘ | no | no | partial ᵛ | no | yes | yes | yes | yes | partial (no replay) | partial (no replay) |
| New Relic | yes | yes | yes (WF, rrweb) | yes | yes ᵘ | partial ʷ | no | partial ᵛ | yes (Apache-2.0) | yes | yes | yes | yes | yes | partial (no replay) |
| Splunk RUM / AppD | yes | yes | yes (HY) | yes | unknown | no | no | yes ˣ | partial ʸ | yes | yes | yes | yes | yes | yes |
| Medallia DXA | yes | partial | yes (SV, 6 fps) | partial | partial | partial (heatmaps) | yes (Medallia surveys) | no | no | yes | unknown | yes | yes | yes | yes |
| Quantum Metric | yes | partial | yes (WF / DOM) | unknown | partial | yes | partial (via Medallia) | no | no | yes | unknown | yes | yes | yes | yes |
| Glassbox | yes | partial | yes (unknown) | yes | yes | yes | no | no | no | yes | unknown | yes | yes | yes | yes |
| Firebase | yes | yes | no | partial (breadcrumbs) | no | partial ᶻ | partial (testers only) | no | yes (Apache-2.0) | yes | yes | yes | yes | no | yes |
| BugSnag | yes | yes | no | yes (breadcrumbs) | no | no | no | yes ˣ | yes (MIT) | yes | yes | yes | yes | yes | yes |
| Shake | yes | no | partial (15 s screen recording) | yes | yes | no | yes | no | no | yes | yes | yes | yes | yes | yes |
| Userback | no | no | no (screenshot only) | partial | no | no | yes | no | partial (MIT wrappers) | yes | unknown | yes | unknown | yes | no |
| Bugfender | yes | no | no | partial (UI event log) | no | no | yes | no | no | yes | yes | yes | yes | yes | yes |

Footnotes:
- ᵃ No Funnels, Paths, Retention or "User Journeys" in Sentry docs. See §6.2.
- ᵇ User Feedback form, shake to report, screenshot, and 30 s of buffered replay. https://docs.sentry.io/platforms/apple/user-feedback/
- ᶜ Backend ingests OTLP (Sentry: traces and logs, beta; PostHog: logs, traces in alpha). The mobile SDKs are not OTel and do not export OTLP. https://docs.sentry.io/concepts/otlp/, https://posthog.com/docs/logs
- ᵈ PostHog iOS crash capture is opt-in; Android catches JVM exceptions only. https://posthog.com/docs/error-tracking/installation/android
- ᵉ PostHog: network telemetry inside replay only; no app-start or frame metrics found.
- ᶠ PostHog: Funnels, Paths (explicitly supports mobile `$screen` events), Retention, Lifecycle, Stickiness. https://posthog.com/docs/product-analytics/paths
- ᵍ Luciq Funnels: steps are events, screens or network calls; retroactive; issues and replays per step. https://docs.luciq.ai/product-guides-and-integrations/product-guides/funnels
- ʰ Native SDK is a closed binary; RN and Flutter wrappers are open (MIT or BSD-3).
- ⁱ Embrace: the User Timeline is event-based, not visual. https://embrace.io/docs/product/sessions/user-timeline/
- ʲ Embrace User Flows: start event to end event (completed / error / abandoned), not multi-step conversion. https://embrace.io/docs/product/user-journeys/
- ᵏ Embrace SDK is built on OTel and exports OTLP. https://embrace.io/docs/ios/6x/advanced-features/opentelemetry-export/
- ˡ Datadog Product Analytics: Funnels, Pathways, Retention on RUM mobile data. https://docs.datadoghq.com/product_analytics/
- ᵐ Datadog: OTel API shim and trace-context correlation; no OTLP export of RUM. https://docs.datadoghq.com/opentelemetry/correlate/rum_and_traces/
- ⁿ OpenReplay funnels and journeys exist for web; nothing on mobile.
- ᵒ OpenReplay ios-tracker is Elastic-2.0 (source-available); the monorepo is AGPL-3.0.
- ᵖ UXCam: ANR and UI freezes yes; app start and frames nf.
- ᵠ Fullstory: a crash event carrying the session URL, and a Crashlytics link-out; no crash grouping.
- ʳ Amplitude docs say view-tree diffs; see §4.1 for why we class it hybrid.
- ˢ Amplitude: iOS wrapper is MIT, but the core is a binary xcframework; Android is closed.
- ᵗ Contentsquare: JVM crashes only ("C or C++ are not supported").
- ᵘ Dynatrace "Session Replay on crashes" keeps 100% of crash sessions. New Relic's error sample rate flushes a client buffer on crash, ANR or handled exception.
- ᵛ Backend ingests OTLP; the mobile agent is proprietary.
- ʷ New Relic "Mobile User Journeys" Sankey, only inside Errors. https://docs.newrelic.com/docs/mobile-monitoring/mobile-monitoring-ui/mobile-app-pages/user-journeys
- ˣ The SDK itself emits OTLP (Splunk agent 2.0; BugSnag performance).
- ʸ Splunk agent is Apache-2.0, but its replay core is closed Smartlook / Cisco binaries.
- ᶻ Firebase funnels live in Google Analytics for Firebase (not verified here).

### 6.2 Claim check: "funnels are strong on PostHog and limited on Sentry"

**Verdict: half right.** PostHog is strong. Sentry is not "limited": it has **no funnel or journey-analytics product at all** [docs only]. Luciq, Datadog, Amplitude, Mixpanel, UXCam and Contentsquare also ship real funnels, so funnels do not set PostHog apart in this market.

| Vendor | What exists | Source |
|---|---|---|
| Sentry | Replay search on `screen`, `count_errors`, `count_rage_clicks`, `count_dead_clicks`, device and OS (the `click.*` fields are DOM-based, so web only). Breadcrumbs and the Activity tab. User Feedback with 30 s of replay. Mobile Insights (Vitals, App Starts, Screen Loads, Screen Rendering), which measure performance, not behaviour. Sentry's blog suggests building funnel-like counts from custom metrics. | https://docs.sentry.io/concepts/search/searchable-properties/session-replay/, https://docs.sentry.io/product/insights/mobile/, https://blog.sentry.io/when-you-need-a-metric/ |
| PostHog | Funnels (conversion window, breakdowns, time to convert, correlation), Paths over `$screen`, Retention, Lifecycle, Stickiness. Mobile `captureScreenViews` and lifecycle events are on by default; element autocapture on mobile is off by default and UIKit-only. | https://posthog.com/docs/product-analytics/funnels, https://posthog.com/docs/libraries/ios/configuration |
| Luciq | Funnels (events, screens or network steps, retroactive, replays per step), Repro Steps / User Steps, APM "Flows" | https://docs.luciq.ai/product-guides-and-integrations/product-guides/funnels |
| Datadog | Funnels, Pathways, Retention, Segments on RUM mobile actions and views | https://docs.datadoghq.com/product_analytics/ |
| Embrace | User Flows (two-point), no multi-step funnel | https://embrace.io/docs/product/user-journeys/ |
| New Relic | Mobile User Journeys Sankey, inside Errors only | see ʷ |

### 6.3 In-app feedback and surveys

| Vendor | In-app feedback / surveys |
|---|---|
| UXCam | nf |
| Smartlook | nf |
| Fullstory | nf (Guides & Surveys repos exist for RN and Swift) |
| LogRocket | Surveys (general) |
| Amplitude | Guides & Surveys mobile SDK |
| Mixpanel | nf |
| Contentsquare | iOS in-app surveys (beta) |
| Dynatrace | nf |
| New Relic | nf |
| Splunk RUM | nf |
| Medallia DXA | yes, Medallia Digital surveys; feedback records link to the replay |
| Quantum Metric | via Medallia |
| Glassbox | nf |
| Firebase | App Distribution tester feedback only |
| BugSnag | nf |
| Shake | Shake to report, screenshot, 15 s video, 60 s "black box" |
| Userback | Core product; NPS / CSAT |
| Bugfender | `sendUserFeedback` plus a ready UI |
| Microsoft App Center | n/a |

---

## 7. Performance footprint

| Vendor | Claim | Method stated? | Source |
|---|---|---|---|
| UXCam | "SDK size below 300kb", "CPU usage below 5%" (marketing). FAQ: iOS ~200–800 KB, Android ~250 KB–1.2 MB. Video 10–280 KB/min (iOS) and 30–400 KB/min (Android) by quality level; elsewhere "approximately 70-80 KB" per minute. "Typical memory usage: 20-40 MB" | No | [docs only] https://uxcam.com/sdk/, https://developer.uxcam.com/docs/how-session-recording-works |
| Smartlook | nf | | |
| Fullstory | "as little as tens of kilobytes per minute"; a screenshot is "10 to 20 kB" per view; "order of magnitude less bandwidth" | "experiments we've run locally" | [blog only] https://www.fullstory.com/blog/mobile-app-analytics-privacy/ |
| LogRocket | "typically around 15KB a second"; capture "less than one frame per second" on average | No | [docs only] https://docs.logrocket.com/docs/performance-impact-of-the-mobile-sdk |
| Amplitude | Qualitative only (async, background queue, batching, compression) | No | [docs only] |
| Mixpanel | "overhead is unnoticeable… testing was not exhaustive"; no disk writes | No | [docs only] |
| Contentsquare | Android, Pixel 5 at High: main-thread CPU <15%, memory 15 MB, ≤838 / 545 / 369 KB/min (High / Medium / Low), SDK ~4.0 MB; startup +7.3 ms on Pixel 9, +22.7 ms on Pixel 6. iOS, iPhone 7: CPU <10%, RAM <5 MB, ≤2 MB/min at High. Flutter: iOS CPU <3%, Android CPU <25% | **Yes, partly**: named devices; startup from "nightly tests" | [docs only] https://docs.contentsquare.com/en/csq-sdk-android/experience-analytics/impact-on-performance/ |
| New Relic | Android: cold start +110.8 ms (+8.1%), hot start no change, peak CPU no change, peak memory +9.25 MB, network +29.6 KB per session, janky frames +2.7%, APK +385 KB release / +465 KB debug. Docs: about 5.3 MB per replay | **Yes**: v7.7.2 on the Now in Android app, 5 baseline runs vs 4 SDK runs, per-run tables published | [code] newrelic-android-agent performance.md @ 48198a2 |
| Quantum Metric | Android "about 200KB", iOS "1MB in the final build", <1% memory, "8-9% decrease in FPS" | No | [blog only] https://quantummetric.com/platform/performance |
| Medallia DXA | ~1.4 MB iOS, ~1.5 MB Android; recording pauses above 70% CPU | No | [docs only] https://developer.medallia.com/medallia-dxa/docs/mobile-sdk-overview |
| Dynatrace, Splunk, Glassbox | nf ("lightweight") | | |

For comparison, the open SDKs (detail in Appendices A–G):
- Sentry iOS: CPU 4–13%, about +19 MB, "10 KB/s", "~25ms per capture", measured on an iPhone 14 Pro.
- Datadog: 3 ms per capture every 64–100 ms; ~12 KB/s on iOS and 1.22 KB/s on Android.

Only **New Relic** (open repo with per-run data) and **Contentsquare** (named devices, nightly startup tests) publish anything close to a method. Every other closed vendor publishes bare numbers.

---

## 8. Blog-to-code grounding

| Claim (source) | Grounding | Verdict |
|---|---|---|
| Mixpanel: mobile replay is "capturing UI hierarchy changes and storing them as images" (iOS docs) | `drawHierarchy` + JPEG 0.4 + base64 img in rrweb (`ScreenRecorder.swift:200,236`, `MPSessionReplayEncoder.swift:92` @ 8ce38fc) | **Confirmed**: screenshot frames, change-gated (`isScreenDirty`, 500 ms) |
| Mixpanel: iOS and Android replay "now open source" (changelog) | Package.swift has source targets only; Apache-2.0 | **Confirmed** for iOS; Android not cloned |
| Amplitude: "captures changes to an app's view tree… each view change as a diff" (iOS docs) | Core is a binary (`Package.swift:32`). The interface exposes `QualityProfile`, imports Metal / AVFoundation / IOSurface and `CGImage.cropping`. The same doc says quality controls "frame rate and image resolution" | **Partly contradicted**: images take part; exact mix not verifiable without the binary |
| New Relic: agent "transforms the viewport into HTML" (docs) | rrweb full and incremental snapshot models, per-view captors (`RRWebModels/`, `ViewCaptors/` @ 4e9c85e) | **Confirmed** |
| New Relic: error sampling keeps a 30 s client buffer (docs) | iOS `SessionReplayRecordingMode.error` comment: "15-second circular buffer" (`:12`) | **Discrepancy**: 15 s in iOS code vs 30 s in docs (could be two 15 s segments; not resolved) |
| New Relic: Android overhead numbers (repo `performance.md`) | Per-run tables in the same file | Published method, small n (5 vs 4 runs) |
| UXCam: Flutter and RN go "through a native bridge" (docs) | Native recorder pulls occlusion rects and optional RGBA pixels from Dart (`occlusion_registry.dart:38,126,156-163` @ 1ff567a) | **Confirmed, with nuance**: pixels for Flutter come from Dart's layer tree |
| Splunk: NATIVE mode compiles video, wireframe in parallel (docs) | Agent downloads Smartlook-hosted `cisco-video-encoder`, `cisco-screenshot`, `cisco-wireframe` (`Package.swift:806-820` @ 99e4b05) | **Confirmed**: Splunk mobile replay = Smartlook engine |
| Fullstory: "never captures screenshots" (help) | Wrapper code shows only view annotations (`fsClass`, …); native is binary | Not verifiable in code |

---

## 9. Questions asked and answers

1. **Does any closed vendor export replay via OTel?** No. OTel appears only in RUM/span transport: Splunk's agent is built on `opentelemetry-swift-core` [code: splunk-otel-ios Package.swift:37], and BugSnag emits OTLP spans [docs only]. New Relic and Dynatrace ingest OTLP on the backend only.
2. **Is Amplitude's mobile replay open?** No. The iOS repo is MIT, but `Package.swift:32` binds a local binary `AmplitudeSessionReplay.xcframework`; Android is README-only [code @ d68813b, 3af13dd].
3. **Who builds Splunk's and AppDynamics' mobile replay?** Smartlook (Cisco). The binaries come from `sdk.smartlook.com/cisco-session-replay/ios/2.0.0/` [code: splunk-otel-ios Package.swift:764-855]. Smartlook itself is end-of-life (platform off 2027-09-30) with Splunk DXA as successor [docs only] https://www.smartlook.com/pricing/.
4. **Is Mixpanel's replay screenshots or wireframe?** Screenshot frames. JPEG q0.4, at most every 500 ms, only when the screen is dirty. A wireframe beta (1.6.0) is extra metadata, off by default [code @ 8ce38fc].
5. **Does Flutter replay run in Dart or native?** It depends on the vendor:
   - Mixpanel: in Dart (`RenderRepaintBoundary.toImage`), with native JPEG encoding [code @ 7ced8fc].
   - UXCam: hybrid. Dart renders the layer tree on request from native [code @ 1ff567a].
   - Contentsquare: the SDK rebuilds the widget tree as wireframe [docs only].
   - Fullstory: the Dart plugin feeds the native SDK, wireframe [docs only].
   - LogRocket, Smartlook: nf.
6. **Does any vendor's replay technique change between native, RN and Flutter?**
   - Yes: PostHog (native wireframe, RN and Flutter screenshots) [docs only].
   - Yes: Dynatrace (no replay outside native).
   - Yes: New Relic (no Flutter replay yet).
   - Yes: Smartlook (RN wireframe only on Android).
   - Mixpanel uses the same technique, but on Flutter it runs in Dart.
7. **Which vendors mask everything by default?**
   - All text and images: Fullstory ("private by default"), Contentsquare, New Relic (default strategy), Dynatrace (Safest), Mixpanel (image, text, web, map).
   - Inputs only: UXCam, Medallia DXA, Smartlook / Splunk.
   - Middle ground: Amplitude's medium level masks editable text.
8. **Which vendor has a replay-on-error buffer like Sentry's `onErrorSampleRate`?**
   - New Relic: error mode, a 15 s ring buffer in iOS code [code: SessionReplayRecordingMode.swift:12] and 30 s per docs.
   - Dynatrace: "Session Replay on crashes".
   - Contentsquare: event-triggered replays.
   - Sentry User Feedback also attaches 30 s.
9. **Is "funnels are strong on PostHog and limited on Sentry" accurate?** Half right. Sentry has none; see §6.2.
10. **Is there a closed vendor already using rrweb for mobile?**
    - New Relic: native view tree serialised as rrweb full and incremental snapshots [code].
    - Mixpanel: rrweb-style envelope with JPEG `<img>` nodes [code].
    - Amplitude: rrweb only inside WebViews, via the injected `webview.js` (`amp_injected_recorder`) [header].
11. **Which closed vendors have no replay?** Firebase, BugSnag, Bugfender and App Center. Shake and Userback do screenshots or a 15 s clip for bug reports.
12. **What happened to App Center?** Retired 2025-03-31. Analytics & Diagnostics were extended to the end of March 2027. Microsoft points mobile telemetry to OTel SDKs → Collector → Azure Monitor (preview) [docs only] https://learn.microsoft.com/en-us/appcenter/retirement.
13. **Do any vendors publish a footprint method?** New Relic (Android, per-run tables on Now in Android) and Contentsquare (named devices, nightly startup tests). The rest publish numbers without a method (§7).
14. **What does Hotjar offer on mobile?** No native SDK. Heap mobile replay is the Contentsquare SDK plus a bridge [docs only] https://developers.heap.io/docs/syncing-heap-data-to-contentsquare.

---

## 10. Takeaways for ouo

1. **The OTel-native slot for mobile replay is empty.**
   - No closed vendor ships replay over OTel.
   - The OTel-based mobile agents either have no replay (Embrace, BugSnag) or bolt on a proprietary binary (Splunk → Smartlook engine).
   - Microsoft is sending App Center's analytics users to "OTel SDK → Collector". That is exactly ouo's architecture, with no replay or RUM UI on top.
   - An OTel SDK plus open replay, through the customer's own Collector, into Grafana: no studied vendor has that shape.
2. **rrweb for mobile is proven by others; ouo should copy it, not invent a format.**
   - New Relic (wireframe) and Mixpanel (JPEG in `<img>`) both put mobile replay into rrweb events, and PostHog does too (Appendix D).
   - ouo's Grafana rrweb player can therefore take a wireframe track (New Relic style) and a screenshot track (Mixpanel style) without a new player.
   - Read `newrelic-ios-agent/Agent/SessionReplay/` and `newrelic-android-agent/.../sessionReplay/` (Apache-2.0) before writing ouo's wireframe captor. They cover UIKit, SwiftUI, Views and Compose.
   - *Superseded for ouo by [roadmap.md §2.2](roadmap.md#22-where-i-disagree): tiles inside ouo's own `frames` chunk, no rrweb container for raster.*
3. **Ship hybrid, defaulting to wireframe plus masked-by-default.**
   - The market converges on hybrid: Smartlook / Splunk run both tracks, LogRocket falls back to wireframe, Amplitude mixes, Mixpanel adds wireframe beside screenshots.
   - Privacy-first vendors (Fullstory, Contentsquare, New Relic) mask all text by default.
   - A sensible ouo default: wireframe with all text masked, screenshot frames as opt-in per screen or per session, and an error-triggered ring buffer (New Relic, Dynatrace and Sentry all have one).
   - *Superseded for ouo by [roadmap.md §2.1](roadmap.md#21-where-i-agree-and-why-it-brings-value-rather-than-complexity): screenshots masked on device stay the base; wireframes are a later optional track at most.*
4. **Flutter replay can be pure Dart.** Mixpanel proves it (`RepaintBoundary.toImage` plus native JPEG). ouo's Flutter replay can then reuse the Dart OTel / Faro path and avoid a per-platform native dependency, while RN delegates to the native SDK as everyone does.
5. **Where the field is thin.**
   - **Footprint transparency.** Only New Relic publishes a reproducible method. An ouo benchmark harness with public per-run data would stand out.
   - **APM-grade RUM plus product analytics plus replay in one tool.** The analytics vendors (Amplitude, Mixpanel, UXCam, Fullstory) have funnels but no app-start or frame metrics. The APM vendors (Dynatrace, New Relic, Splunk, Sentry) have vitals but weak or no funnels.
   - **Funnels on top of OTel data.** Sentry, the closest analogue, has none. Even a basic screen-sequence funnel or path view over ouo's spans and logs in Grafana would beat Sentry's offer.
   - **Do not compete on in-app bug reporting first.** Luciq, Shake and Sentry User Feedback cover it, and it is not OTel-shaped. *Refined by [roadmap.md §2.2](roadmap.md#22-where-i-disagree): the OTel-shaped feedback primitive ships early (W6), the widget UI later.*
6. **Vendor churn is real.**
   - Smartlook ends in 2027 with no data migration.
   - App Center is gone.
   - Embrace was acquired by Palo Alto Networks (per Embrace's blog).
   - An open, self-hostable, OTel-standard stack does not go away with a vendor.
