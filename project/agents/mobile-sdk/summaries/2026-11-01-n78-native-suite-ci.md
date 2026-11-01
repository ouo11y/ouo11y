# N78: the native iOS suite in CI (2026-11-01)

Branch `claude/n78-native-suite-ci` (cut from `origin/main` at 7f2e315). Checklist N78.

## What was done

- **Job `ios-native`** in `.github/workflows/ci.yml`, on the Mac runner (`[self-hosted, macOS]`), 50 min timeout: checkout, `actions/setup-node` (Node 24; the runner's `PATH` has none), `tests/e2e/mobile-native/ci.sh`, its stack logs on failure, and `ci.sh down` in an `always()` step.
- **When it runs:** the `changes` job's new flag `ios-native`: `sdk/ios/`, `examples/ouo-ios/`, `tests/e2e/mobile-native/`, `tests/e2e/lib.mjs`, and every PR that changes `ci.yml` (as for every job). On a push to main it is the one job that looks at the pushed files (`gh api .../compare/<before>...<sha>`): it holds the one Mac runner for 15 to 20 minutes, and the PR already ran it.
- **`tests/e2e/mobile-native/ci.sh`** (`all` | `down` | `logs`): a Lima VM of the user that runs it (`ouo-ci`, `template:docker`, 4 CPUs, 6 GiB) holds the stack, built from the checkout with `compose.yaml` plus the new `stack.compose.yaml` (rum-api data in a named volume, Grafana with the datasources only: the home mount is read-only). Host ports 29000..29099 (`OUO_NATIVE_PORT_BASE`), URLs from `.github/scripts/stack-env.sh`; a new simulator (newest iOS runtime, iPhone 18 Pro); `run.sh - <udid>`; on exit the simulator is deleted by UDID and the stack (`down -v`) and the VM stopped. The VM is kept for its cache and recreated when its `limactl create` arguments change.
- **`run.sh`** takes `-` instead of an env name: the stack's URLs from the environment, the collector container from `OUO_NATIVE_COLLECTOR`. With an env name it works as before.
- Docs: the suite's README (CI section, the two new files), `docs/specs/mobile-sdk.md` (matrix note and the suite paragraph), `check.mjs` prints "maturity (native iOS suite)", kb `ci-runners.md` (new section), checklist N78.

## Why a VM

The brief assumed the Mac runner has Docker; its user does not. `ouo-runner` cannot open the founder's Docker Desktop socket (home `drwxr-x--- staff`, socket owner-only), and opening it would let any job bind-mount the founder's home. Other options weighed: the app on the Mac pointed at a Linux runner's stack (no network path between them without new secrets or exposing the stack), and recording the wire traffic on the Mac to replay it into a stack on Linux (changes what the suite proves, splits `check.mjs` and `pixels.swift` across machines). Lima needs nothing installed or granted: `limactl` is in Homebrew, the VM lives in `ouo-runner`'s home.

## Verified, and how

- **Lima on the runner:** a throwaway push-only workflow on branch `claude/n78-probe` (run 41307925574, deleted after): `ouo-runner` created and started a VZ VM under the LaunchDaemon (148 s cold start), `docker` and `docker compose` worked through the forwarded socket, published ports answered on the Mac's loopback, the VM was deleted.
- **The job's script locally**, bounded with `perl -e 'alarm 3600; exec @ARGV'`, on VM `n78-ci`, port base 29200, its own output folder: a cold run (VM created, images pulled and built) took about 14 minutes and passed 18 of 18 checks (C1.1 to C11.2, every capability L2); at exit the simulator was gone (`simctl list`), the stack removed with its volumes and the VM stopped. A second run after changing the port-forward rules recreated the VM as designed (about 17 minutes, cold again) and passed 18 of 18 on an iPhone 18 Pro, iOS 27.0; during it a container publishing 28998 and 29298 answered on the Mac's loopback only on 29298, and Lima forwarded no UDP port. Both runs: simulator deleted, stack removed, VM stopped at exit.
- **In CI:** see the PR's `ios native conformance` check.

## What the next session must know

- Running the suite by hand on an env still works (`run.sh <env> <udid>`). To run what CI runs: `OUO_NATIVE_VM=<you>-ci OUO_NATIVE_PORT_BASE=29200 OUO_NATIVE_OUT=<own folder> tests/e2e/mobile-native/ci.sh`, then `limactl delete <you>-ci`.
- The VM's disk is not pruned (kb `ci-runners.md`). Stack-only changes (collector, rum-api, compose) do not trigger the job, to keep the Mac free; a change there that breaks the native suite shows on the next `sdk/ios` PR.
- On 2026-11-01 another session wrote the same scratch folder (`scratchpad/native`, `native-run.log`): my first local run was stopped (my own PIDs) and its lines mixed into that session's log, including an `exit 130` line that was mine. Use a folder of your own.
