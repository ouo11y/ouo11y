# ouo on a VM (Ubuntu 24.04)

One Docker host, Caddy for TLS, the compose stack from `deploy/docker` plus the
override in this folder. Suitable for a pilot; the Kubernetes path is `deploy/helm`.

```
internet ──443──> caddy ──> grafana:3000              https://OUO_DOMAIN        (UI + ouo plugin)
                        ├─> otel-collector:4319       https://OUO_OTEL_DOMAIN/v1/replay/*   (replay chunks)
                        └─> otel-collector:4318       https://OUO_OTEL_DOMAIN/*             (OTLP: /v1/traces, /v1/logs, /v1/metrics)
                                  │ Basic <project id>:<project token> checked against projects.htpasswd,
                                  │ ouo.project.id stamped, rate limited
                                  ├──OTLP──> tempo / loki / mimir
                                  └──replay chunks + Bearer <ingest token>──> rum-api:8080 (internal) ──> disk
loopback only: 3000 3100 3200 9009 4317 4318 4319 13133 8080 8081 (operator, scripts)
```

The collector is the only thing an SDK talks to. rum-api has no hostname and no
public port; Grafana reaches it in-network with the read token.

## One-command install

Two DNS names pointing at the VM (`ouo.example.com` for Grafana, `otel.ouo.example.com`
for the collector), ports 22, 80 and 443 open, 4 GB RAM, 20 GB disk to start.

```bash
curl -fsSL https://raw.githubusercontent.com/ZiadMansourM/ouo/main/deploy/vm/install.sh \
  | sudo bash -s -- --domain ouo.example.com --email you@example.com
```

Or from a clone: `sudo deploy/vm/install.sh --domain ... --email ...`. The script

1. installs `docker.io`, `docker-compose-v2`, `git`, `curl`, `openssl` with apt when Docker is
   missing (`--no-install-docker` to refuse),
2. clones the repo to `/opt/ouo` (`--dir`) at `main` (`--ref <tag>` to pin a release),
3. writes `/opt/ouo/deploy/docker/.env` (mode 600) with a random project token
   (`pt_` + `openssl rand -hex 16`), ingest token (`it_` + 32 hex), read token (`rt_` +
   32 hex) and Grafana admin password, and `/opt/ouo/deploy/docker/projects.htpasswd`
   with the project's `{SHA}` line; existing values are kept on re-runs,
4. builds the Grafana plugin inside a `node:24` container (no Node on the host), the ouo
   collector distribution (`collector/Dockerfile`, ocb; the slow step), `rum-api` and the
   demo backend,
5. starts `compose.yaml` + `compose.tls.yaml`, installs and enables `ouo.service`,
6. waits for readiness and prints the Grafana login and the **public** project credential
   with ready-to-paste SDK configuration (`projectId`, `projectToken`, the Basic header).

LAN or IP-only testing without public DNS: `--tls-internal` (default when `--email` is
absent). Caddy then signs with its own CA; trust the root it prints or accept the browser
warning. The project credential still works, the SDK just needs a browser that trusts the CA.

## Projects and tokens

The collector authenticates every ingest request with HTTP Basic: username = project id,
password = project token, checked against `deploy/docker/projects.htpasswd` (ADR-0007).
The hash is `{SHA}` (base64 of the raw SHA-1), the same thing `htpasswd -nbs <id> <token>`
produces; it is deliberately cheap because it runs on every request and the token is
public by design. `install.sh` writes it with `openssl` so the VM needs no `apache2-utils`:

```bash
printf '%s:{SHA}%s\n' web-store "$(printf '%s' pt_live_9f3c... | openssl dgst -binary -sha1 | openssl base64)"
# or: htpasswd -nbs web-store pt_live_9f3c...
```

- **Add a project**: `echo "pt_$(openssl rand -hex 16)"` for the token, append the line
  above to `deploy/docker/projects.htpasswd`, `sudo systemctl restart ouo` (the
  `basicauth` extension reads the file at start). Give the app `projectId` + `projectToken`.
- **Rotate**: append a second line for the same project id with the new token, restart,
  move the SDKs, delete the old line, restart.
- **Revoke**: delete the line, restart.
- Which project an operator script (`smoke.sh`, `e2e.sh`) sends as comes from
  `OUO_PROJECT_ID` / `OUO_PROJECT_TOKEN` in `.env`; compose itself never reads them.

