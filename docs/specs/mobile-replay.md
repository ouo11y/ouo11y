# Mobile replay specification (frame chunks)

Status: normative for iOS replay (ADR-0006). Android will use the same contract.

This page describes schema 1, which every component reads and emits today. Schema 2 (patches against the previous frame, keyframes, the `mode` field) is decided in [ADR-0014](../adr/0014-replay-tiles-in-frames.md) and replaces the sections below when W3 lands.

## Chunk

Posted to `POST /v1/replay/chunks` exactly like rrweb chunks (gzip JSON, headers `content-type: application/json`, `content-encoding: gzip`, `x-ouo-session-id`, `x-ouo-seq`). rrweb chunks have no `kind` and are treated as `kind: "rrweb"`.

```json
{
  "kind": "frames",
  "schema_version": 1,
  "session_id": "uuid",
  "seq": 0,
  "started_at": 1760000000000,
  "ended_at": 1760000005000,
  "viewport": { "width": 393, "height": 852, "scale": 0.5 },
  "platform": "ios",
  "frames": [
    { "ts": 1760000000100, "jpeg": "<base64>", "reason": "timer|touch|navigation|resume" }
  ],
  "touches": [
    { "ts": 1760000001200, "x": 120.5, "y": 640.0, "phase": "began|moved|ended" }
  ],
  "masked": true
}
```

- `ts`, `started_at`, `ended_at` are epoch milliseconds in the device clock; the timeline aligns them with telemetry the same way as rrweb chunks.
- `x`, `y` are in points of the unscaled viewport.
- `seq` is monotonic per session, starts at 0 for a new session, persists across app restarts within a session (same store as the session record).
- A chunk is flushed every 5 seconds, or when it holds 10 frames, or on `pause()`, background, and session rotation.
- The open chunk is also kept on disk (a folder excluded from device backups); a chunk the process could not flush (crash, watchdog or OOM kill, force quit) is sent on the next launch with its own `session_id` and `seq`, `ended_at` being its last frame or touch, whether or not the next launch records (the React Native SDK asks for it before its sampling decision). A chunk that started more than 24 h before the next launch is dropped.
- A cut chunk is written to disk (the `outbox` folder next to the spool, excluded from device backups) as the gzip body it is sent with, before it is sent, and removed when rum-api's receiver answers 2xx or another 4xx than 408 and 429. A network error, 408, 429 or 5xx leaves it there: it is retried after a backoff (1 s doubling to 60 s, at least the `Retry-After` the receiver sends with 429 and 503), with the next chunk, on `flush()` and in the next process, oldest first. Each folder (queued, held) holds at most 10 MB, the oldest chunks dropped first, and a chunk queued more than 24 h ago is dropped. The guarantee starts when the chunk is cut: until the SDK clears the spool only after this write (W3a), a kill during the cut chunk's encoding can lose it. Delivery is at least once; a resent chunk has the same `session_id` and `seq` and replaces its copy.
- **Next-launch keep/drop** (React Native `replay.keepAtNextLaunch`): with it, cut chunks wait in `outbox/held/` instead. At the next launch, after the previous run's open chunk is recovered, the host is asked once per finished session (any held session but the current one) with `{ sessionId, chunks, bytes, firstChunkAt, lastChunkAt, crashed, errors }` and the session's chunks are sent or deleted. Without the hook nothing is held, and chunks held by an earlier build are sent.
- Frames are JPEG, longest side at most 1000 px (scale chosen by the SDK), quality 0.5. The SDK drops a frame whose downsampled hash equals the previous one.
- The maximum chunk size accepted by rum-api is 8 MB for `kind: "frames"`.

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
6. Downscale, fill the rectangles with opaque black, drop the frame when it equals the previous kept one, then encode.
7. Stop capturing on `didEnterBackground`, flush, and resume on `didBecomeActive` with an immediate frame.
8. Touches are observed on the window without interfering with the app's gesture handling.

## Storage

rum-api stores every chunk as `replays/<session_id>/<seq %06d>.json.gz`. `meta.json` gains `"kind": "rrweb" | "frames"` taken from the first chunk; mixing kinds in one session is rejected with 409.

## API

- `GET /v1/sessions/{id}/replay` meta includes `kind`.
- `GET /v1/sessions/{id}/replay/frames` returns `{ session_id, kind: "frames", viewport, platform, started_at, ended_at, frames: [{ts, jpeg, reason}], touches: [...] }` with all chunks concatenated in `seq` order. 409 when the replay is rrweb.
- `GET /v1/sessions/{id}/replay/events` returns 409 when the replay is frames.

## Player

The Grafana plugin reads `kind` from the meta and mounts either rrweb-player or the frame player. The frame player shows the current frame, draws touch indicators that fade over 500 ms, has play/pause, a scrubber, and the same timeline markers and seek behaviour as the rrweb player.

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
