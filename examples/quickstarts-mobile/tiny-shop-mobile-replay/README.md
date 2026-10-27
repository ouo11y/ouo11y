# Tiny Shop Mobile Replay: Sentry mobile replay through the ouo bridge

Mobile quickstart M2. The Tiny Shop Mobile app (Expo, React Native) keeps `@sentry/react-native`
and its **mobile Session Replay**, and sends everything to the ouo Sentry bridge instead of
sentry.io. No Sentry account: the bridge answers the SDK itself (`upstream: none`). You watch a
shopper's session in the ouo11y RUM app with their taps drawn on the video, compare a masked and
an unmasked recording, get the replay of an errored session that was not sampled, and see what a
replay costs. The last section says plainly how a mobile replay differs from a web one.

Two ways to use it:

- **Build it yourself (recommended):** [build-it-yourself-guide.md](build-it-yourself-guide.md)
  writes every file from an empty folder. About 75 minutes, a third of it waiting for iOS builds.
- **Run the finished result**, below.

## What's new in this quickstart

| Bite | Where in the code | Where to see it |
|---|---|---|
| **Replay on, with sampling**: `replaysSessionSampleRate`, `replaysOnErrorSampleRate` | [`app/src/sentry.ts`](result/app/src/sentry.ts) | the **Replay** panel of a session |
| **Masking on (the default) and off**, from one variable | `EXPO_PUBLIC_REPLAY_MASKING` in [`app/src/config.ts`](result/app/src/config.ts) | two replays of the same screens |
| **Per-view masking**: `<Sentry.Unmask>` on prices, `<Sentry.Mask>` on the address and card | [`ProductScreen.tsx`](result/app/src/screens/ProductScreen.tsx), [`CartScreen.tsx`](result/app/src/screens/CartScreen.tsx) | the Cart screen in both replays |
| **Taps on the timeline and on the video** | `sentry-label` in [`app/src/ui.tsx`](result/app/src/ui.tsx), `Sentry.wrap` in [`app/index.ts`](result/app/index.ts) | `ui.tap` on the timeline, a dot on the video |
| **The replay of an errored session**, on-error sampling | `EXPO_PUBLIC_REPLAY_SESSION_RATE=0` | an `errored` session with a replay, others without |
| **What a replay costs** | [`stack/50-rum-api/config.yaml`](result/stack/50-rum-api/config.yaml) | [below](#what-a-replay-costs) |
| **Mobile replay vs web replay** | | [below](#mobile-replay-vs-web-replay) |

<details>
<summary><b>What's running</b></summary>

| Service | Folder | Port on your machine | Job |
|---|---|---|---|
| ouo-collector | `stack/10-collector` | 4318 (OTLP), 4320 (Sentry bridge) | the only ingest: the bridge for the app, OTLP for the API |
| Tempo | `stack/20-tempo` | 3200 (loopback) | traces |
| Loki | `stack/30-loki` | 3100 (loopback) | app events and logs: sessions, taps, errors, `Sentry.logger` lines |
| Mimir | `stack/40-mimir` | 9009 (loopback) | metrics (none from this shop yet) |
| rum-api | `stack/50-rum-api` | none | sessions (healthy / errored / crashed) and the replay videos |
| Grafana + ouo11y RUM app | `stack/60-grafana` | 3000 | the UI, admin / testing567 |
| the API | `backend/` | 5001 | Express, OpenTelemetry Node SDK |
| the app | `app/` | Metro 8081 (Debug builds only) | Expo SDK 57, React Native 0.86, `@sentry/react-native` 8.32.0 |

</details>

<details>
<summary><b>How the data flows</b></summary>

```
iOS Simulator: app/ (@sentry/react-native)           Node API (backend/, OTel Node SDK)
  envelopes (sessions, errors, transactions,            spans ──► :4318
  logs, replay_video) ──► :4320  DSN http://publickey...@localhost:4320/1
            └──────────────────────────┬────────────────────┘
                                       ▼
                  ouo-collector (10-collector): Sentry bridge + OTLP
       spans ──► Tempo    events, logs ──► Loki    replay segments (mp4) ──► rum-api
                                       │
             rum-api builds sessions from Loki + Tempo, stores the videos
                                       ▼
          Grafana (60-grafana): More apps -> ouo11y RUM -> Sessions -> a session
                 timeline (taps, requests, errors) + replay + traces
```

</details>

<details>
<summary><b>Each file explained</b></summary>

| File | What it does |
|---|---|
| `result/app/src/sentry.ts` | `Sentry.init`: the bridge as DSN, traces joined with the API, logs, replay with its sampling and masking |
| `result/app/src/config.ts` | the `EXPO_PUBLIC_*` variables: API URL, DSN, replay rates, masking on or off |
| `result/app/index.ts` | imports Sentry first, wraps the app (tap breadcrumbs) |
| `result/app/App.tsx` | the native stack: Products, Product, Cart |
| `result/app/src/api.ts` | the API calls, each tap in its own trace |
| `result/app/src/screens/` | the three screens; the Debug section is on Products |
| `result/app/src/ui.tsx` | the button (its `sentry-label`) and the styles |
| `result/app/src/cart.tsx`, `navigation.ts` | the cart in memory, the screen list |
| `result/app/app.config.ts` | bundle id, local http, the UIScene and Sentry config plugins |
| `result/app/plugins/withUIScene.js` | the UIScene life cycle iOS 27 needs (Expo 57's template lacks it) |
| `result/backend/` | the Tiny Shop API: products, a checkout with manual spans, a broken endpoint |
| `result/stack/10-collector/` | `compose.yaml`, `config.yaml` (the Sentry bridge and its routing), `projects.htpasswd` |
| `result/stack/20-tempo/` ... `60-grafana/` | one folder per service, its `compose.yaml` and config |

</details>

## Run it

Needs Node 24, Docker Compose 2.24 or later, Xcode 27 with the iOS 27 simulator, and CocoaPods.
Commands have no `$` prompt; each runs from the folder named above it.

**1. The stack.** The ouo images are private for now, so log in to ghcr.io once with a GitHub
token that has `read:packages`:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

From `result/stack` (ports taken? see [Ports](#ports) first):

```bash
docker compose up -d
```

**2. The API.** From `result/backend`:

```bash
npm install
```

```bash
npm start
```

**3. The app, a Release build.** Replay also records in a Debug build, but a Release build is what
your users run: a crash closes the app instead of showing React Native's red error screen
(guide, step 7). From `result/app`, in a second terminal:

```bash
npm install
```

```bash
npx expo run:ios --configuration Release --no-bundler
```

The first build takes about 5 minutes (CocoaPods, then Xcode); it asks for a simulator and opens
the app there. No Metro: the JavaScript is inside the app.

**4. Shop.** In the simulator, tap:

1. **Coffee**, then **Add to cart** twice, then **Go to cart (2)**, then **Checkout**.
2. Back twice to **Tiny Shop**, then **Call broken API** and **Handled error**.
3. Press Cmd+Shift+H (home): the app goes to the background and sends its last replay segment.

## See it in Grafana

http://localhost:3000, admin / testing567. More apps -> ouo11y RUM -> **Sessions**. The newest
`tiny-shop-mobile-replay-app` session is `errored`; open it. Replay segments arrive every 5 s.

**The replay.** The **Replay** panel plays the session as a video, 1 frame per second, with a dot
where each tap landed. With masking on (the default), every text and image is a grey box, except
the prices: they are inside `<Sentry.Unmask>`.

**The taps.** The activity list next to the replay (filter **Taps**) has one line per tap, with
its component path and position; click one and the replay jumps there. With masking on the
target is a component name (`View`, `ScrollView`); with masking off it is the button's
`sentry-label` (`Add to cart`). Sentry does not read labels while it masks text, since a label
can hold personal data.

**From a tap to the API.** Under **Traces**, the `Checkout` trace has the app's `Checkout` and
`POST` spans and, under them, the API's `POST /api/checkout`, `checkout`, `validate cart` and
`charge card`: one trace id, no missing parent.

**Logs.** `cart.add Coffee`, `checkout order 29618 $8.00`, `broken API answered: HTTP 500 ...` and
the handled error with its stack, in the session's **Logs** and in Loki.

### Masking off

Build a second time with masking off (from `result/app`):

```bash
EXPO_PUBLIC_REPLAY_MASKING=off npx expo run:ios --configuration Release --no-bundler
```

Shop again: the new replay shows the real screens, except the address and the card number on the
Cart screen, which are inside `<Sentry.Mask>` and stay hidden in every build.

| On screen | Masking on (default) | Masking off |
|---|---|---|
| product names, descriptions, buttons | grey boxes | visible |
| product image | grey box | visible |
| prices, cart total (`<Sentry.Unmask>`) | visible | visible |
| address and card (`<Sentry.Mask>`) | hidden | hidden |
| tap target in the activity list | component name | the `sentry-label` |
| badge under the replay | `masked` | `not masked` |

Masking happens on the device, before the frame is encoded: a masked text never leaves the phone.

### Replay of an errored session only

Build with no session sampling and full on-error sampling:

```bash
EXPO_PUBLIC_REPLAY_SESSION_RATE=0 npx expo run:ios --configuration Release --no-bundler
```

Browse without errors, press Cmd+Shift+H, wait 40 s (Sentry then ends the session), open the
app again and tap **Handled error**. The first session is `healthy` with no replay; the second
is `errored` with a replay that starts about 30 s before the error. In production this is the
usual setting: a small `replaysSessionSampleRate` (0.1 or less) and `replaysOnErrorSampleRate: 1`.
A 500 alone (**Call broken API**) is not a Sentry error and sends no buffer, and a JavaScript
crash (**Throw error**) kills the app before the buffer is sent.

## What a replay costs

Measured on this quickstart: a 115 s session is 20 segments of H.264 mp4 at 1 frame per second,
402 x 874 points, 4 to 10 KB each: 120 KB of video, 127 KB with the touch files. About **1 KB per
second of foreground**, 4 MB per hour, more for screens that scroll or animate. The phone uploads
the same bytes, one request per 5 to 6 s segment, and spends the CPU: a masked screenshot of the
window every second, encoded on the device.

rum-api stores one `<seq>.mp4` and one `<seq>.json.gz` per segment under `replays/<session id>/`
on the `rum-api-data` volume (`backend: filesystem`). For more than one rum-api or retention rules,
use S3: the commented example is in [`stack/50-rum-api/config.yaml`](result/stack/50-rum-api/config.yaml).
Sampling is the main lever: `replaysSessionSampleRate: 0.1` records a tenth of the sessions.

## Mobile replay vs web replay

They share the plugin's player and timeline, but they are different recordings:

- **Video, not DOM.** The bridge receives `replay_video` items: mp4 segments at 1 fps, touch
  positions, and breadcrumbs (taps, requests, screen changes, console). A web replay is rrweb's
  DOM events. So there is no element to inspect or copy, fast gestures fall between frames, and
  a tap is known by its position and a React Native component path, not by an element.
- **No rage or dead taps in ouo.** The browser SDK emits `ouo.rage_click` and `ouo.dead_click`.
  On the Sentry path, ouo detects neither. Sentry's own SDK emits `ui.multiClick` (3 taps within
  1 s), which the bridge passes on as a plain breadcrumb; in a masked build every button looks
  the same to it, so three quick taps on three buttons count as one rage tap. Dead taps need to
  know whether the screen changed, which a video does not tell.
- **What it means for you:** use the mobile replay to see what the user saw and did around an
  error; name touchables with `sentry-label` and unmask safe views so taps read well; do not build
  frustration metrics on it yet.

The full comparison, with what ouo could add, is step 12 of the
[guide](build-it-yourself-guide.md#step-12-mobile-replay-vs-web-replay).

## Ports

The stack publishes 3000 (Grafana) and the collector's 4318 (OTLP) and 4320 (Sentry bridge) to
your network, and 3100 (Loki), 3200 (Tempo), 9009 (Mimir) and 13133 (collector health) on
loopback only. The API uses 5001; a Debug build's Metro uses 8081. This prints nothing when the
stack's ports are all free:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|3100|3200|4318|4320|9009|13133|5001) '
```

If something is listed, do not stop it: move this stack instead. Create `stack/.env` (Compose
reads it on its own) with the ports that are taken, for example:

```
OUO_GRAFANA_PORT=13000
OUO_OTLP_HTTP_PORT=14318
OUO_SENTRY_PORT=14320
```

The others are `OUO_LOKI_PORT`, `OUO_TEMPO_PORT`, `OUO_MIMIR_PORT` and
`OUO_COLLECTOR_HEALTH_PORT`. Then start the API with
`OUO_OTLP_ENDPOINT=http://localhost:14318 npm start` (and `API_PORT=5002` to move it), and give
the app the new URLs in `app/.env` before you build:

```
EXPO_PUBLIC_SENTRY_DSN=http://publickey0000000000000000000000@localhost:14320/1
EXPO_PUBLIC_API_URL=http://localhost:5002
```

## Copy it out of the repo

`result/` works anywhere: copy it out and run the same commands. It installs published packages
only.

## Clean up

From `result/stack`: `docker compose down` (add `-v` to delete the data and the replays). Stop
the API with Ctrl+C. To remove the app, touch and hold its icon in the simulator, or from any
folder:

```bash
xcrun simctl uninstall booted dev.ouo.tinyshop
```

## Things that bite

- **`npx expo install @sentry/react-native` picks 7.11** for Expo 57, which traces no `fetch` (no
  trace reaches the API). Install `@sentry/react-native@8.32.0` with npm, as `package.json` does.
- **`EXPO_PUBLIC_*` values are build-time.** Change one, rebuild. With `CI` set in your shell, Expo
  keeps Metro's cache between Release builds and the old values with it: `unset CI` first.
- **Masking hides tap labels too.** With `maskAllText` on, taps read `View` or `ScrollView`; with
  it off, `Add to cart`. And in a masked build Sentry's rage-tap detector sees every button as the
  same one.
- **Some taps have no position.** On a busy simulator a few taps (we saw the header back button
  and fast repeated taps) reach the timeline from their breadcrumb but have no touch in the
  recording: the plugin lists them as "no position in the recording".
- **App Hang errors.** sentry-cocoa reports the main thread blocked for 2 s or more as an error;
  a loaded Mac makes the simulator do that, and the session turns `errored`.
- **Several Grafanas on `localhost` log each other out** (cookies ignore ports), and the replay
  then says "segment could not be played". Log in again, or use `http://127.0.0.1:3000`.
- **A newer `latest` can reject a config.** The comment above each ouo `image:` line names the
  tested version and digest; `docker compose logs <service>` names the key, pin the version.
