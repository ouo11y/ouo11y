# 2026-11-15: CI on GitHub-hosted runners for the public repo

Session `public-flip-ci`, branch `claude/public-flip-ci-046261`, PR #198.

## What was done

- The repo went public on 2026-11-15. Every job in `.github/workflows/*.yml` moved from `[self-hosted, Linux]` / `[self-hosted, macOS]` to `ubuntu-latest` / `macos-latest` (free for public repos). `android` moved from the Mac to `ubuntu-latest` (Android SDK and JDK 17 preinstalled). `benchmark.yml` runs on `macos-latest` for every trigger.
- Dropped what only the self-hosted setup needed: per-runner ports in `.github/scripts/stack-env.sh`, the rootless socket in the Trivy step, Helm's home folders in `release-chart.yml`, the `github-hosted` guards on the free-disk steps, the Homebrew `PATH` and simulator comments in `benchmark.yml`, `.github/scripts/setup-mac-runner.sh`. `lychee` is downloaded in the `links` job (0.24.2, sha256 checked).
- `sdk/ios/test.sh` matched only `Xcode.app`; GitHub's runners have `Xcode_26.6.app`, so it took the Command Line Tools branch. Pattern is now `*/Xcode*.app/*`.
- `InteractionTests.TapRecords` was racy: its taps-off Core shared the first Core's folder and could recover and send the first Core's spooled tap (2 taps instead of 1 on the hosted Mac). The second Core now has its own folder and the same sink.
- `.github/SECURITY.md`: private vulnerability reporting no longer says "once public"; provenance line updated. Contact set to security@ouo11y.com (founder, 2026-11-15).
- Docs: `docs/releasing.md` runners paragraph, `AGENTS.md` processes line, kb entry [`project/kb/ci/runners/github-hosted.md`](../../../kb/ci/runners/github-hosted.md), superseded note on `project/kb-archive/ci-runners.md`.
- No new dependency.

## Settings (founder, 2026-11-15)

- The founder first asked to set the org runner group `Default` to `allows_public_repositories: true` (done with `gh api`), then chose GitHub-hosted runners. Once #198 is merged, set it back to `false` so fork PRs can never land on the Hetzner server or the Mac.
- Fork PR approval set to `all_external_contributors` (was `first_time_contributors`).
- Still to apply by the founder: a ruleset on `main` (no protection today), private vulnerability reporting (off), Dependabot alerts (off). `can_approve_pull_request_reviews` is on (release-please only needs create).

## Fork-PR safety

No `pull_request_target` or `workflow_run`. Fork PRs get a read-only token, no secrets, no OIDC. Every publish step (npm OIDC, GHCR push, releases, mirror push) runs only on a tag push (`DRY_RUN` is true for every other event).

## Verified

`actionlint` clean, `lychee --offline` clean, `swift test --filter InteractionTests` locally, and the hosted run on PR #198 (timings in the PR body).

## Content found for the founder

Listed with file:line in the side-session notes (`public-flip-ci-findings.md`), not in this repo: a named client in about 20 files and in history, the business-model sections of `docs/VISION.md` (29-38, appendices Q-S), prospect and pitch lines in the trackers. No real secret in the tree.
