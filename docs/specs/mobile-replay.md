# Mobile replay specification (frame chunks)

Status: normative for iOS and Android replay (ADR-0006, ADR-0014). Flutter emits the same contract.

This page describes schema 2: a frame is a full image or a list of patches against the frame before it ([ADR-0014](../adr-archive/0014-replay-tiles-in-frames.md)). A schema 1 chunk (every frame a full image) is a valid schema 2 chunk with `schema_version: 1` and no `mode`; readers accept both, and a session may mix them. The iOS SDK, the Android capture (`sdk/android`) and the React Native SDK, which embeds both, emit schema 2 (`platform` `ios` or `android`).

## Chunk

Posted to `POST /v1/replay/chunks` exactly like rrweb chunks (gzip JSON, headers `content-type: application/json`, `content-encoding: gzip`, `x-ouo-session-id`, `x-ouo-seq`). rrweb chunks have no `kind` and are treated as `kind: "rrweb"`.

```json
{
  "kind": "frames",
  "schema_version": 2,
  "session_id": "uuid",
  "seq": 0,
  "started_at": 1760000000000,
  "ended_at": 1760000005000,
  "viewport": { "width": 393, "height": 852, "scale": 0.5 },
  "platform": "ios",
  "mode": "session",
  "frames": [
    { "ts": 1760000000100, "reason": "change", "jpeg": "<base64>" },
    { "ts": 1760000001100, "reason": "change",
      "patches": [ { "x": 0, "y": 128, "w": 196, "h": 64, "jpeg": "<base64>" } ] }
  ],
  "touches": [
    { "ts": 1760000001200, "x": 120.5, "y": 640.0, "phase": "began|moved|ended" }
  ],
  "masked": true
}
```

- `ts`, `started_at`, `ended_at` are epoch milliseconds in the device clock; the timeline aligns them with telemetry the same way as rrweb chunks.
- Touch `x`, `y` are in points of the unscaled viewport.
- `seq` is monotonic per session, starts at 0 for a new session, persists across app restarts within a session (same store as the session record).
- `mode` is the capture mode drawn at session start, the same on every chunk of the session: `session` or `navigation` (the iOS SDK), or `buffer` (decided in ADR-0014, not built yet). It is informational free text; readers must not reject other values.
- `reason` is informational free text: why the frame was taken (`timer` in `session` mode, `navigation`, `resume`, `feedback`: the screen when the user sent feedback, a full image, [mobile-sdk.md](mobile-sdk.md) C10; older SDKs also sent `touch`). Readers never use it to tell full frames from patch frames.

## Frames

- A frame has `ts` and **exactly one** of `jpeg` (a full image) and `patches` (a non-empty list of rectangles drawn over the frame before it).
- **The first frame of a chunk is a full image**, and patches refer only to frames of the same chunk. A chunk lost by the uploader or offline never breaks the next one, and a seek starts at the latest full image.
- A patch is `{x, y, w, h, jpeg}`: integer pixels of the most recent full image of the chunk (which sets the canvas size), `w` and `h` positive, the rectangle inside that image. Its `jpeg` holds exactly the `w` x `h` rectangle.
- Patches of one frame do not overlap; readers draw them in array order.
- Images are JPEG, base64 (padded or not), longest side of a full image at most 1000 px (scale chosen by the SDK), quality 0.5.

## Chunking (SDK)

