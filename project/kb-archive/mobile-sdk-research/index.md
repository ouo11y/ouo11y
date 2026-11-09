# Mobile SDK research: Sentry, PostHog, Luciq and the rest of the field

Started 2026-10-29. Question: how do the mobile RUM / session replay SDKs really work (grounded in their source code where it is open), what do they cost on the device and on the wire, which frameworks they cover, whether they export OpenTelemetry, and what ouo should copy or avoid for its own native SDKs (roadmap phases 10 and 14).

Written in a worktree cut before the `project/` layout move, so the sub sessions did not see three entries main already had: [sentry-ios-replay-internals.md](../sentry-ios-replay-internals.md) (sentry-cocoa 9.31.0 vs `sdk/ios`, measured on an iPhone), [sdk-overhead-ios.md](../sdk-overhead-ios.md) and [docs/benchmarks.md](../../../docs/benchmarks.md) (the B3 harness). Appendix A at 9.32.0 agrees with the internals entry on every shared point and adds the measured wire size, the redaction details, crash recovery, the blog grounding and the player; the comparison cross-references all three.

Every appendix follows the same structure so the comparison can be read side by side. Facts carry a source: a repo path with a commit, a doc URL, or "measured here". Claims that could not be grounded in code are marked `[docs only]` or `[blog only]`.

| File | What it covers |
|---|---|
| [comparison.md](comparison.md) | Side-by-side synthesis: capture technique per platform, replay flows, wire size, performance claims and how they were measured, OTel export, feature matrix, recommendations for ouo |
| [roadmap.md](roadmap.md) | Recommendation for ouo (2026-10-29): §12 ranked by value per cost into ten work packages W1–W10 with definitions of done, three parallel lanes, Datadog vs Sentry per part, the mobile SDK spec with twelve capabilities and an L0–L3 maturity ladder, what §12 missed (native crash symbolication, OOM, privacy manifest), what is still missing after W10, the five ADRs it needs |
| [sentry-ios.md](sentry-ios.md) | Appendix A: sentry-cocoa (Swift / Objective-C). RUM flows, replay pipeline (view renderer v1 vs v2 grounded in code), video encoding, masking, wire format, Sentry's player, benchmarks |
| [sentry-android.md](sentry-android.md) | Appendix B: sentry-java / sentry-android (Kotlin / Java). RUM flows, replay pipeline, "faster startup" blog grounded in commits, benchmarks |
| [sentry-react-native-flutter.md](sentry-react-native-flutter.md) | Appendix C: sentry-react-native and sentry-dart. How replay and RUM are layered on the native SDKs, what differs per framework |
| [posthog-ios-android.md](posthog-ios-android.md) | Appendix D: posthog-ios and posthog-android. Wireframe vs screenshot replay, rrweb-compatible snapshot format, the server-side mobile transformer, autocapture |
| [posthog-react-native-flutter.md](posthog-react-native-flutter.md) | Appendix E: posthog-react-native and posthog-flutter. How replay is done per framework and where it diverges from native |
| [luciq.md](luciq.md) | Appendix F: Luciq (formerly Instabug). Closed native SDKs studied through docs and the open wrappers for React Native and Flutter; performance footprint claims and their method |
| [landscape-open-source.md](landscape-open-source.md) | Appendix G: other vendors with open SDKs (Embrace, Datadog, OpenReplay, Microsoft Clarity, opentelemetry-android / -swift): technique and OTel export, grounded in code |
| [landscape-closed.md](landscape-closed.md) | Appendix H: closed vendors (UXCam, Smartlook, FullStory, LogRocket, Amplitude, Mixpanel, Firebase, Bugsnag, New Relic, Dynatrace): technique and features from docs |

HTML report with the matrices, pipelines and the wire-size chart: [project/agents/mobile-sdk-research/reports/mobile-sdk-research.html](../../agents/mobile-sdk-research/reports/mobile-sdk-research.html).

Roadmap recommendation with the lane chart, the value-against-cost view and the maturity matrices: [project/agents/mobile-sdk-research/reports/mobile-sdk-roadmap.html](../../agents/mobile-sdk-research/reports/mobile-sdk-roadmap.html).

## Appendix structure (all files)

1. **Sources**: repos with the exact commit / tag studied, docs and blog URLs, which parts are open source and which are binaries.
2. **Platforms and languages**: table for native iOS (Swift, Objective-C), native Android (Kotlin, Java), React Native (JS/TS), Flutter (Dart), others; minimum OS versions; which SDK does the work for each.
3. **RUM**: what is captured (sessions and release health, crashes, ANR / hangs, app start, slow and frozen frames, screen loads and navigation, network, user interactions, custom spans) and the exact flow of each with code references.
4. **Session replay**: exact capture flow (trigger and cadence, screenshot vs view-hierarchy serialisation, masking, de-duplication, encoding, segmenting, upload), the wire format, how the server and player reconstruct it, sampling modes, configuration knobs, and whether the technique changes between native, React Native and Flutter.
5. **Transport and OpenTelemetry**: endpoint, envelope / batch format, compression, offline cache, retries; whether anything is OTLP or bridges to OTel.
6. **Other features**: user interaction timeline, replay linked to issues, funnels and journeys, in-app bug reporting and feedback, feature flags, surveys, profiling.
7. **Performance footprint**: vendor numbers, how they measured them (benchmark code, tools), and estimates derived from the code (bytes per frame or segment, timers, threads).
8. **Blog-to-code grounding**: for each blog claim, the commit or file that implements it.
9. **Questions asked and answers**, each with a code reference.
10. **Takeaways for ouo**.
