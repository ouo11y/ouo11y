# mobile-store (examples/mobile)

Expo managed app that exercises `@ouo/react-native` against the demo backend: the same
storefront flows as `examples/web` plus a Chaos screen with one button per row of the
session spec / ADR-0004 classification.

Screens: Products, Product, Cart, Checkout (`card` succeeds, `broken-card` makes the
backend answer 500), Order, Chaos. The header badge shows `v<app version> · <short session id>`
and updates when the session rotates.

Session replay (iOS, ADR-0006) is enabled in `src/rum.ts` (`replay: { enabled: true }`). The
Checkout screen has a promo-code field with `testID="ouo-mask"` and the Product screen's title
has `testID="ouo-unmask"` to show the two overrides; the Chaos screen's "Replay pause/resume"
button toggles the recorder and shows `rum.replay.isRecording()`. Replay only records in a
development build (below), never in Expo Go or on web.

Chaos buttons: slow request (`?delay=2000`), 500 from the backend (`?fail=500` ->
`http.request.failed`, session `errored`), handled error (`captureError`, non-fatal),
unhandled promise rejection (non-fatal, unhandled), **fatal error** (thrown from a
`setTimeout` so it reaches `ErrorUtils` with `isFatal = true`: `exception` with
`ouo.exception.fatal = true`, crash marker, session `crashed`; relaunch the app and the SDK
emits `session.end` with reason `crash`), `console.error` (handled, non-fatal), custom event,
set user, flush.

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
(`deploy/docker/.env.example`, user `demo` in the collector's htpasswd).

If you moved ports or changed the project in `deploy/docker/.env`, copy `.env.example` to `.env`
here; Expo CLI loads it into `process.env` before evaluating `app.config.ts`. When the collector
sits behind a proxy on one host (`https://otel.example.com`), set `EXPO_PUBLIC_OTLP_ENDPOINT` to it
and the SDK uses the same host for replay; pass `replayEndpoint` in `src/rum.ts` only if the
replay receiver lives elsewhere.
From the iOS Simulator `localhost` reaches the Mac; a physical device needs the Mac's LAN IP
in `BACKEND_URL` / `EXPO_PUBLIC_OTLP_ENDPOINT`.

Typecheck: `npx tsc --noEmit` in this folder (after `npm install`).

## Run

This app is **not** an npm workspace: it has its own `package.json` and lockfile and links
the SDK with `"@ouo/react-native": "file:../../sdk/react-native"` plus `metro.config.js`
(watch folder, block list for the SDK's `node_modules`, peer redirection). See
`kb/otel-react-native.md`.

```bash
# from the repo root: build the SDK first (Metro consumes dist/index.js, CocoaPods the vendored Swift sources)
npm run -w sdk/react-native build

cd examples/mobile
npm install
npx expo start --ios                      # Expo Go: telemetry only, replay stays off
APP_VERSION=2.4.0 npx expo start --ios    # a second app version for the health split
npx expo start --web --port 8083          # react-native-web build in a browser
npx expo export --platform ios            # bundle check without a simulator
```

### Development build (replay)

The `OuoReplay` Expo module is native code, so the app must be built with Xcode once
(`kb/xcode-setup.md` has the full machine setup):

```bash
cd examples/mobile
npx expo prebuild --platform ios          # generates ios/ (gitignored), runs pod install
npx expo run:ios                          # builds the dev client, boots the simulator, starts Metro
APP_VERSION=2.4.0 npx expo run:ios
```

`npm run ios` is `expo run:ios` since prebuild. `ios/` and `android/` are generated and
gitignored: re-run `prebuild` after changing `app.config.ts` or the SDK's native sources
(`--clean` to start over). Without Xcode, `npx expo prebuild --platform ios --no-install` still
generates the project and `npx expo-modules-autolinking resolve -p apple` lists the three ouo
pods, which is as far as this machine got (see `agents/ios-replay/`).

Rebuild the SDK after changing it; Metro follows the symlink but reads `dist/`.

## Verify

rum-api stays internal (ADR-0007); in the local stack its port 8080 is published on loopback for
these checks. When `OUO_READ_TOKEN` is set (the compose stack sets it in `deploy/docker/.env`), the
read endpoints need `-H "Authorization: Bearer $OUO_READ_TOKEN"`. The app itself never talks to
rum-api: its OTLP and replay uploads carry the project credential to the collector.

```bash
curl -s 'localhost:8080/v1/sessions?from=now-1h&platform=mobile' | jq '.sessions[] | {session_id, service_version, status, end_reason}'
curl -s 'localhost:8080/v1/stats/health?from=now-1h&platform=mobile' | jq .buckets
curl -s "localhost:8080/v1/sessions/<session id>/replay" | jq        # kind: frames, chunk_count, frame_count
```

In Grafana (ouo RUM app) the session's replay plays as frames with touch markers. The demo sets
`replay: { enabled: true, maskText: false }` (`src/rum.ts`) so labels are readable in replays;
text inputs, images and web views keep the default masking, so the promo field is black.

Without a simulator, `sdk/react-native/playground/` runs the same flows headlessly against
the real collector (`OUO_OTLP`, `OUO_PROJECT_ID`, `OUO_PROJECT_TOKEN`; see the SDK README).
