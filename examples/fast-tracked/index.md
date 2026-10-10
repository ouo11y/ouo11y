# Fast track: ouo in your own project

Four guides, in order. Each one is copy-and-paste: commands you run yourself, files you copy as they are, and the exact lines you change in your own code. Nothing here depends on a script.

| Step | Guide | You end up with |
|---|---|---|
| 0 | [00-stack.md](00-stack.md) | Grafana, Loki, Tempo, Mimir, the OTel Collector, rum-api and the ouo Grafana app running in Docker on your Mac |
| 1 | [10-backend.md](10-backend.md) | Your Go backend emitting traces, logs and metrics, with `session.id` and `user.id` copied from baggage onto every span |
| 2 | [20-frontend.md](20-frontend.md) | Your React app sending sessions, errors, fetch spans and rrweb replay, correlated to the backend traces |
| 3 | [30-mobile-ios.md](30-mobile-ios.md) | Your Expo React Native app on the iOS Simulator (and on your iPhone, appendix) sending sessions, crashes and screenshot replay |

## How to read

- Start at step 0 even if you only care about mobile. Every other guide assumes the stack is up.
- Sections marked **Important: we do this ourselves** are the code you hand-write or copy into your project. Everything else is wiring.
- Packages are installed by you, one command per package, each with a one-line reason. If you do not know why a package is there, you will not know when to remove it.
- "Ref files" are files in this repository you copy as they are. Short ones are inlined so a guide works without the repository open.
- Every guide ends with "What you should see" so you can tell whether it worked before moving on.

## Ports used in the guides

The guides use the default host ports from `deploy/docker/.env.example`. If any port is taken on your machine, copy that file to `deploy/docker/.env` and change the values. Nothing else needs to change.

| Service | Default |
|---|---|
| Grafana | http://localhost:3000 (admin / admin) |
| OTel Collector OTLP/HTTP | http://localhost:4318 |
| OTel Collector OTLP/gRPC | localhost:4317 |
| rum-api | http://localhost:8080 |
| demo backend | http://localhost:8081 |
| Loki | http://localhost:3100 |
| Tempo | http://localhost:3200 |
| Mimir | http://localhost:9009 |

## Where to go next

- `docs/specs/session-lifecycle.md` for what a session is and when it rotates.
- `docs/specs/mobile-replay.md` for the screenshot replay chunk format.
- `docs/adr/` for the decisions behind the choices in these guides.
- `kb/` for the quirks the team hit while building this (Xcode, Metro symlinks, Loki labels, Tempo search).
