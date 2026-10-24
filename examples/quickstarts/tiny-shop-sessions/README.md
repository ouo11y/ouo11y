# Tiny Shop Sessions: when a session starts, what ends it, and who it belongs to

Quickstart 3 of the series. The same small shop (an Express API and a React page, traced end to
end), plus a fake login and three panels that let you drive the RUM session by hand: log in, switch
user, log out, end the session, let it time out, and break it. Every rotation shows up in rum-api
and in the ouo11y RUM app as a chain of sessions with an end reason, a user and one device id.
Everything is in this folder: its own app, its own API and its own stack.

## What's new

| Bite | Where in the code | Where to see it |
|---|---|---|
| **Login keeps the session**: anonymous to `alice` only sets `user.id` | `login()` in [`AccountPanel.jsx`](result/frontend/src/AccountPanel.jsx), `rum.setUser` | the same session id before and after, now with user alice |
| **Switching user rotates it**: alice to bob ends the session with `user_change` | `login()` again, `rum.setUser` | two sessions: alice's (ended, `user_change`) and bob's, whose **Previous session** is alice's |
| **Logout rotates it**: `rum.clearUser()`, a fresh anonymous id | `logout()` | a new anonymous session after bob's |
| **End session**: `rum.endSession()`, reason `manual`; your next click starts the next one | `endSession()` | `ended · manual` on the session page |
| **Inactivity**: a switch shortens the timeout to 1 minute | `session.inactivityTimeoutMs` in [`rum.js`](result/frontend/src/rum.js) | `ended · inactivity` after a minute of doing nothing |
| **Break it**: handled error, uncaught error, failed request | [`BreakItPanel.jsx`](result/frontend/src/BreakItPanel.jsx), `GET /api/broken` in [`server.js`](result/backend/server.js) | `errored`, `crashed`, `errored`, and the healthy / errored / crashed split on the Overview |
| **One device, many sessions**: `device.id` | stored by the SDK under `ouo.device` | **Device** on the session page; click it for every session of this browser |
| **A "Your session" panel** in the page | [`session.js`](result/frontend/src/session.js) | the live session id, previous id, user, device id and state |

<details>
<summary><b>The session lifecycle in one page</b></summary>

A **session** is one person using the app in one browser for a while. The SDK makes the id
(`session.id`, a random UUID) and stamps it on every span, event, log and replay chunk.

**When does one start?** On the first page load, and again on the first activity (a click, a key, a
scroll, a navigation, a request) after the previous one ended. Tabs of the same site share it
through `localStorage`, and a reload keeps it.

**What ends it?** The first of these, with the reason in `session.end`:

| Reason | When | Default |
|---|---|---|
| `inactivity` | no activity for the inactivity timeout | 30 min |
| `max_duration` | the session is older than the maximum duration, even if active | 4 h |
| `user_change` | `setUser` with another identified user, or `clearUser()` (a logout) | |
| `manual` | the app called `rum.endSession()` | |

`inactivity` and `manual` are lazy: the session ends at once, but the next one only starts when you
do something. `user_change` starts the next one at once. Each new session carries
`session.previous_id`, so the sessions of one browser form a chain.

**Closing the tab does not end the session.** The browser gives no reliable signal for "the person
left" (a closed tab, a sleeping laptop and a tab in the background look the same), so the session
simply stops getting activity. Come back within 30 minutes, in any tab of the same site, and it
resumes. If you never come back, rum-api ends it on its own after 30 minutes without signals
(`inactivity`), the same rule as the SDK (`session:` in
[`stack/50-rum-api/config.yaml`](result/stack/50-rum-api/config.yaml)).

**Why the 30 min / 4 h defaults?** 30 minutes of inactivity is the industry's usual "visit" (web
analytics and the other RUM tools use it), so session counts compare. 4 hours caps a tab left open
all day, which would otherwise be one endless session.

**Login, switch, logout.** A session belongs to one person:

- anonymous to identified (logging in during the visit) **keeps** the session: the anonymous id was
  never a person, it was this person before they said who they are;
- one identified user to another **rotates** it (`user_change`): alice's session ends with alice,
  bob's starts with bob;
- `clearUser()` (logout) rotates it too, to a fresh anonymous id, so the next person on a shared
  computer is not counted as bob.

**Status.** Every session also has a health status (ADR-0004):

- **healthy**: no error at all;
- **errored**: a handled error (`rum.captureError`) or a failed HTTP request; the user carried on;
- **crashed**: an uncaught error. On the web the page keeps running and the session does **not**
  end; it is only marked.

The full rules: [the session lifecycle spec](../../../docs/specs/session-lifecycle.md).

</details>

<details>
<summary><b>Device id, and why there is no IP linking</b></summary>

`device.id` is a random UUID the SDK stores under its own `localStorage` key (`ouo.device`), apart
from the session (`ouo.session`) and the user (`ouo.user`). Rotation, login and logout leave it
alone, so every session of this browser has the same one: alice's, bob's and the anonymous one
after the logout. It is per browser profile and per site: another browser, a private window or
cleared site data is another device.

