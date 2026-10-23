# ouo React Native SDK next to the Sentry SDK (verified 2026-10-14)

Running `@ouo11y/react-native` in an app that keeps `@sentry/react-native` (8.30.0, Hermes, iOS
Simulator, `examples/sentry-mobile` built with `OUO_SDK=1`, now its `parallel` rollout mode,
`project/kb/openfeature-rum-mode.md`). How-to: SDK README "Next to Sentry".

## Hermes has one promise rejection tracker, and it cannot be shared

- `HermesInternal.enablePromiseRejectionTracker` keeps a single tracker: each call replaces the
  previous one. Both SDKs call it at init, so the one initialised last gets every unhandled
  rejection and the other none.
- `HermesInternal` is frozen on real Hermes: replacing the function (to fan out to several
  trackers) fails silently. A fake object in unit tests accepted it, which is why a "shared
  hub" design passed its tests and failed on the device. Do not try again.
- Working setup: ouo initialised AFTER Sentry, `errors.onUnhandledRejection` forwards to
  `Sentry.captureException(e, { mechanism: { type: "onunhandledrejection", handled: true } })`
  (the shape Sentry's own tracker reports). Run result: 1 Sentry event, 1 ouo record.
- Sentry RN also has an internal global error bus (`__SENTRY_RN_GLOBAL_ERROR_BUS__`,
  `subscribeGlobalError`), marked internal and new in 8.x; subscribing with `fatal` changes
  whether Sentry calls React Native's default handler. Not used.

## fetch, XHR and trace headers

- React Native's `fetch` (whatwg-fetch) opens and sends an `XMLHttpRequest` synchronously inside
  the `fetch` call. An SDK wrapping both must skip that inner XHR or every fetch is two spans.
- axios uses XHR in React Native: an SDK that wraps only `fetch` misses every axios call.
- The SDK whose wrapper runs first (patched last, i.e. initialised last) sets `traceparent`.
  Sentry's XHR and fetch code adds `traceparent` only when none is set (`setHeaderOnXhr` checks
  the recorded request headers), so with ouo last there is exactly one, whatever Sentry's
  `propagateTraceparent`. XHR joins repeated headers into one value: two `traceparent` would be
  invalid, two `baggage` are a valid merged list.
- Run result: 27 requests at the backend, 27 ouo client spans, 27/27 backend server spans
  parented to an ouo span. Sentry recorded 26: it creates `http.client` spans only inside an
  active transaction.
- Sentry traces other code's requests too, ouo's OTLP uploads included:
  `reactNativeTracingIntegration({ shouldCreateSpanForRequest })` excludes them.

## Everything else

- Global JS errors: both SDKs keep the previous `ErrorUtils` handler and call it; both see every
  error. `Sentry.captureException` is Sentry-only.
- Two replays record side by side (Sentry video, ouo frames), two sessions with different rules.
- Native crashes (2026-10-23, `project/kb/ios-native-crashes.md`): ouo keeps the signal and
  `NSException` handlers installed before it and calls them after writing its report. With ouo
  initialised after Sentry, both reported the same `Sentry.nativeCrash()` SIGSEGV on the next launch
  (ouo: fatal `exception`, session `crashed`; Sentry: `EXC_BAD_ACCESS` through the bridge, same
  frames). A JS fatal in Release reaches both JS handlers, then React Native aborts with
  `RCTFatalException`; ouo counts it once (the JS error), the native report only gives the end time.
- Never send both into ouo (Sentry through the collector's Sentry bridge plus the ouo SDK):
  every session would arrive twice.

## Device cost (measured 2026-10-17)

With ouo replay off, ouo next to Sentry costs no CPU, memory, start time or JS frames that can be told
apart from noise, and about 15 requests / 60 KB of upload per 95 s of use; ouo replay on as well adds
~6.6 pp CPU, ~1 MB upload per 95 s and a ~49 ms main-thread stall per frame on the simulator. Since N6
(2026-10-23) ouo's capture holds the main thread ~21 ms CPU per frame on the simulator, about half of
Sentry's in the same traces (`project/kb/ios-replay.md`).
Method and numbers: `project/kb/sdk-overhead-ios.md`.
