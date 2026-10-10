# Changelog

All notable changes to `@ouo/browser`. The format follows Keep a Changelog; versions follow SemVer (0.x: minor bumps may break).

## 0.2.0 - 2026-10-10

Ingest gateway and project tokens (ADR-0007). The SDK now talks to one host, rum-api, and authenticates every request with a public project token.

### Breaking

- `endpoint` is now the **rum-api base URL** (for example `https://rum.example.com`), not the collector's OTLP/HTTP base. The SDK derives `${endpoint}/ingest/otlp/v1/traces`, `${endpoint}/ingest/otlp/v1/logs` and `${endpoint}/v1/replay/chunks` from it.
- `projectToken: string` is **required**. `initRUM` throws `[ouo] initRUM: \`projectToken\` is required ...` when it is missing or empty, before any provider, listener or storage write happens. The token is a public project identifier, not a secret.
- `replayEndpoint` is **removed**. Replay chunks always go to `${endpoint}/v1/replay/chunks`; replay is on unless `replay.enabled: false`. (In 0.1.x replay was silently disabled when `replayEndpoint` was absent.)
- The debug init line changed shape: it prints `endpoint`, `traces`, `logs`, `replay`, `otlpBypass`, `session`, `user` (never the token).

### Added

- `otlpEndpoint?: string` escape hatch for trusted in-network apps: when set, OTLP goes to `${otlpEndpoint}/v1/traces` and `/v1/logs` instead of through rum-api. The token header is still sent. Replay is unaffected.
- `X-Ouo-Project-Token` header on the OTLP trace and log exporters (exporter `headers` option) and on every replay chunk upload, including the `pagehide` keepalive path.
- Exports `deriveIngestUrls`, `PROJECT_TOKEN_HEADER` and the `IngestUrls` type for tooling and tests.
- Package metadata for publishing (`repository`, `homepage`, `bugs`, `keywords`, `publishConfig`); `CHANGELOG.md` and `LICENSE` ship in the tarball.

### Changed

- `tracing.ignoreUrls` built-ins now cover `${otlpBase}/` and `${endpoint}/v1/replay/` instead of the whole `endpoint` origin.

### Migration

```diff
 initRUM({
-  endpoint: "http://localhost:4318",
-  replayEndpoint: "http://localhost:8080",
+  endpoint: "http://localhost:8080",
+  projectToken: "pt_dev_demo_0000000000000000",
   service: { name: "web-store", version: "1.4.2", environment: "local" },
 });
```

rum-api must be 0.2.0 or later (it answers `/ingest/otlp/*` and requires the token). The collector no longer needs browser CORS or a public port.

## 0.1.0 - 2026-10-06

First release: sessions, errors, fetch/XHR tracing with W3C Trace Context and Baggage, Web Vitals, navigation events, rrweb replay chunks. OTLP straight to a collector; replay to rum-api via `replayEndpoint`.
