# Mobile SDK roadmap recommendation: what to build, in which order, and when it is done

Written 2026-10-29 by the mobile-sdk-research orchestrator, as the answer to the founder's questions on [comparison.md §12](comparison.md#12-what-ouo-should-build-recommendations): order the recommendations by value, define done, say how many can run in parallel, say whether the SDK is competitive afterwards and what is still missing, take two steps back and say whether §12 is right at all, Datadog versus Sentry, spec first with different maturity per platform, and whether to finish one implementation before starting the next.

It is a recommendation, not a decision. The decisions it needs are listed in §9 as ADRs. It respects the founder's 2026-10-23 focus order (web SDK robust, then the Sentry bridge per platform, the ouo mobile SDK last): §7 says which pieces can start before that gate without touching the bridge work.

HTML companion with the lane chart and the matrices: [mobile-sdk-roadmap.html](../../agents/mobile-sdk-research/reports/mobile-sdk-roadmap.html).

## 0. The answers in one page

1. **§12 is right on the technique and wrong on three details.** Keep screenshot capture with on-device masking (every vendor falls back to it for SwiftUI, Compose, React Native and Flutter). Change: (a) the diffed representation should be **tiles inside our own `frames` chunk**, not rrweb `<img>` mutations and not H.264; (b) on iOS do **not** adopt opentelemetry-swift in process, keep the dependency-free Swift package and speak OTLP/JSON and semconv ourselves (Android is the opposite: build on opentelemetry-android); (c) in-app feedback is not "do not compete", it is "ship the OTel-shaped primitive now, the widget later". Details in §2.
2. **The biggest gap §12 missed is native crash symbolication.** `OuoCrash` writes addresses and binary images; nobody can read them without dSYM / R8 mapping upload and symbolication in rum-api. Without it "mobile crash reporting" is a checkbox, not a feature. It is work package W7 and it is cheap relative to its value because ADR-0011 already built the web half.
3. **Order by value per unit of cost** (§3): production-safe capture on iOS (W1), spec and conformance suite (W2), wire and durability (W3), crash symbolication (W7), signals parity with Sentry plus funnels on mobile (W4, W5), feedback primitive (W6), native iOS package (W8), Android on opentelemetry-android (W9), Flutter (W10). Wireframe capture, profiling, the feedback widget UI and release-health comparisons are explicitly later.
4. **Three lanes can run in parallel safely**, four once Android tooling exists: the Swift capture lane, the React Native transport lane, the spec/plugin/rum-api lane, and later the Android lane. They touch disjoint folders. A fifth (Flutter) only after Android, because Flutter reuses the Android and iOS native halves.
5. **Datadog or Sentry?** Sentry's capture technique, OpenTelemetry's data model, Datadog's capture time budget, Sentry's buffer (on-error) mode, Luciq's navigation-only mode. Not Datadog's wireframe (it falls back to screenshots exactly where new apps live) and not Sentry's protocol (we are OTel-native). §4.
6. **Spec first, yes.** One `docs/specs/mobile-sdk.md` with twelve capabilities, each with a conformance check the e2e scenario can run against rum-api, and a maturity ladder L0–L3 per platform in `docs/compatibility.md`. The founder already decided this in principle (checklist N17, founder decision (b)); this is the concrete shape. §5.
7. **Finish one platform to L3 before starting the next, with one exception.** React Native on iOS to L3 (conformant and benchmarked) first. The exception: the Android lane may start its native-capture port once W1 is merged, because it reuses the design and not the code, needs tooling the Mac lacks today (JDK, Android SDK, emulator), and is otherwise on the critical path for every Android prospect. Flutter waits for both native halves. §6.
8. **Competitive afterwards?** On the six questions a buyer asks (crashes, performance, replay, timeline, replay-linked issues, funnels) ouo would match Sentry and beat it on funnels and OTel export, match PostHog on funnels and beat it on crashes, vitals and ANR, and stay behind Luciq on feedback UI and behind Sentry on profiling and release health. The honest list of what is still missing after W1–W10 is §8.

## 1. Where the SDK stands today (what the plan builds on)

