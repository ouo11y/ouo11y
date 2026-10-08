# OTel JS SDK inside React Native / Expo

Status: filled in Phase 5 by `sdk-react-native`. Code: `sdk/react-native`, consumer: `examples/mobile`.

## Question

What does the OpenTelemetry JS SDK need to run inside React Native (Hermes) / Expo, how is
the SDK linked into a non-workspace Expo app, and how are mobile sessions, crashes and app
versions made to look exactly like the web ones to the collector and rum-api?

## What was tried

- **Packages**: `@opentelemetry/api`, `api-logs`, `core`, `resources`, `sdk-trace-base`,
  `sdk-logs`, `exporter-trace-otlp-http`, `exporter-logs-otlp-http`, `semantic-conventions`.
  No `sdk-trace-web`, no `zone.js`, no `context-zone`, no instrumentation packages: React
  Native has no async context manager, so the fetch wrapper is hand written and baggage is
  merged at inject time (same approach as `sdk/browser`).
- **Bundling** (`tsup.config.ts`): one CommonJS file, `platform: "browser"`, every
  `@opentelemetry/*` package bundled (`noExternal`). The `browser` field of the OTel packages
  selects the fetch transport, the `Math.random` id generator and the `performance`-based
  clock; those are the builds that run on Hermes. Left external: `react`, `react-native`,
  `@react-native-async-storage/async-storage`. Metro therefore never resolves OTel's
  `browser` field remaps itself (Metro ignores that field unless configured).
- **Node fallback** (`sdk/react-native/playground/`): `node --require preload.cjs scenario.cjs`
  runs the built SDK with stand-ins for `react-native` (`AppState`, `Platform`), AsyncStorage
  (JSON file so separate processes behave like app launches), `ErrorUtils` and
  `HermesInternal.enablePromiseRejectionTracker`. Used for the Phase 5 verification because
  this machine has no Xcode.
- **Expo web** (`npx expo start --web --port 8083`) runs the real app bundle through Metro
  with react-native-web; useful as a UI smoke test when no simulator exists.

## What works

### Shims (`src/shims.ts`), installed before any OTel import is used

| Global | Why | Hermes / Expo | Expo web |
|---|---|---|---|
| `performance.timeOrigin` | `@opentelemetry/core` `hrTime()` adds `performance.timeOrigin` to `performance.now()`; without a numeric origin every timestamp is `NaN` and the collector rejects the batch | Hermes has `performance.now()`; `timeOrigin` is added when missing (`defineProperty`, wrapper object if the host object is frozen) | native |
| `TextEncoder` | OTLP JSON serializer encodes the body to bytes | Hermes >= RN 0.74 ships it; a minimal UTF-8 encoder is installed only when missing | native |

