# Sentry React Native mobile replay through the bridge: masking, taps, on-error, cost

Question: what does a reader see in ouo when an Expo app keeps `@sentry/react-native` mobile replay
and points its DSN at the bridge, and what bites when building it? Found while building and
verifying mobile quickstart M2, `examples/quickstarts-mobile/tiny-shop-mobile-replay` (N59), on
2026-10-28: `@sentry/react-native` 8.32.0 (sentry-cocoa 9.31.0), Expo 57, RN 0.86.3, iOS 27.0
simulator, collector 0.4.0, rum-api 0.5.0, grafana 0.5.0 (plugin 0.9.0).

## Masking

- `mobileReplayIntegration({ maskAllText, maskAllImages, maskAllVectors })` default all `true`.
  `<Sentry.Unmask>` shows a view in a masked build, `<Sentry.Mask>` hides one in an unmasked build;
  both verified in the plugin (Cart: total visible when masked, address and card a grey box when
  unmasked). The bridge sets the chunk's `masked` from the replay's `options` event; the plugin
  shows a `masked` / `not masked` badge.
- **Masking also hides tap labels.** In `touchevents.js`, `shouldReadSentryLabel = !maskAllText &&
  !isInsideMask`, and text extraction is off too. Masked build: `ui.tap` paths are component names
  (`View > Pressable > View > Text`). Unmasked: `sentry-label` values (`Add to cart`), or text
  extracted from children when there is no label (a whole product row's text).
- **Rage taps:** the RN SDK (`ragetap.js`, default on, 3 taps in 1 s) emits `ui.multiClick`
  breadcrumbs. Its identity is the touch path, so in a masked build three taps on three different
  buttons count as one rage tap (seen: Add, Add, Go to cart). The bridge maps `ui.multiClick` to a
  generic `breadcrumb` record (`ouo.breadcrumb.category=ui.multiClick`); the plugin lists it as
  `ui.multiClick clickCount=3 ...`. No `ouo.rage_click`.

## Taps on the replay

- The replay copy of a touch breadcrumb is built natively by `RNSentryReplayBreadcrumbConverter.m`
  (`getTouchPathMessageFrom`): the first 4 path entries, **outermost first** (`path[3] > ... >
  path[0]`), label preferred over name. The bridge (`breadcrumbs.go`) takes the **first** segment as
  `ouo.ui.target`, so the target is the 4th-innermost component: `HeaderBackContext`,
  `ScrollView`, or `Debug` for a tap on a product row whose path is
  `Debug > Product Coffee > Product Coffee > Product Coffee`. It should take the last segment.
- Touch positions come from the recording (`touches` in the chunk). In run 1 (masked), 6 of 13
  taps had no position (the plugin says "no position in the recording"): both header back taps
  and 4 fast taps; the segments around them had `touches: []`. Run 2 (unmasked, same taps) had
  positions for all, back button included. Intermittent; not reproduced on demand.

## On-error sampling

- `replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 1`: a session without a Sentry error
  event has no replay; `Sentry.captureException` sends a `replay_type: buffer` replay whose first
  segment starts ~30 s before the error, and recording continues until background.
- A 500 response is not an error event: no buffer sent (ouo still marks the session `errored`
  from the failed request).
- A JS fatal (`throw` in `setTimeout`, Release) on an on-error build: session `crashed`, **no
  replay**, also after relaunch. The buffer dies with the process.

## Debug vs Release

- Replay records in a Debug build served by Metro too (44 s Debug session had its replay). In
  Debug a JS fatal shows LogBox's red screen, the app stays open, Sentry still reports `crashed`
  and starts a new session, and the red screen is in the video. The quickstarts build Release for
  realism, not because replay requires it. `examples/quickstarts-mobile/index.md` says "replay
  need[s] a Release build": not true for 8.32 on the simulator.

## Build traps

- **`CI=1` makes `EXPO_PUBLIC_*` changes silently stale in Release builds.** `exportEmbedAsync`
  (`@expo/cli`) turns off the `--reset-cache` that `react-native-xcode.sh` passes when `CI` is set,
  and `babel-preset-expo`'s `inline-env-vars` inlines `process.env.EXPO_PUBLIC_*` at transform
  time, so cached transforms keep the old values. Seen: a rebuild with
  `EXPO_PUBLIC_REPLAY_SESSION_RATE=0` still recorded every session. Build without `CI` (agents
  usually set it for non-interactive Expo; `--device <udid> --no-bundler` needs no prompt anyway).
- `npx expo run:ios --configuration Release` starts Metro anyway and keeps running; use
  `--no-bundler`. Release rebuilds after the first take ~30 s.
- `create-expo-app` (template `blank-typescript@sdk-57`) creates `app/.git`, `app/.claude/settings.json`
  (enables an Expo Claude plugin), `AGENTS.md` and `LICENSE`: delete them before committing an
  example. `create-expo-app@latest` now defaults to Expo 58; pin `@sdk-57`.
- npm fails in every worktree while the founder's main checkout has a conflicted workspace
  `package.json`: see [sourcemaps-symbolication.md](sourcemaps-symbolication.md). Build outside the
  checkout.
- Several Grafanas on `localhost` (different ports) share one cookie jar: logging in to one logs
  the others out, and the plugin's `<video>` requests then get 401 ("segment N could not be played:
  not a playable mp4"). Use `127.0.0.1:<port>` for a second Grafana.
- sentry-cocoa app hang tracking reports `App Hang Non Fully Blocked: App hanging between 2.4 and
  3.2 seconds` on a loaded Mac's simulator, which makes a clean session `errored`.

## Cost

One 115 s foreground session: 20 segments, 120 KB of mp4 (4 to 10 KB per 5 to 6 s segment, H.264
1 fps, 402 x 874 points), 127 KB with the `.json.gz` touch files: ~1 KB/s, ~4 MB/h.
