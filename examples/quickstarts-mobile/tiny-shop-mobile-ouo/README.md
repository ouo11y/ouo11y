# Tiny Shop Mobile with the ouo SDK, no Sentry

The Tiny Shop Mobile app (Expo, React Native) instrumented with ouo's own SDK,
[`@ouo11y/react-native`](https://www.npmjs.com/package/@ouo11y/react-native), sending straight to
the ouo collector. No Sentry anywhere. The other mobile quickstarts ([index](../index.md)) keep
`@sentry/react-native` and send through the ouo Sentry bridge; this one shows the other road, and
[sdk-state.md](sdk-state.md) says how far that road goes today.

```
tiny-shop-mobile      place order                   (rum.withSpan, on the Checkout tap)
├─ tiny-shop-mobile   HTTP POST                     (the SDK's fetch span, traceparent + baggage)
│  └─ tiny-shop-mobile-api  POST /api/checkout      (HTTP server span, auto-instrumentation)
│     └─ … checkout
│          ├─ validate cart
│          └─ charge card
└─ tiny-shop-mobile   save receipt                  (rum.startSpan, after the await)
every span: session.id, user.id                     (the SDK in the app, baggage in the API)
session: healthy / errored / crashed, taps, screens, requests, log lines, vitals, replay
```

| Path | What |
|---|---|
| `result/app/src/rum.ts` | `initRUM`: collector URL, the project credential, the API to trace into, replay masking |
| `result/app/index.ts` | starts the SDK before the app |
| `result/app/App.tsx` | `RUMProvider` (taps) and the navigation listener (screens, screen display times) |
| `result/app/src/api.ts` | `rum.withSpan` around the checkout, `rum.startSpan` after the `await`, `rum.log.info` |
| `result/app/src/screens/ProductsScreen.tsx` | the product list and the Debug buttons: broken API, handled error, JS crash, native crash |
| `result/app/modules/tiny-crash/` | a 10-line Expo module that crashes natively (the ouo SDK has no `nativeCrash()` helper) |
| `result/app/plugins/withUIScene.js` | the scene delegate iOS 27 requires, which Expo 57's template does not add yet |
| `result/backend/` | the Tiny Shop API: Express, OpenTelemetry Node SDK, `BaggageSpanProcessor` |
| `result/stack/` | the ouo stack, one folder per service: collector, Tempo, Loki, Mimir, rum-api, Grafana |

Two ways to use it:

- **Build it yourself (recommended):** [build-it-yourself-guide.md](build-it-yourself-guide.md)
  builds the same files from an empty folder, one step at a time. About 60 minutes, a third of it
  waiting for the first iOS builds.
- **Run the finished result:** the steps below.

Needs Node 24, Docker, Xcode with an iOS Simulator runtime (tested: Xcode 27.0, iOS 27.0,
iPhone 18 Pro) and CocoaPods. Simulator only: no phone, no Apple developer account. Commands have
no `$` prompt; each runs from the folder named above it.

## 1. Run the ouo stack

Log in to ghcr.io (the images are private for now:
[fast-tracked 00, "Pull access"](../../fast-tracked/00-stack.md)), then from
`examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack`:

```bash
docker compose up -d
```

Grafana is on http://localhost:3000 (admin / testing567, development values, public), the
collector on `:4318` (OTLP) and `:4319` (replay). Ports taken? See [Ports](#ports) below.

The ouo images are on `latest`, which follows each release; each compose file names the version
and digest this example was tested with (collector 0.4.0, rum-api 0.5.0, grafana 0.5.0), to pin
if you want to stay on them.

## 2. Start the API

From `examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/backend`:

```bash
npm install
```

```bash
npm start
```

It prints `[otel] tracing to http://localhost:4318/v1/traces` and serves on `:5001`.

## 3. Build and run the app

From `examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app`, in a second terminal:

```bash
npm install
```

```bash
npx expo run:ios
```

The first build takes 10 to 15 minutes (it generates `ios/` and installs the pods). It installs the
app on a simulator, opens it and starts Metro on 8081. Tap **Coffee**, **Add to cart**,
**Checkout**, go back, then **Call broken API** and **Handled error**. Send the app to the
background (Cmd+Shift+H) and wait a few seconds: the SDK exports on the way out.

For the native crash and a replay as your users would produce them, build the Release
configuration (no Metro; `EXPO_PUBLIC_*` values are baked in at build time):

```bash
npx expo run:ios --configuration Release
```

Tap **Native crash**: the app closes. Open it again from the simulator's home screen; that launch
sends the crash.

## 4. See it in Grafana

Give Tempo up to a minute before searching.

- **The sessions:** More apps -> ouo11y RUM -> Sessions. `tiny-shop-mobile` sessions: `errored`
  (the broken API and the handled error), `crashed` (Throw error or Native crash, ended at the
  crash time). Each has its taps, screens, requests, log lines and vitals on the timeline, and a
  replay.
- **One trace from the tap to the API:** Explore -> Tempo -> TraceQL
  `{ resource.service.name = "tiny-shop-mobile-api" && name = "charge card" }`: the root is the
  app's `place order` span, and every span has the session's `session.id`.
- **Log lines:** Explore -> Loki -> `{service_name="tiny-shop-mobile"} | event_name="log"`:
  `checkout started with 1 items`, `order … placed`.
- **Vitals:** `{service_name="tiny-shop-mobile", event_name=~"ouo.app.start|ouo.screen.display|app.jank"}`.

## Ports

If the stack runs on other ports (a `result/stack/.env` with `OUO_OTLP_HTTP_PORT=14318`,
`OUO_REPLAY_PORT=14319`, ...), point both apps at them:

```bash
OUO_OTLP_ENDPOINT=http://localhost:14318 npm start
```

and for the app, in front of every `npx expo` command (they are read when the JavaScript is
bundled):

```bash
EXPO_PUBLIC_OUO_ENDPOINT=http://localhost:14318 EXPO_PUBLIC_OUO_REPLAY_ENDPOINT=http://localhost:14319 npx expo run:ios
```

Set both: the SDK derives the replay port (4319) from 4318 only, and with any other OTLP port it
posts replay frames to the OTLP port, where they are lost. The API on another port:
`API_PORT=5002 npm start` and `EXPO_PUBLIC_API_URL=http://localhost:5002`. Metro on another port:
`npx expo run:ios --port 8082`.

## Copy it out of the repo

`result/` works anywhere: copy it out and run the same commands. It installs
`@ouo11y/react-native` from npm, never from this repository.

## Things that bite

- **`create-expo-app` gives Expo 58 now.** This app is Expo SDK 57 (React Native 0.86):
  `--template blank-typescript@sdk-57`.
- **iOS 27 needs the UIScene life cycle.** Without `plugins/withUIScene.js` the app is stopped at
  launch, before any screen.
- **Install with `npx expo install`.** `npm install @react-native-async-storage/async-storage`
  (what the SDK README says) gives 3.x; Expo 57 is tested with 2.2.0.
- **A new local module needs `npx expo prebuild --platform ios`.** `expo run:ios` does not always
  rerun `pod install`, and the JavaScript then fails with `Cannot find native module`.
- **The replay port is derived from 4318 only** (see [Ports](#ports)).
- **React Native has no async context.** Inside `rum.withSpan`, only what starts before the first
  `await` joins the span; after it, pass the span (`{ parent: span }`, `{ span }`).
- **Taps are named by `testID` or accessibility label**, never by the button's text. Give buttons
  a `testID`.
- **Input masking has a hole in 0.2.1:** a frame taken at a touch can show a text field's content
  ([sdk-state.md](sdk-state.md)).
- **The Loki line of most SDK events is only the event name** (`exception`, `navigation`,
  `session.start`), and vitals have an empty line: read the attributes, or ouo11y RUM's timeline.
