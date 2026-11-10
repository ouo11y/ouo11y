# The golden rule checklist: the app must not pay for the SDK's failures

Every ouo SDK (web, React Native, iOS, Android, later Flutter) is checked against this list. A release that fails any item is not shipped.

**The rule.** When the SDK fails (a bug, a bad config, a dead network, a full disk, a broken backend, a hostile page, an OS change), the host app MUST keep working exactly as it would without the SDK: no crash, no hang, no slowdown the user can feel, no changed request, no leaked secret, no lost handler. The SDK loses telemetry before the app loses anything.

**Reading the table.**

- *Motivated by* cites the [incident catalog](../incidents/catalog.md) (`INC-n` other vendors, `OUO-n` our own faults) or the [vendor guidance](../incidents/vendor-guidance.md) (`GUIDE-n`). The source URL is in that row.
- *Platforms*: W web, RN React Native, iOS, And Android, Fl Flutter. "all" means all five.
- *Automated test* is how CI proves it. Fault injection means a test build hook that makes the named SDK internal throw or stall; every SDK needs one (GR-CRASH-7).

## 1. Crashes and exceptions

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-CRASH-1 | A public API call (init, setUser, track, shutdown, every other method) MUST NOT throw, reject or crash, whatever its arguments. It returns or logs instead | INC-1, INC-2, GUIDE-1 | all | Fuzz every public method with null, wrong types, huge strings, NaN, called before init and after shutdown; the test app must stay alive and nothing reaches its error handler |
| GR-CRASH-2 | Every callback the SDK runs (observers, timers, listeners, native delegates, background threads, executors, workers) MUST catch everything it raises, including from third-party code it hosts (rrweb, OTel instrumentations) | OUO-1, OUO-8, OUO-11, INC-29 | all | Fault-inject a throw in each callback; assert no uncaught error, no process death, and an `ouo.sdk.internal_error` count |
| GR-CRASH-3 | A background thread the SDK owns MUST NOT let an exception reach the process's uncaught handler. On JVM, every `Runnable` body is wrapped; on Apple, no `try!`, `fatalError`, force unwrap or `preconditionFailure` outside tests | OUO-1, INC-15, INC-17 | iOS, And, RN, Fl | Lint rule (detekt / SwiftLint / grep) on SDK sources; fault-inject in each executor and assert the app's default handler is not called |
| GR-CRASH-4 | Async SDK work MUST NOT produce an unhandled promise rejection or unobserved task error in the host | OUO-7 | W, RN, Fl | Block the lazy chunk (CSP, offline, 404) and fault-inject each async path; assert no `unhandledrejection` reaches the page |
| GR-CRASH-5 | The SDK MUST NOT crash in the host's crash path: crash handlers are async-signal-safe and do no logging, locking or allocation that can deadlock | INC-11, GUIDE-4 | iOS, And (native), RN | Crash-test matrix (signal, NSException, JVM, JS) with debug logging on; the crash report is written and the process exits in under 2 s |
| GR-CRASH-6 | Optional feature code (replay, vitals, network) MUST be isolated: its failure disables that feature only | INC-8, OUO-7 | all | Fault-inject in replay; assert errors and spans still export and the app is alive |
| GR-CRASH-7 | Every SDK MUST ship a fault-injection hook (test builds only) and a fault e2e suite that runs these tests in CI | OUO-11 | all | CI job present and required; the suite covers every GR item marked "fault-inject" |

## 2. Main thread, hangs and ANR

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-MAIN-1 | The SDK MUST NOT do synchronous disk I/O, network I/O, database open, or lock wait on the UI thread, including at init | INC-13, INC-14, GUIDE-11, GUIDE-12 | all | Android StrictMode (`detectDiskReads/Writes/Network`, penaltyDeath) in the test app; iOS Main Thread Checker plus a hang probe; web long-task observer with a seeded slow IndexedDB |
| GR-MAIN-2 | The SDK MUST NOT run a single task on the UI thread that exceeds the budget in spec §13 (*proposed* 16 ms web, 8 ms mobile) | OUO-10, INC-10 | all | Trace the reference app; fail on any SDK-attributed long task or hang above budget |
| GR-MAIN-3 | The SDK MUST NOT block the UI thread waiting on a background thread (no `sync` dispatch to or from main, no join) | INC-11 | iOS, And, RN | Static check for `DispatchQueue.main.sync` / `runBlocking` on main; hang probe under a stalled exporter |
| GR-MAIN-4 | Large work (replay full snapshot, compression, serialisation) MUST run off the UI thread, or in slices that yield | OUO-9, OUO-10, INC-31 | all | 50k-node page / deep view tree; assert no long task above GR-MAIN-2's budget from the SDK |
| GR-MAIN-5 | Web MUST NOT use synchronous XHR, `unload` listeners, or work in `pagehide` beyond queueing a `sendBeacon`/`keepalive` | INC-40, GUIDE-14 | W | Grep for `open(..., false)` and `'unload'`; bfcache test in Chrome (page restored from bfcache with the SDK on) |

