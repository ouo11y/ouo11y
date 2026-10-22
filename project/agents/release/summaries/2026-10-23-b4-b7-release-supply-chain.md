# 2026-10-23: B4 releases and B7 supply chain (PR #37)

Batch 1 session "b1-release-supply-chain". Allowed paths: `.github/`, `docs/releasing.md`,
the root and per-component CHANGELOGs, release config, `SECURITY.md`, `project/agents/release/`,
`project/kb/`; version fields only in product code. Nothing was tagged, published or made
public; no secret was created.

## Done

**B4, releases**

- release-please in manifest mode: `.github/release-please/config.json` + `manifest.json` (not
  at the root: ADR-0010 keeps the root closed). Eight components, one release PR each
  (`separate-pull-requests`): browser, react-native, ios, plugin, collector, rum-api, grafana,
  chart. `skip-github-release: true` so merging a release PR never tags; the founder pushes the
  tag. `release-please.yml` job `mark-tagged` relabels the merged PR `autorelease: tagged` on the
  tag push (otherwise release-please stops opening release PRs). `bootstrap-sha` = `851692c`
  (main when this started).
- Version fields: `sdk/ios/version.txt` 0.2.0 and `deploy/images/grafana/version.txt` 0.3.0
  (new, release type `simple`); a `# x-release-please-version` marker on `collector/builder.yaml`
  `dist.version` and on `deploy/helm/ouo/Chart.yaml` `version`; root `package-lock.json`
  workspace versions as json extra-files of the npm components.
- New changelogs: `sdk/ios/CHANGELOG.md`, `deploy/helm/ouo/CHANGELOG.md`.
- Publish workflows, every one with a `workflow_dispatch` dry run (input `tag`) and a
  self-rehearsal on PRs that change the workflow file:
  - `release-npm.yml`: pack once, CycloneDX SBOM (`npm sbom`), SHA256SUMS, publish that tarball
    with `--access ${NPM_ACCESS:-restricted}`; provenance and a GitHub attestation only when the
    repo is public and access is public; GitHub release with tarball, SBOM, sums. Without
    `NPM_TOKEN` a tag push degrades to `npm publish --dry-run`.
  - `release-ios.yml`: tag must equal `version.txt`; dry run splits and `git push --dry-run`s to
    the mirror when the deploy key exists; macOS tests skipped on PR rehearsals and on request.
  - `release-plugin.yml`: zip + SBOM + SHA256SUMS (+ .sha1/.md5), signing kept (pinned
    `@grafana/sign-plugin@3.3.3`), attestation when public.
  - `release-chart.yml` (new): `chart-v*` -> `helm push` to `oci://ghcr.io/ouo11y/charts/ouo`,
    compat check first, GitHub release with the .tgz; attestation when public.
  - `release-images.yml`: unchanged behaviour; actions pinned, job-scoped permissions, grafana
    `version.txt` guard, the shared changelog parser (the old awk missed release-please headings).
- `docs/compatibility.md`: release lines with minimum collector / rum-api / plugin / Grafana and
  the replay `schema_version` table. `.github/scripts/compat-check.mjs` checks it against the
  manifest, the schema constants in four source files and the chart's default image tags.
  `release-check.yml` runs it plus `deploy/scripts/e2e.sh` on a compose stack built from the PR
  head, on every PR that changes the manifest (= every release PR).
- `docs/releasing.md` rewritten as the one releasing document: component table, versioning,
  conventional commits, the release-please flow, the founder's checklist, dry runs, pull access,
  accounts/secrets (section 8, exact steps), supply chain, minutes. `docs/operations/upgrade.md`
  section 5 (stale: still described the pre-ADR-0007 `/ingest/otlp` gateway) now points at the
  matrix. Root `CHANGELOG.md` index rows for iOS and chart, image rows marked released 2026-10-22.

**B7, supply chain**

- `.github/renovate.json5`: weekly (Monday before 06:00 UTC), grouped per ecosystem, majors
  separate, Actions and Docker pinned by digest, 3-day minimum release age, advisories
  immediately, OTel collector modules + builder.yaml + the ocb `go install` in one monthly group,
  own `ghcr.io/ouo11y/*` images ignored, conventional commit titles.
- `security.yml`: govulncheck on every Go module (Go 1.26 newest patch) and npm audit
  (runtime deps fail at high+, all deps informational); PRs touching Go / npm, Mondays, dispatch.
- Trivy (`aquasec/trivy:0.76.1` by digest, no action) in the `ci.yml` images job: fixable
  CRITICAL fails, HIGH listed.
- `.github/SECURITY.md` with the placeholder `SECURITY_CONTACT_TBD`.
- Every action in every workflow pinned to a commit SHA with the version as a comment.
- `ci.yml`: a `changes` job and path conditions per job (macOS only for `sdk/ios`), a dynamic
  image matrix, timeouts, `persist-credentials: false`, and a `pr-title` conventional-commit check.
- Fixed what the new checks found: `golang.org/x/net` 0.60.0 in `examples/backend` and three
  collector modules (GO-2026-6603/-6611/-6612/-6617, reachable), `dompurify` 3.4.17 in the
  lockfile (critical GHSA-cg2g-xh64-v4q7, shipped in the plugin bundle).

Dependencies added: none to the product. CI uses release-please-action v5.0.0 (release PRs),
actions/attest-build-provenance v3.0.0 (attestations once public), actions/upload-artifact
v4.6.2 (dry-run artefacts), govulncheck v1.9.0 and the Trivy image (scanners).

## Verified, and how

