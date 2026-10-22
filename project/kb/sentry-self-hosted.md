# Self-hosted Sentry for ouo testing

Question: how do we run a real Sentry on this Mac as the Sentry bridge's upstream (N2), what does it cost, and what had to be worked around? Also: how does Claude read it through the Sentry MCP server?

Written 2026-10-18 by `sentry-demo` (session sentry-selfhost). Sentry 26.10.0 (getsentry/self-hosted, released 2026-10-16), Docker Desktop 29.3.1, Compose 5.1.1, Apple M5 / 32 GB.

## Where it lives

| What | Value |
|---|---|
| Checkout | `~/Desktop/personal/sentry-self-hosted` (tag 26.10.0, outside the repo) |
| Compose project | `sentry-sbx` (`COMPOSE_PROJECT_NAME` in `.env.custom`, a copy of `.env`; the installer and compose read `.env.custom` when it exists) |
| URLs | `https://sentry.ouo.localhost` and `http://sentry.ouo.localhost` through the shared ouo-env proxy (`deploy/envs`, `EXTERNAL` in `lib.mjs`); `http://localhost:9000` direct (fallback, and what the bridge forwards to) |
| Login | `admin@ouo.localhost` / `testing567`, superuser and owner of org `sentry` |
| Project | `sentry-demo` (id 2, platform `react-native`), DSN `http://<public key>@localhost:9000/2`; for the bridge the app uses `http://<public key>@localhost:<bridge port>/2` |
| Feature set | `COMPOSE_PROFILES=feature-complete` (default). Replay (`organizations:session-replay`) and logs (`organizations:ourlogs-*`) are already in the default `SENTRY_FEATURES` of `sentry/sentry.conf.py`; nothing to switch on |

Start and stop (data is kept in named volumes):

```bash
cd ~/Desktop/personal/sentry-self-hosted
docker compose --env-file .env.custom up -d --wait
docker compose --env-file .env.custom down        # never -v: that deletes every event
```

`deploy/envs/ouo-env proxy up` must have run once for the `sentry.ouo.localhost` names.

## Memory

- The installer refuses below 14,000 MB of Docker memory for `feature-complete` (7,000 MB for `errors-only`); the README asks for 16 GB. `install/_min-requirements.sh` is the source of truth.
- `errors-only` drops transactions, spans, replays, profiles, logs, metrics and uptime. N2 needs replays and logs, so it is not an option for bridge testing.
- Measured with `docker stats` (53 containers): **14.0 GiB right after the first start, 13.2 GiB after a 2 min journey**. The largest: taskworker 1.4 GiB, web 1.0 GiB, clickhouse 0.9 GiB, attachments-consumer 0.6 GiB, kafka 0.5 GiB, then about 30 consumers at 0.45 to 0.5 GiB each.
- With Docker Desktop at 20 GB + 4 GB swap, Sentry plus one ouo stack (0.6 GiB) plus the two ouo-env stacks (`main`, `sbx`, about 1.8 GiB) used 16.3 GB and 1.9 GB of swap. That leaves 12 GB of the 32 GB for macOS, Xcode builds and the simulator, which was enough. Do not run more ouo envs next to Sentry without raising the Docker memory.

## Install gotchas

- **bash 4.4+.** `install.sh` fails on macOS's bash 3.2. `brew install bash`, then `PATH=/opt/homebrew/bin:$PATH ./install.sh --skip-user-creation --no-report-self-hosted-issues`.
- **Docker Hub timeouts.** Image HEAD requests from the Docker VM timed out now and then (the Mac itself reached Docker Hub fine). The installer's pull step only warns, but the build step (`clickhouse` from `altinity/clickhouse-server`) fails. Fix: pre-pull the Docker Hub images with retries, then rerun the installer. List them with `docker compose --env-file .env.custom config --images` plus the ClickHouse base image.
- Harmless installer noise: `Error opening GeoIP database` (no MaxMind key), `Deletion of some consumer groups failed ... GroupIdNotFoundException` (fresh Kafka).
- `symbolicator` exited with 137 once right after the first `up --wait` (not OOM-killed); `up -d symbolicator` brought it back.
- Telemetry off: installer flag `--no-report-self-hosted-issues`, and `SENTRY_BEACON = False` appended to `sentry/sentry.conf.py`.
- **Users.** `sentry createuser --email admin ...` is accepted, but the login form requires an email address, so that user cannot sign in. Use an address: `docker exec sentry-sbx-web-1 sentry createuser --email admin@ouo.localhost --password testing567 --superuser --staff --no-input`, then make it an org owner (the first user created by `createuser` gets the default org, later ones may not).
- Sentry's own SDK inside the containers reports to `system.url-prefix`, which the containers cannot reach; every `sentry exec` / `createuser` prints a `ConnectionRefusedError` traceback after doing its work. Look for the command's own output, not the traceback.
- `system.url-prefix` (in `sentry/config.yml`) sets the links Sentry and the MCP server produce. `CSRF_TRUSTED_ORIGINS` in `sentry.conf.py` must list every origin the UI is opened from. Restart `web` after either change.

