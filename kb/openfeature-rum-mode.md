# Choosing Sentry, both, or ouo per device with an OpenFeature flag (React Native)

Question: how does an app that ships `@sentry/react-native` let a feature flag decide, per
device, whether Sentry, Sentry + ouo, or only ouo records, and how is each cohort told apart
in the data? Written 2026-10-17 by sentry-demo. Code: `examples/sentry-mobile/src/rollout.ts`,
`index.ts`, `src/sentry.ts`, `src/ouo.ts`, `src/monitoring.ts`, `flags/`. Client guide:
`examples/sentry-mobile/ROLLOUT.md`.

## Decisions and why

- **Per cold start, never mid-session.** The SDKs install hooks that cannot be removed:
  `ErrorUtils` handler chain (each keeps the previous one), Hermes' single promise rejection
  tracker (frozen `HermesInternal`, `kb/ouo-next-to-sentry.md`), `fetch` / XHR wrappers,
  sentry-cocoa's native crash handler and replay. A flag change applies at the next launch.
  Both SDKs start a new session at every cold start anyway (ouo: "a cold start never resumes",
  `sdk/react-native/src/session/manager.ts`; Sentry: a new `init` session), so a mode change
  never splits a session.
- **Apply the stored decision, refresh for next time.** Launch N applies what launch N-1 stored
  (sync `expo-file-system` read, `Documents/ouo-rum-mode.json`), so `Sentry.init` still runs
  before the first render, with no network wait. Only the first launch after install waits for
  the flag (bounded, then the default `sentry`). Cost: each change takes two launches per device.
- **Device bucket = random id stored with the decision**, used as `targetingKey`. Not Sentry's
  installation id (`did`, `user.id`): it is not readable before `Sentry.init`, and in `ouo` mode
  Sentry never starts.
- **`parallel` sends Sentry straight to Sentry, not through the bridge**: the ouo SDK already
  reports the session; the bridge would report it again.
- **The bridge stamps `ouo.rum.mode = sentry`** on its resource (`ouosentryreceiver`,
  `translate.go`, `breadcrumbs.go`). The bridge copies no Sentry tags (spec section 12), and every
  bridged envelope was recorded by the Sentry SDK, so the receiver knows the cohort without app
  input. The ouo SDK got a `resource` option (`RUMOptions.resource`, SDK attributes win on a
  clash) for `parallel` / `ouo`.

## OpenFeature in React Native

- Use `@openfeature/web-sdk` (static context, one user/device, synchronous evaluation after the
  provider is ready), not the server SDK. 1.10.0, peer `@openfeature/core` 1.12.0.
- **OFREP** (`@openfeature/ofrep-web-provider` 0.4.3) works on Hermes with plain `fetch`. flagd
  serves OFREP on :8016 (`POST /ofrep/v1/evaluate/flags` bulk, `/flags/{key}` single). The flagd
  web provider (`@openfeature/flagd-web-provider`) uses Connect streaming, which React Native's
  `fetch` cannot do: not tried.
- OFREP web provider options for a mobile app: `pollInterval: 0`, `changeDetection: "none"` (flagd's
  bulk answer advertises an SSE stream), `disableVisibilityRefresh: true`, `cacheMode: "disabled"`.
  Its default cache is `localStorage`, which React Native lacks: the calls sit in try/catch and only
  log errors, but the cache never works. Its `document` uses are guarded by `typeof document`.
- `ofrep-core` binds `globalThis.fetch` when the provider is constructed. Requests made later still
  go through XHR, which both SDKs wrap, so exclude the flag URL from tracing in both
  (`shouldCreateSpanForRequest`, `tracing.ignoreUrls`).
- `InMemoryProvider` (in `@openfeature/web-sdk`) pins a variant for tests without a server.

## flagd

- Image `ghcr.io/open-feature/flagd:v0.17.0`, `start --uri file:/flags/<file>.json`. A host edit
  of a bind-mounted file reloads within a second on Docker Desktop for Mac (log
  `filepath event: ... WRITE`).
- Percentage rollout: `fractional` on `cat($flagd.flagKey, targetingKey)`. Measured on 2,000
  random ids with 80 / 15 / 5: 1,581 / 317 / 102 (79.1 / 15.9 / 5.1 %), and the same answer for
  200 / 200 ids asked twice. Buckets are filled in list order, so listing
  `sentry, parallel, ouo` makes a growing rollout move devices only forward.
- `sem_ver` in targeting gates by `appVersion` from the evaluation context.

## Verified on the simulator (2026-10-17)

iOS 27 simulator, isolated stack `ouo-flags` built from the branch, sentrytap as sentry.io behind
the bridge upstream and the direct DSN. `scripts/verify-rollout.py`: `sentry` 12/12, `parallel`
12/12, `ouo` 10/10 (table in `examples/sentry-mobile/ROLLOUT.md`).

- Launch A after a flag change stores the new value about 4 s after `simctl launch` (bundle load
  plus one OFREP round trip); launch B applies it.
- `ouo` mode: zero envelopes at Sentry, so `Sentry.wrap`, `Sentry.startSpan`, `Sentry.logger` and
  `reactNavigationIntegration` without `Sentry.init` stay silent, and sentry-cocoa never starts
  (the RN SDK starts it from `Sentry.init`).
- Switching `sentry` → `parallel`: the killed `sentry` session's `abnormal` update was sent
  through the bridge at launch A (still `sentry`), before the switch took effect.
- Bridge quirk found on the way: `Sentry.captureMessage(msg, "info")` from RN 8.30 carries
  `exception.values` (attached stack), so the bridge records it as `exception`
  (`ouo_sentry_level=info`). The ouo cohorts record the demo's message as `app.message`.
- Cohort split in Loki works on structured metadata:
  `sum by (service_name, ouo_rum_mode) (count_over_time({service_name=~"sentry-demo|sentry-demo-ouo", event_name="session.start"} [15m]))`.
  rum-api's session list and health stats do not filter by cohort yet; until they do, give the
  bridge its own `service_name`.
