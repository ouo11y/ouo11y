# 2026-10-28: mobile quickstart M5, `examples/quickstarts-mobile/tiny-shop-mobile-ouo` (N62)

## What was done

- **Quickstart M5**, per `examples/quickstarts-mobile/index.md`: Tiny Shop Mobile (Products,
  Product, Cart, Debug section) with `@ouo11y/react-native` **0.2.1 from npm**, no Sentry, straight
  to the ouo collector (OTLP 4318, replay 4319) and rum-api.
  - `result/app/`: Expo 57 blank TypeScript template, `src/rum.ts` (`initRUM`: endpoint, optional
    `replayEndpoint`, demo credential, `propagateTo` the API, replay with `maskText: false`),
    `index.ts` (SDK first), `App.tsx` (`RUMProvider`, `navigationStateListener`), `src/api.ts`
    (`rum.withSpan("place order")`, `rum.startSpan("save receipt", { parent })` after the await,
    `rum.log.info`), screens with `testID`s, `modules/tiny-crash/` (local Expo module for a native
    crash, the SDK has no helper), `plugins/withUIScene.js` (copied from `examples/sentry-mobile`).
  - `result/backend/`: the tiny-shop-otel API without CORS, `API_PORT`, service `tiny-shop-mobile-api`.
  - `result/stack/`: tiny-shop-otel's six service folders, CORS removed from the collector, comments
    for a native app.
  - `build-it-yourself-guide.md` (empty folder → plain API and app → stack → backend → SDK →
    Grafana → Release: native crash and replay → clean up → troubleshooting), every result file
    embedded and checked; `README.md`; **`sdk-state.md`**, the founder's question: feature-by-feature
    table against the Sentry path, verdict, order to close the gaps.
- `examples/quickstarts/check-embeds.mjs` scans `examples/quickstarts-mobile` too: **the exact
  diff M1 published** in the shared notes (`check-embeds-m1.diff`), so the two PRs conflict at most
  trivially.
- kb [mobile-quickstart-ouo-sdk.md](../../../kb/mobile-quickstart-ouo-sdk.md), kb index, this
  agent's tracker and summaries index.
- Not touched (as instructed): `examples/quickstarts-mobile/index.md`, `project/tracker/checklist.md`,
  the SDK.

## Dependencies (new, example only)