- A chunk is cut every 5 seconds, once its images pass 1 MiB, on `pause()`, background, session rotation and when the frame size changes (rotation). While the screen changes, a full image therefore goes out at least every 5 s (the roadmap's keyframe interval is 6 s).
- **A static screen sends zero image bytes**: an unchanged frame is not sent, and a chunk with neither frames nor touches is not sent. A chunk with touches and no frames is sent (the screen did not change; the player keeps the last image).
- Further full images go out on every screen change (`screenDidChange()`) and on resume.
- **Patches** come from a hash of every 64 px tile of the frame, compared with the last frame *sent* (never a dropped one). Changed tiles are merged into a few rectangles. When their total area would exceed half the frame, the SDK sends a full image instead.
- The open chunk is also kept on disk (a folder excluded from device backups); a chunk the process could not flush (crash, watchdog or OOM kill, force quit) is sent on the next launch with its own `session_id` and `seq`, `ended_at` being its last frame or touch, whether or not the next launch records (the React Native SDK asks for it before its sampling decision), however long ago it started (no age: see the next point).
- A cut chunk is written to disk (the `outbox` folder next to the spool, excluded from device backups) as the gzip body it is sent with, before it is sent, and removed when the collector's `ouoreplay` receiver answers it finally: 2xx, or any status but 429, 502, 503 and 504 (dropped and counted as rejected, OTLP/HTTP's rule, [mobile-sdk.md](mobile-sdk.md) C11). A network error, 429, 502, 503 or 504 leaves it there: it is retried after a backoff (1 s doubling to 60 s, at least the `Retry-After` the receiver sends with 429 and 503), on `flush()` and in the next process, oldest first. While a retry waits, chunks cut meanwhile wait with it (an outage costs one request per backoff, not one per chunk); the recorder does not retry on foreground, so after an outage a chunk waits for the next retry, at most 60 s. Each folder (queued, held) holds at most 10 MB, the oldest chunks dropped first; nothing is dropped for its age, because no clock on a phone both survives a reboot and cannot be moved by the user (a clock moved a day forward dropped the whole queue, checklist N77), and the bound already caps the disk. Within a folder, names sort in the order chunks were queued even when the clock moved back (a released held chunk keeps its name); the held summary's `firstChunkAt` / `lastChunkAt` are those names' stamps, so after a clock moved back they can lie ahead of it. A chunk the receiver answers 500 to every time is dropped after one attempt (N55); one answered 503 every time waits, retried, until the bound evicts it. The spool is cleared only after this write, so a kill at any point loses nothing. Delivery is at least once; a resent chunk has the same `session_id` and `seq` and replaces its copy.
- **Next-launch keep/drop** (React Native `replay.keepAtNextLaunch`): with it, cut chunks wait in `outbox/held/` instead. At the next launch, after the previous run's open chunk is recovered, the host is asked once per finished session (any held session but the current one) with `{ sessionId, chunks, bytes, firstChunkAt, lastChunkAt, crashed, errors, feedback }` (`feedback`: `rum.feedback` records of the session, C10) and the session's chunks are sent or deleted. Without the hook nothing is held, and chunks held by an earlier build are sent.
- The maximum chunk size accepted by rum-api is 8 MB for `kind: "frames"`, and at most 1000 frames.

## Validation (collector replay receiver and rum-api)

Both reject with 400:

- `schema_version` missing, below 1 or above 2 (`kind: "video"` stays at 1);
- a frame without `ts`, with both or neither of `jpeg` and `patches`, or with an empty `patches`;
- a first frame that is not a full image;
- an image that is not base64 of bytes starting with the JPEG marker `FF D8`;
- a patch outside the most recent full image (its size is read from the JPEG header), with a non-integer or non-positive coordinate or size, or whose JPEG is not `w` x `h`;
- `patches` in a chunk with `schema_version: 1`.

rum-api stores and serves frames unchanged. Upgrade order: rum-api and plugin, then collector, then SDKs ([`operations/upgrade.md`](../operations/upgrade.md) section 4).

## Capture rules (iOS)

