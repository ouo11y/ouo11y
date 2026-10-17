# Releasing

How ouo is versioned, tagged and published, and the checklists for cutting a release. Owner:
the release agent (`project/agents/release/`). Packaging details and tool quirks live in
[`project/kb/release-packaging.md`](../project/kb/release-packaging.md); the operator-side
upgrade procedure in [`operations/upgrade.md`](operations/upgrade.md). This is the only
releasing document: the former root `RELEASING.md` was merged into it on 2026-10-17
([ADR-0010](adr/0010-repository-layout.md)).

**Nobody pushes a release tag without the founder's explicit yes**, with the exact tag
names and what they publish written down first. Tags and published images are permanent.

## 1. Packages and independent versions

Every deliverable has its own semantic version. Nothing is versioned "as ouo"; a release of
the browser SDK does not imply a release of rum-api and vice versa. The root `CHANGELOG.md`
is only an index.

| Package | Source | Version lives in | Tag | Published as | Workflow |
|---|---|---|---|---|---|
| `@ouo11y/browser` | `sdk/browser` | `package.json` | `browser-v<semver>` | npm, `@ouo11y/browser` | `release-npm.yml` |
| `@ouo11y/react-native` | `sdk/react-native` | `package.json` | `react-native-v<semver>` | npm, `@ouo11y/react-native` | `release-npm.yml` |
| `OuoReplay` (Swift package) | `sdk/ios` | git tag only (SwiftPM has no manifest version) | `ios-v<semver>` | mirror repo `ouo11y/ouo11y-ios`, tag `<semver>` | `release-ios.yml` |
| `ouo11y-rum-app` (Grafana app plugin) | `plugins/ouo11y-rum-app` | `package.json` (copied into `plugin.json` at build) | `plugin-v<semver>` | GitHub release asset `ouo11y-rum-app-<semver>.zip` | `release-plugin.yml` |
| `rum-api` image | `services/rum-api` | the tag | `rum-api-v<semver>` | `ghcr.io/ouo11y/rum-api:<semver>`, `:<major.minor>`, `:latest` | `release-images.yml` |
| `grafana` image (Grafana + plugin baked in) | `deploy/images/grafana` | the tag | `grafana-v<semver>` | `ghcr.io/ouo11y/grafana:<semver>`, `:<major.minor>`, `:latest` | `release-images.yml` |
| `collector` image (ouo-collector, ocb distribution) | `collector` | `collector/builder.yaml` `dist.version` | `collector-v<semver>` | `ghcr.io/ouo11y/collector:<semver>`, `:<major.minor>`, `:latest` | `release-images.yml` |
| Helm chart `ouo` | `deploy/helm/ouo` | `Chart.yaml` `version` (`appVersion` = rum-api version it defaults to) | `chart-v<semver>` | not published yet (`helm package` by hand, OCI push is Phase 8c) | none yet |

Tag format is always `<package>-v<major>.<minor>.<patch>[-<pre>]`. The `<package>` prefix is
exactly the first column of the workflow trigger list; the workflows refuse a tag whose
version differs from the manifest version of the package.

## 2. Semantic versioning rules

Quick reference while the major version is 0:

| Change since the last release | Bump | Example |
|---|---|---|
| anything a user or operator can see: new config key, env var, API route, attribute, changed default, dropped support, a stored-data schema change | minor | `0.2.0` -> `0.3.0` |
| a breaking change (also minor while 0.x, listed under **Breaking** in the changelog) | minor | `0.3.0` -> `0.4.0` |
| fixes and internal changes, no visible behaviour change | patch | `0.3.0` -> `0.3.1` |

Image-specific rules:

- **rum-api**: version = the tag. The first release is `0.2.0` and **must contain the YAML
  config file and S3 / MinIO replay storage** (the rum-api-config-s3 work); do not tag
  `rum-api-v0.2.0` before that PR is merged.
