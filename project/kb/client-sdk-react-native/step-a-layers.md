# Step A: the layers added to the React Native SDK

What does step A of [ADR-0021](../../../docs/adr/0021-react-native-sdk-keep-and-extend.md) add to `sdk/react-native`, and what is not obvious about it? Written 2026-11-12. Revised 2026-11-12 after the review of PR 183. Verified by unit tests only (313 in 30 files); nothing here was run on a simulator or against a stack.

## Where each layer lives

| Layer | File | Spec ids |
|---|---|---|
| One guard around every entry point; internal errors counted; self-disable past `diagnostics.selfDisableThreshold` (20) | `src/guard.ts` | ERR-1, ERR-5, ERR-6 |
| Fault-injection suite with an explicit seam table; a source scan fails when a timer, frame or listener callback in `src/` is neither wrapped by the guard nor on a short allowlist | `test/fault-injection.test.ts`, `test/hardening.test.ts` | section 14 method F |
| Options normaliser: never throws, defaults with a diagnostic, clamps, no-op instance on a missing endpoint or credential | `src/config.ts` | CFG-1, CFG-2, CFG-3 |
| `beforeSend`, reserved names, truncation and the consent and sampling gates as OTel processors in front of the batch processors | `src/telemetry/gate.ts`, `src/attributes.ts` | CFG-4, API-3, REC-8 |
| Drop counter and the `ouo.sdk.dropped` event | `src/drops.ts` | ERR-7 |
| Consent: a storage overlay for the few small keys, the offline store held in memory (`Outbox.hold` / `release`), transitions run one after the other | `src/consent.ts`, `src/transport/outbox.ts`, `src/index.ts` (`setConsent`) | PRV-1 to PRV-4 |
| URL sanitising and the `sanitizeUrl` hook | `src/privacy.ts` | PRV-10, PRV-11 |
| Sampling decided once and persisted, bypass set, session rules | `src/sampling.ts`, `src/session/manager.ts`, `src/telemetry/correlation.ts` | SMP-1, SMP-3 to SMP-7, SES-5, SES-6, SES-9, SES-10, LIF-13 |
| Spec API surface, public `shutdown`, providers exposed | `src/index.ts`, `src/types.ts` | API-1, API-4, API-6, LIF-4, LIF-5, REL-5 |

## What was not obvious

- **Working without OTel globals (REL-4).** `context.with` and `propagation.inject` from `@opentelemetry/api` only work with a registered global. The SDK now holds its own context manager and propagator and passes the context explicitly to `tracer.startSpan`. `otel.registerGlobal: true` restores the old behaviour for apps that emit through the OTel API themselves.
- **Hermes has one rejection tracker and no getter for it.** `HermesInternal.enablePromiseRejectionTracker` replaces the previous tracker and nothing returns the old one, so "chain to the previous handler" (ERR-3) cannot be done generically. Next to Sentry the SDK forwards the rejection to Sentry's current scope instead. Tested against a fake Sentry carrier only, not next to a real `@sentry/react-native`.
- **Queue-full drops inside the OTel batch processors are invisible through public API.** The count is read from private fields of `BatchLogRecordProcessor` and `BatchSpanProcessor` (`_finishedLogRecords`, `_finishedSpans`, `_maxQueueSize`); `test/hardening.test.ts` fails when an OTel upgrade renames them.
- **Consent changes race unless they are queued.** A denial has an asynchronous tail (hand over the batch queues, delete the keys) and so has a grant (write out what was held). `setConsent` stops capture at once and runs the tails one after the other; the grant re-checks the state after each wait. While denied the session manager is suspended: activity starts no session, so no id can leave in baggage.
- **A write on its way to storage can land after a delete.** `ConsentStorage.purge` waits for every write still in flight before it removes keys, and the outbox remembers which bodies it wrote so that a request dropped while held is still deleted.
- **A patch can only be removed while it is the outermost one.** On uninstall each of `fetch`, the three XHR methods, `console.error` and the global handler is restored only when the current function is ouo's; otherwise ouo's wrapper stays in the chain and only passes through. The Hermes rejection tracker cannot be removed at all: after shutdown it records nothing and still forwards.
- **`beforeSend` can call the SDK.** A record the hook emits skips the hook (a module-level flag in `src/telemetry/gate.ts`), so a hook that logs what it dropped cannot recurse.
- **The previous global handler waits for the crash marker and the flush, together bounded by `errors.fatalFlushTimeoutMs`,** so a storage that does not answer cannot swallow the app's crash.
- **URLs are sanitised once, where they are captured** (request URLs, the `trackNavigation` path); the gate only does the URLs inside `exception.stacktrace` and `exception.message`. A `url.full` the app puts on its own span is not touched. A query part without `=` is redacted too: it cannot be told from a value.
- **The bypass cap exempts only a native crash and a termination.** A JS error marked fatal can repeat (LogBox in dev, the window `error` path on Expo web), so it is capped like the rest.
- **A test run is the "nothing reaches the host" assertion.** Vitest fails on any uncaught exception or unhandled rejection, so a fault thrown later from a timer or a promise fails the suite without a per-test check.
- **Clamping timeouts to one minute (CFG-2) changes the demo and CI builds**, which used 5 s and 2 s background timeouts to make sessions rotate quickly.

## Still open after step A

- Renames, scope `ouo.rum`, `schema_url`, `ouo.view.id`, the 32-hex session id, the hex-prefix sampling rule, the 15-minute background default, protobuf: step B.
- Replay over OTLP and the native methods the JS layer already calls when present: `capture`, `mask`, `unmask`, and a way to delete unsent replay chunks on consent withdrawal.
- `partial_success` is read on the JS `fetch` path only: the native `postOtlp` does not return the response body.
- `ouo.crash.frames`, `ouo.crash.images` and `ouo.last_events` are bounded only by the 64 KB record total, not the 4 KiB string cut.
- An error that escapes `withSpan` and then arrives at the global handler as fatal produces two `exception` records.
- The exported helpers `resolveEndpoints` and `requireCredentials` still throw when called directly.
