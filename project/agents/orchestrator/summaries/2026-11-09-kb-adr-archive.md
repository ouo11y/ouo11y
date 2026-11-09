# 2026-11-09 archive the MVP kb and ADRs

The MVP knowledge base and ADRs were mostly written by AI without founder review. Post-MVP work starts in fresh folders.

## What was done

- Moved `project/kb` to `project/kb-archive` and `docs/adr` to `docs/adr-archive`.
- Added empty `project/kb/index.md` and `docs/adr/README.md`. ADR numbering continues at 0018.
- Rewrote links and paths that pointed at the old folders. In code and config only comments and one Helm error message changed.
- `AGENTS.md` points agents at the new folders. The archived ADRs it links to stay in force until a new ADR replaces them.

## Verified and how

- `lychee --offline` over all `.md` and `.html`: 0 errors.
- Reviewed the staged diff for non-comment changes in Go, TypeScript, JavaScript, shell, YAML and Helm files: only comments and the Helm `fail` message text.

## What is left

- Folder hierarchy and names for the new kb are still to be decided.
- `docs/specs`, `project/agents`, `project/tracker` and `project/reports` were not moved.

## What the next agent must know

- Open PRs that add kb or ADR files, or link to the old paths, need the new paths after they rebase. Each author rebases its own PR.
- No dependency added.
