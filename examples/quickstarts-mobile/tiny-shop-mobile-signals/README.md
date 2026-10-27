# Tiny Shop Mobile Signals: vitals, logs and a native crash through the Sentry bridge

Mobile quickstart M3. The Tiny Shop Mobile app (Expo, React Native) keeps `@sentry/react-native`
and points its DSN at the **ouo Sentry bridge** in the ouo collector (`upstream: none`: no Sentry
account, nothing leaves your machine). ouo then shows what the Sentry SDK measures about the app:

```
session crashed · Build 1.0.0 (build 1) · Environment development
Warm start 1.75 s · TTID p50 631 ms · max 1.88 s · Frames 2 slow · 1 frozen / 206 · JS stalls 1 · longest 950 ms
timeline: App start (warm) 1.75 s, Products displayed in 1.88 s, Janky frames 2 / 101 (1 frozen),
          1 JS stall, longest 950 ms, Log (info) Order 51874 placed: 1 items, $4.00,
          Fatal error EXC_BAD_ACCESS ... with the native stack
tiny-shop-mobile-signals  Checkout                 (ui.action transaction, through the bridge)
└─ POST                                            (http.client span, sends traceparent)
   └─ tiny-shop-mobile-signals-backend  POST /api/checkout → checkout → validate cart, charge card
```

| Path | What |
|---|---|
| `result/app/src/sentry.ts` | `Sentry.init`: the bridge DSN, release / dist / environment, tracing with `traceparent` to the API, `enableLogs`, the vitals options, React Navigation's TTID |
| `result/app/src/config.ts` | DSN, API URL, release, from `EXPO_PUBLIC_*` variables with local defaults |
| `result/app/src/api.ts` | `fetch` to the API; `action()` gives each tap its own trace and `ui.action` transaction |
| `result/app/src/screens/` | Products (TTFD marker, the Debug buttons), Product, Cart; `Sentry.logger` lines |
| `result/app/app.json`, `result/app/plugins/withUIScene.js` | bundle id `dev.ouo.tinyshop.m3`, local http, the UIScene plugin iOS 27 needs, Sentry's Expo plugin with `disableAutoUpload` |
| `result/backend/` | the Tiny Shop API (Express): OpenTelemetry traces and metrics (`shop.http.requests`, `shop.http.request.duration`, `shop.orders`) |
| `result/stack/` | the ouo stack, one folder per service: collector with the Sentry bridge, Tempo, Loki, Mimir, rum-api, Grafana with the "Tiny Shop Mobile API" dashboard |

Two ways to use it:

- **Build it yourself (recommended):** [build-it-yourself-guide.md](build-it-yourself-guide.md)
  builds the same files from an empty folder, then walks through each signal: app start, TTID and
  TTFD, slow and frozen frames, JS stalls, logs, the release, a native crash. About an hour, plus
  10 minutes for the first iOS build.
- **Run the finished result:** the steps below.

Needs Node 24, Docker, and Xcode with an iOS Simulator runtime (tested with Xcode 27.0 and iOS
27.0, iPhone 18 Pro). Commands have no `$` prompt; each runs from the folder named above it.

## 1. Run the ouo stack

Log in to ghcr.io (the images are private for now:
[fast-tracked 00, "Pull access"](../../fast-tracked/00-stack.md)), then from
`examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack`:

```bash
docker compose up -d
```

