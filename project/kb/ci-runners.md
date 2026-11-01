# CI runners: one user and one rootless dockerd per runner

Question: how are the self-hosted GitHub Actions runners on the `ouo11y` server laid out, and how do two jobs that start the full stack run at the same time? (2026-10-25)

## Layout

- Server `ouo11y` (Hetzner, Ubuntu 26.04, 8 cores, 62 GB, 900 GB). Eight org runners `ouo11y-1`..`8`, labels `self-hosted,Linux,X64`, in `/opt/actions-runner-N` (mode 0700), systemd units `actions.runner.ouo11y.ouo11y-N.service`.
- Runner N runs as its own user `runner-N` (nologin shell, home 0700, own `/etc/subuid` + `/etc/subgid` range of 65536 from `useradd`, linger on). It has its own rootless dockerd: a `systemctl --user` unit (`~/.config/systemd/user/docker.service`, `dockerd-rootless.sh`, slirp4netns, MTU 65520) at `/run/user/<uid>/docker.sock`.
- The runner's `.env` sets `DOCKER_HOST`, `XDG_RUNTIME_DIR`, `DOCKER_CONFIG=/opt/actions-runner-N/.docker` (logins and the buildx builder), the two job hooks, and the runner's host port set.
- Hooks, in `/opt/runner-hooks` (root-owned):
  - `job-started.sh`: removes every container, volume and network in the runner's daemon (a cancelled job's leftovers), then chowns the workspace back through a busybox container.
  - `job-completed.sh`: removes every container, volume and network again. Images stay, as the cache.
- `runner-prune@N.timer` (daily) runs `prune.sh` as `runner-N`: images and build cache unused for 168 h.
- `/opt/runner-admin/migrate.sh N [--ports]` (root only) builds all of the above for one runner. It refuses to run while a `Runner.Worker` is in the unit's cgroup.

## Parallel stacks: a port set per runner

Separate daemons do not separate host ports. rootlesskit forwards each published port onto the host's network namespace, so two `deploy/compose` stacks on default ports still collide on 3000, 4318 and so on. So each runner's `.env` gives it its own `OUO_*_PORT` set, `20N00`..`20N91` for runner N:

| var | port | var | port |
|---|---|---|---|
| OUO_GRAFANA_PORT | 20N00 | OUO_SENTRY_PORT | 20N20 |
| OUO_LOKI_PORT | 20N01 | OUO_COLLECTOR_HEALTH_PORT | 20N33 |
| OUO_TEMPO_PORT | 20N02 | OUO_RUM_API_PORT | 20N80 |
| OUO_MIMIR_PORT | 20N09 | OUO_BACKEND_PORT | 20N81 |
| OUO_OTLP_GRPC_PORT | 20N17 | OUO_MINIO_PORT | 20N90 |
| OUO_OTLP_HTTP_PORT | 20N18 | OUO_MINIO_CONSOLE_PORT | 20N91 |
| OUO_REPLAY_PORT | 20N19 | | |

compose takes shell variables over `deploy/compose/.env`, so the stack binds these ports. `.github/scripts/stack-env.sh` turns them into the URLs the scripts read (`OUO_*_URL`, `VITE_*`), and the `examples` and `e2e` jobs append them to `$GITHUB_ENV`. With the ports unset (a laptop, a hosted runner) everything falls back to the defaults.

Things that do **not** need a port each: containers run with `--network host` (the Playwright image) join the daemon's own rootlesskit network namespace, not the host's. So the SDK's Playwright page server (4180/4181) and the ouo-web static server (4173) inside that container are private to the runner. The same namespace sees the stack's published ports on `localhost`.

## Things that were not obvious

- **`wait-ready.sh` and `e2e.sh` source `deploy/compose/.env`** with `set -a`. The `examples` job copies `.env.example`, which pins the default ports, so the scripts would win over the runner's `OUO_*_PORT`. The `OUO_*_URL` variables have priority in those scripts, which is why `stack-env.sh` exports URLs and not only ports.
- **Hard-coded ports in CI steps:** the RN scenario defaults to `OUO_OTLP` 4318 and its replay endpoint is derived as 4318 → 4319. `ci-journey.py` defaults `--bridge` and `--backend`. The `examples` job passes all of them explicitly.
- **Seed the image cache.** Eight cold daemons pull from one IPv4, and Docker Hub limits anonymous pulls per IP. `migrate.sh` loads the Docker Hub base images (`/var/tmp/runner-seed/hub.tar`, saved from the old shared daemon) into each new daemon. Images pinned by digest (Playwright, Trivy) are re-pulled once per daemon from their own registries.
- **AppArmor:** this box has `kernel.apparmor_restrict_unprivileged_userns = 0`, and Ubuntu ships `/etc/apparmor.d/rootlesskit`, so rootlesskit needed no extra profile.
- **`systemctl --user -M runner-N@`** drives a user's manager from root without a login session. `user@<uid>.service` must be running first (linger starts it at boot).
- **Journal timestamps are CEST:** use `journalctl --utc`.
- **Never pattern-kill on the box.** Stop a runner with `systemctl stop actions.runner.ouo11y.ouo11y-N.service`. It waits for runsvc.sh to stop the listener.

