# ouo-mobile: the ouo React Native path (`@ouo11y/react-native`)

Expo managed app that exercises `@ouo11y/react-native` against the demo backend: the same
storefront flows as `examples/ouo-web` plus a Chaos screen with one button per row of the
session spec / ADR-0004 classification.

Screens: Products, Product, Cart, Checkout (`card` succeeds, `broken-card` makes the
backend answer 500), Order, Chaos. The header badge shows `v<app version> · <short session id>`
and updates when the session rotates.

Session replay (iOS and Android, ADR-0006) is enabled in `src/rum.ts` (`replay: { enabled: true }`). The
Checkout screen has a promo-code field with `testID="ouo-mask"` and the Product screen's title
has `testID="ouo-unmask"` to show the two overrides; the Chaos screen's "Replay pause/resume"
button toggles the recorder and shows `rum.replay.isRecording()`. Replay only records in a
development build (below), never in Expo Go or on web.

The Cart screen has a "Report a problem" form (`src/FeedbackForm.tsx`): it calls
`rum.feedback({ message, contact, screenshot: true })`, and the session page in Grafana lists the
feedback beside the replay with the last 20 steps before it and a seek to the replay at that time
(spec C10). The scripted journey (`scripts/journey.sh`) sends one on the Cart screen and
`scripts/verify.py --feedback` checks it.

Chaos buttons: slow request (`?delay=2000`), 500 from the backend (`?fail=500` ->
`http.request.failed`, session `errored`), handled error (`captureError`, non-fatal),
unhandled promise rejection (non-fatal, unhandled), **fatal error** (thrown from a
`setTimeout` so it reaches `ErrorUtils` with `isFatal = true`: `exception` with
`ouo.exception.fatal = true`, crash marker, session `crashed`; relaunch the app and the SDK
emits `session.end` with reason `crash`), `console.error` (handled, non-fatal), custom event,
set user, flush. In a development or Release build two more come from the demo-only native module
`modules/ouo-chaos` (not part of the SDK): **hang the main thread** for 3 s (one non-fatal `hang`
exception when it is over) and **out-of-memory kill** (a memory warning, then `SIGKILL`, what
jetsam does: the next launch reports a fatal `termination` with cause `memory`). The journey
mailbox also takes `action/hang?ms=3000`, `action/stutter?ms=1200&times=3` and `action/oom`
(`project/agents/mobile-sdk/verify/w4-signals-sim.sh` uses them). Products calls
`rum.reportFullyDisplayed()` once the catalog is on screen (TTFD).

Path: `@ouo11y/react-native` → ouo collector (OTLP + replay) → Loki / Tempo / Mimir and rum-api,
and `fetch` to `examples/backend` with `traceparent` and `baggage` (with `session.id`), so app and
backend spans are one trace. Sentry is not in this app: never run the ouo SDK and the Sentry bridge
into ouo at the same time (`docs/sentry-client-setup.md`, section 6).

## Five-minute run

Needs Docker, Node 24, Python 3, Xcode with an iOS Simulator booted (the first app build takes
about 8 minutes; later runs only the journey).

**Plain compose (clients).** The stack with the released images (`ghcr.io/ouo11y/*:0.3.0`). The
images are public, no `docker login`:

```bash
docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.images.yaml up -d
npm ci && npm run -w sdk/react-native build          # the app links the SDK from this checkout
examples/ouo-mobile/scripts/run.sh --build           # Release build + install, journey, verify
```

**ouo-env (us).**

```bash
deploy/envs/ouo-env up mobile-demo --images           # or without --images: this checkout's build
examples/ouo-mobile/scripts/run.sh --env mobile-demo --build
deploy/envs/ouo-env down mobile-demo
```

`scripts/build-ios.sh` bakes the stack's URLs into a Release build (`.env`, copied from
`.env.example`, or `--env`), so no Metro is involved and `expo.extra` always matches the stack.
`run.sh` then drives the app through `scripts/journey.sh`: products, two items into the cart,
a card checkout, a `broken-card` checkout (500) and a 500 from the Chaos screen. The commands go
through a file the app polls (`src/journey.ts`), because `simctl openurl` prompts on iOS 27.
`scripts/verify.py` then checks:

- rum-api has the session with traces and both failed requests;
- trace continuity, checklist N24 (`examples/tools/tracecheck.py`):
  - every request the backend logged is a sampled trace in Tempo;
  - no backend span has a missing parent;
  - app and backend spans share one trace id;
  - backend spans carry the `session.id` from baggage;
  - one backend span per request, with no dropped trace;
  - CORS allows `traceparent`, `tracestate` and `baggage`;
  - nothing in the window came through the Sentry bridge.

Mobile vitals (`docs/specs/mobile-vitals.md`) are checked with `--vitals` once the SDK emits them.

CI cannot run an iOS Simulator on Linux: the `examples` job in `.github/workflows/ci.yml`
typechecks the app and runs the SDK's built bundle in Node (`sdk/react-native/playground`) against
the same stack and `verify.py`.

## Android (emulator)

Needs JDK 17, the Android SDK and an emulator ([project/kb-archive/android-setup.md](../../project/kb-archive/android-setup.md)).
`scripts/build-android.sh` builds the Release APK with the stack's URLs baked in (`--env <name>` uses an
ouo-env's ports on `10.0.2.2`, the emulator's address of the Mac; `--host <LAN IP>` for a phone) and
installs it; `plugins/withAndroidCleartext.js` lets the Release build talk plain http to the local
stack. The journey's commands reach the app as broadcasts handled by `modules/ouo-chaos` (Android side):