## 3. CPU

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-CPU-1 | High-frequency sources (mousemove, scroll, mutations, frames, sensors) MUST be sampled or throttled with a documented cap | INC-31, INC-9 | all | Synthetic storm (10k mutations/s, continuous scroll); SDK CPU stays within the spec §13 budget |
| GR-CPU-2 | Replay MUST measure its own cost and back off or stop when it exceeds its budget for a sustained period | INC-8 | all with replay | Force a mutation storm; assert replay degrades to a lower rate or stops and emits a drop count |
| GR-CPU-3 | The SDK MUST NOT run a busy loop or unbounded retry of a failing internal operation | INC-32 | all | Fault-inject a permanently failing operation; CPU of the SDK thread stays idle-level after 60 s |

## 4. Memory

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-MEM-1 | Every buffer, queue, cache and map MUST have a byte or count bound, and drop (counted) when full | INC-28, OUO-9 | all | Backend down for 1 h under load; heap growth of the SDK stays under its cap |
| GR-MEM-2 | Every listener, observer, timer and native callback registered MUST be removed on shutdown and on the feature's own stop | INC-30, OUO-6 | all | Soak: start/stop the SDK 100 times; listener and observer counts return to baseline (the web soak harness already does this) |
| GR-MEM-3 | The SDK MUST NOT keep references that stop the host from releasing views, documents, activities or iframes | INC-30, INC-32 | all | LeakCanary (Android), Instruments leaks (iOS), detached-DOM heap snapshot (web) in CI |

## 5. Battery

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-BAT-1 | When the app is in the background or the page is hidden, the SDK MUST stop periodic timers except one flush, and MUST NOT take wake locks or start background tasks of its own | INC-32, GUIDE-7 | all | Background the app for 10 min; count SDK timer fires and wakeups (Battery Historian / Energy log / hidden-tab timer count) |
| GR-BAT-2 | Network sends MUST be batched (spec §8.1), not one request per record | GUIDE-7 | all | Fake collector counts requests per minute against the batch interval |

## 6. Network

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-NET-1 | Every request MUST have a timeout, and retries MUST use capped exponential backoff with jitter and honour `Retry-After` | GUIDE-1, OUO-12 | all | Fake collector that hangs, returns 429/503 with `Retry-After`; assert timing and attempt counts |
| GR-NET-2 | A dead or slow collector MUST NOT slow the app: no request the app makes waits on an SDK request, and SDK sends do not share a connection limit the app needs | INC-41, INC-42 | all | Collector that holds connections open; app's own requests keep their latency within 5% |
| GR-NET-3 | A fleet of clients MUST NOT storm the backend: per-client attempt cap, and drop after max age | no public incident found; GUIDE-1 | all | Simulate 1,000 clients against a 503 collector; total request rate stays under the cap |
| GR-NET-4 | Payload size per request MUST be capped below the platform limit (64 KB for `keepalive` / `sendBeacon` on web) | OUO-12 | all | Oversized batch is split; no request above cap reaches the fake collector |
| GR-NET-5 | SDK requests MUST NOT be instrumented by the SDK itself (no recursion) | spec ERR-5 | all | Assert no span or breadcrumb for the collector URL |

## 7. Storage

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-STO-1 | Persisted SDK data MUST have a byte cap and evict oldest first | INC-37, INC-38 | all | Fill the queue past cap; assert size stays at cap and evictions are counted |
| GR-STO-2 | Storage errors (quota exceeded, `SecurityError`, private mode, disk full, corrupt file) MUST be caught and the SDK MUST fall back to memory | INC-37, INC-39 | all | Stub storage to throw each error; app sees nothing, telemetry continues in memory |
| GR-STO-3 | SDK storage MUST NOT use space the app needs: keys and files are namespaced, never cleared wholesale, excluded from backups | INC-37 | all | Assert namespaced keys; `localStorage.clear()` is never called; Android `noBackupFilesDir`, iOS `isExcludedFromBackup` |