## The Mac runner (2026-10-30)

Why: on the free plan a GitHub-hosted macOS minute costs 10 Linux minutes. In October the Linux jobs moved to the server above, but the `swift` job kept billing macOS minutes: $3.72 of the org's $5 Actions budget, which stops hosted jobs when it is reached.

- One org runner `ouo11y-mac-1` on the founder's Mac (Apple silicon, Xcode 27 from `xcode-select`), labels `self-hosted,macOS,ARM64`. Jobs pick it with `runs-on: [self-hosted, macOS]`: the `swift` job in `ci.yml` and `test` in `release-ios.yml`. One job at a time: a perf-harness PR's `bench` holds it for about 35 min, and Swift jobs queue behind it.
- It runs as the hidden user `ouo-runner` (no password, so no login), home `/Users/ouo-runner` mode 0700, runner in `~/actions-runner`. Its primary group is its own `ouo-runner`, **not `staff`**: macOS homes are `drwxr-x--- <user> staff`, so a user created the usual way (`sysadminctl -addUser`, primary group 20) can read every group-readable file in the founder's home, `~/.ssh` included. The setup script checks this and stops if `ouo-runner` can list the founder's home.
- LaunchDaemon `/Library/LaunchDaemons/com.ouo11y.actions-runner.plist` (`UserName ouo-runner`, `run.sh`, `KeepAlive`, `Nice 10`, `LowPriorityIO`): starts at boot without a login, and the founder's apps win the CPU and disk. Logs in `~/actions-runner/_diag/`.
- Different uid from the founder: a job cannot signal or kill the founder's processes, and the founder's simulators stay separate.
- Set up with `sudo bash .github/scripts/setup-mac-runner.sh` (usage line at its top: user, group, runner v2.338.2 with its sha256 checked, registration, daemon); the token comes from `gh api -X POST orgs/ouo11y/actions/runners/registration-token` run as the founder. Re-running it skips what exists.
- Stop or start it: `sudo launchctl bootout system/com.ouo11y.actions-runner`, `sudo launchctl bootstrap system /Library/LaunchDaemons/com.ouo11y.actions-runner.plist`. Remove it: bootout, then `sudo -u ouo-runner -H sh -c 'cd ~/actions-runner && ./config.sh remove --token <token from gh api -X POST orgs/ouo11y/actions/runners/remove-token>'`, delete the plist, `sudo dscl . -delete /Users/ouo-runner`, `sudo dscl . -delete /Groups/ouo-runner`, `sudo rm -rf /Users/ouo-runner`.

Not obvious:

