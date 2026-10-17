# rum-api: `kind: "video"` replay chunks (2026-10-14)

Branch `claude/sentry-bridge-design` (worktree `rum-api-sentry-sdk-compat-ede203`). Scope:
docs/specs/sentry-bridge.md section 11 (and the section 9 output contract): store and
serve Sentry mobile Session Replay segments (H.264 mp4) that the collector's Sentry bridge
emits as `kind: "video"` chunks through the `ouoreplay` exporter. Not committed (the
orchestrator commits). No new dependencies (standard library only).

## Changed

- `internal/replay/store.go`: `KindVideo`, `DefaultMaxVideoBytes` (8 MiB), `ErrTooLarge`;
  `Chunk` gets `DurationMs`, `VideoBytes`, `Source` (+ unexported decoded mp4 and the JSON to
  store); `Source{vendor, replay_id}`; `ChunkInfo.duration_ms` (`*int64`) and `video_bytes`
  (both omitted for other kinds); `Meta.source`; `Store.OpenVideo` returning `VideoFile`
  (`io.ReadSeekCloser`, size, mtime).
- `internal/replay/parse.go`: `parseChunk(body, maxVideoBytes)`. Frames and video share the
  schema_version / timestamps / viewport / touches checks. `parseVideo`: `video` object,
  `container == "mp4"`, `mp4` non-empty base64 (padded or unpadded), decoded size at most the
  limit (`ErrTooLarge`, early reject from `DecodedLen` before decoding), `ftyp` at offset 4;
  optional `encoding` (string), `duration_ms` / `frame_count` (ints >= 0), `frame_rate`
  (number); duration falls back to `ended_at - started_at`. `parseSource`: optional object,
  string `vendor` / `replay_id`. The stored JSON is the upload with only the `video` value
  replaced (offsets from `json.Decoder.InputOffset`, see kb), so unknown keys, `masked` and
  the full `source` stay in the chunk file. Duplicate `video` keys are 400.
- `internal/replay/fs.go`: `FS.MaxVideoBytes`; for video, `000003.mp4` is written atomically
  first, then `000003.json.gz` (gzip of the slim JSON; the uploaded gzip is not reused since
  it holds the base64), then `meta.json`, all under the per-session lock after the kind /
  project checks. Meta: viewport and platform as for frames, `source` kept from the first
  chunk that has one, chunk `bytes` = mp4 + json.gz. `OpenVideo`. Delete unchanged
  (`RemoveAll`).
- `internal/replay/stream.go`: `ReadPath(kind)`; 409 errors name the right endpoint;
  `VideoManifest` / `VideoSegment`, `BuildVideoManifest`, `WriteVideo`.
- `internal/httpapi/replay.go`: reader cap = max(frames limit, video body limit), video body
  limit = `base64(MaxVideoChunkBytes) + 1 MiB`; above the rrweb limit the per-kind limit
  applies (`bodyLimit`), so frames above 8 MiB are still 413. `ErrTooLarge` -> 413.
  `checkKind` shared by the streaming endpoints and the segment endpoint.
  `GET /replay/video` through `streamReplay` (gzip, `X-Ouo-Replay-Kind`).
  `GET /replay/video/{seq}`: 400 bad seq, 404 / 409 via `checkKind`, 404 missing segment,
  `video/mp4`, `Cache-Control: private, no-cache`, `ETag`, `X-Ouo-Replay-Kind`,
  `http.ServeContent`.
- `internal/httpapi/server.go`: `Options.MaxVideoChunkBytes` (default 8 MiB, never below
  `MaxChunkBytes`), two routes. `sessions.go`: `replay_frame_count` also for video.
  `cors.go`: `Range` allowed, `Content-Range` / `Accept-Ranges` exposed (local tooling).
- `internal/config/config.go` + `main.go`: `MAX_VIDEO_CHUNK_BYTES` (default 8388608, clamped
  to at least `MAX_CHUNK_BYTES`), handed to both `FS.MaxVideoBytes` and the API options.
- `README.md`: intro, diagram, refs, config table, CORS headers, sink (video format,
  validation, limits, 202, on-disk layout), meta, manifest, segment endpoint, 409 rules,
  session fields, curl examples, how it works, layout.
- `docs/specs/sentry-bridge.md` section 11: added "Clarifications from the implementation":
  the video body limit and that the exporter must allow it; decoded oversize is 413 not 400;
  optional `video` fields and the duration fallback; 202 counters; meta `duration_ms`,
  `video_bytes`, `source`; segment `ETag`, cache header, 400 / 416, manifest `path` relative
  to the rum-api root, `source: null`. Nothing in the spec was contradicted.
