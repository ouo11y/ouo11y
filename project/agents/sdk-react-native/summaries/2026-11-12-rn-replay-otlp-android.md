# RN replay over OTLP on an Android emulator (2026-11-12)

The `pixel/frames` replay of `claude/rn-replay-otlp` was run end to end on an Android emulator for the first time: Release build of `examples/ouo-mobile` (`--conformance`, every mask default on), journey, fake Collector. Report and evidence: [reports/rn-replay-otlp-android](../reports/rn-replay-otlp-android/index.md).

## What was done

- Ran the journey four times (no backend; stub backend plus a session rotation; 503 with Retry-After; 400). Every section-11 rule the fake Collector checks passed. The one `sequence` failure in the 400 run is the expected drop.
- Found no defect in the Kotlin, the Expo module or the replay JS. No SDK code changed.
- Added `examples/ouo-mobile/scripts/journey-android.sh`, the Android journey, with commands sent as broadcasts and typing done with `adb shell input`.
- Extended `scripts/fake-collector.mjs`, with unit tests: the report lists telemetry `session.id` values, and it tracks each faulted replay request until its retry arrives (`same_bytes` / `different_bytes`).

## How it was verified

- On the emulator: four collector verdicts, decoded frames read by eye, `adb logcat -b crash`, and `dumpsys activity processes`.
- `sdk/android`: `./gradlew :replay-core:test :signals-core:test` passes (51 + 8 tests, including the golden request hex test). `sdk/react-native`: `npx vitest run` 318 tests pass, and `npx tsc --noEmit` is clean. `node --test scripts/fake-collector.test.mjs` passes (6 tests).

## What the next agent must know

- `session.backgroundTimeoutMs: 5000` in the conformance build is clamped to 60 s (`MIN_TIMEOUT_MS` in `sdk/react-native/src/config.ts`). The README and `src/rum.ts` say 5 s. A session ends in the background only after 60 s. This is not a replay defect; it was left for the session lifecycle owner.
- The soft keyboard is its own window and is not in the frames. Typing into a masked field makes no pixel change, so it adds no patch.
- Not verified: the exact Retry-After wait, buffer mode, web views, `pixel/video` and `structure/wireframe` (not in this build).