| Check | Result |
|---|---|
| `actionlint` 1.7.12 (with shellcheck) on all 9 workflows | clean |
| `renovate-config-validator --strict` (repo mode) | "Config validated successfully" |
| release-please CLI `release-pr --dry-run` against the PR branch | would open exactly `release collector 0.3.1` (from the `fix(deps)` commit), updating `collector/CHANGELOG.md`, `builder.yaml`, the manifest |
| release-please updaters run locally on the real files | changelog section lands under `## Unreleased`; `builder.yaml`, `Chart.yaml`, each lockfile entry: one line each |
| `compat-check.mjs` on the repo, then on a scratch copy with browser 0.3.0, iOS schema 2, chart defaults 0.4.0 | OK; then 6 precise failures |
| PR #37 runs (pull_request), final round on `74efd3d` | all green: ci (changes, pr-title, go x2, collector ocb, images x3 with Trivy, node, swift, links, helm), security (govulncheck, npm-audit), release-check (compat + e2e scenario, [run](https://github.com/ouo11y/ouo11y/actions/runs/39865731907)), release-npm (browser), release-plugin, release-ios, release-chart |
| Dispatch dry runs on the branch | release-chart chart-v0.1.1 ([run](https://github.com/ouo11y/ouo11y/actions/runs/39863952451)), release-ios ios-v0.2.0 with tests skipped ([run](https://github.com/ouo11y/ouo11y/actions/runs/39863956936), notice "OUO_IOS_DEPLOY_KEY secret is not set"), release-plugin plugin-v0.7.0 ([run](https://github.com/ouo11y/ouo11y/actions/runs/39863966388)), release-images grafana-v0.3.0 ([run](https://github.com/ouo11y/ouo11y/actions/runs/39863961473)), release-npm react-native-v0.2.0 ([run](https://github.com/ouo11y/ouo11y/actions/runs/39864268962)), security ([run](https://github.com/ouo11y/ouo11y/actions/runs/39863984778)) |
| govulncheck locally with `GOTOOLCHAIN=go1.26.10` after the bumps | every module clean |
| `npm audit --omit=dev --audit-level=high` after the bump | passes (5 moderate left) |
| Trivy CRITICAL `--ignore-unfixed` on `ghcr.io/ouo11y/{rum-api,collector,grafana}:0.3.0` | 0 findings each |
| plugin build + 119 tests after the dompurify bump; go vet + go test on the four bumped modules | pass |
| `lychee --offline` on all Markdown/HTML | 0 errors |
| secrets scan of the diff (token and private-key patterns) | none |

Bugs the dry runs caught and that are fixed: `npm publish out/x.tgz` is read as a GitHub repo
(needs `./`); react-native's `prepack` output breaks `npm pack --json`; Helm's release-please
updater rewrites `Chart.yaml` (switched to a line marker); `helm template` needs credentials
(uses `values-kind.yaml`); the e2e stack starved Loki of disk on a stock runner (the job now frees ~22 GB first, see the kb).

## Read-only checks of external accounts (2026-10-23)

- npm scope `@ouo11y`: **not claimed** (`registry.npmjs.org/-/org/ouo11y/package` -> "Scope not found").
- grafana.com org `ouo11y`: **not found** (`grafana.com/api/orgs/ouo11y` -> 404).
- `ouo11y/ouo11y-ios`: exists, private, default branch `about`.
- `ouo11y/ouo11y`: private, org on the free plan; Actions secrets and variables: none; "Allow
  GitHub Actions to create and approve pull requests": off; rulesets: unavailable (403).

## Left for the founder (exact list in `docs/releasing.md` section 8)

1. `RELEASE_PLEASE_TOKEN` secret (fine-grained PAT) **or** turn on "Allow GitHub Actions to
   create and approve pull requests"; without either, release-please cannot open PRs.
2. Decide the merge style: "Squash and merge" with conventional PR titles is what the setup expects.
3. npm org `ouo11y`; decide restricted (paid Teams) vs unpublished-until-stable; then `NPM_TOKEN`.
4. `OUO_IOS_DEPLOY_KEY` deploy key on `ouo11y/ouo11y-ios`.
5. grafana.com org `ouo11y`, then `GRAFANA_ACCESS_POLICY_TOKEN` + `GRAFANA_ROOT_URLS`.
6. Install the Renovate app on `ouo11y/ouo11y`.
7. The security disclosure address for `.github/SECURITY.md`.
8. Tags: none needed now. After the accounts exist, the first hand tags are `browser-v0.2.0`,
   `react-native-v0.2.0`, `ios-v0.2.0`, `plugin-v0.7.0`, `chart-v0.1.1` (each after dating its
   changelog section). The collector x/net fix arrives as a release-please PR
   (`collector 0.3.1`) once #37 is merged.

## Next agent must know

- Write conventional commit titles; do not bump versions by hand. Keep hand notes under
  `## Unreleased`, release-please inserts its section below it.
- A new SDK minor needs its line in `docs/compatibility.md`, or the release PR fails.
- A replay schema change must update the schema table in `docs/compatibility.md`.
- AGENTS.md (not in my paths) should mention the conventional-commit rule and that versions are
  bumped by release PRs; proposed for the orchestrator.
- Not done: SBOM for the iOS package (no third-party dependencies) and the chart (no binaries);
  a scheduled Trivy rescan of the released images; source maps in the SDK tarballs (founder).
- Hand-over note for sibling sessions (conflicts in go.mod / package-lock.json):
  side-session notes `b1-release-supply-chain.md`.
