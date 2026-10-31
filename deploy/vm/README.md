# ouo on a VM (Ubuntu 24.04)

One Docker host, Caddy for TLS, the compose stack from `deploy/compose` plus the
override in this folder. Suitable for a pilot; the Kubernetes path is `deploy/helm`.

```
internet ──443──> caddy ──> grafana:3000              https://OUO_DOMAIN        (UI + ouo plugin)
                        ├─> otel-collector:4319       https://OUO_OTEL_DOMAIN/v1/replay/*   (replay chunks)
                        ├─> otel-collector:4320       https://OUO_OTEL_DOMAIN/api/*         (Sentry SDK envelopes, ADR-0008)
                        └─> otel-collector:4318       https://OUO_OTEL_DOMAIN/*             (OTLP: /v1/traces, /v1/logs, /v1/metrics)
                                  │ Basic <project id>:<project token> checked against projects.htpasswd,
                                  │ ouo.project.id stamped, rate limited
                                  ├──OTLP──> tempo / loki / mimir
                                  └──replay chunks + Bearer <ingest token>──> rum-api:8080 (internal) ──> disk
loopback only: 3000 3100 3200 9009 4317 4318 4319 4320 13133 8080 8081 (operator, scripts)
```

The collector is the only thing an SDK talks to. rum-api has no hostname and no
public port; Grafana reaches it in-network with the read token.

## One-command install

Two DNS names pointing at the VM (`ouo.example.com` for Grafana, `otel.ouo.example.com`
for the collector), ports 22, 80 and 443 open, 4 GB RAM, 20 GB disk to start. Building from
source (the default) wants 4 CPUs and takes about 10 minutes, most of it the collector; the
released images (`--images`, below) take about a minute.

```bash
curl -fsSL https://raw.githubusercontent.com/ouo11y/ouo11y/main/deploy/vm/install.sh \
  | sudo bash -s -- --domain ouo.example.com --email you@example.com
```

Or from a clone: `sudo deploy/vm/install.sh --domain ... --email ...`.

**While the repository is private** the `curl` above answers `404` and the clone asks for a
password. Clone it as root with a credential that can read `ouo11y/ouo11y` (a fine-grained
token with read-only Contents on that one repository; never your own account's full token,
and the root checkout keeps it in its git credential store for `--ref` upgrades), then run
the script from the clone:

```bash
sudo git clone https://github.com/ouo11y/ouo11y.git /opt/ouo     # prompts: user + token
sudo /opt/ouo/deploy/vm/install.sh --domain ouo.example.com --email you@example.com
```

The script

1. installs `docker.io`, `docker-compose-v2`, `docker-buildx`, `git`, `curl`, `openssl` with apt
   when Docker is missing (`--no-install-docker` to refuse),
2. clones the repo to `/opt/ouo` (`--dir`) at `main` (`--ref <tag>` to pin a release); on a
   re-run the checkout stays where it is unless `--ref` is given, and when the checked-out
   release carries a different installer the script hands over to it, so files and installer
   always match,
3. writes `/opt/ouo/deploy/compose/.env` (mode 600) with a random project token
   (`pt_` + `openssl rand -hex 16`), ingest token (`it_` + 32 hex), read token (`rt_` +
   32 hex) and Grafana admin password, and `/opt/ouo/deploy/compose/projects.htpasswd`
   with the project's `{SHA}` line; existing values are kept on re-runs,
4. builds the Grafana plugin inside a `node:24` container (no Node on the host), the ouo
   collector distribution (`collector/Dockerfile`, ocb; the slow step), `rum-api` and the
   demo backend, or with `--images` pulls the released images and builds only the demo backend,
5. gives `deploy/data/rum-api` to uid 65532 (rum-api runs as distroless `nonroot`; a
   root-owned bind mount makes it exit with `mkdir /data/replays: permission denied`), starts
   `compose.yaml` [+ `compose.images.yaml`] + `compose.tls.yaml`, installs, enables and starts
   `ouo.service` with the same compose files,