## 8. Startup

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-START-1 | Init on the UI thread MUST stay within the spec §13 init budget; everything else is deferred | INC-10 | all | Cold-start trace of the reference app with and without the SDK; diff within budget |
| GR-START-2 | Heavy optional parts (replay, rrweb) MUST load lazily and the app MUST NOT wait for them | GUIDE-13, OUO-7 | all | Bundle analysis shows replay in a separate chunk; the app is interactive before it loads |
| GR-START-3 | Init MUST NOT depend on the network: no fetch of remote config blocks startup, and a slow or failed fetch keeps the last known or default config | INC-18, INC-1 | all | Start in airplane mode and with a 30 s-stalled endpoint; app starts in normal time |

## 9. Conflicts with the app's own handlers

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-HAND-1 | Every global handler the SDK installs (`ErrorUtils.setGlobalHandler`, Hermes rejection tracker, `NSSetUncaughtExceptionHandler`, signal handlers, Mach exception ports, `Thread.setDefaultUncaughtExceptionHandler`) MUST save the previous handler and call it, with the same arguments, after its own work | OUO-5, INC-25, INC-26, GUIDE-4 | RN, iOS, And, Fl | Install a sentinel handler before the SDK and another after; trigger each crash type; both sentinels fire and the report is written |
| GR-HAND-2 | On web the SDK MUST use `addEventListener`, never assign `window.onerror` / `onunhandledrejection`, and MUST NOT call `preventDefault` on errors it did not cause | INC-6 | W | Page with its own `onerror`; it still fires and the console still shows the error |
| GR-HAND-3 | The SDK MUST NOT swallow an error: after recording it the app's behaviour (red box, crash, default handler) is unchanged | spec ERR-3 | all | Same crash with and without the SDK; same exit code / signal and same dev-mode behaviour |
| GR-HAND-4 | The SDK MUST document and test co-existence with Sentry, Crashlytics and Datadog installed before and after it | INC-20, INC-24, GUIDE-10 | RN, iOS, And, W | Matrix job: SDK + each vendor in both init orders; both get the crash |

## 10. Headers, patching and globals

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-HDR-1 | The SDK MUST NOT overwrite a `traceparent`, `tracestate` or `baggage` header the app set | OUO-3, OUO-4 | W, RN, iOS, And, Fl | Request with an app-set `traceparent`; the server receives the app's value unchanged, for fetch, XHR, URLSession, OkHttp |
| GR-HDR-2 | Propagation headers MUST be added only to origins the app allowed (default: same origin only), so third parties never get a CORS preflight they reject | INC-33, INC-34 | W, RN | Cross-origin request to a server without `Access-Control-Allow-Headers: traceparent`; it succeeds with the SDK on |
| GR-HDR-3 | A patched function (`fetch`, `XMLHttpRequest`, `history.*`, `URLSession` delegates, OkHttp interceptors) MUST keep the original's arguments, defaults, return value, error type and message, timing and `this` | INC-4, INC-5, INC-35 | all | Conformance suite runs the platform's own request tests through the patched function; byte-identical errors and requests |
| GR-HDR-4 | Patching MUST co-exist with other patchers: wrap whatever is installed at patch time, never cache the native original in a way that drops a later wrapper, and unpatch only if still on top | INC-6, INC-27 | W, RN | Install a foreign wrapper before and after; both run; shutdown leaves the foreign wrapper in place |
| GR-HDR-5 | The SDK MUST NOT add, replace or polyfill globals the app sees (`Promise`, `self`, zone.js, prototypes) | INC-27, INC-36 | W, RN | Snapshot `globalThis` own properties and built-in prototypes before and after init; diff is only the documented SDK global |
| GR-HDR-6 | Swizzling and method replacement (iOS, Android bytecode) MUST be opt-out and MUST NOT run on classes the app has marked or that crash on probing (autofill, system views) | INC-21 | iOS, And | UI test on password-autofill screen and system view controllers with swizzling on |

