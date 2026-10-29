# Mobile conformance suite: how the golden React Native iOS app runs without a simulator

Written 2026-10-29 for W2 ([spec](../../docs/specs/mobile-sdk.md), [ADR-0015](../../docs/adr/0015-mobile-sdk-spec-and-conformance.md)). The suite is `tests/e2e/mobile/` (`conformance.mjs`, `launch.cjs`, `standin.cjs`).

## How it is built

- **The SDK runs from its bundle**, `sdk/react-native/dist/index.js` (build first: `npm run -w sdk/react-native build`), under `node --require standin.cjs`. `standin.cjs` loads the playground's preload (react-native, AsyncStorage, ErrorUtils and Hermes stand-ins, a JSON file as AsyncStorage) and then hooks `expo-modules-core` so `requireNativeModule("OuoReplay")` returns a model of the Swift module.
- **One process is one app launch, one directory is one device.** The crash report file, the replay seq store and AsyncStorage live in the device directory, so a second process is the next launch. Five devices: main, crash, early crash, foreground kill, offline.
- **The OS is `globalThis.__ouoStandin`**: `crash()` writes an OuoCrash-format report ([ios-native-crashes.md](ios-native-crashes.md)) with the session id the SDK installed and calls `process.exit(0)`, so nothing is flushed, like a real signal; `terminate()` exits without a report; `blockMainThread()` only logs, because the native module has no hang detector yet (W4 adds the interface and the model).
- **Unique `service.name` per run** (`qa-rn-ios-<run id>`): the funnel check (C7.1) can then assert exact counts (step 3 = 1 session) on a shared env.

## Things that were not obvious

- **The OTLP exporters call `globalThis.fetch`, or `fetch.__original` when the SDK's network instrumentation has wrapped it** (`@opentelemetry/otlp-exporter-base` FetchTransport). A `fetch` wrapper installed in a preload, before `initRUM`, therefore sees every OTLP request: that is how the suite reads `content-encoding` (C11.2, today `identity`) and how it simulates the network being down (throws `TypeError("Network request failed")`, which the exporter treats as retryable).
- **N52 reproduces in Node.** A crash 200 ms after `initRUM` loses the crashed session's `session.start`: rum-api shows only the next launch's `exception` and `session.end` for it (C2.3). After 3 s the first batches are out and the session is complete (C2.2). So the fix needs either an immediate export of `session.start` or the start carried in the crash report.
- **rum-api's timeline keeps `session_previous_id` in `attrs`** (it is not a record field), which is what C1.1 reads on the second session's `session.start`.
- **A foreground kill today is `session.end` `terminated`, status `healthy`.** Nothing marks it as a crash; that is C3.2's gap.
- **Replay frames at a rotation**: native capture resumes on `didBecomeActive` before the JavaScript `AppState` event rotates the session, so the first frame after a long background lands in the old session's last chunk. The model reproduces it because its AppState listener is registered before the SDK's. On a device the order is the same (the notification reaches native code first); W1's "native owns the session id" item (roadmap §12, item 7) removes it. The checks do not assert the boundary frame.
- **Strict pending**: a pending check that passes fails the run. That forces the package that fixed it to delete `pending` in the same PR, so the CI-required set only grows.

## Timing

Locally against an ouo-env env: about 25 s of launches and 30–60 s until rum-api has everything (Tempo's search and rum-api's 60 s Tempo cache are the slowest, C5.1 and C9.1). The suite polls every 5 s up to `OUO_E2E_TIMEOUT` (180 s) and reads once more after 10 s so a late pending pass is not missed.
