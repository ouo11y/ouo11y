# Sentry mobile SDKs: internals, configuration, reliability, wire

How Sentry's iOS (sentry-cocoa), Android (sentry-java / sentry-android) and React Native (@sentry/react-native) SDKs work inside, how they are configured, what they keep on disk, and what they put on the wire. Step 6 (vendor research), researched 2026-11-10.

Versions: sentry-cocoa 9.33.0, sentry-java 8.63.0, @sentry/react-native 8.34.0 (bundles cocoa 9.33.0 and android 8.62.0). Feature-level yes/no is Step 4's [sentry-mobile.md](../../../client-sdk-features/vendors/sentry-mobile.md); the normative envelope format is in [wire-format/](../wire-format/index.md). Start with the explainer.

| Path | What it is |
|---|---|
| [mobile-sdks-explainer.html](mobile-sdks-explainer.html) | How does data leave the phone? Diagrams: RN JS ↔ native, crash → disk → next launch, replay segment pipeline, observed bytes |
| [wire-capture.md](wire-capture.md) | What do iOS and Android actually send, request by request, and where do they differ? (observed) |
| [replay-mobile.md](replay-mobile.md) | What is a mobile replay segment, how many bytes per minute, and what do default masking and the rrweb side events look like? (observed + source) |
| [ios/architecture.md](ios/architecture.md) | How is sentry-cocoa built: start, integrations, queues, transport, SentryCrash, MetricKit, watchdog terminations, app hangs, sessions, tracing, replay internals, footprint? |
| [ios/configuration.md](ios/configuration.md) | Which options does sentry-cocoa have, with default, effect and source line, and how does sampling work? |
| [ios/reliability.md](ios/reliability.md) | What does sentry-cocoa keep on disk, when does it retry or drop, and how are crashes and replays recovered at the next launch? |
| [android/architecture.md](android/architecture.md) | How is sentry-android built: init paths, scopes, integrations, transport, JVM/NDK crashes, ANR v1/v2, sessions, tracing, replay internals, footprint? |
| [android/configuration.md](android/configuration.md) | Which `SentryOptions`, `SentryAndroidOptions`, replay and feedback options and manifest meta-data keys exist, with defaults and sources? |
| [android/reliability.md](android/reliability.md) | What does sentry-android keep on disk, how do retry, rate limits and backpressure work, and how is a crashed replay finished? |
| [react-native/architecture.md](react-native/architecture.md) | What does the JS layer do and what does native do, how do envelopes cross the bridge, and which SDK name ends up on which envelope? |
| [react-native/configuration.md](react-native/configuration.md) | Which RN options exist, which reach native and how, and where do RN and native defaults differ? |
| [react-native/reliability.md](react-native/reliability.md) | Where does JS data wait, what happens to JS fatals, rate limits and client reports, and what is lost early? |
| [fixtures/](fixtures/index.md) | Which real captured requests (redacted) back these entries, per platform? |

Demo used for the captures: `examples/sentry-mobile` (Android build, `SENTRY_CAPTURE_ALL`, `SENTRY_REPLAY_MASK`, `scripts/extract.py`, `scripts/mp4info.py`, `scripts/android-journey.py`, `scripts/replay-journey.sh` were added for this research; see its README).
