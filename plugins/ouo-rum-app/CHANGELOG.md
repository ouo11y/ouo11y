# Changelog

Every user-visible change bumps `version` in `package.json` (it becomes `plugin.json`'s version and the
`module.js?_cache=<version>` query string, so browsers drop the cached bundle).

## 0.3.0 (Phase 8a, 2026-10-10)

- Read token (ADR-0007 section 6): the `rum/*` route adds `Authorization: Bearer {{ .SecureJsonData.readToken }}`
  server-side, so rum-api's `OUO_READ_TOKEN` never reaches the browser.
- Configuration page: `rumApiUrl` (jsonData) and write-only `readToken` (secureJsonData, "configured / Reset"),
  saved through `POST /api/plugins/ouo-rum-app/settings`; "Test connection" probes `rum/healthz` and
  `rum/v1/stats/health?from=now-1h` through the proxy and reports 200 / 401 ("read token rejected by rum-api").
- Overview, Sessions and Session detail show one "rum-api rejected the read token" banner with a link to the
  plugin settings when rum-api answers 401, instead of an empty table.
- Tests: config page save (jsonData + secureJsonData, keep-unless-reset), connection test, 401 banner, client
  error mapping (62 Jest tests).

## 0.2.1 (Phase 7b)

- Pinned replay with self-scrolling timeline, Replay duration column, sortable sessions table.

## 0.2.0 (Phase 7b)

- Version bump so browsers drop the cached `module.js` after the Phase 7b rebuild.

## 0.1.0 (Phase 4 to 7)

- Overview, Sessions and Session detail pages (timeline, traces with Explore links, rrweb replay with markers,
  native frame replay) backed by rum-api through the `rum/*` plugin route.