6. waits for readiness and prints the Grafana login, the **public** project credential with
   ready-to-paste SDK configuration (`projectId`, `projectToken`, the Basic header) and the
   Sentry DSN of the bridge.

LAN or IP-only testing without public DNS: `--tls-internal` (default when `--email` is
absent). Caddy then signs with its own CA; trust the root it prints or accept the browser
warning. The project credential still works, the SDK just needs a browser that trusts the CA.
A name that resolves to a private address without editing `/etc/hosts` anywhere:
`--domain ouo.192-168-1-20.nip.io` (the collector becomes `otel.ouo.192-168-1-20.nip.io`).

Browser origins allowed to post (CORS on the collector, all projects):
`--allowed-origins https://shop.example.com,https://*.preview.example.com` (comma separated,
no spaces; written to `OUO_ALLOWED_ORIGINS`). Without it only `http://localhost:*` and
`http://127.0.0.1:*` are allowed, so a real site gets CORS errors.

### Released images (`--images`)

```bash
sudo /opt/ouo/deploy/vm/install.sh --images --domain ouo.example.com --email you@example.com
```

Runs `ghcr.io/ouo11y/{collector,rum-api,grafana}` at the version `compose.images.yaml` pins
for the checked-out ref (`--image-version <v>` pins one in `.env`, `--registry` changes the
prefix), so no Node, Go or ocb build happens; only the demo backend is built. The mode is
remembered in `.env` (`OUO_INSTALL_MODE`); `--build` switches back.

- The images are public: no `docker login`. The installer and `ouo.service` pull as root,
  so an old, expired ghcr.io login of root makes the pull fail with `denied`; the installer
  then stops with `ghcr.io refused the pull` and the fix, `sudo docker logout ghcr.io`.
