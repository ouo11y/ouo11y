# rrweb chunking

Status: filled in Phase 2 by sdk-browser (2026-10-06). Code: `sdk/browser/src/replay`.

## Question

How does the browser SDK record a session with rrweb and ship it as ordered, bounded,
compressed chunks (ADR-0003), and what sizes come out?

## What works

- `rrweb` 2.1.7, loaded with `import("rrweb")` so tsup emits it as its own chunk
  (`dist/rrweb-*.js`, 257 KB raw / 80 KB gzip) that is only downloaded when
  `replay.enabled` is true, a `replayEndpoint` is set and the session is sampled.
- `record({ emit, maskAllInputs: true, blockClass: "ouo-block", maskTextClass: "ouo-mask",
  checkoutEveryNms: 300000, recordCanvas: false, collectFonts: false, inlineImages: false,
  slimDOMOptions: { script: true, comment: true } })`. `record()` returns the stop function;
  `record.takeFullSnapshot(true)` forces a checkout (used when the session rotates while
  the page lives).
- Masking verified on a chunk written to disk: a typed value `secret` arrives as `******`
  (input event `text: "******"`), `ouo-mask` text and `ouo-block` content are absent from
  the full snapshot.
- Chunker (`chunker.ts`, pure, injectable clock): buffers events, cuts a chunk after 5 s or
  when the estimated JSON size reaches 256 KB, whichever first. The session id and the
  sequence number are captured when the buffer **starts** (`SessionManager.nextReplaySeq()`
  reads `localStorage` fresh, increments, writes immediately), so a session rotation while
  events are buffered does not relabel them and two tabs do not reuse a seq.
- Upload (`uploader.ts`): `JSON.stringify(chunk)` ->
  `new Response(bytes).body.pipeThrough(new CompressionStream("gzip"))` -> `POST
  ${replayEndpoint}/v1/replay/chunks` with `content-type: application/json`,
  `content-encoding: gzip`, `x-ouo-session-id`, `x-ouo-seq`, `authorization: Basic
  base64(<project id>:<project token>)` (since Phase 8a), `keepalive: true` when the
  body is under 48 KB. Uses `fetch.__original` so the OTel fetch instrumentation does not
  trace uploads (the URL is also in `ignoreUrls`). Sequential queue, 3 attempts with
  1 s / 2 s backoff, then the chunk is dropped; buffered + queued bytes capped at 2 MB
  (oldest queued chunks dropped first).
- `pagehide`: the remaining buffer is sent **uncompressed** (compression is async and the
  page is going away) with `keepalive: true`, no retry. Verified: the stub received
  `seq=7 wire=582B gzip=false keepalive=true` with the 5 input events typed just before
  navigating away. `visibilitychange: hidden` triggers a normal (gzip) flush first, so the
  keepalive chunk is usually tiny and stays well inside Chrome's 64 KiB keepalive budget
  that the OTLP exporters share.
- Reload: a new `record()` starts with a full snapshot and the seq continues (`seq=4` after
  a reload of a session that had sent 0..3). New session: seq resets to 0.
- `pause()` stops recording and flushes; `resume()` calls `record()` again, which starts
  with a fresh full snapshot (verified: chunk after resume has types `[4, 2, 3]`).
- `sampleRate` is decided once per session with `Math.random()` and stored as
  `replaySampled` in `ouo.session`.

## Measured sizes (playground page, ~100 DOM nodes)

| Chunk | Events | JSON | gzip | Notes |
|---|---|---|---|---|
| page load (meta + full snapshot + 2 incremental) | 4 | 5.6 KB | 1.3 KB | every page load |
| idle 5 s with one mouse move | 1 | 0.5 KB | 0.26 KB | |
| after resume (new full snapshot) | 7 | 7.7 KB | 1.4 KB | |
| pagehide, 5 typed characters | 5 | 0.58 KB | n/a (plain) | keepalive |

Full snapshots compress 4 to 5 times; incremental chunks are dominated by the envelope.
A real storefront page will have snapshots in the 50 to 300 KB JSON range, which is why
the 256 KB early-flush bound exists.

## Gotchas

- Since Phase 8a (ADR-0007) the SDK uploads to the collector's `ouoreplay` receiver
  (port 4319), not to rum-api: the receiver checks the Basic credential, answers the CORS
  preflight (`authorization, content-encoding, content-type, x-ouo-seq, x-ouo-session-id`
  with `POST`, global `OUO_ALLOWED_ORIGINS`), accepts gzip and plain bodies
  (`content-encoding` tells which) and hands the chunk to the `ouoreplay` exporter, which
  posts it to rum-api's internal sink with the ingest token. rum-api only stores and serves
  replays; it has no CORS and no public ingest. The measurements above were taken in
  Phase 2 against a stub.
- Chunk `started_at` / `ended_at` are Unix epoch **milliseconds** (same unit as rrweb
  event `timestamp`); `ouo.session.started_at` on events is too.
- Several tabs of one session each record their own stream and interleave seq numbers;
  the player concatenating by seq will show snapshots alternating between tabs. Known MVP
  limitation (ADR-0003 says one session one replay).
- jsdom runs rrweb well enough for the integration test to see a full snapshot and a gzip
  upload, so the chunk path is covered without a browser.
