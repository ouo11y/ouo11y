# Mobile recorders

Explainer: [topic 5](../session-replay-explainer.html#t5). Citations: [native-source-notes.md](native-source-notes.md) and [cross-platform-source-notes.md](cross-platform-source-notes.md). Bytes and masking defaults: Step 6 [mobile-replay-evidence.md](../../vendor-internals/mobile-replay-evidence.md).

## The masking race

A picture recorder walks the view tree to find what to mask and copies the pixels, at two slightly different moments. A view that moves between them slips out from under its box. Answers in the code: drop the frame when a masked view moved (ouo), walk the tree after the copy (Sentry Android), read the presentation layer, which holds the animated position (Sentry iOS), or mask inside the framework's own frame (Flutter, where the same frame is rendered and walked). Nobody has measured the leak rate of any of them; a masking-experiment session is doing that.

## Per vendor

| Recorder | Hook | Record | Mask | Pack |
|---|---|---|---|---|
| Sentry iOS (9.33.0) | run-loop observer at order `CFIndex.max`, 1 fps; backs off to 2 s when a capture takes 150 ms or more; waits up to 1 s while 4 or more animations run | render the window | boxes from a layer walk, filled with the average colour of the area | H.264 MP4 per 5 s segment, 20–60 kbps, `MaxKeyFrameInterval = 6`, last frame repeated |
| Sentry Android (8.63.0) | `OnDrawListener` sets a flag, a 1 s loop captures; re-emits the last bitmap when nothing changed | PixelCopy (or a Canvas mode that turns text draws into rectangles) | tree walked in the PixelCopy callback, after the copy; skips at most one frame drawn during the copy | JPEG to disk, then decoded and encoded with MediaCodec into MP4 |
| PostHog iOS (3.94.3) / Android (android-v3.76.1) | run-loop observer at order 2,100,000 / draw listener, 1 s throttle, back-off up to 8 s | wireframes, or screenshots in screenshot mode | data transform in wireframes; boxes in screenshots | rrweb-shaped events, full snapshot per changed frame, hash dedup |
| Datadog iOS (3.21.0) / Android (3.16.0) | swizzled `CALayer` changes, at most every 100 ms / full snapshot every 3 s | wireframes from node recorders; SwiftUI through a private renderer key path | data transform per node recorder | Heckel diff of wireframes, images once by MD5 |
| OpenReplay iOS 1.0.26 / Android v1.1.17 | timer | screenshots | boxes | JPEG archives |
| React Native (all vendors) | the native SDK records; the JS package only configures it and adds RN view classes and privacy components | | | |
| Flutter (all vendors) | recorded in Dart, since the native SDK sees one `FlutterView` | Sentry: images, no dedup; PostHog: FNV hash dedup; Datadog: Dart wireframes | | |