- **collector**: version = `dist.version` in `collector/builder.yaml`; the workflow refuses a
  tag that differs. Bump it in the PR that changes the collector. First release `0.2.0`.
- **grafana**: its own series; the release notes name the Grafana base image and the
  `ouo11y-rum-app` plugin version baked in. Any plugin release that should reach image users
  needs a grafana image release too. First release `0.2.0`.

The `0.2.0` starting point matches the Helm chart defaults (`deploy/helm/ouo/values.yaml`)
and the examples (`deploy/compose/.env.example`).

All packages are `0.y.z` until the first pilot is live. While the major is 0:

- `0.y+1.0` for anything a user can see or that changes a contract: new API, new config key,
  new event or attribute, changed default, dropped support. Breaking changes are allowed in
  a minor bump while major is 0 **and must be listed under a "Breaking" heading** in the
  package changelog.
- `0.y.z+1` for fixes and internal changes with no visible behaviour change.

After `1.0.0` the usual rules apply: major for breaking, minor for additive, patch for fixes.

Package-specific rules:

- **Plugin:** every user-visible change bumps the plugin version, even in a development
  branch, because Grafana caches `module.js?_cache=<version>` (see
  `project/kb/grafana-app-plugin.md`). A plugin tag is cut from a version that was already bumped
  in the PR that made the change.
- **rum-api:** the replay chunk `schema_version` (`docs/specs/mobile-replay.md`) is an
  independent integer. Bumping it is a breaking change for stored data: the rum-api minor
  bumps, and the upgrade note in `docs/operations/upgrade.md` must say which rum-api version
  first reads the new schema. rum-api must refuse to start on a data directory whose highest
  `schema_version` is newer than it knows (requirement recorded in the upgrade doc; the qa
  agent tests it once implemented).
- **SDKs vs rum-api:** an SDK release that needs a new rum-api route or header bumps the SDK
  minor and states the minimum rum-api version in its changelog and in the compatibility
  table of `docs/operations/upgrade.md`.
- **Helm chart:** `version` bumps whenever anything under `deploy/helm/ouo` changes;
  `appVersion` follows the rum-api image the chart defaults to. Changing `appVersion` alone
  is a chart patch bump.
- **Images:** the rum-api image version equals the rum-api version. The grafana image
  version is its own series; its changelog line names the Grafana base version and the
  plugin version baked in.

## 3. Pre-releases (`-rc.N`)

- `<version>-rc.1`, `-rc.2`, ... are candidates for `<version>`. Tag them from any commit
  on `main` (or a release branch) that should be tried by someone outside the repo, e.g. a
  pilot client, before the final.
- They publish `:<version>-rc.N` only. They never move `:latest` or `:<major>.<minor>`,
  and the GitHub release is marked pre-release.
