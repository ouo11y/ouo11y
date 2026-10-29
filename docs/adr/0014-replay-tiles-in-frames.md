# ADR-0014 Replay representation: tiles in `frames` schema 2

Status: accepted (2026-10-29, roadmap agreed by the founder)

## Context

ADR-0006 sends every changed screen as a full JPEG: 20–40 KB per frame, measured at about 2× Sentry's bytes on the same journey (checklist N50). Sentry encodes H.264 and lands near 110 KiB/min masked. The mobile research compared three ways to diff ([comparison.md §4, §12](../../project/kb/mobile-sdk-research/comparison.md)) and the roadmap picked one ([roadmap.md §2.2](../../project/kb/mobile-sdk-research/roadmap.md#22-where-i-disagree)): device H.264 needs a second encoder per platform, and rrweb `<img>` mutations (LaunchDarkly) carry DOM semantics for something that is not a document. The plugin already owns a frames player and a video player.

## Decision

- **A frame is a full image or a list of patches** against the frame before it in the same chunk. `kind: "frames"` moves to `schema_version` 2; `kind: "video"` (Sentry-sourced replays, ADR-0008) stays at 1. Images are base64 JPEG in the field `jpeg`, as in schema 1, so a schema 1 frame is a valid schema 2 full frame.
- **Every chunk starts with a full image**, and patches refer only to frames in the same chunk. A chunk dropped by the uploader or lost offline therefore never breaks the next one, and a seek starts at the latest chunk start or full image. A schema 2 chunk flushes every 5 s, or once its images pass 1 MiB, and on pause, background and session rotation (not at 10 frames). That puts a keyframe at least every 5 s while the screen changes, within the roadmap's 6 s.
- **Further full images** go out on every screen change and on resume. A static screen produces no frame, so a chunk with no frames is not sent, and the screen costs zero image bytes. A viewport change (rotation) ends the chunk.
- **Patches** are computed on the capture queue from a 64 px tile hash and merged into a few rectangles. Each one is diffed against the last frame *sent*, never a dropped one. Patches do not overlap, and the player blits them in array order. When their total area would exceed half the frame, the SDK sends a full image instead.
- **Modes** are drawn at session start, and every chunk of the session carries the drawn value in `mode`:
  - `session`: the cadence of W1.
  - `buffer`: chunks go into an on-disk ring that keeps the last 30 s (whole chunks, so 30–35 s) and upload nothing. On the session's first error or crash, the ring is uploaded and capture continues at the `session` cadence while chunks still say `buffer`. Because the ring is on disk, a crash still yields it on the next launch.
  - `navigation`: one full image per screen change and on resume, with no cadence. It is the low-end tier's default.
- No rrweb container for raster, and no device video encoder until W3 is measured.

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
    { "ts": 1760000000100, "reason": "change", "jpeg": "<base64>" },
    { "ts": 1760000001100, "reason": "change",
      "patches": [ { "x": 0, "y": 128, "w": 196, "h": 64, "jpeg": "<base64>" } ] }
  ],
  "touches": [ { "ts": 1760000001200, "x": 120.5, "y": 640.0, "phase": "began|moved|ended" } ],
  "masked": true
}
```

- A frame has exactly one of `jpeg` and `patches`, and the first frame has `jpeg`. Readers tell full from patch frames by that, never by `reason`.
- Patch coordinates are integer pixels of the chunk's first image, which sets the canvas size. Each patch lies inside it.
- `reason` and `mode` are informational free text. Schema 1's `timer|touch|navigation|resume` stay valid. In W3 the plugin reads `mode` only to label a buffer replay ("starts 30 s before the error").
- `touches` stay in points, and every other field keeps its schema 1 meaning (`docs/specs/mobile-replay.md`).

**Player.** It keeps one canvas, sized from each chunk's first image: draw a full image, blit each patch. To seek, it draws the last full image at or before the target and applies the patch frames after it. Since every chunk opens with one, a missing chunk costs only its own seconds, which is how ADR-0003's "missing chunks degrade gracefully" holds for tiles.

**Schema 1 readers.** A collector replay receiver or rum-api that reads at most schema 1 rejects a schema 2 chunk with 400 (`schema_version 2 not supported`), and the SDK drops it after its retry budget (`docs/operations/upgrade.md` §4). A rum-api that reads schema 2 writes it into `replays/schema.json`, so an older rum-api refuses to start on that store. Stored chunks are never rewritten: rum-api passes frames through unchanged, and a session may mix schema 1 and 2 chunks. A plugin built for schema 1 shows patch frames as broken images. The upgrade order is therefore rum-api and plugin, then collector, then SDKs.

## Consequences

- W3's exit target, with zero image bytes for a static screen:
  - at most 150 KiB/min at T3 with masking on (Sentry ≈ 110);
  - at most 450 KiB/min at T4 with masking off (Sentry ≈ 362).

  If tiles miss it, a device encoder is reconsidered behind the same `kind`.
- rum-api, the replay receiver and `docs/compatibility.md` move to schema 2 together, which bumps rum-api's minor version. Both validators change from "non-empty `jpeg` on every frame" to:
  - exactly one of `jpeg` and `patches`;
  - the JPEG marker on each image;
  - patches inside the first image.

  The receiver accepts `1 <= v <= 2` instead of `== 1`. The plugin's frame type gains `patches`, and the player gains canvas blitting. Storage, the frames endpoint and the chunk route are unchanged.
- ADR-0006's "JPEG frames, one full image each" is replaced by this ADR for schema 2. The ADR-0006 revision (W1) points here.
- Buffer mode costs disk (30–35 s of chunks) and CPU while it uploads nothing. Navigation-only mode is the cheap fallback on low-end devices.
- Android (W9) and Flutter (W10) emit the same schema, so the player and the conformance checks are written once.
