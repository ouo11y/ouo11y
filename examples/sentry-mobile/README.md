# sentry-demo (examples/sentry-mobile)

Expo (React Native) iOS app instrumented **only** with `@sentry/react-native` (no ouo SDK). It
exists to generate real Sentry mobile SDK traffic (sentry-cocoa native layer plus the RN JS
layer, including mobile Session Replay) for the ouo Sentry bridge (ADR-0008,
`docs/specs/sentry-bridge.md`). Knowledge and gotchas: `kb/sentry-react-native-demo.md`.

The DSN must point at a local host: a recorder (`scripts/recorder.py`) or the `ouosentry`
receiver. Never point it at sentry.io from this repo.

## What is in it

- Screens: Home (3 products from the backend, action buttons), Product, Cart.
- `src/sentry.ts`: `Sentry.init` with `tracesSampleRate: 1`, React Navigation integration
  (`navigation` transactions, time to initial display), fetch tracing with W3C `traceparent`
  (`propagateTraceparent: true`, so the OpenTelemetry demo backend joins the app's traces),
  structured logs (`enableLogs: true`; this also captures `console.*`), native auto session
  tracking, `mobileReplayIntegration` with masking **off** (`maskAllText`, `maskAllImages`,
  `maskAllVectors` false; demo only, the app shows no personal data) at
  `replaysSessionSampleRate: 1` and `replaysOnErrorSampleRate: 1`.
- `src/actions.ts`: every action, also reachable by deep link.

| Action (deep link `sentrydemo://action/<name>`) | What Sentry records |
|---|---|
| `fetch-ok` | `GET /api/products` inside a `ui.action` transaction (`action fetch-ok`), `http.client` span status 200 |
| `fetch-500` | `GET /api/products?fail=500` in a `ui.action` transaction, `http.client` span with `http.response.status_code` 500 and span status `internal_error`; no error event (the app catches it) |
| `fetch-slow` | `GET /api/products?delay=2500` in a `ui.action` transaction |
| `handled-error` | `Sentry.captureException`: `event`, level `error`, mechanism `generic`, `handled: true`; the session `errors` count goes up |
| `message` | breadcrumb plus `Sentry.captureMessage(..., "info")`: `event` level `info`, no exception |
| `unhandled-rejection` | `Promise.reject` nobody awaits: `event` level `error`, mechanism `onunhandledrejection` but `handled: true` (sic, SDK 8.30); session stays `ok`, `errors` + 1; the app keeps running |
| `js-fatal` | `throw` inside `setTimeout`: `event` level `fatal`, mechanism `onerror`, `handled: false`, sent together with the session update `crashed` before RN terminates the app (Release). Opt-in in the journey (`--js-fatal`) |
| `native-crash` | `Sentry.nativeCrash()`: on the **next** launch sentry-cocoa sends `event` (level `fatal`, `EXC_BAD_ACCESS`, mechanism `mach`, `handled: false`) + session `crashed` in one envelope, after the new session's `init` |
| `browse-catalog` | new trace (`startNewTrace`), `ui.action` transaction `browse catalog` with manual spans `load catalog`, `load product details` (4 parallel `GET /api/products/{id}`), `rank products`; one `Sentry.logger.info` |
| `search` | new trace, `search products`: `query backend` (`GET /api/products?delay=600`, the backend sleeps in a `db.query` span), `filter results`; `logger.debug` + `logger.info` |
| `checkout` | new trace, `checkout`: `pick products`, two `add <id> to cart` (`POST /api/cart`), `review cart`, `submit order` (`POST /api/checkout`); `logger.info` with cart and order attributes |
| `checkout-fail` | same with `paymentMethod: broken-card`: the backend answers 500, root span status `internal_error`, `logger.error` |
| `flush` | `Sentry.flush()` |

Every action runs in its own trace (`startNewTrace` from `@sentry/core`, which
`@sentry/react-native` does not re-export): without it the JS SDK reuses the scope's trace id for
every root span until the next navigation, and Tempo would show one trace per screen. The Product
screen logs `viewed product` and `added ... to cart` with `Sentry.logger.info`.

Screens: `sentrydemo://screen/home`, `sentrydemo://screen/product?id=p-1002`,
`sentrydemo://screen/cart`, `sentrydemo://screen/back`.

## The stack it talks to

The `ouosentry` receiver ships in the released ouo collector image
(`ghcr.io/ziadmansourm/ouo/collector`, version pinned by `OUO_COLLECTOR_VERSION` in
`deploy/docker/.env.example`). The ouo images are **private for now**, so log in to ghcr.io
once first. You need read access to the ouo packages (ask the ouo founder) and a classic
personal access token with only the `read:packages` scope, kept in your shell and never in the
repo (details: `examples/fast-tracked/00-stack.md`, Step 3, "Pull access"):

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

Then start the main stack with the released images:

```bash
docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.images.yaml up -d
```

Without a login the pull fails with `denied` (HTTP 403). No access yet, or testing collector or
plugin changes from this checkout: build from source instead by leaving
`-f deploy/docker/compose.images.yaml` out; that needs no login
(`examples/fast-tracked/00-stack.md`, Step 3).

## Configuration (build time, `app.config.ts`)

| Variable | Default |
|---|---|
| `SENTRY_DSN` | `http://publickey0000000000000000000000@localhost:4400/1` |
| `BACKEND_URL` | `http://localhost:8082` (demo backend of the main `ouo` compose stack). Build with the backend of the stack whose collector receives the app's traffic, or the backend spans land in another Tempo: `BACKEND_URL=http://localhost:8084` for the isolated `ouo-sb` stack |
| `APP_VERSION`, `BUILD_NUMBER` | `1.0.0`, `1`: release `sentry-demo@1.0.0+1`, dist `1` |
| `SENTRY_ENVIRONMENT` | `development` |
| `SENTRY_DEBUG=1` | SDK debug logging (JS and native), off by default |

The values are baked into the embedded JS bundle, so rebuild after a change.

## Build (Release, simulator, no Metro)

```bash
cd examples/sentry-mobile
npm ci
scripts/build-ios.sh            # prebuild (first run), pod install, xcodebuild Release, simctl install
scripts/build-ios.sh --clean    # regenerate ios/ from app.config.ts first
```

Needs full Xcode (`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`, the script sets it)
and CocoaPods. `ios/` is generated and gitignored. `pod install` downloads the prebuilt
`Sentry.xcframework` from the sentry-cocoa GitHub release (cached in
`~/Library/Caches/sentry-react-native/`).

## Parallel mode: ouo SDK next to Sentry (`OUO_SDK=1`)

Built with `OUO_SDK=1`, the app also runs `@ouo/react-native` (`file:` link to
`../../sdk/react-native`, Metro rules in `metro.config.js`), the way an app on Sentry adopts
ouo: `src/ouo.ts` is imported after `src/sentry.ts` (index.ts), forwards unhandled rejections to
Sentry, and exports to the isolated `ouo-sb` collector (`OUO_OTLP_ENDPOINT`, default :4338;
`OUO_REPLAY_ENDPOINT`, default :4339) as service `sentry-demo-ouo`. Sentry's tracing skips the
ouo uploads (`shouldCreateSpanForRequest`). The action `xhr-cart` calls the backend through a
raw `XMLHttpRequest` (axios' transport in React Native). Without the flag the ouo SDK is linked
but never started. `App.tsx` wraps the app in `RUMProvider` and feeds navigation to ouo, as the SDK README says;
`OUO_REPLAY=0` builds parallel mode without the ouo replay. Findings: `kb/ouo-next-to-sentry.md`.

```bash
OUO_SDK=1 BACKEND_URL=http://localhost:8084 scripts/build-ios.sh
scripts/journey.sh --no-background --no-crash --shop-rounds 1
```

## Capture and journey

Preferred recorder: `collector/tools/sentrytap` (same capture format the bridge tests use).
`scripts/recorder.py` is a stdlib fallback; `scripts/analyze.py` reads both layouts.

```bash
# terminal 1, either:
(cd ../../collector/tools/sentrytap && go build -o /tmp/sentrytap .) && /tmp/sentrytap -listen 127.0.0.1:4400 -dir captures/run1 -sink
python3 -I scripts/recorder.py --out captures/run1   # fallback, listens on 127.0.0.1:4400
scripts/journey.sh                                # terminal 2: full unattended journey (~2.5 min)
scripts/journey.sh --no-crash --no-background     # shorter
python3 -I scripts/analyze.py captures/<run>      # item counts, sdk names, sessions, replay segments
python3 -I scripts/analyze.py captures/<run> --dump-replay /tmp/seg   # one segment's event, recording, mp4
```

The journey does not use `xcrun simctl openurl`: on iOS 27 every custom-scheme URL opened that
way shows an "Open in sentry-demo?" system alert that a script cannot dismiss (and while it is up
the app is inactive, so replay does not start). It writes the same deep-link path into
`Documents/journey-command` in the app's data container instead, which `src/mailbox.ts` polls.
`--openurl` switches back to real deep links for attended runs.

`journey.sh` phases: launch, nav, network, shop (`--shop-rounds N`, default 2: browse catalog,
search, a product screen, checkout, declined checkout), errors, replay wait, background (Settings
in front for 40 s, then relaunch: session `exited` plus a new session), crash (native crash,
relaunch), end. Flags: `--no-nav`, `--no-network`, `--no-shop`, `--no-errors`, `--no-background`,
`--no-crash`, `--js-fatal`, `--shop-rounds N`, `--bg-seconds N`, `--replay-wait N`,
`--device UDID`, `--openurl`.

The journey ends with `simctl terminate` (SIGKILL), so the last session is reported as
`abnormal` on the next launch.

`captures/` is gitignored.
