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
