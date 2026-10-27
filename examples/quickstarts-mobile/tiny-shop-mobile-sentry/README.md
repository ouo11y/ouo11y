# Tiny Shop Mobile with Sentry: keep Sentry, add ouo

The Tiny Shop Mobile app (Expo, React Native) instrumented with `@sentry/react-native` as a team
on Sentry has it, with one change: the DSN's host is the ouo Sentry bridge. The bridge forwards
every envelope unchanged to your Sentry (sentry.io or self-hosted), passes Sentry's answer back,
and translates a copy into ouo. The API is traced with OpenTelemetry, so ouo shows the app's
traces down into the API, which Sentry does not see:

```
app: checkout                         (ui.action transaction, @sentry/react-native, through the bridge)
└─ POST http://localhost:5001/api/checkout   (http.client span)
   └─ tiny-shop-mobile-backend  POST /api/checkout   (OpenTelemetry Node, ouo only)
      └─ checkout
         ├─ validate cart
         └─ charge card
Sentry: the same envelopes, issues, sessions, replay, logs   ouo: sessions, timeline, traces, replay video
```

| Path | What |
|---|---|
| `result/app/src/sentry.ts` | `Sentry.init`: tracing, `traceparent` to the API, logs, replay; the DSN from `app/.env` |
| `result/app/src/api.ts` | the API client: a span around every request, each button press its own trace |
| `result/app/src/screens/` | Products (list, Debug: broken API, handled error, JS fatal, native crash), Product (add to cart), Cart (checkout) |
| `result/app/plugins/withUIScene.js` | the UIScene life cycle iOS 27 requires, which the Expo 57 template lacks |
| `result/backend/` | the Tiny Shop API, traced with the OpenTelemetry Node SDK |
| `result/stack/` | the ouo stack, one folder per service; the Sentry bridge and its upstream in `10-collector` |

Two ways to use it:

- **Build it yourself (recommended):** [build-it-yourself-guide.md](build-it-yourself-guide.md)
  builds the app plain, adds Sentry pointed at your Sentry, then puts the bridge in between and
  compares both UIs on the same session. About 60 minutes.
- **Run the finished result:** the steps below.

Needs Node 24, Docker, Xcode 27 with an iOS 27 simulator, CocoaPods, a UTF-8 shell locale
(`LANG=en_US.UTF-8`) and **a Sentry project** with its DSN. Commands have no `$` prompt; each runs
from the folder named above it.

## 1. Run the ouo stack with your Sentry as upstream

From your DSN `https://<public key>@<sentry host>/<project id>`, create
`examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/.env` from `.env.example`:

```
OUO_SENTRY_UPSTREAM=https://<sentry host>
OUO_SENTRY_PROJECT_ID=<project id>
OUO_SENTRY_PUBLIC_KEY=<public key>
```

A self-hosted Sentry on this machine is `http://host.docker.internal:9000`, not `localhost`.
Log in to ghcr.io (the images are private for now:
[fast-tracked 00, "Pull access"](../../fast-tracked/00-stack.md)), then from `result/stack`:

```bash
docker compose up -d
```

Grafana is on http://localhost:3000 (admin / testing567), the Sentry bridge on `:4320`, OTLP on
`:4318`. The ouo images are on `latest`; each compose file names the version and digest this
example was tested with (collector 0.4.0, rum-api 0.5.0, grafana 0.5.0), to pin if you want to
stay on them.

## 2. Start the API

From `result/backend`:

```bash
npm install
```

```bash
npm start
```

It prints `[otel] tracing to http://localhost:4318/v1/traces` and serves on `:5001`.

## 3. Build and run the app

In `result/app`, create `.env` with your DSN, the host changed to the bridge:

```
EXPO_PUBLIC_SENTRY_DSN=http://<public key>@localhost:4320/<project id>
EXPO_PUBLIC_API_URL=http://localhost:5001
```

Then, from `result/app`:

```bash
npm install
```

```bash
npx expo run:ios --configuration Release
```

The first build takes about 10 minutes. The Release build is the one where a JavaScript fatal
error closes the app (a crash); `npx expo run:ios` (Debug, with Metro) shows everything else.

## 4. See it in both

In the app: add two products, **Checkout**, then **Call broken API**, **Handled error**,
**Throw error** (the app closes; open it again), **Native crash** (closes; open it again).

- **Sentry:** the issues "Cart total is NaN", `EXC_BAD_ACCESS` and "Coupon service timed out",
  the sessions under the release, the `checkout` transaction, the logs, the replay.
- **ouo:** Grafana -> More apps -> ouo11y RUM -> Sessions: the `tiny-shop-mobile` sessions
  (`crashed`, with the timeline and the replay video). Explore -> Tempo ->
  `{ resource.service.name = "tiny-shop-mobile-backend" && name = "charge card" }`: the app's
  `checkout` is the root of the API's spans.
- **The bridge:** `curl -s localhost:9009/prometheus/api/v1/query --data-urlencode
  'query=sum by (outcome) (ouo_sentry_envelopes_total)'`: every envelope `forwarded`.

The guide's step 9 lists what each side shows that the other does not; step 10 is about running
the bridge in production (one replica, what happens when Sentry is down or rate limits).

## Ports

Ports taken? Set them in `stack/.env` (`OUO_GRAFANA_PORT`, `OUO_SENTRY_PORT`,
`OUO_OTLP_HTTP_PORT`, ...; the list is in `.env.example`), then use the bridge port in the app's
DSN, start the API with `OUO_OTLP_ENDPOINT=http://localhost:<otlp port>`, and the API on another
port with `API_PORT=5002 npm start` and `EXPO_PUBLIC_API_URL=http://localhost:5002`.

## Copy it out of the repo

`result/` works anywhere: copy it out and run the same commands. Neither app installs an ouo
package.

## Things that bite

- **`npx expo install @sentry/react-native` picks 7.11.0 for Expo 57**, which under Expo 57
  traces no `fetch`, sends no app start and stamps transactions hours in the past. Install 8.x
  with `npm install --save-exact @sentry/react-native@8.32.0`.
- **`@sentry/core` at the SDK's exact version** (10.76.2 for 8.32.0): `startNewTrace` must act on
  the same copy the SDK uses. `npm ls @sentry/core` shows one version.
- **Only the DSN host changes.** Key and project id stay your Sentry's, and the bridge's project
  table (`stack/.env`) must hold the same pair, or it answers `403` and forwards nothing.
- **ouo gets only what Sentry accepted.** A `429` or any non-`2xx` from Sentry goes back to the
  SDK and the envelope is not translated.
- **Metro bakes `EXPO_PUBLIC_*` into the bundle:** restart it with `npx expo start --clear` after
  changing `app/.env`; a Release build reads it at build time.
- **A JavaScript crash needs a Release build.** In Debug, React Native's red screen catches the
  fatal error and the app keeps running.
- **`disableAutoUpload: true`** in `app.json` keeps the build from uploading to sentry.io; set up
  source map and dSYM uploads with your own auth token if you want symbolicated stacks in Sentry.
- **CocoaPods needs a UTF-8 locale**, else `Unicode Normalization not appropriate for ASCII-8BIT`.
