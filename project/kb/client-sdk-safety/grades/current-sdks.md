# How the current SDKs score against the golden rule

Graded 2026-11-10 against `origin/main` at 3e9e2c11, by category of the [checklist](../checklist/golden-rule-checklist.md). **P** pass, **Pa** partial, **F** fail, **n/a** not applicable, **?** not measured. Each verdict cites the lines read. Verdicts marked *(sampled)* rest on a search hit, not a full read of the file; Step 7 confirms them when it writes the tests.

No SDK has the automated tests the checklist asks for, except the web fault e2e (`OUO-11`). So "P" below means the code does the right thing on reading, not that CI proves it.

## Summary

| Category | Web | RN | iOS | Android |
|---|---|---|---|---|
| 1 Crashes and exceptions | Pa | Pa | P | **F** |
| 2 Main thread and ANR | Pa | Pa | P | P |
| 3 CPU | Pa | ? | P | P |
| 4 Memory | P | P | P | P |
| 5 Battery | ? | ? | Pa | Pa |
| 6 Network | P | Pa | P | P |
| 7 Storage | P | P | P | P |
| 8 Startup | P | ? | ? | ? |
| 9 Handlers | P | **F** | P | P |
| 10 Headers and globals | **F** | **F** | P | n/a |
| 11 Privacy | Pa | **F** | Pa | Pa |
| 12 Offline | P | P | P | P |
| 13 Kill switch | **F** | **F** | **F** | **F** |
| 14 Bad config | **F** | **F** | Pa | **F** |
| 15 Upgrades | Pa | Pa | Pa | Pa |

The four fails that can hurt a user today, in order:

1. **Android crash on bad `jpegQuality`** (GR-CRASH-3, GR-CFG-1). Only a native Android app can trigger it today: RN does not pass `jpegQuality` to native (`sdk/react-native/src/replay.ts:265-277`).
2. **Web and RN overwrite an app-set `traceparent`** (GR-HDR-1).
3. **RN logs 8 characters of the token** (GR-PRIV-1).
4. **RN drops another SDK's rejection tracker** (GR-HAND-1).

No SDK has a kill switch or self-disable (GR-KILL-1, -2): a bug that ships cannot be turned off without an app release.

## Web (`sdk/browser`)

| Cat | V | Evidence |
|---|---|---|
| 1 | Pa | Public API runs in `attempt()` (`sdk/browser/src/index.ts:369-407`); install is in try/cleanup (`index.ts:98-103`); `guard()`/`attempt()` at `sdk/browser/src/guard.ts:33`, `43`. But `initRUM` **throws** on a missing id or token by design (`index.ts:86-93`, via `deriveIngestUrls`), which breaks GR-CRASH-1 and GR-CFG-2 |
| 2 | Pa | IndexedDB is async with a 3 s open timeout (`sdk/browser/src/transport/store.ts:101-103`); `keepalive` caps on page hide (`sdk/browser/src/transport/keepalive.ts:7-8`, `15`). `localStorage` session reads are synchronous though small (`sdk/browser/src/session/storage.ts:25-36`). The rrweb full snapshot runs on the main thread in one go (`project/kb-archive/browser-sdk-safety.md:125`; OUO-9) |
| 3 | Pa | rrweb checkout interval set (`sdk/browser/src/replay/recorder.ts:380`); no mousemove/scroll sampling option *(sampled)*; no replay self-budget (GR-CPU-2) |
| 4 | P | Store bounded by bytes (`store.ts:59-65`, `138-157`); 1 h soak (`project/kb-archive/browser-sdk-safety.md:91-99`) |
| 5 | ? | Timers are guarded; hidden-tab timer behaviour not measured |
| 6 | P | 5 attempts, 30 s max delay, `Retry-After` capped at 60 s, 24 h max age, 30 s timeout (`sdk/browser/src/transport/delivery.ts:132-137`); jitter (`sdk/browser/src/transport/retry.ts:36-37`) |
| 7 | P | `QuotaExceededError` keeps the entry in memory (`store.ts:224`, `264-265`); byte cap (`store.ts:143`) |
| 8 | P | rrweb is a lazy `import()` (`recorder.ts:72`); SSR returns a no-op (`index.ts:94-95`) |
| 9 | P | `addEventListener` only, never assigns `window.onerror` (`sdk/browser/src/errors/install.ts:23`, `62-63`) |
| 10 | **F** | OTel fetch/XHR instrumentation with `propagateTraceHeaderCorsUrls` overwrites an app-set `traceparent` (`sdk/browser/src/network.ts:46`, `64`; OUO-4). Patch hygiene and re-init are otherwise good (`project/kb-archive/browser-sdk-safety.md:20`, `27-34`) |
| 11 | Pa | Token travels as a Basic auth header, not in the URL (75b1484e). Query-string scrubbing of `url.full` not checked |
| 12 | P | IndexedDB offline store (e7c92c8a) |
| 13 | **F** | Only a `guardedFailures()` counter (`guard.ts:19`); nothing disables the SDK after it, and no remote switch |
| 14 | **F** | Missing creds throw (`index.ts:86-93`); clamping of `sampleRate` not verified (`sdk/browser/src/session/manager.ts:238`) |
| 15 | Pa | IndexedDB `onversionchange` closes (`store.ts:124`); no schema version on the session record |

