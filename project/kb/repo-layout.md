# Repository layout moves and link checking

Question: how do you move folders in this repo without breaking links, and how is that checked? Written for the B5 move (ADR-0010, 2026-10-17).

## Moving

- Move with `git mv` in a commit of its own or in one PR with only path edits, so `git log --follow` and rename detection on rebases keep working.
- Rewrite references in two passes, never one global search and replace:
  1. **Link targets** (`](...)` in Markdown, `href=` / `src=` in HTML): resolve each relative target against the file's **old** location in the old tree (`git ls-tree -r HEAD`), map the old path to its new path, and recompute the relative path from the file's **new** location. Links among folders that moved together (`project/{agents,kb,tracker,reports}`) come out unchanged; links from `docs/` into them gain `project/`. A target that did not exist before the move is left alone, so the checker reports it instead of the script hiding it.
  2. **Prose mentions** (backticks, comments, scripts): root-relative paths such as `kb/foo.md` get the new prefix only when the character before is not a path character (`[A-Za-z0-9_./@-]`), so `agents/qa/reports/x` is not rewritten twice and `sdk/ios` is untouched.
- Then read the diff for false positives. In the B5 move these were an agent folder's own `reports/` subfolder ("reports are under `reports/` inside the folder") and historical sentences that named the old paths on purpose (roadmap B5 "before" text, a tracker row that listed both releasing docs). Revert those by hand.
- Compose projects are named by `name:` inside the file (`name: ouo`), not by the folder, so renaming `deploy/docker` to `deploy/compose` keeps running stacks and their volumes.

## Link checking (CI job `links`)

- lychee 0.24.2 via `lycheeverse/lychee-action@v2.9.0`, `--offline`: only local file links are checked, external URLs are excluded, so the job takes about a second and never flakes on third-party sites.
- **Glob inputs do not honour `.gitignore`.** `lychee './**/*.md'` in a checkout with `node_modules/` scanned 47 000 links and reported 1 182 errors inside dependencies. Pass `--exclude-path node_modules --exclude-path /dist/` (the CI job and AGENTS.md command do). Alternative locally: `lychee --offline $(git ls-files '*.md' '*.html')`.
- Verified that it catches what matters: a Markdown link to a missing `../kb/nope.md` and an HTML `href` to a missing file both fail with "File not found".
- Docker Hub pulls of `lycheeverse/lychee` timed out on this Mac on 2026-10-17 (`context deadline exceeded`); the release tarball `lychee-aarch64-apple-darwin.tar.gz` from GitHub (check its `.sha256`) runs without installing anything. `brew install lychee` also works.
- Fragment checking (`#anchor`) is off (lychee's default for files); turning it on would flag GitHub-style heading anchors that lychee computes differently.
