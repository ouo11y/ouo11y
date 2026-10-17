# grafana-plugin

Owns `plugins/ouo11y-rum-app` (Grafana app plugin: Overview, Sessions, Session detail with replay).

- [tracker.md](tracker.md)
- `summaries/`
  - [2026-10-07-phase-4.md](summaries/2026-10-07-phase-4.md) Phase 4: plugin built, proxied, provisioned, verified in Grafana 13.2.1
  - [2026-10-08-phase-7b.md](summaries/2026-10-08-phase-7b.md) Phase 7b: pinned replay with self-scrolling timeline, Replay duration column, sortable sessions table
  - [2026-10-10-phase-8a.md](summaries/2026-10-10-phase-8a.md) Phase 8a: read token (secureJsonData + route header), config page with Test connection, 401 banner, plugin 0.3.0
  - [2026-10-14-video-player.md](summaries/2026-10-14-video-player.md) Sentry bridge S4 part 1: video replay player (mp4 segments via the plugin proxy, Range passes through), plugin 0.4.0
  - [2026-10-16-sentry-taps.md](summaries/2026-10-16-sentry-taps.md) taps in Sentry replays: root cause, tap indicator, tap markers, activity list beside the player, plugin 0.6.0
- `project/reports/`
  - [phase-4-verification.html](reports/phase-4-verification.html) browser verification with screenshots (overview numbers, sessions, detail, replay seek and masking, Explore link, error and empty states)
  - [phase-7b-ux.html](reports/phase-7b-ux.html) Phase 7b browser verification: sticky replay, timeline scroll, stacked layout, sortable headers, Replay column (`7b-*.jpg`)
  - [s4-video-player.html](reports/s4-video-player.html) S4 video player browser verification in `ouo-sb`: real Sentry iOS segments, seek/markers/timeline, touches, error path, Range/206 (`s4-*.jpg`)
  - [sentry-taps.html](reports/sentry-taps.html) taps in Sentry replays, verified on a real-tap simulator session in `ouo-taps` (`taps-*`)
  - `*.jpg` the screenshots referenced by the reports
