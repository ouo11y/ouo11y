# Changelog

## Unreleased

Bridge parity (checklist section 3: G2 to G6, Q1). Everything is in the JS SDK; the vitals that
need native measurements read optional functions of the Expo module that its native side does
not have yet.

### Added

- **Span API** (G3): `rum.startSpan(name, { attributes, kind, startTime, parent })` and
  `rum.withSpan(name, fn, options)` on the SDK's tracer, with the session attributes. A
  synchronous context manager makes the `withSpan` span active while `fn` runs: requests,
  logs and errors inside join its trace.
- **Log API** (G3): `rum.log(level, message, attrs)` and `rum.log.trace|debug|info|warn|error|fatal`,
  OTel log records named `log` (as the Sentry bridge maps `Sentry.logger.*`), with severity,
  `message`, the session attributes and the active span's trace id.
- **Timeline** (G4), with the Sentry bridge's names and attributes (spec section 9a): `ui.tap`
  from `RUMProvider` touches (`ouo.ui.target`, `ouo.ui.path` from `ouo-label`, `sentry-label`,
  `accessibilityLabel`, `aria-label`, `testID` or display names) and `rum.trackTap(target, path)`;
  `app.lifecycle` (`ouo.app.state` `foreground`, `inactive`, `background`); `http.request` for
  answered requests below 500 with the request span's trace id. Option `timeline: { taps,
  appLifecycle, requests }` (all default true).
- **Vitals** (G2, `docs/specs/mobile-vitals.md`): `ouo.stall` (50 ms JS loop) and
  `ouo.screen.display` (TTID per screen) measured in JS; `ouo.app.start` and `app.jank` from the
  Expo module's `getAppStartInfo()` / `getFrameStats()` when its native side has them. Option
  `vitals: { enabled, stalls }`.
- **Sentry forwarding** (G6, opt-in): `errors: { forwardSentryErrors: Sentry.getClient() }` turns
  every error event Sentry sends into an ouo `exception` (`ouo.exception.kind = sentry`,
  `ouo.sentry.event_id`, `ouo.sentry.mechanism`), skipping errors ouo captured itself and
  `captureMessage`.
- **Device model without app code** (G5): expo-device's native constants are read from the Expo
  module registry when the app has expo-device; `ouo.device.simulator = true` on the simulator.
- **Trace id on errors** (G5): `exception` records carry the trace id and span id of the span the
  error escaped from, the active span, or a request that failed less than 2 s before, and
  `ouo.exception.trace_link` (`span`, `active_span`, `failed_request`).
- `http.request.failed` carries its request span's trace id and span id.
- Exports: `normalizeStack`, `touchedComponent`.

### Changed

- **Stack paths** (G5): `exception.stacktrace` frames are rewritten to `app:///<bundle>:line:col`
  (no per-install container UUIDs, no Metro host or query), one `  at fn (file:line:col)` per
  frame, `[in app]` on the app's own frames.
- Records emitted for timeline events have readable bodies (`GET <url>`, `app background`) like
  the bridge's; vitals have an empty body (spec section 1).

### Fixed

- **Q1**: one fatal error is one `exception`. React Native's dev handler printing the fatal
  through `console.error` produced a second error after the crashed session's `session.end`, and
  React dev re-throwing a render error as a new object counted a second crash (`crash_count 2`).
  An Error object reported by one hook is no longer reported by another (rejection tracker,
  `console.error` of the same object, `captureError`, the Sentry forwarder).
- Dev builds no longer trace Metro's `/symbolicate` and `/__sentry/…` calls (LogBox and Sentry's
  middleware): they were spans and `http.request` events after a crashed session's `session.end`.

## 0.2.0 (unreleased)

Phase 8a, ADR-0007 (the collector is the edge, project tokens as HTTP Basic). The SDK talks to
the `ouo-collector` OpenTelemetry Collector distribution only: OTLP/HTTP for traces and events,
its `ouoreplay` receiver for replay chunks. rum-api is internal and never addressed by the SDK.

### Breaking changes

- Package renamed `@ouo/react-native` -> `@ouo11y/react-native` (ADR-0009; never published under the old
  name). `ouo.sdk.name` and the OTel instrumentation scope name are `@ouo11y/react-native`; data stored
  before the rename keeps `@ouo/react-native`. The CocoaPods specs (`OuoReactNative`, `OuoReplay`,
  `OuoReplayCore`) keep their names and point at `github.com/ouo11y/ouo11y`.
- `initRUM({ endpoint })` is the **collector OTLP/HTTP base URL** (for example
  `https://otel.example.com` or `http://localhost:4318`). The SDK posts to `${endpoint}/v1/traces`
  and `${endpoint}/v1/logs`.
