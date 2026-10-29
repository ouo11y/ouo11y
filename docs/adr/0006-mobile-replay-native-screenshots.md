# ADR-0006 Mobile session replay: native screenshot capture, iOS first

Status: accepted (2026-10-08); revision 2 (2026-10-29, capture scheduling and fail-closed masking, mobile SDK roadmap W1) below

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

## Revision 2 (2026-10-29): production-safe capture

Context: on the founder's iPhone 16 Pro Max (N22) each capture held the main thread 44–45 ms against Sentry's 22 ms in the same trace (N51), ouo captured more often than Sentry (a 1 Hz timer plus up to 4 touch captures per second), and some frames were taken mid-transition. The research ([sentry-ios-replay-internals.md](../../project/kb/sentry-ios-replay-internals.md), [roadmap.md](../../project/kb/mobile-sdk-research/roadmap.md) W1) ranked the fixes.

Decision (normative text in `docs/specs/mobile-replay.md`, "Capture rules"):

- **No timer-driven and no touch-triggered captures.** A main run-loop observer after Core Animation's commit decides once per pass whether a frame is due; touches are recorded only. A 1 s keep-alive timer only wakes an idle run loop.
- **Render 1:1 at the screen's scale, downscale off the main thread**, the way Sentry's default renderer does, instead of letting `drawHierarchy` resample to the frame size on the main thread. `UIGraphicsImageRenderer` stays out (16-bit format, N6). One capture in flight.
- **When**: no capture during a view controller transition; animation deferral (4 or more layer animations wait up to 1 s, Sentry's rule); a 0.25 s settle after motion, because `drawHierarchy(afterScreenUpdates: false)` reads what the screen last showed; a time bank of 100 ms of main-thread capture work per second (Datadog's budget), which is also the backoff on slow devices, so there is no separate 150 ms rule.
- **Masking fails closed**: a frame whose masked view is moving is dropped; a subtree cut at the walk's depth limit is masked whole.
- **Modes**: `session`, `navigation` (one frame per screen, Luciq's low-end mode) and `auto`, which picks `navigation` below 3.5 GiB of RAM (the device tier).
- **Crash durability**: the open chunk is kept on disk and sent on the next launch; the crash report carries the session's start (N52).

Consequences: a tap's result can show up to 1 s later in the replay, as in Sentry; a screen with a masked view that never stops moving records no frames rather than an unmasked one; frames at 1x are downscaled on a background queue from a transient bitmap at the screen's scale (about 15 MB on a Pro Max, one at a time).