ouo does **not** link sessions by IP address or by a browser fingerprint:

- **privacy**: an IP address is personal data (GDPR), and fingerprinting is tracking that the user
  never agreed to and cannot reset. A device id in site storage is visible, and cleared with the
  site's data;
- **it is wrong anyway**: many people share one IP behind a home router, an office, a phone
  carrier's NAT or a VPN, and one person changes IP when their phone moves from Wi-Fi to 4G. Linking
  by IP would merge strangers and split the same person.

</details>

<details>
<summary><b>What's running</b></summary>

| Service | Folder | Port on your machine | Job |
|---|---|---|---|
| ouo-collector | `stack/10-collector` | 4318 (OTLP), 4319 (replay) | the only ingest; checks the project credential, routes each signal |
| Tempo | `stack/20-tempo` | 3200 (loopback) | traces |
| Loki | `stack/30-loki` | 3100 (loopback) | browser events: `session.start`, `session.end`, errors, failed requests |
| rum-api | `stack/50-rum-api` | none | folds those events into sessions: status, end reason, user, device |
| Grafana + ouo11y RUM app | `stack/60-grafana` | 3000 | the UI, admin / testing567 |
| the API | `backend/` | 5001 | Express, OpenTelemetry Node SDK |
| the web app | `frontend/` | 5173 | React, `@ouo11y/browser` |

</details>

<details>
<summary><b>How the data flows</b></summary>

```
browser (frontend/, @ouo11y/browser)                Node API (backend/)
  session.start / session.end (reason, user,           spans
  previous_id, device.id), errors, spans, replay
            │  OTLP/HTTP :4318, replay :4319              │  OTLP/HTTP :4318
            └──────────────────────┬──────────────────────┘
                                   ▼
                     ouo-collector (10-collector)
          traces ──► Tempo     events ──► Loki     replay ──► rum-api
                                   │
     rum-api reads Loki: one record per session.id with status, state,
     end_reason, user_id, device_id; session.previous_id links the chain
                                   ▼
        Grafana (60-grafana): More apps -> ouo11y RUM -> Overview, Sessions
```

</details>

<details>
<summary><b>Each file explained</b></summary>

