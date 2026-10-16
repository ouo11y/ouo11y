# Releasing

How ouo is versioned, tagged and published. Owner: the release agent (`agents/release/`).
The image release checklist and the pre-release rules are in the root
[`RELEASING.md`](../RELEASING.md).
Packaging details and tool quirks live in `kb/release-packaging.md`; the operator-side upgrade
procedure in `docs/operations/upgrade.md`.

## 1. Packages and independent versions

Every deliverable has its own semantic version. Nothing is versioned "as ouo"; a release of
the browser SDK does not imply a release of rum-api and vice versa. The root `CHANGELOG.md`
is only an index.

| Package | Source | Version lives in | Tag | Published as | Workflow |
|---|---|---|---|---|---|
| `@ouo/browser` | `sdk/browser` | `package.json` | `browser-v<semver>` | npm, `@ouo/browser` | `release-npm.yml` |
| `@ouo/react-native` | `sdk/react-native` | `package.json` | `react-native-v<semver>` | npm, `@ouo/react-native` | `release-npm.yml` |
| `OuoReplay` (Swift package) | `sdk/ios` | git tag only (SwiftPM has no manifest version) | `ios-v<semver>` | mirror repo `ZiadMansourM/ouo-ios`, tag `<semver>` | `release-ios.yml` |
| `ouo-rum-app` (Grafana app plugin) | `plugins/ouo-rum-app` | `package.json` (copied into `plugin.json` at build) | `plugin-v<semver>` | GitHub release asset `ouo-rum-app-<semver>.zip` | `release-plugin.yml` |
| `rum-api` image | `services/rum-api` | the tag | `rum-api-v<semver>` | `ghcr.io/ziadmansourm/ouo/rum-api:<semver>`, `:<major.minor>`, `:latest` | `release-images.yml` |
| `grafana` image (Grafana + plugin baked in) | `deploy/images/grafana` | the tag | `grafana-v<semver>` | `ghcr.io/ziadmansourm/ouo/grafana:<semver>`, `:<major.minor>`, `:latest` | `release-images.yml` |
| `collector` image (ouo-collector, ocb distribution) | `collector` | `collector/builder.yaml` `dist.version` | `collector-v<semver>` | `ghcr.io/ziadmansourm/ouo/collector:<semver>`, `:<major.minor>`, `:latest` | `release-images.yml` |
| Helm chart `ouo` | `deploy/helm/ouo` | `Chart.yaml` `version` (`appVersion` = rum-api version it defaults to) | `chart-v<semver>` | not published yet (`helm package` by hand, OCI push is Phase 8c) | none yet |

Tag format is always `<package>-v<major>.<minor>.<patch>[-<pre>]`. The `<package>` prefix is
exactly the first column of the workflow trigger list; the workflows refuse a tag whose
version differs from the manifest version of the package.

## 2. Semantic versioning rules

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
  `kb/grafana-app-plugin.md`). A plugin tag is cut from a version that was already bumped
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

## 3. What triggers what

```
PR merged with a version bump      nothing is published; CI (ci.yml) ran on the PR
git tag browser-v0.2.0             release-npm.yml       -> npm publish @ouo/browser@0.2.0 (provenance)
git tag react-native-v0.2.0        release-npm.yml       -> npm publish @ouo/react-native@0.2.0
git tag ios-v0.2.0                 release-ios.yml       -> subtree split sdk/ios -> ouo-ios main + tag 0.2.0
git tag plugin-v0.3.0              release-plugin.yml    -> GitHub release plugin-v0.3.0 with ouo-rum-app-0.3.0.zip (+ .sha1, .md5)
git tag rum-api-v0.2.0             release-images.yml    -> ghcr.io/ziadmansourm/ouo/rum-api:0.2.0, :0.2, :latest (amd64 + arm64)
git tag grafana-v0.2.0             release-images.yml    -> ghcr.io/ziadmansourm/ouo/grafana:0.2.0, :0.2, :latest
git tag collector-v0.2.0           release-images.yml    -> ghcr.io/ziadmansourm/ouo/collector:0.2.0, :0.2, :latest
  (every image tag also creates a GitHub release with notes: changelog section + commits)
Actions > release-images > Run      dry run of a given tag: builds both platforms, prints notes, pushes nothing
pull request                       ci.yml `images` job: builds the three images (amd64, no push) and smoke-runs them
git tag chart-v0.1.0               nothing automated yet; see deploy/helm/ouo/README.md
```

Pre-release versions (`-rc.1`, `-beta.2`) are published the same way; images skip the
`:latest` and `:<major.minor>` tags and the plugin release is marked pre-release. npm
dist-tags for pre-releases are not automated: publish with `npm dist-tag` by hand if a
`next` tag is wanted.

## 4. Release procedure (per package)

1. On a branch, bump the version in the package manifest and move the "Unreleased" section
   of the package `CHANGELOG.md` under the new version with today's date. Add the
   compatibility line (minimum rum-api, minimum SDK) when it changed. Update the row in the
   root `CHANGELOG.md` index.
