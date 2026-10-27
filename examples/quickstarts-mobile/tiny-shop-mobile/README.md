# Tiny Shop Mobile: Sentry React Native through the ouo bridge

An Expo app, Tiny Shop Mobile, that keeps `@sentry/react-native` and sends its traffic to ouo
instead of Sentry: the only change is the **DSN host**, which points at the ouo collector's Sentry
bridge. The bridge runs with `upstream: none`, so you need no Sentry account and nothing leaves
your laptop. Next to it, the Tiny Shop API (Express) is traced with the OpenTelemetry Node SDK,
and one tap is one trace across both:

```
tiny-shop-mobile      tap Checkout                 (ui.action transaction, @sentry/react-native)
└─ tiny-shop-mobile   POST                         (http.client span, sends traceparent)
   └─ tiny-shop-mobile-api  POST /api/checkout     (HTTP server span, OpenTelemetry Node SDK)
      └─ checkout
         ├─ validate cart
         └─ charge card
session: healthy, errored (500, handled error) or crashed (JS fatal), from Sentry's own sessions
logs: every Sentry.logger line in Loki, with its trace id and the session id
```

| Path | What |
|---|---|
| `result/app/src/config.ts` | the API URL and the Sentry DSN, which points at the bridge |
| `result/app/src/sentry.ts` | `Sentry.init`: tracing at 100 %, `traceparent` to the API only, structured logs |
| `result/app/src/api.ts` | the API calls, and `tap()`: a tap that calls the API is its own trace |
| `result/app/src/screens/` | Products (with the Debug section), Product, Cart |
| `result/app/app.json` | the bundle id, the Sentry Expo plugin with uploads off, the UIScene plugin |
| `result/app/plugins/withUIScene.js` | iOS 27 refuses to launch an app without the UIScene life cycle, which Expo 57's template does not add yet |
| `result/backend/` | the Tiny Shop API of [tiny-shop-otel](../../quickstarts/tiny-shop-otel/README.md), as `tiny-shop-mobile-api` |
| `result/stack/` | the ouo stack, one folder per service; `10-collector/config.yaml` turns the Sentry bridge on (port 4320) |

Two ways to use it:

- **Build it yourself (recommended):** [build-it-yourself-guide.md](build-it-yourself-guide.md)
  builds the same files from an empty folder: a plain app first, then the stack, then the API's
  traces, then Sentry pointed at the bridge. About 60 minutes, most of it the first iOS build.
- **Run the finished result:** the steps below.

Needs a Mac with Xcode 27 and an iOS 27 simulator, Node 24 and Docker. Commands have no `$`
prompt; each runs from the folder named above it.

## 1. Run the ouo stack

Log in to ghcr.io (the images are private for now:
[fast-tracked 00, "Pull access"](../../fast-tracked/00-stack.md)), then from
`examples/quickstarts-mobile/tiny-shop-mobile/result/stack`:

```bash
docker compose up -d
```

