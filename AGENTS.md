# AGENTS.md

Operating manual for every coding agent (and human) working in this repository.

## What this project is

ouo11y ("ouo" for short) is an OpenTelemetry-native Real User Monitoring platform. This repo is `github.com/ouo11y/ouo11y`. The MVP is defined in `docs/MVP.md`. The long-term vision is in `docs/VISION.md` and is **not** in scope until the MVP is done.

## Names and repos ([ADR-0009](docs/adr-archive/0009-org-and-product-naming.md))

- Published identifiers say `ouo11y`, lowercase: `@ouo11y/browser`, `@ouo11y/react-native`, plugin ID `ouo11y-rum-app`, images `ghcr.io/ouo11y/{collector,grafana,rum-api}`, Go modules `github.com/ouo11y/ouo11y/...`, SwiftPM package `ouo11y-ios`.
- Code keeps the short name `ouo`: the `ouo.` attribute prefix, the `ouosentry` / `ouoreplay` / `ouoratelimit` components, the Swift modules `OuoReplay` / `OuoReplayCore`, `OUO_*` variables, `ouo-env`, the Helm chart `ouo`. Do not rename these.
- Three repos: `ouo11y/ouo11y` (this one, the product), `ouo11y/ouo11y-ios` (read-only mirror of `sdk/ios`, written only by `release-ios.yml`), `ouo11y/company` (always private).
- Business material (pricing, product plan, go-to-market, prospects, pitch kit, contracts, client notes) goes to `ouo11y/company` only, never here, not even in a summary, report or commit message: this repo may be open-sourced, and its history was purged of business material on 2026-10-18 (checklist N21). An engineering file states a business reason in one line and does not link to `company`.

## Read first, every time

1. `project/tracker/checklist.md` — the single sorted work list; `project/tracker/index.md` lists the phase trackers.
2. `project/agents/index.md` — which agents exist and what each owns.
3. `project/kb/index.md` — knowledge already gathered. Do not re-research something that has a kb entry. `project/kb-archive/` is MVP-era knowledge, mostly unreviewed: check anything you take from it.
4. `docs/adr/` — decisions already made. Do not relitigate them; propose a new ADR if one is wrong. `docs/adr-archive/` is the MVP-era record. The archived ADRs linked from this file stay in force until a new ADR replaces them.

## Repository layout

Product at the top, process material under `project/` ([ADR-0010](docs/adr-archive/0010-repository-layout.md)).

```
sdk/                 SDKs: browser, react-native (TypeScript), ios (Swift)
collector/           ouo-collector (ocb distribution) and its components (Go)
services/rum-api/    platform service (Go)
plugins/ouo11y-rum-app/ Grafana app plugin
libs/                generic libraries for client plugins: ouo-go (Go), ouo-kit (@ouo11y/kit); ADR-0025
deploy/              compose/ (local + VM stack), helm/, vm/, envs/ (ouo-env), images/, scripts/
examples/            demo web, mobile, sentry-mobile and backend apps; fast-tracked guides
tests/               end-to-end scenario
docs/                user-facing docs: vision, MVP scope, specs, ADRs, operations, releasing
  adr/               architecture decision records (numbered)
  specs/             normative specs (session lifecycle, replay format, Sentry bridge)
project/             agent and process material (not shipped)
  agents/            one folder per agent or team, indexed by project/agents/index.md
    <agent>/         index.md, tracker.md, summaries/, reports/ (HTML)
  kb/                knowledge base, one file per topic, indexed by project/kb/index.md
  kb-archive/        MVP-era knowledge base
  tracker/           checklist and phase trackers, indexed by project/tracker/index.md
  reports/           cross-cutting HTML reports, indexed by project/reports/index.md
```

The root holds only `README.md`, `AGENTS.md`, `LICENSE`, `CHANGELOG.md` and the npm workspace files. Do not add new top-level folders or files without an ADR. Links between files are checked in CI (job `links`, lychee in offline mode); when you move or link files, run `lychee --offline --no-progress --exclude-path node_modules --exclude-path /dist/ './**/*.md' './**/*.html'` before you push.

## Agent protocol

- Each agent owns a folder under `project/agents/<name>/` containing at minimum `index.md`, `tracker.md`, and a `summaries/` folder. Write a dated summary there at the end of every run: what was done, what was verified and how, what is left, what the next agent must know.
- Each agent is given an explicit list of **allowed paths**. Do not write outside them except your own `project/agents/<name>/`, `project/kb/`, and the index files that list what you added.
- When you learn something reusable (a library quirk, a config that works, a benchmark), write an entry in a descriptive topic folder (`project/kb/<area>/<subject>/<topic>.md`) and add it to that folder's `index.md`. Keep chat-only knowledge out of chat.
- Every folder that holds documents has an `index.md` listing its contents with one line each. Update the index whenever you add a file.
- Reports and graphs are HTML/CSS/JS files (self-contained, no external network needed to render). Never markdown tables or image files for reports.
- Hand-off to the orchestrator is your summary file plus a short final message. The orchestrator does not read your full transcript.

## Review and merge: two sessions, then the author merges ([ADR-0013](docs/adr-archive/0013-session-to-session-review.md))