| File | What it does |
|---|---|
| `result/frontend/src/rum.js` | `initRUM`: the session options (the inactivity switch), fetch tracing to the API, replay |
| `result/frontend/src/App.jsx` | the shop, with the three panels above it |
| `result/frontend/src/SessionPanel.jsx` | **Your session**: session id, state and end reason, previous id, user, device id |
| `result/frontend/src/AccountPanel.jsx` | **Account**: login, switch user, logout (`clearUser`), End session (`endSession`), the short-timeout switch |
| `result/frontend/src/BreakItPanel.jsx` | **Break it**: handled error, uncaught error, failed request |
| `result/frontend/src/session.js` | reads `ouo.session`, `ouo.user` and `ouo.device` from `localStorage` for the panel, with no side effects |
| `result/frontend/src/main.jsx` | imports `./rum` before React renders |
| `result/frontend/package.json` | `@ouo11y/browser` from `vendor/` until the release (see "Unreleased parts") |
| `result/backend/instrumentation.js` | OTel Node SDK: traces with the project credential, http + express auto-instrumentation, baggage to span attributes |
| `result/backend/server.js` | the API: `GET /api/products`, `POST /api/checkout`, `GET /api/broken` (always 500) |
| `result/stack/compose.yaml` | only `include:` lines, one per service folder |
| `result/stack/10-collector/` | `compose.yaml`, `config.yaml` (pipelines), `projects.htpasswd` (the `demo` project) |
| `result/stack/20-tempo/`, `30-loki/` | `compose.yaml` and the store's `config.yaml` |
| `result/stack/50-rum-api/` | `compose.yaml` (built from source for now) and `config.yaml` (where Loki and Tempo are, the server's session timeouts) |
| `result/stack/60-grafana/` | `compose.yaml` (stock Grafana with the plugin built from source, for now) and `provisioning/` (datasources, the plugin) |

</details>

<details>
<summary><b>Unreleased parts: switch to the releases when they ship</b></summary>

This quickstart uses features that are merged but not yet released, so for now it builds them from
this repository. It must stay inside the repository checkout until then.

| Part | Why | Now | After the release |
|---|---|---|---|
| `@ouo11y/browser` | `setUser` rotation, `clearUser`, `endSession`, `device.id` (PR #73) are newer than 0.2.1 on npm | a tarball packed from `sdk/browser` into `frontend/vendor/` | in `frontend/package.json`: `"@ouo11y/browser": "<next version>"` |
| rum-api | `device_id` on the session and the `device=` filter | `build:` from `services/rum-api` | `image: ghcr.io/ouo11y/rum-api:<next version>` in `stack/50-rum-api/compose.yaml` |
| Grafana + plugin | the device on the session page and the Device filter | `grafana/grafana` with `plugins/ouo11y-rum-app/dist` mounted | `image: ghcr.io/ouo11y/grafana:<next version>` in `stack/60-grafana/compose.yaml`, without the plugin volume |

</details>

Two ways to use it:

- **Build it yourself:** [build-it-yourself-guide.md](build-it-yourself-guide.md) starts from an
  empty folder: the plain shop with no telemetry, then the stack, the instrumentation, and the
  session features one checkable step at a time (the session panel, login / switch / logout /
  End session, the short timeout, the break-it panel). About 45 minutes.
- **Run the finished result** in five minutes, below.

## Run it in five minutes

Needs Node 24 and Docker Compose 2.24 or later, and this repository checked out (see "Unreleased
parts"). Commands have no `$` prompt; each runs from the folder named above it.

**1. The SDK and the plugin, built from source.** From the repository root:

```bash
npm ci && npm run build -w sdk/browser -w plugins/ouo11y-rum-app
```

```bash
mkdir -p examples/quickstarts/tiny-shop-sessions/result/frontend/vendor
```

```bash
npm pack -w sdk/browser --pack-destination examples/quickstarts/tiny-shop-sessions/result/frontend/vendor
```

**2. The stack.** The collector image is private for now, so log in to ghcr.io once with a GitHub
token that has `read:packages`:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

From `result/stack` (the first run builds rum-api, a few minutes):

```bash
docker compose up -d --build
```

**3. The API.** From `result/backend`:

```bash
npm install && npm start
```

**4. The web app.** From `result/frontend`, in a second terminal:

```bash
npm install && npm run dev
```

Open http://localhost:5173 and keep the **Your session** panel in view. Then, in order:

1. Click **Add** and **Failed request**. Note the session id: this session will be `errored`.
2. **Log in as alice**: the session id does not change, `user.id` becomes alice.
3. **Switch to bob**: a new session id, and `session.previous_id` is alice's. Click
   **Handled error** (errored).
4. **Log out**: a new session again, with a new anonymous `user.id`. Click **Uncaught error**
   (crashed; the page keeps working).
5. **End session**: the state reads `ended (manual)`. Click **Add**: a new session starts.
6. Tick **Short inactivity timeout** (the page reloads), then touch nothing for a minute: the state
   reads `ended (inactivity)`. Click anything: the next session starts.

`device.id` stays the same through all of it.

## See it in Grafana

http://localhost:3000, admin / testing567, then **More apps -> ouo11y RUM**. Allow a minute for the
first data.

- **Overview**: the healthy / errored / crashed split. After the run above: 6 sessions, 3 healthy,
  2 errored, 1 crashed.
- **Sessions**: newest first, one row per session, with its status and user. Open bob's: the
  header reads `ended · user_change`, **User** bob, **Previous session** (alice's, click it to walk
  back the chain) and **Device**. Click the device: the list filtered to `device=<id>`, every
  session of this browser, whoever was logged in.
- The **Timeline** of a session starts with "Session start" and ends with "Session end
  (user_change)" (or `manual`, `inactivity`).

The same from rum-api, through Grafana's proxy:

```bash
curl -s -u admin:testing567 "http://localhost:3000/api/plugin-proxy/ouo11y-rum-app/rum/v1/sessions?from=now-1h&to=now"
```

Each session has `state`, `end_reason`, `status`, `user_id` and `device_id`. Add
`&device=<device id>` or `&user=bob@example.com` to filter.

## Ports

Ports taken? Export the new ports before `docker compose up -d` (in `result/stack`):

```bash
export OUO_GRAFANA_PORT=13000 OUO_OTLP_HTTP_PORT=14318 OUO_REPLAY_PORT=14319
```

Then `OUO_OTLP_ENDPOINT=http://localhost:14318 npm start` for the API, and in
`frontend/.env.local`:

```
VITE_OUO_ENDPOINT=http://localhost:14318
VITE_OUO_REPLAY_ENDPOINT=http://localhost:14319
```

The API on another port: `PORT=5002 npm start` and `VITE_API_URL=http://localhost:5002` in
`frontend/.env.local`. The web app must stay on `localhost` or `127.0.0.1`, the only origins the
collector allows.

## Clean up

From `result/stack`: `docker compose down` (add `-v` to delete the data), then stop both `npm`
commands with Ctrl+C.

## Things that bite

- **`rum.session.id()` starts a session.** It returns the active id and starts the next session
  when the last one ended, so calling it on a timer is activity. The panel reads `localStorage`
  instead ([`session.js`](result/frontend/src/session.js)).
- **Clearing site data while the page is open** does not give a fresh start: the SDK writes the
  session back when the page unloads. Close the tab, then clear, or use a private window.
- **Any signal starts the next session**, not only a click: after `endSession` or a timeout, an
  SDK event such as `long_animation_frame` (frequent in a throttled background tab) does too.
- **The inactivity timeout is read once**, at init: the switch reloads the page.
- **The short timeout is in the browser only.** rum-api keeps 30 minutes for sessions that never
  send `session.end`; a session that does send it gets the reason it sent.
- **`npm ci` with the tarball**: there is no `package-lock.json` in `frontend/` while the SDK
  comes from `vendor/`, because the tarball's checksum changes with every pack.
