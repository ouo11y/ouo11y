# 2026-11-25: Sentry replays on the Muninn wire

## What was missing

The Sentry bridge emitted replays only as the legacy video chunk that the `ouoreplay` exporter reads. A Collector that stores replay in Muninn (scope `ouo.replay`, `config.muninn.yaml`) had nothing to route, so a mirror-fed bridge in front of such a Collector had to drop every replay. Browser replays (`replay_event` + `replay_recording` items) were not decoded at all.

## What changed

- New receiver setting `replay_wire`: `legacy` (default, unchanged) or `muninn`.
- On `muninn`, each segment is one `ouo.replay.chunk` record that Muninn's ingest accepts (spec section 9d): mobile `replay_video` as `ouo-video/1` (header line + mp4, `identity`), browser recordings as `rrweb/2` (rrweb events as NDJSON, gzip; keyframe when the segment holds a full snapshot).
- Recordings are read whether zlib (the browser SDK's fflate `Zlib`, `78 9c`), gzip or plain, in the existing parser too.
- A browser segment whose session is unknown uses its replay id as `session.id` instead of being held: browser apps without a release send no session.
- New drop reason `replay_too_large` (Muninn's 1 MiB chunk limit).

## Verified

- `go vet`, `go test -race ./...` in `collector/receiver/ouosentryreceiver`: new tests for both formats, the legacy wire, the zlib reader and config validation.
- The records the bridge produced (dumped as OTLP protobuf) were posted to Muninn's own ingest in its test harness: both accepted, 0 rejected, and the manifests list `ouo-video/1` / `identity` and `rrweb/2` / `gzip` chunks with the expected ids, sequence and keyframe. The throwaway harness test was not committed.

## Left

- Not yet run against a live browser SDK; the first real check is a mirror-fed deployment.
- No `ouo.replay.ended` (Sentry never says a recording ended); Muninn shows such streams `open`, then `partial`.
- `ouo-video/1` playback in `@ouo11y/kit` is separate work.

## Review (second session): end-to-end run and fixes

Ran against real SDKs: a 7.58.1 browser app (no release, numeric user id, session and buffer mode, a reload, a 7.6 min page view), the 11.11.0 `examples/sentry-web` (session and buffer mode), the seven sentry-cocoa captures in `testdata/golden` (118 segments) and the sentry-java fixtures in the kb (3 segments). Path: browser → bridge (`replay_wire: muninn`, `upstream: none`) → collector on `config.muninn.yaml` → Muninn (filesystem). Every segment the bridge emitted was stored, none rejected. Web chunks play in `@ouo11y/kit`'s `ReplayPlayer`; video chunks pass `avmediainfo` and play in the PR 222 video player.

Fixed:

- Sentry writes `performanceSpan` (and `ui.focus`, `ui.blur`, `replay.mutations`, `replay.throttled`) with `timestamp` in seconds. Passed through unchanged, rrweb sorts them first and the player showed a 20 s replay as 498 281 hours. They are now rewritten in ms.
- Browser `options` carry `blockAllMedia` and `maskAllInputs`, not `maskAllImages`: a browser replay with masking off was reported masked. Read now, and kept for the later segments of the replay when no session holds it.
- A browser replay outlives Sentry's sessions (one per page load or route). A segment that resolved to a session after earlier ones fell back to the replay id split one replay across two `session.id`s (two Muninn replays, the second without its keyframe). Each browser replay now keeps the `session.id` its first segment got; a session that already holds another replay no longer drops the segment.
- A `replay_event` without its `replay_recording` (or the reverse) was dropped silently; it is counted `replay_incomplete`, and several pairs in one envelope are paired in order.
- The recording is inflated once per segment, not twice.

Left: errors of a browser app that sends no session carry no `session.id`, so they are not joined to the replay (whose `session.id` is the replay id); a full snapshot over 1 MiB gzip is dropped, and in session mode the SDK makes no new full snapshot until a reload, so the rest of that page is unplayable.