Browser origins allowed to post are the collector's `cors.allowed_origins` list in
`deploy/docker/collector/config.yaml` (global for all projects in this phase). Edit it in
the checkout and `sudo systemctl restart ouo`; note that a local edit to a tracked file
has to be stashed or committed before `install.sh --ref` can move the checkout.

## Files

| File | Purpose |
|---|---|
| `install.sh` | idempotent installer and upgrader (see above) |
| `compose.tls.yaml` | override: Caddy on 80/443, every other published port (collector 4318/4319 included) re-bound to `127.0.0.1`, server-side `projects.htpasswd` mounted into the collector, `restart: unless-stopped`, Grafana public URL and admin password |
| `Caddyfile` | two sites, `tls {$OUO_TLS:internal}` (ACME email or `internal`); `OUO_DOMAIN` -> `grafana:3000`; `OUO_OTEL_DOMAIN` -> `/v1/replay/*` to `otel-collector:4319`, everything else to `otel-collector:4318` |
| `ouo.service` | systemd oneshot that runs `compose up -d` on boot and `compose down` on stop; `__OUO_DIR__` is replaced by the installer |

Everything is driven by `/opt/ouo/deploy/docker/.env` and `/opt/ouo/deploy/docker/projects.htpasswd`:

| Variable | Set by | Meaning |
|---|---|---|
| `OUO_DOMAIN`, `OUO_OTEL_DOMAIN` | `--domain`, `--otel-domain` (default `otel.<domain>`) | hostnames Caddy serves |
| `OUO_TLS` | `--email` or `--tls-internal` | ACME account email, or `internal` |
| `OUO_PROJECT_ID` | `--project` (default `default`) | first project; the Basic username; value of `ouo.project.id` |
| `OUO_PROJECT_TOKEN` | installer, random | **public**; the Basic password; hashed into `projects.htpasswd`; ships in browser bundles |
| `OUO_INGEST_TOKEN` | installer, random | **secret**; bearer the collector's replay exporter presents to rum-api |
| `OUO_READ_TOKEN` | installer, random | **secret**; unlocks `GET/DELETE /v1/*` on rum-api; provisioned into the Grafana plugin's `secureJsonData` |
| `OUO_BACKEND_OTLP_HEADERS` | installer, from the project credential | `Authorization=Basic%20<base64>`: what the demo backend and rum-api use for their own OTLP |
| `OUO_GRAFANA_ADMIN_PASSWORD` | installer, random | Grafana `admin` password |
| `OUO_*_PORT` | optional | loopback ports for the operator (defaults as on a laptop) |

Change a value, then `sudo systemctl restart ouo` (re-runs `compose up -d`, which recreates
only the containers whose configuration changed).

## Firewall

Only 22, 80 and 443 need to be open. Docker publishes ports with its own iptables rules
that bypass ufw, so the override binds every service except Caddy to `127.0.0.1`; a port
that is not published on `0.0.0.0` cannot leak. With ufw:

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw enable
```

Check from outside: `nmap -p 3000,4318,4319,8080 <vm>` must show them closed/filtered;
`curl -si -X POST https://otel.ouo.example.com/v1/traces` must answer `401` (the collector
is reachable and asks for the credential).

## Where data lives

| Data | Location | Notes |
|---|---|---|
| traces, logs, metrics | named volumes `ouo_tempo-data`, `ouo_loki-data`, `ouo_mimir-data` | `docker volume inspect` for the host path (under `/var/lib/docker/volumes`) |
| Grafana state (users, settings) | `ouo_grafana-data` | dashboards and datasources are provisioned from the repo |
| replay chunks | bind mount `/opt/ouo/deploy/data/rum-api/replays/<session_id>/` | gitignored; one `meta.json` per session records `project_id` |
| certificates, ACME account, internal CA | `ouo_caddy-data` | losing it only means re-issuing certificates |
| configuration and secrets | `/opt/ouo/deploy/docker/.env`, `/opt/ouo/deploy/docker/projects.htpasswd` | back these up with the data; neither is in git |

Retention is not configured in Phase 8a (Phase 8b): disk grows with ingest. Watch
`df -h /var/lib/docker` and `du -sh /opt/ouo/deploy/data`.

## Operate

