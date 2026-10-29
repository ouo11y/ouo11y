# Releasing

How ouo is versioned, tagged and published, and the checklist the founder follows to cut a
release. This is the only releasing document. Owner: the release agent
(`project/agents/release/`). Tool quirks live in
[`project/kb/release-packaging.md`](../project/kb/release-packaging.md); which versions work
together in [`compatibility.md`](compatibility.md); the operator-side upgrade procedure in
[`operations/upgrade.md`](operations/upgrade.md).

Three rules from the founder hold for everything below:

- **Only the founder pushes release tags.** CI never creates a tag; release-please is configured
  so that merging a release PR does not tag either. Agents prepare, dry-run and ask; they never
  push a tag, publish a package or change a visibility.
- **Everything published stays private until a stable version**: GHCR images and charts, the
  `ouo11y-ios` mirror. Exception (founder 2026-10-24): the SDK npm packages are public on
  npmjs.org (Apache-2.0). Going public is a separate founder
  decision per channel.
- Tags and published versions are permanent. A broken release is fixed by the next patch, never
  by moving or deleting a tag.

## 1. Components, tags and where they are published

Every component has its own semantic version. release-please tracks them in
[`.github/release-please/manifest.json`](../.github/release-please/manifest.json) (the version
last released) with the settings in
[`.github/release-please/config.json`](../.github/release-please/config.json).

| Component | Source | Version field the release PR bumps | Tag | Published as | Workflow |
|---|---|---|---|---|---|
| `browser` | `sdk/browser` | `package.json` (+ root lockfile) | `browser-v<semver>` | npm `@ouo11y/browser` (public) | `release-npm.yml` |
| `react-native` | `sdk/react-native` | `package.json` (+ root lockfile) | `react-native-v<semver>` | npm `@ouo11y/react-native` (public) | `release-npm.yml` |
| `ios` | `sdk/ios` | `version.txt` | `ios-v<semver>` | mirror `ouo11y/ouo11y-ios`, tag `<semver>` (SwiftPM `ouo11y-ios`) | `release-ios.yml` |
| `plugin` | `plugins/ouo11y-rum-app` | `package.json` (+ root lockfile; becomes `plugin.json` at build) | `plugin-v<semver>` | GitHub release asset `ouo11y-rum-app-<semver>.zip` | `release-plugin.yml` |
| `collector` | `collector` | `builder.yaml` `dist.version` | `collector-v<semver>` | `ghcr.io/ouo11y/collector` | `release-images.yml` |
| `rum-api` | `services/rum-api` | none: the tag is the version | `rum-api-v<semver>` | `ghcr.io/ouo11y/rum-api` | `release-images.yml` |
| `grafana` | `deploy/images/grafana` | `version.txt` | `grafana-v<semver>` | `ghcr.io/ouo11y/grafana` | `release-images.yml` |
| `chart` | `deploy/helm/ouo` | `Chart.yaml` `version` | `chart-v<semver>` | `oci://ghcr.io/ouo11y/charts/ouo` | `release-chart.yml` |

Every publish workflow refuses a tag whose version differs from the version field, and every
one can be rehearsed (section 6). Each creates a GitHub release for its tag, marked
pre-release for `-rc.N` and never "latest" (several components share the repo).

## 2. Versioning rules

All components are `0.y.z` until the first pilot is live.

| Change since the last release | Commit type | Bump while 0.x |
|---|---|---|
| user- or operator-visible: new API, config key, env var, attribute, changed default, dropped support, stored-data schema change | `feat` | minor `0.3.0` -> `0.4.0` |
| breaking (also listed under **Breaking** in the changelog) | `feat!` or a `BREAKING CHANGE:` footer | minor (`bump-minor-pre-major`) |
| fix, performance, internal change with no visible effect | `fix`, `perf` | patch `0.3.0` -> `0.3.1` |
| docs, tests, CI, chores | `docs`, `test`, `ci`, `chore`, `refactor`, `build` | no release |

After `1.0.0` the usual rules apply (major for breaking). Component-specific rules:

- **plugin:** every user-visible change is a release, because Grafana caches
  `module.js?_cache=<version>` (`project/kb/grafana-app-plugin.md`).
