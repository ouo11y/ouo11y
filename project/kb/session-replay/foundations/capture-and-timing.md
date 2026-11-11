# Capture families and timing

Explainer: [topic 2](../session-replay-explainer.html#t2) and [topic 3](../session-replay-explainer.html#t3).

## Four capture families

| Family | What is recorded | Masking | Examples |
|---|---|---|---|
| Tree serialisation + diff | the UI tree with ids, then changes | a data transform: text replaced before it is written | rrweb and its forks on the web |
| Wireframes | a simplified tree of boxes, text and images | a data transform | Datadog iOS/Android, PostHog wireframe mode |
| Pictures | screenshots, as images, tiles or video | geometry: boxes painted onto a picture taken at a slightly different moment from the tree walk (the masking race) | Sentry mobile, PostHog screenshot mode, ouo frames, OpenReplay mobile |
| Draw commands | what the app drew (display lists, canvas calls) | a data transform at the draw call | Sentry Android canvas mode (text draws become rectangles) |

Nobody is pure: PostHog falls back to screenshots where a wireframe cannot describe a view; Datadog captures images inside wireframes; Sentry ships touches as rrweb JSON next to its video.

## Timing

- **Keyframes and deltas.** A keyframe can be played alone; deltas need the keyframe before them. Seeking costs "last keyframe + deltas since", so recorders take a new keyframe (a checkout) on a timer or a size threshold: Sentry web every 60 s in buffer mode, Highlight at 10 MB or 4 min, the draft spec at least every 5 min and on visibility change.
- **Change signals.** MutationObserver on the web; on mobile a run-loop observer (Sentry and PostHog iOS), a swizzled `CALayer` setter (Datadog iOS), `OnDrawListener` (Sentry Android), a fixed timer (Datadog Android full snapshot every 3 s), post-frame callbacks (Flutter).
- **Dedup.** Hash the picture or the wireframe and skip unchanged ones (PostHog FNV/hash, ouo tiles). Sentry does not dedup: Android re-emits the last bitmap, iOS repeats the last frame in the video.
- **Flush.** Time (Sentry web 5 s debounce, 5.5 s max; PostHog 2 s; Datadog 5 s; ouo 5 s), size (PostHog 0.9 MB, Datadog 60,000 B per segment, ouo 1 MiB), lifecycle (hide, background, unload) and error buffers (keep the last 30–60 s in memory, send only on an error).