- No internet on the VM: `docker save` the three images on a machine that has
  them (pick the VM's platform, e.g. `--platform linux/arm64`), `sudo docker load` them on the
  VM, run the installer with `--images`; it pulls only what is missing.

## Projects and tokens

The collector authenticates every ingest request with HTTP Basic: username = project id,
password = project token, checked against `deploy/compose/projects.htpasswd` (ADR-0007).
The hash is `{SHA}` (base64 of the raw SHA-1), the same thing `htpasswd -nbs <id> <token>`
produces; it is deliberately cheap because it runs on every request and the token is
public by design. `install.sh` writes it with `openssl` so the VM needs no `apache2-utils`:

```bash
printf '%s:{SHA}%s\n' web-store "$(printf '%s' pt_live_9f3c... | openssl dgst -binary -sha1 | openssl base64)"
# or: htpasswd -nbs web-store pt_live_9f3c...
```

- **Add a project**: `echo "pt_$(openssl rand -hex 16)"` for the token, append the line
  above to `deploy/compose/projects.htpasswd`, `sudo systemctl restart ouo` (the
  `basicauth` extension reads the file at start). Give the app `projectId` + `projectToken`.
- **Rotate** (cut-over): replace the project's line with one for the new token, restart,
  ship the new token to the apps. The collector's `basicauth` keeps only one line per
  project id, so the old token stops working at the restart (ADR-0007 section 2).
- **Revoke**: delete the line, restart.
- Which project an operator script (`smoke.sh`, `e2e.sh`) sends as comes from
  `OUO_PROJECT_ID` / `OUO_PROJECT_TOKEN` in `.env`; compose itself never reads them.

Browser origins allowed to post are `OUO_ALLOWED_ORIGINS` in `.env` (global for all projects
in this phase; `--allowed-origins` writes it). Change it and `sudo systemctl restart ouo`.

### Sentry SDK bridge

Apps that keep the Sentry SDK change only the DSN host (ADR-0008). Caddy sends
`https://OUO_OTEL_DOMAIN/api/*` to the bridge on 4320; the installer prints the DSN
`https://<OUO_SENTRY_PUBLIC_KEY>@OUO_OTEL_DOMAIN/<OUO_SENTRY_PROJECT_ID, default 1>`. Set
`OUO_SENTRY_UPSTREAM` (your Sentry ingest URL) in `.env` to keep forwarding to Sentry;
without it the bridge answers locally. Installs from before the key existed keep the
compose default `publickey0000000000000000000000`, which their apps already use. Known gap:
the bridge stamps `ouo.project.id=demo` on what it translates (`ouo_project_id` is fixed in
`deploy/compose/collector/config.yaml`), so bridged sessions show under project `demo`, not
the install's project.

## Files

| File | Purpose |
|---|---|
| `install.sh` | idempotent installer and upgrader (see above) |
| `compose.tls.yaml` | override: Caddy on 80/443, every other published port (collector 4318/4319 included) re-bound to `127.0.0.1`, server-side `projects.htpasswd` mounted into the collector, `restart: unless-stopped`, Grafana public URL and admin password |
| `Caddyfile` | two sites, `tls {$OUO_TLS:internal}` (ACME email or `internal`); `OUO_DOMAIN` -> `grafana:3000`; `OUO_OTEL_DOMAIN` -> `/v1/replay/*` to `otel-collector:4319`, everything else to `otel-collector:4318` |
| `ouo.service` | systemd oneshot that runs `compose up -d` on boot and `compose down` on stop; the installer replaces `__OUO_DIR__` and writes the ExecStart / ExecStop compose files of the install mode |

Everything is driven by `/opt/ouo/deploy/compose/.env` and `/opt/ouo/deploy/compose/projects.htpasswd`:

| Variable | Set by | Meaning |
|---|---|---|
| `OUO_DOMAIN`, `OUO_OTEL_DOMAIN` | `--domain`, `--otel-domain` (default `otel.<domain>`) | hostnames Caddy serves |
| `OUO_TLS` | `--email` or `--tls-internal` | ACME account email, or `internal` |
| `OUO_PROJECT_ID` | `--project` (default `default`) | first project; the Basic username; value of `ouo.project.id` |
| `OUO_PROJECT_TOKEN` | installer, random | **public**; the Basic password; hashed into `projects.htpasswd`; ships in browser bundles |
| `OUO_INGEST_TOKEN` | installer, random | **secret**; bearer the collector's replay exporter presents to rum-api |
| `OUO_READ_TOKEN` | installer, random | **secret**; unlocks `GET/DELETE /v1/*` on rum-api; provisioned into the Grafana plugin's `secureJsonData` |
| `OUO_ADMIN_TOKEN` | installer, random | **secret**; unlocks rum-api's `/v1/admin/*` (delete by user / project, audit log, retention sweep); operators only |
| `OUO_RETENTION_LOGS`, `_TRACES`, `_METRICS`, `_REPLAYS` | `--retention logs=720h,...` (defaults 720h, 336h, 2160h, 720h) | retention per signal: Loki, Tempo, Mimir, rum-api replays ([data lifecycle](../../docs/operations/data-lifecycle.md)) |
| `OUO_BACKEND_OTLP_HEADERS` | installer, from the project credential | `Authorization=Basic%20<base64>`: what the demo backend and rum-api use for their own OTLP |
| `OUO_GRAFANA_ADMIN_PASSWORD` | installer, random | Grafana `admin` password |
| `OUO_INSTALL_MODE` | `--images` / `--build` (default `build`) | which compose files the installer and `ouo.service` use |
| `OUO_ALLOWED_ORIGINS` | `--allowed-origins` | browser origins allowed by the collector's CORS |
| `OUO_SENTRY_PUBLIC_KEY` | installer, random (new installs) | Sentry DSN key of the bridge; public |
| `OUO_RUM_API_VERSION`, `OUO_COLLECTOR_VERSION`, `OUO_GRAFANA_VERSION`, `OUO_IMAGE_REGISTRY` | `--image-version`, `--registry` (optional) | pin the released images; unset means the pins of the checked-out `compose.images.yaml` |
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

Check from outside: `nmap -p 3000,4318,4319,4320,8080 <vm>` must show them closed/filtered;
`curl -si -X POST https://otel.ouo.example.com/v1/traces` must answer `401` (the collector
is reachable and asks for the credential).

## Where data lives

| Data | Location | Notes |
|---|---|---|
| traces, logs, metrics | named volumes `ouo_tempo-data`, `ouo_loki-data`, `ouo_mimir-data` | `docker volume inspect` for the host path (under `/var/lib/docker/volumes`) |
| Grafana state (users, settings) | `ouo_grafana-data` | dashboards and datasources are provisioned from the repo |
| replay chunks | bind mount `/opt/ouo/deploy/data/rum-api/replays/<session_id>/` | gitignored; one `meta.json` per session records `project_id` |
| certificates, ACME account, internal CA | `ouo_caddy-data` | losing it only means re-issuing certificates |
| configuration and secrets | `/opt/ouo/deploy/compose/.env`, `/opt/ouo/deploy/compose/projects.htpasswd` | back these up with the data; neither is in git |

Retention is set per signal in `.env` (`OUO_RETENTION_*`, `--retention` on install):
Loki, Tempo and Mimir delete expired data in their compactors, rum-api's sweeper deletes
expired replays hourly. Per-project log retention lives in `deploy/compose/loki/runtime.yaml`,
per-project replay retention in `deploy/compose/rum-api/config.yaml` (`projects:`). Delete by
user or project and the audit log: [data lifecycle](../../docs/operations/data-lifecycle.md).
Disk still grows with ingest up to the retention: watch `df -h /var/lib/docker` and
`du -sh /opt/ouo/deploy/data`.

## Operate

```bash
sudo systemctl status ouo                                                             # active (exited) = up -d succeeded
grep ExecStart /etc/systemd/system/ouo.service                                        # the compose files of this install (add compose.images.yaml after compose.yaml with --images)
cd /opt/ouo && sudo docker compose -f deploy/compose/compose.yaml -f deploy/vm/compose.tls.yaml ps
cd /opt/ouo && sudo docker compose -f deploy/compose/compose.yaml -f deploy/vm/compose.tls.yaml logs -f caddy otel-collector rum-api
cd /opt/ouo && sudo deploy/scripts/wait-ready.sh                                     # loopback readiness: collector health + 4318/4319, rum-api /readyz
cd /opt/ouo && sudo deploy/scripts/smoke.sh                                          # round trip on the loopback ports
cd /opt/ouo && sudo OUO_OTLP_URL=https://otel.ouo.example.com OUO_REPLAY_URL=https://otel.ouo.example.com deploy/scripts/smoke.sh   # through Caddy, as an SDK would
```

With `--tls-internal` the VM itself does not trust Caddy's CA, so the smoke test through
Caddy fails with `000` until curl gets a bundle that includes it:

```bash
cd /opt/ouo && sudo docker compose -f deploy/compose/compose.yaml -f deploy/vm/compose.tls.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt /tmp/ouo-root.crt
cat /etc/ssl/certs/ca-certificates.crt /tmp/ouo-root.crt > /tmp/ouo-bundle.pem
sudo CURL_CA_BUNDLE=/tmp/ouo-bundle.pem OUO_OTLP_URL=https://otel.ouo.example.com OUO_REPLAY_URL=https://otel.ouo.example.com deploy/scripts/smoke.sh
```

From another machine: `curl --cacert ouo-root.crt https://otel.<domain>/v1/traces ...`;
Node (`deploy/scripts/e2e.sh`) takes `NODE_EXTRA_CA_CERTS=ouo-root.crt` and
`OUO_GRAFANA_URL=https://<domain>` (rum-api builds its trace links on the public URL).
Run `git` in `/opt/ouo` with `sudo`: the checkout is root's, and git refuses it to other
users (`detected dubious ownership`).

With `--allowed-origins` set, `http://localhost:5173` (the smoke test's default origin) is no
longer allowed and the CORS check fails; pass one of your origins: `sudo
OUO_SMOKE_ORIGIN=https://shop.example.com deploy/scripts/smoke.sh`.

`smoke.sh` reads the project credential from `.env`, posts to the collector and checks
Tempo, Loki, Mimir and the replay store (via rum-api on loopback). The negative checks
(401 without or with a wrong credential, 401 on the internal replay sink without the
ingest token) prove the edge rules; run it against the public hostname to prove them
through Caddy.

## Upgrade

Re-run the installer with the target ref; tokens, the project registry, passwords and
data are kept (`docs/operations/upgrade.md` has the full procedure, the one-time step from
0.2.0, and the rehearsal):

```bash
sudo /opt/ouo/deploy/vm/install.sh --ref <tag or main>            # add --images for the released images
```

It fetches, checks out, rebuilds the plugin and images (the collector distribution
included) or pulls the released ones, and re-applies `up -d`, which recreates only changed
containers. A re-run without `--ref` never moves the checkout. **From 0.2.0** run the new
installer once (`sudo git -C /opt/ouo show origin/main:deploy/vm/install.sh > /tmp/install.sh
&& sudo bash /tmp/install.sh --images --ref main`): the 0.2.0 script stops at
`deploy/docker/compose.yaml: no such file or directory`, the new one moves `.env` and
`projects.htpasswd` from `deploy/docker/` to `deploy/compose/`. Image tags for
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
sudo cp /opt/ouo/deploy/compose/.env /backup/ouo.env
sudo cp /opt/ouo/deploy/compose/projects.htpasswd /backup/ouo.projects.htpasswd
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
  `deploy/compose/collector/config.yaml`.
- Replays missing while traces arrive: `docker compose ... logs otel-collector | grep -i
  replay` and `logs rum-api`. The exporter needs `OUO_INGEST_TOKEN` to be identical on the
  collector and on rum-api (both come from `.env`); a mismatch is a `401` in rum-api's log.
- Plugin missing in Grafana: `ls /opt/ouo/plugins/ouo11y-rum-app/dist` must contain
  `module.js`; re-run the installer or `docker compose ... restart grafana` after a build.
- Grafana restarts with `plugin not installed: "ouo11y-rum-app"` (images mode): the
  `grafana-data` volume hides the image's plugin. `compose.images.yaml`'s `grafana-plugin`
  service copies it before Grafana starts; check `docker logs ouo-grafana-plugin-1`
  (`ouo11y-rum-app <version> installed`). A checkout older than that service needs the
  installer from `main`.
- rum-api restarts with `mkdir /data/replays: permission denied`: `deploy/data/rum-api` is
  owned by root; `sudo chown -R 65532:65532 /opt/ouo/deploy/data/rum-api` (the installer does
  this since 2026-10-23).
- rum-api restarts with `replay store written by a newer replay schema`: a rum-api older than
  the one that last opened the store; run that version or newer (`docs/operations/upgrade.md`
  section 4). Do not delete `replays/schema.json` to force it.
- `install.sh: ghcr.io refused the pull`: `sudo docker logout ghcr.io` (an expired root login; see "Released images").

## Trying it on a laptop VM

The install was run end to end on 2026-10-23 on a fresh Ubuntu 24.04 VM on an Apple-silicon
Mac with [Lima](https://lima-vm.io) (`brew install lima`; chosen because it boots the Ubuntu
cloud image under Apple's Virtualization framework in under a minute, has a host-reachable
network (`vzNAT`), and is scriptable without a GUI). Any Ubuntu 24.04 VM works the same.

```yaml
# ouo-vm.yaml: limactl create --name ouo-vm ouo-vm.yaml && limactl start ouo-vm
base: template:ubuntu-24.04
cpus: 4
memory: 5GiB
disk: 30GiB
networks: [{ vzNAT: true }]      # the VM gets an address the Mac reaches (limactl shell ouo-vm ip -4 a show lima0)
mounts: []                       # a clean VM: nothing of the Mac's home inside
portForwards: [{ guestPortRange: [1, 65535], ignore: true }]   # keep 80/443 off the Mac's localhost
```

Then inside the VM (`limactl shell ouo-vm`) clone and install as above with
`--domain ouo.<ip with dashes>.nip.io`, and from the Mac copy Caddy's root
(`limactl copy`) and `curl --cacert` the two hostnames. Delete it with
`limactl delete -f ouo-vm`.
