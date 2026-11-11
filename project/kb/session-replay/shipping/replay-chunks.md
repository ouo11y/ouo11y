# Each technique as `ouo.replay.chunk`

Explainer: [topic 6](../session-replay-explainer.html#t6), with a chunk builder that cuts 60 s of each technique into records. Evidence only, no decision.

## Today and in the draft spec

- **Today.** SDKs `POST /v1/replay/chunks` to the `ouoreplay` receiver on port 4319 ([config.go](../../../../collector/receiver/ouoreplayreceiver/config.go), [receiver.go](../../../../collector/receiver/ouoreplayreceiver/receiver.go)). A JSON envelope carries `kind` (`rrweb`, `frames` or `video`) with images and MP4 as base64. Mobile frames close a chunk at 5 s, 1 MiB of images, pause, background, rotation or a screen-size change ([mobile-replay.md](../../../../docs/specs/mobile-replay.md)).
- **Draft spec** ([sdk-spec.md](../../opentelemetry/rum-semantic-conventions/sdk-spec.md) §11, [replay.md](../../opentelemetry/rum-semantic-conventions/replay.md)). An OTLP log record, event `ouo.replay.chunk`, scope `ouo.replay`, over OTLP/HTTP protobuf. Hierarchy session → replay → stream → segment → chunk. Chunks close at 256 KiB (hard 1 MiB), 5 s, stream end or hide (RPL-10); a keyframe at least every 5 min and on visibility change (RPL-9); `ouo.replay.sha256`. Bytes go to the Collector, which stores them and forwards a reference (D3, recommended, not decided). The mobile format is open (§11.6).

## Techniques mapped

| Technique | Keyframe | Deltas | Body | Per 5 s chunk (per-minute evidence ÷ 12) |
|---|---|---|---|---|
| rrweb (web) | Meta + FullSnapshot | incremental events | JSON, gzip | ~1.7 KiB (ouo, 19.9 KiB/min); a 10,000-node page ~21 KiB |
| Wireframes | full wireframe list | adds, removes, updates | JSON, gzip | ~2.8 KiB to 6–60 KiB |
| Frames + tiles (ouo mobile) | full JPEG | tile patches | JPEG, identity | ~3.2 KiB iOS, ~11.8 KiB Android |
| Video (Sentry) | the MP4 itself: one segment = one chunk | inside the codec | MP4, identity | ~4.1 KiB to 14–18 KiB |

The open choices (body packaging, compression, segment length, resources, touches, where bodies live, formats per session) are tabled in the explainer, section 6.4. What survives every option is the chunk record itself, which is what RPL-23 asks for: the record must not depend on the format.
