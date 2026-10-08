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
| `extra.backendUrl` | `http://localhost:8082` | `BACKEND_URL` |
| `extra.otlpEndpoint` | `http://localhost:4328` | `OTLP_ENDPOINT` |
| `extra.environment` | `local` | `OUO_ENV` |

The defaults are the host ports of `deploy/docker/.env` on the machine this was built on.
From the iOS Simulator `localhost` reaches the Mac; a physical device needs the Mac's LAN IP
in `BACKEND_URL` / `OTLP_ENDPOINT`.

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

```bash
curl -s 'localhost:8080/v1/sessions?from=now-1h&platform=mobile' | jq '.sessions[] | {session_id, service_version, status, end_reason}'
curl -s 'localhost:8080/v1/stats/health?from=now-1h&platform=mobile' | jq .buckets
curl -s "localhost:8080/v1/sessions/<session id>/replay" | jq        # kind: frames, chunk_count, frame_count
```

In Grafana (ouo RUM app) the session's replay plays as frames with touch markers. The demo sets
`replay: { enabled: true, maskText: false }` (`src/rum.ts`) so labels are readable in replays;
text inputs, images and web views keep the default masking, so the promo field is black.

Without a simulator, `sdk/react-native/playground/` runs the same flows headlessly against
the real collector (see the SDK README).
