# 2026-10-28: quickstart M1 `examples/quickstarts-mobile/tiny-shop-mobile` (N58)

## What was done

- First mobile quickstart, per `examples/quickstarts-mobile/index.md`: Tiny Shop Mobile, an Expo
  57 app (Products with the Debug section, Product, Cart) that keeps `@sentry/react-native` 8.32.0
  with its DSN pointed at the ouo Sentry bridge (`ouosentry`, port 4320, `upstream: none`), plus
  the tiny-shop-otel Express API traced with the OpenTelemetry Node SDK.
  - `result/stack/`: tiny-shop-otel's six service folders; `10-collector` replaces the replay
    receiver with the Sentry bridge (project `1` / `publickey0000000000000000000000` -> ouo project
    `demo`, service `tiny-shop-mobile`) and the `routing/sentry` connector from
    `deploy/compose/collector/config.yaml`. Ports `${OUO_SENTRY_PORT:-4320}`, `${OUO_OTLP_HTTP_PORT:-4318}`.
  - `result/backend/`: the tiny-shop-otel API as `tiny-shop-mobile-api`, without `cors()` and
    without the baggage span processor (Sentry's baggage carries no `session.id`).
  - `result/app/`: `src/config.ts` (`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SENTRY_DSN`),
    `src/sentry.ts` (`tracesSampleRate: 1`, `tracePropagationTargets: [API_URL]`,
    `propagateTraceparent: true`, `enableLogs: true`, React Navigation integration), `src/api.ts`
    (`tap()`: `startNewTrace` + a `ui.action` transaction per API tap; the first request waits for
    `navigationReady`), screens with `Sentry.logger` lines, `plugins/withUIScene.js` (copied from
    `examples/sentry-mobile`), `app.json` with the Sentry plugin and `disableAutoUpload: true`,
    bundle id `dev.ouo.tinyshop.m1`.
  - `build-it-yourself-guide.md`: the contract table, empty folder -> plain API -> plain Expo app
    (built and run) -> the stack one service at a time -> API instrumentation -> Sentry pointed at
    the bridge (6a to 6f) -> see it all (three sessions, one per state) -> next (M2 to M5) ->
    clean-up -> "When something does not work". Every result file is an `<!-- embed: -->` block.
  - `README.md`: what it shows, run `result/` as is, ports, things that bite, next.
- `examples/quickstarts/check-embeds.mjs` now also scans `examples/quickstarts-mobile` and skips
  `ios/`, `android/`, `Pods/` and dot folders (the generated native projects of the apps).
- kb `mobile-quickstart-bridge.md` (+ kb index line).

## Dependencies (new, example only)

- app: `@sentry/react-native` 8.32.0 (the SDK under test; 8.x because Expo's pick 7.11 has no fetch
  spans on RN 0.86), `@sentry/core` 10.76.2 (`startNewTrace`, not re-exported by
  `@sentry/react-native`), `@react-navigation/native` 7.5.1 + `native-stack` 7.21.0 +
  `react-native-screens` 4.26 + `react-native-safe-area-context` 5.7 (the three screens), and the
  Expo 57 template's own (`expo` 57.0.31, `react-native` 0.86.3, `react` 19.2.3, `expo-status-bar`).
- backend: `express` and the tiny-shop-otel OpenTelemetry packages, minus `cors` and
  `@opentelemetry/baggage-span-processor`.
- Lockfiles committed. npm was run with `--prefix .` (the worktree walk-up to the main checkout's
  conflicted workspace `package.json`, already in kb `diy-browser-rum.md`).

## How it was verified

`result/stack` as compose project `qs-m1` on M1's block (Grafana 31000, OTLP 31318, Sentry 31320,
Tempo 31200, Loki 31100, Mimir 31009, health 31133), images pulled that day; API on 31501;
`npx expo run:ios --port 31081` (Debug, Metro) with `EXPO_PUBLIC_*` pointing at those ports, on
simulator `ouo-qs-tiny-shop-mobile` (iPhone 18 Pro, iOS 27.0) created for this run.

- Real taps with the Claude Code iOS simulator tool (tap / HOME / screenshot), three sessions as
  the guide says. rum-api `/v1/sessions`: `crashed` (end `crash`, errors 1, crashes 1, failed 1,
  7 traces), `errored` (end `background`, errors 1, failed 1, 1 trace), `healthy` (end
  `background`, 4 traces), plus the `active` session Sentry opens after the Debug red screen.
- Grafana plugin (in-app browser): Sessions list with all three states; the crashed session page
  has device, OS, release, environment, vitals, the timeline (taps by label, screens, requests,
  failed request 500, both errors with **Show stack trace**, logs) and its 7 traces.
- Tempo: trace `tap Checkout` (tiny-shop-mobile, `ui.action`) -> `POST` (`http.client`) ->
  `POST /api/checkout` (tiny-shop-mobile-api) -> `request handler` -> `checkout` -> `validate cart`,
  `charge card`: one trace id, every parent present (script over `/api/v2/traces`).
- Loki `{service_name="tiny-shop-mobile", event_name="log"}`: `loaded 3 products`,
  `added Tea to the cart (1 items)`, `order 31737 placed: 2 items, $9`,
  `GET /api/fail failed: /api/fail answered 500`, `coupon check failed: ...`. `exception` records
  carry `exception.stacktrace` resolving to `ProductsScreen.tsx:37` (handled) and `:48` (fatal,
  `ouo.exception.fatal=true`).