| Capability | React Native (iOS) | Native iOS (Swift package) | Android | Flutter |
|---|---|---|---|---|
| Sessions, lifecycle, sampling | yes, JS (`sdk/react-native/src/session`) | no session manager in Swift; replay takes a `sessionId` closure | stub module that logs once | none |
| JS errors, native crashes | yes; `OuoCrash` signals + NSException, sent next launch (G1) | `OuoCrash` only | none | none |
| Crash symbolication | web only (ADR-0011); native frames keep addresses and images | same | none | none |
| Vitals: app start, TTID, frames, stalls | yes (G2, `OuoVitals`) | `OuoVitals` | none | none |
| ANR / hangs, TTFD, watchdog terminations | none | none | none | none |
| Network spans, propagation | `fetch` wrapper, W3C | none (no `URLSession` hook) | none | none |
| Span and log API | yes (G3) | none | none | none |
| Timeline events: taps, lifecycle, requests | yes, in the bridge's format | none | none | none |
| Screens / navigation events | yes, from react-navigation; feed funnels through `url.path` (ADR-0012) | none | none | none |
| Replay | JPEG frames, 1 fps + touch captures, view-walk masking, 5 s chunks, gzip, Basic auth | same package | none | none |
| Replay cost | 44–45 ms main thread per capture on an iPhone 16 Pro Max, Sentry 22 ms in the same traces (N51); bytes ≈ 2× Sentry at matched quality (N50) | same | — | — |
| Offline buffer, gzip OTLP | none (N49, N48) | n/a | — | — |
| Feedback, funnels on mobile, user steps | none, funnels work for whatever `navigation` events arrive | none | — | — |
| Benchmark | B3 harness, simulator cells, phone budget (`docs/benchmarks.md`) | — | — | — |

Sources: `sdk/ios/README.md`, `sdk/react-native/README.md`, [sentry-bridge-vs-ouo-sdk.md](../sentry-bridge-vs-ouo-sdk.md), [sentry-ios-replay-internals.md](../sentry-ios-replay-internals.md), checklist section 3.

## 2. Two steps back: is §12 right?

### 2.1 Where I agree, and why it brings value rather than complexity

| §12 item | Verdict | Value | Complexity it adds | Note |
|---|---|---|---|---|
| 1 screenshot + on-device masking as the base | agree | high | none, it is what we have | Wireframes are a later optional track at most; New Relic's open captors are the reference if a UIKit-only customer ever asks (H §10) |
| 3 change-driven cadence with a budget | agree | high | low: a run-loop observer, a dirty flag, two counters | Already item 3 of the ranked list in [sentry-ios-replay-internals.md](../sentry-ios-replay-internals.md); Datadog's 100 ms per second bank is the one addition |
| 4 V2 rendering on iOS, PixelCopy on Android | agree | high | low on iOS (one function); medium on Android (a new module) | N51 is the open item: 45 ms vs 22 ms per capture on the phone |
| 5 fail-closed masking | agree | high (privacy incidents are the one thing that ends a replay product) | low: drop-frame rules and a two-sample geometry check | Also a mask preview tool in the demo app |
| 6 crash durability | agree | high | low: the crash handler already exists; add chunk id and end time to the report | Pairs with N52 (session start lost when a crash comes in the first second) |
| 7 thin RN module, native owns ids | agree | medium | negative: it removes JS state | Sentry's stale `trace.replay_id` bug is the warning |
| 8 Flutter capture once, in Dart | agree | medium, later | high, but unavoidable | Last platform |
| 10 ANR, app start origin, frozen frames, TTFD, then a funnel view | agree | high | low per signal | App start origin and frames are done; ANR, TTFD and funnels on mobile are the work |
| 11 B3 as the public method | agree | high (it is a sales argument no vendor has) | low | Add the init trace section and Android cells |
| 13 Luciq's three cheap ideas | agree | high per cost | low | Navigation-only mode and the keep/drop hook are the two best byte savers after tiles |

### 2.2 Where I disagree

