# grafana-plugin

> rum-api, the MVP Grafana plugin (`ouo11y-rum-app`) and the MVP replay path (`ouoreplay` receiver/exporter, :4319) were removed on 2026-11-15 (refactor!: remove rum-api, the MVP plugin and the MVP replay path). Text below that names them is the record of that time.

Owns `plugins/ouo11y-rum-app` (Grafana app plugin: Overview, Sessions, Session detail with replay).

- [tracker.md](tracker.md)
- `summaries/`
  - [2026-10-07-phase-4.md](summaries/2026-10-07-phase-4.md) Phase 4: plugin built, proxied, provisioned, verified in Grafana 13.2.1
  - [2026-10-08-phase-7b.md](summaries/2026-10-08-phase-7b.md) Phase 7b: pinned replay with self-scrolling timeline, Replay duration column, sortable sessions table
  - [2026-10-10-phase-8a.md](summaries/2026-10-10-phase-8a.md) Phase 8a: read token (secureJsonData + route header), config page with Test connection, 401 banner, plugin 0.3.0
  - [2026-10-14-video-player.md](summaries/2026-10-14-video-player.md) Sentry bridge S4 part 1: video replay player (mp4 segments via the plugin proxy, Range passes through), plugin 0.4.0
  - [2026-10-16-sentry-taps.md](summaries/2026-10-16-sentry-taps.md) taps in Sentry replays: root cause, tap indicator, tap markers, activity list beside the player, plugin 0.6.0
  - [2026-10-23-bridge-parity.md](summaries/2026-10-23-bridge-parity.md) plugin 0.8.0: C1 to C8, B1 Timeline toggle, F4 seek and one clock; rum-api `masked`, `context`, `root_url_path`
  - [2026-11-04-n30-viewer-delete.md](summaries/2026-11-04-n30-viewer-delete.md) N30: proxy routes split per method, replay DELETE for org Admins only, unrouted methods 404
- `project/reports/`
  - [phase-4-verification.html](reports/phase-4-verification.html) browser verification with screenshots (overview numbers, sessions, detail, replay seek and masking, Explore link, error and empty states)
  - [phase-7b-ux.html](reports/phase-7b-ux.html) Phase 7b browser verification: sticky replay, timeline scroll, stacked layout, sortable headers, Replay column (`7b-*.jpg`)
  - [s4-video-player.html](reports/s4-video-player.html) S4 video player browser verification in `ouo-sb`: real Sentry iOS segments, seek/markers/timeline, touches, error path, Range/206 (`s4-*.jpg`)
  - [sentry-taps.html](reports/sentry-taps.html) taps in Sentry replays, verified on a real-tap simulator session in `ouo-taps` (`taps-*`)
  - [b1-bridge-parity.html](reports/b1-bridge-parity.html) plugin 0.8.0 before / after in `ouo-env` `b1-plugin-bridge`: C1 to C4, C6 to C8, B1 toggle off and on, F4 seek and clock (`b1-*.jpg`)
  - `*.jpg` the screenshots referenced by the reports
