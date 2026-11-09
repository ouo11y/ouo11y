# ouo-env: named local environments

Question: how do several ouo stacks run side by side on one Mac without port juggling, and what bit us building it? Tool: `deploy/envs/ouo-env` (roadmap B2, 2026-10-17). Usage: `deploy/envs/README.md`.

## Design in one paragraph

Each env is the compose project `ouo-<env>` built from `deploy/compose/compose.yaml` plus a generated overlay (`~/.local/state/ouo-env/<env>/compose.env.yaml`). The overlay drops every UI/API host port (`ports: !reset []`), joins the external network `ouo-proxy`, and adds Traefik labels so one Traefik v3.7 on port 80 routes `http://<service>.<env>.ouo.localhost`. Only the SDK ingest ports (OTLP, replay, Sentry bridge) and the demo backend stay published, from a per-env block (main: 4318-4320 + 8082; sbx: 20010-20013; ephemeral n ≥ 2: 20000+10n). State (branch, PR, session, created, block, source checkout) lives in `~/.local/state/ouo-env/<env>.json` and as `ouo.*` container labels. `main` is built from a dedicated detached worktree at `origin/main`, never from a feature checkout.

## Things that were not obvious

- **`*.localhost` resolution:** Chrome, Firefox, curl and Node (`dns.lookup` returns `::1`) resolve any `*.localhost` to loopback with no `/etc/hosts` entry; Docker Desktop publishes port 80 on IPv4 and IPv6, so both work. A physical phone resolves `localhost` to itself and cannot reach the Mac's loopback: use the LAN IP and the published block ports (`ouo-env url <env> --lan`).
- **Port 8081 is Metro's** (Expo dev server), so `main`'s demo backend is published on 8082.
- **Overlay paths must be absolute.** Compose resolves relative paths of every `-f` file against the first file's directory; the overlay writes absolute paths (rum-api config) to avoid surprises.
- **`!reset` / `!override` need YAML**, so the overlay is rendered as YAML text, not JSON; compose ≥ 2.24 (here v5.1.1).
- **rum-api in a named volume:** rum-api runs as distroless `nonroot` (65532). A fresh named volume is root-owned, and rum-api exited with `mkdir /data/replays: permission denied`. The base stack never hit this because it bind-mounts `deploy/data/rum-api` (Docker Desktop's file sharing ignores ownership). Fix: the rum-api image now ships an empty `/data` owned by nonroot; Docker copies it, with ownership, into a new empty volume on first mount. An env created before that image keeps a root-owned volume: `ouo-env down <env> --purge` and up again. Copied replay data is `chown -R 65532:65532`.
- **Per-project image names:** services with `build:` and no `image:` (rum-api, backend) are tagged `<project>-<service>`, so a new env builds them once even with `--no-build` (compose builds missing images).
- **Docker Hub timeouts:** on 2026-10-17 lookups of `docker/dockerfile:1` (the `# syntax=` line) and base images timed out intermittently (`context deadline exceeded`). `ouo-env` retries `compose up`, `compose create` and the copy containers up to 3 times.
- **Grafana admin password:** `GF_SECURITY_ADMIN_PASSWORD` only applies when `grafana.db` is created. Data copied from an older stack kept that stack's password (`admin`), so `up` always runs `grafana cli admin reset-admin-password testing567`.
- **Traefik and Docker Engine 29** (API 1.54, minimum 1.40): Traefik v3.7.13's Docker provider negotiates fine; no `DOCKER_API_VERSION` needed.
- **gc safety:** `gh pr list --head <branch> --state all` gives the PR; if `gh` fails the env is kept ("PR state unknown"), an open PR keeps an env even if the local branch was deleted, and `main` / `sbx` are never collected.
- **Compose down by project name** (`docker compose -p ouo-<env> down`) works without the files; `-v` does not find the volumes that way, so `--purge` removes volumes by the `com.docker.compose.project` label.

## Verified (2026-10-17)

- `node --test deploy/envs/*.test.mjs`: 10 tests (slugs, names, hosts, port blocks, gc decisions, ls rows, overlay content, exports, args).
- `ouo-env up sbx`: proxy started, all routes registered, `smoke.sh` SMOKE OK and `e2e.sh` E2E OK (40 sessions, plugin proxy assertions) through `eval "$(ouo-env env sbx)"`; Grafana login admin / testing567.
- `gc`: an ephemeral env on the merged branch of PR #23 → `--dry-run` "would remove", `gc` took it down with 5 volumes kept, `gc --purge` removed them; `sbx` kept as protected.
