# 2026-10-30 W3a, step 1: `frames` schema 2 in rum-api, the collector and the player

Branch `claude/w3a-tiles`, first of the two W3 tiles PRs of [roadmap.md](../../../kb-archive/mobile-sdk-research/roadmap.md) §3 (lane C), as decided in [ADR-0014](../../../../docs/adr-archive/0014-replay-tiles-in-frames.md). Env `w3a-tiles`. Step 2 (Swift tiles in `sdk/ios`) follows on the same branch name once this merges.

## What was done

- **rum-api** (`internal/replay`): `SchemaVersion` 2. One `frameChecker` replaces `validateFrame`: every frame has `ts` and exactly one of `jpeg` and `patches`; the first frame is a full image; every image is base64 with the JPEG marker; patches are non-empty, integer, positive-sized and inside the most recent full image, whose size comes from its JPEG header (`image/jpeg.DecodeConfig`). A full image whose header does not parse still passes alone (schema 1 behaviour, existing fixtures), and fails only when a patch needs its size. `patches` under schema 1 is a 400. Video chunks stay at schema 1. Storage and the frames endpoint are unchanged: frames pass through as uploaded.
- **Collector replay receiver** (`ouoreplayreceiver/chunk.go`): the same checker (a copy, as the file says), `maxSchemaVersion = 2`; `compat-check.mjs` reads that constant now.
- **Plugin**: `ReplayFrame.jpeg` optional, `patches` added. `utils/frames.ts` gains `frameDrawOps` (data URLs once per replay) and `paintOps` (the latest full image at or before a frame, then every patch after it). `FramePlayer` keeps one `<canvas>` instead of an `<img>`: it decodes the ops' images (an LRU of 64 decoded images keyed by op), sizes the canvas from the full image and blits patches in order; a stale paint is dropped when the cursor moved on; a full image that does not decode leaves the canvas as it was, a patch that does not decode is skipped.
- **Docs**: `docs/specs/mobile-replay.md` rewritten for schema 2 (chunk, frames, chunking, validation, the API and player paragraphs, capture rule 6); `docs/compatibility.md` schema table (rum-api and receiver 2, video 1, iOS still 1); `docs/operations/upgrade.md` section 4 (schema 2, the upgrade order).

## Decisions worth knowing

- **Patches lie inside the most recent full image** of the chunk, not literally "the chunk's first image" as ADR-0014 words it. They are the same image when the SDK cuts the chunk on a size change (the spec says it must); checking against the latest one also keeps the validator and the player on one rule (the canvas is sized by every full image).
- **A chunk with touches and no frames is still sent** (a static screen with taps): zero image bytes, and the taps matter (rage taps on a screen that does not react). The spec says so; ADR-0014's "a chunk with no frames is not sent" is read as "no frames and no touches".
- `mode` is not surfaced by the frames endpoint: the plugin needs it only to label a `buffer` replay, and nothing emits `buffer` yet. Whoever builds buffer mode adds it (meta or endpoint).
- Release lines (rum-api 0.6, collector 0.5, plugin 0.10) are added by the release PRs, per `docs/releasing.md`; their bounds can only name released versions.

## Verified, and how

- `services/rum-api`: `go vet ./...` clean, `go test ./...` pass; new `TestFramesSchema2` (2 good chunks, 16 refusals) and `TestFramesMixedSchemasStream` (schema 1 and 2 chunks in one session, served in seq order, unchanged); the existing video test still refuses video schema 2.
- `collector/receiver/ouoreplayreceiver`: `go vet`, `go test` pass; new `TestParseChunkSchema2`.
- Plugin: `tsc --noEmit` clean, jest 26 suites / 183 tests pass (new: `frameDrawOps`/`paintOps`, canvas painting with patches, seeking into a later chunk, a patch that does not decode), eslint no new warnings, prettier clean.
- `node .github/scripts/compat-check.mjs`: OK, schema in code `[2,2,1,1]`.
- **Live**, env `w3a-tiles` built from this branch: `deploy/scripts/smoke.sh` OK. A generator (real JPEGs, 192x384, a red square moving 64 px per patch frame) posted one schema 1 chunk and two schema 2 chunks through the collector's replay receiver: 202 each; a chunk whose first frame is a patch frame got 400 `frames[0]: the first frame must be a full image (jpeg)` at the edge. rum-api's frames endpoint served the 14 frames as uploaded. In Grafana, the session's frame player stepped through all 14 frames; reading the canvas pixels at each step put the square exactly where each frame puts it (rows 76, 140, 204, 268, then the second full image's 12 and its patch's 76), and a scrub back from the last frame to frame 5 rebuilt it from its chunk's full image plus three patch frames.
- `lychee --offline` clean.

## Left, and what the next session must know

- Step 2: Swift tiles in `sdk/ios` (`ScreenCapturer.compose`, `FrameComposer`, `Models`, `ChunkBuilder`), `FrameChunk.schemaVersion` 2 and the iOS row of the schema table, and the B3 simulator run against the W1 result.
- W3b's note for step 2: `ChunkBuilder.cut()` clears the spool before `onChunk` hands the chunk to W3b's on-disk outbox, so a kill in that window loses it; clear the spool after `onChunk` returns.
- Buffer mode (ADR-0014) is not built by W3a: it needs the on-disk ring (where `ChunkSpool` should become the one-entry case) and the plugin label.

## Review round 1 (review-pr-116)

- **Fixed**:
  - The patch bounds check overflowed (`x + w > width` with x = MaxInt). Both validators now check `x < width && w <= width - x` (same for y), with tests.
  - A patch's JPEG must be exactly `w` x `h` (read from its header), which catches a points-vs-pixels bug in an SDK with a 400.
  - `frameChecker` lost its frame counter (the index is passed in), and `patchFrames` became a bool.
  - The player's image cache never evicts what one paint needs (`max(64, ops of the paint)`).
  - ADR-0014 got revision 1 with the two readings (most recent full image; a touches-only chunk is sent).
  - `upgrade.md` names plugin 0.10 and the grafana image.
- **Answered, not changed**: "scrubbing back before the first frame keeps the last frame on the canvas" does not happen. `frameIndexAt` clamps such a cursor to frame 0, which is always a full image, so the canvas repaints it. A new test pins this.
- Verified again: rum-api `go vet` and its replay tests (the S3 tests could not pull the MinIO image from Docker Hub locally, a timeout; CI runs them); the collector's `go vet` and `go test`; the checker copies are identical except for the error name; plugin jest 185/185, `tsc`, eslint, prettier.
