# 2026-10-28 quickstart M3: tiny-shop-mobile-signals (N60)

Session: qs-m3 (side session of the mobile quickstart series). Branch
`claude/quickstart-tiny-shop-mobile-signals-c53c4b`, cut from `claude/mobile-quickstarts-plan`
(PR #98), PR to `main`.

## Done

- `examples/quickstarts-mobile/tiny-shop-mobile-signals/`: README, build-it-yourself guide,
  `result/` with `stack/` (collector with the `ouosentry` bridge on 4320, `upstream: none`, no
  replay pipeline; Tempo, Loki, Mimir, rum-api, Grafana with a provisioned "Tiny Shop Mobile API"
  dashboard), `backend/` (Express, OTel traces + metrics `shop.http.requests`,
  `shop.http.request.duration`, `shop.orders`; no `cors()`, a native app sends no preflight) and
  `app/` (Expo 57 blank-typescript, React Navigation native stack, `@sentry/react-native` 8.32.0
  with the bridge DSN, `withUIScene.js`, bundle id `dev.ouo.tinyshop.m3`).
- Signals in the app: app start (cold / warm), TTID per screen (React Navigation integration),
  TTFD on Products (`<Sentry.TimeToFullDisplay>`), slow and frozen frames ("Render long text": a
  6,000-line read-only TextInput freezes the main thread about 1 s), a JS stall ("Block JavaScript
  1 s"), `Sentry.logger.*` lines with `fmt` templates and attributes, release / dist / environment,
  handled error, JS fatal, native crash (`Sentry.nativeCrash()`, Release), API metrics in Mimir.
- `examples/quickstarts/check-embeds.mjs` now also scans `examples/quickstarts-mobile` (M1's diff
  from the shared notes folder, applied verbatim so the five PRs merge cleanly).
- kb: `project/kb/sentry-rn-vitals-quickstart.md` (+ index line).

## Verified, and how

Stack `docker compose -p qs-m3` on the M3 port block (Grafana 33000, OTLP 33318, bridge 33320,
Tempo 33200, Loki 33100, Mimir 33009, health 33133), API on 33501, Metro 33081; `result/` copied
to the session scratchpad and run there (outside the repo, see Found 1). Simulator
`ouo-qs-tiny-shop-mobile-signals` (iPhone 18 Pro, iOS 27.0) created for this run. All taps were
real taps through the simulator tool; no deep links.

- Debug (`npx expo run:ios`): Products → Coffee → Add to cart → Cart → Checkout → Call broken API →
  Handled error → long text / JS block; relaunches with `simctl terminate` + launch.
- Release (`npx expo run:ios --configuration Release`): the same journey, then Native crash and a
  relaunch from the home-screen icon; a fresh uninstall + install for a cold start; Throw error and
  a relaunch.
- Loki: `session.start`/`session.end` (reasons `terminated`, `crash`), `ouo.app.start` (Debug cold
  28,989 ms, warm 2,955-4,303 ms; Release cold 1,697 ms, warm 1,532-1,753 ms),
  `ouo.screen.display` (Release TTID Product 631 ms, Cart 536 ms; TTFD on Products), `app.jank`
  (Release `Render long text`: total 101, slow 1, frozen 1), `ouo.stall` (950 ms), `log` lines with
  readable bodies (`Added Coffee to cart`, `Order 51874 placed: 1 items, $4.00`,
  `Broken API: /api/fail answered 500`), `exception` (SyntaxError handled; `Error: Cart total is
  NaN` fatal `onerror`; `EXC_BAD_ACCESS` fatal `mach` with 20 native frames and debug images),
  `http.request` / `http.request.failed`; every record with `service_version` 1.0.0,
  `ouo_app_build` 1, `ouo_sentry_release` `tiny-shop-mobile-signals@1.0.0+1`,
  `deployment_environment_name` development.
- Tempo: 9 API traces, 0 with an orphan parent; `Checkout` → `POST` → `POST /api/checkout` →
  `checkout` → `validate cart`, `charge card` in one trace.
- rum-api (`/v1/sessions`, `/v1/sessions/{id}/vitals` through the plugin proxy) and the plugin
  page in Grafana (built-in browser): crashed session 215921C7 with "Warm start 1.75 s · TTID p50
  631 ms · max 1.88 s · Frames 2 slow · 1 frozen / 206 · JS stalls 1 · longest 950 ms", Build
  "1.0.0 (build 1)", Environment "development", timeline "App start (warm) 1.75 s",
  "Product displayed in 631 ms", "Janky frames 2 / 101 (1 frozen)", "1 JS stall, longest 950 ms",
  "Fatal error EXC_BAD_ACCESS ...".
- Mimir: `shop_http_requests` by route/status (incl. `/api/fail` 500), `shop_orders`, p95 latency.
- N53: 0 of 10 sessions lost their app start / TTID; no record or span with
  `ouo.sentry.session_match = none`.
- Guide: intermediate (plain) files typechecked (`tsc --noEmit`) at both stages (plain app; Sentry
  added with plain screens) and the plain app's iOS bundle exported (`npx expo export -p ios`);
  the plain backend was not run separately (it is the final one minus OTel). `check-embeds.mjs`
  in sync; lychee offline clean on the new files.

Not verified: the guide's exact Debug path from an empty folder end to end (the result/ files and
both intermediate stages were checked instead); TTFD values beyond Products; Android.

## Versions

| Piece | Version |
|---|---|
| Expo / React Native | 57.0.31 / 0.86.3 |
| `@sentry/react-native` / `@sentry/core` / sentry-cocoa | 8.32.0 / 10.76.2 / 9.31.0 |
| React Navigation native / native-stack, screens, safe-area | 7.5.1 / 7.21.0, 4.26.2, 5.7.0 |
| Express, OTel sdk-node / sdk-trace / sdk-metrics / api | 5.3.0, 0.300.0 / 3.0.0 / 3.0.0 / 1.10.0 |
| Xcode / iOS runtime / device | 27.0 (27A266a) / iOS 27.0 (24A434) / iPhone 18 Pro |
| ouo images (`latest` pulled 2026-10-28) | collector 0.4.0 `sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2`, rum-api 0.5.0 `sha256:1ee9e606220df2c42f4ade4131fdd3f82085d6e814676a771754a85a6ae78336`, grafana 0.5.0 (plugin 0.9.0) `sha256:57607a3616c88867644be1f69abb4681ca73df05d6bf2682543418f0dfeb622f` |
| upstream images | loki 3.7.7, tempo 3.0.3, mimir 3.2.1 |

## New dependencies (one line each)

- `@sentry/react-native` 8.32.0: the subject of the quickstart; 8.x because the bridge is verified
  with 8.30+ and Expo's default 7.11 misses parts (kb `sentry-bridge-examples.md`).
- `@sentry/core` 10.76.2: `startNewTrace` (not re-exported by the RN SDK), pinned to RN's own copy.
- `@react-navigation/native`, `@react-navigation/native-stack`, `react-native-screens`,
  `react-native-safe-area-context`: the three-screen stack and the TTID integration.
- Backend `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http`: the API
  metrics for Mimir (as the web signals quickstart); `@opentelemetry/baggage-span-processor` and
  `cors` dropped (no ouo baggage from Sentry, no preflight from a native app).

## Index status line and checklist line (for the orchestrator)

Status column of M3 in `examples/quickstarts-mobile/index.md`:

```
done (PR <n>): Release + Debug on iOS 27 sim; app start cold/warm, TTID/TTFD, 1 frozen frame, JS stall, logs, release, native crash crashed on next launch; API dashboard
```

`project/tracker/checklist.md`:

```
- [x] N60 Mobile quickstart M3 `tiny-shop-mobile-signals`: @sentry/react-native 8.32.0 → ouo Sentry bridge (`upstream: none`); app start cold/warm, TTID/TTFD, slow + frozen frames (long TextInput), JS stall, Sentry.logger lines, release/dist/environment, native crash in Release reported on the next launch, API metrics dashboard. Verified on the iOS 27 simulator with real taps, qs-m3 stack (2026-10-28, PR <n>)
```

## Found

1. **npm fails in every worktree** ("Exit prior to config file resolving"): npm walks up to the
   founder's main checkout, which is mid-merge with conflict markers in workspace `package.json`
   files (diagnosed by M1, M2, M5 in the shared notes). Repro: `npm -v` anywhere under
   `.claude/worktrees/<x>`. Workaround: `npm --prefix .` or run from a copy outside the tree.
   Founder's checkout, not fixed here.
2. **Stale `app.screen.name` on interaction vitals after a back navigation** (bridge). Repro:
   Products → Cart → Checkout (goes back to Products) → Render long text: the `app.jank` /
   `ouo.stall` records and the plugin timeline say `Cart` although the app is on Products. The
   receiver's current screen only moves on transactions, and React Navigation's integration drops
   empty back-navigation transactions (`ignoreEmptyBackNavigationTransactions`). The `navigation`
   breadcrumbs to Products are on the timeline, so the receiver could update the screen from them.
3. **Frozen frames vanish when a transaction ends during the freeze** (Sentry RN, not ouo). Repro:
   end a `ui.action` span 1 s after rendering a 6,000-line TextInput: `frames_total 4`, slow 0,
   frozen 0 for a 1.08 s window; end it 3 s later: frozen 1. A minute-long freeze drops the frames
   measurement entirely. Documented in the guide; worth a line in `docs/specs/mobile-vitals.md`
   ("producers measure frames up to the transaction end") or the plugin's help.
4. **Vital records have an empty Loki line body** (by spec): Loki shows only the event name
   (`app.jank`), against the quickstart rule "a Loki line says what happened". The plugin titles
   them well; a body such as `Janky frames 2 / 101 (1 frozen) on Products` would make Loki readable
   too. Spec change, not done here.
5. **Debug builds report an App Hang at every launch** (sentry-cocoa, 2.0-2.8 s while the bundle
   loads from Metro), turning every Debug session `errored`. The quickstart sets
   `enableAppHangTracking: !__DEV__`; `examples/sentry-mobile` may want the same.
6. N53 did not reproduce: 0 of 10 launches (Debug and Release).

## What the next agent must know

- The bridge config in `result/stack/10-collector/config.yaml` has no replay route: M3 sends no
  replay. M2 needs the `routing/sentry` connector of the full stack.
- The guide's step 6 keeps the plain screens on purpose; their Checkout and broken-API calls run
  outside a transaction until step 7 replaces them.
- Stack `qs-m3` torn down (`docker compose -p qs-m3 down -v`), simulator
  `ouo-qs-tiny-shop-mobile-signals` deleted, backend and Metro processes stopped. Nothing left
  running.
