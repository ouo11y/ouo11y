# grafana-plugin tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-07 | Scaffold `plugins/ouo-rum-app` (create-plugin 7.12.1, frontend only), workspace install | done |
| 2026-10-07 | Route proxy `rum/*` -> `jsonData.rumApiUrl`, provisioning yaml, compose volume, config page | done, verified with curl |
| 2026-10-07 | Overview page (tiles + version tables, time range in URL) | done, numbers match rum-api |
| 2026-10-07 | Sessions page (filters in URL, table, row click) | done, verified in browser |
| 2026-10-07 | Session detail (timeline, traces + Explore, rrweb-player + markers sync) | done, verified in browser |
| 2026-10-07 | Tests (format, markers), typecheck, lint, build | done |
| 2026-10-07 | kb/grafana-app-plugin.md, deploy/README.md, tracker/mvp.md Phase 4, HTML report | done |
| open | Replace deprecated `Select` with `Combobox`; Playwright e2e | todo (post-MVP) |
| 2026-10-08 | Phase 7 frame player: code + 34 tests landed; visual check in Grafana pending | review |
| 2026-10-08 | Phase 7b: sticky replay + self-scrolling timeline, Replay duration column, sortable sessions table (52 tests, browser-verified, `reports/phase-7b-ux.html`) | done |
| 2026-10-10 | Phase 8a: read token via `secureJsonData.readToken` + route `Authorization` header, config page with SecretInput and Test connection, 401 banner with settings link, version 0.3.0 + CHANGELOG, 62 Jest tests, build green; live checks handed to qa | done (code), qa pending |
