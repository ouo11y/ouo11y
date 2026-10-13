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
  (`navigation` transactions, time to initial display), fetch tracing, native auto session
  tracking, `mobileReplayIntegration()` with default masking at `replaysSessionSampleRate: 1` and
  `replaysOnErrorSampleRate: 1`.
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
| `flush` | `Sentry.flush()` |

Screens: `sentrydemo://screen/home`, `sentrydemo://screen/product?id=p-1002`,
`sentrydemo://screen/cart`, `sentrydemo://screen/back`.

## Configuration (build time, `app.config.ts`)

| Variable | Default |
|---|---|
| `SENTRY_DSN` | `http://publickey0000000000000000000000@localhost:4400/1` |
| `BACKEND_URL` | `http://localhost:8082` (demo backend of the main `ouo` compose stack) |
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

`journey.sh` phases: launch, nav, network, errors, replay wait, background (Settings in front for
40 s, then relaunch: session `exited` plus a new session), crash (native crash, relaunch), end.
Flags: `--no-nav`, `--no-network`, `--no-errors`, `--no-background`, `--no-crash`, `--js-fatal`,
`--bg-seconds N`, `--replay-wait N`, `--device UDID`, `--openurl`.

The journey ends with `simctl terminate` (SIGKILL), so the last session is reported as
`abnormal` on the next launch.

`captures/` is gitignored.
