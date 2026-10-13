# Video replay chunks in rum-api: storing and serving mp4 segments

Question: how does rum-api take a `kind: "video"` chunk (base64 mp4 inside JSON,
docs/specs/sentry-bridge.md 9 and 11) and serve the segments to a `<video>` element, and
what was non-obvious? (rum-api agent, 2026-10-14.)

## Splicing the stored JSON without re-encoding the chunk

The stored `<seq>.json.gz` is the upload minus `video.mp4`, plus `video.bytes`. Rather than
unmarshal the whole chunk into a map and marshal it again (another copy of a ~11 MiB
string, keys reordered), the validator records byte offsets while it walks the top-level
keys with `json.Decoder.Token()`:

- after `Token()` returns the key `"video"`, `dec.InputOffset()` is the byte **right after
  the closing quote of the key** (the colon is consumed by the next `Decode`);
- after `dec.Decode(&raw)` (a `json.RawMessage`), `InputOffset()` is the **end of the value**.

`body[:keyEnd] + ":" + newVideo + body[valEnd:]` then keeps every other byte as uploaded
(whitespace, key order, unknown keys). `TestSpliceVideoKeepsBytes` pins this with odd
whitespace and an escaped `"video"` inside a string value. Duplicate `video` keys are
rejected so there is exactly one span.

## Size limits

- The decoded mp4 is limited by `MAX_VIDEO_CHUNK_BYTES` (8 MiB). The body that carries it
  is about 4/3 of that, so the sink's body limit for video is
  `base64.StdEncoding.EncodedLen(MAX_VIDEO_CHUNK_BYTES) + 1 MiB` (12.2 MiB by default). The
  reader cap of `POST /v1/replay/chunks` is the largest kind limit; frames still stop at
  8 MiB through the per-kind check after `PeekKind`.
- `DecodedLen(len)` overestimates by up to 2 bytes (padding), so the cheap pre-check before
  decoding is `DecodedLen - 2 > max`; the exact check follows the decode.
- The collector's `ouoreplay` exporter posts the chunk **uncompressed** (no gzip), so the
  wire size is the full base64 body. Sentry segments are usually tens to hundreds of KB.

## Serving with http.ServeContent

- `http.ServeContent` gives `Range` (206, `Content-Range`, 416), `HEAD`, `Last-Modified`
  and `If-Modified-Since` for free. It needs an `io.ReadSeeker`, so segments are stored as
  raw mp4 files, never gzip.
- `Last-Modified` has **one-second resolution**. A `seq` re-posted within the same second
  as a client's earlier GET would get a 304 for the stale bytes. rum-api therefore also sets
  `ETag: "<size hex>-<mtime ns hex>"`; ServeContent evaluates `If-None-Match` before
  `If-Modified-Since`, so the replaced file is served. `Cache-Control: private, no-cache`.
- Go 1.26's built-in MIME table does map `.mp4` to `video/mp4`, but rum-api sets the
  `Content-Type` explicitly anyway.

## Open for the plugin

Not yet verified: whether Grafana's plugin route proxy passes `Range` through and returns
the 206 unchanged. If it does not, the player can fetch each segment whole as a blob
(`URL.createObjectURL`); segments are small.
