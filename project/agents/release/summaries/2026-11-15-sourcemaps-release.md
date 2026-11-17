# 2026-11-15 — `@ouo11y/sourcemaps` as a release-please component

**Done.** `sdk/sourcemaps` added to `.github/release-please/config.json` (node, component `sourcemaps`, root lockfile extra-file) and `manifest.json` at 0.1.0, as `@ouo11y/kit` was in #195. `release-npm.yml` maps `sourcemaps-v*` to `sdk/sourcemaps`; its PR rehearsal now rehearses sourcemaps (newest package). `package.json` gained `bugs` and `CHANGELOG.md` in `files` (`bin`, `publishConfig`, `repository`, license were already there); new `sdk/sourcemaps/CHANGELOG.md` with an undated 0.1.0 section. `docs/releasing.md`: component row, first-release steps, local-check row. ADR-0026 reworded so it stands alone (the ADR-0022 draft of #186 never merged); status still proposed.

**Verified.** `npm run typecheck|build|test -w sdk/sourcemaps` (37 tests pass); `npm pack --dry-run` lists `dist/cli.js` (shebang `#!/usr/bin/env node`) and `CHANGELOG.md`, 17 files; config/manifest parse as JSON, workflow as YAML; `lychee --offline` 0 errors. The PR runs the release-npm dry run itself.

**Founder steps.** In `docs/releasing.md` section 5: date the changelog, push `sourcemaps-v0.1.0` (or publish 0.1.0 by hand once), set the npm trusted publisher (`ouo11y` / `ouo11y` / `release-npm.yml`), then merge release PRs as usual.

**No dependency added.**