- **grafana image:** its own series. A plugin release reaches image users only through a grafana
  image release: after the plugin tag, merge a `feat(grafana): ship plugin <version>` commit that
  touches `deploy/images/grafana` (its `CHANGELOG.md` `Unreleased` note is enough). Its notes
  name the Grafana base and the plugin version inside.
- **rum-api:** the replay chunk `schema_version` (`specs/mobile-replay.md`) is an independent
  integer. Raising it is a breaking change for stored data: rum-api minor bump, the
  [`compatibility.md`](compatibility.md) schema table, and the upgrade note in
  [`operations/upgrade.md`](operations/upgrade.md) section 4.
- **SDKs:** an SDK release that needs a newer collector or rum-api bumps the SDK minor and adds
  its line to [`compatibility.md`](compatibility.md) with the minimum versions.
- **chart:** `version` bumps on any change under `deploy/helm/ouo`; `appVersion` follows the
  rum-api image the chart defaults to. The chart never defaults to an image that is not tagged
  (checked by `compat-check.mjs`).

## 3. Commit and PR titles (conventional commits)

release-please reads the commits on `main` that touch a component's folder and turns
`feat` / `fix` / `perf` into that component's next version and changelog. A commit counts for
every component whose folder it touches; the scope is for readers.

```
feat(collector): rate limit per project
fix(browser)!: drop the 0.1 endpoint option
```

- The `pr-title` job in `ci.yml` checks every PR title.
- **Merge PRs with "Squash and merge"** so that the PR title becomes the one commit on `main`.
  With "Create a merge commit" release-please reads the branch's own commits, which must then be
  conventional too (the `Merge pull request ...` commit itself is ignored).
- Commits before `bootstrap-sha` in `config.json` (the `main` commit release-please was added
  on) are not read: the existing hand-written changelogs cover them.

## 4. How a release happens

Automatic since [ADR-0013](adr/0013-automated-review-merge-and-release.md): no human step between a merge on `main` and the published artefacts.

```
merge to main          release-please.yml   opens or updates one PR per component with pending
                                            changes: "chore(main): release <component> <version>",
                                            label "autorelease: pending", bumping the version field,
                                            the CHANGELOG and the manifest
release PR opened      release-check.yml    compatibility matrix + e2e scenario on the PR head
                       ci.yml               the usual checks for the touched paths
daily 06:00 UTC        merge-ready.yml      squash-merges the release PR when those checks passed
                                            (one release per component per day at most)
release PR merged      release-please.yml   creates the tag and the GitHub release, relabels the
                                            PR "autorelease: tagged"
tag created            release-<x>.yml      publishes (table in section 1)
```

The chain needs `RELEASE_PLEASE_TOKEN` (section 8): merges, tags and PRs made with `GITHUB_TOKEN`
trigger no workflows. A hand-pushed tag still works (rc tags, emergencies) and `mark-tagged`
relabels its PR as before.

Hand edits on an open release PR (rewording the generated changelog, adding a **Breaking** or
**Compatibility** note) are overwritten when the next commit lands on `main`, and the bot merges
the PR in the next daily run: make them in the same session as the change that needs them, as a
commit on `main` under `## Unreleased` in the component changelog, which release-please keeps.

## 5. Checklist: cutting a release (now the bot's; kept for a release by hand)

Since ADR-0013 the steps below are what `merge-ready.yml` and release-please do. A release by hand
(an rc, a hotfix tag while the bot is broken) follows the same list.

Before merging the release PR:

1. [ ] The release PR's checks are green, including `release-check` (compatibility + e2e). If
   the PR was opened with `GITHUB_TOKEN`, no checks ran: Actions > `release-check` > Run
   workflow on the PR branch (and `ci`), or set `RELEASE_PLEASE_TOKEN` once (section 8).
2. [ ] The changelog section reads well; **Breaking** and **Compatibility** notes are there when
   needed, and [`compatibility.md`](compatibility.md) has the component's line.
3. [ ] Rehearse the publish: Actions > `release-<x>` > Run workflow on the release PR branch,
   tag = the tag you will push (e.g. `browser-v0.3.0`). Green means it builds, the versions
   match, and (npm) `npm publish --dry-run` or (ios) `git push --dry-run` to the mirror pass.
   - [ ] **`react-native`, major release (a minor opts in): device-cost benchmark.** Actions >
     `benchmark` > Run workflow with `ouo_ref` = the release PR branch. Green means no metric
     regressed against the previous `react-native-v*` release beyond the thresholds in
     [`benchmarks.md`](benchmarks.md) section 5 (simulator, latest stable Sentry). A red gate
     blocks the release unless you override it with a written reason on the PR. Then run the
     iPhone benchmark by hand (`benchmarks.md` section 4) and commit its result folder to
     `project/reports/benchmarks/` with the release.
