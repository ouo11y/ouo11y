# ADR-0014 Replay representation: tiles in `frames` schema 2

Status: accepted (2026-10-29, roadmap agreed by the founder)

## Context

ADR-0006 sends every changed screen as a full JPEG: 20–40 KB per frame, measured at about 2× Sentry's bytes on the same journey (checklist N50). Sentry encodes H.264 and lands near 110 KiB/min masked. The mobile research compared three ways to diff ([comparison.md §4, §12](../../project/kb/mobile-sdk-research/comparison.md)) and the roadmap picked one ([roadmap.md §2.2](../../project/kb/mobile-sdk-research/roadmap.md#22-where-i-disagree)): device H.264 needs a second encoder per platform, and rrweb `<img>` mutations (LaunchDarkly) carry DOM semantics for something that is not a document. The plugin already owns a frames player and a video player.

## Decision

- **A frame is a full image or a list of patches** against the frame sent before it. `kind` stays `"frames"`, `schema_version` becomes 2. Images are base64 JPEG in the field `jpeg`, as in schema 1, so a schema 1 frame is a valid schema 2 full frame.
- **Keyframes.** The next frame sent is a full image when the last full image is 6 s old or older (Sentry's keyframe interval), on every screen change, on resume, and as the first frame of a session or of a buffer flush. A static screen sends nothing, so it costs zero image bytes. A viewport change (rotation) ends the chunk.
- **Patches** are computed on the capture queue from a 64 px tile hash and merged into a few rectangles. Diffs are against the last frame *sent*, never against a dropped one. When the patches would cover more than half the frame, the SDK sends a full image instead.
- **Modes**, drawn at session start and constant for the session's replay:
  - `session`: the cadence of W1, uploaded every 5 s.
  - `buffer`: capture into a 30 s on-disk ring and upload nothing. On the session's first error or crash, upload the ring (starting with a full image) and continue as `session`. Because the ring is on disk, a crash still yields its 30 s on the next launch.
  - `navigation`: one full image per screen change and on resume, with no cadence. It is the low-end tier's default.
- **`video` stays** for Sentry-sourced replays (ADR-0008). No rrweb container for raster, and no device video encoder until W3 is measured.

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
  "mode": "session|buffer|navigation",
  "frames": [
    { "ts": 1760000000100, "reason": "keyframe|change|navigation|resume", "jpeg": "<base64>" },
    { "ts": 1760000001100, "reason": "change",
      "patches": [ { "x": 0, "y": 128, "w": 197, "h": 64, "jpeg": "<base64>" } ] }
  ],
  "touches": [ { "ts": 1760000001200, "x": 120.5, "y": 640.0, "phase": "began|moved|ended" } ],
  "masked": true
}
```

A frame has exactly one of `jpeg` and `patches`. Patch coordinates are integer pixels of the encoded frame (the viewport in points times `scale`), and each patch lies inside it. `touches` stay in points. Every other field keeps its schema 1 meaning (`docs/specs/mobile-replay.md`).

**Player.** It keeps one canvas: draw a full image, blit each patch. To seek, it draws the last full image at or before the target and applies the patch frames after it. After a `seq` gap it ignores patch frames until the next full image, which is how ADR-0003's "missing chunks degrade gracefully" holds for tiles.

**Schema 1 readers.** A collector replay receiver or rum-api that reads at most schema 1 rejects a schema 2 chunk with `400 schema_version 2 not supported`, and the SDK drops it after its retry budget (`docs/operations/upgrade.md` §4). A rum-api that reads schema 2 writes it into `replays/schema.json`, so an older rum-api refuses to start on that store. Stored chunks are never rewritten: rum-api passes frames through unchanged, and a session may mix schema 1 and 2 chunks. A plugin built for schema 1 shows patch frames as broken images. The upgrade order is therefore rum-api and plugin, then collector, then SDKs.

## Consequences

- W3's exit target is at most 150 KiB/min at T3 with masking on (Sentry ≈ 110), at most 450 KiB/min at T4, and zero image bytes for a static screen. If tiles miss that target, a device encoder is reconsidered behind the same `kind`.
- rum-api, the replay receiver and `docs/compatibility.md` move to schema 2 together, which bumps rum-api's minor version. The plugin gains canvas blitting and the seek rule above. Storage, the frames endpoint and the chunk route are unchanged.
- Buffer mode costs disk (30 s of frames) and CPU while it uploads nothing. Navigation-only mode is the cheap fallback on low-end devices.
- Android (W9) and Flutter (W10) emit the same schema, so the player and the conformance checks are written once.
