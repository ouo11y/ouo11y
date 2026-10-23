# @ouo11y/react-native

ouo Real User Monitoring SDK for React Native / Expo. OpenTelemetry under the hood:
sessions, errors, JS and native (iOS) crashes, app version, outbound `fetch` tracing with W3C Trace
Context and Baggage, all exported over OTLP/HTTP to the ouo collector (`ouo-collector`, the only
internet-facing service, ADR-0007) with the project credential as HTTP Basic. Telemetry needs no
native code and runs in Expo Go; session replay (iOS) is an Expo native module and needs a
development build.

Spec: `docs/specs/session-lifecycle.md` (mobile rules), classification: ADR-0004, ingest and
project tokens: ADR-0007. Runtime notes and gotchas: `project/kb/otel-react-native.md`. Changes: `CHANGELOG.md`.

## Install

```bash
npm install @ouo11y/react-native @react-native-async-storage/async-storage   # expo-modules-core comes with expo
# in this repository: "@ouo11y/react-native": "file:../../sdk/react-native" plus the Metro config below
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
   import { initRUM } from "@ouo11y/react-native";
   import Constants from "expo-constants";
   import * as Device from "expo-device";

   export const rum = initRUM({
     endpoint: "http://localhost:4318",              // collector OTLP/HTTP base (ADR-0007); replay defaults to :4319
     projectId: "demo",                              // user name of the Basic credential; required
     projectToken: "pt_dev_demo_0000000000000000",   // password of the Basic credential; required, public by nature
     service: { name: "mobile-store", version: Constants.expoConfig?.version ?? "0.0.0", environment: "local" },
     tracing: { propagateTo: [/^http:\/\/localhost:8081/] },
     device: { modelIdentifier: Device.modelId ?? undefined, manufacturer: Device.manufacturer ?? undefined },
     debug: __DEV__,
   });
   ```

2. Wrap the app root in `RUMProvider` so touches count as session activity, and feed
   react-navigation state changes to the SDK for `navigation` events:

   ```tsx
   import { RUMProvider, navigationStateListener } from "@ouo11y/react-native";

   <RUMProvider rum={rum}>
     <NavigationContainer onReady={() => rum.trackNavigation("/Products")} onStateChange={navigationStateListener(rum)}>
       ...
     </NavigationContainer>
   </RUMProvider>
   ```

3. Linking the SDK from this monorepo (`file:` dependency) needs `examples/ouo-mobile/metro.config.js`:
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

### Endpoints and the project credential (ADR-0007)

`endpoint` is the collector's OTLP/HTTP base URL; `projectId` and `projectToken` are required.
From them the SDK derives:

| Signal | URL | Header |
|---|---|---|
| traces | `${endpoint}/v1/traces` | `Authorization: Basic base64("<projectId>:<projectToken>")` |
| events (logs) | `${endpoint}/v1/logs` | same |
| replay chunks (native) | `${replayEndpoint}/v1/replay/chunks` | same, plus `x-ouo-session-id`, `x-ouo-seq` |

`replayEndpoint` is optional: it defaults to `endpoint` with port 4318 replaced by 4319 (the
collector's `ouoreplay` receiver listens next to OTLP), or to `endpoint` itself when it uses any
other port or none (a proxy such as `https://otel.example.com` routes `/v1/replay/*` to the
receiver). The collector's `basicauth` extension checks the credential (401 when missing or
unknown; the user name is the project id, the password the token), its rate limiter and body
limits apply, and it stamps `ouo.project.id` on every resource from the authenticated user name.
`initRUM` throws a `TypeError` when `projectId` or `projectToken` is missing or empty. The token
is public (it only allows writing telemetry into one project), so shipping it in the app bundle
is expected, exactly like every RUM vendor's key. The header value is built with the SDK's own
base64 encoder (`basicAuthorization`, `base64Encode`): `btoa` is not available on every React
Native runtime.

`resolveEndpoints({ endpoint, replayEndpoint })` and `defaultReplayEndpoint(endpoint)` are
exported so hosts and tests can see the derived URLs. Requests to the derived URLs are never traced.