- `initRUM({ projectId, projectToken })` are **both required**. Every OTLP export and every replay
  chunk upload carries `Authorization: Basic base64("<projectId>:<projectToken>")`, which the
  collector's `basicauth` extension validates (user name = project id, password = token).
  `initRUM` throws a `TypeError` naming the option when either is missing or empty, or when
  `projectId` contains `:` (the collector would answer 401 on every request otherwise). The
  `X-Ouo-Project-Token` header of the first 0.2.0 draft is never sent.
- `initRUM({ replayEndpoint })` is back, optional: the base URL of the collector's replay receiver,
  chunks go to `${replayEndpoint}/v1/replay/chunks`. Default: `endpoint` with port 4318 replaced
  by 4319 (the receiver's default port), or `endpoint` itself for any other port or no port (a
  proxy such as `https://otel.example.com` routes `/v1/replay/*` to the receiver). The 0.1.0
  default (OTLP host on port 8080) is gone.
- `otlpEndpoint` (first 0.2.0 draft) is removed; `endpoint` is the collector.
- Exports: `resolveEndpoints({ endpoint, replayEndpoint })`, `defaultReplayEndpoint(endpoint)`,
  `basicAuthorization(projectId, projectToken)`, `base64Encode`, `AUTHORIZATION_HEADER`,
  `DEFAULT_OTLP_PORT` (4318), `DEFAULT_REPLAY_PORT` (4319). `PROJECT_TOKEN_HEADER` and the
  0.1.0 `defaultReplayEndpoint()` (port 8080) are gone.
- `NativeStartOptions` (the record the Expo module `start(endpoint, options)` receives) gains the
  required `projectId` and `projectToken`; the native uploader builds the Basic header itself.
  Swift: `OuoReplayConfig(endpoint:projectId:projectToken:sessionId:...)` (`projectId:` is new,
  `endpoint` is the replay receiver base URL), `OuoReplayConfig.authorization` (computed),
  `ChunkUploader.init(endpoint:projectId:projectToken:...)`,
  `ChunkUploader.makeRequest(url:authorization:sessionId:seq:gzipBody:)`,
  `ChunkUploader.basicAuthorization(projectId:projectToken:)`, `ChunkUploader.authorizationHeader`
  (`"Authorization"`); `projectTokenHeader` is gone. The Expo module throws
  `ERR_OUO_REPLAY_CREDENTIAL` when either id is empty (replaces `ERR_OUO_REPLAY_TOKEN`).

### Added

- `initRUM({ resource })`: extra resource attributes on every span and log record, for example
  the rollout cohort `{ "ouo.rum.mode": "parallel" }`. The SDK's own attributes win on a clash.
- `XMLHttpRequest` instrumentation: axios and other XHR clients get the same `CLIENT` spans,
  propagation and `http.request.failed` as `fetch`. The XHR that React Native's `fetch` opens is
  skipped (one span per fetch), and `traceparent` is never added twice.
- `errors.onUnhandledRejection(error)`: called with every unhandled promise rejection after ouo
  recorded it. Hermes keeps one rejection tracker (the SDK initialised last owns it) and
  `HermesInternal` is frozen, so next to Sentry the SDK is initialised after Sentry and forwards
  rejections to `Sentry.captureException`. Debug-mode warning when a Sentry client exists and
  nothing forwards. README "Next to Sentry".

- A small RFC 4648 base64 encoder (UTF-8 input) so the header value is built the same way on
  every React Native runtime; `btoa` is not guaranteed on Hermes and `Buffer` does not exist
  there.
- Package metadata for publishing: `exports`, `repository`, `homepage`, `bugs`, `keywords`,
  `publishConfig`, `prepack` (builds and vendors the Swift sources), `CHANGELOG.md` in `files`,
  `ios/.npmignore` so the vendored Swift copies ship in the tarball.

### Migration from 0.1.0

```diff
 initRUM({
-  endpoint: "http://localhost:4318",
-  replayEndpoint: "http://localhost:8080",
+  endpoint: "http://localhost:4318",          // collector OTLP/HTTP; replay defaults to :4319
+  projectId: "demo",
+  projectToken: "pt_dev_demo_0000000000000000",
   service: { name: "mobile-store", version: appVersion, environment: "local" },
   replay: { enabled: true },
 });
```

Behind a proxy that serves both receivers from one host nothing else is needed:
`endpoint: "https://otel.example.com"` sends replay chunks to
`https://otel.example.com/v1/replay/chunks`. Pass `replayEndpoint` only when the replay receiver
lives somewhere else.

Native hosts of the Swift package:
`OuoReplayConfig(endpoint: URL(string: "http://localhost:4319")!, projectId: "demo", projectToken: "pt_…", sessionId: …)`.

A stock OpenTelemetry SDK can post to the same collector without ouo code:
`OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com` and
`OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64>`.

## 0.1.0 (2026-10-08)

First version: sessions, errors and crashes, fetch tracing with W3C Trace Context and Baggage,
OTLP/HTTP export, native iOS session replay through the `OuoReplay` Expo module (ADR-0006),
masking opt-out (`maskText`, `maskInputs`, `maskImages`, `maskWebViews`).
