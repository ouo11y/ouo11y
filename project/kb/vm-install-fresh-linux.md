# VM install on a fresh Linux host

Status: filled by platform-infra on 2026-10-23 (roadmap 8a, checklist "8a VM install run").
Verified on Ubuntu 24.04.5 LTS (aarch64 cloud image) under Lima 2.2.1 (`vz`, `vzNAT`) on an
Apple-silicon Mac; Docker 28 from Ubuntu's `docker.io`, Compose 2.40.3 (`docker-compose-v2`).

## Question

What breaks when `deploy/vm/install.sh` runs on a real Linux VM instead of Docker Desktop on a
Mac, and how do we test that locally?

## Findings

- **Bind-mount ownership.** rum-api is distroless `nonroot` (uid 65532). Docker creates a
  missing bind-mount source (`deploy/data/rum-api`) as `root:root 755`, so rum-api exits with
  `replay store: create /data/replays: mkdir /data/replays: permission denied` and
  `wait-ready.sh` times out on `/readyz -> 000`. Docker Desktop's file sharing ignores
  ownership, so this never shows on a Mac. Fix: `chown -R 65532:65532 deploy/data/rum-api`
  before `up` (install.sh does it).
- **Named volume over a baked-in plugin.** `compose.images.yaml` mounts `grafana-data` at
  `/var/lib/grafana` and the ouo Grafana image keeps the plugin in `/var/lib/grafana/plugins`.
  Docker copies image content into a volume only when the volume is empty, so the plugin of the
  first install stays forever; 0.2.0 -> 0.3.0 (id `ouo-rum-app` -> `ouo11y-rum-app`) crash-loops
  with `app provisioning error: plugin not installed: "ouo11y-rum-app"`. The Helm chart already
  copies the plugin in an init container; compose now has a one-shot `grafana-plugin` service
  (`depends_on: condition: service_completed_successfully`). A bind-mount run (build mode) also
  leaves an empty `plugins/ouo11y-rum-app` mount point in the volume.
- **systemd unit vs install mode.** `ouo.service` hard-coded the build-mode compose files, and
  `systemctl enable --now` after an `--images` install re-ran `up -d` without
  `compose.images.yaml`: Compose then built the collector and rum-api from source (10 minutes)
  and replaced the ouo Grafana image with stock Grafana. The installer now rewrites the
  ExecStart / ExecStop lines for the mode, whatever template the checkout carries.
- `enable` without `--now` leaves `systemctl status ouo` at `inactive (dead)` although the
  stack runs; start it (a no-op on re-runs, unlike `restart`, which runs `compose down`).
- `docker-compose-v2` without `docker-buildx` warns "Compose is configured to build using Bake,
  but buildx isn't installed" and falls back to the classic builder; install both.
- Private registry and `sudo`: `docker login` as the normal user is invisible to the installer
  and the unit, which pull as root. `sudo docker login ghcr.io`.
- Git as non-root in `/opt/ouo` (root's checkout): `fatal: detected dubious ownership`. Use
  `sudo git`.
- Re-running the 0.2.0 installer with `--ref` of 0.3.0 checks out 0.3.0 and then fails with
  `open /opt/ouo/deploy/docker/compose.yaml: no such file or directory` (ADR-0010 layout move);
  the stack keeps running. The gitignored `deploy/docker/.env` and `projects.htpasswd` survive
  the checkout and can be moved.
- Handing over to the checked-out installer must not pass new flags: the 0.2.0 / 0.3.0 scripts
  exit 2 on an unknown option. Use an environment variable as the guard, and hand over only to
  an installer that knows the protocol.
- A re-run without `--ref` used to move the checkout to `main` (surprising after a tag install).
- Caddy `tls internal`: the VM does not trust its own CA, so `smoke.sh` through the public
  name fails with `000` until curl gets a bundle (`CURL_CA_BUNDLE=<system bundle + root.crt>`);
  Node needs `NODE_EXTRA_CA_CERTS`. `e2e.sh` must get `OUO_GRAFANA_URL=https://<domain>` since
  rum-api builds trace links on the public URL.
- The VM override did not publish or route the Sentry bridge (4320); Caddy now sends `/api/*`
  to it. The bridge stamps `ouo.project.id=demo` from `deploy/compose/collector/config.yaml`.

## Local test recipe

Lima (`brew install lima`), template `ubuntu-24.04`, `networks: [{vzNAT: true}]` for an
address the Mac reaches, `portForwards: [{guestPortRange: [1, 65535], ignore: true}]` so the
VM's 80/443 do not collide with a proxy on the Mac, and only the mounts the test needs. Names:
`ouo.<ip-with-dashes>.nip.io` resolves to the VM everywhere without `/etc/hosts`. Getting
images into a VM without moving a registry credential:
`docker save --platform linux/arm64 <img> | limactl shell <vm> -- sudo docker load`.
Install timings on 4 vCPU / 5 GiB: build mode about 10 minutes (ocb), images mode under a minute.