```bash
deploy/envs/ouo-env up mobile-demo --images
examples/ouo-mobile/scripts/build-android.sh --env mobile-demo --conformance   # the journey commands need it (or a debug build)
adb shell am start -n dev.ouo.mobilestore/.MainActivity
adb shell "am broadcast -a dev.ouo.mobilestore.JOURNEY -p dev.ouo.mobilestore --es cmd 'screen/Cart'"
```

`--conformance` builds the golden app of the Android conformance suite
([tests/e2e/mobile-android](../../tests/e2e/mobile-android/README.md)): default replay masking, a 5 s
background timeout, and `OUO_NOTE` lines in logcat. The Product screen shows an image so the suite can
check that images are masked.

## Configuration

`app.config.ts`:

| Setting | Default | Override |
|---|---|---|
| `version` (-> `service.version`) | `2.3.0` | `APP_VERSION=2.4.0 npx expo start --ios` |
| `extra.backendUrl` | `http://localhost:8081` | `BACKEND_URL` |
| `extra.otlpEndpoint` (-> `initRUM({ endpoint })`) | `http://localhost:4318` | `EXPO_PUBLIC_OTLP_ENDPOINT` |
| `extra.projectId` (-> `initRUM({ projectId })`) | `demo` | `EXPO_PUBLIC_OUO_PROJECT_ID` |
| `extra.projectToken` (-> `initRUM({ projectToken })`) | `pt_dev_demo_0000000000000000` | `EXPO_PUBLIC_OUO_PROJECT_TOKEN` |
| `extra.environment` | `local` | `OUO_ENV` |

Since ADR-0007 the app talks only to the collector (`ouo-collector`): OTLP goes to
`${otlpEndpoint}/v1/{traces,logs}` and replay chunks to the collector's replay receiver on port
4319 (`http://localhost:4319/v1/replay/chunks`, derived by the SDK from port 4318), every request
with `Authorization: Basic base64("<projectId>:<projectToken>")`. rum-api is internal and the app
never addresses it. The defaults are the development project of the stock compose stack
(`deploy/compose/.env.example`, user `demo` in the collector's htpasswd).

If you moved ports or changed the project in `deploy/compose/.env`, copy `.env.example` to `.env`
here; Expo CLI loads it into `process.env` before evaluating `app.config.ts`. When the collector
sits behind a proxy on one host (`https://otel.example.com`), set `EXPO_PUBLIC_OTLP_ENDPOINT` to it
and the SDK uses the same host for replay; pass `replayEndpoint` in `src/rum.ts` only if the
replay receiver lives elsewhere.
From the iOS Simulator `localhost` reaches the Mac; a physical device needs the Mac's LAN IP
in `BACKEND_URL` / `EXPO_PUBLIC_OTLP_ENDPOINT`.

Typecheck: `npx tsc --noEmit` in this folder (after `npm install`).

## Run

This app is **not** an npm workspace: it has its own `package.json` and lockfile and links
the SDK with `"@ouo11y/react-native": "file:../../sdk/react-native"` plus `metro.config.js`
(watch folder, block list for the SDK's `node_modules`, peer redirection). See
`project/kb-archive/otel-react-native.md`.

```bash
# from the repo root: build the SDK first (Metro consumes dist/index.js, CocoaPods the vendored Swift sources)
npm run -w sdk/react-native build

cd examples/ouo-mobile
npm install
npx expo start --ios                      # Expo Go: telemetry only, replay stays off
APP_VERSION=2.4.0 npx expo start --ios    # a second app version for the health split
npx expo start --web --port 8083          # react-native-web build in a browser
npx expo export --platform ios            # bundle check without a simulator
```

### Development build (replay)

The `OuoReplay` Expo module is native code, so the app must be built with Xcode once
(`project/kb-archive/xcode-setup.md` has the full machine setup):

```bash
cd examples/ouo-mobile
npx expo prebuild --platform ios          # generates ios/ (gitignored), runs pod install
npx expo run:ios                          # builds the dev client, boots the simulator, starts Metro
APP_VERSION=2.4.0 npx expo run:ios
```

`npm run ios` is `expo run:ios` since prebuild. `ios/` and `android/` are generated and
gitignored: re-run `prebuild` after changing `app.config.ts` or the SDK's native sources
(`--clean` to start over). Without Xcode, `npx expo prebuild --platform ios --no-install` still
generates the project and `npx expo-modules-autolinking resolve -p apple` lists the three ouo
pods, which is as far as this machine got (see `project/agents/ios-replay/`).

Rebuild the SDK after changing it; Metro follows the symlink but reads `dist/`.

## Verify

rum-api stays internal (ADR-0007); in the local stack its port 8080 is published on loopback for
these checks. When `OUO_READ_TOKEN` is set (the compose stack sets it in `deploy/compose/.env`), the
read endpoints need `-H "Authorization: Bearer $OUO_READ_TOKEN"`. The app itself never talks to
rum-api: its OTLP and replay uploads carry the project credential to the collector.

```bash
curl -s 'localhost:8080/v1/sessions?from=now-1h&platform=mobile' | jq '.sessions[] | {session_id, service_version, status, end_reason}'
curl -s 'localhost:8080/v1/stats/health?from=now-1h&platform=mobile' | jq .buckets
curl -s "localhost:8080/v1/sessions/<session id>/replay" | jq        # kind: frames, chunk_count, frame_count
```

In Grafana (ouo11y RUM app) the session's replay plays as frames with touch markers. The demo sets
`replay: { enabled: true, maskText: false }` (`src/rum.ts`) so labels are readable in replays;
text inputs, images and web views keep the default masking, so the promo field is black.

Without a simulator, `sdk/react-native/playground/` runs the same flows headlessly against
the real collector (`OUO_OTLP`, `OUO_PROJECT_ID`, `OUO_PROJECT_TOKEN`; see the SDK README).
