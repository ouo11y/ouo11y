# replay-school

An animated course on how session replay works inside, in 25 lessons: fundamentals first, then the six topics every recorder answers, then one lesson per vendor and platform, then the six-step model and what ouo would borrow. Open [index.html](index.html) in a browser; no network needed. Light and dark, readable at 375 px, respects reduced motion. Each lesson ends with a short quiz.

Built from the [session replay explainer](../session-replay-explainer.html), the [kb entries](../index.md) beside it and Step 6 [vendor internals](../../vendor-internals/index.md). Demos and step-through flows are reused from the explainer; every technique step links its source at a pinned tag. Compression mechanisms in lesson 5 come from the standards (RFC 1950–1952, RFC 4648, ITU-T H.264) and are marked as not read in code.

| File | Content |
|---|---|
| [index.html](index.html) | Contents page and entry point |
| [f1-pixels-vs-structure.html](f1-pixels-vs-structure.html) | Fundamentals 1: reading a screen versus looking at it |
| [f2-event-loop-and-frames.html](f2-event-loop-and-frames.html) | Fundamentals 2: DOM, event loop, MutationObserver, frames |
| [f3-view-trees.html](f3-view-trees.html) | Fundamentals 3: view trees on UIKit, SwiftUI, Views, Compose, React Native, Flutter |
| [f4-keyframes-and-deltas.html](f4-keyframes-and-deltas.html) | Fundamentals 4: keyframes, deltas, checkouts, seeking |
| [f5-compression.html](f5-compression.html) | Fundamentals 5: deflate, base64, tiles, H.264 I/P-frames and skip blocks (live frame-diff demo) |
| [f6-masking-data-vs-geometry.html](f6-masking-data-vs-geometry.html) | Fundamentals 6: masking as a data transform versus as geometry |
| [t1-hooks.html](t1-hooks.html) | Topic: when to look; five strategies on one session |
| [t2-what-to-record.html](t2-what-to-record.html) | Topic: the four capture families on one screen |
| [t3-masking-race.html](t3-masking-race.html) | Topic: the masking race and four defences |
| [t4-packing.html](t4-packing.html) | Topic: bytes per technique; ouo tiles versus Sentry video |
| [t5-sending.html](t5-sending.html) | Topic: flush triggers, `ouo.replay.chunk` today and in the draft spec, open choices |
| [t6-playing.html](t6-playing.html) | Topic: the rrweb player; one player per format |
| [w1-rrweb.html](w1-rrweb.html) | Technique: rrweb record |
| [w2-sentry-web.html](w2-sentry-web.html) | Technique: Sentry on the web |
| [w3-posthog-web.html](w3-posthog-web.html) | Technique: PostHog on the web |
| [w4-datadog-web.html](w4-datadog-web.html) | Technique: Datadog on the web |
| [w5-openreplay-highlight-clarity.html](w5-openreplay-highlight-clarity.html) | Technique: OpenReplay, Highlight, Clarity; browser recorders side by side |
| [m1-sentry-ios.html](m1-sentry-ios.html) | Technique: Sentry iOS |
| [m2-sentry-android.html](m2-sentry-android.html) | Technique: Sentry Android |
| [m3-posthog-mobile.html](m3-posthog-mobile.html) | Technique: PostHog iOS and Android |
| [m4-datadog-mobile.html](m4-datadog-mobile.html) | Technique: Datadog iOS and Android |
| [m5-openreplay-mobile.html](m5-openreplay-mobile.html) | Technique: OpenReplay iOS and Android |
| [m6-react-native.html](m6-react-native.html) | Technique: React Native |
| [m7-flutter.html](m7-flutter.html) | Technique: Flutter; mobile recorders side by side |
| [z1-six-steps.html](z1-six-steps.html) | Finale: six steps, borrow map, licences, order; ADR-0018 (proposed) |
| [school.css](school.css) | Shared styles and colour tokens (same tokens as the explainer) |
| [school.js](school.js) | Shared script: lesson list, theme, progress, quizzes, step-through flows |

## Editing

Pages are plain HTML; edit them directly. The lesson order lives in `RS.PAGES` in `school.js` (drives the progress bar and lesson numbers); prev/next links are written in each page, so a new lesson needs its neighbours' links updated and a row on `index.html` and here. A future iOS port or masking experiment result belongs in a new lesson after the topic it informs.