## React Native (`sdk/react-native`)

| Cat | V | Evidence |
|---|---|---|
| 1 | Pa | `onUnhandledRejection` callback wrapped (`sdk/react-native/src/errors/install.ts:142-146`); storage goes through `safeStorage`. Config errors throw *(sampled, `sdk/react-native/src/index.ts` near line 99)* |
| 2 | Pa | AsyncStorage outbox is async (`sdk/react-native/src/transport/outbox.ts:57`); JS-thread cost not measured |
| 3 | ? | JS side not measured; native replay pacing as iOS/Android |
| 4 | P | Outbox 5 MB / 500 entries, oldest dropped (`outbox.ts:7-8`, `225`) |
| 5 | ? | Backoff capped at 30 s (`outbox.ts:10`, `187`); not measured |
| 6 | Pa | Backoff with `Retry-After` (`outbox.ts:187`); no request timeout found in `send.ts` *(sampled)* |
| 7 | P | Bounded (`outbox.ts:225`); storage errors caught |
| 8 | ? | Not measured |
| 9 | **F** | `ErrorUtils` handler is chained and restored (`errors/install.ts:73`, `78`, `106-108`), but the Hermes rejection tracker replaces any earlier one (`errors/install.ts:151-160`; OUO-5). It warns only when Sentry is detected |
| 10 | **F** | `headerBag` overwrites by lowercase name, so fetch replaces an app-set `traceparent` (`sdk/react-native/src/network.ts:43-47`, `155-160`; OUO-3). XHR already skips it (`network.ts:283`) |
| 11 | **F** | Debug log prints `projectToken.slice(0, 8)` (`sdk/react-native/src/replay.ts:300`; OUO-2) |
| 12 | P | AsyncStorage outbox (`outbox.ts:57-60`) |
| 13 | **F** | None (`sdk/react-native/src/types.ts:226` is a content switch, not a kill switch) |
| 14 | **F** | Missing creds throw (spec CFG-1 says no-op). RN sends no `jpegQuality` to native (`replay.ts:265-277`), so OUO-1 is not reachable from RN |
| 15 | Pa | No outbox format version *(sampled)* |

## iOS (`sdk/ios`)