### Session replay (iOS, ADR-0006)

```ts
initRUM({
  endpoint: "http://localhost:4318",              // chunks go to http://localhost:4319/v1/replay/chunks
  projectId: "demo",
  projectToken: "pt_dev_demo_0000000000000000",
  replay: { enabled: true, frameInterval: 1, maskText: true, maskInputs: true, maskImages: true, maskWebViews: true },
  // ...
});
rum.replay.pause(); rum.replay.resume(); rum.replay.isRecording();
```

The package is an Expo module (`expo-module.config.json`): `ios/OuoReplayModule.swift` bridges
the `OuoReplay` Swift package in `sdk/ios` (screenshot capture with view-hierarchy masking,
gzip frame chunks to `POST /v1/replay/chunks` with the Basic `Authorization` header), `android/`
is a no-op that logs once. The JS side calls native `start(replayEndpoint, { projectId, projectToken,
sessionId, ... })`, forwards every session rotation (`sessionDidRotate`), flushes with
`rum.flush()`, and is a silent no-op where the native module is absent: Expo Go, web, Jest/Vitest,
bare apps without `expo-modules-core` (a debug-only warning is logged once).

### Masking and how to opt out

By default everything that can carry user content is painted black on the device before a
frame is encoded: labels and `<Text>` (`maskText`), text inputs (`maskInputs`), images
(`maskImages`) and web views (`maskWebViews`). The default is deliberately aggressive: a replay
must never leak what a user typed or read, so you opt in to visibility rather than out of
privacy (the same default Sentry ships). Opt out per category in `replay`:

- `maskText: false` shows labels, paragraphs and navigation-bar titles so replays stay readable.
  Inputs are **not** affected: they are governed by `maskInputs` alone.
- `maskImages: false` shows images (product photos, avatars).
- `maskInputs: false` shows what users type into `TextInput`s. Only set it if you really mean it.
- `maskWebViews: false` shows `WKWebView` content.

Per view, `testID="ouo-unmask"` keeps a view and its subtree visible whatever the class rules say,
and `testID="ouo-mask"` redacts a view (its rectangle covers the subtree); both work with any
combination of the options above. Extra class names can be masked with `maskClasses` on the
Swift config (`extraClasses` in the planner) when embedding the package directly. Details and the
class lists are in `sdk/ios/README.md`.

Requirements: `expo-modules-core` (peer, optional), a development build instead of Expo Go
(`npx expo prebuild --platform ios && npx expo run:ios`, needs Xcode + CocoaPods), and
`npm run -w sdk/react-native build` before `pod install`: the build copies the Swift sources of
`sdk/ios` into `ios/OuoReplayCore` and `ios/OuoReplay` (gitignored) because CocoaPods only globs
files under the podspec directory. Three pods are autolinked: `OuoReplayCore`, `OuoReplay`,
`OuoReactNative`. In this monorepo `examples/ouo-mobile/metro.config.js` also redirects the SDK's
`expo-modules-core` import to the app's copy.

## API

