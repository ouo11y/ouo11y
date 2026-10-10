# Changelog

## 0.2.0 (2026-10-10)

Phase 8a, ADR-0007 (ingest gateway and project tokens). The SDK now talks only to rum-api; the
OpenTelemetry Collector is no longer reachable from devices.

### Breaking changes

- `initRUM({ endpoint })` is now the **rum-api base URL** (for example `https://rum.example.com`
  or `http://localhost:8080`), not the collector's OTLP/HTTP URL. The SDK derives
  `${endpoint}/ingest/otlp/v1/traces`, `${endpoint}/ingest/otlp/v1/logs` and
  `${endpoint}/v1/replay/chunks`.
- `initRUM({ projectToken })` is **required**. It is sent as `X-Ouo-Project-Token` on every OTLP
  export and on every replay chunk upload; `initRUM` throws a `TypeError` naming the option when
  it is missing or empty (rum-api would answer 401 on every request otherwise).
- `replayEndpoint` is removed, together with the "same host, port 8080" default. Replay chunks
  always go to `${endpoint}/v1/replay/chunks`.
- `defaultReplayEndpoint()` is no longer exported. `resolveEndpoints({ endpoint, otlpEndpoint })`
  and `PROJECT_TOKEN_HEADER` are exported instead.
- `NativeStartOptions` (the record the Expo module `start(endpoint, options)` receives) gains
  the required `projectToken`. The Swift `OuoReplayConfig` initialiser gains a required
  `projectToken:` parameter after `endpoint:`, `ChunkUploader.init` and `ChunkUploader.makeRequest`
  take `projectToken:`, and every upload request carries `X-Ouo-Project-Token`.

### Added

- `initRUM({ otlpEndpoint })`: escape hatch for a trusted in-network app that may post OTLP
  straight to a collector (`${otlpEndpoint}/v1/traces|logs`, token header still sent). Replay
  stays on rum-api.
- Package metadata for publishing: `exports`, `repository`, `homepage`, `bugs`, `keywords`,
  `publishConfig`, `prepack` (builds and vendors the Swift sources), `CHANGELOG.md` in `files`,
  `ios/.npmignore` so the vendored Swift copies ship in the tarball.

### Migration

```diff
 initRUM({
-  endpoint: "http://localhost:4318",
-  replayEndpoint: "http://localhost:8080",
+  endpoint: "http://localhost:8080",
+  projectToken: "pt_dev_demo_0000000000000000",
   service: { name: "mobile-store", version: appVersion, environment: "local" },
   replay: { enabled: true },
 });
```

Native hosts of the Swift package: `OuoReplayConfig(endpoint: url, projectToken: "pt_…", sessionId: …)`.

## 0.1.0 (2026-10-08)

First version: sessions, errors and crashes, fetch tracing with W3C Trace Context and Baggage,
OTLP/HTTP export, native iOS session replay through the `OuoReplay` Expo module (ADR-0006),
masking opt-out (`maskText`, `maskInputs`, `maskImages`, `maskWebViews`).
