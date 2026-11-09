# 2026-10-16 grafana-plugin: taps in Sentry-sourced replays

Ask (founder, via the orchestrator session): in a Sentry-sourced (`video`) replay, taps must show at least as
clearly as in Sentry's player, on the video and in a list beside it with click-to-seek.

## Root cause (evidence in `project/kb-archive/sentry-replay-taps.md`)

- Not the SDK, not the receiver: real simulator taps give rrweb touch events (source 2 type 7/9, source 6 moves) in
  video points and `ui.tap` breadcrumbs 80 to 150 ms after each touch start. New golden capture
  `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/realtap` (39 requests, 1.3 MB) and
  `TestGoldenRealTap` pin it. No receiver code changed.
- Test data: `examples/sentry-mobile/scripts/journey.sh` makes no UIKit touch (mailbox / deep links), so its
  replays have neither touches nor `ui.tap`. Header comment added.
- Plugin: `ui.tap` (`type: custom`) was not a marker kind; no list beside the player; the dot faded from 0 ms and
  doubled for start/end. Scaling and timing were correct (re-measured).

## Done

- `src/utils/taps.ts`: `buildTaps` (gestures from touches, breadcrumb pairing within 1 s, breadcrumb-only and
  touch-only taps, swipe detection), `visibleTaps` (1 s hold, fade to 1.5 s).
- `src/components/TapOverlay.tsx`: ripple + pop indicator with target label; unplaced taps as a chip.
  `VideoPlayer` takes `taps` (defaults to the manifest's touches); the old `TouchOverlay` now only draws moves.
- `src/utils/markers.ts`, `ReplayMarkers.tsx`: `tap` kind, merged taps for video, legend entry. `ReplayMarker`
  gained a `key`.
- `src/utils/activity.ts`, `src/components/ReplayActivity.tsx`: activity list beside the video and frame players
  (filters, counts, search, active row, click-to-seek). `SessionDetail` lays player and list side by side and
  widens the Replay panel.
- Plugin 0.6.0 + CHANGELOG. No dependency added.

## Verified

- `npm test` 17 suites / 119 tests, `npm run typecheck`, `npm run lint` (3 old `Select` warnings), `npm run build`.
- `go test ./...` and `go vet ./...` in `collector/receiver/ouosentryreceiver`.
- Live: isolated compose project `ouo-taps` (Grafana 3005, rum-api 8093, Loki 3105, Tempo 3205, Mimir 9013,
  OTLP 4357/4358, replay 4359, Sentry 4360, backend 8086; env file in the session scratchpad). The installed app's
  DSN is `localhost:4400`, which a leftover `sentrytap` from 2026-10-14 held (forwarding to `ouo-sb`). It was stopped,
  a `sentrytap` forwarding to :4360 ran for the test, and the original was restarted with its exact command line.
  Real taps via the simulator tool (sequence in the kb). Session `F3A44DE4-8970-4685-B8F8-39E82C56F946`: 14 touches,
  6 `ui.tap`, 6/6 paired in the plugin with component and position; indicator at 50 % / 71.968 % for (201, 629);
  playback sampled every 250 ms: full for 1 s, gone by 1.5 s; six tap ticks on the scrubber; list click seeks.
  Screenshots and numbers: `project/reports/sentry-taps.html`.

## Left / next agent

- The `ouo-taps` stack is still up for review (`docker compose -p ouo-taps ... down -v` to remove).
- The activity list duplicates the left Timeline panel for mobile replays; a later pass could collapse the
  Timeline when the list is shown.
- Android touches (S5) are untested.
