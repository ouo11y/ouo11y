# Sentry mobile Session Replay: format, bytes per minute, masking (evidence)

- **Versions:** @sentry/react-native 8.34.0 (2026-11-05), sentry-cocoa 9.33.0 (bundled by RN), sentry-android 8.62.0 (bundled by RN; source read at sentry-java 8.63.0). Self-hosted Sentry 26.10.0.
- **Research date:** 2026-11-10.
- **Method:** observed on an iOS 27.0 simulator (iPhone 18 Pro, `step6-sentry-mobile`) and an Android 15 (API 35) emulator (Pixel 6 profile, 1080x2400, 420 dpi), Release builds of `examples/sentry-mobile`. Traffic went through `sentrytap` to self-hosted Sentry. Source facts link to the release tags.
- **Scope:** facts only. This file does not pick between wireframe and video replay. The cross-vendor comparison is in Step 4's [mobile-replay-format-evidence.md](../../../client-sdk-features/mobile-replay-format-evidence.md). Wire format details are normative in [wire-format/replay-wire.md](../wire-format/replay-wire.md). Storage is in [self-hosted-storage/](../self-hosted-storage/index.md).

## 1. The pipeline in one table

| Step | iOS (sentry-cocoa 9.33.0) | Android (sentry-android 8.62.0) | Source |
|---|---|---|---|
| Trigger | Run-loop observer after UI work, at most 1 fps | Main-looper runnable every `1000 / frameRate` ms (1 fps) | [ios/architecture.md](ios/architecture.md) section 13; [WindowRecorder.kt#L108](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-replay/src/main/java/io/sentry/android/replay/WindowRecorder.kt#L108) |
| Capture | `drawHierarchy` of the window. The mask is drawn on a background queue in the view's average colour | `PixelCopy` of the window surface (default). The masks are solid blocks | [android/architecture.md](android/architecture.md) section 13 |
| Frame store | One PNG per frame on disk, plus the in-memory image | One JPEG per frame in the `replay_<id>` cache folder | [ios/reliability.md](ios/reliability.md), [android/reliability.md](android/reliability.md) |
| Encode | `AVAssetWriter`, H.264 Main AutoLevel, no B-frames, keyframe interval 6, average bit rate 20/40/60 kbps for low/medium/high | `MediaCodec` H.264, `KEY_I_FRAME_INTERVAL` 6, bit rate 50/75/100 kbps for low/medium/high, size scale 0.8/1/1 | [SentryOnDemandReplay.swift#L395-L414](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryOnDemandReplay.swift#L395-L414), [SentryReplayOptions.swift#L106-L112](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L106-L112), [SimpleVideoEncoder.kt#L149-L160](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-replay/src/main/java/io/sentry/android/replay/video/SimpleVideoEncoder.kt#L149-L160), [SentryReplayOptions.java#L78-L86](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryReplayOptions.java#L78-L86) |
| Segment | 5 s (`sessionSegmentDuration`). On-error buffer 30 s. Maximum 60 min | 5 s, 30 s buffer, 60 min | [SentryReplayOptions.swift#L42-L45](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L42-L45), [SentryReplayOptions.java#L135-L144](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry/src/main/java/io/sentry/SentryReplayOptions.java#L135-L144) |
| Envelope | One `replay_video` item per segment. Its payload is a msgpack map of `replay_event`, `replay_recording` and `replay_video` (the mp4 bytes) | Same | [wire-format/replay-wire.md](../wire-format/replay-wire.md) |

React Native adds nothing to the pixels. `mobileReplayIntegration` forwards the options to native and enriches breadcrumbs and network data. See [react-native/architecture.md](react-native/architecture.md) section 2.5.

## 2. Observed video properties

Parsed from the captured mp4 boxes with `examples/sentry-mobile/scripts/mp4info.py`. ffprobe is not installed on this Mac. Fixtures: [fixtures/ios/04-replay-segment-0](fixtures/ios/04-replay-segment-0/), [fixtures/android/05-replay-segment-0](fixtures/android/05-replay-segment-0/).

| Property | iOS simulator | Android emulator |
|---|---|---|
| Container | mp4 (`ftyp` `mp42`, compatible `isom mp41 mp42`) | mp4 (`mp42`, compatible `isom mp42`) |
| Codec | H.264 (`avc1`), **Main** profile, level 3.1 | H.264 (`avc1`), **Baseline** profile, level 4.1 |
| Resolution | **402x874**: the screen in points (1206x2622 px at 3x). Touch coordinates use the same point space | **416x912**: the window in dp (1080x2400 px / 2.625 = 411x914), rounded to multiples of 16 |
| Frame rate | 1 fps, constant (`frameRateType: constant`), timescale 600 | 1 fps, constant, timescale 90000 |
| Frames per 5 s segment | 5 (the last segment before background: 2 to 3) | 5 (the segment flushed at a crash: 7) |
| Keyframes per segment | 1 | 1 (2 in a 7 s segment: keyframe every 6 frames) |
| Status bar | Not in the frame | Not in the frame (not part of the window surface) |
| Masking look (default) | Text and images become boxes in the view's average colour, so the layout stays readable | Text and images become solid blocks (black text bars, white blocks on buttons). The back-arrow vector is not masked |

The first frame of a masked segment was rendered with macOS Quick Look (`qlmanage -t`) to check the masking look. The PNGs are not committed. The masked segments themselves are: [fixtures/ios/13-replay-segment-default-masking](fixtures/ios/13-replay-segment-default-masking/) and [fixtures/android/15-replay-segment-default-masking](fixtures/android/15-replay-segment-default-masking/), each with `mp4info.json`.

## 3. Bytes per minute: scripted 2-minute journey

Journey: launch, then one command every 2.5 s for 120 s, cycling through screens (Home, Product, Cart) and actions (fetch, browse catalog with 5 requests, search, handled error), then background, which sends the last partial segment.
- iOS used `scripts/replay-journey.sh`, which drives the app through its file mailbox, so there are no touches.
- Android used `scripts/android-journey.py --phases replay`, with real `adb input tap` touches and the same loop.

Replay `medium` quality, `replaysSessionSampleRate: 1`. Each platform ran once with the demo's unmasked setting (`maskAllText/Images/Vectors: false`) and once with Sentry's default masking (`SENTRY_REPLAY_MASK=default`). Numbers from `replaystats.py` over the decoded captures. The per-run JSON is in [fixtures/replay-2min-stats.json](fixtures/replay-2min-stats.json).

| Run | Segments | Video s | mp4 bytes | Wire bytes (gzip envelopes) | **Wire KB/min** | mp4 KB/min | Avg video kbps | Segment mp4 bytes median (min to max) | Recording JSON bytes |
|---|---|---|---|---|---|---|---|---|---|
| iOS, unmasked | 24 | 126 | 862,177 | 892,793 | **415** | 401 | 54.7 | 34,477 (27,205 to 44,427) | 33,853 |
| iOS, default masking | 24 | 127 | 329,436 | 356,686 | **165** | 152 | 20.8 | 11,159 (7,839 to 41,590) | 34,770 |
| Android, unmasked | 26 | 130 | 1,016,414 | 934,647 | **421** | 458 | 62.5 | 38,490 (12,271 to 89,066) | 65,015 |
| Android, default masking | 26 | 128 | 554,388 | 462,626 | **212** | 254 | 34.6 | 18,270 (8,174 to 45,894) | 55,645 |

Observations:
- Default masking cut wire bytes by **60 %** on iOS and **50 %** on Android. Masked boxes are flat and compress well.
- Measured wire rate: **2.7 to 7 KB/s**. Sentry's documented overhead pages say about 10 KB/s on iOS and 7 KB/s on Android. Those pages use a different app (Pocket Casts), real devices and full masking (see Step 4's file, sources 27 and 28).
- The iOS average bit rate (54.7 kbps unmasked) is **above** the configured 40 kbps `medium` target. AVAssetWriter's average bit rate is not met on 5-frame clips. Android stays below its 75 kbps target.
- Android's gzip makes the wire **smaller** than the mp4 bytes (Baseline mp4 still compresses about 10 %). On iOS the wire is a little larger than the mp4: Main-profile H.264 does not shrink under gzip, and the JSON parts are added.
- Non-video data is small: 34 to 65 KB per 2 minutes for the recording (breadcrumbs, touches) and 42 to 68 KB for `replay_event` JSON, which is repeated in full on every segment. That is 7 to 13 % of the masked wire bytes.
- The idle cost was observed too. In the full Android journey, 4 segments of a static screen (app idle before going to the background) were each exactly 36,214 bytes: a static screen still costs about 7 KB/s at 1 fps on Android. iOS static segments were about 33 KB per 5 s.
- Every segment arrived. Segment ids were contiguous (0 to 23 on iOS, 0 to 25 on Android). Sentry stored 24 and 26 segments for these replays (`count_segments` from `GET /api/0/organizations/sentry/replays/`).

Step 5 owns CPU, memory and frame-time overhead. This file has bytes only.

## 4. What travels with the video (per segment)

From the decoded `replay_recording` of each segment. Observed counts per 2-minute run: iOS 93 to 96 breadcrumb events and 0 touches (no UIKit touch in a mailbox journey); Android 74 to 75 breadcrumbs and 83 to 85 touch events.

| rrweb event | iOS | Android | Notes |
|---|---|---|---|
| `type 4` meta | `width`, `height`, `href: ""` | same | one per segment |
| `type 5` `tag: video` | `segmentId`, `size`, `duration`, `frameCount`, `frameRate`, `frameRateType`, `width`, `height`, `left`, `top`, `encoding: h264`, `container: mp4`, **plus `timestamp` in seconds** | same keys, **no `timestamp` key** in the payload | event `timestamp` is ms on both |
| `type 5` `tag: breadcrumb` | `console`, `fetch` (`url`, `method`, `status_code`, `__span`), `navigation`, `sentry.transaction`, `app.*`, `ui.tap` with real taps | the same plus `device.connectivity`, `device.battery`, `device.orientation` and system-event breadcrumbs from sentry-android | console lines appear here **and** as `log` items when `enableLogs` is on |
| `type 5` `tag: options` | segment 0 only: `quality`, `maskAllText`, `maskAllImages`, `sessionSampleRate`, `errorSampleRate`, `nativeSdkName`, `nativeSdkVersion`, `networkDetailHasUrls` | segment 0 only, **also lists `maskedViewClasses`, `unmaskedViewClasses` and `screenshotStrategy: pixelCopy`** | fixture `options` events in both segment-0 fixtures |
| `type 3` `source 2` touch | `data.type` 7 start / 9 end, `x`, `y` in points (archive capture, see [sentry-replay-taps.md](../../../../kb-archive/sentry-replay-taps.md)) | observed: start/end pairs per tap, `pointerType` 2 | Android: [fixtures/android/06-replay-segment-1-touches](fixtures/android/06-replay-segment-1-touches/) |
| `type 3` `source 6` touch move | `positions[]` with `timeOffset` | observed on swipes (scroll to a button) | |

`replay_event` per segment: `type: replay_video`, `replay_id` (= `event_id`), `segment_id`, `replay_type: session`, `replay_start_timestamp`, `timestamp`, `trace_ids`, `urls` (screen names), `platform` (`cocoa` on iOS, `java` on Android, already on the wire), full `contexts` (app, os, device, trace), `release`, `environment` and `sdk` (`sentry.javascript.react-native` on both). Network details (headers, bodies) are off by default: `networkDetailHasUrls: false`.

## 5. Session boundaries and gaps (observed)

- **iOS:** one replay per release-health session. A background of more than 30 s ends the session and starts a new replay id. A native crash's last segment is recovered and sent at the next launch with `sdk.name` `sentry.cocoa.react-native` (fixture `ios/12-...`). A JS fatal ends the replay without a recovered segment.
- **Android:** the replay id **did not change** when the release-health session rotated after each handled JS error (see [wire-capture.md](wire-capture.md) section 4). Replay `4b867ec3…` spans 4 health sessions. At a JVM crash, the buffered frames were encoded and sent **in the dying process** as one longer segment (7 s, 155 KB, fixture `android/14-...`), right after the crash event.
- After a background of more than 30 s, both platforms started a new replay (`a64ad2f5…` on Android, `fde07bb7…` on iOS).
- Source says replay pauses while offline or rate-limited on both platforms (gaps, not backlog): [ios/reliability.md](ios/reliability.md) section 6, [android/reliability.md](android/reliability.md) section 6. Not reproduced here.

## 6. Masking defaults and known limits

| Item | iOS | Android | RN | Source |
|---|---|---|---|---|
| `maskAllText` / `maskAllImages` | true / true | true / true | true / true, plus `maskAllVectors` true (`com.horcrux.svg.SvgView` on Android; observed in the `options` event) | [SentryReplayOptions.swift#L15-L16](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L15-L16), [react-native/configuration.md](react-native/configuration.md) section 4 |
| Always-masked classes (observed `maskedViewClasses`, Android) | WebView, PDF (docs) | `WebView`, `VideoView`, CameraX `PreviewView`, Media3/ExoPlayer `PlayerView`s, `RNSentryReplayMask` | `<Sentry.Mask>` / `<Sentry.Unmask>` | fixture `android/05-replay-segment-0/replay_recording.json` |
| Error screenshots (`attachScreenshot`) | Masked by default, **independently of replay masking**: the Android screenshot of a handled error was fully masked although replay masking was off | same | `screenshot` options | fixture `android/09-…/item-2-attachment.screenshot.png` |
| SwiftUI | Masking by layer-class rules. iOS 26 Liquid Glass broke it once, and the SDK then disables replay unless overridden | n/a | n/a | Step 4 file, sources 7 and 33 |
| Frame rate | 1 fps, not public (`@_spi(Private)`) | 1 fps (`frameRate` internal) | not exposed | [SentryReplayOptions.swift#L465](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Swift/Integrations/SessionReplay/SentryReplayOptions.swift#L465) |
| Quality → bit rate | low 20 / medium 40 / high 60 kbps | low 50 / medium 75 / high 100 kbps | `replaysSessionQuality` is read on iOS only ([react-native/configuration.md](react-native/configuration.md)) | section 1 |
| Max item size | 10 MiB compressed per `replay_video` (Relay) | same | | [wire-format/limits-and-rate-limits.md](../wire-format/limits-and-rate-limits.md) |
