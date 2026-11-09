# ADR-0010 Repository layout: product by component at the top, process material under `project/`

Status: accepted (2026-10-17, approved by the founder). Number 0010 because 0009 is taken by the org and product naming proposal (PR #27).

## Context

By 2026-10-17 the root of the repository mixed two kinds of content:

- **Product**: `sdk/`, `collector/`, `services/`, `plugins/`, `deploy/`, `examples/`, `tests/`, `docs/`.
- **Process**: `agents/` (173 files of agent folders, summaries and HTML verification reports), `kb/`, `tracker/` and `reports/`, all written by and for the agents that build ouo.

A reader opening the repository saw four folders of process material next to the product and could not tell which was which. The release documentation was split between a root `RELEASING.md` and `docs/releasing.md`, each pointing at the other. The compose stack lived in `deploy/docker`, named after the tool rather than the deployment mode, next to `deploy/helm` and `deploy/vm`. Nothing checked that the many relative links between documents still resolved.

Roadmap backlog item B5 proposed a layout; the founder approved it on 2026-10-17 and asked for it to be done while no other session writes to the repository, before batches 1 to 3 of `project/tracker/checklist.md` start.

## Decision

1. **Product code by component at the top level.** Each component keeps its own README and, where it is released, its own CHANGELOG:

   ```
   sdk/{browser,react-native,ios}
   collector/
   services/rum-api/
   plugins/ouo11y-rum-app/
   deploy/{compose,helm,vm,envs,images,scripts}
   examples/
   tests/
   ```

   `deploy/docker` is renamed `deploy/compose` (the local and single-VM compose stack), so `deploy/` names deployment modes: `compose`, `helm`, `vm`, plus `envs` for the named local environments of B2 (`ouo-env`, added right after this move). `deploy/images` (Dockerfiles that are not a component's own) and `deploy/scripts` (wait-ready, smoke, e2e) stay where they are.

2. **All user-facing documentation lives under `docs/`**: vision, MVP scope, specs, ADRs, operations, releasing. The root `RELEASING.md` is merged into `docs/releasing.md`, which is now the only releasing document. Component READMEs stay next to their code. `examples/fast-tracked/` stays with the examples it walks through.

3. **All agent and process material moves under `project/`**: `project/agents/`, `project/kb-archive/`, `project/tracker/`, `project/reports/`. The name `project/` was chosen because it says what the content is about — how the project is run (who works on what, what is known, what is open, what was verified) — without implying it is internal, secret or generated. Alternatives rejected: `.project/` or `.agents/` (hidden folders are skipped by editors, `ls` and GitHub's file finder, and the trackers are read by the founder), `meta/` (vague), `internal/` (has a compiler meaning in Go), `ops/` (confused with operations docs for users), `agents/` holding `kb/` and `tracker/` (the knowledge base and trackers are not owned by any one agent).

4. **The root keeps only** `README.md` (with a map of the layout), `AGENTS.md`, `LICENSE`, `CHANGELOG.md`, the npm workspace files (`package.json`, `package-lock.json`), `.gitignore` and `.github/`. A new top-level folder or file needs an ADR.

5. **The move is mechanical and history-preserving.** Every file is moved with `git mv` in one pull request with no content changes besides path references. Every reference is updated in the same pull request: `AGENTS.md`, every `index.md`, workflow paths, compose files, scripts, Helm comments, code comments, docs and examples. Relative links are recomputed from each file's old location, so a link that resolved before still resolves after.

6. **Links are checked in CI.** A `links` job runs lychee in offline mode over every tracked Markdown and HTML file; a broken relative link fails the pull request. External URLs are not checked (offline), so the job is fast and never flaky.

## Consequences

- Paths that agents and the founder type change: `tracker/checklist.md` is now `project/tracker/checklist.md`, `kb/<topic>.md` is `project/kb-archive/<topic>.md`, `deploy/docker/compose.yaml` is `deploy/compose/compose.yaml`. AGENTS.md "Read first" lists the new paths.
- Links inside `project/` between `agents/`, `kb/`, `tracker/` and `reports/` did not change, because the four folders moved together.
- The compose project name is set by `name:` in the compose file, not by its folder, so running stacks keep their project names and volumes across the rename.
- Open branches written against the old layout conflict on every moved file. This is why the move runs alone (batch 0); branches still open afterwards are rebased with `git rebase` (rename detection carries their edits to the new paths).
- Folder names contain no product or org name besides `plugins/ouo11y-rum-app`, so the org rename decided in ADR-0009 stays a mechanical search and replace on package names, image refs and that one folder.
- `git log --follow` works for every moved file.
