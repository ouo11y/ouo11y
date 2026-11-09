# Mobile RUM and session replay SDKs: side-by-side comparison

Written 2026-10-29 by the orchestrator of the `mobile-sdk-research` agent, from the eight appendices in this folder. Every number here is traceable to an appendix section, which in turn cites a repo path and commit, a doc URL, or a measurement made in this repo. Provenance labels: **code** (read in source), **measured** (computed here from real captures or fixtures), **docs** / **blog** (vendor claim, not verified in code).

Related entries written earlier on main and not repeated here: [sentry-ios-replay-internals.md](../sentry-ios-replay-internals.md) (sentry-cocoa 9.31.0 against ouo's `sdk/ios`, with the measured ≈ 22 ms vs ≈ 45 ms main-thread cost per capture on an iPhone 16 Pro Max and a ranked change list), [sdk-overhead-ios.md](../sdk-overhead-ios.md) and [docs/benchmarks.md](../../../docs/benchmarks.md) (the B3 device-cost harness: ouo vs Sentry, paired deltas, tiers T1–T4), [ios-vitals.md](../ios-vitals.md), [ios-native-crashes.md](../ios-native-crashes.md), [sentry-bridge-vs-ouo-sdk.md](../sentry-bridge-vs-ouo-sdk.md).

Appendices: [A sentry-cocoa](sentry-ios.md), [B sentry-java](sentry-android.md), [C Sentry RN + Flutter](sentry-react-native-flutter.md), [D PostHog iOS + Android](posthog-ios-android.md), [E PostHog RN + Flutter](posthog-react-native-flutter.md), [F Luciq](luciq.md), [G open-source landscape + OTel](landscape-open-source.md), [H closed vendors + feature matrix](landscape-closed.md).

## 0. The questions, answered in one page

| Question | Answer |
|---|---|
| **How do they handle RUM?** | Sentry is an APM-grade RUM SDK: sessions and release health, crashes (KSCrash fork / sentry-native), ANR and app hangs, app start spans, slow and frozen frames, screen-load transactions with TTID/TTFD, network spans with trace propagation, touch breadcrumbs, profiling (A §3, B §3). PostHog is a product-analytics SDK with replay and error tracking bolted on: `$screen`, lifecycle and autocapture events, opt-in crash capture, **no** ANR, app start, frame or screen-load metrics, no span API (D §3). Luciq is an APM plus bug-reporting SDK: app launch, screen load, UI hangs, network, crashes, ANR, OOM, user steps (F). |
| **Do they export OTel?** | **None of Sentry, PostHog or Luciq exports OTLP from a mobile SDK.** Sentry propagates `sentry-trace` + `baggage` (W3C `traceparent` opt-in, default off) and only its JVM backend modules speak OTel (A §5, B §5). PostHog's one OTel touch point is OTLP/JSON **logs** to `/i/v1/logs`; replay and events are proprietary, backend correlation uses `X-POSTHOG-SESSION-ID` (D §5, E §5). Luciq: none; it injects a home-made W3C `traceparent` (32 random bits plus the request time) on captured requests only to deep-link into Grafana, New Relic or Dynatrace (F §5). Across the field only Embrace, Splunk, Honeycomb, Elastic and LaunchDarkly run real OTel SDKs in process and export OTLP; Bugsnag emits OTLP without an OTel SDK; Datadog implements the OTel tracing API but ships to its own endpoint (G Comparison). Nobody sends **replay** over OTel. |
| **Do they support session replay?** | Yes, all three. Sentry: screenshots encoded to H.264 mp4 segments on device, on all four platforms (A, B, C). PostHog: wireframe (view-tree JSON) by default on native iOS and Android, screenshot mode opt-in and forced for SwiftUI, Compose, React Native and Flutter (D, E). Luciq: still WebP screenshots taken on screen transitions by default, optionally on interactions or on a ≥ 500 ms timer, played as a stepped timeline with user steps, network and logs; closed source, ~10 KB per frame at the default quality with a 1 MB per-session budget, uploaded at most every 6 hours (F §4). |
| **Screenshots or vectors, and how is it reconstructed?** | Three families plus one: **screenshot video** (Sentry: the player stitches one `<video>` per 5 s segment and overlays rrweb touch events), **screenshot frames** (PostHog screenshot mode, Mixpanel, OpenReplay, Luciq, LaunchDarkly tiles: images inside rrweb `<img>` nodes or an image sequence), **wireframe / vector** (PostHog default, Datadog, New Relic, Fullstory: view tree serialised to JSON, converted to rrweb DOM at play time in the browser), and **draw commands** (Microsoft Clarity on Flutter: Skia/Canvas operations recorded). §1 and §3. |
| **Wire size on the device?** | Measured on real sentry-cocoa traffic in this repo: **about 110 KiB per minute with default masking, about 362 KiB per minute unmasked**, 5–6 s segments of 6–50 KB mp4 (A §7.3). PostHog wireframes are a few KB per minute gzipped on Android (incremental) and ≈ 12 KB per minute gzipped on iOS (full trees, gzip over a batch), PostHog screenshots 15–40 KB per changed frame (D §7, E §10). §4 has the whole table. |
| **Same technique across native, RN and Flutter?** | **Sentry: same pipeline everywhere.** RN is 100 % the native SDK plus options and RN class names; Flutter swaps only the capture step (Dart `RenderRepaintBoundary.toImage` + Dart masking, raw RGBA handed to the native encoder) (C). **PostHog: changes technique.** Native default is wireframe; RN forces the native SDK into screenshot mode; Flutter captures PNG in Dart and native re-encodes to WebP (E). **Luciq**: native capture everywhere; RN only reports screen changes and resolves React tags to native views for masking; Flutter computes mask rectangles in Dart and the plugin captures with `PixelCopy` / `drawViewHierarchyInRect` and paints the black boxes itself (F §4.3). Across the field the rule holds: RN wraps native; Flutter needs Dart-side capture because the native tree is one opaque surface (G, H §9). |
| **Six targets (Swift, ObjC, Kotlin, Java, RN, Flutter)?** | All three vendors cover all six. Sentry's cocoa SDK is now mostly Swift with a curated `@objc` surface and a `SentryObjC` wrapper for module-less ObjC++; sentry-java is Java-first with the replay module in Kotlin, a pure-Java app loses nothing (A §2, B §2). PostHog iOS is `@objc` except SwiftUI modifiers; Android uses `@JvmOverloads` (D §2). §10 has the matrix. |
| **Other competitors?** | Open: Embrace (OTel-native, no replay), Datadog (wireframe replay, OTel API only), OpenReplay (JPEG frames, mixed licences), LaunchDarkly / ex-Highlight (screenshot tiles as rrweb, OTel telemetry), Microsoft Clarity (open on Flutter only), New Relic (open, rrweb wireframe), Mixpanel (open, JPEG frames in rrweb), Bugsnag, Firebase (G, H). Closed: UXCam, Smartlook (end of life 2027, engine lives on inside Splunk), Fullstory, LogRocket, Amplitude, Contentsquare/Heap, Dynatrace, Quantum Metric, Glassbox, Medallia, Shake, Userback, Bugfender (H). |
| **Open source or blogs only?** | Sentry and PostHog SDKs are fully open (MIT); every flow in A–E was read in code. Sentry's server and player are source-available (FSL), read for the reconstruction only. Luciq's native SDKs are closed binaries; only its RN and Flutter wrappers are open, so F is docs plus wrapper code plus binary headers. §11. |
| **How were performance footprints measured?** | Mostly badly. Sentry iOS's view renderer V2 numbers came from a hand-added timing patch on an iPhone 8 in one PR, and the in-repo benchmark workflow (which measured the profiler, never replay) was deleted in August 2026. Sentry Android's startup blog is backed by a real in-repo Jetpack Macrobenchmark with a `SentryAndroid.init` trace section on a Pixel 3 with locked clocks. PostHog publishes no numbers. Luciq publishes a footprint page with devices and SDK versions but no tool, run count or percentile, and its headline (10–40 ms launch) contradicts its own table (39–64 ms) (F §7). Datadog, Embrace, New Relic and Contentsquare are the only vendors with a reproducible method. §5. |
| **Funnels: strong on PostHog, limited on Sentry?** | Half right. PostHog has funnels, paths, retention over `$screen` events. Sentry has **no** funnel or journey product at all, only replay search filters and mobile vitals. Luciq, Datadog, Amplitude, Mixpanel, UXCam and Contentsquare also ship funnels (H §6.2). |

## 1. Capture technique per vendor and platform

| Vendor | Native iOS | Native Android | React Native | Flutter | Masking default | Source |
|---|---|---|---|---|---|---|
| **Sentry** | screenshot → H.264 mp4 (`drawHierarchy` into a raw `CGContext`, V2) | screenshot → H.264 mp4 (`PixelCopy` into RGB_565) | native SDKs, RN only adds class names and `<Mask>` container views | Dart captures and masks, native encodes | all text and images masked | A §4, B §4, C §4 |
| **PostHog** | wireframe JSON by default; screenshot WebP q0.3 opt-in; SwiftUI needs screenshot | wireframe JSON by default with diffing; screenshot WebP q30 opt-in; Compose needs screenshot | native SDK forced to screenshot mode | Dart PNG → native WebP → rrweb `screenshot` node | text inputs and images masked | D §4, E §4 |
| **Luciq** | WebP screenshots on screen change (default), interactions or a ≥ 500 ms timer (closed binary; `instacapture` + `PixelCopy` class names on Android) | same | native capture; RN reports screen changes and resolves React tags for private views | native-style capture in plugin code, mask rectangles computed in Dart | private views + WebViews; type-based auto masking **off** on iOS by default | F §4 |
| Datadog | wireframe, Heckel diff, images uploaded separately | wireframe, diff, full snapshot every 3 s | native + RN mappers | Dart Element-tree wireframes (preview) | all text, all images, touches hidden | G.2 |
| OpenReplay | JPEG frames on a timer, no dedupe | JPEG frames, 1 fps, no dedupe | native | Dart `toImageSync`, hash dedupe | **opt-in only** | G.3 |
| LaunchDarkly (ex-Highlight) | JPEG 64-px tiles, tile-hash diff, rrweb `<img>` mutations | same via `PixelCopy` | native | Dart `toImage` → native diff | inputs only | G.6 |
| Microsoft Clarity | closed binary | closed binary (Skia picture classes) | binaries | **draw commands** recorded from a custom `Canvas` (open Dart) | strict | G.4 |
| New Relic | wireframe → rrweb full/incremental (open) | same (open) | native | none yet | all text and images | H §4.2 |
| Mixpanel | JPEG q0.4 frames in rrweb `<img>`, ≤ 2 fps on change (open) | same | native | Dart `toImage` → native JPEG | image, text, web, map | H §4.2 |
| Fullstory | wireframe from draw operations, "never captures screenshots" | same | native, annotated views | Dart plugin feeds native wireframe | private by default | H §4.1 |
| Smartlook / Splunk | hybrid: screenshots + video **and** a wireframe track (Cisco binaries) | same | same | same | inputs | H §4.1 |
| Amplitude | hybrid (binary core; docs say view-tree diffs, interface imports AVFoundation/Metal) | closed | native | early access | medium level | H §4.2 |
| Embrace, Bugsnag, Firebase, opentelemetry-android/-swift | none | none | none | none | — | G |

**The pattern.** Vendors that started as crash/APM tools (Sentry, Luciq, Splunk, Medallia) chose screenshots: fidelity for debugging. Vendors that started as analytics or privacy-first tools (PostHog, Datadog, Fullstory, New Relic, Contentsquare) chose wireframes: small payloads, text masked before it leaves the tree, searchable. Both camps are converging on hybrids, and **everyone falls back to screenshots for SwiftUI, Compose, React Native and Flutter** because there is no typed native view tree to serialise (D §9 Q1, E §9 Q1, G.2 SwiftUI flag off by default).

## 2. The exact replay flows, step by step

### 2.1 Sentry iOS (sentry-cocoa 9.32.0, A §4)

```
Sentry session starts ──► sample: sessionSampleRate → session mode | onErrorSampleRate → buffer mode
CFRunLoopObserver (main run loop, after UI work, since 9.19.0; no timer)
  └─ captureFrameIfNeeded: base 1 fps; full rate while interacting; defer ≤1 s in animations;
     back off ×2 (cap 2 s) when redact+render ≥ 150 ms; one capture in flight
     ├─ main: redact = walk presentation layers → regions (class lists, clipOut/clipBegin/clipEnd, zPosition)
     ├─ main: render = drawHierarchy(afterScreenUpdates:false) into calloc'd CGContext at screen scale (V2)
     ├─ bg:   mask = redraw at 1× (points) and fill regions with text colour or average colour
     └─ utility queue: PNG to disk (crash recovery) + keep UIImage (6 in session, 31 in buffer)
every 5 s (session) ──► AVAssetWriter H.264 Main, 1 fps, 40 kbit/s target (medium), keyframe ≤ 6, no B-frames
  └─ envelope item replay_video = msgpack {replay_event JSON, replay_recording rrweb JSON, mp4}
     recording = meta(4) + video custom(5) + touches(3: types 7/9, moves source 6) + breadcrumbs → ui.tap, resource.http, navigation
buffer mode ──► nothing encoded until an error; then last 30 s encoded as segment 0 and mode flips to session
crash ──► async-signal-safe C writes segmentId + lastSegmentEnd; next launch re-encodes PNGs when the fatal event is processed
transport ──► POST /envelope/ gzip; disk cache of 30 envelopes shared with everything; pauses offline and on rate limit
```

### 2.2 Sentry Android (sentry-java 8.62.0+16, B §4)

```
SentryAndroid.init (API ≥ 26) ──► ReplayIntegration; LifecycleWatcher foreground → sample → Session | Buffer strategy
RootViewsSpy swaps WindowManagerGlobal.mViews ──► last added root window is recorded (dialog replaces activity)
main looper: Runnable re-posted with postDelayed(1000 / frameRate), frameRate = 1
  ├─ no onDraw since last tick → re-emit the same bitmap (re-JPEG'd every second)
  └─ PixelCopy.request(window → RGB_565 bitmap at dp × sizeScale, rounded to 16) → callback on main:
       ViewHierarchyNode tree (View + Compose semantics) built on main
       → replay executor: MaskRenderer paints per-line text rects in text colour, image rects in average colour, else black
       → JPEG q30 to <cache>/replay_<id>/<ts>.jpg; .ongoing_segment key=value metadata
every 5 s (session) ──► MediaCodec video/avc, 75 kbit/s VBR (medium), 1 fps, I-frame every 6 s, MediaMuxer mp4
  └─ same msgpack replay_video item, written by hand in fixed key order
buffer mode ──► JPEGs only, rotated past 30 s; on error: encode + send with 100 ms gaps, convert to session strategy
crash / ANR ──► nothing encoded in process; next launch rebuilds last segment from JPEGs + .ongoing_segment (Backfillable)
transport ──► AsyncHttpTransport, gzip, envelope cache 30, session mode pauses offline / rate limited
```

### 2.3 Sentry Flutter (sentry-dart 10.2.0, C §4.2): capture moves to Dart, the rest stays native

```
SentryWidget = RepaintBoundary ──► capture(): synchronous until toImage future + mask list exist (coordinates match)
  ├─ RenderRepaintBoundary.toImage(pixelRatio = 1.0 for medium/high, 0.8 low)   ← logical points, not device pixels
  ├─ Element-tree walk (first match wins): user rules → SentryMask/Unmask → Image (asset images exempt) → Text/EditableText/RichText → SensitiveContent
  └─ PictureRecorder: draw image, fill rects in the widget's text colour → second toImage → toByteData(rawRgba)
iOS: cocoa's scheduler PULLS through SentryFlutterReplayScreenshotProvider; pixels cross as a malloc pointer, native frees
Android: Dart PUSHES on its own Scheduler (post-frame callback, never overlapping) through JNI into a reused ARGB_8888 Bitmap
native SDK ──► segments, H.264, msgpack, upload exactly as 2.1 / 2.2. No dedupe in Dart (hasSameImageAs exists, unused).
```

React Native (C §4.1) adds nothing to this picture: `mobileReplayIntegration` only serialises options, and the mask list `RCTTextView`, `RCTParagraphComponentView`, `RCTImageView`, `RCTImageComponentView`, `RNSVGSvgView` lives in the RN SDK and is resolved natively with `NSClassFromString`. `<Mask>`/`<Unmask>` are container view classes registered with the native walker, not tags.

### 2.4 PostHog iOS (posthog-ios 3.92.7, D §4.2)

```
swizzled UIView.layoutSublayers(of:) ──► onViewLayout, throttled to throttleDelay = 1 s with a trailing call (no timer)
snapshot():
  wireframe mode (default):
    root is a SwiftUI hosting controller? → return, log "enable screenshotMode"
    main thread: recursive walk → RRWireframe per visible view {id = view.hash, x,y,w,h, type, text (masked → '*' × len), RRStyle, base64 image if unmasked}
    emit $snapshot: meta(4) on first frame or size change, then ALWAYS a type-2 full snapshot of the whole tree (no diff, no dedupe)
  screenshot mode:
    main: mask walk → MaskedRegions (+ live rects of postHogMask() reporters; frame SKIPPED if a reporter has not laid out, during VC transitions, camera on screen)
    main: settle check: sample masks, wait 25 ms, sample again, pick renderer by drift
    main: drawHierarchy at native scale (fallback layer.presentation().render during motion)
    utility queue: redraw at 1 px/pt, fill masks black, WebP q0.3 via vendored libwebp (JPEG fallback) → data URL
    emit one type-2 full snapshot holding a single {type:"screenshot", base64} wireframe; dropped if base64 hash == previous
touches: swizzled UIApplication.sendEvent, began/ended only → rrweb MouseInteraction 7/9, own $snapshot
network: URLSession swizzle → rrweb plugin event rrweb/network@1 (no bodies)
queue ──► replayQueue on disk, flushAt 20 / 30 s, gzip, POST /s/ ; buffered on disk until remote config + minimumDuration resolve
```

### 2.5 PostHog Android (posthog-android 3.73.1, D §4.3)

Same shape, with three differences: window discovery through square/curtains and a per-decor-view `OnDrawListener` + `Throttler`; the wireframe walk runs **off main** on `PostHogReplayThread`; and **every frame after the first is diffed** (flatten, match by id, emit a type-3 mutation with adds/removes/updates; nothing emitted when nothing changed). Screenshot mode uses `PixelCopy` into a pooled bitmap at `screenshotScale` × physical pixels, masks painted, WebP q30; with `verifyScreenshotMaskAlignment` (always on for Compose) the mask walk repeats on every draw while a capture is armed and misaligned frames are discarded. Keyboard show/hide is a custom event.

### 2.6 PostHog Flutter (posthog-flutter 5.58.0, E §4.2)

```
PostHogWidget = RepaintBoundary; ChangeDetector = Timer.periodic(1 s) → addPostFrameCallback (no repaint → no capture)
tick: method channel getSessionReplayState → endOfFrame → synchronous Element walk for mask rects
      → toImage(pixelRatio 1.0 (iOS) | screenshotScale (Android)) → toByteData(rawRgba)
      → FNV-1a over every byte on the UI isolate; equal to last hash → drop
      → paint black masks on a PictureRecorder → toImage → PNG → MethodChannel sendFullSnapshot(bytes, id, x, y, w, h)
native: decode PNG → re-encode WebP q0.3 (iOS) / q30 (Android) → wrap as rrweb type-2 {type:"screenshot"} → native queue → /s/
native replay integration stays installed (touches, sampling, meta) but its own capture loop is off when sdkName == "posthog-flutter"
```

React Native (E §4.1): `@posthog/react-native-plugin` starts a **second, native** PostHog instance with `screenshotMode = true` / `screenshot = true` hard-coded since the first commit; JS owns the session id and pushes `endSession()` + `startSession(id)` lazily on the next `getSessionId()`; masking is `accessibilityLabel="ph-no-capture"` on a wrapper with `collapsable={false}`.

### 2.7 Luciq

Closed binaries, so the pipeline is known from docs, wrapper code and binary headers (F §4):

```
capture modes (LCQScreenshotCapturingMode): Navigation (default) | Interactions (+tap, swipe, pinch, scroll, debounced) | Frequency (timer ≥ 500 ms, default 1 s)
  └─ native view walk, private views and type rules painted as black boxes into the bitmap before it is stored or sent
  └─ WebP: High 50 %, Normal 25 % (default), Greyscale; ≈ 16 / 10 / 8 KB per frame; 1 MB (or 2 MB, pages disagree) per session
replay = still screenshots + user steps + network logs + Luciq logs + crash and APM markers on one timeline, grouped by screen
keep/drop: no sample rate; a syncCallback on the NEXT launch sees the previous session's metadata (crashes, bugs, OOMs, duration) and decides
upload: batches at most every 6 hours, never in background, so a replay arrives on a later launch
Flutter: hidden native hook → waits 100 ms (iOS) / 300 ms (Android) → asks Dart for rectangles over Pigeon → PixelCopy / drawViewHierarchyInRect → black boxes painted in plugin code
```

## 3. Reconstruction and players

| Vendor | Where | How | Source |
|---|---|---|---|
| Sentry | browser, FSL frontend | one `<video>` element per segment URL `/replays/<id>/videos/<segmentId>/`, preload ±3 segments with an LRU; an rrweb `Replayer` runs alongside with a **fake FullSnapshot injected after each meta event** so rrweb can draw the touch tail; taps clamped to a minimum visible duration; gaps between segments tracked | A §10 (`videoReplayer.tsx`, `videoReplayerWithInteractions.tsx`, `replayReader.tsx`) |
| PostHog | browser, at play time (ingest stores events as sent) | `transformEventToWeb` in `@posthog/replay-shared`: full snapshot → synthetic `html > head(style) > body` with ids 1–5, each wireframe a `position: fixed` element with inline CSS; `text` → div + text node, `image`/`screenshot` → `<img src=data-uri>`, inputs → `<input>`/`<select>`/`<progress>`; incremental `updates` become remove + add; screenshot nodes re-parented to `<body>`; player synthesises a full snapshot if playback starts on an incremental screenshot | D §4.5 |
| Luciq | closed | stepped timeline of screenshots plus logs | F |
| OpenReplay | server + player | image service appends `[ts][size][jpeg]` records to one `replay.frames` file per session, zstd at session end; player shows the last frame at or before the playhead, touches overlaid from the message stream | G.3 |
| LaunchDarkly | none needed | tiles are already rrweb `<img>` nodes with absolute positions; a stock rrweb player plays them | G.6 |
| New Relic, Mixpanel | none needed | rrweb full/incremental events (New Relic wireframe; Mixpanel JPEG `<img>`) | H §4.2 |
| Datadog | player | own schema (not rrweb): `records[]` with FullSnapshot 10 / Incremental 11, wireframe `shape|text|image|placeholder|webview|embedded_content`, images fetched as separate resources | G.2 |

**Lesson for ouo.** Three independent vendors (PostHog, LaunchDarkly, Mixpanel, New Relic) put mobile replay into rrweb events and play them with the stock rrweb player. Sentry needed a separate video player plus an rrweb overlay. ouo already has an rrweb player in the Grafana plugin (`project/kb-archive/grafana-app-plugin.md`) and a video player for Sentry-sourced replays (`project/kb-archive/grafana-plugin-video-player.md`); screenshot frames or tiles as rrweb `<img>` mutations would let one renderer play web, mobile frames and mobile wireframes.

## 4. Wire size

Measured rows come from this repo's golden capture (`collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/`, 77 `replay_video` segments, 423 s, iPhone 18 Pro simulator at 402×874 points, sentry-cocoa 9.30.1 under `@sentry/react-native` 8.30.0, medium quality, 1 fps). Re-aggregated by the orchestrator from the decoder output; the per-run figures match A §7.3 exactly.

| Vendor / mode | Per frame or segment | Per minute while the screen changes | Static screen | Provenance |
|---|---|---|---|---|
| **Sentry iOS, masked (default)** | 5–6 s segment: median **9.6 KB** mp4 (5.8–16 KB); I-frame 4–5 KB, P-frames 0.2–1.1 KB; `replay_event` ≈ 1.7 KB; recording 0.4–5.5 KB | **≈ 110 KiB** (122 KiB gzip body) | still one I-frame per segment ≈ 60 KiB/min | measured, A §7.3 |
| **Sentry iOS, unmasked** | median **34–36 KB** per segment; I-frame 24–27 KB, a mid-segment screen change adds a 44 KB keyframe | **≈ 362 KiB** | ≈ 300 KiB/min | measured, A §7.3; consistent with the B3 harness, where Sentry uploaded 651 KB in a 95 s masking-off run including all other telemetry ([sdk-overhead-ios.md](../sdk-overhead-ios.md)) |
| Sentry iOS, bitrate target | 40 kbit/s medium (20 low, 60 high), target not cap | 293 KiB (146 / 439) | — | code, A §7.2 |
| Sentry iOS, vendor claim | "10 KB/s" | 586 KiB | — | docs, A §7.1 |
| Sentry Android, medium | ≤ ~47 KB per 5 s segment (75 kbit/s VBR cap) + 1–3 KB JSON; a 1080×2400 phone encodes at 416×912 | ≤ ~560 KB (low ≤ 375, high ≤ 750); docs say "7 KB/s" ≈ 420 KB | VBR, far lower | code + docs, B §7 |
| Sentry Flutter | same encoders as above; **1.34 MiB raw RGBA per frame crosses Dart → native before encoding** (1.47 MiB on a 412×915 dp Android) | same as native | same | code, C §7 |
| Sentry RN | native pipeline; JS adds per segment: `ui.tap` ≈ 730 B, `fetch` 271 B, `console` ≈ 290 B, touches 118–167 B each, `options` 346 B on segment 0 | native + ≈ 1–5 KB JSON per busy segment | — | measured, C §9 Q10 |
| **PostHog iOS, wireframe** | full tree every second: ≈ 10 KB raw for a 50-view screen (text wireframe ≈ 295 B, bare div 32–82 B, with background image 2.2 KB) | ≈ 600 KB raw, **≈ 12 KB gzipped** (20 snapshots per `/s/` batch compress together) | same, no dedupe | measured on fixtures, D §7 |
| PostHog Android, wireframe | incremental with 3 updated nodes ≈ 0.9 KB raw / 0.4 KB gz | a few KB gzipped | 0 | measured on fixtures, D §7 |
| PostHog screenshot (iOS, RN, Flutter) | 1 px/pt WebP q0.3: ≈ 15–40 KB per changed frame (27 KB JPEG q30 measured at 402×874) | 1.2–1.6 MB at 60 changed frames; **0.2–0.8 MB typical** (10–20 changes) | ≈ 0 (hash dedupe) | measured + derived, D §7, E §10 |
| PostHog Android screenshot | **physical** pixels × `screenshotScale` (1.0) WebP q30, ≈ 7× the pixels of a dp-sized frame | higher than iOS unless scale is lowered | ≈ 0 | code, E §10 |
| Luciq | WebP ≈ 10 KB per frame at Normal (16 KB High, 8 KB Greyscale), derived from the "1 MB ≈ 104 screenshots" docs line | ≈ 600 KB at 1 fps Frequency mode until the 1 MB budget (~100 s); Navigation mode ≈ 200–400 KB per whole session | ≈ 0 (no capture without a transition) | docs-derived, F §4.1, §7.2 |
| Datadog | 50-wireframe Meta + Focus + FullSnapshot 13.4 KB raw → **1.6 KB** deflated; one text update ≈ 162 B; images separate, MD5-deduped | docs: ≈ 12 KB/s iOS, 1.2 KB/s Android | ≈ 0 | derived from schema, G.2; docs, H §7 |
| OpenReplay | 15–40 KB per JPEG, no codec, no dedupe on native | 0.9–2.4 MB at 1 fps, 2.7–7.2 MB at 3 fps | same (no dedupe) | derived, G.3 |
| LaunchDarkly | only the bounding rect of changed 64-px tiles, JPEG q0.3; keyframe every 10–15 frames | depends on change area | 0 | code, G.6 |
| Mixpanel | JPEG q0.4 full frame, ≤ 1 per 500 ms, only when dirty | ≤ 120 frames × ~30 KB | 0 | code, H §4.2 |
| UXCam | video; docs: 10–280 KB/min iOS, 30–400 KB/min Android by quality | as stated | — | docs, H §7 |
| Contentsquare | docs: ≤ 838 / 545 / 369 KB/min Android High/Med/Low; ≤ 2 MB/min iOS High | as stated | — | docs, H §7 |
| LogRocket | docs: "typically around 15 KB a second" | ≈ 900 KB | — | docs, H §7 |
| Fullstory | docs: "tens of kilobytes per minute", a screenshot would be 10–20 kB per view | as stated | — | blog, H §7 |
| New Relic | docs: ≈ 5.3 MB per replay; perf test +29.6 KB per session | — | — | docs + repo, H §7 |
| **ouo today (ADR-0006)** | JPEG q0.5 at half resolution, 20–40 KB per changed frame, base64 in gzip JSON | nominal 1.2–2.4 MB at 1 changed frame/s (ADR-0006's per-frame bound); **measured at matched quality ≈ 2× Sentry**, +267 KB/min at T4 (checklist N50) | ≈ 0 (dedupe) | ADR-0006, N50 |

Reading: Sentry's H.264 is **5–20× smaller than ADR-0006's nominal per-frame JPEG bound** when the screen changes every second (the measured gap on the same journey is ≈ 2×, N50, because real screens do not change every second), because a 5 s segment costs one I-frame plus near-empty P-frames. Wireframes are another order of magnitude smaller still, but only describe what the tree can see. The cheapest screenshot design in the field is LaunchDarkly's tile diff: zero bytes for a static screen and only changed tiles otherwise.

## 5. Performance footprint: the claims and how they were measured

| Vendor | Claim | Method | Reproducible from the repo? | Source |
|---|---|---|---|---|
| Sentry iOS, V1 → V2 renderer | 149 ms → 25 ms render per frame at 2× on iPhone 8 (≈ 155 → 31 ms with redact); 9–10 dropped frames per capture → ≈ 2 | hand-added `DispatchTime` timing around redact and render, rolling 120 samples, sample app, manual run | **No**: the timing code was never committed; unit tests could not render | A §7.1, PR #4940 |
| Sentry iOS, replay on | FPS 55 → 53, memory 102 → 121 MB, CPU 4 → 13 %, cold start unchanged, ≈ 25 ms main thread per capture, 10 KB/s | Pocket Casts, iPhone 14 Pro, full masking, "same flow 10 times", medians | No harness published. **ouo's own measurement** (N22, [sentry-ios-replay-internals.md](../sentry-ios-replay-internals.md)): ≈ 22 ms main thread per capture on an iPhone 16 Pro Max with masking off, 73–83 captures per 75 s | docs, A §7.1 |
| Sentry iOS, run-loop scheduler | slow frames 4.1 % → 1.4 %, p99 74.9 → 25.7 ms (iPhone 15, iOS 26.5) | "benchmark app" outside the repo | No | PR #7851, A §4.2 |
| Sentry iOS, CI | — | `Benchmarking.yml` ran `testProfilerCPUUsage` on Sauce Labs: **profiler only, never replay**; deleted 2026-08-06 (`d888cf5b`); only `size-analysis.yml` remains | Removed | A §7.1 |
| Sentry Android, replay on | FPS 55 → 54, memory 255 → 265 MB, CPU 36 → 42 %, cold start +6 ms, 7 KB/s | Pocket Casts, Pixel 2 XL, Android 11, 10 runs | No | docs, B §7 |
| **Sentry Android, faster startup** | `SentryAndroid.init` 43.5 ms (8.43.0) → 33.1 ms (8.54.0), −23.9 %; −3 MB heap | **In-repo Jetpack Macrobenchmark**: `StartupTimingMetric` + `TraceSectionMetric("SentryAndroid.init")`, `StartupMode.COLD`, `CompilationMode.Full()`, 12 iterations (thermal throttling after ~14), interleaved A/B rounds, Pixel 3 with locked clocks, airplane mode; Sauce Labs variant echoes JSON through logcat | **Yes** (`sentry-uitest-android-macrobenchmark`, not a CI gate); the older CPU / dropped-frame benchmark and the 50-run startup diff were deleted 2026-08-25 (`67c065ca6`) | blog + code, B §8 |
| Sentry RN | the iOS/Android Pocket Casts tables re-published; **not an RN app** | — | `performance-tests/` (TestAppPlain vs TestAppSentry, 50 runs, Sauce Labs, init only, no replay) deleted 2026-10-16 (`52ff298c`) | C §7 |
| Sentry Flutter | Open Food Facts: iPhone X CPU 30.0 → 31.9 %, memory flat; Pixel Fold CPU 93 → 106 %, memory 372 → 392 MB | 10 runs, `py-ios-device` | `metrics/` mobile jobs removed (`e77adf4e`); `microbenchmarks/` (toImage, toByteData, JNI) exist without results | C §7 |
| PostHog (all) | none quantified | — | one Robolectric mask-walk microbenchmark gated by `POSTHOG_BENCHMARK=1`, "not a CI test" | D §7, E §7 |
| Luciq | cold launch +54 ms (iPhone 14 Pro) / +64 ms (iPhone 12 Pro), +38.9 ms (S20 FE) / +50 ms (Pixel 5A); main thread per screenshot ≈ 56–66 ms iOS, ≈ 2.5 ms Android; download +5.3 / +4.4 MB; RAM ≈ 7.3 / 28 MB; no CPU or battery figure | devices and SDK versions named, no tool, run count, percentile or feature set; claims a CI launch gate (> 10 % regression on a Pixel 6 blocks the commit) | No (closed) | docs, F §7 |
| Datadog | Android core CPU 26.8 vs 25.2 %, TTID 243 vs 229 ms, APK +552 KB; SR janky frames 3.2 % → 3.9–5.6 % (Views), 2.9 % → 6.2–6.9 % (Compose), memory up to +55 MB; iOS IPA +1.4 MB | baseline vs instrumented app in Synthetics, CPU from `task_info` / `/proc/self/stat`, RSS, FPS from `CADisplayLink` / Choreographer, exported through the **OTel metrics SDK** | **Yes** (`BenchmarkTests/`, `tools/benchmark/`) | G.2 |
| Embrace iOS | launch 2.317 → 2.360 s (+1.9 %) | `XCTApplicationLaunchMetric` with vs without SDK; PR gate on BrowserStack with a Welch t-test, 5 % threshold | **Yes** | G.1 |
| New Relic Android | cold start +110.8 ms (+8.1 %), memory +9.25 MB, janky frames +2.7 %, APK +385 KB | Now in Android app, v7.7.2, 5 baseline vs 4 SDK runs, per-run tables in `performance.md` | Yes (data), small n | H §7 |
| Contentsquare | Android High: main-thread CPU < 15 %, 15 MB, startup +7.3 ms (Pixel 9) / +22.7 ms (Pixel 6) | named devices, "nightly tests" | No | docs, H §7 |
| LaunchDarkly | tile hash "20×", "100× on Pixel 8" | commit messages only | No | G.6 |
| UXCam, LogRocket, Fullstory, Amplitude, Mixpanel, Quantum Metric, Medallia | bare numbers or "unnoticeable" | none stated | No | H §7 |

**What this means.** The two Sentry blogs are grounded differently. The iOS V2 blog's numbers are a one-off manual measurement whose code never shipped; what shipped is the renderer, and its design holds up in code. The Android startup blog is backed by a committed, documented macrobenchmark. No vendor in the field gates **replay** overhead in CI. An ouo harness that runs a replay-on app against a replay-off app and publishes per-run frame time, CPU, memory and bytes per minute would be unique (C §10, H §10).

## 6. Blog-to-code grounding, condensed

### 6.1 "Boosting Session Replay performance on iOS with View Renderer V2" (A §8)

| Blog claim | Code | Verdict |
|---|---|---|
| V1 created a `UIGraphicsImageRenderer` per frame and `drawHierarchy` cost ≈ 155 ms on iPhone 8 | `SentryDefaultViewRenderer.swift:8-13` | code true; number from a manual run |
| V2 draws into a hand-made `CGContext` (`calloc` w×h×4, flipped CTM, `UIGraphicsPushContext`) at screen scale, ≈ 80 % less main-thread time | `SentryGraphicsImageRenderer.swift:43-89`, `SentryViewRendererV2.swift:14-28` | true |
| `layer.render(in:)` is faster still but loses tab-bar SF Symbols, so it is opt-in `enableFastViewRendering` | `SentryViewRendererV2.swift:21-25`, default false | true |
| experimental in 8.48.0, default from 8.50.2 | CHANGELOG: experimental in **8.47.0** (#4940), GA and default in **8.50.0** (#5054), 8.50.2 fixed defaults for one init path | off by one |
| what was not in the blog | V2 also switches the mask renderer; a later PR replaced the display-link cadence with a run-loop observer plus backoff (#7851, 9.19.0) and live encoding from memory (#8636, 9.26.0) | — |

### 6.2 "The Sentry Android SDK is now 20–30 % faster" (B §8)

| What was slow | Fix | Commit |
|---|---|---|
| `PackageManager.getApplicationInfo(GET_META_DATA)` + Bundle unparcelling to read manifest options on main | SAGP generates a static `ManifestMetadataReader.manifestMetadata` map at build time; runtime skips the lookup when present (−6.5 %) | `5dc72eec5` (#5976) |
| `Class.forName` probes for Fragment / Timber / Replay availability | SAGP generates `LoadClass.classAvailability` at build time | `1e904b2bb` (#5875) |
| `new URI(dsn).normalize()` took ≈ 6 ms on main | `indexOf` / `substring` parsing, ≈ 1 µs | `29f120b09` (#5448) |
| a `java.util.Timer` thread per transaction (idle/deadline timeouts) plus permanent timers in `LifecycleWatcher` and `RateLimiter` ("dominant source of thread churn", 1 MB ART stack each) | one lazily started shared timer executor that idles out (−3 MB) | `bcd3e76a8` (#5670), `023ef0038` (#5819), `c318acd31` (#5814) |
| plus ten smaller items | deferred frame-metrics `HandlerThread`, less reflection, no executor prewarm, lazy dirs, batched scope writes, shake detector off main, lazy locks | B §8 list |
| still on main | `SentryInitProvider.onCreate` → `SentryAndroid.init`, bracketed by the `SentryAndroid.init` trace section the benchmark measures | `C/SentryAndroid.java:101-227` |

## 7. RUM signals captured (native SDKs)

| Signal | Sentry iOS | Sentry Android | PostHog iOS | PostHog Android | Luciq | Datadog | Embrace |
|---|---|---|---|---|---|---|---|
| Sessions / release health | 30 s background rule, `ok/exited/crashed/abnormal` | same via `LifecycleWatcher` | `$session_id` UUIDv7, 30 min idle / 24 h | same | yes | 15 min / 4 h | 30 min / 12 h, session = span |
| Crashes | SentryCrash (Mach + signals), next launch | JVM handler + sentry-native NDK + tombstones | vendored PLCrashReporter, opt-in | JVM + NDK tombstones, opt-in | yes incl. NDK | KSCrash / NDK | KSCrash / libunwindstack |
| ANR / hangs | watchdog thread, 2 s, fully vs non-fully blocking | v1 watchdog 5 s; v2 `ApplicationExitInfo` next launch | **none** | **none** | app hang 3 s, UI hang 250 ms, ANR, force restart | 5 s watchdog, iOS off by default | 249 ms thread blockage |
| App start | `sysctl` process start, prewarm aware, spans | `Process.getStartUptimeMillis`, content providers, API 35 start type | none | none | yes | TTID/TTFD | span tree |
| Slow / frozen frames | `CADisplayLink`, frozen > 0.7 s | `OnFrameMetricsAvailableListener`, frozen > 700 ms | none | none | yes (UI hangs) | 700 ms | — |
| Screen loads, TTID / TTFD | VC swizzling, `ui.load` | `ActivityLifecycleIntegration`, 25 s TTFD cap | `$screen` only | `$screen` only | screen load | views | view spans |
| Network | `URLSessionTask.resume` swizzle, spans + `sentry-trace`/`baggage` | OkHttp interceptor + event listener | replay plugin event only, `X-POSTHOG-*` headers | OkHttp interceptor, opt-in | yes, W3C headers opt-in | yes, `tracecontext` + `datadog` | spans, `traceparent` off by default |
| User interactions | `sendAction` swizzle, `ui.action.click` | `Window.Callback` + `GestureDetector` | `sendAction` swizzle, off by default | curtains, off by default | user steps (tap, double tap, long press, pinch, swipe, scroll) with view type and label, max 100 per report | actions | `emb-ui-tap` events |
| Profiling | 101 Hz sampling, continuous | method tracing, Perfetto on API 35 | none | none | session profiler | continuous | — |

Detail and citations: A §3, B §3, D §3, F §3, G.1, G.2.

## 8. OpenTelemetry

| Vendor | OTel SDK in process | OTLP to any collector | Session attribute | Propagation | Source |
|---|---|---|---|---|---|
| Sentry (all mobile SDKs) | no | no | Sentry session envelope | `sentry-trace` + `baggage`; W3C `traceparent` opt-in | A §5, B §5, C §5 |
| PostHog (all) | no | **logs only**, OTLP/JSON to `/i/v1/logs` (core also has OTLP traces/metrics builders, unused on mobile) | `$session_id`, `sessionId` log attribute | `X-POSTHOG-SESSION-ID` / `-DISTINCT-ID` | D §5, E §5 |
| Luciq | no | no | — | home-made `traceparent` (epoch-seconds hex + 32 random bits, repeated) injected or caught on captured requests, server-flag gated | F §5 |
| Embrace | yes (opentelemetry-kotlin compat / swift-core) | yes via app-registered exporters; export-only mode without an app id (no disk persistence on Android then) | iOS `session.id`; Android `emb.*` only | `traceparent` off by default | G.1 |
| Datadog | tracing **API** only | **no** | RUM JSON `session.id` | `datadog` + `tracecontext` | G.2 |
| opentelemetry-android | yes | yes, OTLP/HTTP, disk buffering | `session.id`, `session.start/end` | W3C | G.5 |
| opentelemetry-swift | yes | yes | `session.id` (Sessions module) | W3C | G.5 |
| Honeycomb, Elastic EDOT, LaunchDarkly | yes | yes, endpoint configurable | `session.id` | W3C | G.5, G.6 |
| Splunk | yes | OTLP, Android custom URL must contain `auth=` | `session.id` + legacy | W3C | G.5 |
| Bugsnag Performance | **no** (own tracer) | emits OTLP/HTTP JSON traces to an overridable endpoint | `bugsnag.*` | — | G.7 |
| New Relic, Dynatrace | no | backend ingests OTLP, agent proprietary | — | — | H §5 |
| Everyone else | no | no | — | — | H §5 |

Semantic conventions (v1.44.0, all `development`): `session.id`, `session.previous_id`, `session.start` / `session.end`, `app.screen.*`, `app.widget.*`, `app.jank.*`, `app.crash`, `device.app.lifecycle` with `ios.app.state` / `android.app.state`. There is no convention for app start spans, screen views or replay (G.5).

## 9. Feature matrix (condensed; full 24-vendor matrix with footnotes in H §6.1)

| Feature | Sentry | PostHog | Luciq | Datadog | Embrace | OpenReplay |
|---|---|---|---|---|---|---|
| Mobile crash reporting | yes | partial (opt-in; Android JVM + NDK tombstones, no ANR) | yes | yes | yes | partial (NSException only on iOS) |
| Mobile performance monitoring | yes | partial (nothing beyond network in replay) | yes | yes | yes | partial |
| Session replay | yes, screenshot video | yes, wireframe / screenshot | yes, WebP screenshots per screen change | yes, wireframe | no | yes, JPEG frames |
| User interaction timeline | yes (breadcrumbs, `ui.tap` in replay) | partial (touches in replay; autocapture off by default) | yes (user steps) | yes (actions) | yes (event timeline) | yes |
| Replay linked to issues | yes (`contexts.replay.replay_id`, buffer flush on error, next-launch crash replay) | yes (shared `$session_id`) | yes | yes | no | partial |
| Journey / funnel analysis | **no** | yes (funnels, paths, retention) | yes (retroactive funnels over screens, events and endpoints, drop-offs linked to replays; code-instrumented Flows) | yes | partial (two-point flows) | web only |
| In-app bug reporting / feedback | yes (feedback widget, shake, 30 s replay) | partial (surveys) | yes (core product) | no | no | no |
| OTel export | no | logs only | no | API only | yes | no |
| Open-source SDK | yes, MIT | yes, MIT | wrappers only | yes, Apache-2.0 | yes, Apache-2.0 | mixed (ELv2 / AGPL / unlicensed) |

## 10. Platforms and languages for the six targets

| Target | Sentry | PostHog | Luciq |
|---|---|---|---|
| Native iOS, Swift | sentry-cocoa 9.32.0, iOS 15+, mostly Swift now (53k Swift vs 22k ObjC lines); SwiftUI product with `.sentryReplayMask()` | posthog-ios 3.92.7, iOS 13+ (replay iOS only); SwiftUI needs screenshot mode and `.postHogMask()` | `LuciqSDK` xcframework 19.13.0, iOS 15+, 12.8 MB arm64 slice; ObjC headers with `NS_SWIFT_NAME`, a 39-line `.swiftinterface` for SwiftUI modifiers (`.luciq_privateView()`, `.luciqTracedView`) |
| Native iOS, Objective-C | curated `@objc` API incl. `options.sessionReplay` and `SentrySDK.replay`; `SentryObjC` wrapper for module-less ObjC++; SPI knobs (`frameRate`, segment durations) hybrid-only | public API `@objc` (`PostHogSDK.shared`, every config field); SwiftUI modifiers Swift-only | first-class: the public API **is** Objective-C (`LCQ*` headers), bundle id still `com.Instabug.Instabug` |
| Native Android, Kotlin | sentry-android 8.62.0, minSdk 21, replay API ≥ 26; replay module Kotlin, Compose masking modifiers, Compose 1.5–1.10.2 | posthog-android 3.73.1, minSdk 23, replay API ≥ 26; Compose only in screenshot mode | `ai.luciq.library:luciq` 19.15.0 (core 5.9 MB AAR, 4,676 classes, `kotlin-stdlib`), `luciq-compose` with `Modifier.luciqPrivate()`; NDK crashes API 21+ |
| Native Android, Java | Java-first public API; a Java app loses only Compose modifiers (irrelevant without Compose) | `@JvmOverloads` config, `@JvmStatic` factories | Java API (`Luciq.addPrivateViews`, `SessionReplay.setSyncCallback`), obfuscated internals |
| React Native | `@sentry/react-native` 8.33.0 wrapping cocoa 9.32.0 / android 8.62.0; replay = native + class names; Expo dev client required; Fabric and Hermes supported; `replaysSessionQuality` ignored on Android | `posthog-react-native` 4.84.3 + `@posthog/react-native-plugin` (old-arch bridge module via interop); forced screenshot; Expo dev build required; JS gzip unavailable on Hermes | `@luciq/react-native` 19.10.1 (MIT) over Luciq iOS 19.9.3 / Android 19.10.1: TurboModule spec, XHR patching, React Navigation screen reports with a 1 s settle timer, hidden `cp_*` native hooks; Expo dev build required |
| Flutter | `sentry_flutter` 10.2.0 wrapping cocoa 9.31.0 / android 8.61.1 via method channel (iOS) and jnigen JNI (Android); Dart-side capture and masking | `posthog_flutter` 5.58.0; Dart-side capture, PNG over method channel | `luciq_flutter` 19.9.4 (MIT), Pigeon channels, Dart user steps and frame timing, Dart mask rectangles, plugin-side capture; `luciq_dio_interceptor`, `luciq_http_client`, `luciq_gql_link` |

## 11. Open source or blogs only?

| Vendor | What is open | What we could only read in docs or blogs |
|---|---|---|
| Sentry | sentry-cocoa, sentry-java, sentry-react-native, sentry-dart, sentry-native (all MIT); server and player source-available (FSL) | the two blogs' measurement harnesses (never committed), Pocket Casts overhead runs |
| PostHog | posthog-ios, posthog-android, posthog-js monorepo (RN), posthog-flutter, posthog-unity, the posthog server and transformer (MIT outside `ee/`) | nothing structural; performance claims absent |
| Luciq | `luciqai/luciq-reactnative-sdk` and `luciq-flutter-sdk` (MIT; the Instabug repos were archived in October 2026), a PII masking linter, CLIs, a HyperDX fork; binary public headers and AAR class lists | the entire native capture, replay, APM and crash pipeline, the wire format, the player; the footprint page |
| Embrace, Datadog, LaunchDarkly, New Relic, Mixpanel, Bugsnag, Firebase | full SDKs (Apache-2.0 / MIT) | backend formats |
| OpenReplay | source visible, but ELv2 / AGPL / unlicensed: ideas only | — |
| Splunk / Smartlook, Clarity native, Amplitude core, UXCam, Fullstory, LogRocket, Contentsquare, Dynatrace, Quantum Metric, Glassbox, Medallia | wrappers only | everything |

## 12. What ouo should build (recommendations)

These are the orchestrator's conclusions from A–H, written against ADR-0006 (native screenshot capture, iOS first, JPEG frames) and the roadmap's native SDK phases.

1. **Keep screenshot capture with on-device masking as the base technique.** Every vendor, including the wireframe-first ones, falls back to it for SwiftUI, Compose, RN and Flutter, which is where new apps are written (D §10, G.2, H §9). Wireframes can be a later, optional track for UIKit/View apps, and New Relic's open captors are the reference if we do (H §10).
2. **Move from JPEG frames to a diffed representation before shipping Android.** Two options, both cheaper than ADR-0006's 20–40 KB per frame: (a) Sentry's H.264 segments, measured at ≈ 110 KiB/min masked, with the cost of a video player plus an rrweb overlay (A §10); (b) LaunchDarkly's 64-px tile diff emitted as rrweb `<img>` mutations, zero bytes for a static screen, playable by the rrweb player we already ship (G.6, G §10). Recommendation: prototype (b) first because it reuses the Grafana rrweb player and keeps web and mobile on one format; keep `kind: "video"` for Sentry-sourced replays. This deserves an ADR revision.
3. **Capture cadence: change-driven with a budget, not a timer.** Sentry iOS: run-loop observer, 1 fps base, full rate during interaction, deferral during animations, backoff when a capture costs ≥ 150 ms (A §4.2). PostHog: layout/draw-driven with a 1 s throttle and a trailing capture, overlapping captures dropped (D §10). Datadog Android: a time bank of 100 ms of capture work per second (G.2). Combine: dirty flag from layout/draw → at most one capture per second → skip when over budget → report skipped frames as a metric.
4. **Rendering on iOS: copy V2.** `drawHierarchy(afterScreenUpdates:false)` into a raw `CGContext` at screen scale, downscale to 1× off the main thread, never `UIGraphicsImageRenderer` per frame, never `layer.render(in:)` by default (A §4.5). On Android: `PixelCopy` into a pre-sized RGB_565 bitmap at dp resolution, `OnDrawListener` dirty flag, `RootViewsSpy` window discovery, last root wins (B §10).
5. **Masking: fail closed, mask by default, two-pass check.** Mask text inputs, labels, images and web views by default (we already do). Add PostHog's and LaunchDarkly's rule: drop the frame when mask geometry moved between two samples, when a mask reporter has not laid out, during view-controller transitions, or when the masked render fails (D §10, G.6). Mask whole subtrees when a tree read throws (Sentry iOS) and when Compose traversal fails (fix Sentry Android's fail-open, B §10). Keep RN class lists for both architectures and resolve them with `NSClassFromString` (C §10). Expect per-iOS-release fixes for private SwiftUI classes and ship a mask preview tool.
6. **Crash durability.** Keep frames on disk, write the segment/chunk id and last end time from the crash handler with async-signal-safe C, and finish the last chunk on the next launch, triggered by the crash event (A §4.8, B §4.8). Give replay its own disk budget so it cannot evict crash reports (A §10).
7. **React Native: native does the work; JS owns nothing it cannot be told about.** Keep the Expo module thin (options, class names, `ouo-mask` container views with `collapsable={false}`). Do not cache session or replay ids in JS without a native→JS event on rotation (Sentry's stale `trace.replay_id` bug, C §4.1). Avoid PostHog's second-full-SDK design and its base64 bridge hop (E §10, C §10). Compress natively; Hermes has no `CompressionStream` (E §9 Q6).
8. **Flutter: Dart-side capture is unavoidable, so do it once.** `RenderRepaintBoundary.toImage` at 1× logical pixels, synchronous Element walk for masks in the same frame, hash a downsampled copy (not 1.3 MB on the UI isolate), skip the tree walk when unchanged, hand raw RGBA or a single JPEG/WebP to native without a PNG round trip, let native chunk and upload (C §10, E §10, H §10).
9. **OTel is our differentiator; nobody exports replay or even RUM over OTLP to a user's collector except Embrace and a few OTel distributions.** Build on opentelemetry-android (sessions, crash, ANR, jank, OTLP, disk buffering already there) and opentelemetry-swift (Sessions module; add lifecycle, taps, screens and crash ourselves, following Honeycomb's and Embrace's Apache-2.0 code). Use semconv `session.id`, `session.previous_id`, `session.start/end`, `app.screen.click`, `device.app.lifecycle`. Emit taps and screen views as their own log events, not span events on a long session span (G §10). Keep replay chunks on the collector's replay receiver path with `session.id` as the join key (ADR-0007).
10. **Fill PostHog's gaps, match Sentry's vitals, add what Sentry lacks.** ANR/hang detection, app start spans with a kernel process-start origin (`sysctl` on iOS, Bugsnag's approach, G.7), slow/frozen frames at the 700 ms industry threshold, screen-load spans with TTID/TTFD. Then a basic screen-sequence funnel or path view over spans in Grafana would already beat Sentry's offer (H §10).
11. **Keep the B3 harness and make it the public method.** `docs/benchmarks.md` already does what no vendor does: one app, real taps, paired deltas against a no-SDK baseline, tiers, replay bytes per minute, per-run data in the repo. Add what the field suggests: a trace section around init measured like Sentry Android's macrobenchmark (B §8), CPU / memory / FPS exported through our own OTel pipeline like Datadog (G.2), and Android cells when phase 10 lands.
12. **Do not compete on in-app bug reporting first.** Luciq, Shake and Sentry feedback own it and it is not OTel-shaped (H §10).
13. **Borrow three Luciq ideas that cost little** (F §10): a **navigation-only capture mode** (one frame per screen change plus a per-session byte budget) as the low-end default next to 1 fps; **human-readable user steps** (`Tapped on the button "Send"`) as OTel log events with gesture, view type, label and screen, with a content-capture kill switch; and a **next-launch keep/drop hook** that sees the previous session's summary (crashes, errors, duration) before uploading its replay, which is client-side tail sampling. Device tiers (cores, RAM, OS) that degrade capture on low-end phones belong with them.

The ranked `sdk/ios` change list in [sentry-ios-replay-internals.md](../sentry-ios-replay-internals.md) (render 1:1 and downscale off main, no touch-triggered captures, run-loop observer, one in flight, lighter walk, backoff) is the concrete first step for items 3 and 4; this research adds the cross-vendor evidence and the Android, RN and Flutter sides.

## 13. Open questions and limits of this research

- All wire-size and footprint numbers for vendors other than Sentry iOS are derived from code constants or fixtures, not measured on a device. The Sentry iOS numbers come from a React Native app on a simulator; a native UIKit app with photos would sit closer to the unmasked rows.
- sentry-android's `maskAllText` coverage of React Native's newer Android text views that do not extend `TextView` was not verified (C §9 Q18).
- Luciq's capture internals cannot be verified; everything in F is docs, wrapper code or header names.
- Amplitude's and Dynatrace's exact capture technique could not be determined from public material (H §4.1).
- The CI benchmark deletions in sentry-cocoa (August 2026), sentry-java (August 2026), sentry-react-native (October 2026) and sentry-dart mean the blog numbers cannot be re-run from the repos today; the Android macrobenchmark module is the exception.
