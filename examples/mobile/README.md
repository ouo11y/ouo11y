# mobile-store (examples/mobile)

Expo managed app that exercises `@ouo/react-native` against the demo backend: the same
storefront flows as `examples/web` plus a Chaos screen with one button per row of the
session spec / ADR-0004 classification.

Screens: Products, Product, Cart, Checkout (`card` succeeds, `broken-card` makes the
backend answer 500), Order, Chaos. The header badge shows `v<app version> · <short session id>`
and updates when the session rotates.

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
# from the repo root: build the SDK first (Metro consumes dist/index.js)
npm run -w sdk/react-native build

cd examples/mobile
npm install
npx expo start --ios                      # iOS Simulator (needs Xcode + Expo Go)
APP_VERSION=2.4.0 npx expo start --ios    # a second app version for the health split
npx expo start --web --port 8083          # react-native-web build in a browser
npx expo export --platform ios            # bundle check without a simulator
```

Rebuild the SDK after changing it; Metro follows the symlink but reads `dist/`.

## Verify

```bash
curl -s 'localhost:8080/v1/sessions?from=now-1h&platform=mobile' | jq '.sessions[] | {session_id, service_version, status, end_reason}'
curl -s 'localhost:8080/v1/stats/health?from=now-1h&platform=mobile' | jq .buckets
```

Without a simulator, `sdk/react-native/playground/` runs the same flows headlessly against
the real collector (see the SDK README).