Grafana is on http://localhost:3000 (admin / testing567), the Sentry bridge on `:4320` (the app's
DSN), OTLP on `:4318` (the API). Ports taken? See [Ports](#ports) below.

The ouo images are on `latest`, which follows each release; each compose file names the version
and digest this example was tested with (collector 0.4.0, rum-api 0.5.0, grafana 0.5.0), to pin
if you want to stay on them.

## 2. Start the API

From `examples/quickstarts-mobile/tiny-shop-mobile-signals/result/backend`:

```bash
npm install
```

```bash
npm start
```

It prints `[otel] traces and metrics to http://localhost:4318` and serves on `:5001`.

## 3. Build and run the app on the Simulator

From `examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app`, in a second terminal:

```bash
npm install
```

```bash
npx expo run:ios
```

The first build takes about 10 minutes (CocoaPods, then Xcode). Expo starts Metro on 8081, boots
a Simulator and opens **Tiny Shop**. Tap **Coffee**, **Add to cart**, **Cart (1)**, **Checkout**,
then the Debug buttons: **Call broken API**, **Handled error**, **Render long text** (a frozen
frame), **Block JavaScript 1 s** (a JS stall).

For the native crash, build Release (no Metro, real start times), tap **Native crash**, then open
the app again from the Simulator's home screen: the report is sent on that next launch.

```bash
npx expo run:ios --configuration Release
```

## 4. See it in Grafana

Give each signal up to half a minute.

- **The session:** More apps → ouo11y RUM → Sessions. The header has the build, the environment
  and the vitals (app start, TTID, slow and frozen frames, JS stalls); the timeline has one entry
  per vital, log, tap, request and error. After **Native crash** and a relaunch, the session is
  `crashed` with `EXC_BAD_ACCESS` and its native frames.
- **One trace across app and API:** Explore → Tempo → TraceQL
  `{ resource.service.name = "tiny-shop-mobile-signals-backend" && name = "charge card" }`: the
  root is the app's `Checkout` transaction.
- **Vitals and logs:** Explore → Loki → `{service_name="tiny-shop-mobile-signals"}`, with
  `event_name` `ouo.app.start`, `ouo.screen.display`, `app.jank`, `ouo.stall`, `log`, `exception`,
  `session.start`, `session.end`.
- **The API's metrics:** Dashboards → Tiny Shop Mobile → Tiny Shop Mobile API.

## Ports

If the stack runs on other ports (a `result/stack/.env` with `OUO_SENTRY_PORT=14320`,
`OUO_OTLP_HTTP_PORT=14318`, `OUO_GRAFANA_PORT=13000`, ...), point the API and the app at them:

```bash
OUO_OTLP_ENDPOINT=http://localhost:14318 npm start
```

and in `app/.env` (read when Metro bundles the app; restart Metro after a change):

```
EXPO_PUBLIC_SENTRY_DSN=http://publickey0000000000000000000000@localhost:14320/1
EXPO_PUBLIC_API_URL=http://localhost:5001
```

The API on another port: `API_PORT=5002 npm start` and `EXPO_PUBLIC_API_URL=http://localhost:5002`.
Metro on another port: `npx expo run:ios --port 8082`.

## Copy it out of the repo

`result/` works anywhere: copy it out and run the same commands. The app installs
`@sentry/react-native` from npm and no ouo package.

## Things that bite

- **`npx expo install @sentry/react-native` picks 7.11.** Expo 57's tested list is older than the
  SDK the bridge is verified with; the app pins `@sentry/react-native` 8.32.0 and the matching
  `@sentry/core` 10.76.2 (for `startNewTrace`).
- **`disableAutoUpload: true`** in Sentry's Expo plugin keeps Release builds from calling
  sentry-cli and sentry.io. Without it the build fails asking for a Sentry token.
- **iOS 27 needs the UIScene life cycle**, which Expo 57's template does not add:
  `plugins/withUIScene.js`. Without it the app stops at launch.
- **Debug numbers are not real numbers.** A Debug build loads its JavaScript from Metro before the
  first frame: a first launch reads 20 to 30 s. Release on the same Mac: about 1.7 s cold, 1.5 s
  warm. A Debug build also reports an "App Hang" on launch unless `enableAppHangTracking` is off in
  Debug, as here.
- **Frozen frames need the main thread.** JavaScript work stalls the JS thread (`ouo.stall`), not
  the main thread; a frozen frame (700 ms or more) needs native work, here a 6,000-line text view.
  End the transaction after the freeze: Sentry reads the frame counters on the main thread when a
  transaction ends, and misses a frozen frame that has not finished yet.
- **Requests need an active span.** A request outside any transaction still gets a `traceparent`
  with a parent no span has: `api()` waits for navigation, `action()` wraps taps
  ([sentry-client-setup](../../../docs/sentry-client-setup.md), section 4).
- **A native crash is reported on the next launch**, and only without a debugger attached.
- **`simctl terminate` is a kill**: the session ends `terminated` (Sentry's `abnormal`), reported
  on the next launch.
