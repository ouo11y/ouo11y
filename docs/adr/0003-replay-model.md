# ADR-0003 One session, one replay, many chunks

Status: accepted (2026-10-06)

## Context

The MVP asks whether one session equals one replay or whether a session can contain several replays.

## Decision

**One session has exactly one replay.** The replay is an ordered sequence of chunks:

- The web SDK runs `rrweb.record` for the life of the page and flushes buffered rrweb events as a chunk every 5 seconds or when the buffer exceeds 256 KB, whichever comes first, and on `pagehide` via `fetch(..., { keepalive: true })`.
- A chunk is `{ session_id, seq, started_at, ended_at, events: [...] }`, gzip-compressed, posted to `rum-api` `POST /v1/replay/chunks`. `seq` is monotonic per session and persisted with the session so a reload continues the sequence.
- Every full page load starts a new rrweb recording, which begins with a full snapshot. A replay therefore contains one or more full snapshots; the rrweb replayer handles that natively, so the player simply concatenates all chunks of the session in `seq` order.
- rrweb's `checkoutEveryNms` is set to 5 minutes so long single-page sessions also get periodic full snapshots, which keeps seeking cheap.
- Storage layout: `replays/<session_id>/<seq padded to 6>.json.gz` plus `replays/<session_id>/meta.json` (chunk count, time range, bytes). Filesystem in the MVP, behind a `ReplayStore` interface.
- Privacy: `maskAllInputs: true` by default, `blockClass: "ouo-block"`, `maskTextClass: "ouo-mask"`. Replay can be turned off independently of telemetry (`replay.enabled: false`) and paused at runtime.
- Mobile has no replay in the MVP.

## Consequences

- No separate "replay id". `session.id` is the key everywhere, which keeps the timeline, traces and replay trivially joinable.
- Missing chunks degrade gracefully: the player plays from the next full snapshot.
- Replay bytes never pass through the OTel Collector or Loki.
