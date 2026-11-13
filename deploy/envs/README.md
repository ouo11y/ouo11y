# deploy/envs: named local environments (`ouo-env`)

One reverse proxy, many stacks, no port juggling (roadmap B2). Every local stack an agent
or the founder runs is an **env**: the compose stack from `deploy/compose/compose.yaml`
under the compose project `ouo-<env>`, reached by name through one Traefik proxy.

| Env | What it runs | Grafana |
|---|---|---|
| `main` | always `origin/main`, built in its own worktree (`~/.local/state/ouo-env/src/main`) | http://grafana.ouo.localhost |
| `sbx` | long-lived sandbox, built from the checkout you run it from | http://grafana.sbx.ouo.localhost |
| `<slug>` | one ephemeral env per branch or PR (default name: the branch slug, `claude/foo-bar` → `foo-bar`) | http://grafana.<slug>.ouo.localhost |

Every Grafana logs in with **admin / testing567** (`up` resets it, also for data copied from an older stack).

## Commands

```bash
deploy/envs/ouo-env up <env>             # build and start (or refresh) an env, print its URLs
deploy/envs/ouo-env down <env>           # stop it; volumes are kept
deploy/envs/ouo-env down <env> --purge   # stop it and delete its volumes and state
deploy/envs/ouo-env ls                   # env, kind, branch, PR state, status, age, URLs
deploy/envs/ouo-env gc [--dry-run]       # take down ephemeral envs whose PR merged/closed or branch is gone
deploy/envs/ouo-env url <env> [--lan]    # URLs; --lan prints the device URLs with this Mac's LAN IP
deploy/envs/ouo-env env <env>            # exports for deploy/scripts/{wait-ready,smoke,e2e}.sh
deploy/envs/ouo-env proxy up|down        # the shared proxy (up is implicit in `up`)
```

- `up main` fetches origin and checks out `origin/main` in the main worktree (`--ref <ref>` for another ref), builds the plugin there when the commit changed, then builds the images. `--images` runs the released GHCR images instead (`compose.images.yaml`, public images, no login). Refresh main after every merge with `deploy/envs/ouo-env up main`.
- `up <env> --muninn` adds `deploy/compose/compose.muninn.yaml`: Muninn (the replay store, ADR-0019) on MinIO, and the collector on `collector/config.muninn.yaml`, where replay chunks are OTLP log records on `/v1/logs` routed to Muninn through a disk queue. The flag is kept in the env's state for later `up`s. Muninn is at `http://muninn.<env>.ouo.localhost`; `ouo-env env <env>` also exports `OUO_MUNINN_URL` and `OUO_COMPOSE_PROJECT` for `tests/e2e/muninn/run.mjs`.
- `up <env>` for any other env builds from the checkout the script lives in (`--src <dir>` for another one) and records the branch, its PR (via `gh`), `OUO_SESSION` / `--session`, the creation time and the port block as Docker labels (`ouo.env`, `ouo.branch`, `ouo.pr`, `ouo.session`, `ouo.created`, `ouo.block`) and in `~/.local/state/ouo-env/<env>.json` (override with `OUO_ENV_STATE`).
- `gc` never touches `main` or `sbx`, and keeps an env when `gh` cannot answer. Volumes are kept unless `--purge`.
- Smoke-test an env: `eval "$(deploy/envs/ouo-env env sbx)" && deploy/scripts/smoke.sh`.

## Hostnames

