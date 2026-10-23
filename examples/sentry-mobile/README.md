# sentry-mobile: the Sentry path (`@sentry/react-native` through the ouo bridge)

Expo (React Native) iOS app instrumented with `@sentry/react-native` and, depending on the
rollout flag, `@ouo11y/react-native` ("Rollout modes" below). It exists to generate real Sentry
mobile SDK traffic (sentry-cocoa native layer plus the RN JS
layer, including mobile Session Replay) for the ouo Sentry bridge (ADR-0008,
`docs/specs/sentry-bridge.md`). Knowledge and gotchas: `project/kb/sentry-react-native-demo.md`.

The DSN must point at a local host: the `ouosentry` receiver (the bridge) or a recorder
(`scripts/recorder.py`). Never point it at sentry.io from this repo.

Path: `@sentry/react-native` → the ouo Sentry bridge (the collector's `ouosentry` receiver) →
fan-out to Sentry (self-hosted `sentry-sbx`, or your own) and to ouo (Loki / Tempo / rum-api);
`fetch` to `examples/backend` with `traceparent` (`propagateTraceparent: true`), so app and
backend spans are one trace. The stack's bridge defaults to `upstream: none`: it runs without any
Sentry. Client setup notes (sampling, propagation targets, breadcrumbs, parallel mode):
[`docs/sentry-client-setup.md`](../../docs/sentry-client-setup.md).

## Five-minute run

Needs Docker, Node 24, Python 3, Xcode with an iOS Simulator booted (the first app build takes
about 8 minutes; later runs only the journey).

**Plain compose (clients).** The stack with the released images (`ghcr.io/ouo11y/*:0.3.0`). The
packages are private for now: ask for read access, then log in once with a classic token that has
only `read:packages` (`examples/fast-tracked/00-stack.md`, "Pull access"):

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.images.yaml up -d
cp examples/sentry-mobile/.env.example examples/sentry-mobile/.env   # bridge on :4320, backend on :8081
examples/sentry-mobile/scripts/run.sh --build       # build + install, journey, verify
```

**ouo-env (us).**

```bash
deploy/envs/ouo-env up sentry-demo --images         # or without --images: this checkout's build
examples/sentry-mobile/scripts/run.sh --env sentry-demo --build
deploy/envs/ouo-env down sentry-demo
```

`run.sh` runs a short unattended journey on the booted simulator (`scripts/journey.sh`:
launch, navigation, network calls including a 500, one shop round, errors; `--full` adds the
background rotation and a native crash) and then `scripts/verify.py`:

- rum-api has the bridged sessions with their traces and, when rum-api and the collector have
  mobile vitals (after 0.3.0), the app start and time to initial display
  (`docs/specs/mobile-vitals.md`);
- trace continuity, checklist N24 (`examples/tools/tracecheck.py`):
  - every request the backend logged is a sampled trace in Tempo;
  - no backend span has a missing parent (Sentry sends a random parent span id when no span is
    active, `src/api.ts` gives such requests their own transaction);
  - app and backend spans share one trace id, with no dropped trace;
  - CORS allows `traceparent`, `tracestate`, `baggage` and `sentry-trace`;
  - every app span came through the bridge;
  - no ouo SDK span is in the window: the default build runs Sentry only
    (`OUO_FLAG_PROVIDER=memory`, `OUO_RUM_MODE=sentry`). Never the ouo SDK and the bridge at once.

**With a real Sentry.** Point the stack's bridge at it, not the app:
`OUO_SENTRY_UPSTREAM=https://sentry.example.com`, plus `OUO_SENTRY_PROJECT_ID` and
`OUO_SENTRY_PUBLIC_KEY` of your project, in `deploy/compose/.env` (or the env's), then build the
app with that key and project in `SENTRY_DSN` (host still the bridge). The bridge forwards every
envelope unchanged and answers with Sentry's response. Our run against self-hosted Sentry:
`project/kb/sentry-self-hosted.md`.

CI cannot run an iOS Simulator on Linux: the `examples` job in `.github/workflows/ci.yml`
typechecks the app and sends the same headers and envelopes from `scripts/ci-journey.py` through
the real bridge and backend, then runs the same `verify.py`.


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
| `xhr-cart` | `GET /api/cart` through a raw `XMLHttpRequest` (axios' transport in React Native) in a `ui.action` transaction |
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
(`ghcr.io/ouo11y/collector`, version pinned by `OUO_COLLECTOR_VERSION` in
`deploy/compose/.env.example`). The ouo images are **private for now**, so log in to ghcr.io
once first. You need read access to the ouo packages (ask the ouo founder) and a classic
personal access token with only the `read:packages` scope, kept in your shell and never in the
repo (details: `examples/fast-tracked/00-stack.md`, Step 3, "Pull access"):

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

Then start the main stack with the released images:

```bash
docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.images.yaml up -d
```

Without a login the pull fails with `denied` (HTTP 403). No access yet, or testing collector or
plugin changes from this checkout: build from source instead by leaving
`-f deploy/compose/compose.images.yaml` out; that needs no login
(`examples/fast-tracked/00-stack.md`, Step 3).

## Configuration (build time, `app.config.ts`)

| Variable | Default |
|---|---|
| `SENTRY_DSN` | `http://publickey0000000000000000000000@localhost:4400/1` |
| `BACKEND_URL` | `http://localhost:8082` (demo backend of the main `ouo` compose stack). Build with the backend of the stack whose collector receives the app's traffic, or the backend spans land in another Tempo: `BACKEND_URL=http://localhost:8084` for the isolated `ouo-sb` stack |
| `APP_VERSION`, `BUILD_NUMBER` | `1.0.0`, `1`: release `sentry-demo@1.0.0+1`, dist `1` |
| `SENTRY_ENVIRONMENT` | `development` |
| `SENTRY_DEBUG=1` | SDK debug logging (JS and native), off by default |
| rollout variables | see "Rollout modes" below |

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

## Rollout modes: Sentry, both, or ouo, picked at runtime

The OpenFeature flag `ouo.rum.mode` decides at each cold start which SDK records
(`src/rollout.ts`, `index.ts`; the client-facing guide is [ROLLOUT.md](ROLLOUT.md)):

| Mode | What runs |
|---|---|
| `sentry` | Sentry only, DSN `SENTRY_DSN` (the ouo bridge) |
| `parallel` | Sentry with DSN `SENTRY_DIRECT_DSN` (straight to Sentry, never the bridge) + `@ouo11y/react-native` with replay off, initialised after Sentry, forwarding unhandled rejections to Sentry |
| `ouo` | `@ouo11y/react-native` only, replay on; `Sentry.init` is never called |

A new flag value applies at the next launch (each launch stores the flag's answer for the
next one); only the first launch after install waits for the flag (`OUO_FLAG_TIMEOUT_MS`,
default 1500), then falls back to `OUO_DEFAULT_MODE` (`sentry`). The decision and the device's
bucketing id live in `Documents/ouo-rum-mode.json`; the status line shows
`rum mode <mode> (<stored|flag|default>)`. ouo records carry the resource attribute
`ouo.rum.mode`, Sentry events the tag `ouo.rum.mode`; the bridge stamps `ouo.rum.mode = sentry`.
ouo exports as service `sentry-demo-ouo` to `OUO_OTLP_ENDPOINT` / `OUO_REPLAY_ENDPOINT`.
`src/monitoring.ts` sends the app's own `captureException`, `captureMessage` and `flush` calls to
whichever SDKs run. `App.tsx` wraps the app in `RUMProvider` and feeds navigation to ouo when ouo
runs, as the SDK README says. Findings: `project/kb/openfeature-rum-mode.md`, `project/kb/ouo-next-to-sentry.md`.

| Variable | Default |
|---|---|
| `OUO_FLAG_PROVIDER` | `ofrep` (flagd or any OFREP server at `OUO_FLAG_URL`, default `http://localhost:8016`); `memory` pins `OUO_RUM_MODE` without a server |
| `SENTRY_DIRECT_DSN` | `http://publickey0000000000000000000000@localhost:4401/1` (stands in for sentry.io) |

```bash
docker compose -p ouo-flagd -f flags/compose.yaml up -d      # flagd with flags/ouo-rum-mode.flagd.json
SENTRY_DSN=http://publickey0000000000000000000000@localhost:4340/1 BACKEND_URL=http://localhost:8084 scripts/build-ios.sh
# one cohort: pin the mode in a copy of the flag file flagd reads, two launches, short journey
scripts/rollout-journey.sh --mode parallel --flags-file <flagd json> [--fresh]
scripts/verify-rollout.py --mode parallel --start <start> --end <end> --sentry-capture <sentrytap dir>
```

`verify-rollout.py` expects the Sentry upstream of the bridge and `SENTRY_DIRECT_DSN` to be the
same sentrytap capture (what sentry.io would receive), and checks Sentry, Loki, Tempo and rum-api
for the cohort. Quick local test without flagd: `OUO_FLAG_PROVIDER=memory OUO_RUM_MODE=ouo
scripts/build-ios.sh`. The former build flag `OUO_SDK=1` is gone (the build fails with a pointer
here); `parallel` is what it did.

## Overhead measurement (`OUO_PERF=1`, `scripts/perf/`)

What the SDKs cost on the device, per SDK mix, from one binary. Built with `OUO_PERF=1`, the app
reads `Documents/perf-mode.json` at start (`{"mode": "none" | "sentry" | "parallel" | "ouo",
"ouoReplay"?: bool}`) instead of the flag (`src/rollout.ts`; nothing is evaluated or stored for
that launch) and runs a JS frame monitor (`src/perf.ts`) that writes `Documents/perf.json`. The
harness modes are `none` (no SDK), `sentry`, `both` (`parallel`), `both-replay` (`parallel` with
ouo replay forced on) and `ouo-replay` (`ouo`). Without `OUO_PERF=1` both are no-ops.

| Script | Does |
|---|---|
| `scripts/perf/proxy.py` | counting HTTP forwarder between the app and the stack: one JSON line per request (destination, bytes up and down, status) |
| `scripts/perf/sample.py` | samples the app process from the host every 0.5 s: CPU time, phys_footprint, lifetime peak, energy (`proc_pid_rusage`), process start time |
| `scripts/perf/driver/` | XCUITest bundle (`make-driver.rb` generates the Xcode project with the CocoaPods xcodeproj gem): real taps on a fixed 95 s schedule |
| `scripts/perf/run.sh` | the loop: per run, wipe the app's Library, write the mode, sample, drive, collect; modes interleaved |
| `scripts/perf/analyze.py`, `report.py` | medians and spread per mode; the HTML report |

Method, numbers and caveats: `project/kb/sdk-overhead-ios.md`; last report:
`project/agents/sentry-demo/reports/sdk-overhead-ios.html`.

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