2. Run the package checks locally (table in section 5) and open the PR. CI must be green.
3. Merge. On the merge commit: `git tag <package>-v<semver> && git push origin <package>-v<semver>`.
   Tags are annotated by the person cutting the release (`git tag -a`), never by CI.
4. Watch the workflow run; its summary lists what was published. A failed publish is fixed
   by a new patch version, never by moving or deleting the tag (npm and GHCR versions are
   immutable; a deleted tag leaves a published artifact without source).
5. For a rum-api or chart release, run the upgrade procedure from the previous release on the
   compose path and record it in `agents/qa/`.

## 5. Local checks before tagging

| Package | Commands |
|---|---|
| `@ouo/browser` | `npm run build -w sdk/browser && npm run test -w sdk/browser && npm pack --dry-run -w sdk/browser` |
| `@ouo/react-native` | `npm run build -w sdk/react-native && npm run test -w sdk/react-native && npm pack --dry-run -w sdk/react-native` |
| `OuoReplay` | `sh sdk/ios/test.sh` and, on a Mac with Xcode, `(cd sdk/ios && swift build)` |
| plugin | `npm run build -w plugins/ouo-rum-app && npm run test -w plugins/ouo-rum-app && npm run lint -w plugins/ouo-rum-app` |
| rum-api | `(cd services/rum-api && go vet ./... && go test ./...)` and `docker build -t ouo/rum-api:release-check services/rum-api` |
| collector | `docker buildx build --platform linux/amd64,linux/arm64 collector` and `docker run --rm <image> --version` (prints `dist.version`) |
| grafana image | `npm run build -w plugins/ouo-rum-app && docker buildx build --platform linux/amd64,linux/arm64 -f deploy/images/grafana/Dockerfile .` |
| chart | `helm lint deploy/helm/ouo` and the kind check in `agents/helm/` |
| workflows | `actionlint` (Homebrew `brew install actionlint`) |

## 6. Secrets, variables and external accounts

Nothing publishes until these exist. Set them in the GitHub repository settings
(`Settings > Secrets and variables > Actions`).

| Name | Kind | Used by | How to create |
|---|---|---|---|
| `NPM_TOKEN` | secret | `release-npm.yml` | npm granular access token, packages and scopes: `@ouo` read and write, bypass 2FA for automation, expiry at most 1 year. The `ouo` npm organisation (or scope) must exist and the publishing user must be an owner. |
| `GITHUB_TOKEN` | automatic | `release-images.yml`, `release-plugin.yml` | nothing to create. After the first image push, open the package on GitHub and link it to the repository. Visibility stays private until ouo is stable (founder decision 2026-10-17), so every pull needs `docker login ghcr.io` with a classic `read:packages` token; see "Pull access" in `RELEASING.md`. |
| `GRAFANA_ACCESS_POLICY_TOKEN` | secret, optional | `release-plugin.yml` | grafana.com account, "My account > Security > Access policies", scope `plugins:write`, realm the publishing org. Without it the plugin is released unsigned. |
| `GRAFANA_ROOT_URLS` | variable, optional | `release-plugin.yml` | comma separated Grafana root URLs the private signature is valid for (e.g. `https://grafana.pilot.example.com`). Required when the token is set. |
| `OUO_IOS_DEPLOY_KEY` | secret, optional | `release-ios.yml` | `ssh-keygen -t ed25519 -C ouo-ios-deploy -f ouo_ios_deploy` locally; add `ouo_ios_deploy.pub` as a deploy key with write access on `github.com/ZiadMansourM/ouo-ios`; paste the private file as the secret; delete the local copies. The repository `ZiadMansourM/ouo-ios` must exist (empty is fine). Without it the workflow tests and exits with a notice. |

Provenance (`npm publish --provenance`) additionally requires the repository to be public
and the `repository.url` in each SDK `package.json` to point at it; both are in place.

## 7. Changelogs

- One `CHANGELOG.md` per package, Keep-a-Changelog style: an `## Unreleased` section at the
  top, then `## <version> (<date>)` sections with `Added`, `Changed`, `Fixed`, `Breaking`,
  `Compatibility` headings as needed. Written by the agent that owns the package.
- The root `CHANGELOG.md` is an index: one row per package pointing at its changelog and
  latest version, plus a "release trains" table recording which versions were released and
  verified together. It never repeats per-package entries.
- The plugin release workflow extracts the matching version section from
  `plugins/ouo-rum-app/CHANGELOG.md` for the GitHub release notes.

## 8. Not automated (yet)

- Helm chart publishing to an OCI registry (`helm push` to `oci://ghcr.io/ziadmansourm/ouo/charts`): Phase 8c, once the chart has been through a kind upgrade test.
- Signed git tags and SBOM attestations for npm packages: product-plan checklist "before the first paid subscription".
- Grafana catalog (community or commercial signature) submission: needs the trademark and name check from the product plan first.
- Android package: Phase 10.