The report of what was needed is logged as `[ouo] shims {...}` when `debug: true`. Nothing
else was needed: `fetch`, `Headers`, `setTimeout`, `Promise`, `crypto.getRandomValues` /
`randomUUID` (Expo installs them; `ids.ts` falls back to `Math.random`) are present. The
`URL` global is **not** used (RN's `URL` polyfill historically throws on `hostname`), see `src/url.ts`.

### Linking the SDK into `examples/mobile` (not an npm workspace)

`"@ouo/react-native": "file:../../sdk/react-native"` gives a symlink in
`examples/mobile/node_modules/@ouo/react-native`. Metro needs three things (`metro.config.js`):

1. `watchFolders` += the SDK folder (Metro only serves files under its watch folders).
2. `resolver.blockList` += `sdk/react-native/node_modules/.*` so Metro never crawls the SDK's
   dev dependencies (which include a second `react-native` for Vitest).
3. `resolver.resolveRequest`: imports of `react`, `react-native`,
   `@react-native-async-storage/async-storage`, `promise` that originate inside the SDK are
   re-resolved from the app's `index.ts`, so the app's copies are used (two Reacts = hook errors).

Rebuild the SDK (`npm run -w sdk/react-native build`) after changing it; Metro follows the
symlink but consumes `dist/index.js`. `npx expo export --platform ios` builds the Hermes
bytecode bundle (`.hbc`) without a simulator and is the cheapest "does it bundle" check.

### Session rules (`src/session/manager.ts`)

- Persisted under AsyncStorage keys `ouo.session`, `ouo.user`, `ouo.crash`. Activity persists
  at most once per second, structural changes immediately.
- Cold start = new process: a new session id is available synchronously; `rum.ready` resolves
  once the previous run's record was read. If that record has no `endedAt`, `session.end` is
  emitted for it with reason `crash` (crash marker for that id exists), else the expiry reason
  (`inactivity` / `max_duration` / `background` when it was killed while backgrounded), else
  `terminated`. The marker is then cleared; `session.previous_id` is set on the new session.
- Same-process re-init (hot reload) resumes the session, spec case 2.
- AppState `background` stamps `backgroundAt`; `active` after more than `backgroundTimeoutMs`
  (30 s) ends the session (`background`) and the foreground activity starts the next one. iOS
  `inactive` is ignored in both directions.
- **AsyncStorage ordering gotcha**: writes issued before the cold-start read would overwrite
  the previous run's record; `persist()` is suppressed for the new record until the read is done.
- `session.end` records carry their own `session.id` / `service.version` (the version the
  session ran on, stored in the record), so the `SessionLogProcessor` must not overwrite
  attributes that are already present and must not call `session.id()` (which would create the
  replacement session) for a record about an ended session.

### Errors (`src/errors/install.ts`)

- `ErrorUtils.setGlobalHandler`: `exception` with `ouo.exception.fatal = isFatal`,
  `ouo.exception.handled = false`; on fatal: crash marker + `flush()` bounded by
  `fatalFlushTimeoutMs` (2 s), then the previous handler (LogBox / native crash) runs.
- Unhandled rejections: `HermesInternal.enablePromiseRejectionTracker` (non-fatal, unhandled).
  Fallback `promise/setimmediate/rejection-tracking` (JSC), then the window event.
- `console.error` and `captureError`: non-fatal, handled.
- **Expo web gotcha**: Expo bundles RN's `ErrorUtils` polyfill for web too, but browser timers
  and DOM handlers never go through it, so a throw inside `setTimeout` reached nobody and the
  session ended `terminated` instead of `crash`. The SDK now installs the window `error` and
  `unhandledrejection` listeners **in addition** to `ErrorUtils` whenever
  `globalThis.addEventListener` exists, de-duplicated per error object (`WeakSet`). On native
  RN there is no `addEventListener` global, so nothing changes there.
- A fatal error thrown from a `setTimeout` on native goes through RN's timer error guard and
  reaches the global handler with `isFatal = true`; that is why the Chaos screen uses a timer.

### Network (`src/network.ts`)

`global.fetch` wrapper: one CLIENT span `HTTP <METHOD>` with `http.request.method`, `url.full`,
`server.address`, `url.path`, `http.response.status_code`; `traceparent` + `baggage`
(`session.id`, `user.id`, `ouo.platform=mobile`) for `propagateTo` URLs; `http.request.failed`
for 5xx and network failures (not 4xx, not `AbortError`). The OTLP endpoint is always ignored
and the wrapper keeps `fetch.__original`. The Go demo backend copies the baggage onto its
server spans, so Tempo `{ span.session.id = "<id>" }` returns the mobile client span plus the
`demo-backend` `POST /api/checkout`, `db.query`, `payment.charge` ... spans in one trace.

### Resource

`service.name`, `service.version` (app version from `Constants.expoConfig.version`),
`deployment.environment.name`, `ouo.platform=mobile`, `ouo.sdk.name/version`, `os.name`
(`iOS` / `iPadOS` / `Android` from `Platform`), `os.version`, `device.model.identifier`,
`device.model.name`, `device.manufacturer` (from `expo-device` when the app passes them).
`telemetry.sdk.language` stays `webjs` (OTel browser build default).

## Gotchas

- Every span and log record must carry `session.id`, `user.id`, `ouo.platform`,
  `service.version` as **attributes** (rum-api folds Loki labels; Tempo search uses
  `span.session.id`). The resource alone is not enough for Tempo search.
- rum-api caches Tempo results per session for 60 s: a `/v1/sessions` query made a few
  seconds after a flush can show `trace_count: 0` until Tempo's ingester makes the spans
  searchable and the cache entry expires. Re-query after a minute before suspecting the SDK.
- `vitest` must run with `environment: jsdom` and `mainFields: ["browser", ...]` so the tests
  exercise the same fetch-transport builds Metro bundles; with `environment: node` Vite picks
  the `node:http` exporters.
- Never `console.error` inside the SDK: it instruments `console.error` and would report itself.
- With `CI=1`, Expo/Metro disables file watching ("reloads are disabled"): restart
  `expo start` after rebuilding the SDK.
- Verification on this machine: **no Xcode installed** (only Command Line Tools), so the iOS
  Simulator could not be used in Phase 5. The Node playground against the real collector and
  the Expo web build were used instead; the native run (Expo Go on a simulator) is still owed.
