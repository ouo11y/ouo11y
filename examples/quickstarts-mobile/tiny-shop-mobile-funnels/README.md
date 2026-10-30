# Tiny Shop Mobile Funnels: where shoppers drop between the list and paying

The Tiny Shop Mobile app (Expo, React Native) with ouo's own SDK,
[`@ouo11y/react-native`](https://www.npmjs.com/package/@ouo11y/react-native): its screens and two
custom events make a funnel, Products, a product, add to cart, Cart, order paid. A script drives
30 sessions through the app on the iOS Simulator with a known drop-off at every step; you build
the funnel in Grafana and check it says the same. Then you tap through the shop yourself and read
your taps on the session's timeline as steps a person would write down: `Tap add-to-cart
(button) on Product`. The mobile counterpart of the web
[tiny-shop-funnels](../../quickstarts/tiny-shop-funnels/README.md).

```
generate-sessions ──xcrun simctl──► Tiny Shop (Release build on the simulator, @ouo11y/react-native)
   one cold launch per session: simctl launch … -journey product-3,add,cart,pay
        navigation {url.path=/Products|/Product|/Cart}   add_to_cart   order_paid   ui.tap
                                           ▼
                             ouo-collector (stack/10-collector) :4318
          events ──► Loki      traces ──► Tempo      replay ──► rum-api (:4319)
                                           ▼
       rum-api POST /v1/funnels/query: steps matched per session.id, strict order
                                           ▼
             Grafana: More apps -> ouo11y RUM -> Funnels, Sessions
```

| Bite | Where in the code | Where to see it |
|---|---|---|
| **Screens are page steps**: every screen change is a `navigation` event, `url.path` = `/` + the screen name, `ouo.navigation.kind = screen` | `navigationStateListener(rum)` in [`app/App.tsx`](result/app/App.tsx) | step kind **Page**: `/Products`, `/Product`, `/Cart` |
| **Event steps**: `rum.addEvent("add_to_cart")`, `rum.addEvent("order_paid")` | `add` in [`app/src/cart.tsx`](result/app/src/cart.tsx), `checkout` in [`app/src/api.ts`](result/app/src/api.ts) | step kind **Event** |
| **30 sessions with a known answer** | [`generate-sessions/generate.mjs`](result/generate-sessions/generate.mjs) and the journey runner [`app/src/journey.ts`](result/app/src/journey.ts) | the script's last lines: the count per step |
| **Taps as readable steps**: gesture (`tap`, `long_press`, `swipe`), what was touched, its view type, the screen | `<RUMProvider>` in `App.tsx`; `testID` and `role` on the buttons in [`app/src/ui.tsx`](result/app/src/ui.tsx) | a session's timeline; the Loki line of `ui.tap` |
| **Labels stay on the phone** if you want: `timeline: { tapLabels: false }` | [`app/src/rum.ts`](result/app/src/rum.ts) | `Tap button on Product` |

<details>
<summary><b>What's running</b></summary>

| Service | Folder | Port on your machine | Job |
|---|---|---|---|
| ouo-collector | `stack/10-collector` | 4318 (OTLP), 4319 (replay) | the only ingest; checks the project credential, routes each signal |
| Tempo | `stack/20-tempo` | 3200 (loopback) | traces |
| Loki | `stack/30-loki` | 3100 (loopback) | screens, custom events, taps: the funnel steps |
| Mimir | `stack/40-mimir` | 9009 (loopback) | metrics (the shop sends none) |
| rum-api | `stack/50-rum-api` | none | sessions, funnels and the replay store |
| Grafana + ouo11y RUM app | `stack/60-grafana` | 3000 | the UI, admin / testing567 |
| the API | `backend/` | 5001 | Express, OpenTelemetry Node SDK |
| the app | `app/` | the iOS Simulator | Expo SDK 57, React Native 0.86, `@ouo11y/react-native` |
| the session generator | `generate-sessions/` | none | Node, `xcrun simctl` |

</details>

<details>
<summary><b>Each file explained</b></summary>

| File | What it does |
|---|---|
| `result/app/src/rum.ts` | `initRUM`: collector URL, the project credential, the API to trace into, replay, the tap label switch |
| `result/app/index.ts` | starts the SDK before the app |
| `result/app/App.tsx` | `RUMProvider` (taps) and the navigation listener (screens), the journey runner |
| `result/app/src/cart.tsx` | the cart; adding a product sends `add_to_cart` |
| `result/app/src/api.ts` | the API calls; a paid checkout sends `order_paid` |
| `result/app/src/ui.tsx` | the button: `testID` names it, `role="button"` says what it is |
| `result/app/src/screens/` | Products (list), Product (Add to cart, Go to cart), Cart (Pay) |
| `result/app/src/journey.ts` | for the generator only: walks the steps of its `-journey` launch argument through the same navigation and cart code |
| `result/app/plugins/withUIScene.js` | the scene delegate iOS 27 requires, which Expo 57's template does not add yet |
| `result/generate-sessions/generate.mjs` | 30 sessions over 7 journeys (bounce, cart first, browse, add and leave, abandon the cart, buy, wander and buy), seeded, then the expected count per step |
| `result/backend/` | the Tiny Shop API: `GET /api/products`, `POST /api/checkout`, OpenTelemetry Node SDK |
| `result/stack/` | the ouo stack, one folder per service, each with its `compose.yaml` and config; the top `compose.yaml` only includes them |

</details>

Two ways to use it:

- **Build it yourself (recommended):** [build-it-yourself-guide.md](build-it-yourself-guide.md)
  builds the same files from an empty folder, one step at a time. About 60 minutes, a third of it
  waiting for the first iOS build.
- **Run the finished result:** the steps below.

Needs Node 24, Docker, Xcode with an iOS Simulator runtime (tested: Xcode 27.0, iOS 27.0,
iPhone 18 Pro) and CocoaPods. Simulator only: no phone, no Apple developer account. Commands have
no `$` prompt; each runs from the folder named above it.

> **Versions.** Readable taps (view type, gesture, screen) and `ouo.navigation.kind` need
> `@ouo11y/react-native` 0.3.0 or later; with 0.2.x the funnel works the same and taps carry only
> their label. Funnels need rum-api 0.5.0 and the `ouo11y/grafana` image 0.5.0 or later, and the
> timeline reads taps as steps from ouo11y RUM app 0.10.0. The stack runs the released ouo images on
> `latest`; each compose file names the version and digest this example was tested with
> (collector 0.4.0, rum-api 0.5.0, grafana 0.5.0), to pin if you want to stay on them.

## 1. Run the ouo stack

Log in to ghcr.io (the images are private for now:
[fast-tracked 00, "Pull access"](../../fast-tracked/00-stack.md)), then from
`examples/quickstarts-mobile/tiny-shop-mobile-funnels/result/stack`:

```bash
docker compose up -d
```

Grafana is on http://localhost:3000 (admin / testing567, development values, public), the
collector on `:4318` (OTLP) and `:4319` (replay). Ports taken? See [Ports](#ports).

## 2. Start the API

From `examples/quickstarts-mobile/tiny-shop-mobile-funnels/result/backend`:

```bash
npm install
```

```bash
npm start
```

It prints `[otel] tracing to http://localhost:4318/v1/traces` and serves on `:5001`.

## 3. Build the app

The generator needs a Release build: it starts the app 30 times, without Metro. From
`examples/quickstarts-mobile/tiny-shop-mobile-funnels/result/app`, in a second terminal:

```bash
npm install
```

```bash
npx expo run:ios --configuration Release
```

The first build takes 10 to 15 minutes (it generates `ios/` and installs the pods). It installs the
app on the booted simulator (or asks which one) and opens it on the product list.

## 4. Drive 30 sessions

From `examples/quickstarts-mobile/tiny-shop-mobile-funnels/result/generate-sessions`:

```bash
node generate.mjs
```

About five minutes: one line per session, then the answer the funnel must give:

```
expected funnel (sessions per step):
  1. page:/Products       30
  2. page:/Product        24
  3. event:add_to_cart    17
  4. page:/Cart           13
  5. event:order_paid     8
```

Several simulators booted? `node generate.mjs --device <name or udid>`.

## 5. Build the funnel

More apps -> ouo11y RUM -> **Funnels**. Time range: the last 15 minutes. Service:
`tiny-shop-mobile-funnels`. Steps, in order:

| # | Kind | Value |
|---|---|---|
| 1 | Page | `/Products` |
| 2 | Page | `/Product` |
| 3 | Event | `add_to_cart` |
| 4 | Page | `/Cart` |
| 5 | Event | `order_paid` |

The bars say 30, 24, 17, 13, 8: the generator's count. Users: 1, since every session ran on the
same simulator, one anonymous user. Why not more:

- the two **cart first** sessions opened the Cart before any product: strict order, they stop at
  step 1;
- the two **wander and buy** sessions added a product twice and saw `/Product` twice: a step
  repeated counts once;
- each step reports the median and p75 time from the step before (the generator's paces, 0.6 to
  1.8 s, plus the API call before `order_paid`).

Click a drop-off (the hatched part of a bar) for the sessions that stopped there, and one of them
for its session page and its replay.

## 6. Your own taps, as steps

On the simulator, tap **Cake**, then **Add to cart**, then **Go to cart**. Send the app to the
background (Cmd+Shift+H): the SDK sends on the way out. In ouo11y RUM -> **Sessions**, open the
newest `tiny-shop-mobile-funnels` session. Its timeline reads:

```
Navigation  /Products
Tap         product-3 (Pressable) on Products
Navigation  /Product
Tap         add-to-cart (button) on Product
Tap         go-to-cart (button) on Product
Navigation  /Cart
```

A long press (hold a button half a second) says `Long press`; a drag on the product list says
`Swipe`. The same step is the Loki line of each tap, in Explore -> Loki:

```
{service_name="tiny-shop-mobile-funnels", event_name="ui.tap"}
```

The attributes are `ouo.ui.target` (the `testID`), `ouo.ui.view_type` (the `role`, else the
component), `ouo.ui.gesture` and `app.screen.name`. The SDK never reads the text on a button.

**Keep even the labels on the phone.** Some apps label buttons with what the user sees ("Send to
Ana"). Build with the switch off:

```bash
EXPO_PUBLIC_OUO_TAP_LABELS=false npx expo run:ios --configuration Release
```

and the same three taps read `Tap Pressable on Products`, `Tap button on Product`, `Tap button on
Product`: the gesture, what was touched and where, never which one.

## Ports

If the stack runs on other ports (a `result/stack/.env` with `OUO_OTLP_HTTP_PORT=14318`,
`OUO_REPLAY_PORT=14319`, ...), point both apps at them:

```bash
OUO_OTLP_ENDPOINT=http://localhost:14318 npm start
```

and for the app, in front of the build (the values are baked in when the JavaScript is bundled):

```bash
EXPO_PUBLIC_OUO_ENDPOINT=http://localhost:14318 EXPO_PUBLIC_OUO_REPLAY_ENDPOINT=http://localhost:14319 npx expo run:ios --configuration Release
```

Set both: the SDK derives the replay port (4319) from 4318 only. The API on another port:
`API_PORT=5002 npm start` and `EXPO_PUBLIC_API_URL=http://localhost:5002`.

## Copy it out of the repo

`result/` works anywhere: copy it out and run the same commands. It installs
`@ouo11y/react-native` from npm, never from this repository.

## Trade-offs

- **The generator does not tap.** It starts the app with the steps as launch arguments and the
  app walks them through its own navigation and cart code: the screens and events are real SDK
  records, the touches are not. Driving 30 sessions with real taps needs XCUITest; your own taps in
  step 6 show what a finger records.
- **One session per cold launch.** A mobile session starts on every cold start; the generator
  starts the app again per journey (`simctl launch --terminate-running-process`). Each session ends `terminated` when the next one starts, which is
  what the session list shows.
- **Screens are route names.** `url.path` is `/` + the active route name of React Navigation:
  `/Product` for every product. To funnel on one product, send an event with the product id.

## Things that bite

- **`create-expo-app` gives Expo 58 now.** This app is Expo SDK 57 (React Native 0.86):
  `--template blank-typescript@sdk-57`.
- **iOS 27 needs the UIScene life cycle.** Without `plugins/withUIScene.js` the app is stopped at
  launch, before any screen.
- **`EXPO_PUBLIC_*` values are baked into a Release build.** Change one, build again. With `CI=1`
  set, Expo can keep the old values: unset it.
- **Taps are named by `testID` or accessibility label**, never by the button's text. Give buttons a
  `testID`, and a `role` for a readable view type.