4. [ ] Merge the release PR (squash).

Tag (on the merge commit, from an up-to-date clone):

```bash
git fetch origin --tags && git switch --detach origin/main
```

```bash
git tag -a browser-v0.3.0 -m "browser 0.3.0"
```

```bash
git push origin browser-v0.3.0
```

After the tag:

5. [ ] The `release-<x>` run is green; its summary lists what was published, checksums and digest.
6. [ ] The `release-please` run relabelled the release PR `autorelease: tagged`.
7. [ ] First publish of an image or chart package only: GitHub > Packages > the package >
   Package settings: link it to `ouo11y/ouo11y`, leave it **private**, grant Read to whoever
   already has access to the other packages (section 7).
8. [ ] Images: `docker buildx imagetools inspect ghcr.io/ouo11y/<image>:<version>` shows
   `linux/amd64` and `linux/arm64`.
9. [ ] Images: pins that should follow the new version (chart defaults, `deploy/compose/.env.example`,
   `deploy/compose/compose.images.yaml`, `examples/fast-tracked/00-stack.md`) are bumped in a
   follow-up PR, and `deploy/scripts/gen-quickstart.sh` (after `docker login ghcr.io`) regenerates
   `deploy/compose/quickstart.yaml` with the new version and digest; then
   `node examples/quickstarts/check-embeds.mjs --write` updates the guides that embed it. The
   quickstart follows `:latest` (moved only by the newest final release of an image), so it
   takes each image's configs from the commit its own tag points at: images released from
   different commits are fine. CI job `quickstart` fails on main from the tag until this PR
   lands, and also when the script's service blocks no longer match the releases' compose
   files or the newest releases break `docs/compatibility.md`. For the chart that is a
   `fix(chart)` and gives the next chart release.
10. [ ] Released together and verified: add a row to the release trains table in
    [`CHANGELOG.md`](../CHANGELOG.md).

**Release candidates** (`<version>-rc.N`) need no release PR: tag the commit to try, with the
version field already at the target version (`collector` needs `dist.version` equal to the full
rc version). They publish `:<version>-rc.N` only (npm dist-tag `next`), never move `:latest` or
`:<major>.<minor>`, and the GitHub release is a pre-release. Tag the final on the same commit as
the last rc when possible.

**The first SDK, iOS, plugin and chart releases** are hand tags of the versions already in the
manifest (no release PR is needed, the version fields and changelogs are in place):
`browser-v0.2.0`, `react-native-v0.2.0`, `ios-v0.2.0`, `plugin-v0.7.0`, `chart-v0.1.1`. Each needs
its accounts from section 8 first, and its changelog section dated in a small PR.

## 6. Dry runs

Every publish workflow has a `workflow_dispatch` dry run with a `tag` input and also rehearses
itself on any PR that changes the workflow file. A dry run never pushes, publishes or creates a
release; artefacts are kept on the run for 7 days.

| Workflow | Dry run does | Real run adds |
|---|---|---|
| `release-npm` | build, test, `npm pack`, CycloneDX SBOM, SHA256SUMS, registry check (`npm view`: answers, version not taken), `npm publish --dry-run` | `npm publish` of that tarball to npmjs.org by trusted publishing (OIDC), GitHub release with tarball + SBOM + sums |
| `release-ios` | `version.txt` check, macOS tests (skippable), `git subtree split`, `git push --dry-run` to the mirror when the key exists | push `main` and tag `<semver>` to `ouo11y/ouo11y-ios` |
| `release-plugin` | build, test, sign (when configured), zip, SBOM, sums | GitHub release with zip + SBOM + sums (+ `.sha1`, `.md5`), provenance when public |
| `release-chart` | compat check, `helm lint`, `helm template`, `helm package`, sums | `helm push` to `oci://ghcr.io/ouo11y/charts`, GitHub release |
| `release-images` | resolve, version checks, amd64 + arm64 build with SBOM and provenance, notes | push to `ghcr.io/ouo11y/<image>`, GitHub release |

