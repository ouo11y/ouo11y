# ouo React Native SDK next to the Sentry SDK (verified 2026-10-14)

Running `@ouo/react-native` in an app that keeps `@sentry/react-native` (8.30.0, Hermes, iOS
Simulator, `examples/sentry-mobile` built with `OUO_SDK=1`, now its `parallel` rollout mode,
`kb/openfeature-rum-mode.md`). How-to: SDK README "Next to Sentry".

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
- Never send both into ouo (Sentry through the collector's Sentry bridge plus the ouo SDK):
  every session would arrive twice.
