# grafana-plugin tracker

| Date | Item | Status |
|---|---|---|
| 2026-10-07 | Scaffold `plugins/ouo11y-rum-app` (create-plugin 7.12.1, frontend only), workspace install | done |
| 2026-10-07 | Route proxy `rum/*` -> `jsonData.rumApiUrl`, provisioning yaml, compose volume, config page | done, verified with curl |
| 2026-10-07 | Overview page (tiles + version tables, time range in URL) | done, numbers match rum-api |
| 2026-10-07 | Sessions page (filters in URL, table, row click) | done, verified in browser |
| 2026-10-07 | Session detail (timeline, traces + Explore, rrweb-player + markers sync) | done, verified in browser |
| 2026-10-07 | Tests (format, markers), typecheck, lint, build | done |
| 2026-10-07 | project/kb/grafana-app-plugin.md, deploy/README.md, project/tracker/mvp.md Phase 4, HTML report | done |
| open | Replace deprecated `Select` with `Combobox`; Playwright e2e | todo (post-MVP) |
| 2026-10-08 | Phase 7 frame player: code + 34 tests landed; visual check in Grafana pending | done: frames played in Grafana during the Phase 7 native verification (ios-replay tracker), merged in #9 (N1 2026-10-17) |
| 2026-10-08 | Phase 7b: sticky replay + self-scrolling timeline, Replay duration column, sortable sessions table (52 tests, browser-verified, `project/reports/phase-7b-ux.html`) | done |
| 2026-10-10 | Phase 8a: read token via `secureJsonData.readToken` + route `Authorization` header, config page with SecretInput and Test connection, 401 banner with settings link, version 0.3.0 + CHANGELOG, 62 Jest tests, build green; live checks handed to qa | done (code), qa pending |
| 2026-10-14 | Sentry bridge S4 part 1: video replay player (`VideoPlayer`, shared clock + touch overlay), `video` kind in renderer/table, plugin 0.4.0 + CHANGELOG, 97 Jest tests, build green, live-verified in `ouo-sb` (`project/reports/s4-video-player.html`) | done |
| 2026-10-16 | Taps in Sentry replays: merged taps (touches + `ui.tap`), tap indicator, `tap` scrubber markers, activity list beside the player, plugin 0.6.0, 119 Jest tests, live on a real-tap session in `ouo-taps` (`project/reports/sentry-taps.html`) | done |
| 2026-10-23 | Bridge parity: C1 stack traces, C2 header, C3 frames taps, C4 clamp, C6 trace names, C7 exception log line, C8 masking (rum-api `masked`), B1 `sessionTimelinePanel` toggle, F4 seek hold + one clock; plugin 0.8.0, 155 Jest tests, live before/after in `b1-plugin-bridge` (`reports/b1-bridge-parity.html`) | done, PR pending |
