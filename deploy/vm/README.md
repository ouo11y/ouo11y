# ouo on a VM (Ubuntu 24.04)

One Docker host, Caddy for TLS, the compose stack from `deploy/docker` plus the
override in this folder. Suitable for a pilot; the Kubernetes path is `deploy/helm`.

```
internet ──443──> caddy ──> grafana:3000        https://OUO_DOMAIN       (UI + ouo plugin)
                        └─> rum-api:8080        https://OUO_RUM_DOMAIN   (SDK ingest, replay)
                                 │ X-Ouo-Project-Token checked, ouo.project.id stamped
                                 └──OTLP──> otel-collector:4318 ──> tempo / loki / mimir
loopback only: 3000 3100 3200 9009 4317 4318 13133 8080 8081 (operator, scripts)
```

## One-command install

Two DNS names pointing at the VM (`ouo.example.com` for Grafana, `rum.ouo.example.com`
for rum-api), ports 22, 80 and 443 open, 4 GB RAM, 20 GB disk to start.

```bash
curl -fsSL https://raw.githubusercontent.com/ZiadMansourM/ouo/main/deploy/vm/install.sh \
  | sudo bash -s -- --domain ouo.example.com --email you@example.com
```

Or from a clone: `sudo deploy/vm/install.sh --domain ... --email ...`. The script

1. installs `docker.io`, `docker-compose-v2`, `git`, `curl`, `openssl` with apt when Docker is
   missing (`--no-install-docker` to refuse),
2. clones the repo to `/opt/ouo` (`--dir`) at `main` (`--ref <tag>` to pin a release),
3. writes `/opt/ouo/deploy/docker/.env` (mode 600) with random `OUO_PROJECT_TOKEN`
   (`pt_` + `openssl rand -hex 16`), `OUO_READ_TOKEN` (`rt_` + 32 hex) and
   `OUO_GRAFANA_ADMIN_PASSWORD`; existing values are kept on re-runs,
4. builds the Grafana plugin inside a `node:24` container (no Node on the host) and the
   `rum-api` / demo backend images,
5. starts `compose.yaml` + `compose.tls.yaml`, installs and enables `ouo.service`,
6. waits for readiness and prints the Grafana login and the **public** project token with
   ready-to-paste SDK configuration.

LAN or IP-only testing without public DNS: `--tls-internal` (default when `--email` is
absent). Caddy then signs with its own CA; trust the root it prints or accept the browser
warning. The project token still works, the SDK just needs a browser that trusts the CA.

Second project, token rotation: copy `deploy/docker/projects.example.yaml` to
`deploy/docker/projects.yaml`, uncomment `OUO_PROJECTS_FILE` and the bind mount in
`compose.yaml`, `systemctl restart ouo`.

## Files

| File | Purpose |
|---|---|
| `install.sh` | idempotent installer and upgrader (see above) |
| `compose.tls.yaml` | override: Caddy on 80/443, every other published port re-bound to `127.0.0.1`, `restart: unless-stopped`, Grafana public URL and admin password, `OUO_TRUST_PROXY=true` for rum-api |
| `Caddyfile` | two sites, `tls {$OUO_TLS:internal}` (ACME email or `internal`), `reverse_proxy` to `grafana:3000` and `rum-api:8080` |
| `ouo.service` | systemd oneshot that runs `compose up -d` on boot and `compose down` on stop; `__OUO_DIR__` is replaced by the installer |

Everything is driven by `/opt/ouo/deploy/docker/.env`:

| Variable | Set by | Meaning |
|---|---|---|
| `OUO_DOMAIN`, `OUO_RUM_DOMAIN` | `--domain`, `--rum-domain` (default `rum.<domain>`) | hostnames Caddy serves |
| `OUO_TLS` | `--email` or `--tls-internal` | ACME account email, or `internal` |
| `OUO_PROJECT_ID` | installer (`default`) | value of the `ouo.project.id` resource attribute |
| `OUO_PROJECT_TOKEN` | installer, random | **public**; ships in browser bundles; write-only right to this project |
| `OUO_ALLOWED_ORIGINS` | `--allowed-origins` (default `https://<rum-domain>,https://<domain>`) | browser origins allowed to post; add your app's origin, for example `https://shop.example.com` |
| `OUO_READ_TOKEN` | installer, random | **secret**; unlocks `GET/DELETE /v1/*`; provisioned into the Grafana plugin's `secureJsonData` |
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

