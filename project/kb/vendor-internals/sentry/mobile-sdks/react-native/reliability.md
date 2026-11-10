# Sentry React Native SDK: reliability (buffering, crashes, offline, sessions)

@sentry/react-native 8.34.0 (tag, 2026-11-05), @sentry/core 10.78.0, sentry-cocoa 9.33.0, sentry-android 8.62.0. Research date 2026-11-10. Method: source read at the tag; docs accessed 2026-11-10.

Notes:
- sentry-java was read at **8.63.0** (local clone); RN pins 8.62.0. Java behaviour quoted from 8.63.0 is *uncertain* for 8.62.0.
- "Read" = seen in code. "Inferred" = derived from code, not run. Leads from the 8.30 iOS capture (`kb-archive/sentry-react-native-demo.md`) are marked "lead".
- Native disk cache, retry and rate-limit rules are owned by the native SDKs: [../ios/reliability.md](../ios/reliability.md), [../android/reliability.md](../android/reliability.md). Architecture: [architecture.md](architecture.md). Options: [configuration.md](configuration.md). Feature summary: [sentry-mobile.md](../../../../client-sdk-features/vendors/sentry-mobile.md).

## 1. Where JS data waits before it reaches native

| Stage | Size / timer | When full or failing | Source |
|---|---|---|---|
| @sentry/core client processing buffer (`_process`) | `transportOptions.bufferSize`, which RN sets to `maxQueueSize` (default 30; core default would be 64) | Records `queue_overflow` client outcome and drops the event | [core client.ts#L241](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/client.ts#L241), [L1545-L1563](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/client.ts#L1544-L1563), [sdk.tsx#L155-L160](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L155-L160) |
| `NativeTransport` PromiseBuffer | `maxQueueSize`, default 30 (`DEFAULT_BUFFER_SIZE`) | `add` rejects with the `SENTRY_BUFFER_FULL_ERROR` symbol; `ReactNativeClient.sendEnvelope` only logs `Error while sending event`. Inferred: no client report is recorded for this drop, since NativeTransport does not use `createTransport` | [transports/native.ts#L13](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/transports/native.ts#L13), [L26-L39](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/transports/native.ts#L26-L39), [promisebuffer.ts#L45-L58](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/utils/promisebuffer.ts#L45-L58), [client.ts#L177-L186](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L177-L186) |
| Log buffer | flush at 100 logs, ~800 KB, 5 s after the first log (core); RN adds a 5 s idle timer when `enableLogs` | Lost if the process dies before the timer (inferred) | [logs/internal.ts#L19](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/logs/internal.ts#L19), [core client.ts#L116-L165](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/client.ts#L116-L165), [client.ts#L90-L104](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L90-L104) |
| JS client-report outcomes | in memory until the next envelope | See section 6 | [client.ts#L165-L196](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L165-L196) |

The transport buffer only holds in-flight bridge calls. A slot is freed when `RNSentry.captureEnvelope` resolves, which native does right after handing the envelope to its hub ([RNSentry.mm#L638-L660](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentry.mm#L638-L660), [RNSentryModuleImpl.java#L647-L660](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryModuleImpl.java#L647-L660)). JS never waits for HTTP. Inferred: the 30-slot limit matters only for bursts.

### 1.1 When the native side is not ready

| Situation | What happens | Source |
|---|---|---|
| `enableNative: false`, or module missing at init | JS uses `makeFetchTransport` (direct HTTP from JS, @sentry/core `createTransport`, no disk cache) | [sdk.tsx#L149-L154](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L149-L154) |
| Native transport chosen but `NATIVE.enableNative` later false (e.g. no DSN, `closeNativeSdk`) | `sendEnvelope` logs `Event was skipped as native SDK is not enabled.` and resolves: envelope dropped | [wrapper.ts#L225-L229](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L225-L229), [L322-L328](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L322-L328) |
| Module object missing | throws `Native Client is not available`; envelope dropped | [wrapper.ts#L231-L233](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L231-L233) |
| Native SDK not started yet (JS init is fire-and-forget) | iOS hub returns silently when its client is nil ([SentryHub.m#L931-L953](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Sentry/SentryHub.m#L931-L953)). Android: inferred that the no-op scopes drop it. Whether a `captureEnvelope` can overtake `initNativeSdk` on the native module queue is *uncertain* | [client.ts#L259-L290](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L259-L290) |
| `autoInitializeNativeSdk: false` and nobody started native | Same as above: JS keeps sending to a native SDK that does not run. Inferred: all JS events are lost | [wrapper.ts#L307-L315](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L307-L315) |

There is no JS-side retry or JS-side persistence for envelopes on the native path (read: `NativeTransport` has no retry code).

## 2. JS fatal errors

Read in [reactnativeerrorhandlers.ts#L162-L263](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/reactnativeerrorhandlers.ts#L162-L263), [wrapper.ts#L243-L282](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L243-L282):

1. The global handler builds the event (`fatal`, `{handled: false, type: 'onerror'}`), calls `captureEvent`, then `client.flush(shutdownTimeout || 2000)` and only then calls RN's default handler. A second fatal during the flush is ignored (`handlingFatal`).
2. The flush waits for JS processing and for the `captureEnvelope` bridge call to resolve. It does not wait for HTTP.
3. `hardCrashed: true` is set because of the `onerror` + `handled: false` mechanism ([misc.ts#L11-L20](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/misc.ts#L11-L20)).
4. iOS release builds: `store` = synchronous disk write by the hub, with the session ended as `crashed` and **no** new session ([RNSentry.mm#L650-L657](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentry.mm#L650-L657), [SentryHub.m#L931-L941](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Sentry/SentryHub.m#L931-L941)). Debug builds use `capture` instead.
5. Android release builds (since 8.33.0): `storeHardCrashEnvelope` writes envelope + `crashed` session to the disk cache on the calling thread, clears the scope session and deletes the current-session file. If the store fails it queues instead. Debuggable apps and apps without a disk cache use `InternalSentrySdk.captureEnvelope(bytes, false)` ([RNSentryModuleImpl.java#L647-L735](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryModuleImpl.java#L647-L735)). The changelog says that before 8.33.0 the event was only queued on the transport thread and was lost when RN killed the process ([CHANGELOG.md#L53-L54](https://github.com/getsentry/sentry-react-native/blob/8.34.0/CHANGELOG.md#L53-L54)).
6. The stored envelope is sent by the native SDK later, normally at the next launch (inferred from "sent on the next launch" in the changelog and the iOS store path). The 8.30 iOS capture saw the fatal event sent before death (lead); the reason is *uncertain*.
7. Native duplicates of the same JS error are dropped: iOS `beforeSend` filters `Unhandled JS Exception` and `ExceptionsManager.reportException` ([RNSentryStart.m#L248-L263](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L248-L263)); Android ignores `JavascriptException` ([RNSentryStart.java#L355-L357](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryStart.java#L355-L357)).
8. In `__DEV__` the default handler (red box) runs immediately, without waiting for the flush ([L227-L232](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/reactnativeerrorhandlers.ts#L227-L232)).
9. If an on-error replay is linked, `captureReplay(isHardCrash=true)` is called from `afterSendEvent` ([mobilereplay.ts#L495-L506](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L495-L506)). Whether the replay upload completes before RN kills the process is *uncertain*; the 8.30 capture saw a crashed session's last replay segment sent after relaunch (lead, native crash case).

## 3. Offline behaviour

- Every JS envelope on the native path becomes a native envelope: `capture` goes through the native client and transport; the native SDK writes it to its disk cache before sending (iOS and Android both cache by default). So the native rules apply unchanged: cache size `maxCacheItems` (default 30, oldest rotated out), age limits, retry/backoff, send-all-cached at startup. See [../ios/reliability.md](../ios/reliability.md) and [../android/reliability.md](../android/reliability.md).
- RN only forwards `maxCacheItems` and (Android) `maxQueueSize` ([configuration.md](configuration.md)). There is no RN option for the cache directory.
- With `enableNative: false` (and in Expo Go) there is no offline cache: the JS fetch transport sends once ([sdk.tsx#L208-L211](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L208-L211) logs that offline caching is unavailable in Expo Go).
- Observed on 8.30 iOS (lead): with the endpoint unreachable, sentry-cocoa retried the first envelope with backoff, kept the rest on disk, and flushed everything when the endpoint answered again.

## 4. Rate limits

- On the native path, rate limits are handled only by the native transport (native parses `X-Sentry-Rate-Limits` / `Retry-After`).
- JS does not see HTTP responses: `NativeTransport.send` resolves to `{}` ([transports/native.ts#L35-L39](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/transports/native.ts#L35-L39)). It does not use `createTransport`, so the JS rate-limit check (`isRateLimited` → `ratelimit_backoff` outcome) and `updateRateLimits` never run ([transports/base.ts#L45-L46](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/transports/base.ts#L45-L46), [L95](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/transports/base.ts#L95)). Inferred: while rate-limited, JS still builds, serialises and bridges every envelope, and native drops it.
- With `enableNative: false`, the JS fetch transport uses `createTransport` and honours rate limits in JS.

## 5. `Sentry.flush()` and `Sentry.close()`

| Call | What it waits for | Source |
|---|---|---|
| `Sentry.flush()` | `client.flush()` without timeout: emits `flush` (drains log/metric buffers), waits for the client processing buffer, then `NativeTransport.flush` = drain of in-flight `captureEnvelope` bridge calls. It does **not** wait for native HTTP. The doc comment calls it "flush to disk", for use before OTA updates | [sdk.tsx#L380-L398](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L380-L398), [core client.ts#L448-L463](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/client.ts#L448-L463), [transports/native.ts#L49-L51](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/transports/native.ts#L49-L51) |
| `Sentry.close()` | JS flush, `enabled = false`, then `closeNativeSdk`: iOS `SentrySDK close`, Android `Sentry.close()` (native flush/shutdown per native `shutdownTimeout`) | [client.ts#L135-L146](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L135-L146), [RNSentry.mm#L830-L835](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentry.mm#L830-L835), [RNSentryModuleImpl.java#L1008-L1014](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/android/src/main/java/io/sentry/react/RNSentryModuleImpl.java#L1008-L1014) |

After `closeNativeSdk` resolves, `NATIVE.enableNative` is false, so later envelopes are skipped ([wrapper.ts#L729-L740](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L729-L740)).

## 6. Client reports: JS vs native

- JS outcomes (sampling, `beforeSend` drops, event processor drops, `queue_overflow` in the processing buffer, discarded spans) are kept in memory and **attached as a `client_report` item to the next outgoing envelope** ([client.ts#L165-L196](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L165-L196), [L308-L320](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts#L308-L320)).
- RN never sends a standalone JS client report: @sentry/core's `_flushOutcomes` exists but is only called by other SDK subclasses (read: no call in `ReactNativeClient`, no call in core `client.ts` besides the definition) ([core client.ts#L1583](https://github.com/getsentry/sentry-javascript/blob/10.78.0/packages/core/src/client.ts#L1583)). Inferred: outcomes recorded right before the app dies, with no later envelope, are lost.
- Native SDKs send their own client reports (`sendClientReports` default true is forwarded to both), covering native drops: rate limits, cache overflow, network errors, including for JS-originated envelopes.
- Observed on 8.30 iOS (lead): `client_report` with `discarded_events` reason `no_parent_span`.

## 7. Release health sessions

- Owned by native. No JS session integration is installed on iOS/Android ([default.ts#L64-L79](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/default.ts#L64-L79)). `enableAutoSessionTracking` and `sessionTrackingIntervalMillis` pass through to native (defaults true / 30000).
- iOS: RN posts `SentryHybridSdkDidBecomeActive` after native start so the session starts even though `didBecomeActive` fired before JS ([RNSentryStart.m#L331-L354](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentryStart.m#L331-L354)).
- JS errors update the native session only when their envelope reaches native: the native hub inspects the `event` item (level ≥ error) and appends a `session` item (errors+1, or `crashed` if any exception has `handled: false`) ([SentryHub.m#L1014-L1087](https://github.com/getsentry/sentry-cocoa/blob/9.33.0/Sources/Sentry/SentryHub.m#L1014-L1087), [InternalSentrySdk.java#L186-L201](https://github.com/getsentry/sentry-java/blob/8.63.0/sentry-android-core/src/main/java/io/sentry/android/core/InternalSentrySdk.java#L186-L201)).
- Consequences (inferred):
  - JS errors dropped in JS (`sampleRate`, `beforeSend`, `ignoreErrors`) do not count in session `errors`. RN does not call the native "dropped event" session APIs (grep found none).
  - A non-fatal JS error sent with `capture` and a `handled: false` mechanism (e.g. custom code) ends the session as `crashed` and starts a new one natively.
  - Unhandled promise rejections are sent with `handled: true` ([reactnativeerrorhandlers.ts#L114-L121](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/reactnativeerrorhandlers.ts#L114-L121)) and never mark a session crashed or `unhandled` (also observed on 8.30, lead).
  - The `captureNonTerminating` / `unhandled` session path in the native SDKs is not used by RN (grep found no call).

## 8. App background behaviour

| Item | Behaviour | Source |
|---|---|---|
| JS flush on background | None: no `AppState` listener in the client or transport (grep) | [client.ts](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/client.ts) |
| Open root spans | Cancelled on `background`; iOS schedules cancellation on `inactive` because the JS thread can be suspended before `background` arrives | [onSpanEndUtils.ts#L234-L305](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/tracing/onSpanEndUtils.ts#L234-L305) |
| Sessions | Native: ends after `sessionTrackingIntervalMillis` in background; observed on 8.30 iOS that `exited` is sent when the app returns to foreground (lead) | native |
| Replay | Native: last partial segment sent on background (lead); optional iOS `avoidForegroundResumeHang` restarts in buffer mode | [mobilereplay.ts#L291-L302](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/replay/mobilereplay.ts#L291-L302) |
| Logs | 5 s timers; if the OS suspends or kills the process first, buffered logs are lost (inferred) | section 1 |

## 9. What is lost when things fail early

| Case | Lost | Source |
|---|---|---|
| JS throws before `Sentry.init` runs | The error (ErrorUtils handler not installed yet) | [reactnativeerrorhandlers.ts#L149-L162](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/integrations/reactnativeerrorhandlers.ts#L149-L162) |
| Native crash before JS `Sentry.init` (bundle load, native module setup) without `sentry.options.json` native init | The crash, and its session | [Capture App Start Errors](https://docs.sentry.io/platforms/react-native/manual-setup/app-start-error-capture/), accessed 2026-11-10 |
| With `RNSentrySDK.start()` / `.init()` | Pre-JS crashes captured, with only the options-file values and native auto-detection (release/environment must match JS) | same docs; [RNSentrySDK.m#L24-L79](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/ios/RNSentrySDK.m#L24-L79) |
| Scope data set before `Sentry.init` | Not synced to native (patching happens in `init`) | [sdk.tsx#L94-L97](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/sdk.tsx#L94-L97) |
| Scope data set inside `withScope` (current scope) | Not synced to native; native crashes do not see it (inferred: only global and isolation scopes patched) | same |
| JS event between `Sentry.init` and native start | Possibly dropped (section 1.1, *uncertain*) | |
| Native-created events vs JS hooks | JS `beforeSend` never runs on them (functions are not forwarded) | [wrapper.ts#L187-L201](https://github.com/getsentry/sentry-react-native/blob/8.34.0/packages/core/src/js/wrapper.ts#L187-L201) |

## 10. Facts for a replay store reading from Sentry / an OTel collector in front of Sentry

Facts only; each is backed above.

1. All HTTP traffic from an RN app with native enabled is sent by the native SDK. `User-Agent` / `sentry_client` is the native name (`sentry.cocoa.react-native/<cocoa version>` or `sentry.java.android.react-native/<java version>`), even for JS events (architecture.md 4.4; lead for iOS).
2. Envelope header `sdk.name` is `sentry.javascript.react-native` for JS-built envelopes and the native name for native-built ones. `replay_event.sdk.name` is `sentry.javascript.react-native` on both platforms, even though native builds the replay (architecture.md 4.4).
3. JS error envelopes reach the server with a `session` item appended by native. Session updates therefore ride with the JS event envelope.
4. JS fatal errors in release builds are written to the native disk cache and typically arrive on the next launch. The ingest side sees them late, possibly together with the new session's `init`.
5. Native responses (status codes, `X-Sentry-Rate-Limits`, `Retry-After`) are consumed only by the native transport. A collector that returns 429 throttles native sending; JS keeps bridging envelopes that native then drops.
6. JS `client_report` outcomes only appear inside other envelopes; native client reports appear as their own envelopes.
7. The disk cache (default 30 envelopes) is the only offline buffer. When it rotates, the oldest envelopes are gone; replay segments compete with events for those slots (inferred: replay segments are envelopes too).
8. `contexts.replay.replay_id` on error events can point to a replay that is never uploaded (tagged before the native on-error sampling roll).
9. `trace.replay_id` in the DSC comes from a JS cache and can be stale after native rotates the replay (lead + source).
10. `Sentry.flush()` from JS does not guarantee delivery; it guarantees hand-off to native.
11. With `enableNative: false` or Expo Go, the JS fetch transport sends directly, with no offline cache, no native sessions and no replay.