```ts
import { initRUM, type RUM } from "@ouo11y/react-native";

const rum: RUM = initRUM({
  endpoint: "http://localhost:4318",              // collector OTLP/HTTP base URL, required
  replayEndpoint: undefined,                      // optional; default: endpoint with 4318 -> 4319, else endpoint
  projectId: "demo",                              // required
  projectToken: "pt_dev_demo_0000000000000000",   // required
  service: { name: "mobile-store", version: "2.3.0", environment: "local" },
  tracing: { propagateTo: [/^http:\/\/localhost:8081/], ignoreUrls: [] },
  session: { inactivityTimeoutMs: 30 * 60_000, maxDurationMs: 4 * 3_600_000, backgroundTimeoutMs: 30_000 },
  user: { id: "user-1" },          // optional, otherwise an anonymous persisted id
  device: { modelIdentifier, modelName, manufacturer, osName, osVersion }, // optional
  resource: { "ouo.rum.mode": "parallel" }, // optional extra resource attributes; the SDK's own win
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
| native crash on iOS (signal, uncaught NSException), sent on the next launch | `exception`, `ouo.exception.kind = native` | true | false |

A fatal error writes the crash marker, waits for it and for a flush (bounded by
`fatalFlushTimeoutMs`), then calls the previous global handler, so the red box (dev) or the
native crash (release) still happens. The next launch turns the marker into
`session.end` with reason `crash`. Wherever a window exists (react-native-web / Expo web,
which still bundles `ErrorUtils` but whose browser timers never reach it) the `error` /
`unhandledrejection` window events are installed as well, de-duplicated per error object, and
an uncaught error counts as fatal (ADR-0004, web rule).

**Native crashes (iOS, Expo module).** `initRUM` installs signal handlers (`SIGSEGV`, `SIGBUS`,
`SIGABRT`, `SIGILL`, `SIGFPE`, `SIGTRAP`, `SIGSYS`) and an uncaught `NSException` handler. At
crash time they write one JSON report (crashing thread's frames, the binary images they point
into, signal or exception, time, session id) to `Library/Application Support/ouo/crash`. The
next launch takes it once, ends the crashed session with reason `crash` **at the crash time**
and emits a fatal `exception` stamped with that time and the crashed `session.id`:
`exception.stacktrace` in Apple crash report form (`0   app   0x… 0x… + offset`, then
`Binary Images:`), plus `ouo.crash.frames` (`instruction_addr`, `image_addr`) and
`ouo.crash.images` (`code_file`, `debug_id`, `image_addr`, `image_size`, `image_vmaddr`) as JSON,
so the stack can be symbolicated later (`atos -o App.dSYM -l <image_addr> <instruction_addr>`). A
JS fatal that React Native turns into `RCTFatalException` in Release is not reported twice: the
JS handler already sent it, the native report only gives the end time. Turn it off with
`errors: { nativeCrashes: false }`. Only the crashed thread is recorded, from its frame pointers.

Hermes keeps one promise rejection tracker: every `enablePromiseRejectionTracker` call replaces
the previous one, and `HermesInternal` is frozen, so the tracker cannot be shared. The SDK
initialised last gets unhandled rejections. `errors.onUnhandledRejection` hands each rejection
on after ouo recorded it (to Sentry, see "Next to Sentry").

## Network

`globalThis.fetch` and `XMLHttpRequest` (axios, superagent and other XHR clients) are wrapped:
one `CLIENT` span `HTTP <METHOD>` per request with
`http.request.method`, `url.full`, `url.scheme`, `url.path`, `server.address`, `server.port`,
`http.response.status_code` (`error.type` on failure); `traceparent` and `baggage`
(`session.id`, `user.id`, `ouo.platform=mobile`) on URLs matching `propagateTo`;
`http.request.failed` on 5xx or a network failure (status 0), not on 4xx or aborts. The
SDK's own ingest URLs are never traced and the exporter uses the unwrapped `fetch.__original`.
React Native's `fetch` runs on `XMLHttpRequest`; the XHR that a wrapped `fetch` call opens is
skipped, so a fetch is one span, not two. On XHR, `traceparent` is only added when the request
has none yet (XHR would join two into one invalid header); `baggage` is merged.

## Next to Sentry

The SDK runs in an app that keeps `@sentry/react-native`, the way an APM agent and an
OpenTelemetry SDK can run side by side while a team moves over. Verified on the iOS Simulator
with `examples/sentry-mobile` in its `parallel` rollout mode (@sentry/react-native 8.30.0, Hermes).

1. **Initialise ouo after Sentry** and forward unhandled rejections to it:

   ```js
   // index.js: imports run in order, and before any code in this file
   import "./src/sentry"; // Sentry.init(...)
   import "./src/ouo";    // initRUM(...) below
   import App from "./App";
   ```

   ```js
   initRUM({
     // ...
     errors: {
       onUnhandledRejection: (e) =>
         Sentry.captureException(e, { mechanism: { type: "onunhandledrejection", handled: true } }),
     },
   });
   ```

   Hermes keeps one rejection tracker and the SDK initialised last owns it; ouo records each
   rejection and hands it to Sentry, so both report it once. Without the hook, the SDK warns in
   debug mode that Sentry stopped getting rejections. Initialised the other way round, Sentry
   owns the tracker and ouo never sees a rejection.
2. **Trace headers**: initialised last, ouo's fetch and XHR wrappers run first and set
   `traceparent`; Sentry then adds `sentry-trace` and its `baggage` entries but no second
   `traceparent`, whatever its `propagateTraceparent` says. The backend joins ouo's trace.
3. **Errors**: each global error handler calls the one before it; both SDKs see every error.
   `Sentry.captureException` calls stay Sentry-only (use `rum.captureError` for ouo).
   **Native crashes**: ouo keeps the signal and `NSException` handlers installed before it
   (Sentry's) and calls them after writing its own report, so both SDKs report the crash on the
   next launch. Sentry's Mach exception handler sees a bad access first and passes it on as a
   signal, which then reaches ouo.
4. **Exclude ouo's uploads from Sentry's tracing**, or Sentry records them as `http.client`
   spans: `Sentry.reactNativeTracingIntegration({ shouldCreateSpanForRequest: (url) => !url.startsWith(OUO_ENDPOINT) })`.
5. Two independent sessions (ouo's rules and Sentry's), two replays when both record (about twice
   the capture cost), two uploads. Do not also point Sentry's DSN at the ouo collector's Sentry
   bridge while both SDKs run: ouo would get every session twice.
6. **Rolling out per device**: `examples/sentry-mobile/ROLLOUT.md` picks Sentry, both, or ouo
   with an OpenFeature flag at each cold start (never mid-session) and tags each cohort with
   `resource: { "ouo.rum.mode": ... }`.

## Events (OTel log records, `event.name`)

`session.start`, `session.end` (`ouo.session.end_reason`, `ouo.session.duration_ms`,
`ouo.session.started_at`, `ouo.session.ended_at`), `exception`, `http.request.failed`,
`navigation` (`url.path`, `ouo.navigation.from`), custom events from `addEvent`
(`ouo.event.custom=true`). Every span and log record carries `session.id`,
`session.previous_id` (when set), `user.id`, `ouo.user.anonymous`, `ouo.platform=mobile`
and `service.version`. Resource: `service.name`, `service.version`,
`deployment.environment.name`, `ouo.platform`, `os.name`, `os.version`,
`device.model.identifier`, `device.model.name`, `device.manufacturer`, `ouo.sdk.name`,
`ouo.sdk.version`, plus the app's `resource` attributes (for example the rollout cohort
`ouo.rum.mode`, `examples/sentry-mobile/ROLLOUT.md`).

## Development

```bash
npm run -w sdk/react-native build   # sync Swift sources into ios/, tsup -> dist/index.js (cjs) + index.d.ts
npm run -w sdk/react-native test    # vitest (jsdom env so the OTel browser builds are used)
npm pack --dry-run -w sdk/react-native   # what gets published (dist, ios incl. vendored Swift, android, config)
# run the built bundle in Node against the live stack (no simulator needed):
cd sdk/react-native && SCENARIO=healthy node --require ./playground/preload.cjs playground/scenario.cjs
```

Scenarios: `healthy`, `errored`, `crash`, `relaunch`, `background`; `APP_VERSION`,
`OUO_OTLP` (collector OTLP/HTTP base, default `http://localhost:4318`), `OUO_PROJECT_ID` (default
`demo`), `OUO_PROJECT_TOKEN` (default the development token), `OUO_REPLAY_ENDPOINT` (optional),
`OUO_BACKEND`, `OUO_STORAGE_FILE` (the shared "disk" between launches). `test/ingest-stub.test.ts`
starts a Node stub of the collector with `basicauth` on port 18082 and checks that traces and logs
arrive on `/v1/traces` and `/v1/logs` with `Authorization: Basic …` and that a wrong token is a 401.
