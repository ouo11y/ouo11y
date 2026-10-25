# Changelog

Every user-visible change bumps `version` in `package.json` (it becomes `plugin.json`'s version and the
`module.js?_cache=<version>` query string, so browsers drop the cached bundle).

## Unreleased

- **Source-mapped stack traces (ADR-0011):** an exception whose stack rum-api could map through the
  uploaded source maps opens on the original files, lines and functions, shows the source lines around the
  first mapped frame and a `source mapped` badge, with an Original / Raw toggle back to the minified stack.
  Needs a rum-api with source maps (the `symbolicated` field); without it the raw stack shows as before.

## 0.8.0 (bridge parity C1 to C8, B1, F4; 2026-10-23)

Needs rum-api after 0.3.0 for the masking state, the header's OS and environment and the trace paths; with an
older rum-api those parts fall back as described below.

- **Session page layout (B1):** only the activity list beside the player. The left Timeline panel is behind
  the feature toggle `sessionTimelinePanel` (off by default), set with `OUO_FEATURE_TOGGLES_ENABLE` in
  provisioning or `grafana.plugin.featureToggles` in the Helm chart (README, "Feature toggles"). Sessions
  without a replay show the activity list on its own; rrweb replays get the list beside the player too.
- **Stack traces (C1):** errors in the activity list, the Timeline and the Logs panel have an expandable
  `exception.stacktrace` ("Show stack trace (n frames)"); expanding it never seeks the replay.
- **Session header (C2):** Device, OS, Build and Environment rows from the session detail's new `context`
  (falls back to the device and build attributes the timeline carries; rows without a value are left out).
- **Taps in frames replays (C3):** touches of ouo SDK (`frames`) replays are taps like those of video replays:
  the Taps filter, scrubber tap markers and the info line count them (was "Taps 0").
- **Nothing before the session start (C4):** events recorded before `session.start` (the Sentry bridge's
  first screen, about 3 s early) are shown at the start, after "Session start"; the tooltip keeps the
  recorded time.
- **Trace names (C6):** a generic `HTTP GET` root reads `GET /api/products/p-1001` (method plus the root's
  `url.path` from rum-api), the name the Sentry bridge gives its http spans; the raw name is the tooltip.
- **Exception log lines (C7):** the Logs panel shows `Type: message` for exception records instead of the
  record body (`exception`) and hides `session_*` metadata attributes.
- **Masking state (C8):** the replay info line shows the real masking state from the replay meta's
  `masked` flag (masked, not masked, masking unknown) instead of a fixed sentence.
- **No black frame on seek (F4):** the video player preloads both neighbouring segments and keeps the frame
  on screen until the segment under the cursor can paint, with a small "loading segment n…" tag, instead of a
  black stage with "Loading segment n…" for about a second.
- **One clock (F4):** the activity list, the Timeline, the Logs panel and the players' time labels are all
  relative to the session start (the list and the players were relative to the replay start, 0.3 s apart).
- Header: "Previous session" link from `session.previous_id` (the ouo SDKs and, since the bridge parity
  fixes, the Sentry bridge). Log lines also hide `network_*` attributes (the bridge's
  `network_connection_type`).
- The configuration page lists the feature toggles and keeps every `jsonData` key it does not edit when it
  saves (it used to drop all but `rumApiUrl`).

## 0.7.0 (plugin ID `ouo11y-rum-app`, 2026-10-18)

- **Breaking: the plugin ID is `ouo11y-rum-app`** (was `ouo-rum-app`, ADR-0009); the folder is
  `plugins/ouo11y-rum-app` and the display name is "ouo11y RUM". Grafana keys everything on the ID, so to
  Grafana this is a different plugin:
  - pages move from `/a/ouo-rum-app/...` to `/a/ouo11y-rum-app/...`; old bookmarks and dashboard links
    return "plugin not found";
  - the proxy route moves to `/api/plugin-proxy/ouo11y-rum-app/rum/...`;
  - app settings (`rumApiUrl`, `readToken`) are stored per plugin ID and are **not carried over**. Stacks
    that provision the app (compose `grafana/provisioning/plugins/ouo11y-rum-app.yaml`, the Helm chart's
    plugins configmap, the VM install) get them from provisioning on the next start. A Grafana configured
    by hand needs both values entered again at `/plugins/ouo11y-rum-app`;
  - `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` and `GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS` must
    name `ouo11y-rum-app`, or Grafana refuses to load the unsigned plugin;
  - the old `ouo-rum-app` row stays in Grafana's database as a disabled, missing plugin; it is harmless.
    Delete `/var/lib/grafana/plugins/ouo-rum-app` if the plugin was copied in by hand rather than baked
    into the image or bind-mounted. On Helm, the init container copies the plugin to
    `/pvc/plugins/ouo11y-rum-app` and leaves an older `/pvc/plugins/ouo-rum-app` on the PVC; Grafana refuses
    to load it (unsigned and no longer allow-listed) and logs a warning. Delete it when convenient.

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
