# Mobile replay specification (frame chunks)

Status: normative for iOS replay (ADR-0006, ADR-0014). Android and Flutter emit the same contract.

This page describes schema 2: a frame is a full image or a list of patches against the frame before it ([ADR-0014](../adr/0014-replay-tiles-in-frames.md)). A schema 1 chunk (every frame a full image) is a valid schema 2 chunk with `schema_version: 1` and no `mode`; readers accept both, and a session may mix them. rum-api and the collector read schema 2 and the plugin plays it; the iOS SDK emits schema 1 until its W3 tiles change lands (roadmap W3).

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
- `mode` is the capture mode drawn at session start, the same on every chunk of the session: `session`, `navigation` or `buffer` (decided in ADR-0014, not emitted by any SDK yet). It is informational free text; readers must not reject other values.
- `reason` is informational free text (`change`, `resume`, `navigation`; schema 1 also has `timer` and `touch`). Readers never use it to tell full frames from patch frames.

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
- The open chunk is also kept on disk (a folder excluded from device backups); a chunk the process could not flush (crash, watchdog or OOM kill, force quit) is sent on the next launch with its own `session_id` and `seq`, `ended_at` being its last frame or touch, whether or not the next launch records (the React Native SDK asks for it before its sampling decision). A chunk that started more than 24 h before the next launch is dropped.
- A cut chunk is written to disk (the `outbox` folder next to the spool, excluded from device backups) as the gzip body it is sent with, before it is sent, and removed when rum-api's receiver answers 2xx or another 4xx than 408 and 429. A network error, 408, 429 or 5xx leaves it there: it is retried after a backoff (1 s doubling to 60 s, at least the `Retry-After` the receiver sends with 429 and 503), with the next chunk, on `flush()` and in the next process, oldest first. Each folder (queued, held) holds at most 10 MB, the oldest chunks dropped first, and a chunk queued more than 24 h ago is dropped. The guarantee starts when the chunk is cut: until the SDK clears the spool only after this write (W3a), a kill during the cut chunk's encoding can lose it. Delivery is at least once; a resent chunk has the same `session_id` and `seq` and replaces its copy.
- **Next-launch keep/drop** (React Native `replay.keepAtNextLaunch`): with it, cut chunks wait in `outbox/held/` instead. At the next launch, after the previous run's open chunk is recovered, the host is asked once per finished session (any held session but the current one) with `{ sessionId, chunks, bytes, firstChunkAt, lastChunkAt, crashed, errors }` and the session's chunks are sent or deleted. Without the hook nothing is held, and chunks held by an earlier build are sent.
- The maximum chunk size accepted by rum-api is 8 MB for `kind: "frames"`, and at most 1000 frames.

## Validation (collector replay receiver and rum-api)

Both reject with 400:

- `schema_version` missing, below 1 or above 2 (`kind: "video"` stays at 1);
- a frame without `ts`, with both or neither of `jpeg` and `patches`, or with an empty `patches`;
- a first frame that is not a full image;
- an image that is not base64 of bytes starting with the JPEG marker `FF D8`;
- a patch outside the most recent full image (its size is read from the JPEG header), or with a non-integer or non-positive coordinate or size;
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
4. Before encoding, walk the window's view hierarchy and compute redaction rectangles in window coordinates for: `UITextField`, `UITextView`, `UILabel`, React Native text views (`RCTTextView`, `RCTParagraphComponentView`), `UIImageView`, `WKWebView`, and any view with `accessibilityIdentifier == "ouo-mask"` (React Native `testID`). Views with `accessibilityIdentifier == "ouo-unmask"` and their subtree are skipped. Hidden views, zero-alpha views and views clipped outside the window are skipped.
5. **Masking fails closed**, decided on the main thread before the render: a frame is dropped when a rectangle to mask belongs to a moving view, or to one inside it, because the pixels may not be where the rectangle is. A view is moving when an animation runs on its layer whose key path is not opacity, colors, contents, borders, corner radius, shadows or filters, or when it is a scroll view being dragged or decelerating (the screen shows the previous offset). A view with alpha 0 that still animates (fading out) is walked and masked like a visible one. A subtree the walk cut at its depth limit (64) is masked whole.
6. Downscale, fill the rectangles with opaque black, then compare the 64 px tiles with the last frame sent: no changed tile drops the frame; otherwise send a full image (first frame of a chunk, screen change, resume, or changed area above half the frame) or the changed rectangles as patches, each encoded on its own.
7. Stop capturing on `didEnterBackground`, flush, and resume on `didBecomeActive` with an immediate frame.
8. Touches are observed on the window without interfering with the app's gesture handling.

## Storage

rum-api stores every chunk as `replays/<session_id>/<seq %06d>.json.gz`. `meta.json` gains `"kind": "rrweb" | "frames"` taken from the first chunk; mixing kinds in one session is rejected with 409.

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
