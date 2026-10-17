# Taps in Sentry-sourced (`video`) replays: why they "never showed", and how they show now

Status: verified 2026-10-16 by grafana-plugin (plugin 0.6.0, Grafana 13.2.1, isolated stack `ouo-taps`,
`@sentry/react-native` 8.30.0 / sentry-cocoa 9.30.1, iOS 27 simulator).
Code: `plugins/ouo-rum-app/src/utils/taps.ts`, `components/TapOverlay.tsx`, `components/ReplayActivity.tsx`,
`utils/activity.ts`, `utils/markers.ts`. Golden: `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/realtap`
(`TestGoldenRealTap`).

## Question

Sentry's replay player shows each tap on the video and lists it ("Animated(Pressable) > Pressable > View > Text")
in the breadcrumb panel. In ouo's plugin, taps "never show" in a Sentry-sourced replay. Where is the fault?

## What each layer does (checked one by one)

| Layer | Result |
|---|---|
| SDK (sentry-cocoa via RN 8.30) | **Works.** For every real UIKit tap the replay recording has rrweb incremental `source 2` touch start (`type 7`) and end (`type 9`) with `x`/`y` in video points, plus a `ui.tap` breadcrumb (custom event, tag `breadcrumb`) with the component path. Swipes add `source 6` moves. Measured on the simulator: start and end 0 to 3 ms apart, the breadcrumb 80 to 150 ms after the touch start. |
| Receiver (`replay.go`, `breadcrumbs.go`) | **Works.** Touches go to the chunk's `touches`, breadcrumbs to `ui.tap` log records with `ouo.ui.target` / `ouo.ui.path`. Golden `realtap`: 6 real taps, every breadcrumb has a touch start 0 to 300 ms before it at the tapped point. No receiver change. |
| rum-api | **Works.** `GET .../replay/video` returns `touches`; the session timeline has the breadcrumbs as `type: "custom"`, `name: "ui.tap"`. |
| Test data | **Cause 1.** `examples/sentry-mobile/scripts/journey.sh` drives the app through the file mailbox / deep links. No UIKit touch happens, so those replays have no touches and no `ui.tap` at all (144 of 145 stored chunks in `ouo-sb` had none). A replay from the journey can never show a tap. |
| Plugin, video overlay | Drew touches correctly (point space = video pixel space on iOS, stage aspect = viewport, measured 50 % / 71.97 % for a tap at 201, 629 on 402x874), but as a plain dot that faded linearly from the first millisecond, two dots per tap (start and end 1 ms apart), with no label. Easy to miss on a ~1 fps video. |
| Plugin, scrubber markers | **Cause 2.** `markerKind` only knew `exception`, `http.request.failed`, `navigation`. `ui.tap` is `type: "custom"`, so taps never got a marker. |
| Plugin, side list | **Cause 3.** No list beside the player. Taps were only in the left Timeline panel as "Tap action-x", far from the video. |

## What changed (plugin 0.6.0)

- **Taps are merged** (`buildTaps`): touches are grouped into gestures (a `began` up to its `ended`; a pause of more
  than 1 s also starts a new gesture), and each `ui.tap` breadcrumb is paired with the nearest unpaired gesture within
  1 s. A breadcrumb without a touch is still a tap (no position); a gesture without a breadcrumb is a tap without a
  target ("Tap at 330, 852"). A gesture that moved more than 24 pt is a swipe.
- **Tap indicator** (`TapOverlay`): orange ring with a white core and dark halo, a ripple and a pop when it appears,
  the target as a label under it. Fully opaque for 1 s, then fades out by 1.5 s (so at 1 fps at least one frame
  shows it fully). A tap with no position shows as a label chip at the top of the stage. Moves of a swipe are still
  drawn as the old touch trail. `prefers-reduced-motion` turns the animation off.
- **Scrubber**: `tap` marker kind (thin orange ticks under the other kinds), from the merged taps for video replays
  and from `ui.tap` events otherwise.
- **Activity list** (`ReplayActivity`) beside the video and frame players: every timeline event plus the merged
  taps in time order, filters All / Taps / Navigation / Network / Errors / Logs with counts, text search, the row at
  the cursor highlighted and kept in view, rows after the cursor dimmed, click to seek. The Replay panel takes 2/3
  of the row when the list is shown; the list wraps under the player in a narrow panel.

## How to get a session with real taps (no deep links)

The Claude simulator tool's `tap` and `swipe` inject real UIKit touches (idb, AXe and cliclick are not installed on
this Mac; `simctl` has no tap). Sequence used on 2026-10-16 (points on the 402x874 iPhone 18 Pro, Home screen):

1. `xcrun simctl terminate booted dev.ouo.sentrydemo; xcrun simctl launch booted dev.ouo.sentrydemo`
2. tap (201, 418) Browse catalog, wait 3 s; tap (201, 629) Fetch products, wait 3 s
3. swipe (300, 700) to (300, 400) over 0.6 s (scrolls the list), wait 3 s
4. tap (201, 404) Fetch 500; tap (201, 660) Breadcrumb + message; tap (330, 852) empty space; tap (201, 803) Flush
5. wait about 15 s for the replay segments, then terminate the app

The app's DSN is baked in (`localhost:4400`), so route port 4400 to the stack under test with
`sentrytap -listen 127.0.0.1:4400 -dir <capture> -forward http://127.0.0.1:<OUO_SENTRY_PORT>`.

## Gotchas

- The tap's timestamp in the activity list is relative to the replay start; the left Timeline is relative to the
  session start, so the same tap reads +11.2 s in one and +11.5 s in the other.
- RN reports a tap on a scroll view's empty area as `HeaderShownContext` (the nearest labelled component), and the
  same target for a swipe on the list: the target alone does not tell a tap from a swipe, the touch moves do.
- The last tap before the app is terminated can miss its replay segment (the Flush tap above has no touch or
  breadcrumb stored).
