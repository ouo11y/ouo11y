# From scratch: the ouo stack, a web app, a phone app and your own plugin

A series of build-it-yourself guides. Each starts from what the one before left, writes every file
by hand and ends with something you can see. Together they build the whole picture since
[ADR-0025](../../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md): ouo collects and
stores, and the UI on top is yours, built with the generic libraries `ouo-go` and `@ouo11y/kit`.

| # | Guide | You end up with | Time |
|---|---|---|---|
| 00 | [Build the stack](00-stack.md) | The OpenTelemetry Collector, Tempo, Loki, Muninn and Grafana in Docker, one folder per service, and a first record sent with `curl` | 20 min |
| 01 | [A web app](01-web.md) | Tiny Shop in React with `@ouo11y/browser`: sessions, page views, clicks, a custom event, an error, traces and a masked replay, found in Grafana and Muninn | 20 min |
| 02 | [A React Native app](02-react-native.md) | Tiny Shop for iOS with Expo and `@ouo11y/react-native`: screens, a custom event, the crash, vitals and screenshot replay | 30 min |
| 03 | [Your own Grafana plugin](03-plugin.md) | **Sessions**, an app plugin with a Go backend on `ouo-go` (sessions, events, replays, and an access rule: Viewers never see the user) and a React frontend that plays the web replay with `@ouo11y/kit` | 30 min |

Start at 00; every other guide sends to or reads from that stack. 02 and 03 are independent of
each other, and both use the web app of 01.

```
ouo-from-scratch/
├── stack/      00: one folder per service, numbered in start order
├── web/        01: Vite + React, @ouo11y/browser
├── mobile/     02: Expo, @ouo11y/react-native
└── plugin/     03: Grafana app plugin, Go backend with ouo-go, React with @ouo11y/kit
```

[`result/`](result) is exactly what the four guides end with. Compare with it when you are stuck.
It leaves out the scaffolder's files for coding agents (`AGENTS.md`, `CLAUDE.md`, `.claude/`), its
root `README.md` and its GitHub workflows. It keeps the rest as the scaffolder wrote it, including
`.config/` (owned by `create-plugin update`), `src/README.md` (the plugin's page in Grafana) and
the Playwright and Docker setup the guide does not use.

## Run `result/` as is

Each block runs from `result/`, in its own terminal tab. You need Docker, Node 24 and, for the
plugin, Go 1.26; for the phone app, Xcode and CocoaPods.

The plugin first, built into `plugin/dist`, which the stack's Grafana mounts:

```bash
cd plugin && npm install && npm run build && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o dist/gpx_sessions_linux_arm64 ./pkg && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o dist/gpx_sessions_linux_amd64 ./pkg
```

The stack:

```bash
cd stack && docker compose up -d
```

The web app on http://localhost:5173:

```bash
cd web && npm install && npm run dev
```

The phone app on the iOS Simulator:

```bash
cd mobile && npm install && LANG=en_US.UTF-8 npx expo run:ios
```

Then open http://localhost:3000 (admin / testing567), **More apps > Sessions**.

## Ports

| Service | Port | Where |
|---|---|---|
| Grafana | 3000 | your network; `OUO_GRAFANA_PORT` |
| Collector, OTLP/HTTP | 4318 | your network; `OUO_OTLP_HTTP_PORT` |
| Loki, Tempo, Muninn | 3100, 3200, 3400 | loopback only, for `curl` |
| Collector health | 13133 | loopback only |
| Web app (Vite) | 5173 | your machine |

Move a port with `stack/.env` ([00, step 3](00-stack.md#step-3-check-the-ports)), never by
stopping what holds it.

## Released pieces only

| Piece | Version | From |
|---|---|---|
| OpenTelemetry Collector (contrib) | 0.160.0 | `otel/opentelemetry-collector-contrib` |
| Tempo, Loki, Grafana | 3.0.3, 3.7.7, 13.2.5 | `grafana/*` |
| Muninn | 0.1.0 | `ghcr.io/ouo11y/muninn` |
| `@ouo11y/browser` | 0.4.1 | npm |
| `@ouo11y/react-native` | 0.4.0 | npm |
| `@ouo11y/kit` | 0.1.0 | npm |
| `ouo-go` | v0.2.0 | `go get github.com/ouo11y/ouo11y/libs/ouo-go@v0.2.0` |
| `@grafana/create-plugin` | 9.0.3 | npm |

Every development credential in the series is public and for a laptop only: the `demo` project
token `pt_dev_demo_0000000000000000`, Muninn's `mit_dev_...` and `mrt_dev_...` tokens, Grafana's
`admin` / `testing567`.

## What is not there yet

- **Mobile replay does not play in the plugin.** The phone's `ouo-frames/3` chunks are stored in
  Muninn; `@ouo11y/kit` 0.1 plays `rrweb/2` (web) only and names the frames as "stored, not
  playable" until its frames player ships.
- **Funnels, session health %, vitals and traces in the plugin**: `ouo-go` v0.2.0 has the readers;
  the plugin does not use them yet ([03, the last section](03-plugin.md#what-else-ouo-go-reads)).
- **The ouo collector image** adds a per-client rate limiter; its released 0.5.0 lacks the disk
  queue Muninn's route needs, so 00 uses the stock contrib Collector.
- **Android** for 02: the SDK supports it, but this series was verified on the iOS Simulator only.
