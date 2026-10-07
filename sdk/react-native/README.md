# @ouo/react-native

ouo Real User Monitoring SDK for React Native / Expo. OpenTelemetry under the hood:
sessions, errors and JS crashes, app version, outbound `fetch` tracing with W3C Trace
Context and Baggage, all exported over OTLP/HTTP to the ouo collector. No native code;
it runs in Expo Go.

Spec: `docs/specs/session-lifecycle.md` (mobile rules), classification: ADR-0004.
Runtime notes and gotchas: `kb/otel-react-native.md`.

## Install

```bash
npm install @ouo/react-native @react-native-async-storage/async-storage
# in this repository: "@ouo/react-native": "file:../../sdk/react-native" plus the Metro config below
```

Peer dependencies: `react`, `react-native` (>= 0.74), `@react-native-async-storage/async-storage`.
The OpenTelemetry packages are bundled into `dist/index.js` (CommonJS), so Metro never has
to resolve their `browser` field remaps.

### Expo setup

1. Initialise the SDK in the entry file **before** the root component is registered, so the
   global error handler and the `fetch` wrapper exist before the first render:

   ```ts
   // index.ts
   import "./src/rum";
   import { registerRootComponent } from "expo";
   import App from "./App";
   registerRootComponent(App);
   ```

   ```ts
   // src/rum.ts
   import { initRUM } from "@ouo/react-native";
   import Constants from "expo-constants";
   import * as Device from "expo-device";

   export const rum = initRUM({
     endpoint: "http://localhost:4328", // OTLP/HTTP base URL of the collector
     service: { name: "mobile-store", version: Constants.expoConfig?.version ?? "0.0.0", environment: "local" },
     tracing: { propagateTo: [/^http:\/\/localhost:8082/] },
     device: { modelIdentifier: Device.modelId ?? undefined, manufacturer: Device.manufacturer ?? undefined },
     debug: __DEV__,
   });
   ```

2. Wrap the app root in `RUMProvider` so touches count as session activity, and feed
   react-navigation state changes to the SDK for `navigation` events:

   ```tsx
   import { RUMProvider, navigationStateListener } from "@ouo/react-native";

   <RUMProvider rum={rum}>
     <NavigationContainer onReady={() => rum.trackNavigation("/Products")} onStateChange={navigationStateListener(rum)}>
       ...
     </NavigationContainer>
   </RUMProvider>
   ```

3. Linking the SDK from this monorepo (`file:` dependency) needs `examples/mobile/metro.config.js`:
   the SDK folder is added to `watchFolders`, its `node_modules` is block-listed, and a
   `resolveRequest` redirects the SDK's peer imports (`react`, `react-native`,
   `@react-native-async-storage/async-storage`, `promise`) to the app's `node_modules`.
   A published npm install needs none of this.

### Shims

The SDK installs, only when missing: `performance.timeOrigin` (Hermes exposes
`performance.now()` but older runtimes lack `timeOrigin`, and every OTel timestamp is
`timeOrigin + now()`), a UTF-8 `TextEncoder` (used by the OTLP JSON serializer). It does
not need `crypto.getRandomValues` (trace ids use `Math.random`, session ids use
`crypto.randomUUID` when present and fall back otherwise), `URL` (URLs are parsed with a
regex), `zone.js`, `XMLHttpRequest` instrumentation or `document`.

## API

```ts
import { initRUM, type RUM } from "@ouo/react-native";

const rum: RUM = initRUM({
  endpoint: "http://localhost:4328",
  service: { name: "mobile-store", version: "2.3.0", environment: "local" },
  tracing: { propagateTo: [/^http:\/\/localhost:8082/], ignoreUrls: [] },
  session: { inactivityTimeoutMs: 30 * 60_000, maxDurationMs: 4 * 3_600_000, backgroundTimeoutMs: 30_000 },
  user: { id: "user-1" },          // optional, otherwise an anonymous persisted id
  device: { modelIdentifier, modelName, manufacturer, osName, osVersion }, // optional
  errors: { consoleErrors: true, fatalFlushTimeoutMs: 2000 },
  storage: AsyncStorageLike,       // optional, defaults to @react-native-async-storage/async-storage
  debug: false,
});

rum.setUser({ id: "user-1" });
rum.captureError(err, { screen: "Cart" });      // exception, fatal=false, handled=true
rum.addEvent("cart.added", { "product.id": "p-1" });
rum.trackNavigation("/Cart");                   // navigation event + activity
rum.recordActivity();                           // what RUMProvider does on touch
rum.session.id(); rum.session.userId(); rum.session.previousId();
await rum.ready;                                // persisted state read, session.start emitted
await rum.flush();                              // force export of spans and log records
```

