# @ouo11y/react-native

ouo Real User Monitoring SDK for React Native / Expo. OpenTelemetry under the hood:
sessions, errors, JS and native (iOS) crashes, app version, outbound `fetch` tracing with W3C Trace
Context and Baggage, a span and log API, timeline events (taps, app lifecycle, requests), mobile vitals, all exported over OTLP/HTTP to the ouo collector (`ouo-collector`, the only
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
  replay: { enabled: true, mode: "auto", frameInterval: 1, maskText: true, maskInputs: true, maskImages: true, maskWebViews: true },
  // ...
});
rum.replay.pause(); rum.replay.resume(); rum.replay.isRecording();
rum.replay.hideScreen(); rum.replay.showScreen();   // never-record screens, see below
```

`mode`: `session` records a frame at most every `frameInterval` seconds while the screen changes;
`navigation` records one frame per screen (start, resume, and every route change the SDK tracks:
`onStateChange` or `rum.trackNavigation`); `auto` (default) picks `navigation` on devices with
less than 3.5 GiB of RAM and `session` otherwise. Frames are taken after the run loop's UI work, a
due frame waits up to 1 s while animations run, and the capture's main-thread time is bounded at
100 ms per second. A frame where a masked view is moving (a screen sliding in) is dropped rather
than risk an unmasked pixel. The open chunk is kept on disk and sent on the next launch after a
crash.

The package is an Expo module (`expo-module.config.json`): `ios/OuoReplayModule.swift` bridges
the `OuoReplay` Swift package in `sdk/ios` (screenshot capture with view-hierarchy masking,
gzip frame chunks to `POST /v1/replay/chunks` with the Basic `Authorization` header), and
`android/src/main/java/dev/ouo/reactnative/OuoReplayModule.kt` the same functions over the Kotlin
capture of `sdk/android` (`PixelCopy` into RGB_565, per-line text masks, the same schema 2 chunks;
its sources are vendored into `android/vendor` by `npm run build`, like the Swift ones). On Android
the crash, hang and vitals functions are not there yet (W9 part 2): the JavaScript checks each one
and the SDK emits only what JavaScript sees. The JS side calls native `start(replayEndpoint, { projectId, projectToken,
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

### Never-record screens

Masking hides content but still records the layout. For screens that must not appear in a
replay at all (identity checks, signatures, health records):

```ts
initRUM({ replay: { enabled: true, excludeScreens: ["IdentityCheck", "/Account/Sign*", /^Patient/] } });

// A screen the SDK does not see as a route: a third-party SDK's own UI.
rum.replay.hideScreen();
await stripeIdentity.present();   // Stripe Identity's view controller / activity
rum.replay.showScreen();
```

- `excludeScreens` matches the screen the SDK tracks (`navigationStateListener(rum)` or
  `rum.trackNavigation(path)`): a string equals the screen name (the path's last segment) or the
  whole path, or is a prefix when it ends with `*`; a RegExp is tested against both. On such a
  screen native capture is paused (the open chunk is cut and sent, no frame is taken), and it
  resumes with a full frame 500 ms after the screen is left, once the transition out of it is
  over. A recorder that would start on a hidden screen starts when it is shown.
- `hideScreen()` / `showScreen()` do the same by hand. They, `excludeScreens` and `pause()` are
  independent: capture resumes only when none of them holds it. They survive backgrounding, a
  new activity or view controller and session rotation.
- Hiding writes an `ouo.replay.hidden` event (`ouo.replay.hidden_reason`: `screen` or `manual`)
  to the session's timeline, once per hidden stretch, and again for a session that starts while
  hidden; the player keeps the last frame before the gap.
- **Timing.** The SDK learns about a route from `onStateChange`, after the screen mounted, and
  the native pause runs on the next main-thread turn. A screen pushed with a native transition is
  safe (no frame is taken during a transition), but one shown without one (a tab switch, a
  `Modal` with `animationType="none"`) can have one frame captured first, masked like any other.
  For a screen that must never appear, call `hideScreen()` **before** navigating to it, and
  `showScreen()` after leaving it.
- **Third-party native UI.** What a third-party SDK presents is in your app's process, so the
  recorder sees it: on iOS a view controller presented in the key window (Stripe Identity's
  flow) is captured like your own screens, on Android its activity's window is the topmost one and
  is captured. Its text, images and camera preview (`SurfaceView` / `TextureView` on Android) are
  masked by the class rules, but the layout is recorded, so wrap it in `hideScreen()` /
  `showScreen()`. (Not verified against the Stripe Identity SDK itself: the example apps do not
  embed it.)

Requirements: `expo-modules-core` (peer, optional), a development build instead of Expo Go
(`npx expo prebuild --platform ios && npx expo run:ios`, needs Xcode + CocoaPods), and
`npm run -w sdk/react-native build` before `pod install`: the build copies the Swift sources of
`sdk/ios` into `ios/OuoReplayCore` and `ios/OuoReplay` (gitignored) because CocoaPods only globs
files under the podspec directory. Three pods are autolinked: `OuoReplayCore`, `OuoReplay`,
`OuoReactNative`. In this monorepo `examples/ouo-mobile/metro.config.js` also redirects the SDK's
`expo-modules-core` import to the app's copy.

### Delivery and offline (C11)

Every OTLP batch is written to AsyncStorage before it is sent and removed when the collector
answers, so an outage, a crash or a kill mid-request loses nothing. A network error, 429, 502, 503
or 504 (OTLP/HTTP's retryable answers) keeps it: what is left is sent oldest first on the next
launch, when the app comes back to the foreground, on `rum.flush()`, and after a backoff (1 s
doubling to 30 s, `Retry-After` honoured). Any other answer is final: 2xx removes it as sent, and a
4xx or another 5xx (a 500 the collector would give every time) drops it, counted as rejected,
so it never blocks the requests behind it. The store keeps at most 5 MB or 500 requests (the oldest
dropped first) and has no age limit: the device clock can be moved, so an age would drop what is
queued when it jumps forward; what is too old to ingest is the backend's call. If the
stored queue cannot be read at launch (an AsyncStorage error, or no answer within 5 s), that run
keeps its requests in memory and leaves the stored ones for the next launch.
Requests are gzip: the native module compresses and posts them off the JS thread (Hermes has no
`CompressionStream`; iOS and Android); where it is absent (Expo Go, web) they go out through
`fetch`, uncompressed. Replay chunks have the same guarantee on the native side
(`docs/specs/mobile-replay.md`).

```ts
initRUM({
  // ...
  transport: { offline: { maxBytes: 5 * 1024 * 1024 } },  // the default; at most 500 requests
  // transport: { offline: false }  -> retried in this process only, nothing kept for the next launch
});
```

**Next-launch keep/drop** (client-side tail sampling for replay, iOS). With
`replay.keepAtNextLaunch`, chunks stay on the device; at the next launch the hook sees each finished
session and its chunks are sent when it returns `true`, deleted otherwise (a throw keeps them):

```ts
replay: {
  enabled: true,
  keepAtNextLaunch: (s) => s.crashed || s.errors > 0 || s.feedback > 0,  // { sessionId, chunks, bytes, firstChunkAt, lastChunkAt, crashed, errors, feedback }
},
```

A session's replay then arrives one launch later, never during the session itself. Held chunks
beyond 10 MB are deleted, the oldest first. Spans and events are not held.

### Sampling

```ts
initRUM({
  // ...
  session: { sampleRate: 0.5 },                        // half the sessions send anything at all
  replay: { enabled: true, sampleRate: 0.2, onErrorSampleRate: 1 },
});
```

- `session.sampleRate` (default 1): a session outside it sends no spans, events, logs or replay.
- `replay.sampleRate` (default 1): sessions (inside the session sample) recorded from their start.
- `replay.onErrorSampleRate` (default 0): of the sessions left out by `replay.sampleRate`, the
  fraction that start recording at their first error (`captureError`, unhandled errors and
  rejections). The recording covers the rest of the session from the error on: the native recorder
  keeps no buffer of earlier frames.

Each decision is a deterministic hash of the session id (`sampled(id, rate, salt)`, exported), the
same rule rum-api uses for a per-project server-side cap, so a cap below the app's rate keeps a
subset of the app's sample. Details: `docs/operations/data-lifecycle.md`, section 5.

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
  device: { modelIdentifier, modelName, manufacturer, osName, osVersion }, // optional; expo-device is read without it
  resource: { "ouo.rum.mode": "parallel" }, // optional extra resource attributes; the SDK's own win
  errors: { consoleErrors: true, fatalFlushTimeoutMs: 2000, forwardSentryErrors: undefined },
  timeline: { taps: true, tapLabels: true, appLifecycle: true, requests: true, rageTaps: { threshold: 3, windowMs: 1000, radiusPt: 30 }, deadTaps: { timeoutMs: 1000 } },
  vitals: { enabled: true, stalls: true },
  storage: AsyncStorageLike,       // optional, defaults to @react-native-async-storage/async-storage
  debug: false,
});

rum.setUser({ id: "user-1" });
rum.captureError(err, { screen: "Cart" });      // exception, fatal=false, handled=true
rum.addEvent("cart.added", { "product.id": "p-1" });
rum.trackNavigation("/Cart");                   // navigation event + activity
rum.recordActivity();                           // activity without a timeline event
rum.trackTap("checkout-pay");                   // ui.tap on the current screen + activity (RUMProvider does it per touch)
rum.reportFullyDisplayed();                     // the current screen's content is on screen: TTFD
rum.withSpan("checkout", (span) => fetch(url)); // span around fn, ended when its promise settles
const span = rum.startSpan("parse", { parent }); span.end();
rum.log.info("checkout started", { "cart.items": 3 }); // OTel log record, linked to session and span
rum.feedback({ message, contact, screenshot: true }); // feedback event with the last 20 events; returns its id
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
| `Sentry.captureException` and other Sentry error events, with `errors.forwardSentryErrors` | `exception`, `ouo.exception.kind = sentry` | `level == fatal` | Sentry's `mechanism.handled` (default true) |
| native crash (iOS: signal, uncaught NSException; Android: uncaught Java or Kotlin exception, not NDK C/C++ crashes), sent on the next launch | `exception`, `ouo.exception.kind = native` | true | false |
| app hang: the main thread could not draw (iOS) or answer (Android) for 2 s or more, sent when it is over | `exception`, `ouo.exception.kind = hang` | false | false |
| foreground termination (out of memory, watchdog or ANR: killed in the foreground without a crash report; Android from `ApplicationExitInfo`, 11+), sent on the next launch | `exception`, `ouo.exception.kind = termination` | true | false |

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
`errors: { nativeCrashes: false }` (which also turns off hangs and terminations). Only the
crashed thread is recorded, from its frame pointers.
**Android** (`sdk/android` `signals`, ADR-0017): an uncaught exception handler chained to React
Native's writes the report (mechanism `jvm`, Java frames `module.function(file:line)`), a watchdog
reports main-thread hangs, and the next launch reads `ApplicationExitInfo` for foreground
terminations; React Native's `JavascriptException` is the JS fatal and only gives the end time.
**Android NDK (C/C++) crashes are not captured**: no `native` exception and no stack is sent; on
Android 11+ the next launch reports a termination with cause `unknown`, before that nothing.

**App hangs (iOS).** A watchdog thread reads the same `CADisplayLink` frames as the vitals every
400 ms (sentry-cocoa's rules, mobile SDK spec C3): when the main thread drew no frame for 2 s
(fully blocking), or drew some but more than 99 % of 2 s was frame delay, it reads the main
thread's stack, and once frames are back on time it sends one non-fatal `exception` stamped at the
hang's start (a block right after launch or resume, before the first frame, too):
`exception.type = AppHang`, `App hanging for 3.0 s`, `ouo.hang.duration_ms` (the
whole blocked time), `ouo.hang.fully_blocking`, the stack as for a crash (`ouo.crash.frames`,
`ouo.crash.images`, symbolicated from dSYMs). One record per hang however long it lasts; none
while the app is not active (the watchdog then waits without waking) or a debugger is attached.
The session is `errored`.

**Terminations (iOS).** iOS kills an app over its memory limit or one whose main thread does not
answer with `SIGKILL`, which no handler sees. The Expo module keeps `run.json` next to the crash
report current (active or not, the session, a heartbeat every 5 s while active, a memory
warning, a hang in progress). When the previous run was active, left no crash report, did not
receive `willTerminate` or call `exit()`, and neither the app version and build (with the
executable's build UUID), the OS version and build nor the boot time changed,
the next launch reports it as a fatal `exception` (`WatchdogTermination`,
`ouo.termination.cause`: `memory` after a memory warning in its last 60 s, `watchdog` when a hang
was in progress, with that hang's stack, else `unknown`) stamped at its last heartbeat, and its session ends `crash`
there. A kill in the background (a user swipe), an update, a reboot or a debugger run end the
session `terminated`, as before.

**Error context.** Every `exception` carries what you read it with: `ouo.last_events` (the
session's last 20 events before it, as on feedback), `app.screen.name`, `ouo.device.locale`, and
on iOS `ouo.memory.app_bytes`, `ouo.memory.available_bytes` and `network.connection.type`
(`wifi`, `cell`, `wired`, `unavailable`). A native crash or a termination is reported by the next
launch with the screen and last events the crashed run persisted (`ouo.context`: at once after a
tap, a navigation or an exception, else at most 5 s old), without memory or network (not
measured at the crash).

**One error, one record.** An Error object reported by one hook is not reported again by
another (global handler, rejection tracker, `console.error` of the same object, `captureError`,
the Sentry forwarder). For 5 s after a fatal, a fatal with the same type and message (React
dev re-throwing a render error as a new object) and a `console.error` line that contains the
fatal's message (React Native's dev handler printing it) are dropped too: before 0.3.0 they
showed up as a second error after the crashed session's `session.end`, or as `crash_count 2`.

**Trace id on errors.** An `exception` record carries a trace id and span id, and
`ouo.exception.trace_link` says where they came from: `span` (the error escaped from
`withSpan`, or is the rejection of a fetch / XHR), `active_span` (reported while a `withSpan`
callback ran), `failed_request` (a request failed less than 2 s before: the handler that threw
on the 500). Otherwise it has none.

**Stack paths.** `exception.stacktrace` is normalised: per-install paths
(`/private/var/containers/Bundle/Application/<uuid>/App.app/main.jsbundle`, the simulator's
`CoreSimulator/Devices/<uuid>/…`, Metro's `http://host:8081/index.bundle?…`) become
`app:///main.jsbundle:1:2345`, every frame reads `  at fn (file:line:column)` as the Sentry
bridge writes them, and frames of the app's code end with `[in app]` (not native, not
`InternalBytecode`, not `node_modules`), so the same error groups across devices.

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
In dev (`__DEV__`) Metro's `/symbolicate` (LogBox) and `/__sentry/…` (@sentry/react-native's
middleware) calls are not traced either.
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
   To get `Sentry.captureException`, `Sentry.ErrorBoundary` and Sentry's other error events in
   ouo too, opt in with the client (after `Sentry.init`):

   ```js
   initRUM({ /* ... */ errors: { forwardSentryErrors: Sentry.getClient() } });
   ```

   ouo listens to the client's `beforeSendEvent` hook, so it forwards exactly the error events
   Sentry sends (not those dropped by `beforeSend` or `sampleRate`), as `exception` records
   with `ouo.exception.kind = sentry`, `ouo.sentry.event_id` and `ouo.sentry.mechanism`. No
   double reporting: errors ouo captured itself (global handler, forwarded rejections, a
   `console.error` or `captureError` of the same Error object) are skipped, and so are
   `captureMessage`, transactions and other non-error events.
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

## Spans and logs

`rum.startSpan(name, options)` and `rum.withSpan(name, fn, options)` create spans on the SDK's
tracer: every span gets the session attributes and is exported with the request spans.
`options`: `attributes`, `kind` (`SpanKind`), `startTime`, `parent` (a span or span context;
`null` starts a new trace). `withSpan` ends the span when `fn` returns or its promise settles; a
throw or rejection sets the status to error, records the exception on the span and rethrows.

React Native has no async context, so the span is the active one only while `fn` runs
synchronously: requests started there are its children (and the backend joins its trace),
logs and errors reported there carry its trace id. After an `await`, pass it on explicitly:
`rum.startSpan("step", { parent: span })`, `rum.log.info("…", attrs, { span })`. The OTel
global tracer provider is set too, so `trace.getTracer("my-lib")` from `@opentelemetry/api`
works the same way.

`rum.log(level, message, attrs)` or `rum.log.trace|debug|info|warn|error|fatal(message, attrs)`
emits an OTel log record named `log`: body and `message` = the message (`message` truncated to
1 KiB), OTel severity number and text, the attributes, the session attributes and the active
(or given) span's trace id and span id. The Sentry bridge maps `Sentry.logger.*` to the same
record, so rum-api's session logs show both alike. Logs are not session activity.

## Timeline (taps, app lifecycle, requests)

The same events the Sentry bridge derives from Sentry breadcrumbs (`docs/specs/sentry-bridge.md`
section 9a), with the same names and attributes, so the plugin shows both paths alike; a tap also
carries what the bridge cannot know (view type, gesture, screen: spec C6). Each can be turned off
in `timeline`.

| `event.name` | When | Attributes | Body |
|---|---|---|---|
| `ui.tap` | a touch inside `<RUMProvider>` when the finger lifts (stamped at the touch start), or `rum.trackTap(target, path, gesture)` | `ouo.ui.target`: the first label up the touched component tree (`ouo-label`, `sentry-label`, `accessibilityLabel`, `aria-label`, `testID`), else the innermost display name; `ouo.ui.path`: labels and names innermost first, joined with ` > ` (when it differs); `ouo.ui.view_type`: the control's `role` / `accessibilityRole`, else the labelled component (`Pressable`), else the innermost one; `ouo.ui.gesture`: `swipe` (moved 10 pt or more), `long_press` (held 500 ms or more) or `tap`; `app.screen.name`: the current screen | the user step: `Tap add-to-cart (button) on Product` |
| `app.lifecycle` | every `AppState` change | `ouo.app.state`: `foreground`, `inactive`, `background` | `app <state>` |
| `http.request` | a fetch / XHR answered with 1 to 499 | `http.request.method`, `url.full`, `http.response.status_code`; trace id and span id of the request span | `<METHOD> <url>` |

Text content is never read for tap targets (Sentry reads it unless replay masks text). Give
buttons a `testID` or an `accessibilityLabel`, and a `role` for a readable view type. When even
labels must stay on the device, `timeline: { tapLabels: false }` records taps without them:
`ouo.ui.target` is the view type (`Long press button on Cart`) and there is no `ouo.ui.path`. `http.request.failed` keeps its rules and now
carries its span's trace id and span id too.

**Rage and dead taps** ([ADR-0019](../../docs/adr/0019-rage-and-dead-taps.md), spec C6), the
browser SDK's records under the same names, from `RUMProvider`'s touches (`WARN`, identity only,
never text):

| Event | When | Attributes |
|---|---|---|
| `ouo.rage_click` | 3 or more taps on one control, or within 30 pt of the first, within 1 s (one event per burst, at its first tap) | `app.widget.id` (the tap's target), `app.screen.coordinate.x` / `.y`, `ouo.ui.view_type`, `app.screen.name`, `ouo.click.count`, `ouo.click.duration_ms` |
| `ouo.dead_click` | a tap on a control (a button-like `role` or a React Native touchable) after which nothing answered within 1 s of the finger lifting: no navigation, no request, no move to the background and no UI commit (Fabric) | the same, without the counts |

A UI commit is React changing what is on screen; a native press highlight (`TouchableOpacity`) is
not one, a `Pressable` whose style depends on `pressed` re-renders on every press and so never has
dead taps. Dead taps need the new architecture (Fabric) and `initRUM` before the first render;
otherwise they stay off. A control whose only answer is a haptic or a native-driven animation, or
one tapped quickly on purpose (a stepper), opts out of both with `ouo-frustration={false}` on it or
on an ancestor:

```tsx
<Pressable testID="qty-plus" ouo-frustration={false} onPress={increment} />
```

`timeline: { rageTaps: false }` and `timeline: { deadTaps: false }` turn them off.

## Vitals

Per `docs/specs/mobile-vitals.md` (`ouo.vital.source = ouo`; turn off with `vitals: { enabled: false }`):

| `event.name` | Measured how | Needs |
|---|---|---|
| `ouo.stall` | a 50 ms JS timer; an iteration of 100 ms or more is a stall of its excess over 50 ms; one record per window with stalls (`vitals.stalls: false` turns the timer off) | nothing |
| `ouo.screen.display` | TTID: from the navigation state change (`trackNavigation`) to the second animation frame after it; for the first screen, from the process start. TTFD (`ouo.screen.ttfd_ms`) when the app calls `rum.reportFullyDisplayed()` on that screen: to the frame after the call, never below TTID. The record waits for that call until the screen is left, the app goes to the background or 30 s passed | the first screen: the native process start |
| `ouo.app.start` | from the native process start (`cold`; the app image load when iOS prewarmed the process) or the JS runtime's start after a reload (`warm`) to the frame after `<RUMProvider>` mounted (or the first screen's frame), once per run, not when the app was launched in the background | `getAppStartInfo()` in the Expo module (iOS) |
| `app.jank` | `CADisplayLink` frame counters (slow: longer than one frame at the refresh rate minus 1 fps, frozen: 700 ms or more, as sentry-cocoa), diffed per window | `getFrameStats()` in the Expo module (iOS) |

Windows: `app_start` until the first screen, then one per screen visit (`ouo.vital.window =
screen`, `app.screen.name` = the route name, the last segment of the navigation path), closed at
the next navigation or when the app goes to the background. The native measurements are the
`OuoVitals` Swift target of `sdk/ios`, which the Expo module starts when it is created: one
`CADisplayLink` callback per frame that only updates counters (main-thread cost in
`project/kb/ios-vitals.md`). Without the native measurements (Expo Go, web, Android until W9 part 2) the SDK
emits no `ouo.app.start`, no `app.jank` and no first-screen TTID (spec rule 1: nothing that was
not measured).

## Device

Without a `device` option the SDK reads expo-device's native constants from the Expo module
registry when the app has `expo-device` installed (no import, no app code): `modelId` ->
`device.model.identifier` (`iPhone17,2`), `modelName` -> `device.model.name`, `manufacturer`.
On the simulator expo-device answers the CPU (`arm64`), which is not a model: the SDK sets
`ouo.device.simulator = true` instead. Values passed in `device` win.

## Feedback (C10)

`rum.feedback({ message, contact?, screenshot? })` sends what the user wrote as one `feedback`
event on the current session. Build the form yourself (a widget comes later); pass the text the
user typed:

```ts
const id = rum.feedback({ message: text, contact: email, screenshot: true });
```

| Attribute | Value |
|---|---|
| body, `ouo.feedback.message` | the message, trimmed; above 4096 bytes of UTF-8 cut to whole characters plus `…` (as the Sentry bridge cuts); an empty message sends nothing and returns `undefined` |
| `ouo.feedback.contact` | the contact, when not empty (same cut) |
| `ouo.feedback.id` | a UUID, also the return value |
| `ouo.feedback.screenshot` | `true` when `screenshot: true` and replay was recording: the recorder was asked, right after the record, for a frame of the current screen, masked like every frame, so the session's replay shows it just after the feedback time. No separate image is sent |
| `ouo.last_events` | JSON array, by time oldest first, of the session's last 20 events and log lines before the feedback: `{"ts": <epoch ms>, "name": "ui.tap", "body": "Tap pay (button) on Cart"}`; the body is the readable step (the path of a navigation, `Type: message` of an error, `METHOD url status` of a request), cut at 200 bytes the same way |

The feedback follows the session's sampling like every record. With `replay.keepAtNextLaunch`,
keep the sessions with `feedback > 0`: their replay is the feedback's screenshot. The plugin lists a session's
feedback beside its replay, with these events and a link to the replay at the feedback time.

## Events (OTel log records, `event.name`)

`session.start`, `session.end` (`ouo.session.end_reason`, `ouo.session.duration_ms`,
`ouo.session.started_at`, `ouo.session.ended_at`), `exception`, `http.request.failed`,
`navigation` (`url.path`, `ouo.navigation.from`, `ouo.navigation.kind = screen`), `ui.tap`, `app.lifecycle`, `http.request`,
`log`, `feedback`, `ouo.replay.hidden` (`ouo.replay.hidden_reason`: `screen`, `manual`), the vitals `ouo.app.start`, `ouo.screen.display`, `app.jank`, `ouo.stall`, custom events
from `addEvent` (`ouo.event.custom=true`). Every span and log record carries `session.id`,
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