app: `@ouo11y/react-native` 0.2.1 (the SDK under test), `@react-native-async-storage/async-storage`
2.2.0 (the SDK's session persistence, peer), `expo-constants` (app version for `service.version`),
`expo-device` (device model, read by the SDK), `@react-navigation/native` + `native-stack`,
`react-native-screens`, `react-native-safe-area-context` (the three screens; the series' stack).
backend: tiny-shop-otel's minus `cors` (a native app sends no preflight). Lockfiles committed;
the app lock resolves `@ouo11y/react-native` from registry.npmjs.org, no `file:`.

## How it was verified

Isolated compose project `qs-m5` on the M5 block (Grafana 35000, OTLP 35318, replay 35319, Tempo
35200, Loki 35100, Mimir 35009, health 35133), API on 35501, Metro 35081, own simulator
`ouo-qs-tiny-shop-mobile-ouo` (iPhone 18 Pro, iOS 27.0), bundle id `dev.ouo.tinyshop.m5`. npm, Expo
and Xcode ran on a copy of `result/` in the session scratchpad, outside the repo (npm cannot run
inside the worktrees today, Found 9). Real taps: an XCUITest bundle tapping by `testID` (kb entry);
no simulator panel (access not granted), no deep links.

- **Debug** (`npx expo run:ios`): session `errored` (1 error, 1 failed request, 3 traces); Tempo
  trace `place order` → `HTTP POST` → `POST /api/checkout` → Express spans → `checkout` →
  `validate cart`, `charge card`, plus `save receipt`: 9 spans, one trace id, no orphan parent,
  `session.id` and `user.id` on every span; Loki `log` lines `checkout started with 1 items`,
  `order 3082 placed`; events `ui.tap` (by testID), `navigation`, `http.request`,
  `http.request.failed`, `exception`, `app.lifecycle`, `ouo.app.start`, `ouo.screen.display`,
  `app.jank`, `ouo.stall`. Replay in Debug: `frames`, 11 frames / 30 s. Native crash in Debug:
  report on disk, sent on relaunch, session `crashed`, `end_reason crash` at the crash time.
- **Release** (`--configuration Release`): session `errored` with replay 86 s / 39 frames / 40
  touches, cold app start 2.19 s (simulator, busy host); JS fatal → `crashed`, `crash_count 1`,
  `kind uncaught`, stack `app:///main.jsbundle:…`; native crash → `crashed`, `kind native`,
  `SIGSEGV` with frames and binary images; next session has `session.previous_id`.
- **Clean copy of `result/app`** (`npm ci`, fresh `ios/`, Release): builds, links TinyCrash first
  time, session `errored` with replay, checkout trace as above.
- **Bytes on the wire** (Release, replay on, `maskText: false`, ~115 s of taps): whole app 337 KB/min
  out (`nettop`, 45–116 s), replay 250 KB/min (rum-api chunk bytes = gzip as uploaded, 57 frames,
  ~8 KB a frame), so ≈ 85 KB/min OTLP + API. Simulator-only. Device numbers cited from N22 / B3.
- The guide's intermediate files: the plain app (api.ts, ProductsScreen, App.tsx) typechecks; the
  plain `server.js` serves products, checkout, the 500.
- `check-embeds.mjs`: in sync; lychee offline on `examples/quickstarts-mobile` and this folder: 0 errors.
- Sessions checked through the plugin's own route (`/api/plugin-proxy/ouo11y-rum-app/rum/v1/...`),
  not in the rendered Grafana UI.

## Versions

Expo 57.0.31, React Native 0.86.3, `@ouo11y/react-native` 0.2.1 (reports `ouo.sdk.version`
0.2.0, Found 5), async-storage 2.2.0, react-navigation native 7.5.1 / native-stack 7.21.0,
react-native-screens 4.26.2, Xcode 27.0 (27A266a), iOS 27.0 simulator (24A434), CocoaPods 1.17.0,
Node 24.15.0.
Images pulled 2026-10-28: `ghcr.io/ouo11y/collector:latest` = 0.4.0
`sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2`, `rum-api:latest` = 0.5.0
`sha256:1ee9e606220df2c42f4ade4131fdd3f82085d6e814676a771754a85a6ae78336`, `grafana:latest` = 0.5.0
`sha256:57607a3616c88867644be1f69abb4681ca73df05d6bf2682543418f0dfeb622f`; `grafana/tempo:3.0.3`
`sha256:0296560ac66f8a3600d7fb3014a52c189d4d9c3549ad6ff441bf2409855d68d5`, `grafana/loki:3.7.7`
`sha256:d70e4659623f3e109af669cae76fe2a5dd5be54e2298fe8aed380d982fbc2500`, `grafana/mimir:3.2.1`
`sha256:92838f113ba54230014e79bc812e57ca90bb9ebc06e665f59e4f700098c2dd04`.

## Ready to paste

Index status line (`examples/quickstarts-mobile/index.md`, M5 row, Status column):

```
done (2026-10-28, [summary](../../project/agents/fast-tracked/summaries/2026-10-28-quickstart-tiny-shop-mobile-ouo.md)): @ouo11y/react-native 0.2.1 from npm; Debug + Release on the simulator with real taps; [the state of the SDK](tiny-shop-mobile-ouo/sdk-state.md)
```

Checklist line (`project/tracker/checklist.md`):

```
- [x] N62 `examples/quickstarts-mobile/tiny-shop-mobile-ouo`: Tiny Shop Mobile on `@ouo11y/react-native` 0.2.1 from npm, no Sentry, and `sdk-state.md` (the ouo mobile SDK against the Sentry path, verdict, order of the gaps) [2026-10-28: `qs-m5` on the 35xxx ports, own simulator, real XCUITest taps; Debug and Release: sessions errored / crashed (JS fatal, native SIGSEGV on the next launch), one trace `place order` -> API `charge card` with `session.id` on all 9 spans, `rum.log` lines in Loki, vitals, `ui.tap` by testID, frames replay; replay 250 KB/min on the wire; found an input-masking leak on touch frames; [summary](../agents/fast-tracked/summaries/2026-10-28-quickstart-tiny-shop-mobile-ouo.md)]
```

## Found

1. **P0, privacy: input masking leaks on touch-triggered replay frames** (`sdk/ios` OuoReplay).
   Repro: this quickstart's Release build (`maskInputs` default true, `maskText: false`), Cart, type
   `SECRET42` in the promo field, tap **Checkout**, then the header **Back**. `GET
   /v1/sessions/<id>/replay/frames`: the frame with `reason: "touch"` at the Back tap shows
   `SECRET42`; the `timer` frames before it show the field black. Seen in Debug (session
   `44708298…`, frame 6) and Release (`dd91a50e…`, frame 30). Hypothesis: `ScreenCapturer.snapshot`
   draws the last committed frame (`drawHierarchy(afterScreenUpdates: false)`) while the redaction
   rects come from the current view tree; during a transition or keyboard dismissal they differ.
   Not fixed here (SDK work); the guide and README warn.
2. **SDK README, install:** `npm install @ouo11y/react-native @react-native-async-storage/async-storage`
   gives async-storage 3.1.1 under Expo 57 (wants 2.2.0); should say `npx expo install`.
3. **SDK README, Expo snippet** passes `device: { modelIdentifier: Device.modelId }`, which wins over
   the SDK's own expo-device reading, so the simulator reports `arm64` (the SDK drops it only when
   it reads it itself). Its `propagateTo: [/^http:\/\/localhost:8081/]` is Metro's port, confusing
   next to an API. The monorepo-only steps (Metro config, `npm run -w sdk/react-native build` before
   `pod install`) read as if npm users needed them.
4. **Replay port is derived only from 4318:** with any other OTLP port the SDK posts replay chunks to
   the OTLP port, no error in the app's debug log. Repro: `initRUM({ endpoint: "http://localhost:35318" })`
   → `replayChunks: http://localhost:35318/v1/replay/chunks`. Documented in the README, but a trap for
   every moved-port setup; derive +1 from any port, or warn in debug when the receiver answers 404.
5. **`ouo.sdk.version` is 0.2.0 in the 0.2.1 package** (`src/version.ts` kept by hand; the debug log
   says `@ouo11y/react-native@0.2.0 initialised`). The CHANGELOG lists the whole bridge-parity work
   under "Unreleased" below `0.2.1`, though 0.2.1's tarball contains it (span/log API, taps, vitals,
   sampling, native crashes).
