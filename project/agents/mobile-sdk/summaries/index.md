# mobile-sdk summaries

One dated summary per run.

- [2026-10-29-adr-0014-0016.md](2026-10-29-adr-0014-0016.md) ADR-0014 (tiles in `frames` schema 2) and ADR-0016 (OpenTelemetry in process)
- [2026-10-29-w1-ios-capture.md](2026-10-29-w1-ios-capture.md) W1 production-safe iOS capture: run-loop pacer, 1:1 render, fail-closed masking, modes, spool, N52
- [2026-10-29-w2-mobile-spec.md](2026-10-29-w2-mobile-spec.md) W2: the mobile SDK spec, ADR-0015 and the React Native iOS conformance suite
- [2026-10-29-w7-symbolication.md](2026-10-29-w7-symbolication.md) W7: native iOS crash symbolication from dSYMs (ADR-0011 section 7)
- [2026-10-30-w3b-delivery.md](2026-10-30-w3b-delivery.md) W3 delivery: gzip OTLP and write-first outbox (RN), durable chunk queue (iOS), next-launch keep/drop
- [2026-10-30-w3a-schema2-player.md](2026-10-30-w3a-schema2-player.md) W3a step 1: `frames` schema 2 in rum-api and the collector, the canvas frame player, the spec rewritten
- [2026-10-30-w5-funnels.md](2026-10-30-w5-funnels.md) W5: readable user steps (view type, gesture, screen, labels kill switch), screen navigation kind, C6.1 required, mobile funnels quickstart M6
- [2026-10-30-w6-feedback.md](2026-10-30-w6-feedback.md) W6: the feedback primitive (SDK, Sentry bridge, plugin), the shared last-events buffer, C10.1 required
- [2026-10-30-w3a-swift-tiles.md](2026-10-30-w3a-swift-tiles.md) W3a step 2: tiles in `sdk/ios` (TileDiffer, full or patch frames, 1 MiB chunks); B3 T3 120 and T4 334 KiB/min, static screen zero bytes
- [2026-10-30-w4-signals.md](2026-10-30-w4-signals.md) W4: app hangs, foreground terminations, TTFD and error context; C3.1, C3.2, C4.2 required
- [2026-10-31-w8-native-ios-part1.md](2026-10-31-w8-native-ios-part1.md) W8 part 1: the native iOS SDK `OuoSDK` (sessions, OTLP export and outbox, lifecycle, URLSession, crash, vitals and replay wired, `@objc` API, privacy manifest)
- [2026-10-31-fix-ingest-stub-flake.md](2026-10-31-fix-ingest-stub-flake.md) Fix of the ingest-stub CI flake: `_uninstall` awaits the outbox drain (bounded 2 s), PR #124
- [2026-10-31-w8-native-ios-part2.md](2026-10-31-w8-native-ios-part2.md) W8 part 2: UIKit screens and taps, SwiftUI masking, feedback, the crash-time context, the native example, its suite and B3 cells
- [2026-10-31-n77-diskqueue-clock.md](2026-10-31-n77-diskqueue-clock.md) N77: iOS disk queues keep no age (bounds only) and keep `put` order when the clock moves; tests move the clock
- [2026-10-31-n76-feedback-frame.md](2026-10-31-n76-feedback-frame.md) N76: `FrameReason.feedback` on iOS, native C10.1 asks for the frame within 2 s, the plugin says "screenshot" and seeks to it
- [2026-10-31-w9-android-part1.md](2026-10-31-w9-android-part1.md) W9 part 1: React Native Android: `sdk/android` replay capture, the Expo module Android side (replay, gzip delivery, vitals), the emulator suite `tests/e2e/mobile-android`, CI job `android`
- [2026-11-01-n55-n83-delivery-retries.md](2026-11-01-n55-n83-delivery-retries.md) N55 and N83: C11 retries only 429 and 502–504 (new check C11.3 in both suites), the React Native outbox keeps no age
- [2026-11-01-w9-android-part2.md](2026-11-01-w9-android-part2.md) W9 part 2: native signals in `sdk/android` (crashes, hangs, `ApplicationExitInfo` terminations, `FrameMetrics`, cold start), ADR-0017, React Native Android at L2 on C1–C11 including C11.3