## 11. Privacy and secret leaks

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-PRIV-1 | Logs MUST NOT contain any part of a token, auth header, cookie or password, at any log level | OUO-2, INC-43, INC-44, INC-45 | all | Run the suite with debug on and a canary token; grep all captured output for any 4+ character substring of it |
| GR-PRIV-2 | The SDK MUST NOT send the app's auth headers, cookies or request/response bodies unless the app opted in per field | INC-45 | all | Canary values in headers and bodies; assert none reach the fake collector by default |
| GR-PRIV-3 | URL query strings and fragments MUST be scrubbed of configured sensitive keys before export, and default-mask known ones (`token`, `password`, `key`, `code`, `session`) | INC-44 | all | URLs with canary params; assert redacted in `url.full` and replay |
| GR-PRIV-4 | Replay MUST mask inputs and text by default (spec §10.2), and a masking failure MUST drop the frame, never send it unmasked | GUIDE-6 | all with replay | Fault-inject the masker; assert the frame is dropped |
| GR-PRIV-5 | SDK credentials MUST NOT appear in URLs | INC-44 | all | Assert the collector URL has no query string carrying the token |

## 12. Offline

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-OFF-1 | Offline MUST be a normal state: no errors, no busy retry, no growth past the storage cap | INC-18 | all | Airplane mode for 1 h of use; no app-visible error, SDK CPU idle, storage at most cap |
| GR-OFF-2 | Retry MUST wait for connectivity or backoff, and MUST NOT flush the whole backlog in one burst when the network returns | GUIDE-7 | all | Reconnect after 1 h; assert the drain is paced in batches |

## 13. Kill switch and self-disable

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-KILL-1 | After N internal errors in one process (spec ERR-6, *default* 20) the SDK MUST become a no-op and say so once | INC-8, GUIDE-1 | all | Fault-inject 21 errors; assert no further SDK work and one `ouo.sdk.disabled` event |
| GR-KILL-2 | The operator MUST be able to disable the SDK, or one feature, remotely for a release or a share of users, without an app update, through a collector response (spec §8.2) | INC-1, INC-2 | all | Collector returns the disable signal; the next session starts as a no-op |
| GR-KILL-3 | Remote control MUST be strictly validated and fail closed to "SDK off" or last known good. A malformed, wrongly typed or unknown value MUST never throw | INC-1, INC-2 | all | Fuzz the remote config / disable response with wrong types; app is alive and the SDK keeps last known good |
| GR-KILL-4 | The app MUST be able to turn the SDK off locally (config flag) and the off path MUST do no work at all (no patching, no handlers, no storage) | GUIDE-2 | all | Init with `enabled: false`; assert no globals changed, no handlers installed, no storage touched |

## 14. Init with bad config

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-CFG-1 | Invalid config MUST NOT throw. Out-of-range numbers are clamped to range, wrong types fall back to the default, and each fix is logged once in debug | OUO-1, INC-1 | all | Table test of every option with below-range, above-range, NaN, wrong type, null; init returns and the effective config is clamped |
| GR-CFG-2 | Missing endpoint or token MUST make the SDK a no-op, not throw | GUIDE-2 | all | Init with no token; app runs and the SDK reports disabled |
| GR-CFG-3 | Config values passed to native code (RN → iOS/Android, Flutter → native) MUST be validated on both sides | OUO-1 | RN, Fl | RN test passes `jpegQuality: 500` and `-1` through the bridge; no native crash |
| GR-CFG-4 | Calling init twice, from two threads, or after shutdown MUST be safe | no public incident found; spec ERR-5 | all | Concurrent init stress test |
| GR-CFG-5 | Unsupported environments (SSR, web workers, app extensions, old OS) MUST degrade to a no-op | GUIDE-2 | all | Run init under Node SSR, in a worker, in an iOS extension; nothing throws |

## 15. Upgrades

| Id | MUST | Motivated by | Platforms | Automated test |
|---|---|---|---|---|
| GR-UPG-1 | Every persisted format (queue, session, run state) MUST carry a version; an unknown or corrupt version MUST be discarded, never crash | INC-15, INC-16 | all | Seed storage written by the previous release and by garbage; upgrade; app runs |
| GR-UPG-2 | A new SDK release MUST pass this checklist and the overhead budgets against the previous release before it ships, and MUST be rollable back without data migration | INC-15, INC-16, INC-17 | all | Release CI job: previous-version → new → previous on the reference app |
| GR-UPG-3 | The SDK MUST build cleanly with the app's toolchain range it claims (bundlers, SSR frameworks, Gradle/AGP, Xcode) and add no peer dependency the app did not ask for | INC-7, INC-36 | all | Matrix build of example apps per supported toolchain |
| GR-UPG-4 | New OS versions MUST be tested in beta before release (crash handler, swizzling, permissions) | INC-23 | iOS, And | Scheduled CI on the latest OS beta simulator/emulator |

## Count

15 categories, 61 items. Every item has an automated test; fault injection (GR-CRASH-7) is the shared harness most of them need.