```bash
sudo systemctl status ouo                                                             # active (exited) = up -d succeeded
cd /opt/ouo && sudo docker compose -f deploy/docker/compose.yaml -f deploy/vm/compose.tls.yaml ps
cd /opt/ouo && sudo docker compose -f deploy/docker/compose.yaml -f deploy/vm/compose.tls.yaml logs -f caddy otel-collector rum-api
cd /opt/ouo && sudo deploy/scripts/wait-ready.sh                                     # loopback readiness: collector health + 4318/4319, rum-api /readyz
cd /opt/ouo && sudo deploy/scripts/smoke.sh                                          # round trip on the loopback ports
cd /opt/ouo && sudo OUO_OTLP_URL=https://otel.ouo.example.com OUO_REPLAY_URL=https://otel.ouo.example.com deploy/scripts/smoke.sh   # through Caddy, as an SDK would
```

`smoke.sh` reads the project credential from `.env`, posts to the collector and checks
Tempo, Loki, Mimir and the replay store (via rum-api on loopback). The negative checks
(401 without or with a wrong credential, 401 on the internal replay sink without the
ingest token) prove the edge rules; run it against the public hostname to prove them
through Caddy.

## Upgrade

Re-run the installer with the target ref; tokens, the project registry, passwords and
data are kept:

```bash
sudo /opt/ouo/deploy/vm/install.sh --ref v0.2.0
```

It fetches, checks out, rebuilds the plugin and images (the collector distribution
included), and re-applies `up -d`, which recreates only changed containers. Image tags for
Grafana, Loki, Tempo, Mimir and Caddy are pinned in the compose files, the collector's
upstream component versions in `collector/builder.yaml`, so an upgrade is a reviewed change
in git, never a surprise pull. Release-specific steps (schema versions, breaking SDK
changes) are listed in `CHANGELOG.md` by the release process.

## Backup

Minimum viable backup until the Phase 8c drill: stop writes, archive the volumes and the
bind mount, keep `.env` and `projects.htpasswd`.

```bash
cd /opt/ouo && sudo systemctl stop ouo
for v in grafana-data loki-data tempo-data mimir-data caddy-data; do
  sudo docker run --rm -v ouo_$v:/v -v /backup:/b alpine tar czf /b/ouo_$v.tgz -C /v .
done
sudo tar czf /backup/ouo_replays.tgz -C /opt/ouo/deploy/data rum-api
sudo cp /opt/ouo/deploy/docker/.env /backup/ouo.env
sudo cp /opt/ouo/deploy/docker/projects.htpasswd /backup/ouo.projects.htpasswd
sudo systemctl start ouo
```

Restore is the reverse (`tar xzf` into fresh volumes, copy both files back, `systemctl start ouo`).
Phase 8c replaces this with object storage, a rehearsed restore and a runbook.

## Troubleshooting

- `caddy` logs `obtaining certificate ... challenge failed`: DNS for both names must
  resolve to this VM and 80/443 must be reachable from the internet. Until then use
  `--tls-internal`.
- Your app gets `401` from `https://otel.<domain>`: the SDK sends no `Authorization`
  header, or a `projectId` / `projectToken` pair that has no line in `projects.htpasswd`.
  Check with `curl -si -X POST https://otel.<domain>/v1/traces -H "Authorization: Basic $(printf '%s:%s' <id> <token> | base64)" -H 'content-type: application/json' -d '{"resourceSpans":[]}'` (expect `200`).
- The browser console shows a CORS error: the page origin is not in the collector's
  `cors.allowed_origins` (see "Projects and tokens").
- `429` / `503` with `Retry-After`: the collector's rate limit (per project or per client
  address) or `memory_limiter`. Behind Caddy every request arrives from Caddy's address,
  so the per-client limit must key on `X-Forwarded-For` (which Caddy appends) rather than
  on the TCP peer; if it does not in your version, raise or disable the per-client limit in
  `deploy/docker/collector/config.yaml`.
- Replays missing while traces arrive: `docker compose ... logs otel-collector | grep -i
  replay` and `logs rum-api`. The exporter needs `OUO_INGEST_TOKEN` to be identical on the
  collector and on rum-api (both come from `.env`); a mismatch is a `401` in rum-api's log.
- Plugin missing in Grafana: `ls /opt/ouo/plugins/ouo-rum-app/dist` must contain
  `module.js`; re-run the installer or `docker compose ... restart grafana` after a build.