6. **Loki bodies:** `exception`, `navigation`, `session.start`, `session.end` records have the event
   name as body; vitals an empty body. The quickstart rule "the Loki line says what happened" is
   not met by the SDK (`http.request`, `ui.tap`, `app.lifecycle`, `log` are fine).
7. **No `nativeCrash()` test helper** in the SDK (Sentry has one); the quickstart needs a local
   native module to show native crash reporting.
8. **A JS fatal before `rum.ready`** (here: `requireNativeModule` throwing at import) is recorded
   with a temporary `user.id` (`98ed97a9…` vs the persisted `4918c3bd…`), and the next launch ends
   that session `terminated`, not `crash` (rum-api still says `crashed` from the fatal). Repro: a
   module-level `throw` imported by `App.tsx`; session `6c7bea54…`. Low.
9. **npm cannot run inside `.claude/worktrees/*`** while the founder's main checkout has merge-conflict
   markers in five workspace `package.json` files (`examples/ouo-web`, `examples/sentry-mobile`,
   `sdk/react-native`, `sdk/browser`, `plugins/ouo11y-rum-app`); npm walks up into it. Workaround:
   `npm --prefix .` or a copy outside the checkout. Shared note left for the other sessions.
10. **Checklist id N48 is used twice** (the tiny-shop-otel quickstart, done, and "RN SDK sends OTLP
    uncompressed", open).
11. **Taps on native header buttons are not `ui.tap` events** (8 of 20 real taps, all the
    native-stack Back button): `RUMProvider` sees only React Native's responder system. The replay
    records them as touches. Low; Sentry's touch breadcrumbs are JS-side too.
12. **Release JS stacks mark React Native's own frames `[in app]`** (`_performTransitionSideEffects`,
    `onResponderRelease`): in a Release build every frame is in `main.jsbundle`. Needs source maps
    (N41) to tell app code from `node_modules`.
13. Expo: `expo run:ios` does not rerun `pod install` for a new local module when `ios/` exists;
    `npx expo prebuild --platform ios` does (guide step 6e). Expo's behaviour, not ours.

## Left / next agent

- Orchestrator: paste the status and checklist lines, give Found 1 (P0) and the others ids.
- Not checked in the rendered Grafana UI (plugin pages), only through the plugin's proxy route.
- Not run: sampling options, Android, a bare React Native app, the guide's intermediate Debug build
  between steps 3 and 6 as a reader would do it (its files were typechecked; the flow was run in a
  different order: SDK first, then module).
- Torn down at the end: compose project `qs-m5` (`down -v`), the simulator
  `ouo-qs-tiny-shop-mobile-ouo` deleted, the API and Metro stopped (own PIDs).