- No sentry.io call: build phases export `SENTRY_DISABLE_AUTO_UPLOAD=true`; the DSN is the bridge.
- Bridge probe of step 4d: `POST /api/1/envelope/?sentry_key=wrong` -> `403 {"detail":"unknown project or public key"}`.
- Intermediates: the plain app (step 3) typechecked (`tsc --noEmit`) and bundled
  (`expo export --platform ios`, 832 modules); the plain `server.js` passes `node --check`.
- `node examples/quickstarts/check-embeds.mjs`: in sync; lychee offline on `examples/quickstarts-mobile`: 0 errors.
- Torn down: Metro and API (own PIDs), `docker compose -p qs-m1 down -v`, simulator deleted.

Not done: a Release build (not needed for M1), a literal walk of the guide by a person.

Versions and digests:

| Piece | Version |
|---|---|
| collector | 0.4.0, `sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2` |
| rum-api | 0.5.0, `sha256:1ee9e606220df2c42f4ade4131fdd3f82085d6e814676a771754a85a6ae78336` |
| grafana | 0.5.0 (Grafana 13.2.1), `sha256:57607a3616c88867644be1f69abb4681ca73df05d6bf2682543418f0dfeb622f` |
| Tempo / Loki / Mimir | 3.0.3 / 3.7.7 / 3.2.1 (pinned, as tiny-shop-otel) |
| Expo / React Native / React | 57.0.31 / 0.86.3 / 19.2.3 |
| `@sentry/react-native` / sentry-cocoa / `@sentry/core` | 8.32.0 / 9.31.0 / 10.76.2 |
| Xcode / iOS runtime / Node | 27.0 (27A266a) / iOS 27.0 (24A434) / 24.15.0 |

## Status line (index row M1)

`done 2026-10-28: Expo 57 + @sentry/react-native 8.32 to the bridge (upstream none), healthy / errored / crashed sessions, tap Checkout -> http.client -> API -> charge card in one trace, stacks, Sentry.logger lines in Loki; verified on the simulator with real taps ([summary](../../project/agents/fast-tracked/summaries/2026-10-28-quickstart-tiny-shop-mobile.md))`

## Checklist line (N58)

`- [x] N58 examples/quickstarts-mobile/tiny-shop-mobile: Expo 57 app keeping @sentry/react-native 8.32 with the ouo bridge as DSN (upstream none) + tiny-shop-otel API on OTel Node [2026-10-28: qs-m1 on the 31xxx block, simulator with real taps: sessions healthy / errored / crashed in ouo11y RUM, one trace tap Checkout -> POST -> POST /api/checkout -> checkout -> charge card with no orphan parent, handled and fatal errors with source stacks, Sentry.logger lines in Loki; check-embeds covers quickstarts-mobile; [summary](../agents/fast-tracked/summaries/2026-10-28-quickstart-tiny-shop-mobile.md)]`

## Found

1. **Bridge records with an empty-meaning body (rule 6).** `navigation`, `session.start`,
   `session.end`, `http.request.failed`, `app.jank`, `ouo.stall` and `ouo.app.start` records from
   the bridge have the event name as their Loki line (`navigation`, `http.request.failed`), not
   what happened (`navigation Products -> Cart`, `GET http://localhost:5001/api/fail 500`).
   Repro: run M1, `{service_name="tiny-shop-mobile"} != "app.jank"` in Loki. `http.request` and
   `exception` are fine.
2. **Native back-button taps: two unreadable `ui.tap` events.** One press of the native-stack header
   back button gives `ui.tap` `__backButtonAction:` and `ui.tap` `SafeAreaInsetsContext` in the
   timeline. Repro: M1, Cart -> back. Sentry's touch breadcrumbs name the nearest labelled
   component; the bridge could drop `__*Action:` / context names or merge the pair.
3. **Debug-build fatal adds a noisy `console` record.** With `enableLogs`, LogBox's `console.error`
   of the fatal arrives as a `console` record whose body is the whole JSON error with Metro bundle
   URLs (about 2 KB). Repro: M1 Debug, **Throw error**, Loki `event_name="console"`.
4. **Debug cold start reported as app start.** The bridge reports `App start (cold) 25.13 s` for a
   Debug launch that downloads the bundle from Metro. Repro: M1 first launch. Possibly filter
   `app_start` when the release is a dev build, or label it.
5. **`create-expo-app@latest` now scaffolds Expo SDK 58** (RN 0.88). The series index says Expo 57;
   M1 pins `--template blank-typescript@sdk-57`. M2 to M5 need the same pin or a decision to move
   to 58 (shared note left for the sibling sessions).

## For the next agent

- M2 to M5 can start from this `result/`: the collector already routes bridged replay chunks to
  rum-api (`routing/sentry` -> `logs/replay`), so M2 only turns replay on in `Sentry.init`.
- If M2 to M5 also extend `check-embeds.mjs`, apply the same diff (left in the shared notes folder)
  or rebase on this PR.
- Nothing left running: no compose project, no simulator, no Metro.