- `project/kb/video-replay-serving.md` (+ index line).

## Shapes as implemented

202: `{"accepted":true,"project_id":"mobile-store","session_id":"<id>","kind":"video","seq":3,"events":0,"frames":<video.frame_count>,"touches":<n>,"bytes":<request body bytes>}`

Meta (`GET /v1/sessions/{id}/replay`): the existing meta plus, for video, `viewport`,
`platform`, `source: {vendor, replay_id}`, `frame_count` (sum of `video.frame_count`) and
per chunk `duration_ms` and `video_bytes`.

Manifest (`GET /v1/sessions/{id}/replay/video`), keys in this order:
`{"session_id","kind":"video","viewport":{width,height,scale},"platform","started_at","ended_at","segments":[{"seq","started_at","ended_at","duration_ms","frame_count","bytes","path":"/v1/sessions/<id>/replay/video/<seq>"}],"touches":[...as uploaded...],"source":{"vendor","replay_id"}|null}`

## Verified

- `cd services/rum-api && go vet ./... && go test -race -count=1 ./...`: all packages ok;
  41 top-level tests + 14 subtests pass, 0 fail. New tests: `replay`:
  `TestVideoPutMetaManifest` (files, slim JSON, meta, OpenVideo, manifest, replace on
  re-post, kind mismatch both ways, other project, delete), `TestVideoValidation` (8 good
  variants incl. unpadded base64 and exactly-the-limit; 25 bad cases incl. bad ftyp, bad
  base64, wrong container, bad touch, bad source; too big padded and unpadded -> ErrTooLarge;
  each bad case checked to fail for its own reason), `TestSpliceVideoKeepsBytes`;
  `httpapi`: `TestVideoReplayHTTP` (202 shape, 400 bad ftyp, meta JSON, manifest gzip + plain
  with exact prefix and key order, segment 200 / `Range: bytes=0-99` 206 exact bytes /
  open range / 416 / 304 on If-Modified-Since and If-None-Match / HEAD / 404 / 400, re-post
  replaces and the old ETag no longer matches, 409 matrix both ways for reads and posts,
  delete), `TestVideoChunkSizeLimits` (6 MiB mp4 = 8+ MiB body accepted plain and gzip,
  8 MiB + 1 decoded -> 413, 10 MiB mp4 body -> 413 plain and gzip, 8+ MiB frames body still
  413, configured 5 MiB limit honoured), `TestVideoSessionFields` (list and detail
  `replay_kind` video, `replay_duration_ms` 10000, `replay_frame_count` 8),
  `TestVideoReadToken`; `TestReplaySummaryFromMeta` gained a video case;
  `TestFramesValidation`'s "unknown kind" now uses `gif` and a "video without video" case
  was added.
- Live binary (`OTEL_SDK_DISABLED=true`, both tokens set, scratch `DATA_DIR`): gzip POST of a
  video chunk -> 202; meta, manifest (`Content-Encoding: gzip`, `X-Ouo-Replay-Kind: video`);
  `curl -r 0-99` -> 206 `Content-Range: bytes 0-99/536`, bytes identical to the first 100 of
  the mp4 (`cmp`); `/replay/events` -> 409 naming `/replay/video`; directory holds
  `000000.mp4`, `000000.json.gz`, `meta.json`.
- `docker build -t ouo/rum-api:sb services/rum-api`: ok. No container run or replaced.

## For the next agents

- Collector (`ouoreplay` exporter, `ouosentry` receiver): rum-api accepts video bodies up to
  ~12.2 MiB (decoded mp4 8 MiB). The exporter posts uncompressed; it maps 413 / 400 / 409 to
  permanent errors already. `X-Ouo-Seq` / `X-Ouo-Session-Id` headers stay informational.
  The `ouoreplay` receiver's kind check (port 4319) still rejects `video`; only matters for
  direct client posts.
- Plugin: pick the video player on `replay_kind == "video"`; fetch the manifest, then each
  segment by mapping `path` (rum-api root relative) onto the plugin proxy route. Check that
  Grafana's plugin proxy forwards `Range` and the 206; if not, fetch segments whole as blobs.
  `<video src>` cannot set `Authorization`; going through the Grafana proxy (cookie session
  + injected read token) avoids that.
- Open: S3 store would need `OpenVideo` as a ranged GET / presigned URL.