Check from outside: `nmap -p 3000,4318,8080 <vm>` must show them closed/filtered;
`curl -sI https://rum.ouo.example.com/readyz` must answer `200`.

## Where data lives

| Data | Location | Notes |
|---|---|---|
| traces, logs, metrics | named volumes `ouo_tempo-data`, `ouo_loki-data`, `ouo_mimir-data` | `docker volume inspect` for the host path (under `/var/lib/docker/volumes`) |
| Grafana state (users, settings) | `ouo_grafana-data` | dashboards and datasources are provisioned from the repo |
| replay chunks | bind mount `/opt/ouo/deploy/data/rum-api/replays/<session_id>/` | gitignored; one `meta.json` per session records `project_id` |
| certificates, ACME account, internal CA | `ouo_caddy-data` | losing it only means re-issuing certificates |
| configuration and secrets | `/opt/ouo/deploy/docker/.env` | back this up with the data; it is not in git |

Retention is not configured in Phase 8a (Phase 8b): disk grows with ingest. Watch
`df -h /var/lib/docker` and `du -sh /opt/ouo/deploy/data`.

## Operate

```bash
sudo systemctl status ouo                                                             # active (exited) = up -d succeeded
cd /opt/ouo && sudo docker compose -f deploy/docker/compose.yaml -f deploy/vm/compose.tls.yaml ps
cd /opt/ouo && sudo docker compose -f deploy/docker/compose.yaml -f deploy/vm/compose.tls.yaml logs -f caddy rum-api
cd /opt/ouo && sudo deploy/scripts/wait-ready.sh                                     # loopback readiness, incl. rum-api
cd /opt/ouo && sudo OUO_RUM_API=https://rum.ouo.example.com deploy/scripts/smoke.sh  # full round trip through Caddy
```

`smoke.sh` reads the project token from `.env`, posts through rum-api and checks Tempo,
Loki and Mimir on the loopback ports. The negative checks (401 without token, 403 for a
foreign origin) prove the gateway rules on the public hostname.

## Upgrade

Re-run the installer with the target ref; tokens, passwords and data are kept:

```bash
sudo /opt/ouo/deploy/vm/install.sh --ref v0.2.0
```

It fetches, checks out, rebuilds the plugin and images, and re-applies `up -d`, which
recreates only changed containers. Image tags for Grafana, Loki, Tempo, Mimir and the
collector are pinned in `compose.yaml`, so an upgrade is a reviewed change in git, never a
surprise pull. Release-specific steps (schema versions, breaking SDK changes) are listed in
`CHANGELOG.md` by the release process.

## Backup

Minimum viable backup until the Phase 8c drill: stop writes, archive the volumes and the
bind mount, keep `.env`.

```bash
cd /opt/ouo && sudo systemctl stop ouo
for v in grafana-data loki-data tempo-data mimir-data caddy-data; do
  sudo docker run --rm -v ouo_$v:/v -v /backup:/b alpine tar czf /b/ouo_$v.tgz -C /v .
done
sudo tar czf /backup/ouo_replays.tgz -C /opt/ouo/deploy/data rum-api
sudo cp /opt/ouo/deploy/docker/.env /backup/ouo.env
sudo systemctl start ouo
```

Restore is the reverse (`tar xzf` into fresh volumes, copy `.env`, `systemctl start ouo`).
Phase 8c replaces this with object storage, a rehearsed restore and a runbook.

## Troubleshooting

- `caddy` logs `obtaining certificate ... challenge failed`: DNS for both names must
  resolve to this VM and 80/443 must be reachable from the internet. Until then use
  `--tls-internal`.
- `rum-api` returns `401` to your app: the SDK sends no `X-Ouo-Project-Token`, or a token
  that is not in `.env` / `projects.yaml`.
- `403`: the page origin is not in `OUO_ALLOWED_ORIGINS` (patterns are `scheme://host[:port]`,
  `*` may replace the leading host label or the port).
- `429`: per-project or per-IP rate limit. Behind Caddy the client IP is taken from
  `X-Forwarded-For` because the override sets `OUO_TRUST_PROXY=true`; without it every
  request would count against Caddy's address.
- Plugin missing in Grafana: `ls /opt/ouo/plugins/ouo-rum-app/dist` must contain
  `module.js`; re-run the installer or `docker compose ... restart grafana` after a build.