A tag pushed before the accounts exist degrades to a dry run with a notice (iOS without
`OUO_IOS_DEPLOY_KEY`, plugin unsigned without the grafana.com token). npm needs no secret: it
publishes by trusted publishing (OIDC) from a GitHub-hosted runner.

## 7. Pull access (private until stable)

Founder decision (2026-10-17): `ghcr.io/ouo11y/*` images and charts stay **private** until ouo
reaches a stable version. Anyone pulling them logs in first:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

```bash
echo $GHCR_TOKEN | helm registry login ghcr.io -u <github-user> --password-stdin
```

- The token is a **classic** personal access token with only **`read:packages`** (fine-grained
  tokens do not work with ghcr.io). It lives in the puller's shell or password manager.
- Access is granted per package by the founder: Package settings > Manage access > add the
  GitHub user with **Read**, for `collector`, `rum-api`, `grafana` and `charts/ouo`.
- Kubernetes: a `docker-registry` Secret plus `imagePullSecrets` (`deploy/helm/ouo/README.md`).
- No access: build from source (`deploy/envs/ouo-env up <env>`), no login needed.
- **SDK npm packages** are public on npmjs.org (founder decision 2026-10-24, Apache-2.0):
  `npm install @ouo11y/browser` or `npm install @ouo11y/react-native`, no login. The 0.2.0
  copies published to GitHub Packages on 2026-10-23 stay there, private, and get no new versions.

## 8. Accounts, secrets and settings (founder)

Nothing below is created by an agent. Settings > Secrets and variables > Actions for secrets
and variables.

| What | Needed for | How |
|---|---|---|
| Repository setting "Allow GitHub Actions to create and approve pull requests" (Settings > Actions > General) | release-please with `GITHUB_TOKEN` | Currently **off**. Turn it on, or set `RELEASE_PLEASE_TOKEN` instead. |
| `ANTHROPIC_API_KEY` secret | `pr-review.yml` (ADR-0013): Claude reviews every PR push; without it the `review` check fails and nothing merges | Console key for the `ouo11y` org, Actions secret. `.github/scripts/repo-settings.sh --check` reports it. |
| `RELEASE_PLEASE_TOKEN` secret (**required** since ADR-0013) | release PRs that trigger `ci` and `release-check`; merges by `merge-ready.yml` and tags by release-please that trigger the next workflow | Fine-grained PAT, resource owner `ouo11y`, repository `ouo11y/ouo11y` only, permissions Contents, Pull requests, Issues: read and write; expiry at most 1 year. The org must allow fine-grained PATs (Organization settings > Personal access tokens). |
| npm org `ouo11y` + trusted publisher | `release-npm.yml` | Org claimed 2026-10-23; keep 2FA on for every member. No token: (1) the founder publishes each package's first version by hand once (npm only lets you set a trusted publisher on a package that exists); (2) on each package, npmjs.com > Settings > Trusted publisher > GitHub Actions: organization `ouo11y`, repository `ouo11y`, workflow `release-npm.yml`; (3) then every tag publishes from a GitHub-hosted runner (not the self-hosted Mac: npm refuses those). Still to claim: the lookalike `ouolly` (ADR-0009). |
| `OUO_IOS_DEPLOY_KEY` secret | `release-ios.yml` | `ssh-keygen -t ed25519 -C ouo11y-ios-deploy -f ouo_ios_deploy -N ""`; add `ouo_ios_deploy.pub` as a deploy key **with write access** on `github.com/ouo11y/ouo11y-ios` (Settings > Deploy keys); paste the private file as the secret; delete both local files. The mirror exists (private) with a README on branch `about`; the first push creates `main`; then make `main` the default branch and delete `about`. |
| grafana.com organisation `ouo11y` | plugin signing | Not found (2026-10-23). Create it at grafana.com (sign up, organisation name `ouo11y`). |
| `GRAFANA_ACCESS_POLICY_TOKEN` secret | `release-plugin.yml` signing | grafana.com > My account > Security > Access policies: realm the `ouo11y` org, scope `plugins:write`; create a token. Without it the zip is unsigned. |
| `GRAFANA_ROOT_URLS` variable | `release-plugin.yml` signing | Comma separated Grafana root URLs allowed to load the private signature, e.g. `https://grafana.pilot.example.com`. Required when the token is set. |
| Organization settings > Packages: allow members / Actions to create packages | first image or chart push | Already done for the 0.3.0 images; the first `chart-v*` push creates `charts/ouo` the same way. |
| Renovate GitHub App | `.github/renovate.json5` | Install "Renovate" (Mend) from the GitHub Marketplace on the `ouo11y` org, repository `ouo11y/ouo11y` only. The config already exists, so there is no onboarding PR; expect the "Dependency Dashboard" issue and, on the first Monday, the digest-pinning PRs. |
| Security contact | `.github/SECURITY.md` | Replace `SECURITY_CONTACT_TBD` with the disclosure address. |

