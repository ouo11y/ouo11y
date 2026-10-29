# Release automation and supply chain: release-please, dry runs, npm, attestations, scanners

What was learned wiring release-please, the publish dry runs and the B7 checks (2026-10-23,
PR #37). Policy and the founder's checklist: `docs/releasing.md`; packaging mechanics per
channel: [release-packaging.md](release-packaging.md).

## release-please (v17.11.2 CLI, release-please-action v5.0.0)

- **Leaving tags to a human:** `skip-github-release: true` (config and action input). Merging a
  release PR then creates no tag and no GitHub release. The merged PR keeps the label
  `autorelease: pending`, and `Manifest.createPullRequests` refuses to open any new release PR
  while such a PR exists ("There are untagged, merged release PRs outstanding - aborting",
  `build/src/manifest.js`). `release-please.yml` job `mark-tagged` flips the label to
  `autorelease: tagged` when the founder pushes the matching tag (title match
  `chore(main): release <component> <version>`). Relabelling by hand works too.
- **Finding the previous release** works from GitHub releases first, then tags
  (`<component>-v<version>`), then `bootstrap-sha`. The image workflows already create GitHub
  releases, so the CLI dry run found `collector-v0.3.0` etc.; components never released (SDKs,
  plugin, chart) fall back to `bootstrap-sha` and the manifest version.
- **No `additional-paths` option** in 17.11.2: a component only sees commits touching its own
  folder. The grafana image therefore does not see plugin commits; a `feat(grafana)` commit in
  `deploy/images/grafana` releases it.
- **Release types used:** `node` (package.json; the root `package-lock.json` workspace entry via
  a `json` extra-file with jsonpath `$.packages['sdk/browser'].version` and a leading `/` path =
  repo root; one line changes. Workspaces that pin a sibling exactly, like `examples/ouo-web` on
  `@ouo11y/browser`, need two more extra-files, the pin and its lock entry, or `npm ci` fails with
  "Missing: @ouo11y/browser@<old> from lock file" on the release PR), `go` (changelog only: rum-api, collector), `simple` (writes
  `version.txt`: ios, grafana). The collector's `dist.version` and the chart's `version` are
  bumped by a `generic` extra-file through a `# x-release-please-version` marker on that line
  of `builder.yaml` / `Chart.yaml` (ocb and Helm ignore the comment), with release type `go`
  (= changelog only). Not `helm`: its updater re-serialises the whole `Chart.yaml` with
  js-yaml (re-wrapped the description, would drop comments).
- **Changelog insertion:** the new section goes before the first `## <digit|[>` heading, i.e.
  below a hand-written `## Unreleased`, which is kept. Heading style `## [0.3.1](compare-url)
  (date)`; `.github/scripts/changelog-section.sh` extracts both that and `## 0.3.0 (date)`.
- **Tag format** `browser-v0.2.0` = `include-component-in-tag` + `tag-separator: "-"` +
  `include-v-in-tag`, the same format the workflows already used.
- **0.x bumps:** `bump-minor-pre-major: true` makes breaking changes minor;
  `bump-patch-for-minor-pre-major: false` keeps `feat` a minor (our policy).
- **Dry run without touching the repo:**
  `release-please release-pr --dry-run --token=$(gh auth token) --repo-url=ouo11y/ouo11y
  --target-branch=<branch> --config-file=.github/release-please/config.json
  --manifest-file=.github/release-please/manifest.json` reads config, tags and commits through
  the API and prints the PRs it would open. On the PR #37 branch it proposed exactly
  `release collector 0.3.1` from the `fix(deps)` commit.
- **GITHUB_TOKEN limits:** PRs opened with `GITHUB_TOKEN` trigger no workflows (no CI on the
  release PR), and the token can open PRs only when the repository setting "Allow GitHub
  Actions to create and approve pull requests" is on (`gh api
  repos/ouo11y/ouo11y/actions/permissions/workflow` showed `can_approve_pull_request_reviews:
  false` on 2026-10-23). A fine-grained PAT (`RELEASE_PLEASE_TOKEN`) solves both.

## Dry runs of workflows that are not on main yet

- `gh workflow run <file> --ref <branch> -f tag=...` works for a workflow that exists only on a
  branch **after it has run once on that branch** (here via its `pull_request` trigger); before
  that the API answers 404. Giving every publish workflow a `pull_request` trigger on its own
  file both registers it and rehearses every change to it.
- Real dispatch rehearsals on 2026-10-23: chart-v0.1.1, ios-v0.2.0 (tests skipped),
  grafana-v0.3.0, plugin-v0.7.0, react-native-v0.2.0; links in the release agent summary.

## npm

- **`npm publish out/pkg.tgz` fails** with `git ls-remote ssh://git@github.com/out/pkg.tgz.git`:
  npm parses `owner/repo` as a GitHub shorthand. Pass `./out/pkg.tgz`.
- **`npm pack --json` is not machine-readable for `@ouo11y/react-native`**: its `prepack`
  script (`sync-ios`, then a full tsup build) prints to stdout before the JSON. Pack with
  `--pack-destination out` and take the file name from the directory.
- `--access restricted` on the command line beats `publishConfig.access: public` in
  `package.json` (dry run printed "restricted access").
- **Restricted (private) scoped packages need a paid npm org** (Teams); a free org publishes
  public packages only.
- **Provenance needs a public package from a public repository**: npm rejects provenance for
  restricted packages, and GitHub-hosted runners in a private repo cannot produce it. The
  workflow enables `--provenance` only when `github.event.repository.private == false` and
  `NPM_ACCESS=public`.
- `npm sbom -w <ws> --omit dev --sbom-format cyclonedx` (npm >= 10, built in, no extra tool)
  writes the runtime dependency SBOM of one workspace; its root component is named after the
  monorepo folder, so the workflow rewrites `metadata.component`. Browser SDK: 33 components.
- Checking whether a scope exists without an account: `curl
  https://registry.npmjs.org/-/org/<name>/package` answers `{"error":"Scope not found"}` 404
  for a free name (`/-/org/babel/package` returns 200). `www.npmjs.com/org/<name>` is behind a
  bot wall (403 for everything).

## GitHub attestations on the free plan

- `actions/attest-build-provenance` works for public repositories on every plan, but for
  private repositories only on GitHub Enterprise Cloud. The npm, plugin and chart workflows
  gate the step on `github.event.repository.private == false`. BuildKit attestations on the
  images (`provenance: mode=max`, `sbom: true`) live in the image index and work in private
  repositories.
- Repository rulesets / branch protection on a private repo of a free org: HTTP 403 "Upgrade to
  GitHub Pro or make this repository public". So no check can be made required yet.

## Scanners

- **govulncheck scans the standard library of the Go that runs it.** Local Go 1.26.2 reported
  ~10 stdlib advisories (net/http, crypto/x509) fixed in 1.26.9 and 1.26.10;
  `GOTOOLCHAIN=go1.26.10 govulncheck ./...` (downloads that toolchain) showed the real module
  findings. In CI `setup-go` with `go-version: '1.26'` + `check-latest: true` gives the newest
  patch. `go 1.26.0` in `go.mod` alone would select exactly 1.26.0.
- On 2026-10-23 the module findings were `golang.org/x/net` 0.58/0.59 (GO-2026-6603, -6611,
  -6612, -6617), fixed by 0.60.0 in `examples/backend` and three collector modules.
- **npm audit** needs no install (reads `package-lock.json`). All dependencies: 39 high + 1
  critical, almost all dev tooling (jest 29, metro / react-native as a devDependency of the RN
  SDK). `--omit=dev`: one critical, `dompurify` <= 3.4.16 via `@grafana/ui` (shipped in the
  plugin bundle); `npm update dompurify` moved the lockfile to 3.4.17 without touching
  `package.json`.
- **Trivy** runs from `aquasec/trivy:<version>@sha256:...` with the Docker socket mounted, no
  action. `--severity CRITICAL --ignore-unfixed --exit-code 1` on the released 0.3.0 images:
  0 for rum-api, collector and grafana. The grafana image (upstream `grafana/grafana:13.2.1`
  on Alpine) carries many HIGH findings in Grafana's bundled Go binaries (13 to 23 per binary);
  they are listed, not gating, and only a Grafana base bump fixes them.
- **Renovate config validation:** `npx --package renovate renovate-config-validator --strict`
  with no argument validates the repository config (`.github/renovate.json5`); passing the path
  validates it as a *global* config instead. Installing with `--ignore-scripts` leaves out
  `re2` (warning only).

## e2e stack on a GitHub-hosted runner

- The first `release-check` e2e run failed with rum-api health "total=0" after 120 s, while
  every edge check passed. The cause: the runner disk was > 90% full after `npm ci` plus the
  compose image builds, Loki's WAL logged "disk usage exceeded threshold, throttling writes" and
  answered every push with 503 "Ingester is shutting down", so the collector kept retrying.
  Removing the preinstalled .NET, Android, GHC and CodeQL toolchains (`sudo rm -rf ...`, tens of
  GB) and `node_modules` after the plugin build fixes it.

## Actions minutes

- Free org plan: 2,000 minutes a month for private repositories, macOS at 10x, every job billed
  rounded up to a whole minute. `ci.yml` now has a `changes` job (PR file list through
  `gh api .../pulls/<n>/files`, no third-party action) and per-job `if:`; the image matrix is
  built from the list of images whose paths changed (`fromJSON`).

## Merging by a session on a free private repository (ADR-0013, 2026-10-29)

- A **private repository on the free plan** has no branch protection, rulesets, required checks, auto-merge or merge queue (`403 Upgrade to GitHub Pro`), so `gh pr merge --auto` is unavailable; `.github/scripts/merge-agreed.sh` checks the two review comments and the check runs itself.
- **An empty check list is not green**: the check-runs API returns nothing for a commit whose workflows never started (a PR opened with `GITHUB_TOKEN`); the script refuses in that case.
- `gh pr merge --squash` uses the **single commit's message** as the subject when the PR has one commit, which breaks conventional-commit titles for release-please: always pass `--subject "$title"`; `--match-head-commit` aborts the merge when someone pushed in between.