**Item 2, the diffed representation.** §12 says prototype LaunchDarkly's 64-px tile diff emitted as rrweb `<img>` mutations first. I would not. rrweb's player is a DOM player; putting raster tiles into it means inventing a DOM for every frame, carrying rrweb's full-snapshot and mutation semantics for something that is not a document, and depending on how rrweb-player treats `<img>` sources for the one thing we care about (sizing, timing, seeking). We already own a frames player and a video player in the plugin. The cheaper path with the same byte saving: keep `kind: "frames"`, `schema_version` 2, and let a frame carry either a full image or a list of `patches` (`x, y, w, h, image`) against the previous frame, with a full frame forced every N seconds (Sentry's 6 s keyframe rule, B §4.4) and on every screen change. The player keeps a canvas and blits patches. Storage, rum-api and the chunk receiver do not change beyond the schema version. That is the ADR-0006 revision I recommend (§9, ADR-0013). H.264 stays what it is today: the `video` kind for Sentry-sourced replays. A device encoder for our own frames can be revisited after W3 is measured, since the measured Sentry wire size (≈ 110 KiB/min masked, A §7) is the target tiles have to reach.

**Item 9, opentelemetry-swift in process.** Right for Android, wrong for iOS. opentelemetry-android ships sessions, crash, ANR, jank, OTLP/HTTP and disk buffering today (G.5) and is Apache-2.0; building on it saves the Android lane months and makes the Android package OTel-native in the strongest sense. opentelemetry-swift is a large dependency tree (gRPC, SwiftProtobuf, slow compiles, a known SwiftPM footprint), has no lifecycle, tap or crash instrumentation, and the Swift package today has zero third-party dependencies, which is a feature when a customer's app review asks what we link. OTel-native means the wire format and the semantic conventions, not the reference SDK in the process. Keep the Swift package dependency-free: an OTLP/JSON logs and traces exporter is a few hundred lines and the chunk uploader already has the transport, retry and auth. Revisit when opentelemetry-swift ships a lighter core.

**Item 12, in-app feedback.** The founder calls feedback crucial, and the research says the UI is where Luciq and Shake win (F §6). The two statements are compatible. Split it: the **primitive** is OTel-shaped and cheap: a `feedback` log event on the current session with message, contact, optional screenshot (the capture pipeline already produces masked frames), the last N timeline events, and a link in the plugin next to the replay. The bridge has to translate Sentry's `user_report` / `feedback` items for N37 anyway, so the record type serves both. The **widget** (shake to report, annotation, ticket integrations) is the later, non-OTel part. So: primitive in W6, widget after W10.

### 2.3 What §12 missed

