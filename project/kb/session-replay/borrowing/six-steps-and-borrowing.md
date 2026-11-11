# Six steps, and which to borrow

Explainer: [topic 7](../session-replay-explainer.html#t7), with a borrow map per recorder. Proposed decision: [ADR-0018](../../../../docs/adr/0018-borrow-the-replay-recorder.md).

## Replay without the buzz words

1. **Hook**: a callback or loop the recorder registers (MutationObserver, run-loop observer, draw listener plus a timer, post-frame callback).
2. **Record**: pixels (take a frame) or structure (describe the screen: DOM snapshots and mobile wireframes are the same family).
3. **Mask**: a data transform for structure, which cannot miss; geometry for pixels, which can miss when a view moves between the tree walk and the copy.
4. **Pack**: images, tiles, WebP, H.264, JSON. An optimisation: it changes bytes and CPU, never what the replay shows or whether masking is right.
5. **Ship**: `ouo.replay.chunk` through the OpenTelemetry Logs SDK. ouo's own.
6. **Play**: a player per format in the Grafana plugin. The hidden cost of supporting several formats.

Only steps 2 and 3 are design questions. Steps 1 and 4 are copyable engineering; 5 and 6 are ouo's.

## Licences (read from each repository's LICENSE file on 2026-11-11)

| Project | Licence |
|---|---|
| sentry-cocoa, sentry-java, sentry-javascript, sentry-dart | MIT |
| posthog-ios, posthog-android | MIT |
| rrweb | MIT |
| dd-sdk-ios, dd-sdk-android | Apache-2.0 (keep LICENSE and NOTICE, mark changed files) |

Copy the recorder core (hook, record, mask, pack) at a pinned tag, keep the notices, add a script that diffs the copy against a newer upstream tag, and cut the seams to the vendor's hub, options and envelope. Not legal advice; one review before the first release that ships copied code.

## Order

1. **Sentry video**, iOS then Android: the plugin already plays `kind: "video"` from the Sentry bridge ([ADR-0008](../../../../docs/adr-archive/0008-sentry-sdk-bridge.md)). A spike session ports the iOS core.
2. **PostHog wireframes**: rrweb-shaped events, close to the existing web player (not checked in player code).
3. **Datadog wireframes**: no open-source player found; ouo would write the renderer.

Each chunk names its format in `ouo.replay.format` (for example `sentry-video`).

## What borrowing Sentry gives up

- A static screen costs one full picture per 5 s segment instead of zero bytes (ouo tiles, [ADR-0014](../../../../docs/adr-archive/0014-replay-tiles-in-frames.md)).
- The drop-if-moving mask check ([ADR-0006](../../../../docs/adr-archive/0006-mobile-replay-native-screenshots.md) revision 2), unless kept as a patch on the copied code.
- Bytes on the Step 5 light journey ([overhead.md](../../client-sdk-state/overhead.md)): Sentry iOS 49.5 KiB/min vs ouo 38.8; Android about 193 vs 142.

## The founder's questions

- **ouo also captures about 1 fps; what differs from Sentry?** Mask and pack. ouo sends nothing on a static screen, only changed 64 px tiles on small changes, a full JPEG on scroll, and drops a frame when a masked view moved. Sentry sends a frame every second regardless (Android re-sends the last bitmap, iOS repeats it in the video), lets the codec encode differences (cheap on scroll), and keeps frames with moving masks.
- **Why is an unchanged frame almost free in H.264?** Frames are cut into 16×16 blocks; in a P-frame a block equal to the previous frame is a "skip" (about one bit) and a moved block is a motion vector plus a small residual. But Sentry iOS forces a key frame at least every 6 frames and every 5 s segment is its own MP4 starting with one, so a static screen still costs a full picture per segment (Step 6 measured about 36 KB per idle 5 s segment on Android).
- **When does ouo export?** At the first of 5 s, 1 MiB of images, pause or background, session rotation or screen-size change; persisted to disk, sent one request per chunk with retries; an empty chunk is not sent.
- **Does Sentry drop frames in motion or capture faster?** Neither: iOS keeps 1 fps while scrolling, waits up to 1 s during 4 or more animations, backs off to 2 s when captures are slow; Android skips at most one frame drawn during the copy.
- **Why do 1 fps Sentry replays look acceptable?** Reasoning, not measured: most time is spent on still screens, and the player draws touches and breadcrumbs from their own timestamps.
- **Raise the rate on change?** No pixel recorder does today; Datadog iOS records structure up to every 100 ms. For pixels the cost is main-thread time per capture; worth an experiment within ouo's 100 ms/s budget.
- **Still frames, or only a field, button or spinner changing?** Solved by packing (no bytes, one tile, or skip blocks). Leave it.
- **When to send; bandwidth or compute?** Time, size, lifecycle and a disk queue. The phone's real cost is capture and masking on the main thread, not packing; the spike measures it.