Nobody waits on a pull request and no bot touches it. A PR is reviewed by a second session, both sessions leave one comment each, and the author session merges. The founder reviews merged work at checkpoints.

- **Push only what you are proud of.** Before `git push`, run this list and fix what fails: the tests and `go vet` / typecheck of every touched module pass locally with the tracker's commands; the conformance or e2e checks of what you touched pass; `lychee --offline` is clean; your summary, kb entries and index rows are written; no test was skipped, weakened or marked flaky to pass; no secret, token or business material is in the diff; the PR title is a conventional commit (`feat(scope): …`, `fix(scope): …`; release-please reads it); you would sign the diff with your name. Not proud yet: do not push. Write what is missing in your summary and leave the branch local.
- **CI is always green.** A red check on your PR is yours to fix before anything else, and a red `main` is fixed forward by the session that broke it, in that session while it runs. Never merge over a failed check, never skip or weaken a test to pass.
- **Get a review from another session.** Start a fresh session (or ask the founder to) with a brief: the PR number, what the change is for, what to test. The reviewer reads the diff and the surrounding code, runs the tests, and tells you directly about every bug and every place the design can be simpler. Talk until you agree; push the fixes.
- **The reviewer pushes for simpler and looks at the whole picture.** Beyond bugs, the reviewer asks of every change: is there a simpler implementation that does the same (fewer concepts, fewer files, fewer options, reuse of what the repo has), does it fit the specs and ADRs and the way the rest of the repository does the same thing, and does it leave the next session a simpler codebase than it found. "Works but could be simpler" is a finding the author answers, by simplifying or by writing down why not.
- **Two comments on the PR, then merge.** The reviewer posts `Review: approve` (or `Review: changes needed`) with its findings and what it verified and how. You post `Author: agreed` with what you changed and what you left as is, with the reason. With both comments and CI green, merge with `.github/scripts/merge-agreed.sh <pr>` (squash, PR title as subject, branch deleted; it refuses on a failed or empty check list). Rebase only your own branch, never someone else's PR, never several at once.
- **Leave no PR behind.** Before your session ends, your PR is merged or closed with a line in your summary saying why. No stale bot will do it for you.
- **Releases happen at checkpoints** (the roadmap milestones, or when the founder says so), through `docs/releasing.md`: the checkpoint session merges the release PRs the same way and pushes the tags only when the founder asks it to.

## Engineering conventions

- TypeScript: npm workspaces at the repo root, strict mode, ESM, Node 24. Tests with Vitest.
- Go: one module per service or example, Go 1.26, standard library HTTP, `go test ./...` must pass. `go vet` clean.
- OpenTelemetry: use OTel SDKs, OTLP, and semantic conventions. Do not invent a parallel telemetry format. Custom attributes are prefixed `ouo.`.
- Telemetry generated by the platform itself (rum-api, demo backend) goes through the same collector.
- Secrets never go in the repo. Local defaults live in `.env.example` files.
- No dependency is added without a one-line justification in the agent summary.
- Do not disable or skip tests to make CI pass.

## Definition of done for a phase

- Code builds and tests pass locally with the commands listed in the phase tracker.
- The acceptance checks listed in `project/tracker/mvp.md` for the phase are verified and the verification method is recorded.
- kb entries written for anything non-obvious.
- Agent summary written, indexes updated, phase tracker updated.
- One pull request per package or phase, cut from `origin/main`; work that needs another package's code waits for that package's merge.

## Running the local stack: `ouo-env` only

Every session runs its stack as a named env (roadmap B2, `deploy/envs/README.md`); no raw `docker compose up` of `deploy/compose` on ad-hoc ports or project names.

```bash
deploy/envs/ouo-env up <env>      # <env>: the branch slug (`deploy/envs/ouo-env slug`), `sbx`, or `main`
deploy/envs/ouo-env ls
deploy/envs/ouo-env down <env>    # no --purge unless asked: volumes are kept
```

- Use the branch slug for your own env (the default when `<env>` is omitted). `main` always runs `origin/main` and is refreshed with `deploy/envs/ouo-env up main` after a merge; `sbx` is the long-lived sandbox. Set `OUO_SESSION` to your session name so `ls` shows who owns an env.
- Give the founder the URL `ouo-env up` prints (`http://grafana.<env>.ouo.localhost`, admin / testing567 in every env), and for device runs the LAN URLs from `ouo-env url <env> --lan` (a phone cannot resolve `*.localhost`).
- Tear your env down with `ouo-env down <env>` when the work is done or the PR merges (`ouo-env gc` catches the rest). Never leave an env running without saying so, with its name and URL, in your summary.
- Smoke-test an env with `eval "$(deploy/envs/ouo-env env <env>)" && deploy/scripts/smoke.sh`.

## Processes on the founder's Mac

Sessions, CI (the self-hosted runner) and the founder's own apps share one machine. Stop only processes you started: keep the PID (`$!`, a PID file) and `kill <pid>`, or use the tool's own stop command (`ouo-env down`, `xcrun simctl shutdown <udid>`, Playwright teardown). Never kill by pattern (`pkill`, `killall`, `pkill -f`, `ps | grep | xargs kill`): `pkill -f "cat"` matches every `/Applications/...` path and closed the founder's apps on 2026-10-24.