Through the proxy on port 80: `grafana`, `rum-api`, `otlp` (4318), `replay` (4319), `sentry-bridge`
(4320, the collector's Sentry bridge), `collector` (health), `backend`, `loki`, `tempo`, `mimir`, each as
`http://<name>.<env>.ouo.localhost` (main: `http://<name>.ouo.localhost`). Traefik's dashboard is
http://traefik.ouo.localhost.

Hosts outside any env (`EXTERNAL` in `lib.mjs`, Traefik file provider):

| Host | Target | What |
|---|---|---|
| `http://sentry.ouo.localhost`, `https://sentry.ouo.localhost` | `host.docker.internal:9000` | self-hosted Sentry, compose project `sentry-sbx`, the bridge's real upstream for testing (`project/kb-archive/sentry-self-hosted.md`); 502 while it is down |

**https.** Port 443 serves every env route and the external hosts, with a certificate from a local
CA that `proxy up` creates once in `~/.local/state/ouo-env/proxy/tls/` (openssl; the CA key stays
there). A wildcard covers one label only, so the certificate names `*.ouo.localhost` (main and the
external hosts) plus `*.<env>.ouo.localhost` for every env in the state dir; `proxy up` and `up`
re-issue it from the same CA when an env is added, and Traefik reloads it. http keeps working on
port 80. Browsers warn until the founder trusts the CA once (asks for the Mac password):

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.local/state/ouo-env/proxy/tls/ca.pem
```

Node tools trust it with `NODE_EXTRA_CA_CERTS=~/.local/state/ouo-env/proxy/tls/ca.pem` (the Sentry MCP
server needs https: it refuses an `http://` organization URL).
`*.localhost` resolves to the loopback address in Chrome, Firefox, curl and Node with no `/etc/hosts`
edit (`.local` would be mDNS on macOS and slow). The collector's CORS allows `http://*.ouo.localhost` and `https://*.ouo.localhost`.

## Devices: published ingest ports

Only what an SDK on a simulator or phone needs is published on the host, per env block:

| Env | OTLP/HTTP | replay | Sentry bridge | demo backend |
|---|---|---|---|---|
| `main` (block 0) | 4318 | 4319 | 4320 | 8082 (8081 is Metro's) |
| `sbx` (block 1) | 20010 | 20011 | 20012 | 20013 |
| ephemeral block n ≥ 2 | 20000+10n | +1 | +2 | +3 |

`ouo-env ls` shows each env's OTLP port; the block is kept for the env's lifetime (state file).

- **Simulator** (iOS Simulator, Android emulator via `adb reverse`): `http://localhost:<port>`.
- **Physical iPhone or Android phone:** a device cannot resolve `*.localhost` (it is its own
  loopback) and cannot reach the Mac's loopback. Use the Mac's LAN IP and the published port, with
  the phone on the same Wi-Fi: `deploy/envs/ouo-env url main --lan` prints e.g.
  `OTLP http://192.168.8.35:4318`, and a Sentry DSN for the bridge becomes
  `http://<public key>@192.168.8.35:4320/<project id>`. iOS needs the app's ATS exception for
  plain HTTP to a LAN address (`NSAllowsLocalNetworking` or a per-domain exception).

## Migrating an existing stack into an env (one-off)

`up <env> --copy-from <compose project> [--copy-rum-api-data <dir>]` seeds a **new** env with the
named volumes (`grafana-data`, `loki-data`, `tempo-data`, `mimir-data`) of an older compose project,
and optionally the bind-mounted rum-api replay directory (`deploy/data/rum-api` of that checkout).
Stop the old stack first (`docker compose -p <project> stop`) so the stores are consistent; when the
env works, remove the old stack with `docker compose -p <project> down` (no `-v`).

## Files

- `ouo-env`: the CLI (Node 24, no dependencies); `lib.mjs`: its pure logic (names, hosts, port
  blocks, the compose overlay it writes to `~/.local/state/ouo-env/<env>/compose.env.yaml`, ls / gc
  decisions); `lib.test.mjs`: `node --test deploy/envs/*.test.mjs` (CI `node` job).
- `proxy.compose.yaml`: Traefik v3.7, Docker provider (env routes) and file provider
  (`~/.local/state/ouo-env/proxy/dynamic.yaml`, rendered from `lib.mjs` on every `proxy up`: TLS
  certificate and the external hosts), network `ouo-proxy`, ports 80 and 443. Start it with
  `ouo-env proxy up`; plain `docker compose` fails on the unset `OUO_PROXY_DIR`.
- Isolation: env services join only their own compose network (`ouo-<env>_default`); `ouo-env up`
  attaches the proxy container to it, and `down` detaches it. Never put env services on a shared
  network: compose aliases every container by its bare service name on each network it joins, so
  two envs on one network resolve each other's `loki`, `tempo`, `rum-api` at random (seen
  2026-10-24).
- Knowledge and quirks: `project/kb-archive/ouo-env.md`.
