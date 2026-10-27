# 2026-10-28: quickstart M4 `examples/quickstarts-mobile/tiny-shop-mobile-sentry` (N61)

## What was done

- New mobile quickstart "keep Sentry, add ouo": the Tiny Shop Mobile app (Expo 57, three screens,
  Debug section with broken API, handled error, JS fatal, native crash) on `@sentry/react-native`
  8.32.0, whose DSN host is the ouo Sentry bridge; the bridge forwards every envelope to a real
  Sentry (`OUO_SENTRY_UPSTREAM`, project id, public key in `stack/.env`) and translates a copy.
  - `result/stack/`: tiny-shop-otel's stack, one folder per service, with the `ouosentry`
    receiver on 4320, the `routing/sentry` connector, the collector's own metrics pushed to Mimir
    (bridge counters), `host.docker.internal` for a Sentry on the same machine, `.env.example`
    with the DSN-to-upstream mapping. The web replay receiver (4319) is left out: nothing posts to it.
  - `result/backend/`: the tiny-shop-otel API with `API_PORT`, without CORS and without the
    baggage processor (Sentry's baggage carries `sentry-*` keys, not `session.id`).
  - `result/app/`: `src/sentry.ts` (init with tracing, `propagateTraceparent`,
    `tracePropagationTargets` = the API, logs, replay with Sentry's default masking,
    `autoInitializeNativeSdk`), `src/api.ts` (a span around every request, each button press its
    own trace via `startNewTrace`), screens, `plugins/withUIScene.js` (copied from
    `examples/sentry-mobile`), `metro.config.js`, `app.json` with `disableAutoUpload`.
  - `build-it-yourself-guide.md`: DSN mapping table (sentry.io, self-hosted, self-hosted on this
    machine), plain API and app first, Sentry pointed straight at your Sentry (where a team is
    today), the stack, the one-line DSN change, the API traced, the same session side by side,
    "what each side shows that the other does not" (both ways), running the bridge for real
    (one replica N4, headers pass through, Sentry down, 429, latency, production TLS, going back),
    clean-up, troubleshooting. Every result file is an `<!-- embed: -->` block.
  - `README.md`: run `result/` as is, ports, things that bite.
- `examples/quickstarts/check-embeds.mjs`: also scans `examples/quickstarts-mobile` (M1's exact
  diff from the shared notes folder, so the PRs merge cleanly).
- kb `sentry-bridge-real-upstream.md` (DSN mapping, 429 / outage behaviour, metric gap, Expo 57
  pitfalls), kb index line, this summary and the summaries index line.

## Dependencies (new, example only)

- app: `@sentry/react-native` 8.32.0 (the SDK the quickstart is about; 8.x because 7.11.0 is
  partial under Expo 57), `@sentry/core` 10.76.2 (`startNewTrace`, at the SDK's exact version),
  `@react-navigation/native` + `native-stack`, `react-native-screens`,
  `react-native-safe-area-context` (the index's navigation stack); the rest is the Expo
  `blank-typescript@sdk-57` template. Lockfile committed.
- backend: express and the OpenTelemetry Node packages of tiny-shop-otel minus
  `baggage-span-processor` and `cors`. Lockfile committed.

## How it was verified

Stack `result/stack` as compose project `qs-m4` on M4's ports (Grafana 34000, bridge 34320, OTLP
34318, Tempo 34200, Loki 34100, Mimir 34009, health 34133), API on 34501, Metro 34081, simulator
`ouo-qs-tiny-shop-mobile-sentry` (iPhone 18 Pro, iOS 27.0) created for this run and deleted at the
end, bundle id `dev.ouo.tinyshop.m4`. `result/app` built with `expo run:ios` (Debug) and
`--configuration Release`. Every action by real taps (the iOS Simulator tool), no deep links.

1. **Forwarding, fake upstream** (`collector/tools/sentrytap`, A in front of the bridge, B as
   `OUO_SENTRY_UPSTREAM=http://host.docker.internal:34421`):
   - Debug journey (two products, checkout, broken API, handled error): `sentrytap compare` 21/21
     byte-identical, 0 problems; items: 9 `replay_video`, 6 `transaction`, 4 `log`,
     4 `client_report`, 2 `session`, 1 `event`.
   - Release (handled error, JS fatal, relaunch, native crash, relaunch): 42/42 byte-identical.
   - **429** (B `-status 429 -rate-limits 60::organization -retry-after 60`): A recorded `429` with
     both headers; the next error within 60 s was never sent; no `exception` in Loki.
   - **Upstream down** (B stopped): A saw `EOF` (bridge aborted); after B restarted and the app
     relaunched, the same `event_id` arrived at B and Loki held it once, plus a
     `sentry.unsampled_error` for the error Sentry had refused with 429.
2. **ouo side** (both fake-upstream runs): rum-api sessions `errored` (1 error, 1 failed request,
   6 traces, video replay 50 s), `crashed` (JS fatal, 1 error + 1 crash) and `crashed` (native);
   Loki lines readable (`added Coffee to cart`, `order 66373 placed: 2 items, $7`,
   `Error: Coupon service timed out`); Tempo: every API server span (products, checkout, fail) is a
   child of an app span in the same trace, checkout = app `checkout` -> `POST` -> `POST
   /api/checkout` -> `checkout` -> `validate cart`, `charge card`; Mimir
   `ouo_sentry_envelopes_total{outcome}`. Grafana plugin session page: state, device, OS, vitals,
   masked Sentry replay with tap / fatal / error markers, activity (all 3 requests), traces, logs.
3. **Real upstream: self-hosted Sentry 26.10** (`sentry-sbx`, started at 01:44 once no other
   `qs-m*` project ran, after waiting from 01:17; stopped at the end; volumes kept). New project
   `tiny-shop-mobile` (id 3) created with `sentry exec`; bridge upstream
   `http://host.docker.internal:9000` exactly as the guide says, tap A in front. Release journey
   (guide step 8): 40 envelopes, all `200` from Sentry (`Server: nginx` passed through).
   Relay showed `deadline exceeded` (kb taskbroker stall); `restart taskbroker` fixed it.
   Compared through Sentry's API and UI and ouo:

   | | Sentry | ouo |
   |---|---|---|
   | sessions | 2 crashed, 1 healthy (release `dev.ouo.tinyshop.m4@1.0.0+1`) | 2 crashed, 1 healthy |
   | errors | 3 issues: `EXC_BAD_ACCESS` fatal, "Cart total is NaN" fatal, "Coupon service timed out" error | 3 `exception` records, same messages |
   | logs | 3 app + 3 `Running "main"` | 3 `log` + 3 `console` |
   | replay | `de88d544…` 13 segments 72 s, `ea9b7291…` 3 segments 16 s | same replay ids, 13 and 3 segments, 72 s and 16 s |
   | checkout trace `7cefc524…` | 2 spans (`ui.action`, `http.client`) | the same 2 + the API's 6 |

   Tempo check: 4 API entry spans, all under an app span, none orphaned.
4. Guide intermediates: the plain step-3 app typechecks and bundles (`expo export`, 830 modules);
   the plain step-2 API answers `/api/products` and `500` on `/api/fail`; `npm ls @sentry/core`
   one copy. `check-embeds.mjs` in sync (29 blocks); lychee offline 0 errors on
   `examples/quickstarts-mobile`. Both Sentry build phases print "SENTRY_DISABLE_AUTO_UPLOAD=true,
   skipping": nothing was ever sent to sentry.io.

Not done: a literal walk of the guide by a person; the sentry.io variant of the DSN mapping is
documented, not run (rule: nothing to sentry.io from this repo).

## Versions

Expo 57.0.31, React Native 0.86.3, `@sentry/react-native` 8.32.0 (sentry-cocoa 9.31.0 per the
SDK's user agent), `@sentry/core` 10.76.2, React Navigation 7.5.1 / native-stack 7.21.0,
react-native-screens 4.26.2, safe-area-context 5.7.0. Xcode 27.0 (27A266a), iOS 27.0 runtime
(24A434), CocoaPods 1.17.0, Node 24.15.0. Images pulled 2026-10-28: `ghcr.io/ouo11y/collector:latest`
= 0.4.0 `sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2`, `rum-api:latest`
= 0.5.0 `sha256:1ee9e606220df2c42f4ade4131fdd3f82085d6e814676a771754a85a6ae78336`, `grafana:latest`
= 0.5.0 `sha256:57607a3616c88867644be1f69abb4681ca73df05d6bf2682543418f0dfeb622f`;
`grafana/tempo:3.0.3` `sha256:0296560ac66f8a3600d7fb3014a52c189d4d9c3549ad6ff441bf2409855d68d5`,
`grafana/loki:3.7.7` `sha256:d70e4659623f3e109af669cae76fe2a5dd5be54e2298fe8aed380d982fbc2500`,
`grafana/mimir:3.2.1` `sha256:92838f113ba54230014e79bc812e57ca90bb9ebc06e665f59e4f700098c2dd04`.
Self-hosted Sentry 26.10.0.

## Ready to paste

Index row (`examples/quickstarts-mobile/index.md`, status column):

```
| M4 | [`tiny-shop-mobile-sentry`](tiny-shop-mobile-sentry/README.md) | N61 | "keep Sentry, add ouo": the bridge forwards every envelope to a real Sentry (your sentry.io project, or self-hosted) and the same session shows in both UIs; what each side shows that the other does not | done ([#103](https://github.com/ouo11y/ouo11y/pull/103)) |
```

Checklist (`project/tracker/checklist.md`):

```
- [x] N61 `examples/quickstarts-mobile/tiny-shop-mobile-sentry`: keep Sentry, add ouo; `@sentry/react-native` 8.32.0 with the bridge as DSN host and a real upstream, the same session in Sentry and ouo11y RUM, what each side shows that the other does not, operating notes (one replica, headers pass through, Sentry down, 429) [2026-10-28: sentrytap 21/21 and 42/42 byte-identical (Debug, Release with JS fatal and native crash), 429 and outage behaviour checked; self-hosted Sentry 26.10 upstream, 40 envelopes 200, sessions, errors, logs, replay ids and the checkout trace equal on both sides, the API's spans only in Tempo; [summary](../agents/fast-tracked/summaries/2026-10-28-quickstart-tiny-shop-mobile-sentry.md)]
```

## Found

1. **No metric shows what Sentry refused.** `ouo_sentry_envelopes_total` counts a `429` (any
   non-2xx upstream answer) as `outcome="forwarded"`, and `ouo_sentry_items_total` does not count
   that envelope's items at all. An operator cannot see from ouo how much ouo missed because
   Sentry rate limited. Repro: `sentrytap -listen 127.0.0.1:P -dir d -sink -status 429` as
   `OUO_SENTRY_UPSTREAM`, send one envelope, query
   `sum by (outcome) (ouo_sentry_envelopes_total)` in Mimir. Suggest an `upstream_rejected`
   outcome or a `status_class` label.
2. **`sentry_ui_url` is parsed but unused.** `collector/receiver/ouosentryreceiver/config.go`
   accepts it; nothing builds a link and the plugin has none, so going from an ouo error to the
   same event in Sentry means copying ids by hand (spec section 6 promises the link).
3. **Bridge-made timeline records have no readable body.** In Loki the `navigation`,
   `session.start`, `http.request.failed`, `ouo.app.start` and `ouo.screen.display` lines read
   just their event name (rule 6 of the quickstarts wants `GET http://localhost:5001/api/fail 500`).
   Repro: any bridged session, `{service_name="tiny-shop-mobile"}` in Explore.
4. **npm in the worktrees** (environment, already in the shared notes and kb `funnels.md`): the
   founder's main checkout is mid-merge; npm walks up into its conflicted workspace
   `package.json` and fails with "Exit prior to config file resolving". Worked around with
   `--no-workspaces` and scratchpad copies.

## For the next agent

- CI's `quickstart` job (which runs `check-embeds.mjs`) is triggered by `^examples/quickstarts/`
  only; a PR that touches only `examples/quickstarts-mobile/` skips it. Add the mobile folder to
  that path flag in `.github/workflows/ci.yml` once one of the M1 to M5 PRs has landed.
- The guide's step 4 points the DSN straight at the reader's Sentry; in this repo that step was
  verified only against the fake upstream and self-hosted Sentry, never sentry.io.
- Taps: the iOS Simulator tool's tap works headless; take screenshots a second after a tap
  (transitions lag), coordinates are device points (402 x 874 on iPhone 18 Pro).
- Nothing left running: `qs-m4` down with volumes, `sentry-sbx` down (volumes kept, it was not
  running before), simulator deleted, every process started here stopped.