1. **Native crash symbolication** (W7). Addresses with binary images are not a crash report a developer can act on. dSYM upload for iOS (`ouo-sourcemaps` already has the upload tool and ADR-0011 the release index), R8 / ProGuard mapping for Android, symbolication in rum-api, and Hermes bytecode source maps for the JS half of React Native (N38 mentions them for the bridge; the ouo SDK needs the same).
2. **Error context on errors**: the last N timeline events (taps, screens, requests), current screen, locale, memory and network state attached to each error and crash, which the bridge report lists as data Sentry sends and ouo's SDK does not.
3. **OOM and watchdog terminations** on iOS (MetricKit `MXDiagnostic`, Sentry's watchdog-termination heuristic). A crash reporter that is silent on the most common iOS termination is incomplete.
4. **App Store privacy manifest** (`PrivacyInfo.xcprivacy`) for the Swift package and the Expo module: required since 2024 for SDKs that use the "required reason" APIs (we read `sysctl`, file timestamps and user defaults). This is a release blocker for any native iOS customer, not a feature.
5. **Distribution**: the `ouo11y-ios` mirror with tags for SwiftPM, CocoaPods for React Native (done), Maven Central for Android, pub.dev for Flutter. Checklist B4 covers the first two.

## 3. The ordered work list

Order is value divided by cost, with dependencies respected. "Cost" is the orchestrator's estimate in focused agent-days, with the device budget rule from `docs/benchmarks.md` (phone only for two short experiments per request). Each package is one PR (or a small stack) with its own definition of done.

| # | Work package | Value | Cost | Depends on | Lane |
|---|---|---|---|---|---|
| W1 | **Production-safe iOS capture** (N51 + §12 items 3, 4, 5, 6, 13): V2-style render 1:1 and downscale off main, run-loop observer with animation deferral, no touch captures, one in flight, 150 ms backoff, Datadog-style time bank, fail-closed masking rules, navigation-only mode, device tiers, crash-time chunk id and end time, N52 session start in the crash report | very high | M (8–10 d) | nothing | A Swift |
| W2 | **Mobile SDK spec and conformance suite**: `docs/specs/mobile-sdk.md` (twelve capabilities, attributes, event names, thresholds), a golden mobile session the e2e scenario asserts in rum-api, maturity ladder in `docs/compatibility.md` | very high (it is what lets every later package be judged) | S–M (4–6 d) | nothing | C spec |
| W3 | **Wire and durability**: tiles in `frames` schema 2 (ADR-0013), player canvas blits, N48 gzip OTLP, N49 offline buffer for OTLP batches and chunks, keep/drop hook at next launch | very high | M (8–10 d) | W1 (tiles are computed on the capture queue W1 reshapes), ADR-0013 | A Swift + B RN + C plugin |
| W4 | **Signals parity with Sentry**: ANR / hang watchdog (2 s, fully and non-fully blocking), TTFD, OOM / watchdog terminations via MetricKit, error context (last N events, screen, locale, memory, network), `session.previous_id` | high | M (6–8 d) | W2 for the names | A Swift + B RN |
| W5 | **Funnels and user steps on mobile**: screen names as `navigation` `url.path` verified end to end, human-readable user steps as log events (`app.screen.click` with gesture, view type, label, screen, content kill switch), a mobile quickstart with a known funnel answer like tiny-shop-funnels | high (beats Sentry, matches PostHog with no new backend) | S (3–4 d) | W2 | B RN + C examples |
| W6 | **Feedback primitive**: `rum.feedback({message, contact, screenshot?})` as a `feedback` log event with the last N timeline events and an optional masked frame; plugin list and link beside the replay; bridge mapping of Sentry `feedback` / `user_report` shares the record | medium–high | S (3–4 d) | W2 | B RN + C plugin |
| W7 | **Native crash symbolication**: dSYM upload through `ouo-sourcemaps`, release index per build UUID, symbolication in rum-api, Hermes source maps for the RN JS half; R8 mapping later with W9 | very high | M (6–8 d) | ADR-0011 extension | C rum-api + tooling |
| W8 | **Native iOS package** (Swift and Objective-C): session manager in Swift (today in JS), `URLSession` hook with W3C propagation, OTLP/JSON exporter (no opentelemetry-swift), lifecycle, taps, screens (`UIViewController` swizzle), SwiftUI `.ouoMask()` modifiers, `@objc` surface, `PrivacyInfo.xcprivacy`, UIKit + SwiftUI example app | high (second platform, and it is where the bridge's N40 customers go later) | L (12–15 d) | W1, W2, W4 | A Swift |
| W9 | **Android** (React Native first, then native): opentelemetry-android base (sessions, crash, ANR, jank, disk buffering), `PixelCopy` RGB_565 capture with `OnDrawListener` dirty flag and `RootViewsSpy`-style window discovery, per-line text masks, Compose modifiers, same `frames` schema 2, Expo module Android side, R8 mapping symbolication, B3 Android cells | very high for prospects, zero until one needs it | L (15–20 d) | W1 design, W2, W3 schema, JDK + Android SDK + emulator on a machine | D Android |
| W10 | **Flutter**: Dart capture (`RenderRepaintBoundary.toImage` at 1×, synchronous Element walk, downsampled hash, raw RGBA to native), native halves do chunking, upload, crash, vitals | medium | L (10–12 d) | W8, W9 | E Flutter |
| later | Wireframe track for UIKit / View apps; profiling; feedback widget UI; release-health comparisons (Phase 9); device H.264 encoder; wireframe-based text search in replays | low now | — | — | — |

Why this order and not §12's numbering:

- **W1 before everything** because nobody can run ouo replay in production at 45 ms per capture on the main thread, and every later package's benchmark cell would be measured against a moving baseline.
- **W2 second and in parallel** because it costs little, blocks nothing today, and every package after it gets a pass/fail instead of an opinion.
- **W3 before W4** because bytes and offline loss are what a prospect sees on day one (N49: a run with the network down lost everything; Sentry kept 535 KB and re-sent it).
- **W7 before W8** because symbolication turns crash reporting from a checkbox into a feature on the platform we already have, while W8 adds a platform.
- **W9 after W8** on the Mac that exists today, because W8 reuses W1's code and W9 needs tooling that is not installed. If a second machine with the Android toolchain and an Android-capable session exist, W9 starts right after W3 (§6).

## 4. Datadog or Sentry?

The question has three parts, and the answer differs per part.

| Part | Datadog | Sentry | Recommendation for ouo |
|---|---|---|---|
| Replay capture | wireframe (view-hierarchy serialization, image-less), screenshots for SwiftUI and Compose | screenshots, masked on device, H.264 segments | **Sentry's technique**, because the wireframe path falls back to screenshots exactly where new apps are written (SwiftUI, Compose, React Native, Flutter), and a wireframe player needs a per-toolkit renderer we would maintain forever (D §10, G.2). Our representation: tiles in frames (§2.2) |
| Capture scheduling | time bank: 100 ms of capture work per second on Android | run-loop observer, animation deferral, backoff at 150 ms | **both**: the observer and deferral give good frames, the bank bounds cost on low-end devices |
| Replay modes | session sampling | session mode and buffer mode (nothing encoded until an error, then the last 30 s) | **Sentry's buffer mode** (nothing encoded until an error, then the last 30 s; the mode Sentry's setup docs recommend with `replaysOnErrorSampleRate: 1.0`, A §6) because it is how replay links to issues at a fraction of the bytes; plus **Luciq's navigation-only mode** as the low-end default |
| Data model | RUM JSON: views, actions, resources, errors, long tasks; OTel tracing API only | own envelopes, breadcrumbs, transactions | **neither: OpenTelemetry semconv** (`session.*`, `app.screen.*`, `app.widget.*`, `app.jank.*`, `device.app.lifecycle`) over OTLP to the customer's collector. Datadog's view / action / resource model is the closest to what semconv became, so Datadog's docs are the better reference for naming screens and actions |
| Crash and vitals breadth | KSCrash, 5 s watchdog, TTID/TTFD, 700 ms frozen frames | SentryCrash, 2 s hang watchdog, app start with prewarm, frozen > 0.7 s, TTID/TTFD, profiling | **Sentry's list** minus profiling (W4) |
| Error context | attributes on the view | breadcrumbs on the event | **Sentry's**: last N events on the error, which the bridge report already lists as missing |
| Transport | own intake, batching, disk persistence | envelopes, gzip, 30-envelope offline cap | OTLP/HTTP with gzip and an offline store, as the browser SDK already does (N48, N49) |

So: Sentry's capture and modes, OpenTelemetry's model, Datadog's cost bound and naming. Not Datadog's wireframes, not Sentry's protocol.

## 5. Spec first, with maturity per platform

The founder decided "one ouo SDK spec with a conformance suite" (checklist N17, decision (b)). The concrete shape:

**`docs/specs/mobile-sdk.md`**, twelve capabilities, each with the record type, required attributes, event names, thresholds and one conformance check:

| # | Capability | Record | Conformance check (golden session asserted in rum-api) |
|---|---|---|---|
| C1 | Sessions and lifecycle | `session.start` / `session.end` logs, `session.id`, `session.previous_id`, background rule, sampling | a session with foreground, background and a rotation shows as two sessions linked by `previous_id` |
| C2 | Errors and crashes | `exception` logs with `app:///` stack paths, native crash as a fatal on the next launch, session `crashed` at the crash time | a native crash in the first second still shows the session start and the crash |
| C3 | Hangs and terminations | `app.hang` events, watchdog / OOM termination on next launch | a 3 s main-thread block produces one hang event with its duration |
| C4 | Vitals | `docs/specs/mobile-vitals.md` (app start, TTID, TTFD, jank, stalls) | cold start, warm start, first-screen TTID and TTFD within thresholds |
| C5 | Network | client spans with W3C propagation and `session.id` baggage | a request to the demo backend joins one trace with the backend span |
| C6 | Interactions timeline | `app.screen.click` logs with gesture, view type, label, screen | three taps appear in order with labels |
| C7 | Screens and navigation | `navigation` logs with the screen name in `url.path` | a three-screen journey counts as a three-step funnel |
| C8 | Replay | `frames` schema 2 chunks keyed by `session.id`, masking defaults, modes (session, buffer, navigation-only), crash finalisation | a masked text field is never readable in any frame; a replay cut by a crash finishes on the next launch |
| C9 | Span and log API | `startSpan`, `withSpan`, `log.*` | a custom span parents a request span |
| C10 | Feedback | `feedback` log with contact, message, last N events, optional frame | one feedback appears beside the replay |
| C11 | Delivery | gzip OTLP, bounded offline store, retry, flush on background | a run with the network refused loses nothing after the next launch |
| C12 | Cost | B3 tier deltas | per tier, paired median delta against `none` within the release gate |

**Maturity ladder**, one cell per platform in `docs/compatibility.md`:

| Level | Meaning |
|---|---|
| L0 | not available |
| L1 | basic: the capability emits records in the spec's names but has no conformance check or known gaps (listed) |
| L2 | conformant: every conformance check of the capability passes in CI on the platform's example app |
| L3 | benchmarked: L2 and a B3 cell on the platform with the release gate applied |

**Target matrix at the end of W1–W10**:

| Capability | React Native iOS | Native iOS | React Native Android | Native Android | Flutter |
|---|---|---|---|---|---|
| C1–C9, C11, C12 | L3 | L3 | L3 | L2 | L2 |
| C10 feedback | L2 | L2 | L2 | L1 | L1 |
| C8 replay | L3 | L3 | L3 | L2 | L2 |

Objective-C and Java are API surfaces of the native iOS and native Android packages, not separate implementations (the research confirms this is how every vendor does it, §10 of the comparison): the conformance suite runs once per package, with a smoke app per language that compiles against the public API.

## 6. One at a time, or in parallel?

Recommendation: **finish React Native on iOS to L3 before starting a new platform**, which agrees with the founder's instinct ("my React Native is super mature, Flutter can come later"). Reasons: the benchmark harness, the demo app, the examples and the bridge comparison all live on that platform, and every regression there is measured. A platform at 70 % is a platform a prospect cannot buy.

Two refinements:

1. **"95–99 %" should mean L3 on C1–C9 and C11–C12, not every item on the feature matrix.** Profiling, the feedback widget and wireframes are not part of the 99 %.
2. **One exception: the Android lane may start once W1 is merged and W2's spec exists**, before React Native iOS reaches L3, if a machine with the Android toolchain exists. It reuses the design (cadence, masking rules, chunk schema, conformance checks), not the code, and it is the longest package on the critical path for any Android prospect. It must not start before W1, otherwise it copies the capture design W1 replaces.

**How many at once.** Lanes by folder, so no two writers touch the same files:

| Lane | Folders | Packages | Can run with |
|---|---|---|---|
| A Swift capture | `sdk/ios`, `sdk/react-native/ios` | W1, W3 (tiles), W4 (hangs, MetricKit), W8 | B, C, D |
| B React Native transport | `sdk/react-native/src`, `examples/ouo-mobile` | W3 (gzip, offline), W4 (error context), W5, W6 | A, C, D |
| C Spec, rum-api, plugin, tooling | `docs/specs`, `tests/e2e`, `services/rum-api`, `plugins/`, `sdk/sourcemaps` | W2, W3 (player), W6 (plugin), W7 | A, B, D |
| D Android | `sdk/android`, `sdk/react-native/android` | W9 | A, B, C after W1 and W2 |
| E Flutter | `sdk/flutter` | W10 | alone, after W8 and W9 |

Three lanes from day one (A, B, C), four with Android tooling. Two packages inside one lane are sequential. W3 is the one package that spans three lanes; split it into three PRs (schema and player; Swift tiles; RN gzip and offline) that merge in that order.

Sequencing on one calendar, with three lanes:

```
Lane A  | W1 ----------| W3 tiles ---| W4 hangs/MetricKit --| W8 native iOS -------------------|
Lane B  |              | W3 gzip+offline --| W4 error ctx | W5 funnels+steps | W6 feedback |
Lane C  | W2 spec -----| W3 schema+player | W7 symbolication ---------| conformance CI, plugin views |
Lane D  |              |                    (tooling)    | W9 Android ---------------------------------|
Lane E  |                                                                       | W10 Flutter ---|
```

Milestones: **M1** W1 + W2 merged (iOS capture safe, spec exists); **M2** W3 + W7 (bytes, offline, readable crashes); **M3** W4 + W5 + W6 (React Native iOS at L3 across C1–C12: the "path 1" upgrade can be sold); **M4** W8 (native iOS at L3); **M5** W9 (Android); **M6** W10 (Flutter).

## 7. What can start before the founder's gate

The 2026-10-23 order puts the ouo mobile SDK last, after the web SDK and the four bridge platforms. Three pieces do not conflict with that order and shorten the critical path when the gate opens:

1. **W2, the spec and the conformance checks** (docs and `tests/e2e` only). It also defines the records the bridge should map to (feedback, hangs, user steps), so the bridge work for N37 / N40 and the SDK end up on one vocabulary.
2. **ADR-0013** (tiles in frames) and the ADR-0011 extension for dSYM symbolication (W7's design): decisions, not code.
3. **The feedback record and the hang record in the bridge** (N37 translates Sentry `feedback` / `user_report` and N40 covers app hangs): if they use the spec's names, W6 and W4 inherit the plugin side for free.

Everything else waits, as decided.

## 8. After W1–W10: is it competitive, and what is still missing?

**Where ouo would stand** against the §9 feature matrix of the comparison:

| Feature | Sentry | PostHog | Luciq | ouo after W10 |
|---|---|---|---|---|
| Mobile crash reporting | yes | partial | yes | yes, symbolicated (W7), with OOM / watchdog (W4) |
| Mobile performance monitoring | yes | partial | yes | yes: app start, TTID / TTFD, frames, hangs, network (W4); no profiling |
| Session replay | video | wireframe / screenshot | WebP per screen change | tiles in frames, session / buffer / navigation-only modes (W1, W3) |
| User interaction timeline | yes | partial | yes | yes, human-readable steps (W5) |
| Replay linked to issues | yes | yes | yes | yes, same `session.id`, buffer mode (W3) |
| Journey / funnel analysis | **no** | yes | yes | yes, funnels over screens and events (W5, ADR-0012); paths view later |
| In-app bug reporting / feedback | widget | surveys | core product | primitive and plugin view (W6); widget later |
| OTel export to the customer's collector | no | logs only | no | **yes, everything** |
| Open-source SDK | MIT | MIT | wrappers | yes (when the repo opens, N20) |
| Public device-cost method | blog numbers | none | numbers without method | **B3, reproducible, in the repo** |

**What is still missing after W10**, in the order a prospect would notice:

1. **Profiling** (Sentry's continuous 101 Hz sampler, Luciq's session profiler). Expensive, needs a backend (Pyroscope exists in LGTM, which is an opening). Later.
2. **Release health comparisons and regression alerts** across versions (Phase 9): the data is there (sessions carry version and crash status), the views are not.
3. **Feedback widget UI** with shake, annotation and ticket integrations; Luciq and Shake stay ahead here by design.
4. **Paths / journey view** (PostHog's paths): the sequence of screens as a graph, not just a fixed funnel. Needs an ADR; the query shape is the funnel's.
5. **Issue grouping and ownership**: error fingerprints, assignment, resolve / regress states. ouo lists errors per session; Sentry's issue workflow is a product on top. Check what rum-api groups today before promising it (not verified in this research).
6. **Wireframe capture** for UIKit / View apps where a customer wants text-searchable replays or cannot accept screenshots. New Relic's captors are the reference.
7. **Network body and header capture**, GraphQL operation names, and WebView replay bridging.
8. **Native Android and Flutter at L3** (the plan ends them at L2 for replay and benchmarks).
9. **Platforms outside the six**: tvOS, macOS, watchOS, Unity, .NET MAUI, Kotlin Multiplatform, Capacitor. Sentry covers most; a per-platform phase each (N17).
10. **Privacy and compliance surface**: a published data-collection inventory per capability, GDPR controls (user-level delete across LGTM and replay store, which `data-lifecycle.md` partly covers), SOC 2 evidence. Buyers ask before the first install.

Reliability-wise, after W1–W10 the SDK would be as reliable as its conformance suite and benchmark gate make it: every capability has a check that runs in CI on the example app, and every release is measured against the previous one on the same journey. That is more than any of the three vendors publishes, and it is the argument to make instead of "feature parity".

## 9. Decisions needed (ADRs)

| ADR | Decision | Blocks |
|---|---|---|
| ADR-0013 | Replay representation: tiles in `frames` schema 2 (patches against the previous frame, keyframe every 6 s and on screen change, buffer and navigation-only modes), `video` stays for Sentry-sourced replays, no rrweb container for raster | W3 |
| ADR-0011 rev | Native symbolication: dSYM and R8 mapping upload, build-UUID release index, symbolication in rum-api, Hermes maps for React Native | W7 |
| ADR-0014 | Mobile SDK spec and maturity ladder: twelve capabilities, L0–L3, one conformance suite per native package, Objective-C and Java as API surfaces | W2 |
| ADR-0015 | OpenTelemetry in process: opentelemetry-android as the Android base; dependency-free Swift package speaking OTLP/JSON and semconv on iOS | W8, W9 |
| ADR-0006 rev | Record that touch-triggered captures, the timer and `UIGraphicsImageRenderer` are replaced by the run-loop observer and raw-context rendering (W1), and that masking fails closed | W1 (can be the same PR) |

## 10. Definition of done, per package and for the whole

Every package:

1. Code, unit tests, and the conformance checks of the capabilities it touches pass in CI on the platform's example app.
2. A B3 run on the simulator (N ≥ 10) with the package's tier shows no paired median delta worse than the previous release beyond the gate in `docs/benchmarks.md` §5. The one phone experiment per package follows the phone budget.
3. Spec updated (`docs/specs/mobile-sdk.md` or `mobile-replay.md` / `mobile-vitals.md`), README of the package, `docs/compatibility.md` cell moved to its new level, CHANGELOG line.
4. kb entry for anything non-obvious, agent summary, tracker and index rows, one PR.

Package-specific exit criteria:

| Package | Exit criterion |
|---|---|
| W1 | per-capture main-thread time on the iPhone 16 Pro Max ≤ 25 ms (Sentry 22 ms in the same trace); no capture during a view-controller transition; a moved mask between two samples drops the frame (test); a crash mid-chunk finishes the chunk on the next launch with the right end time; B3 T3 / T4 CPU delta ≤ Sentry's |
| W2 | spec merged; the e2e scenario asserts C1–C9 and C11 for React Native iOS and prints the maturity matrix; `compat-check` reads the levels |
| W3 | replay bytes per minute at T4 ≤ 150 KiB masked (Sentry ≈ 110); a static screen sends zero image bytes; an offline run loses nothing after the next launch (C11); OTLP requests are gzip |
| W4 | a 3 s block yields one hang event; TTFD on the first screen; a simulated OOM shows as a termination on the next launch; every error carries the last 20 events and the screen |
| W5 | the mobile quickstart's funnel reports the generator's known counts; three taps show as readable steps; kill switch verified |
| W6 | a feedback from the demo app appears beside its replay with the last events and a masked frame |
| W7 | a native crash in the demo app shows function names and lines in the plugin; a Hermes stack maps to source |
| W8 | the UIKit + SwiftUI example passes C1–C9, C11; an Objective-C smoke target compiles against the `@objc` API; `PrivacyInfo.xcprivacy` present; B3 cells for the native app |
| W9 | React Native Android example passes C1–C9, C11; B3 Android cells; Compose masking verified; R8 symbolication |
| W10 | Flutter example passes C1–C8; masking verified on the Dart side |

For the whole: React Native iOS at L3 on every capability (M3) is the point where path 1 ("more data than the Sentry SDK, at a measured cost") can be sold, which the checklist's section 3 defines as the goal.
