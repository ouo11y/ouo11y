# ADR-0017 Android signals: ouo detectors in `sdk/android`, opentelemetry-android as the native package's pipeline

Status: proposed (2026-11-01, W9 part 2); refines [ADR-0016](0016-opentelemetry-in-process.md) for the React Native Android module.

## Context

ADR-0016 decided that Android builds on opentelemetry-android, and that "the native package and the React Native Android module use its agent for sessions, crash, ANR, jank, OTLP/HTTP and disk buffering". W9 part 2 started with the React Native module and read opentelemetry-android 1.8.0 (`core`, `session`, `instrumentation/crash`, `anr`, `slowrendering`, `startup`) against what the module needs:

- **Sessions, export and disk buffering are already owned by the JavaScript half** of `@ouo11y/react-native`: the session manager of [session-lifecycle.md](../specs/session-lifecycle.md) (persisted, background timeout, rotation, `session.previous_id`) and the OTLP outbox of C11, the same code as on iOS. A second OpenTelemetry SDK in the process would make a second session id and a second exporter for the same app.
- **Its detectors do not meet the spec.** Its ANR instrumentation reports a 5 s block at detection; C3.1 asks for a 2 s hang reported once when it is over, with its duration. It has no foreground-termination instrumentation (C3.2). Its crash instrumentation emits a log record through its own logger, while the JavaScript reads a report file at the next launch, the contract the iOS module already serves. Its slow-rendering instrumentation sends periodic spans, not the cumulative counters `app.jank` is computed from.
- What would be reused is two techniques (an uncaught exception handler, a `FrameMetrics` listener), about a hundred lines, at the cost of the OpenTelemetry Java SDK in every React Native app.

## Decision

1. **The native signals are ouo's own detectors in `sdk/android`**: `signals-core` (plain Kotlin, the rules, tested on the JVM: the report format, the hang rules, the termination decision, frame counting, the app start) and `signals` (the Android wiring: the uncaught exception handler chained to the one before, a main-thread watchdog, `ApplicationExitInfo` at the next launch, `FrameMetrics` per window, `ApplicationStartInfo`). They write the report format of `project/kb/ios-native-crashes.md`, with a `jvm` mechanism and JVM frames, so the JavaScript, rum-api and the plugin treat both platforms alike.
2. **The React Native Android module does not embed opentelemetry-android.** It wires the detectors to the JavaScript (`installCrashReporter`, `takePendingCrash`, `onHang`, `getFrameStats`, `getAppStartInfo`), as the iOS module wires `OuoCrash` and `OuoVitals`.
3. **ADR-0016 stands for the native Android package**: there opentelemetry-android is the pipeline (OpenTelemetryRum, its session provider configured to the spec's rules, OTLP/HTTP, disk buffering, network instrumentation), and the ouo detectors are registered with it as instrumentations that emit the spec's records. The detectors therefore take no dependency on the React Native module or on an OpenTelemetry SDK.

## Consequences

- The React Native Android module adds no third-party dependency; its records come from the same JavaScript as on iOS, so the conformance checks are the iOS checks.
- ouo owns the Android hang and termination rules, as it owns them on iOS; they are written down in [mobile-sdk.md](../specs/mobile-sdk.md) C3 and tested in `signals-core`.
- The native package (a later part of W9) still saves what ADR-0016 counted on: sessions, export, disk buffering and network instrumentation come from opentelemetry-android; only the signals that must follow the spec are ouo's.
- A version bump of opentelemetry-android touches only the native package.
