# Releasing

How ouo is versioned, tagged and published, and the checklist the founder follows to cut a
release. This is the only releasing document. Owner: the release agent
(`project/agents/release/`). Tool quirks live in
[`project/kb-archive/release-packaging.md`](../project/kb-archive/release-packaging.md); which versions work
together in [`compatibility.md`](compatibility.md); the operator-side upgrade procedure in
[`operations/upgrade.md`](operations/upgrade.md).

Three rules from the founder hold for everything below:

- **Only the founder pushes release tags**, or a checkpoint session the founder asks to
  ([ADR-0013](adr-archive/0013-session-to-session-review.md) §7). CI never creates a tag; release-please is configured
  so that merging a release PR does not tag either. Otherwise agents prepare, dry-run and ask; they never
  push a tag, publish a package or change a visibility.
- **Everything published stays private until a stable version**, except where the founder
  decided otherwise: the SDK npm packages are public on npmjs.org (2026-10-24, Apache-2.0) and
  the `collector`, `rum-api` and `grafana` images on ghcr.io (2026-10-31, for the pilots). Still
  private: the Helm chart package and the `ouo11y-ios` mirror. Going public is a separate
  founder decision per channel.
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
| `kit` | `libs/ouo-kit` | `package.json` (+ root lockfile) | `kit-v<semver>` | npm `@ouo11y/kit` (public) | `release-npm.yml` |
| `sourcemaps` | `sdk/sourcemaps` | `package.json` (+ root lockfile) | `sourcemaps-v<semver>` | npm `@ouo11y/sourcemaps` (public; CLI `ouo-sourcemaps`) | `release-npm.yml` |
| `ios` | `sdk/ios` | `version.txt` | `ios-v<semver>` | mirror `ouo11y/ouo11y-ios`, tag `<semver>` (SwiftPM `ouo11y-ios`) | `release-ios.yml` |
| `plugin` | `plugins/ouo11y-rum-app` | `package.json` (+ root lockfile; becomes `plugin.json` at build) | `plugin-v<semver>` | GitHub release asset `ouo11y-rum-app-<semver>.zip` | `release-plugin.yml` |
| `collector` | `collector` | `builder.yaml` `dist.version` | `collector-v<semver>` | `ghcr.io/ouo11y/collector` | `release-images.yml` |
| `rum-api` | `services/rum-api` | none: the tag is the version | `rum-api-v<semver>` | `ghcr.io/ouo11y/rum-api` | `release-images.yml` |
| `muninn` | `services/muninn` | none: the tag is the version | `muninn-v<semver>` | `ghcr.io/ouo11y/muninn` | `release-images.yml` |
| `grafana` | `deploy/images/grafana` | `version.txt` | `grafana-v<semver>` | `ghcr.io/ouo11y/grafana` | `release-images.yml` |
| `chart` | `deploy/helm/ouo` | `Chart.yaml` `version` | `chart-v<semver>` | `oci://ghcr.io/ouo11y/charts/ouo` | `release-chart.yml` |

