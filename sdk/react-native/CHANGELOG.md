# Changelog

## 0.2.0 (unreleased)

Phase 8a, ADR-0007 (the collector is the edge, project tokens as HTTP Basic). The SDK talks to
the `ouo-collector` OpenTelemetry Collector distribution only: OTLP/HTTP for traces and events,
its `ouoreplay` receiver for replay chunks. rum-api is internal and never addressed by the SDK.

### Breaking changes

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