`initRUM` returns the same instance on repeated calls; `getRUM()` returns it from anywhere.

## Sessions (mobile rules)

- Cold start: a new session is created synchronously (its id is usable at once). The
  previous run's persisted session (`AsyncStorage` key `ouo.session`) is ended with
  `session.end`, reason `crash` if the crash marker `ouo.crash` exists, else `inactivity` /
  `max_duration` when its deadlines passed, else `background` when it was killed while
  backgrounded for longer than the background timeout, else `terminated`. The new
  `session.start` then carries `session.previous_id`.
- Activity: touches (`RUMProvider`), `trackNavigation`, outbound `fetch`, foreground.
  `lastActivity` is persisted at most once per second and on every flush.
- `AppState`: `background` records the timestamp; `active` after more than
  `backgroundTimeoutMs` (30 s) ends the session (`background`) and starts a new one.
  `inactive` is ignored. An in-process timer ends an expired session even without a
  foreground event; the replacement is created on the next activity.
- Inactivity (30 min) and max duration (4 h) work as on web.

## Errors and crashes (ADR-0004)

| Source | event | `ouo.exception.fatal` | `ouo.exception.handled` |
|---|---|---|---|
| `ErrorUtils` global handler, `isFatal = true` | `exception` | true | false |
| `ErrorUtils` global handler, `isFatal = false` | `exception` | false | false |
| unhandled promise rejection (Hermes tracker) | `exception` | false | false |
| `console.error` | `exception` | false | true |
| `rum.captureError` | `exception` | false | true |

A fatal error writes the crash marker, waits for it and for a flush (bounded by
`fatalFlushTimeoutMs`), then calls the previous global handler, so the red box (dev) or the
native crash (release) still happens. The next launch turns the marker into
`session.end` with reason `crash`. Wherever a window exists (react-native-web / Expo web,
which still bundles `ErrorUtils` but whose browser timers never reach it) the `error` /
`unhandledrejection` window events are installed as well, de-duplicated per error object, and
an uncaught error counts as fatal (ADR-0004, web rule).

## Network

`globalThis.fetch` is wrapped: one `CLIENT` span `HTTP <METHOD>` per request with
`http.request.method`, `url.full`, `url.scheme`, `url.path`, `server.address`, `server.port`,
`http.response.status_code` (`error.type` on failure); `traceparent` and `baggage`
(`session.id`, `user.id`, `ouo.platform=mobile`) on URLs matching `propagateTo`;
`http.request.failed` on 5xx or a network failure (status 0), not on 4xx or aborts. The
OTLP endpoint is never traced and the exporter uses the unwrapped `fetch.__original`.

## Events (OTel log records, `event.name`)

`session.start`, `session.end` (`ouo.session.end_reason`, `ouo.session.duration_ms`,
`ouo.session.started_at`, `ouo.session.ended_at`), `exception`, `http.request.failed`,
`navigation` (`url.path`, `ouo.navigation.from`), custom events from `addEvent`
(`ouo.event.custom=true`). Every span and log record carries `session.id`,
`session.previous_id` (when set), `user.id`, `ouo.user.anonymous`, `ouo.platform=mobile`
and `service.version`. Resource: `service.name`, `service.version`,
`deployment.environment.name`, `ouo.platform`, `os.name`, `os.version`,
`device.model.identifier`, `device.model.name`, `device.manufacturer`, `ouo.sdk.name`,
`ouo.sdk.version`.

## Development

```bash
npm run -w sdk/react-native build   # tsup -> dist/index.js (cjs) + index.d.ts
npm run -w sdk/react-native test    # vitest (jsdom env so the OTel browser builds are used)
# run the built bundle in Node against the live stack (no simulator needed):
cd sdk/react-native && SCENARIO=healthy node --require ./playground/preload.cjs playground/scenario.cjs
```

Scenarios: `healthy`, `errored`, `crash`, `relaunch`, `background`; `APP_VERSION`,
`OUO_OTLP`, `OUO_BACKEND`, `OUO_STORAGE_FILE` (the shared "disk" between launches).
