# Mobile quickstarts

The mobile counterpart of [`../quickstarts/`](../quickstarts/index.md): small, standalone React
Native apps that show ouo end to end on the iOS Simulator, from an empty folder to the session in
Grafana. Four follow the Sentry path (the app keeps `@sentry/react-native`, the ouo Sentry bridge
takes its traffic); the fifth uses ouo's own SDK, `@ouo11y/react-native`, and says where that SDK
stands.

| # | Quickstart | Checklist | What the reader ends with | Status |
|---|---|---|---|---|
| M1 | `tiny-shop-mobile` | N58 | Expo app + Express API (OTel Node). `Sentry.init` with the **ouo bridge as DSN** (`upstream: none`, no Sentry account). Sessions healthy / errored / crashed in ouo11y RUM, one trace from a tap to the API's manual spans, a JS error with its stack, `Sentry.logger` lines in Loki | review, [PR #99](https://github.com/ouo11y/ouo11y/pull/99) |
| M2 | `tiny-shop-mobile-replay` | N59 | Sentry mobile replay through the bridge (`replay_video`), masking on and off, taps on the timeline, replay of an errored session; an honest section on how a mobile replay differs from a web one (video + tap breadcrumbs vs DOM events) | review, [PR #101](https://github.com/ouo11y/ouo11y/pull/101) |
| M3 | `tiny-shop-mobile-signals` | N60 | app start cold / warm, time to initial display, slow and frozen frames, structured logs, release and environment, a native crash reported on the next launch | review, [PR #100](https://github.com/ouo11y/ouo11y/pull/100) |
| M4 | `tiny-shop-mobile-sentry` | N61 | "keep Sentry, add ouo": the bridge forwards every envelope to a real Sentry (your sentry.io project, or self-hosted) and the same session shows in both UIs; what each side shows that the other does not | review, [PR #103](https://github.com/ouo11y/ouo11y/pull/103) |
| M5 | `tiny-shop-mobile-ouo` | N62 | no Sentry: `@ouo11y/react-native` (npm) straight to the ouo collector and rum-api: sessions, traces with `session.id`, errors, native crash, vitals, replay; ends with **the state of the ouo mobile SDK** against the Sentry path (M1 to M4) | review, [PR #102](https://github.com/ouo11y/ouo11y/pull/102) |

Checklist ids N58 to N62 are reserved here for these five (`project/tracker/checklist.md`).
The five were built on 2026-10-28 with Expo 57.0.31, React Native 0.86.3, `@sentry/react-native`
8.32.0 (M1 to M4) and `@ouo11y/react-native` 0.2.1 (M5), each verified on its own iOS 27
simulator with real taps. M5 ends with `tiny-shop-mobile-ouo/sdk-state.md`: the ouo mobile SDK
feature by feature against the Sentry path, and what blocks replacing Sentry.

## What the five found

Given checklist ids N63 to N73; the repro of each is in the quickstart's agent summary
(`project/agents/fast-tracked/summaries/2026-10-28-quickstart-*.md`).

| Id | Found by | Where | What |
|---|---|---|---|
| N63 | M5 | `sdk/ios` replay | **P0 privacy:** a replay frame captured at a touch can show a text input unmasked (`maskInputs: true`): the typed text is readable on the Back-tap frame, masked on the timer frames around it |
| N64 | M1, M3, M4, M5 | bridge, `@ouo11y/react-native` | Loki lines of `navigation`, `session.start` / `end`, `http.request.failed`, `exception` (SDK) and the vitals records are the event name or empty, not what happened (same as N57 on the web) |
| N65 | M1, M2, M5 | bridge, `@ouo11y/react-native` | tap names: the bridge takes the outermost segment of React Native replay tap paths (`Debug` for a product row); the native back button gives two `ui.tap` (`__backButtonAction:`, `SafeAreaInsetsContext`); the ouo SDK misses taps on native header buttons |
| N66 | M2 | sentry-cocoa or bridge | some taps have no position in the replay (`touches: []`), intermittent |
| N67 | M3 | bridge | vitals after a back navigation carry the previous screen: the receiver moves the screen only on transactions, React Navigation drops empty back transactions |
| N68 | M4 | bridge metrics | an upstream 429 counts as `outcome="forwarded"` and its items are not counted: nothing shows what Sentry refused |
| N69 | M4 | bridge, plugin | `sentry_ui_url` is parsed but unused: no link from an ouo error to the same event in Sentry |
| N70 | M5 | `@ouo11y/react-native` | README: `npm install` instead of `npx expo install`, the Expo snippet's `Device.modelId` overrides the SDK's own reading, monorepo-only steps; `ouo.sdk.version` says 0.2.0 in 0.2.1; the CHANGELOG lists 0.2.1's work under Unreleased |
| N71 | M5 | `@ouo11y/react-native` | the replay URL is derived only from port 4318: on any other OTLP port, chunks go to the OTLP port with no warning; no `nativeCrash()` test helper; a fatal before `rum.ready` has a temporary `user.id` |
| N72 | M1, M3 | Sentry path in Debug builds | a Debug launch reports a 25 s cold start and an App Hang (session `errored`), and LogBox's `console.error` arrives as a 2 KB `console` record; filter or label dev builds in the bridge, and say so in `docs/sentry-client-setup.md` |
| N73 | M2 | plugin | after a Grafana sign-out (two Grafanas on `localhost` share the cookie) a replay segment fails with "not a playable mp4" (the request is 401); say "signed out" |

Not ours, written in the guides: frozen frames vanish when a Sentry transaction ends during the
freeze (M3); `CI=1` keeps old `EXPO_PUBLIC_*` values in Release builds (M2); `expo run:ios` does
not rerun `pod install` for a new local module (M5). N53 (the bridge race) did not reproduce in
M3 (0 of 10 launches).

## Rules

Every rule in [`../quickstarts/index.md`, "Rules for every quickstart"](../quickstarts/index.md#rules-for-every-quickstart)
applies (shape, relative paths, one command per block, the stack one folder per service,
`:latest` ouo images with a tested-version comment, packages explained, readable telemetry,
embeds checked by `check-embeds.mjs`, trade-offs, verified before the PR). Mobile changes and
additions:

### The shared app: Tiny Shop Mobile

All five build the same app, so a reader can move from one to the next. Each quickstart is still
standalone: its guide writes every file from an empty folder.

```
<name>/
├── README.md
├── build-it-yourself-guide.md
└── result/
    ├── stack/      10-collector (with the Sentry bridge on 4320, except M5), 20-tempo, 30-loki,
    │               40-mimir, 50-rum-api, 60-grafana; top compose.yaml only include:s them
    ├── backend/    Express API, OpenTelemetry Node SDK, as in ../quickstarts/tiny-shop-otel
    └── app/        Expo app (create-expo-app), TypeScript
```

- **App:** Expo SDK 57, React Native 0.86, React Navigation native stack, the versions
  `examples/sentry-mobile` runs. `create-expo-app@latest` scaffolds SDK 58 since October 2026:
  pin the template, `npx create-expo-app@latest app --template blank-typescript@sdk-57`, and
  delete what it adds besides the app (`.git`, `.claude/`, `AGENTS.md`, `LICENSE`). Screens: **Products** (list from `GET /api/products`),
  **Product** (detail, "Add to cart"), **Cart** ("Checkout" `POST /api/checkout`). A
  **Debug** section on Products with: "Call broken API" (`GET /api/fail`, 500), "Handled error",
  "Throw error" (JS fatal), and from M3 "Native crash".
- **API:** the tiny-shop-otel backend: `GET /api/products`, `POST /api/checkout` (manual spans
  `checkout` → `validate cart`, `charge card`), `GET /api/fail`. Port `${API_PORT:-5001}`. CORS is
  not needed for a native app, but the API must accept `traceparent`, `tracestate`, `baggage` and
  `sentry-trace`.
- **Sentry path (M1 to M4):** `@sentry/react-native` 8.x, `tracesSampleRate: 1`,
  `propagateTraceparent: true`, `tracePropagationTargets` the API URL, `enableLogs: true`; DSN
  `http://<public key>@localhost:${OUO_SENTRY_PORT:-4320}/<project>`. Follow
  [`docs/sentry-client-setup.md`](../../docs/sentry-client-setup.md) and its traps (requests
  outside a transaction get a random parent span id: give each action its own trace, as
  `examples/sentry-mobile/src/api.ts` does). `disableAutoUpload: true` in the Expo plugin: the
  build must never call sentry.io.
- **ouo path (M5):** `@ouo11y/react-native` from npm (0.2.1 today), never `file:../../sdk/...`.
- **Simulator only.** No phone. The guide's main path is `npx expo run:ios` (Debug, Metro); a
  native crash and replay need a Release build, which the guide shows where it matters
  (`npx expo run:ios --configuration Release`).
- **iOS 27 needs the UIScene life cycle**, which the Expo 57 template does not add:
  `examples/sentry-mobile/plugins/withUIScene.js` is the config plugin (`project/kb/xcode-setup.md`).
  Copy it into the app and explain it in one line.
- **Readable telemetry:** the Loki line of every log record says what happened; a tap, a request,
  an error each read on their own in ouo11y RUM's timeline.

### Verification

As rule 9 of the web quickstarts, plus:

- Run `result/` on a simulator **created for this quickstart** (`xcrun simctl create
  ouo-qs-<name> "iPhone 18 Pro"`); never boot, erase or shut down a simulator you did not create.
  Delete yours at the end.
- Drive the app with real taps where the guide says "tap" (XCUITest, or `idb` / the simulator
  tool if available); deep links only for setup. Check each signal where the reader looks:
  Loki line, Tempo trace (app span → API server span → manual spans, one trace id, no orphan
  parent), session in ouo11y RUM (state, activity, replay where the quickstart has one).
- Record versions (Expo, RN, `@sentry/react-native` or `@ouo11y/react-native`, image tags and
  digests, Xcode, iOS runtime) in the agent summary.

### Building them in parallel (2026-10-28)

The five are built by five sessions at once on one Mac. Each keeps to its own block of host
ports, its own simulator, compose project and bundle id:

| # | Ports (`OUO_GRAFANA_PORT`, `OUO_OTLP_HTTP_PORT`, `OUO_REPLAY_PORT`, `OUO_SENTRY_PORT`, Tempo, Loki, Mimir, health, API, Metro) | Compose project | Bundle id |
|---|---|---|---|
| M1 | 31000, 31318, 31319, 31320, 31200, 31100, 31009, 31133, 31501, 31081 | `qs-m1` | `dev.ouo.tinyshop.m1` |
| M2 | 32000, 32318, 32319, 32320, 32200, 32100, 32009, 32133, 32501, 32081 | `qs-m2` | `dev.ouo.tinyshop.m2` |
| M3 | 33000, 33318, 33319, 33320, 33200, 33100, 33009, 33133, 33501, 33081 | `qs-m3` | `dev.ouo.tinyshop.m3` |
| M4 | 34000, 34318, 34319, 34320, 34200, 34100, 34009, 34133, 34501, 34081 | `qs-m4` | `dev.ouo.tinyshop.m4` |
| M5 | 35000, 35318, 35319, (none), 35200, 35100, 35009, 35133, 35501, 35081 | `qs-m5` | `dev.ouo.tinyshop.m5` |

The guides themselves use the default ports; these blocks are only for the verification runs.

- Do not edit this file or `project/tracker/checklist.md` from a quickstart session: put the
  status line and the checklist line in your agent summary
  (`project/agents/fast-tracked/summaries/`); the orchestrator merges them here.
- New bugs found on the way get a line in the summary under "Found", with what reproduces them;
  the orchestrator gives them checklist ids (N63 and up).
- Docker memory is shared (20 GB). Self-hosted Sentry (`sentry-sbx`) takes about 14 GB: only M4
  starts it, and only when no other `qs-m*` project is running.