Grafana is on http://localhost:3000 (admin / testing567), the Sentry bridge on `:4320`, OTLP on
`:4318`. Ports taken? See [Ports](#ports) below.

The ouo images are on `latest`, which follows each release; each compose file names the version
and digest this example was tested with (collector 0.4.0, rum-api 0.5.0, grafana 0.5.0), to pin
if you want to stay on them.

## 2. Start the API

From `examples/quickstarts-mobile/tiny-shop-mobile/result/backend`:

```bash
npm install
```

```bash
npm start
```

It prints `[otel] tracing to http://localhost:4318/v1/traces` and serves on `:5001`.

## 3. Run the app on the simulator

From `examples/quickstarts-mobile/tiny-shop-mobile/result/app`, in a second terminal:

```bash
npm install
```

```bash
npx expo run:ios
```

The first run generates `ios/`, installs the pods and builds the app (5 to 10 minutes), then
opens it on a simulator with Metro attached. Then three short sessions, one per state (Sentry
ends a session after 30 s in the background):

1. Tap **Coffee**, **Add to cart**, **Tea**, **Add to cart**, **Cart**, **Checkout**, back. Press
   Cmd+Shift+H, wait 30 s, open **Tiny Shop** again: that session is `healthy`.
2. Under **Debug**, tap **Call broken API** and **Handled error**. Background the app for 30 s
   again and reopen it: `errored`.
3. Tap **Throw error**: a red error screen, the JS fatal as a Debug build shows it. The session
   is `crashed`. Tap **Dismiss**.

## 4. See it in Grafana

Give Tempo up to a minute after the taps before searching.

- **The sessions:** More apps -> ouo11y RUM -> Sessions. Three `tiny-shop-mobile` sessions:
  `healthy`, `errored` (1 error, 1 failed request) and `crashed`. Each one's timeline has the
  screens, the taps by label, the requests, the errors with their stacks (`ProductsScreen.tsx`
  line 48 for the fatal), your log lines, and its traces.
- **One trace across app and API:** Explore -> Tempo -> TraceQL
  `{ resource.service.name = "tiny-shop-mobile-api" && name = "charge card" }`: the root is the
  app's `tap Checkout` transaction, then its `http.client` span `POST`, then the API's
  `POST /api/checkout`, `checkout`, `validate cart` and `charge card`.
- **The app's logs:** Explore -> Loki -> `{service_name="tiny-shop-mobile", event_name="log"}`:
  `loaded 3 products`, `added Tea to the cart (1 items)`, `order 31737 placed: 2 items, $9`,
  `GET /api/fail failed: /api/fail answered 500`, `coupon check failed: ...`. Without
  `event_name`, the same stream also has the records the bridge writes for the sessions
  (`session.start`, `navigation`, `ui.tap`, `http.request`, `exception`, ...).

## Ports

If the stack runs on other ports (a `result/stack/.env` with `OUO_SENTRY_PORT=14320`,
`OUO_OTLP_HTTP_PORT=14318`, ...), point the API and the app at them:

```bash
OUO_OTLP_ENDPOINT=http://localhost:14318 npm start
```

and in `app/.env` (then stop Metro and run `npx expo run:ios` again):

```
EXPO_PUBLIC_SENTRY_DSN=http://publickey0000000000000000000000@localhost:14320/1
```

The API on another port: `PORT=5002 npm start` and `EXPO_PUBLIC_API_URL=http://localhost:5002` in
`app/.env`. Metro on another port: `npx expo run:ios --port 8082`.

## Copy it out of the repo

`result/` works anywhere: copy it out and run the same commands. The app installs
`@sentry/react-native`, no ouo package.

## Things that bite

- **The DSN is the whole switch.** `http://<public key>@<bridge host>:4320/<project id>`; the
  bridge's `projects` table (`stack/10-collector/config.yaml`) must list that public key and
  project id, or it answers 403 and the SDK drops the envelope.
- **`propagateTraceparent: true`.** Sentry sends `sentry-trace` and `baggage`; an OpenTelemetry
  API reads W3C `traceparent` only. Without it, the API's spans start a trace of their own.
- **`tracePropagationTargets` lists the API only.** A bare `"localhost"` would also add the trace
  headers to the bridge's own URL.
- **`tracesSampleRate: 1`.** Below 1, unsampled requests send `traceparent` with flag `00` and the
  API's sampler drops its spans.
- **A request needs an active span.** A tap that calls the API after the screen's transaction
  ended has none: Sentry records no `http.client` span and sends a `traceparent` whose parent no
  span has. `tap()` in `api.ts` gives each such tap its own trace and transaction.
- **`disableAutoUpload: true`** in the Sentry Expo plugin. Without it the iOS build phases call
  `sentry-cli`, which uploads source maps and debug symbols to sentry.io (and fails without a token).
- **iOS 27 and UIScene.** Without `plugins/withUIScene.js` the app stops at launch on iOS 27
  (`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`).
- **Expo 58 is out.** `create-expo-app` now creates SDK 58 apps by default; this quickstart is on
  SDK 57 (React Native 0.86), with `--template blank-typescript@sdk-57`.
- **Sessions end after 30 s in the background.** Sentry reports the end when the app comes back
  (or at the next launch); until then ouo11y RUM shows the session as `active`.
- **A Debug build's cold start is long.** The first launch downloads the JS bundle from Metro, so
  the session header's cold start reads about 25 s. A Release build (M3) measures the real one.
- **Back-button taps have odd labels.** Sentry names a tap after the nearest labelled component:
  the native header's back button shows as `__backButtonAction:` and `SafeAreaInsetsContext`.

## Next

- **M2, `tiny-shop-mobile-replay`:** Sentry's mobile Session Replay through the bridge.
- **M3, `tiny-shop-mobile-signals`:** app start, time to initial display, slow and frozen frames,
  a native crash.
- **M4, `tiny-shop-mobile-sentry`:** keep Sentry and add ouo, the bridge forwarding to a real Sentry.
- **M5, `tiny-shop-mobile-ouo`:** the same app with the ouo React Native SDK instead of Sentry.

The [mobile quickstarts index](../index.md) lists them with their status.