Every publish workflow refuses a tag whose version differs from the version field, and every
one can be rehearsed (section 6). Each except `release-ios` (its release is the mirror's tag)
creates a GitHub release for its tag, marked pre-release for `-rc.N`.

**"Latest" on GitHub is the newest chart release.** GitHub always shows one release as Latest,
even when every release is created with `--latest=false` (checklist N81: it then keeps whichever
release it picked, `rum-api 0.6.0` on 2026-10-31, and `gh release edit <tag> --latest=false`
does not clear it). Several components share the repo, so a component release must not be read
as "the" release; the chart is the one artefact that names a version of every server image
(its defaults point at tagged images). So `release-chart.yml` creates the newest final chart
release with `--latest=true`, and every other release (images, plugin, npm, a chart rc or a
patch to an older chart line) with `--latest=false`; `chart-v0.2.0` was set by hand
(`gh release edit chart-v0.2.0 --latest`). Which versions work together is
[`compatibility.md`](compatibility.md), not the Latest badge.

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
  `module.js?_cache=<version>` (`project/kb-archive/grafana-app-plugin.md`).
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

```
merge to main          release-please.yml   opens or updates one PR per component with pending
                                            changes: "chore(main): release <component> <version>",
                                            label "autorelease: pending", bumping the version field,
                                            the CHANGELOG and the manifest
release PR opened      release-check.yml    compatibility matrix + e2e scenario on the PR head
                       ci.yml               the usual checks for the touched paths
release PR merged      (nothing)            no tag, no publish (skip-github-release); merged like any PR,
                                            by the checkpoint session through ADR-0013 (two comments, CI green)
founder pushes tag     release-<x>.yml      publishes (table in section 1), creates the GitHub release
                       release-please.yml   relabels the merged PR "autorelease: tagged"
```

While a merged release PR is still `autorelease: pending`, release-please opens no further
release PRs for any component. Pushing its tag (or relabelling it by hand) unblocks it.

Hand edits on an open release PR (rewording the generated changelog, adding a **Breaking** or
**Compatibility** note) are overwritten when the next commit lands on `main`: make them last,
right before merging. Notes written by hand under `## Unreleased` in a component changelog stay
where they are; move them into the generated section in that last edit.

## 5. Checklist: cutting a release (founder, or the checkpoint session the founder asks; ADR-0013 §7)

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
   Package settings: link it to `ouo11y/ouo11y`. It starts **private**: a chart stays so (grant
   Read to whoever already has chart access); a new image package waits for the founder to
   make it public like the others (section 7).
8. [ ] Images: `docker buildx imagetools inspect ghcr.io/ouo11y/<image>:<version>` shows
   `linux/amd64` and `linux/arm64`.
9. [ ] Images: pins that should follow the new version (chart defaults, `deploy/compose/.env.example`,
   `deploy/compose/compose.images.yaml`, `examples/fast-tracked/00-stack.md`) are bumped in a
   follow-up PR, and `deploy/scripts/gen-quickstart.sh` (reads ghcr.io anonymously) regenerates
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
`browser-v0.2.0`, `react-native-v0.2.0`, `ios-v0.2.0`, `plugin-v0.7.0`, `chart-v0.1.1`. Muninn's
first image is the same: tag `muninn-v0.1.0` (manifest and `services/muninn/CHANGELOG.md` are at 0.1.0),
then make the new `muninn` package public (section 7). `@ouo11y/kit`'s first release is the
same: tag `kit-v0.1.0` (manifest, `package.json` and `libs/ouo-kit/CHANGELOG.md` are at 0.1.0),
published by hand once so its trusted publisher can be set (section 8). Push `kit-v0.1.0` on
the merge commit that added the kit before release-please runs again, or close the
"release kit 0.2.0" PR it opens in the meantime (no `kit-v0.1.0` tag yet means it counts every commit since bootstrap). `@ouo11y/sourcemaps`
(the `ouo-sourcemaps` CLI) follows the kit exactly: (1) date the 0.1.0 section of
`sdk/sourcemaps/CHANGELOG.md` and merge; (2) on that merge commit push `sourcemaps-v0.1.0`, or
publish 0.1.0 by hand once with `npm publish --access public` from `sdk/sourcemaps` after
`npm run build -w sdk/sourcemaps` (npm only lets a trusted publisher be set on a package that
exists); (3) on npmjs.com > `@ouo11y/sourcemaps` > Settings > Trusted publisher > GitHub Actions:
organization `ouo11y`, repository `ouo11y`, workflow `release-npm.yml`; (4) from then on merge the
"release sourcemaps" PR release-please opens and push its tag. Close any "release sourcemaps
0.2.0" PR opened before `sourcemaps-v0.1.0` exists. Each needs
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

A tag run that failed before it published (the chart's `helm registry login` on 2026-10-31) is
not fixed by a re-run: a re-run uses the tag commit's copy of the workflow. After the fix is on
`main`, `release-chart` publishes the existing tag: Actions > `release-chart` > Run workflow on
`main` with the tag and `publish` ticked (`gh workflow run release-chart.yml --ref main -f
tag=chart-v0.2.0 -f publish=true`); it checks out the tag itself. Never move or re-create the tag.

A tag pushed before the accounts exist degrades to a dry run with a notice (iOS without
`OUO_IOS_DEPLOY_KEY`, plugin unsigned without the grafana.com token). npm needs no secret: it
publishes by trusted publishing (OIDC) from a GitHub-hosted runner.

## 7. Pull access

Founder decisions: 2026-10-17, images and charts stay **private** until a stable version;
2026-10-31, the images `ghcr.io/ouo11y/{collector,rum-api,grafana}` are **public** so pilots
can run the stack on their own infra. Pulling an image needs no login and no token.

- `denied` (HTTP 403) on an image pull: Docker still sends an old ghcr.io login whose token
  expired or was revoked. `docker logout ghcr.io` (with `sudo` where root pulls, as on the VM).
- Kubernetes: no pull secret for the images; `imagePullSecrets` stays for a private mirror
  (`deploy/helm/ouo/README.md`, "Pull access").
- The Helm chart package (`oci://ghcr.io/ouo11y/charts/ouo`, once published) stays private.
  Installing from a checkout (`helm install ouo deploy/helm/ouo`) needs no login; pulling the
  package does, with a **classic** personal access token that has only **`read:packages`**
  (fine-grained tokens do not work with ghcr.io), and Read granted by the founder in Package
  settings > Manage access:

```bash
echo $GHCR_TOKEN | helm registry login ghcr.io -u <github-user> --password-stdin
```
- **SDK npm packages** are public on npmjs.org (founder decision 2026-10-24, Apache-2.0):
  `npm install @ouo11y/browser`, `npm install @ouo11y/react-native` or `npm install @ouo11y/kit`, no login. The 0.2.0
  copies published to GitHub Packages on 2026-10-23 stay there, private, and get no new versions.

## 8. Accounts, secrets and settings (founder)

Nothing below is created by an agent. Settings > Secrets and variables > Actions for secrets
and variables.

| What | Needed for | How |
|---|---|---|
| Repository setting "Allow GitHub Actions to create and approve pull requests" (Settings > Actions > General) | release-please with `GITHUB_TOKEN` | Currently **off**. Turn it on, or set `RELEASE_PLEASE_TOKEN` instead. |
| `RELEASE_PLEASE_TOKEN` secret (recommended) | release PRs that trigger `ci` and `release-check` | Fine-grained PAT, resource owner `ouo11y`, repository `ouo11y/ouo11y` only, permissions Contents, Pull requests, Issues: read and write; expiry at most 1 year. The org must allow fine-grained PATs (Organization settings > Personal access tokens). |
| npm org `ouo11y` + trusted publisher | `release-npm.yml` | Org claimed 2026-10-23; keep 2FA on for every member. No token: (1) the founder publishes each package's first version by hand once (npm only lets you set a trusted publisher on a package that exists); (2) on each package, npmjs.com > Settings > Trusted publisher > GitHub Actions: organization `ouo11y`, repository `ouo11y`, workflow `release-npm.yml`; (3) then every tag publishes from a GitHub-hosted runner (npm refuses self-hosted ones). Still to claim: the lookalike `ouolly` (ADR-0009). |
| `OUO_IOS_DEPLOY_KEY` secret | `release-ios.yml` | `ssh-keygen -t ed25519 -C ouo11y-ios-deploy -f ouo_ios_deploy -N ""`; add `ouo_ios_deploy.pub` as a deploy key **with write access** on `github.com/ouo11y/ouo11y-ios` (Settings > Deploy keys); paste the private file as the secret; delete both local files. The mirror exists (private) with a README on branch `about`; the first push creates `main`; then make `main` the default branch and delete `about`. |
| grafana.com organisation `ouo11y` | plugin signing | Not found (2026-10-23). Create it at grafana.com (sign up, organisation name `ouo11y`). |
| `GRAFANA_ACCESS_POLICY_TOKEN` secret | `release-plugin.yml` signing | grafana.com > My account > Security > Access policies: realm the `ouo11y` org, scope `plugins:write`; create a token. Without it the zip is unsigned. |
| `GRAFANA_ROOT_URLS` variable | `release-plugin.yml` signing | Comma separated Grafana root URLs allowed to load the private signature, e.g. `https://grafana.pilot.example.com`. Required when the token is set. |
| Organization settings > Packages: allow members / Actions to create packages | first image or chart push | Already done for the 0.3.0 images; the first `chart-v*` push creates `charts/ouo` the same way. |
| Renovate GitHub App | `.github/renovate.json5` | Install "Renovate" (Mend) from the GitHub Marketplace on the `ouo11y` org, repository `ouo11y/ouo11y` only. The config already exists, so there is no onboarding PR; expect the "Dependency Dashboard" issue and, on the first Monday, the digest-pinning PRs. |
| Security contact | `.github/SECURITY.md` | security@ouo11y.com (founder, 2026-11-15). |

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

Runners: every job runs on GitHub-hosted runners (`ubuntu-latest`, `macos-latest` for the Swift,
iOS release and benchmark jobs), free for a public repository. No job asks for a self-hosted
runner, and the org runner group `Default` must keep `allows_public_repositories: false` (check
command in the kb entry below), so code from a fork pull request never runs on our hosts. `ci.yml`
still runs each job only for the paths it covers, every workflow has a concurrency group, and
release dry runs only run when their own workflow file changes. What runs where, and the job
times: [github-hosted.md](../project/kb/ci/runners/github-hosted.md).

## 10. Local checks

| Component | Commands |
|---|---|
| browser / react-native / kit / sourcemaps | `npm run build -w <dir> && npm run test -w <dir> && npm pack --dry-run -w <dir>` (`sdk/browser`, `sdk/react-native`, `libs/ouo-kit`, `sdk/sourcemaps`) |
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

- Grafana catalog submission (community or commercial signature): needs the name and trademark
  check first.
- Signed git tags: the founder may use `git tag -s` instead of `-a`; nothing checks it yet.
- Android package: Phase 10.