Provenance and attestations: npm `--provenance` (npmjs.org only, at the public release),
`actions/attest-build-provenance` for the plugin zip and the chart need a **public** repository on the free plan; the
workflows switch them on by themselves when the repository becomes public. Images already carry
BuildKit SBOM and max-mode provenance attestations, private or not.

## 9. Supply chain

| Control | Where | Gate |
|---|---|---|
| Renovate: weekly grouped PRs, Actions and Docker pinned by digest, 3-day release age, advisories immediately | `.github/renovate.json5` | review |
| `govulncheck` on every Go module with the newest Go 1.26 patch | `security.yml` (Go/npm PRs, Mondays, on demand) | any reachable finding (each has a fixed-in version) |
| `npm audit` | `security.yml` | runtime dependencies at high and above; dev tooling informational |
| Trivy on every built image | `ci.yml` `images` job | fixable CRITICAL; HIGH listed |
| SBOM | images: BuildKit attestation; npm and plugin: CycloneDX asset on the GitHub release | every release |
| Provenance | images: BuildKit; npm, plugin, chart: GitHub attestations when public | every release |
| Disclosure policy | `.github/SECURITY.md` | |

Actions minutes (free plan, 2,000 per month for private repos, macOS counts 10x): `ci.yml` runs
each job only for the paths it covers, the macOS jobs only for `sdk/ios` (and the iOS release),
every workflow has a concurrency group, and release dry runs only run when their own workflow
file changes. If minutes run out, a self-hosted runner can take `runs-on` labels later; no job
depends on GitHub-hosted extras beyond Docker, Node, Go and Helm.

## 10. Local checks

| Component | Commands |
|---|---|
| browser / react-native | `npm run build -w sdk/<x> && npm run test -w sdk/<x> && npm pack --dry-run -w sdk/<x>` |
| ios | `sh sdk/ios/test.sh` and, on a Mac with Xcode, `(cd sdk/ios && swift build)` |
| plugin | `npm run build -w plugins/ouo11y-rum-app && npm run test -w plugins/ouo11y-rum-app && npm run lint -w plugins/ouo11y-rum-app` |
| rum-api | `(cd services/rum-api && go vet ./... && go test ./...)` |
| collector | `(cd collector && builder --config builder.yaml && ./dist/ouo-collector --version)` |
| chart | `helm lint deploy/helm/ouo` |
| matrix | `node .github/scripts/compat-check.mjs` |
| workflows | `actionlint` (`brew install actionlint`) |
| vulnerabilities | `govulncheck ./...` per module, `npm audit --omit=dev --audit-level=high` |

## 11. Changelogs

- One `CHANGELOG.md` per component, next to its version field. release-please writes a section
  per release from the commits (`Added` = feat, `Fixed` = fix, `Changed` = perf); hand-written
  `Breaking` / `Compatibility` notes are added in the release PR (section 4).
- The root [`CHANGELOG.md`](../CHANGELOG.md) is an index plus the release trains table; it never
  repeats component entries.
- Release notes on GitHub are the component's section, extracted by
  `.github/scripts/changelog-section.sh` (understands both heading styles).

## 12. Not automated

- The benchmark gate on a `react-native` release runs only when `benchmark.yml` is dispatched on
  the release PR branch (section 5, step 3); the bot does not dispatch it yet. Until it does, a
  session that bumps `@ouo11y/react-native` runs it before adding `ready` (the roadmap's W1 exit
  criterion makes it part of the package).

- Grafana catalog submission (community or commercial signature): needs the name and trademark
  check first.
- Signed git tags: the founder may use `git tag -s` instead of `-a`; nothing checks it yet.
- Android package: Phase 10.