- An rc may be cut before every planned feature has landed when a client needs something
  runnable now; say what is missing in its release notes. Check it still runs with the
  compose file and chart on `main`: rum-api without the YAML config PR (#19) exits on the
  `-config.file` flag that compose.yaml and the chart pass after #19, so the first rum-api
  rc is cut after #19 merges (`rum-api-v0.2.0-rc.1`), then `0.2.0`.
- The final is tagged on the same commit as the last rc whenever possible (no new code
  between "verified" and "released").
- Examples and docs pin finals. Point an example at an rc only on a branch.

## 4. What triggers what

```
PR merged with a version bump      nothing is published; CI (ci.yml) ran on the PR
git tag browser-v0.2.0             release-npm.yml       -> npm publish @ouo11y/browser@0.2.0 (provenance)
git tag react-native-v0.2.0        release-npm.yml       -> npm publish @ouo11y/react-native@0.2.0
git tag ios-v0.2.0                 release-ios.yml       -> subtree split sdk/ios -> ouo11y-ios main + tag 0.2.0
git tag plugin-v0.3.0              release-plugin.yml    -> GitHub release plugin-v0.3.0 with ouo11y-rum-app-0.3.0.zip (+ .sha1, .md5)
git tag rum-api-v0.2.0             release-images.yml    -> ghcr.io/ouo11y/rum-api:0.2.0, :0.2, :latest (amd64 + arm64)
git tag grafana-v0.2.0             release-images.yml    -> ghcr.io/ouo11y/grafana:0.2.0, :0.2, :latest
git tag collector-v0.2.0           release-images.yml    -> ghcr.io/ouo11y/collector:0.2.0, :0.2, :latest
  (every image tag also creates a GitHub release with notes: changelog section + commits)
Actions > release-images > Run      dry run of a given tag: builds both platforms, prints notes, pushes nothing
pull request                       ci.yml `images` job: builds the three images (amd64, no push) and smoke-runs them
git tag chart-v0.1.0               nothing automated yet; see deploy/helm/ouo/README.md
```

Pre-release versions (`-rc.1`, `-beta.2`) are published the same way; images skip the
`:latest` and `:<major.minor>` tags and the plugin release is marked pre-release. npm
dist-tags for pre-releases are not automated: publish with `npm dist-tag` by hand if a
`next` tag is wanted.

## 5. Release procedure (per package)

1. On a branch, bump the version in the package manifest and move the "Unreleased" section
   of the package `CHANGELOG.md` under the new version with today's date. Add the
   compatibility line (minimum rum-api, minimum SDK) when it changed. Update the row in the
   root `CHANGELOG.md` index.
2. Run the package checks locally (table in section 7) and open the PR. CI must be green.
3. Merge. On the merge commit: `git tag <package>-v<semver> && git push origin <package>-v<semver>`.
   Tags are annotated by the person cutting the release (`git tag -a`), never by CI.
4. Watch the workflow run; its summary lists what was published. A failed publish is fixed
   by a new patch version, never by moving or deleting the tag (npm and GHCR versions are
   immutable; a deleted tag leaves a published artifact without source).
5. For a rum-api or chart release, run the upgrade procedure from the previous release on the
   compose path and record it in `project/agents/qa/`.

### Next image release after the rename (proposed 2026-10-18, needs the founder's yes)

The 0.2.0 images exist only as `ghcr.io/ziadmansourm/ouo/{rum-api,collector,grafana}:0.2.0`, and
grafana 0.2.0 carries the plugin as `ouo-rum-app`. Every pin in the repo now names
`ghcr.io/ouo11y/*`, so `compose.images.yaml`, the Helm defaults and the VM `--images` mode pull
nothing until the next tags exist. Proposed:

| Tag | Why this version | Publishes |
|---|---|---|
| `rum-api-v0.3.0` | no API change since 0.2.0, but the three images move registry together and are verified together as the first `ouo11y` set; a minor bump keeps them aligned | `ghcr.io/ouo11y/rum-api:0.3.0`, `:0.3`, `:latest` |
| `collector-v0.3.0` | the Unreleased `ouo.rum.mode = sentry` attribute (a feature) plus the rename; needs `builder.yaml` `dist.version: 0.3.0` first | `ghcr.io/ouo11y/collector:0.3.0`, `:0.3`, `:latest` |
| `grafana-v0.3.0` | plugin 0.7.0 inside, whose ID change is breaking | `ghcr.io/ouo11y/grafana:0.3.0`, `:0.3`, `:latest` |

Order: a release PR (move each Unreleased section under its version, `dist.version: 0.3.0`),
then the three tags, then the pin bump in step 10 of section 6. Before the first push, the
`ouo11y` org must allow `GITHUB_TOKEN` to create packages (Organization settings > Packages),
and after it each new package needs its Read grants again (section 8): grants on the old
`ziadmansourm/ouo/*` packages do not carry over. The old packages stay where they are; delete
them only on the founder's word once nothing pulls them.

## 6. Checklist: container image release

Before the tag:

1. [ ] The change is merged to `main`, CI green, including the `image (<name>)` jobs.
2. [ ] Changelog: move `## Unreleased` to `## <version> (<date>)` in
   `services/rum-api/CHANGELOG.md`, `collector/CHANGELOG.md` or
   `deploy/images/grafana/CHANGELOG.md`; update the row in the root `CHANGELOG.md`.
   (rcs may skip this; the notes then list the commits only.)
3. [ ] collector only: `collector/builder.yaml` `dist.version` equals the version.
4. [ ] Local checks (section 7) and `actionlint`.
5. [ ] Dry run: GitHub > Actions > `release-images` > Run workflow on `main` with the exact
   tag, e.g. `rum-api-v0.2.0`. It builds amd64 + arm64, checks the version and prints the
   release notes in the run summary; nothing is pushed.
6. [ ] Ask the founder in chat: exact tag names, the image refs they create
   (`ghcr.io/ouo11y/<image>:<version>` plus `:<major>.<minor>` and `:latest` for
   a final). Packages stay private (see "Pull access"); making one public is a separate
   founder decision. Wait for yes.

Tag:

```bash
git switch main && git pull --ff-only
```

```bash
git tag -a rum-api-v0.2.0 -m "rum-api 0.2.0"
```

```bash
git push origin rum-api-v0.2.0
```

After the tag:

7. [ ] The `release-images` run is green; its summary lists the pushed tags and digest.
8. [ ] First release of an image only: GitHub > Packages > the package > Package settings:
   connect it to the repository and leave visibility **private** (founder decision until ouo
   is stable); grant Read under Manage access to everyone who already has access to the other
   ouo packages. Pulls need a `docker login ghcr.io` ("Pull access").
9. [ ] `docker buildx imagetools inspect ghcr.io/ouo11y/<image>:<version>` shows
   `linux/amd64` and `linux/arm64` (plus `unknown/unknown` attestation entries).
10. [ ] Bump the pins that should follow: `deploy/compose/.env.example` and the defaults in
    `deploy/compose/compose.images.yaml`, `deploy/helm/ouo/values.yaml` (chart patch bump),
    the version table in `examples/fast-tracked/00-stack.md`.
11. [ ] Run the stack from the released images and record it (release trains table in
    `CHANGELOG.md`):

    ```bash
    docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.images.yaml up -d
    ```

A broken release is fixed by a new patch version (or the next rc). Never move or delete a
pushed tag and never overwrite a published image tag.

## 7. Local checks before tagging

| Package | Commands |
|---|---|
| `@ouo11y/browser` | `npm run build -w sdk/browser && npm run test -w sdk/browser && npm pack --dry-run -w sdk/browser` |
| `@ouo11y/react-native` | `npm run build -w sdk/react-native && npm run test -w sdk/react-native && npm pack --dry-run -w sdk/react-native` |
| `OuoReplay` | `sh sdk/ios/test.sh` and, on a Mac with Xcode, `(cd sdk/ios && swift build)` |
| plugin | `npm run build -w plugins/ouo11y-rum-app && npm run test -w plugins/ouo11y-rum-app && npm run lint -w plugins/ouo11y-rum-app` |
| rum-api | `(cd services/rum-api && go vet ./... && go test ./...)` and `docker build -t ouo/rum-api:release-check services/rum-api` |
| collector | `docker buildx build --platform linux/amd64,linux/arm64 collector` and `docker run --rm <image> --version` (prints `dist.version`) |
| grafana image | `npm run build -w plugins/ouo11y-rum-app && docker buildx build --platform linux/amd64,linux/arm64 -f deploy/images/grafana/Dockerfile .` |
| chart | `helm lint deploy/helm/ouo` and the kind check in `project/agents/helm/` |
| workflows | `actionlint` (Homebrew `brew install actionlint`) |

## 8. Pull access (packages are private until ouo is stable)

Founder decision (2026-10-17): the `ghcr.io/ouo11y/*` packages stay **private**
until ouo reaches a stable version. Anyone pulling them (examples, verification, clients)
logs in first:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

- The token is a **classic** personal access token with only **`read:packages`** (fine
  grained tokens do not work with ghcr.io). It lives in the puller's shell or password
  manager, never in the repo.
- Access is granted by the founder per package: GitHub > Packages > the package > Package
  settings > Manage access > add the GitHub user with the **Read** role. Do it for all three
  (`collector`, `rum-api`, `grafana`); that read access is what a new user asks the founder for.
- Kubernetes: a `docker-registry` Secret plus `imagePullSecrets` (`deploy/helm/ouo/README.md`,
  "Pull access").
- No access: build from source (`docker compose -f deploy/compose/compose.yaml up -d` without
  `compose.images.yaml`), no login needed.
- Without a login a pull fails with `denied` (HTTP 403).

## 9. Secrets, variables and external accounts

Nothing publishes until these exist. Set them in the GitHub repository settings
(`Settings > Secrets and variables > Actions`).

| Name | Kind | Used by | How to create |
|---|---|---|---|
| `NPM_TOKEN` | secret | `release-npm.yml` | npm granular access token, packages and scopes: `@ouo` read and write, bypass 2FA for automation, expiry at most 1 year. The `ouo` npm organisation (or scope) must exist and the publishing user must be an owner. |
| `GITHUB_TOKEN` | automatic | `release-images.yml`, `release-plugin.yml` | nothing to create. After the first image push, open the package on GitHub and link it to the repository. Visibility stays private until ouo is stable (founder decision 2026-10-17), so every pull needs `docker login ghcr.io` with a classic `read:packages` token; see section 8, "Pull access". |
| `GRAFANA_ACCESS_POLICY_TOKEN` | secret, optional | `release-plugin.yml` | grafana.com account, "My account > Security > Access policies", scope `plugins:write`, realm the publishing org. Without it the plugin is released unsigned. |
| `GRAFANA_ROOT_URLS` | variable, optional | `release-plugin.yml` | comma separated Grafana root URLs the private signature is valid for (e.g. `https://grafana.pilot.example.com`). Required when the token is set. |
| `OUO_IOS_DEPLOY_KEY` | secret, optional | `release-ios.yml` | `ssh-keygen -t ed25519 -C ouo11y-ios-deploy -f ouo_ios_deploy` locally; add `ouo_ios_deploy.pub` as a deploy key with write access on `github.com/ouo11y/ouo11y-ios`; paste the private file as the secret; delete the local copies. The repository `ouo11y/ouo11y-ios` exists (private, created 2026-10-18) with only a README on its default branch `about`, so `main` is created by the first push and fast-forwards; after that push, make `main` the default branch and delete `about`. Without it the workflow tests and exits with a notice. |

Provenance (`npm publish --provenance`) additionally requires the repository to be public
and the `repository.url` in each SDK `package.json` to point at it; both are in place.

## 10. Changelogs

- One `CHANGELOG.md` per package, Keep-a-Changelog style: an `## Unreleased` section at the
  top, then `## <version> (<date>)` sections with `Added`, `Changed`, `Fixed`, `Breaking`,
  `Compatibility` headings as needed. Written by the agent that owns the package.
- The root `CHANGELOG.md` is an index: one row per package pointing at its changelog and
  latest version, plus a "release trains" table recording which versions were released and
  verified together. It never repeats per-package entries.
- The plugin release workflow extracts the matching version section from
  `plugins/ouo11y-rum-app/CHANGELOG.md` for the GitHub release notes.

## 11. Not automated (yet)

- Helm chart publishing to an OCI registry (`helm push` to `oci://ghcr.io/ouo11y/charts`): Phase 8c, once the chart has been through a kind upgrade test.
- Signed git tags and SBOM attestations for npm packages: product-plan checklist "before the first paid subscription".
- Grafana catalog (community or commercial signature) submission: needs the trademark and name check from the product plan first.
- Android package: Phase 10.
