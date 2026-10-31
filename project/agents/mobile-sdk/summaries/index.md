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
