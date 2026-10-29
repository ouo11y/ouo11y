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
- Frames are JPEG, longest side at most 1000 px (scale chosen by the SDK), quality 0.5. The SDK drops a frame whose downsampled hash equals the previous one.
- The maximum chunk size accepted by rum-api is 8 MB for `kind: "frames"`.

## Capture rules (iOS)

1. Capture the key `UIWindow` with `drawHierarchy(in:afterScreenUpdates:false)` on the main thread, timer at 1 Hz plus one capture per touch `began` and `ended` (coalesced to at most 4 per second).
2. Before encoding, walk the window's view hierarchy and compute redaction rectangles in window coordinates for: `UITextField`, `UITextView`, `UILabel`, React Native text views (`RCTTextView`, `RCTParagraphComponentView`), `UIImageView`, `WKWebView`, and any view with `accessibilityIdentifier == "ouo-mask"` (React Native `testID`). Views with `accessibilityIdentifier == "ouo-unmask"` and their subtree are skipped. Hidden views, zero-alpha views and views clipped outside the window are skipped.
3. Fill the rectangles with opaque black on the captured image, then downscale and encode.
4. Stop the timer on `didEnterBackground`, flush, and resume on `didBecomeActive` with an immediate frame.
5. Touches are observed on the window without interfering with the app's gesture handling.

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
    frameInterval: 1.0,
    maskText: true, maskImages: true, maskWebViews: true,
    debug: false))
OuoReplay.pause(); OuoReplay.resume(); OuoReplay.isRecording
OuoReplay.sessionDidRotate(newId: String)   // flushes, resets seq to 0
OuoReplay.flush()
```

React Native: `initRUM({ replay: { enabled: true } })` starts it through the Expo module; `rum.replay.pause()/resume()/isRecording()` mirror the web API; the JS session manager calls `sessionDidRotate` on rotation.
