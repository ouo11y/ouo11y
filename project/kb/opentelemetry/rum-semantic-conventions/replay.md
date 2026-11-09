# RUM conventions: replay

Rules, status words and sources are in [rules.md](rules.md). Choices here are **Proposed**.

## What OTel defines

**Nothing.** Checked on 2026-11-09:

- No `replay` in core, client-side or in any open PR in the client-side registry.
- Browser issue #32 ("consider session replay using rrweb") has only +1 comments and no design.
- Semantic-conventions #3592 proposes "replay-adjacent" mobile events and explicitly excludes full replay, screenshots and view hierarchy.
- The Android roadmap lists replay as a distant item and cites "the absence of an appropriate OTLP style data model".
- The keyword search of the SIG notes found no replay discussion. It was not a full read.

## Event or span

**Event, a log record per chunk.** The founder's expectation holds. A chunk is a payload at a moment, must survive tab death, has no children, and a span would be open for a whole recording. Span events are being deprecated.

## Prediction

OTel will eventually define a log record with an event name, an identifier tying it to a session, ordering attributes, and either a bytes body or a reference. The `*_ref` direction was noted in the earlier research. Confidence: event-shaped High, bytes versus reference Medium, name Low. Not soon: we found no work in progress, so assume at least a year.

## Ours

One log record per chunk, **event name `ouo.replay.chunk`**.

| Field | Value |
|---|---|
| Scope | Own logger, `ouo.replay`, so the pipeline can route it (Q26) |
| `session.id` | Join key. No separate replay id |
| `ouo.view.id` | Optional, for jumping to a page |
| `ouo.replay.sequence` | Integer, per session, from 0. Detects gaps and reorders (Q25) |
| `ouo.replay.start_time`, `ouo.replay.end_time` | Time range, in ms since epoch. The record time is the chunk start |
| `ouo.replay.format` | For example `rrweb` or a mobile format. A reader must know how to decode it |
| `ouo.replay.encoding` | Compression of the body, for example `gzip` |
| Body, SDK to Collector | Bytes |
| `ouo.replay.ref` | Set by the Collector, replaces the body, points to the stored object |

## Bytes or reference (Q23)

**Both, at different hops. Founder decision D3.**

- **SDK to Collector: bytes body.** The Collector is the edge, and OTLP carries bytes raw over protobuf. No presigned-URL dance, no second endpoint for the client, and no client access to object storage.
- **Collector to log store: reference only.** A custom Collector component writes the bytes to the replay store and forwards the record with `ouo.replay.ref` and no body. So Loki never sees a body over 256 KB or a base64 expansion, and the log store remains an index over chunks.

If the Collector component falls behind or is unavailable, the fallback is to drop the chunks, not the other telemetry. That is why it must be a separate pipeline.

JSON encoding note: OTLP JSON has to base64 bytes, a 4/3 cost before compression. If a client chooses JSON over protobuf to save bundle size ([Step 1](../storage-backends/signal-choice-and-backends.md)), replay is the exception to re-measure.

## Pipeline and limits (Q24, Q26)

A separate queue and separate export in the SDK, and a separate Collector pipeline keyed on the scope. A large replay backlog must never delay errors. The 64 KiB `keepalive` budget at page unload is shared by all fetches in flight, so unload flushes send telemetry first and only then a small replay chunk. Sizes and flush timing are Step 3.

## Vendor names

| | Sentry | Datadog | PostHog |
|---|---|---|---|
| Web | envelope items `replay_event`, `replay_recording` | `replay` track | `$snapshot` event |
| Mobile | `replay_video` | not checked | `$snapshot` |
| Link from other data | `sentry.replay_id` | `session.has_replay` | |

All three treat replay as its own payload type rather than as ordinary telemetry records, which supports the separate pipeline. How each one transports it is for Step 6.
