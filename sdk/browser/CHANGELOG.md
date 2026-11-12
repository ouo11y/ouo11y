# Changelog

All notable changes to `@ouo11y/browser` (named `@ouo/browser` until 2026-10-18). The format follows Keep a Changelog; versions follow SemVer (0.x: minor bumps may break).

## [0.4.0](https://github.com/ouo11y/ouo11y/compare/browser-v0.3.1...browser-v0.4.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **browser:** rebuild the web SDK on the client SDK spec (ADR-0020) ([#182](https://github.com/ouo11y/ouo11y/issues/182))
* **browser:** mask all replay text by default, ouo-unmask, never-record routes and screens

### Added

* **browser:** mask all replay text by default, ouo-unmask, never-record routes and screens ([3af96e4](https://github.com/ouo11y/ouo11y/commit/3af96e42e1ed199c31989d907b57bfaf0ca6ca96))
* **browser:** rebuild the web SDK on the client SDK spec (ADR-0020) ([#182](https://github.com/ouo11y/ouo11y/issues/182)) ([533131d](https://github.com/ouo11y/ouo11y/commit/533131dec2dfcb48cde67999862dca819b3a2909))

## [0.3.1](https://github.com/ouo11y/ouo11y/compare/browser-v0.3.0...browser-v0.3.1) (2026-11-01)

### Fixed

- `ouo.sdk.version` (and the OTel logger and tracer version, and the init log) reports the package
  version: 0.3.0 reported 0.2.0, because `src/version.ts` was kept by hand. release-please now bumps
  it with `package.json`, and a test fails when the two differ
  ([cd65004](https://github.com/ouo11y/ouo11y/commit/cd650047d988ca57584eb5bea50ee2d72e807ca3)).
  Queries that filter on `ouo.sdk.version` see 0.2.0 for sessions sent by 0.3.0.

## [0.3.0](https://github.com/ouo11y/ouo11y/compare/browser-v0.2.1...browser-v0.3.0) (2026-10-25)


### Added

* **browser:** delivery that does not lose telemetry: retry, gzip, page-hide keepalive, offline store (N36 part A) ([#66](https://github.com/ouo11y/ouo11y/issues/66)) ([e7c92c8](https://github.com/ouo11y/ouo11y/commit/e7c92c8a828a6b311db1a71f7d6dc8896c7bf248))
* **browser:** never break the host page, ES2022 floor, fault and CSP e2e, 1 h soak (N36 part B) ([#72](https://github.com/ouo11y/ouo11y/issues/72)) ([775757e](https://github.com/ouo11y/ouo11y/commit/775757ec5bf555099f03a5c03068007590fc76c1))
* **browser:** rotate the session on user change, endSession, clearUser, device.id (N45) ([#80](https://github.com/ouo11y/ouo11y/issues/80)) ([60c103f](https://github.com/ouo11y/ouo11y/commit/60c103f8b7491bd7105e4b97f2c9c69c2f7813cc))
* source maps and symbolication for minified web stacks (N36 part C, ADR-0011) ([#64](https://github.com/ouo11y/ouo11y/issues/64)) ([9a41831](https://github.com/ouo11y/ouo11y/commit/9a41831b67b58831672662f838608fbb06776f25))

## 0.2.1 - 2026-10-24

### Changed

- Published publicly on npmjs.org (`npm install @ouo11y/browser`), released from CI through npm trusted publishing. No code changes since 0.2.0.

## 0.2.0 - unreleased

The OpenTelemetry Collector is the only edge (ADR-0007). The SDK posts OTLP straight to `ouo-collector` and replay chunks to its replay receiver, and authenticates every request with HTTP Basic project credentials. Nothing from the earlier 0.2.0 draft (rum-api `/ingest/otlp`, `X-Ouo-Project-Token`) was released.

### Breaking

- Package renamed `@ouo/browser` -> `@ouo11y/browser` (ADR-0009; never published under the old name). `ouo.sdk.name` and the OTel instrumentation scope name are `@ouo11y/browser`; data stored before the rename keeps `@ouo/browser`.
- `projectId: string` and `projectToken: string` are **required**. Every ingest request (OTLP and replay) carries `Authorization: Basic base64(projectId + ":" + projectToken)`. `initRUM` throws `[ouo] initRUM: \`projectId\` is required ...` / `\`projectToken\` is required ...` when either is missing or empty (and when the id contains `:`), before any provider, listener or storage write happens. The token is a public project identifier, not a secret.
- `endpoint` is the **collector OTLP/HTTP base** (for example `https://otel.example.com` or `http://localhost:4318`); OTLP goes to `${endpoint}/v1/traces` and `/v1/logs`. In 0.1.x it was the same URL without authentication.
- `replayEndpoint` is now **optional** and points at the collector's replay receiver, not rum-api. Default: when `endpoint` uses port `4318`, the same scheme and host on port `4319`; otherwise `endpoint` itself (a reverse proxy routing `/v1/replay/*`). Chunks go to `${replayEndpoint}/v1/replay/chunks`. Replay is on unless `replay.enabled: false` (in 0.1.x it was silently disabled when `replayEndpoint` was absent).
- The debug init line changed shape: `endpoint`, `replayEndpoint`, `traces`, `logs`, `replay`, `projectId`, `session`, `user` (never the token or the header value).

### Added

- `Authorization` header on the OTLP trace and log exporters (exporter `headers` option) and on every replay chunk upload, including the `pagehide` keepalive path.
- Exports `deriveIngestUrls`, `deriveReplayEndpoint`, `basicAuthorization` and the `IngestUrls` type for tooling and tests.
- Package metadata for publishing (`repository`, `homepage`, `bugs`, `keywords`, `publishConfig`); `CHANGELOG.md` and `LICENSE` ship in the tarball.

### Changed

- `tracing.ignoreUrls` built-ins cover `${endpoint}/v1/` and `${replayEndpoint}/v1/replay/`.

### Migration

```diff
 initRUM({
   endpoint: "http://localhost:4318",
-  replayEndpoint: "http://localhost:8080",
+  projectId: "demo",
+  projectToken: "pt_dev_demo_0000000000000000",
   service: { name: "web-store", version: "1.4.2", environment: "local" },
 });
```

The stack must run `ouo-collector` (basicauth on the OTLP receiver, replay receiver on 4319) with the browser origin in the collector's CORS `allowed_origins` and `Authorization` in its allowed headers. rum-api is internal and no longer reachable from the browser.

## 0.1.0 - 2026-10-06

First release: sessions, errors, fetch/XHR tracing with W3C Trace Context and Baggage, Web Vitals, navigation events, rrweb replay chunks. OTLP straight to a collector; replay to rum-api via `replayEndpoint`.