1. Capture the key `UIWindow` with `drawHierarchy(in:afterScreenUpdates:false)` on the main thread, 1:1 at the screen's scale into an 8-bit bitmap in the screen's color space; the downscale to the frame size, redaction and encoding run on a background queue. One capture in flight.
2. **Scheduling** (ADR-0006 rev 2). A main run-loop observer (`beforeWaiting`, after Core Animation's commit) decides once per pass; a 1 s keep-alive timer wakes an idle run loop. A frame is taken when all hold:
   - it is due: in `session` mode at least `frameInterval` (default 1 s) after the last one; in `navigation` mode only on start, resume and 0.4 s after a screen change (`screenDidChange()`, called by the React Native SDK on every route change), and again 0.5 s later, at most 3 times, when that frame was dropped;
   - no view controller transition is running (checked on every pass; no capture during a push, pop or presentation, however long);
   - fewer than 4 layer animations run, or the frame has waited 1 s for them (a spinner must not stop replay);
   - 0.25 s have passed since the last transition or animation burst seen (`drawHierarchy(afterScreenUpdates: false)` reads what the screen last showed, which trails the model); passes before that skip the view walk, and a one-shot timer wakes the run loop when the frame can be due;
   - the time bank is not overdrawn: the main-thread part of capturing (walk and render) may spend 100 ms per second, banked up to 100 ms. This is also the backoff on slow devices: a 150 ms capture leaves one frame every 1.5 s.
   Touches are recorded but never trigger a capture.
3. **Modes**: `session`, `navigation`, and `auto` (default): `navigation` on devices with less than 3.5 GiB of RAM, `session` otherwise.
4. Before encoding, walk the window's view hierarchy and compute redaction rectangles in window coordinates for: `UITextField`, `UITextView`, `UILabel`, React Native text views (`RCTTextView`, `RCTParagraphComponentView`), `UIImageView`, `WKWebView`, SwiftUI's text (`SwiftUI.CGDrawingView`), images and vector shapes (`SwiftUI._UIGraphicsView`, a class name ending in `_UIShapeHitTestingView`), and any view with `accessibilityIdentifier == "ouo-mask"` (React Native `testID`, SwiftUI `.ouoMask()`). Inside a system bar (`UINavigationBar`, `UITabBar`, `UIToolbar`) SwiftUI's drawing views are bar chrome and not masked, except under a SwiftUI toolbar item (a class name containing `UIKitBarItemHost`). Views with `accessibilityIdentifier == "ouo-unmask"` and their subtree are skipped. A view with `accessibilityIdentifier == "ouo-unmask-area"` (SwiftUI `.ouoUnmask()`, a view behind content drawn by its siblings) leaves out the rectangles masked by class inside its frame; `ouo-mask` and cut-off subtrees inside it stay masked. Hidden views, zero-alpha views and views clipped outside the window are skipped.
5. **Masking fails closed**, decided on the main thread before the render: a frame is dropped when a rectangle to mask belongs to a moving view, or to one inside it, because the pixels may not be where the rectangle is. A view is moving when an animation runs on its layer whose key path is not opacity, colors, contents, borders, corner radius, shadows or filters, or when it is a scroll view being dragged or decelerating (the screen shows the previous offset). A view with alpha 0 that still animates (fading out) is walked and masked like a visible one. A subtree the walk cut at its depth limit (64) is masked whole.
6. Downscale, fill the rectangles with opaque black, then compare the 64 px tiles with the last frame sent: no changed tile drops the frame; otherwise send a full image (first frame of a chunk, screen change, resume, or changed area above half the frame) or the changed rectangles as patches, each encoded on its own.
7. Stop capturing on `didEnterBackground`, flush, and resume on `didBecomeActive` with an immediate frame.
8. Touches are observed on the window without interfering with the app's gesture handling.

## Capture rules (Android)

`sdk/android` (W9; the React Native SDK compiles it into its Expo module). The same chunks, cadence, tiles and modes as iOS; what differs is how the screen is read:

1. **Window**: the topmost visible root view that covers the activity's window (the activity, or a full-screen dialog such as a React Native `Modal`), found through `WindowManagerGlobal`'s root views. It is copied with `PixelCopy` (Android 8+) when no layout or invalidation waits for a draw; otherwise the walk runs in the next draw's `OnDrawListener` (it sees what that frame shows) and the copy is requested right after it. The copy goes straight into an RGB_565 bitmap at the frame size (longest side at most 1000 px; the GPU scales); before Android 8 the tree is drawn in software into the same bitmap. Popups, toasts and dialogs that do not cover the activity are not recorded.
2. **Scheduling**: the window's `OnDrawListener` sets a dirty flag. In `session` mode a frame is due at most once per `frameInterval` and only when the window drew since the last frame (a static screen costs no copy); `navigation` and `auto` modes and the 100 ms per second time bank of the main-thread work (walks and the copy request) are as on iOS. Touches are recorded through a wrapper of the window's `Window.Callback`, in dp (the viewport's points), and never trigger a capture.
3. **Masks**: the view tree is walked on the main thread into window-pixel boxes through every parent's offset, scroll and transform. Masked by default: text (`TextView`, so React Native's `ReactTextView`, and React Native's `PreparedLayoutTextView`) **one box per laid-out line** (`Layout` line bounds; the space beside a short line stays visible; an unknown layout masks the whole view), inputs (`EditText`, whole, governed by `maskInputs` alone), images (`ImageView`, React Native images, and `TextureView` / `SurfaceView`: video, maps, camera previews) and web views (`WebView`). Jetpack Compose content (`AndroidComposeView`) is masked whole with text, since the view walk cannot see into it (fails closed until a Compose semantics walk). A view whose tag is `ouo-mask` (React Native `testID`) is masked whole, `ouo-unmask` leaves its subtree out; hidden and transparent views are skipped; a subtree deeper than 64 levels is masked whole.
4. **Masking fails closed**: the tree is walked again when the copy is done; when any mask moved between the two walks (a scroll, a running transform), the frame is dropped and asked for again after the settle time.
5. Background (no started activity): stop and flush; foreground: resume with a full frame. The spool and the outbox live in `noBackupFilesDir/ouo/replay`.

## Storage

rum-api stores every chunk as `replays/<session_id>/<seq %06d>.json.gz`. `meta.json` gains `"kind": "rrweb" | "frames" | "video"` taken from the first chunk; mixing kinds in one session is rejected with 409.

## API

- `GET /v1/sessions/{id}/replay` meta includes `kind`.
- `GET /v1/sessions/{id}/replay/frames` returns `{ session_id, kind: "frames", viewport, platform, started_at, ended_at, frames: [{ts, jpeg | patches, reason}], touches: [...] }` with all chunks concatenated in `seq` order, every frame as uploaded. A chunk's first frame is a full image, so the frames of a missing chunk never break the next. 409 when the replay is rrweb.
- `GET /v1/sessions/{id}/replay/events` returns 409 when the replay is frames.

## Player

The Grafana plugin reads `kind` from the meta and mounts either rrweb-player or the frame player. The frame player keeps one canvas: to show the frame at the cursor it draws the latest full image at or before it (sizing the canvas to that image) and blits the patches of every frame after it, in order. It draws touch indicators that fade over 500 ms, has play/pause, a scrubber, and the same timeline markers and seek behaviour as the rrweb player.

## Host API (iOS package)

```swift
import OuoReplay

OuoReplay.start(OuoReplayConfig(
    endpoint: URL(string: "http://localhost:8080")!,
    sessionId: { currentSessionId },      // called on every chunk
    mode: .auto,                          // .session, .navigation, .auto
    frameInterval: 1.0,
    maskText: true, maskImages: true, maskWebViews: true,
    debug: false))
OuoReplay.pause(); OuoReplay.resume(); OuoReplay.isRecording
OuoReplay.sessionDidRotate(newId: String)   // flushes, resets seq to 0
OuoReplay.screenDidChange()                 // the frame for a new screen in navigation mode
OuoReplay.flush()
```

React Native: `initRUM({ replay: { enabled: true, mode: "auto" } })` starts it through the Expo module; `rum.replay.pause()/resume()/isRecording()` mirror the web API; the JS session manager calls `sessionDidRotate` on rotation.

## Video chunks from the iOS SDK, legacy upload path (spike, proposed ADR-0018)

Behind `OuoReplayConfig.recorder = .sentryVideo` (`OuoConfig.replayRecorder`, default `.frames`) the native iOS SDK records with sentry-cocoa's recorder core, copied into `sdk/ios/Sources/OuoReplaySentryCore` ([kb](../../project/kb/session-replay/borrowing/sentry-ios-recorder-spike.md)), and posts `kind: "video"` chunks to the same `POST /v1/replay/chunks`, with the same headers, outbox and credential as frame chunks. One chunk is one segment: up to 5 s at 1 frame/s, H.264 in an mp4 that starts with a keyframe, so every chunk is decodable alone. The OTLP path of the same recorder is [`ouo-video/1`](#ouo-video1-video-segments-over-otlp) below.

```json
{
  "kind": "video", "schema_version": 1, "format": "ouo-video/1",
  "session_id": "uuid", "seq": 0, "started_at": 1760000000000, "ended_at": 1760000005000,
  "viewport": { "width": 402, "height": 874, "scale": 1 }, "platform": "ios", "mode": "session",
  "video": { "container": "mp4", "encoding": "h264", "duration_ms": 5000, "frame_count": 5, "frame_rate": 1, "mp4": "<base64>" },
  "touches": [ { "ts": 1760000001200, "x": 120.5, "y": 640.0, "phase": "began" } ],
  "masked": true
}
```

- The shape is the Sentry bridge's video chunk (ADR-0008) without `source`, plus `format` and `mode`. `viewport` is the video size at scale 1 (the core renders one pixel per point), so touches in points land on it unchanged.
- `format` names the payload; the collector copies it to the log attribute `ouo.replay.format` (sdk-spec section 11.3). It is optional: frames and rrweb chunks have none. The spike first wrote `sentry-video`; that name is retired.
- The collector's `ouoreplay` receiver validates a video chunk the way rum-api does (`schema_version` 1, `video.container` `"mp4"`, `video.mp4` non-empty base64 of a file with `ftyp` at offset 4, non-negative `duration_ms` and `frame_count`) and applies the body limit of frame chunks, not the rrweb one.
- Masking is the frames recorder's (next section). Not built on this path: the crash spool, `navigation` mode and feedback frames.

## `ouo-video/1`: video segments over OTLP

`replay.mode: "pixel/video"` (React Native on iOS, ADR-0021 decision 5) sends replay as `ouo.replay.chunk` log records (sdk-spec section 11) with `ouo.replay.format` `ouo-video/1`. Everything above the body (identity, stream, sequence, buffer ring, `ouo.replay.ended`, delivery) is the same as for `ouo-frames/3` (RPL-23).

**One chunk is one segment (RPL-25).** Every chunk has `ouo.replay.keyframe` `true` and its own `ouo.replay.segment.index` (one more than the chunk before it in the stream), and plays without any other chunk. `ouo.replay.start_time` and `ouo.replay.end_time` are the segment's first frame and its end. A segment is at most 5 s (one frame per second while the screen changes); background, pause, stop and a session rotation cut it early. A body over the 1 MiB chunk limit is dropped whole, never cut, and counted (`replay.frames_dropped`).

**Body.** `ouo.replay.encoding` is `identity`: the body is sent as built, not compressed again (H.264 already is). It is one line of JSON (UTF-8, no newline inside), a newline (`0x0A`), then the mp4 bytes:

```text
{"t":1760000000000,"type":"video","end":1760000005000,"w":402,"h":874,"scale":1,"fps":1,"frames":5,"mp4":48213,"touches":[{"t":1760000001200,"x":120.50,"y":640,"phase":"began"}]}\n<48213 bytes of mp4>
```

| Key | Meaning |
|---|---|
| `t`, `end` | Epoch ms of the first frame and of the segment's end |
| `w`, `h` | Video size in pixels |
| `scale` | Video pixels per point of the window (1: the core renders one pixel per point) |
| `fps`, `frames` | Frame rate the mp4 is timed at, and its number of frames |
| `mp4` | Byte length of what follows the newline: an ISO base media file (`ftyp`, `moov`, `mdat`), H.264, starting with a keyframe |
| `touches` | Touches made during the segment (`t` in `[t, end)`), in points of the window: `{t, x, y, phase}` with `phase` `began`, `moved` or `ended` |

A player reads up to the first newline, parses the header, and hands the rest to its video element (`video/mp4`); it draws each touch at `(x * scale, y * scale)` when the video's time reaches `t - header.t`. Frame `i` of the mp4 is shown from `t + i * 1000 / fps`.

**Capture and masking.** The recorder core is sentry-cocoa 9.33.0's (pacing, render, H.264 encoder), with ouo's masking instead of Sentry's: before every render it asks the plan the frames recorder uses (`ReplayMaskPlanner`: the view walk with the host's overrides from `ReplayMaskRegistry`, the default classes, secure fields always masked, strict precedence). No look while a view controller transition runs; no frame when a masked view moves or the walk fails (PRV-8). The rectangles are painted black, as in `ouo-frames/3`, before the frame reaches the encoder. The raw render never leaves the process. `ouo.replay.masked` is `true`.

## Never-record screens (React Native, ADR-0006 revision 3)

- `initRUM({ replay: { excludeScreens: ["IdentityCheck", "/Account/Sign*", /^Patient/] } })`: a string equals the screen name (the last segment of the tracked navigation path) or the whole path, or is a prefix when it ends with `*`; a RegExp is tested against both.
- When the tracked screen matches, the SDK calls the native `pause()` before it emits the `navigation` event and asks for no frame (`screenDidChange` is not called); when it no longer matches, `resume()` (a full frame) 500 ms later, so a transition out of the screen is over; hidden again within the 500 ms, capture stays paused. The native `start()` is not called while the screen is hidden: the controller starts it once the screen is shown. `rum.replay.hideScreen()` / `showScreen()` do the same by hand. The host's `pause()`, the sampling pause, `excludeScreens` and `hideScreen()` are independent; capture resumes only when none holds it.
- The SDK emits an OTel event `ouo.replay.hidden` with `ouo.replay.hidden_reason` `screen` or `manual` when a recorded session's capture is hidden (once per hidden stretch), and for a new session that starts while hidden. Chunks carry no marker; the player keeps the last frame across the gap.
- Native `pause()` runs on the main thread's next turn: a frame already being captured, or one taken between the screen's mount and the navigation callback on a screen shown without a transition, can still be sent, masked by the capture rules. Hosts call `hideScreen()` before navigating to a screen that must never appear.
