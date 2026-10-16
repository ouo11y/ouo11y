# Changelog

Every user-visible change bumps `version` in `package.json` (it becomes `plugin.json`'s version and the
`module.js?_cache=<version>` query string, so browsers drop the cached bundle).

## 0.6.0 (taps in Sentry replays, 2026-10-16)

- Taps in video (Sentry) replays are merged from the recording's touches and the `ui.tap` breadcrumbs: one tap has
  the touched component and the position; a breadcrumb without a recorded touch and a touch without a breadcrumb
  are taps too. A gesture that moved is a swipe.
- Tap indicator on the video: orange ring with a ripple and the touched component as a label, fully visible for 1 s
  and fading out by 1.5 s (Sentry records about 1 frame per second); a tap without a position shows as a label at
  the top of the stage. The moves of a swipe are still drawn as a trail.
- Scrubber: `tap` markers (thin orange ticks under the other kinds) and a "tap" legend entry, also for `ui.tap`
  timeline events of other replays.
- Activity list beside the video and frame players, like Sentry's breadcrumb panel: taps, navigations, requests,
  errors and logs in time order, filters with counts, search, the row at the cursor highlighted and kept in view,
  click to seek. The Replay panel takes two thirds of the row when the list is shown.

## 0.5.0 (Sentry bridge follow-ups, 2026-10-14)

- Logs section on the session page, from rum-api `GET /v1/sessions/{id}/logs`: the session's own log lines
  (Sentry logs, console output, errors) and the lines of other services that share one of the session's traces
  (the demo backend's request logs), with level, service and the line's own attributes. Filter by source (this
  session / same traces) and by text; clicking a line seeks the replay and scrolls it into view; each line links
  to its trace and the section to the whole query in Explore.
- Timeline titles for the events the Sentry bridge derives: `log`, `console`, `http.request`, `app.lifecycle`,
  `ui.tap`, `breadcrumb`, `sentry.message` (they were listed as raw `k=v` attributes).
- Touch markers are white with a dark halo (the theme-coloured ring was invisible on coloured buttons), and
  video replays keep a touch visible for 1.5 s instead of 500 ms (Sentry records about 1 frame per second).
- Fix: the Timeline list now fills its panel. It was capped at the viewport height while the panel stretched to
  the (taller) Replay panel, leaving the lower part of the panel empty.

## 0.4.0 (Sentry bridge S4, 2026-10-14)

- Video replay player for `replay_kind: "video"` (ADR-0008, Sentry mobile Session Replay through the Sentry
  bridge): plays the mp4 segments of `GET /v1/sessions/{id}/replay/video` in seq order as one timeline from the
  manifest's `started_at` to `ended_at`, preloads the next segment, keeps the previous segment's last frame in a
  gap, and maps the scrubber, replay markers and timeline clicks to (segment, offset). Touches are drawn from the
  manifest in the video's pixel space and fade over 500 ms like the frame player. "Sentry replay" source badge
  when `source.vendor` is `sentry`. Segments stream through the `rum/*` proxy route as `<video src>` (the Grafana
  session cookie authenticates, the proxy adds the read token and passes `Range`/206 through).
- Sessions table: `video` kind in the Replay column.
- Frame and video players share one playback clock (`usePlaybackClock`) and touch overlay (`TouchOverlay`).

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
