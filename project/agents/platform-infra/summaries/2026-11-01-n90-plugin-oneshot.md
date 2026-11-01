# 2026-11-01: N90, the grafana-plugin one-shot leaves an unchanged plugin alone (and N91)

## Problem

`deploy/compose/compose.images.yaml`'s one-shot `grafana-plugin` (the copy of the plugin out of
the Grafana image onto the `grafana-data` volume) ran `rm -rf` + `cp -a` on every start. Compose
starts it again on every `up -d`, also when only another pin changed and Grafana keeps running,
so the plugin folder vanished and came back under a live Grafana. Seen in the M2/M3 upgrade
rehearsal at the rum-api step (`project/agents/release/summaries/2026-11-01-qa-upgrade-m2-m3.md`).

## Fix

The one-shot copies only when `diff -r` finds the volume's plugin differs from the image's; it
logs `ouo11y-rum-app <version> already installed` otherwise. Chosen over a version comparison
(a rebuilt image with the same version would not be copied) and over an atomic swap alone (it
would still replace the folder under Grafana on every `up -d`). When the plugin does differ the
Grafana image changed: compose then stops the old Grafana container before the one-shot runs and
starts the new one after it exits (seen by the reviewer), so no Grafana runs during the copy.
`diff` is the busybox one in the Alpine-based grafana image; it exits 0 on a file it cannot
read and prints nothing (exit 1) for a directory only in the destination, so the test needs
both a zero exit and no output (review of #149).

Same path everywhere it runs: `ouo-env up --images` and `deploy/vm/install.sh --images` both use
`compose.images.yaml`; the source build bind-mounts `plugins/ouo11y-rum-app/dist` and has no
one-shot. Not changed:
- Helm's `install-plugin` init container runs before Grafana in the same pod, and the
  Deployment is `Recreate`, so no Grafana runs while it copies.
- `deploy/compose/quickstart.yaml` (written by `gen-quickstart.sh`) keeps the old command
  until the next grafana release: `--check` compares it with `compose.images.yaml` at the
  `grafana-v*` tag and will fail on `grafana-plugin.command` from that tag on. Copy the
  command into the script then (`project/kb/compose-quickstart.md`).

N91, in the same PR: `@types/node` `^24.0.0` in `examples/ouo-web` devDependencies (and the root
lockfile), so a copy of the example outside the workspace builds.

## Verified

Env `n90-plugin-oneshot` (`ouo-env up --images`, pins in this worktree's `deploy/compose/.env`),
plugin folder read with `stat` from an `alpine` container on the volume:

| Step | One-shot log | Plugin folder | Grafana |
|---|---|---|---|
| up: rum-api 0.5.0, grafana 0.5.0 | `0.9.0 already installed` (Docker seeded the new volume from the image) | inode 1671236, 0.9.0 | 5b1b26e1e3a7 |
| only rum-api -> 0.6.0, `up` | one-shot ran again: `0.9.0 already installed` | inode, ctime and tree hash unchanged | same container, not restarted |
| contrast: the old command run by hand | | new inodes (1671238): the folder was replaced | |
| grafana -> 0.6.0, `up` | `0.10.0 installed` | 0.10.0, new tree hash | recreated, serves 0.10.0 |
| `plugin.json` deleted, `up` | `0.10.0 installed` | repaired | serves 0.10.0 |

After the review's hardening (`out=$(diff -r ...) && [ -z "$out" ]`), the rendered command run
under `sh -ec` in `grafana:0.6.0` on a throwaway volume chowned to uid 472 (a bare volume is
root-owned; in a real `up` Docker seeds it from the grafana container first): copy on first run,
then `already installed`; `installed` for a `root:root 0600` file, an extra file, an extra empty
directory and an extra `n/plugin.json` in the destination.

`gen-quickstart.sh --check`: up to date. N91: `examples/ouo-web` copied outside the repo,
`npm install` and `npm run build` pass.

## Left

The env was torn down (`ouo-env down n90-plugin-oneshot`, volumes kept; `gc` removes it after
the merge).