| Cat | V | Evidence |
|---|---|---|
| 1 | P | `Ouo.start` returns false on bad config, in an extension, or on a second call, never throws (`sdk/ios/Sources/OuoSDK/Ouo.swift:48-66`); no `fatalError` / `try!` in Sources outside the probe *(grep)* |
| 2 | P | Only the minimal snapshot half runs on main (`sdk/ios/Sources/OuoReplay/ScreenCapturer.swift:5`, `82`; OUO-10) |
| 3 | P | `CapturePacer` and `TileDiffer` in `OuoReplayCore` |
| 4 | P | Pending logs 2048, spans 1024 (`sdk/ios/Sources/OuoSDK/Exporter.swift:17-18`, `75`, `84`) |
| 5 | Pa | Utility-QoS timer queue (`Exporter.swift:31`); benchmark partial (953c6f2d) |
| 6 | P | Doubling backoff to 30 s; only 429/502/503/504 retried (`Exporter.swift:8-10`, `19`) |
| 7 | P | DiskQueue 5 MB / 500 entries (`Exporter.swift:19`; `DiskQueue.swift:33-42`) |
| 8 | ? | Not measured beyond app-start vitals |
| 9 | P | NSException handler chained (`sdk/ios/Sources/OuoCrash/OuoCrash.swift:29`, `226`); signals chain, `SIG_IGN`/`SIG_DFL` handled (`sdk/ios/Sources/OuoCrashCore/ouo_crash.c:34`, `436`, `454-470`) |
| 10 | P | `traceparent` set only when absent (`sdk/ios/Sources/OuoSDK/NetworkTracing.swift:25-26`). Origin allow-list not checked against GR-HDR-2 |
| 11 | Pa | Logs only problems; not audited with a canary token |
| 12 | P | DiskQueue persists across launches (`Exporter.swift:6-10`) |
| 13 | **F** | None |
| 14 | Pa | `config.problem` refuses start (`Ouo.swift:50-53`); `jpegQuality` unclamped (`OuoReplayConfig.swift:34`, `81` → `FrameComposer.swift:133`), but ImageIO tolerates it |
| 15 | Pa | Run state has `"version": 1` (`sdk/ios/Sources/OuoCrash/RunState.swift:111`); the outbox format has none *(sampled)* |

## Android (`sdk/android`: replay and signals; no HTTP instrumentation)

| Cat | V | Evidence |
|---|---|---|
| 1 | **F** | `compose.execute { … }` body is not wrapped (`sdk/android/replay/src/main/kotlin/dev/ouo/replay/ReplayRecorder.kt:315-318`) on the `ouo-replay-compose` thread (`ReplayRecorder.kt:348`); `Bitmap.compress` throws on a bad quality (`ScreenCapturer.kt:103`). Other paths use `runCatching` (`ReplayRecorder.kt:283`, `359`, `369`) |
| 2 | P | PixelCopy, then compose on a background thread (`ReplayRecorder.kt:298-318`, `348`) |
| 3 | P | `CapturePacer` budget and 0.1 s floor (`CapturePacer.kt:49`, `99-118`); `TileDiffer` caps (`TileDiffer.kt:15`, `55`, `62`) |
| 4 | P | 1 MB image cap per chunk (`ChunkBuilder.kt:24`) |
| 5 | Pa | Frame retries capped at 3 (`CapturePacer.kt:54`, `83`); not measured |
| 6 | P | 15 s timeouts (`Transport.kt:28-29`); backoff to 60 s with `Retry-After` (`DiskQueue.kt:42`, `224`) |
| 7 | P | 10 MB queue (`ChunkUploader.kt:26`); evicts above max (`DiskQueue.kt:160`); `noBackupFilesDir` (`OuoReplayConfig.kt:41`) |
| 8 | ? | `start` posts to main (`OuoReplay.kt:41-46`); not measured |
| 9 | P | Chains the previous default handler (`sdk/android/signals/src/main/kotlin/dev/ouo/signals/Signals.kt:117-123`) |
| 10 | n/a | No HTTP instrumentation yet; GR-HDR applies when it lands |
| 11 | Pa | Debug logger off by default (`ReplayRecorder.kt:372-378`); masking on by default (`OuoReplayConfig.kt:20-24`) |
| 12 | P | DiskQueue survives a kill (`DiskQueue.kt:11-12`) |
| 13 | **F** | None |
| 14 | **F** | `jpegQuality` documented as 0..100 but never checked (`OuoReplayConfig.kt:29-30`; OUO-1) |
| 15 | Pa | No queue format version found |