- **When the Mac sleeps or is off, the runner is offline.** iOS jobs wait in the queue (GitHub cancels them after 24 h). There is no automatic fallback to `macos-latest`; to use the hosted runner for one PR, change `runs-on` on the branch.
- **`benchmark.yml` is split.** Its PR smoke run (1 round, 3 cells, no gate; PRs that change the perf harness) runs on the Mac, so those PRs are not blocked when the hosted budget is spent. Tag and manual runs stay on `macos-latest`: they load the simulator for hours, and their numbers need an idle machine. On the Mac the job puts `/opt/homebrew/bin` first in `PATH` (CocoaPods; the runner's own `PATH` has no Homebrew), so the rest of the job also uses the founder's Homebrew `bash`, `python3`, `ruby`, `git` where they exist: a `brew upgrade` can change the smoke run. Kept because it passed and the system Ruby 2.6 for `xcodeproj` is untested and shuts its simulator down at the end. `ouo-runner` has its own CoreSimulator device set, separate from the founder's.
- **Shared loopback ports.** `bench`'s proxy binds 4718/4719/4720/4781 and the backend 8581, for every user on the Mac: a local `bench.sh` run during a CI `bench` makes one of them fail to bind (loudly).
- **The founder's Xcode is CI's Xcode.** Swift and Xcode upgrades on the Mac change CI too (Swift 6.4 here vs 6.3.3 on hosted, 2026-10-30).
- **Nothing prunes the Mac runner yet:** `~/actions-runner/_work`, `ouo-runner`'s simulator devices, CocoaPods and npm caches grow until someone clears them (as `ouo-runner`, or `sudo rm -rf` inside `/Users/ouo-runner`).
- **`release-npm.yml` stays on `ubuntu-latest`**: npm trusted publishing (OIDC) refuses self-hosted runners.
- **Before the repo goes public:** a self-hosted runner runs whatever a pull request's workflow says. Fork PRs cannot exist on a private repo, but once the repo is public they can. Then either require approval for every outside contributor, or gate the macOS (and Linux) jobs on `github.event.pull_request.head.repo.full_name == github.repository`. The Default runner group has `allows_public_repositories: false`, and the runner is not ephemeral (a job can rewrite `~/actions-runner`).

## The native iOS suite on the Mac runner: a Lima VM for the stack (2026-11-01, N78)

Job `ios-native` in `ci.yml` runs `tests/e2e/mobile-native/ci.sh`: the stack built from the checkout, a new simulator, `run.sh`, teardown. Why and how:

- **`ouo-runner` has no Docker.** The Mac's Docker Desktop belongs to the founder: `/var/run/docker.sock` links to `/Users/ziadhassanin/.docker/run/docker.sock`, behind a home that is `drwxr-x--- staff` (and `ouo-runner` is not in `staff`), and the socket is `srwxr-xr-x` (connect needs write). Opening it would also undo the isolation above: Docker Desktop shares `/Users`, so any job could bind-mount the founder's home. Docker Desktop cannot run for a user with no login session.
- **So the job runs its own Linux VM with Lima** (`/opt/homebrew/bin/limactl`, 2.2.1, Homebrew, so a `brew upgrade` changes it): instance `ouo-ci` in `/Users/ouo-runner/.lima`, `template:docker` (Ubuntu, rootless Docker), 4 CPUs, 6 GiB, 60 GiB sparse disk, VZ. A probe on the runner (2026-11-01) showed VZ works for `ouo-runner` under the LaunchDaemon, without a login session; the cold start took 148 s.
- **Ports.** Lima forwards a guest port to the Mac's `127.0.0.1` when something listens on it; the Mac's loopback is shared by every user, so the founder's envs and the job could take each other's ports. `ci.sh` pins the stack to `OUO_*_PORT` = 29000..29099 (the founder's `ouo-env` blocks are 20000+10n) and adds port-forward rules: forward 29000..29099, ignore everything else. Both ignore rules are needed, `guestIP: 127.0.0.1` and `guestIP: 0.0.0.0`, each with `proto: any`: with only the first (TCP default) Lima still forwarded UDP 5353 (mDNS) from `0.0.0.0`, and with only the second, chrony's `127.0.0.1:323`.
- **The VM mounts the home folder read-only** at the same path, so compose's bind mounts of config files work, but nothing can be created there: `tests/e2e/mobile-native/stack.compose.yaml` puts rum-api's replay data in a named volume and gives Grafana only `provisioning/datasources` (provisioning the app plugin without its built `dist/` stops Grafana: "plugin not installed", and building it needs `npm ci`; the suite reads only Tempo through Grafana).
- **The docker CLI** is Docker Desktop's (`/usr/local/bin/docker`, world-executable) pointed at the VM's forwarded socket (`DOCKER_HOST=unix://$HOME/.lima/ouo-ci/sock/docker.sock`). Its `compose` plugin is found through the founder's `~/.docker`, which `ouo-runner` cannot read, so `ci.sh` writes a `DOCKER_CONFIG` with `cliPluginsExtraDirs: ["/Applications/Docker.app/Contents/Resources/cli-plugins"]`. Node is not on the runner's `PATH`: the job uses `actions/setup-node`.
- **Kept, stopped.** The VM is created once and stopped after every run (`ci.sh` traps EXIT; the job's `always()` step runs `ci.sh down` again after a cancel), so its images and build cache stay: the first run on a new VM took about 14 minutes locally (image download, Docker install, image pulls and builds, then the 6-minute suite). `ci.sh` writes its `limactl create` arguments to `~/.lima/<vm>/ouo-create-args` and recreates the VM when they change, since only `ouo-runner` (or root) can delete it by hand.
- **Simulator:** a new one per run (newest iOS runtime, iPhone 18 Pro when the runtime has it), in `ouo-runner`'s own device set, deleted by UDID at the end.
- **Run it locally the same way** with another VM name and port block, so it never collides with a CI run on the same Mac: `OUO_NATIVE_VM=<you>-ci OUO_NATIVE_PORT_BASE=29200 tests/e2e/mobile-native/ci.sh` (bound it with `perl -e 'alarm 3600; exec @ARGV'`), then `limactl delete <you>-ci`. Give it its own `OUO_NATIVE_OUT`: two sessions writing one scratch folder mixed their logs on 2026-11-01.
- **Nothing prunes the VM's disk** either: `limactl shell ouo-ci docker system prune` as `ouo-runner`, or delete the VM (it is recreated on the next run).
