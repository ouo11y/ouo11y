# 2026-10-28: mobile quickstart M2 `examples/quickstarts-mobile/tiny-shop-mobile-replay` (N59)

## What was done

- New mobile quickstart M2, per `examples/quickstarts-mobile/index.md`: Tiny Shop Mobile (Expo 57,
  RN 0.86, React Navigation native stack; Products with the Debug section, Product, Cart) keeps
  `@sentry/react-native` 8.32.0 with `mobileReplayIntegration`, DSN pointed at the ouo Sentry bridge
  (`upstream: none`, no Sentry account, nothing sent to sentry.io, `disableAutoUpload: true`).
  - `README.md`: what it shows, run `result/` as is, masking table, on-error sampling, cost, a short
    "Mobile replay vs web replay", ports, things that bite.
  - `build-it-yourself-guide.md` (13 steps): plain API and plain app first, the stack one service
    at a time, OTel Node API, Sentry pointed at the bridge, Release build, then shop and watch the
    replay, masking off and per view (`<Sentry.Mask>` / `<Sentry.Unmask>`), on-error only sampling,
    what it cost, the full mobile-vs-web comparison, clean up, troubleshooting table. Every
    `result/` file is embedded with `<!-- embed: -->`.
  - `result/stack/` (`name: tiny-shop-mobile-replay`): 10-collector with `ouosentry` on 4320 and
    the `routing/sentry` connector (no 4319 replay receiver: the app never posts there),
    20-tempo, 30-loki, 40-mimir, 50-rum-api (storage comment with the S3 example), 60-grafana.
  - `result/backend/`: the tiny-shop-otel API without `cors` and without `BaggageSpanProcessor`
    (Sentry's baggage carries only `sentry-*` keys), port `${API_PORT:-5001}`, product descriptions.
  - `result/app/`: `app.config.ts` (bundle id from `IOS_BUNDLE_ID`, local http, UIScene plugin,
    Sentry plugin), `src/config.ts` (`EXPO_PUBLIC_API_URL`, `_SENTRY_DSN`, `_REPLAY_SESSION_RATE`,
    `_REPLAY_ON_ERROR_RATE`, `_REPLAY_MASKING`), `src/sentry.ts`, `src/api.ts` (each tap its own
    trace via `startNewTrace` + `forceTransaction`, first screen waits for the navigation
    container), screens, `plugins/withUIScene.js` copied from `examples/sentry-mobile`.
- `examples/quickstarts/check-embeds.mjs` now also walks `examples/quickstarts-mobile/` (3 lines):
  without it no mobile guide's embeds were checked in CI. Sibling sessions were told (shared notes).
- kb: [`sentry-rn-replay-masking-taps.md`](../../../kb/sentry-rn-replay-masking-taps.md).

New dependencies (all in `result/`, none in the repo's workspaces):

- `@sentry/react-native` 8.32.0: the quickstart's subject; 8.x because 7.11 (Expo 57 default)
  traces no `fetch`.
- `@sentry/core` 10.76.2: `startNewTrace` (not re-exported by the RN SDK), pinned to the version
  8.32.0 depends on, as `examples/sentry-mobile` does.
- `@react-navigation/native`, `@react-navigation/native-stack`, `react-native-screens`,
  `react-native-safe-area-context`: the index's navigation stack (Expo 57 versions).
- Backend: the tiny-shop-otel OpenTelemetry packages and `express`, minus `cors` and
  `@opentelemetry/baggage-span-processor`.

## Verified, and how

On 2026-10-28, isolated compose project `qs-m2` on the M2 port block (Grafana 32000, OTLP 32318,
Sentry bridge 32320, Tempo 32200, Loki 32100, Mimir 32009, health 32133, API 32501, Metro 32081),
`latest` images pulled that day, simulator `ouo-qs-tiny-shop-mobile-replay` (iPhone 18 Pro,
iOS 27.0, created for this run), bundle id `dev.ouo.tinyshop.m2`. The app was built from a copy of
`result/app` outside the repo (npm cannot run in worktrees right now, see Found), sources rsynced
back unchanged. All taps are real simulator taps (Claude Code iOS Simulator tool), no deep links.

Four builds:

1. **Release, masking on, session rate 1.** Journey: Coffee, Add to cart x2, Go to cart, Checkout,
   back x2, Call broken API, Handled error, home. Session `errored` (2 errors: the handled
   `SyntaxError` and an `App Hang` from sentry-cocoa, 1 failed request), 6 traces, replay 115 s,
   20 segments, all 20 mp4 decode in Chromium (`loadeddata`, 402x874, 5 to 6 s each). In the plugin
   (browser pane, `127.0.0.1:32000`): `masked` badge, Cart frame all grey boxes except the
   `<Sentry.Unmask>` total `Total $8.00`, tap dot drawn on Checkout, 13 taps in the activity list.
   Tempo: `Checkout` trace = app `Checkout` -> app `POST` -> API `POST /api/checkout` ->
   `checkout` -> `validate cart`, `charge card`, one trace id, every parent present, app spans with
   `session.id`; `Products` and `Call broken API` traces also rooted at app spans. Loki:
   `cart.add Coffee`, `checkout order 29618 $8.00`, `broken API answered: HTTP 500 from ...`,
   `SyntaxError: JSON Parse error: ...`, `ui.tap`, `navigation`, `http.request`,
   `http.request.failed`.
2. **Release, `EXPO_PUBLIC_REPLAY_MASKING=off`.** Same journey. `not masked` badge; Cart frame shows
   `2 x Coffee $8.00`, `Total $8.00`, `SHIP TO`, and the `<Sentry.Mask>` address + card block as a
   grey box. Tap targets are the `sentry-label`s (`Add to cart`, `Checkout`, `Go to cart (2)`).
3. **Release, `EXPO_PUBLIC_REPLAY_SESSION_RATE=0`** (rebuilt without `CI=1`, see Found): session
   with no error `healthy`, no replay; next session (after 40 s in background) with Handled error:
   `errored`, replay of type `buffer`, first segment starting 30.5 s before the error, masked again.
   Then **Throw error**: session `crashed`, no replay, none after relaunch.
4. **Debug (Metro on 32081), default config**: a 44 s Debug session had its replay; Throw error
   showed LogBox, the session was still `crashed` with its replay, and a new session started.

Also: `node examples/quickstarts/check-embeds.mjs` in sync; lychee offline (README rule) clean on
`examples/quickstarts-mobile/**/*.md` and `examples/quickstarts/*.md`; `tsc --noEmit` on the final
app and on the guide's intermediate (plain) app files; `node --check` on the plain `server.js`;
`docker compose config` on `result/stack`. The plain app was typechecked, not built natively (the
final app was built four times).

Versions:

| Piece | Version |
|---|---|
| Expo / React Native | 57.0.31 (template `blank-typescript@sdk-57`) / 0.86.3 |
| `@sentry/react-native` / `@sentry/core` | 8.32.0 / 10.76.2 (sentry-cocoa 9.31.0) |
| Xcode / iOS runtime / macOS | 27.0 (27A266a) / iOS 27.0 (24A434) / 27.0.1 |
| Node | 24.15.0 |
| collector | 0.4.0 `sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2` |
| rum-api | 0.5.0 `sha256:1ee9e606220df2c42f4ade4131fdd3f82085d6e814676a771754a85a6ae78336` |
| grafana (plugin 0.9.0) | 0.5.0 `sha256:57607a3616c88867644be1f69abb4681ca73df05d6bf2682543418f0dfeb622f` |
| Tempo / Loki / Mimir | 3.0.3 `sha256:0296560a...` / 3.7.7 `sha256:d70e4659...` / 3.2.1 `sha256:92838f11...` |

Teardown: `docker compose -p qs-m2 down -v`, my API process stopped by its PID, my Metro processes
stopped by PID, simulator `ouo-qs-tiny-shop-mobile-replay` shut down and deleted. Nothing left running.

## Lines for the orchestrator

Index status line (`examples/quickstarts-mobile/index.md`, M2 row, last column):

```
done: [README](tiny-shop-mobile-replay/README.md), [guide](tiny-shop-mobile-replay/build-it-yourself-guide.md); verified 2026-10-28 on qs-m2 (4 builds, real taps): masked vs unmasked replay with taps, on-error buffer replay, trace tap -> API, cost 1 KB/s
```

Checklist line (`project/tracker/checklist.md`):

```
- [x] N59 Mobile quickstart M2 `examples/quickstarts-mobile/tiny-shop-mobile-replay` [2026-10-28]: Sentry RN 8.32 mobile replay through the bridge (`upstream: none`), masking on/off and `<Sentry.Mask>`/`<Sentry.Unmask>`, taps on the replay and timeline, on-error-only sampling (buffer replay ~30 s before the error), cost (~1 KB/s), "mobile replay vs web replay"; verified on `qs-m2` with real simulator taps (4 builds); `check-embeds.mjs` now covers quickstarts-mobile. Found: 6 items, see summary 2026-10-28-quickstart-tiny-shop-mobile-replay
```

Correction for the index: "a native crash and replay need a Release build" is not true for replay
with `@sentry/react-native` 8.32 on the simulator (Debug records it, build 4 above). The guide says
so and builds Release for realism (a JS crash closes the app instead of LogBox).

## Found

1. **Bridge: wrong `ouo.ui.target` for React Native taps from the replay** (collector,
   `ouosentryreceiver/breadcrumbs.go`). `RNSentryReplayBreadcrumbConverter.m` writes the message as
   the first 4 path entries outermost first (`path[3] > path[2] > path[1] > path[0]`); the bridge
   takes the first segment as the target. Repro: unmasked build, tap a product row: path
   `Debug > Product Coffee > Product Coffee > Product Coffee`, target `Debug`; masked build, tap a
   row: target `HeaderBackContext`. Fix: take the last segment (or the innermost one with a label).
   Golden captures of `examples/sentry-mobile` hid it because its labels repeat across levels.
2. **Some taps have no position in the replay** (sentry-cocoa or bridge, intermittent). Run 1:
   6 of 13 taps (2 header back taps, 4 taps within 700 ms) had a `ui.tap` breadcrumb but the
   segments' `touches` were `[]`; run 2 with the same taps had all positions. Repro unclear; look
   at the raw `replay_recording` of such a segment (`sentrytap`) to tell SDK from bridge.
3. **`CI=1` silently keeps old `EXPO_PUBLIC_*` values in Release builds** (Expo CLI): affects any
   agent build script that sets `CI` (e.g. `examples/sentry-mobile/scripts/build-ios.sh` exports
   `CI=1` while its values come from `app.config.ts` `extra`, which is not affected; anything using
   `EXPO_PUBLIC_*` is). Repro: build with `EXPO_PUBLIC_X=a`, rebuild with `CI=1 EXPO_PUBLIC_X=b`:
   the app still sees `a`.
4. **Grafana sessions clobber each other across localhost ports** (all quickstarts and ouo-envs on
   one machine): the plugin then reports "segment N could not be played: not a playable mp4" (the
   video request is 401), which reads like a replay bug. Repro: log in to Grafana on
   `localhost:32000`, then to another on `localhost:31000` in the same browser; go back: 401. A
   clearer plugin message on 401 ("signed out") would save time.
5. **npm cannot run in any worktree** while the founder's main checkout is mid-merge (a workspace
   `package.json` with conflict markers; npm walks up). Known pattern
   (`project/kb/sourcemaps-symbolication.md`); reported to sibling sessions.
6. **`create-expo-app` writes `.claude/settings.json` enabling `expo@claude-plugins-official`, an
   `AGENTS.md`, a `LICENSE` and a `.git`** into the new app: remove before committing examples.

## Product suggestions: closing the mobile-vs-web replay gap

Ordered by value for effort; all on the Sentry path unless noted.

1. **Rage taps from `ui.multiClick` (small, bridge).** Map the RN SDK's `ui.multiClick` breadcrumb
   (already in recordings and on events) to `ouo.rage_click` with `ouo.click_count` =
   `data.clickCount`, `ouo.ui.target` from the innermost labelled path entry, route from
   `data.route`. Same event name as the web, so the plugin's rage markers and the Loki query work
   unchanged. Document the masked-build false positives (identity = component path).
2. **Rage taps derived in the bridge from tap breadcrumbs + touch positions (medium).** For SDKs
   without `ui.multiClick` (sentry-cocoa native, older RN, Android): 3+ touches within 1 s within
   ~30 pt in one session -> `ouo.rage_click`. Positions make it independent of masking, which fixes
   item 1's false positives.
3. **Dead taps, approximated (medium, bridge + rum-api).** A tap followed within 1 to 2 s by no
   navigation, no request, no breadcrumb and no `ui.action` span = candidate `ouo.dead_click`.
   Optionally confirm with the video: compare the frame before and after the tap (rum-api can
   decode the mp4 segment; 1 fps makes it coarse). Mark it `ouo.dead_click.confidence = low`.
4. **Fix the tap target (small, item 1 of Found)** and keep the full path; then "most tapped
   targets" per screen is a cheap aggregation in Loki.
5. **ouo's own mobile SDK (`@ouo11y/react-native`, M5) can record structure, not only pixels**:
   send the view hierarchy (or React fiber tree) diff with each frame or on each tap, so taps
   resolve to elements, dead taps are exact (no layout or state change), and element search in the
   replay becomes possible. This is the real equivalent of rrweb for mobile; it also enables
   rendering at any resolution and smaller uploads than video (N50).
6. **Plugin: a "mobile replay" hint** next to the player saying the replay is 1 fps video, why
   some taps have no position, and that rage/dead taps are web-only today, so users do not read a
   missing marker as "no frustration".
