# CI on GitHub-hosted runners (since 2026-11-15)

Question: where does each GitHub Actions job of `ouo11y/ouo11y` run now that the repository is public, and what did the move change? (2026-11-15)

## What runs where

Every job runs on a GitHub-hosted runner. Hosted minutes are free for a public repository, macOS included.

| Runner | Jobs |
|---|---|
| `ubuntu-latest` | `ci.yml`: changed paths, PR title, quickstart, go, collector, images (build + Trivy), node, examples (full stack), android, links, helm. `security.yml`, `release-check.yml`, `release-please.yml`, `release-images.yml`, `release-plugin.yml`, `release-chart.yml`, `release-npm.yml`, `browser-soak.yml`, `release-ios.yml` mirror |
| `macos-latest` | `ci.yml` swift, `release-ios.yml` test, `benchmark.yml` (all triggers) |

## Why not the self-hosted runners

- The org runner group `Default` must have `allows_public_repositories: false`. The founder set it to true for a few hours on 2026-11-15 so queued PRs could run, and it is set back to false right after this move merges (a merge step in PR #198). Check it with `gh api orgs/ouo11y/actions/runner-groups --jq '.runner_groups[] | {name, allows_public_repositories}'`. Why it matters: a self-hosted runner runs whatever a pull request's workflow says, and the runners are not ephemeral (a job can rewrite the runner's files). With the repo public, a fork pull request could otherwise run code on the Hetzner server or the founder's Mac.
- The server's eight runners and the Mac runner `ouo11y-mac-1` still exist and are registered to the org. How they were built: [ci-runners.md](../../../kb-archive/ci-runners.md). Their setup script `.github/scripts/setup-mac-runner.sh` was removed from the tree (it is in git history).

## What the move dropped

- Per-runner port sets: `.github/scripts/stack-env.sh` now only honours `OUO_*_PORT` when set and otherwise prints compose's default ports; each hosted job has its own VM, so stacks never collide.
- Rootless Docker: the Trivy step mounts `/var/run/docker.sock` directly.
- `lychee` is no longer preinstalled: the `links` job downloads the pinned release binary and checks its sha256.
- `android` moved from the Mac to `ubuntu-latest`, which ships the Android SDK (`ANDROID_HOME`) and JDK 17.
- `release-chart.yml` no longer moves Helm's config to `$RUNNER_TEMP` (that was for the runner users' unwritable `~/.config`).
- The free-disk-space steps in `examples` and `release-check` now always run (they were skipped on self-hosted).

## Fork pull requests

- Workflows triggered by `pull_request` from a fork get a read-only `GITHUB_TOKEN`, no secrets and no OIDC token, whatever `permissions:` says. No workflow uses `pull_request_target` or `workflow_run`.
- Publishing steps are gated on tag pushes: `release-npm.yml` publishes (OIDC) only when `github.event_name == 'push'`, and its only push trigger is `browser-v*`, `react-native-v*`, `kit-v*` tags. The same holds for `release-images`, `release-plugin`, `release-chart` and `release-ios`; their `pull_request` runs are dry runs.

## Job times

See the PR that made the move (`ci: move every job to GitHub-hosted runners`) for the per-job comparison with the last self-hosted run on `main`.
