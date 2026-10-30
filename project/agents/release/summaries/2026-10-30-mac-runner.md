# 2026-10-30: the Swift jobs move to a self-hosted Mac runner

## Why

GitHub warned that the org had used 75% of its Actions budget. October billing (`gh api
/organizations/ouo11y/settings/billing/usage/summary`): the free 2,000 minutes went on Oct 22–23,
before the Linux jobs moved to the Hetzner runners. After that, almost all paid usage was the `swift`
job on `macos-latest` (10x minutes): $3.72 of $3.90 net, against a $5 budget that stops hosted
jobs when it is reached.

## What changed

- New org runner `ouo11y-mac-1` on the founder's Mac (labels `self-hosted,macOS,ARM64`), set up
  by `.github/scripts/setup-mac-runner.sh`. It runs as a hidden user `ouo-runner` with its own
  primary group (not `staff`, which can read the founder's home), from a LaunchDaemon at nice 10
  with low-priority I/O.
- `ci.yml` `swift` and `release-ios.yml` `test`: `runs-on: [self-hosted, macOS]`.
- `benchmark.yml`: the PR smoke run goes to the Mac (asked by the mobile SDK orchestrator: with the
  budget spent, every PR touching the perf harness had a red `bench`); tag and dispatch runs stay
  on `macos-latest` (hours of simulator load; numbers need an idle machine). On the Mac it adds
  `/opt/homebrew/bin` to `PATH` for CocoaPods and shuts its simulator down at the end.
  `release-npm.yml` stays hosted (npm OIDC).
- `project/kb/ci-runners.md`: a Mac runner section. `docs/releasing.md`: the minutes paragraph.

## Verified

- Founder ran the setup script: isolation check passed (`ouo-runner`, uid 601, cannot list the
  founder's home), runner tarball sha256 OK, registration OK, LaunchDaemon running.
- `gh api /orgs/ouo11y/actions/runners`: `ouo11y-mac-1 online`; `ps -U ouo-runner`: `run.sh`,
  `Runner.Listener` at nice 10.
- actionlint on the three workflows, shellcheck on the script, `lychee --offline`: clean.
- This PR changes `ci.yml`, so every job runs, `swift` included: its run on `ouo11y-mac-1` is the
  end-to-end check (see the PR's checks).

## Left / next agent

- The Mac sleeping or off means iOS jobs queue (GitHub cancels after 24 h). No hosted fallback.
- Before the repo goes public: gate self-hosted jobs against fork PRs (kb entry says how).