## Sentry MCP server

- `@sentry/mcp-server` 0.42.0 (stdio, `npx`), user-level Claude config, name `sentry-sbx` (the user config already has a `sentry` entry for another host):

  ```bash
  claude mcp add --scope user sentry-sbx \
    -e SENTRY_ACCESS_TOKEN=<token> \
    -e NODE_EXTRA_CA_CERTS=$HOME/.local/state/ouo-env/proxy/tls/ca.pem \
    -- npx -y @sentry/mcp-server@0.42.0 --host=sentry.ouo.localhost --organization-slug=sentry --skills=inspect
  ```

- Token: a user auth token of `admin@ouo.localhost` with `org:read project:read team:read event:read` only (created with `ApiToken.objects.create(...)` in `sentry exec`). A write call answers 403. `--skills=inspect` keeps the write tools off as well. The token lives only in `~/.claude.json`.
- **The MCP server needs https.** With `--host=localhost:9000 --insecure-http`, `find_projects` works, but every issue, replay or trace read fails with `Invalid regionUrl provided: http://localhost:9000. Must use HTTPS protocol for security.` (`validateRegionUrl` checks the organization's `links.regionUrl`, which is `system.url-prefix`; no flag turns it off). Hence `system.url-prefix: https://sentry.ouo.localhost` through the ouo-env proxy's TLS, and `NODE_EXTRA_CA_CERTS` for the local CA. Node resolves `*.localhost` to loopback without `/etc/hosts`.
- The server sends its own telemetry only when `SENTRY_DSN` / `--sentry-dsn` is set; neither is set here.
- URL arguments must be https too: pass `replayId` + `organizationSlug` (`get_replay_details` through `execute_sentry_tool`) or an `https://sentry.ouo.localhost/...` URL.
- Verified: `find_projects` lists `internal` and `sentry-demo`; `get_replay_details` returns duration, 18 segments, 3 errors, the activity and related issues and traces.

## Bridge against real Sentry (N2), first run

Chain: app → `sentrytap` A (127.0.0.1:4420) → ouo collector `ouosentry` (`OUO_SENTRY_UPSTREAM=http://host.docker.internal:4421`, `OUO_SENTRY_PROJECT_ID=2`, the project's public key) → `sentrytap` B (127.0.0.1:4421) → Sentry `localhost:9000`. ouo on the released 0.2.0 images.

- Real-tap journey (simulator taps, not deep links): 49 requests, `sentrytap compare` 49/49 byte-identical, 0 problems.
- Every answer was `200` with body `{}` (the fake sink answers `{"id": ...}`). No `X-Sentry-Rate-Limits`, no `Retry-After`, no 413 (largest envelope 60 KB), no auth error. The bridge passes Sentry's whole header set through (CORS headers, `Server: nginx`), not only the four the spec lists; the responses at A and B were identical apart from `Date`.
- Latency added by the bridge: p50 8 ms at A vs 3 ms at B, p95 56 vs 35 ms.
- Sentry stored everything: 4 error events (handled error and unhandled rejection grouped into one issue), 10 transactions, 2 replays (18 + 6 segments, every segment sent), sessions (1 crashed, 1 healthy), logs.
- ouo: `verify-bridge.py` 19/21. The two failures do not depend on the upstream: console lines printed before Sentry's first session exists (`rum mode ...`, `Running "main"`, `[rollout] next launch`) get no session (`ouo.sentry.session_match = none`), and `Running "main"` is stored twice (log item without a session, replay breadcrumb with one).

## Ingest stuck: taskbroker (2026-10-23)

- Symptom: every envelope gets `200`, but nothing shows in Sentry (no issues, logs or sessions). Relay logs `error fetching project state <key>: deadline exceeded ... pending=275`; web logs no project config requests.
- Cause: the `taskbroker` Kafka consumer logged `Actor shutdown signaled` after a rebalance and never rejoined, so no task (also the project config build Relay waits for) ran. `taskworker` was idle.
- Fix: `docker compose --env-file .env.custom restart taskbroker`. Within 10 s the taskworker runs again, Relay stops timing out and delivers the envelopes it held. Check `docker logs --since 1m sentry-sbx-relay-1 | grep -c "deadline exceeded"` before a live run.

## Gotchas for the app

- The demo app needs `npm run -w sdk/react-native build` before `scripts/build-ios.sh`, or the build fails with `no such module 'OuoReplay'` (the SDK build vendors the Swift sources into the pods).
- `sentrytap` processes left by other sessions may hold 4400 / 4411; check with `lsof -iTCP:<port> -sTCP:LISTEN` and pick free ports.
