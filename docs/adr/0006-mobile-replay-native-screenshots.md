# ADR-0006 Mobile session replay: native screenshot capture, iOS first

Status: accepted (2026-10-08)

## Context

ADR-0003 left mobile without replay because rrweb serializes a DOM and native apps have none. The product needs mobile replay on iOS and Android. Two families exist: view-hierarchy serialization ("wireframe", PostHog Android) and screenshot capture with view-hierarchy masking (Sentry iOS and Android, PostHog iOS, OpenReplay iOS). Sentry's SDKs are MIT and document the screenshot approach in detail; Sentry's server is source-available (FSL), so only SDK-side ideas are reused.

## Decision

- **Screenshot-based capture in native code**, following Sentry's design: the native SDK captures the key window about once per second and on touches, redacts sensitive views by walking the native view hierarchy and painting opaque rectangles over them **before the frame leaves the device**, deduplicates unchanged frames, and uploads frames as chunks through the existing replay pipeline.
- **The native SDK is the product.** `sdk/ios` is a Swift package (`OuoReplay`) usable directly by native iOS apps. The React Native SDK consumes it through an Expo native module, exactly as Sentry's React Native SDK wraps `sentry-cocoa`. Android follows with the same contract (`sdk/android`, Kotlin) after iOS works.
- **iOS only in this phase.** The Expo module's Android side is a no-op stub that logs once.
- **One session, one replay** still holds (ADR-0003). A mobile replay is a sequence of frame chunks keyed by the same `session.id` the telemetry carries. rum-api stores frame chunks and rrweb chunks the same way; the chunk's `kind` tells the player which renderer to use. Contract in `docs/specs/mobile-replay.md`.
- **Masking defaults**: text inputs, text views, labels and React Native text components, images, web views, and any view whose accessibility identifier is `ouo-mask` are redacted. `ouo-unmask` opts a view out. Replay is off until the host enables it and can be paused at runtime.
- **Frames, not video, in this phase.** JPEG frames at half resolution, quality 0.5, stored as base64 inside gzip JSON chunks. Video encoding (what Sentry does) is a storage optimisation that can come later behind the same `kind` field.

## Consequences

- Building and running the iOS package requires Xcode. The package is split so the pure-Swift core (chunking, dedupe, redaction geometry, encoding) builds and tests on macOS with the Command Line Tools, and only the UIKit capture target needs the iOS SDK.
- The Expo app needs a development client (`npx expo prebuild` + `expo run:ios`) instead of Expo Go, because Expo Go cannot load custom native modules.
- Frame payloads are larger than rrweb: roughly 20 to 40 KB per frame at 1 fps when the screen changes, near zero when it does not. Sampling and `pause()` matter more than on web.
- rum-api raises the chunk limit for frame chunks and exposes a frames endpoint; the Grafana plugin gains a frame player.
