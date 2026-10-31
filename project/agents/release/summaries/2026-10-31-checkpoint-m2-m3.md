# 2026-10-31: release checkpoint for M2 and M3

The founder asked for the open release PRs to ship ("Yes ship them. And old releases PR"). This
session merged them one at a time under ADR-0013 (reviewer session `Review: approve` after the last
commit, `Author: agreed`, `.github/scripts/merge-agreed.sh`) and pushed the tags as
`docs/releasing.md` section 5 shows.

## Shipped

| Component | Release PR, merge commit | Tag | Publish run | Verified |
|---|---|---|---|---|
| rum-api 0.6.0 | #111, `819d985` | `rum-api-v0.6.0` | `release-images` 41193630030, green | `imagetools inspect`: amd64 + arm64; GitHub release; PR `autorelease: tagged` |
| collector 0.5.0 | #93, `846b3eb` | `collector-v0.5.0` | `release-images` 41194336682, green | amd64 + arm64; release; label |
| plugin 0.10.0 | #115, `a379966` | `plugin-v0.10.0` | `release-plugin` 41194979671, green | zip, CycloneDX SBOM, md5 / sha1, SHA256SUMS on the release (unsigned: no grafana.com token) |
| grafana image 0.6.0 | #113, `4354873` (after #126 `feat(grafana): ship plugin 0.10.0`, `9e18d20`) | `grafana-v0.6.0` | `release-images` 41196117069, green | amd64 + arm64; `plugin.json` in the image says 0.10.0; base 13.2.5 (CVE-2026-111497 fix) |
| chart 0.2.0 | #95, `f3adbfd` | `chart-v0.2.0` | tag run `release-chart` 41200375608 failed; published by dispatch 41242867986 (after #133), green | `helm show chart oci://ghcr.io/ouo11y/charts/ouo --version 0.2.0`: appVersion 0.6.0, digest `sha256:71e2e37a…`; release with `ouo-0.2.0.tgz` + SHA256SUMS |
| ios 0.3.0 | #94, `4fcf425` (includes W8 part 2, `64d5056`) | `ios-v0.3.0` | `release-ios` 41201437767, green, **dry run** | swift tests and subtree split pass; mirror push skipped: no `OUO_IOS_DEPLOY_KEY` |

Grafana 0.5.1 (the CVE fix alone) was never released: tagged on that day's `main` it would have
carried the unreleased plugin code under the 0.9.0 name. Its fix ships in 0.6.0.

Follow-up PRs, each reviewed and merged:

- #128 `fix(deploy)`: `deploy/compose/quickstart.yaml` regenerated (versions and digests), the
  tiny-shop guide embed, the pins in `.env.example`, `compose.images.yaml` and
  `examples/fast-tracked/00-stack.md`. `main`'s `quickstart.yaml in sync` was red from the
  rum-api tag until this merged (57745fd green).
- #129 `fix(chart)`: chart defaults rum-api 0.6.0, collector 0.5.0, grafana 0.6.0, `appVersion`
  0.6.0, before the chart release. The rendered rum-api config passes `rum-api:0.6.0
  -config.verify`, the collector config `collector:0.5.0 validate`.
- #130 `fix(sdk)`: `src/version.ts` of both SDKs bumped by release-please (`ouo.sdk.version`
  said 0.2.0 in browser 0.3.0), with a test against `package.json`. It opened browser 0.3.1 (#131).

## Waiting for 2026-11-01 (hosted runner)

- #112 react-native 0.3.0 (head `f92fc00`) and #131 browser 0.3.1 (head `6feb132`) are approved,
  **not merged**. Section 5 step 3: rehearse `release-npm` on each final head
  (`gh workflow run release-npm.yml --ref <branch> -f tag=<tag>`), then merge and tag. The two
  manifest lines are adjacent: the second to merge needs a merge of `main` and a fresh approval.
  The react-native minor opts out of the device benchmark (hosted only as well).
- Then the release trains row in the root `CHANGELOG.md` (step 10) and its Packages table, which
  still shows the 0.3.0-era versions.

## Chart blocker (resolved the same day)

The tag run 41200375608 passed the version check, compat, lint, template and package, then failed
at `helm registry login`: `mkdir /home/runner-2/.config/helm: permission denied` (`~/.config` is
not writable by `runner-N` on the self-hosted runners). Dry runs never log in, so the rehearsals
could not see it, and a re-run uses the tag commit's copy of the workflow. The founder was away;
the coordinator chose the workflow fix: #133 (`f873f46`, reviewed by a background session) keeps
helm's config, cache, data and registry files under `$RUNNER_TEMP` and adds `publish` to the
`workflow_dispatch` (checks out `refs/tags/<tag>`, pushes like the tag run; `docs/releasing.md`
section 6). `gh workflow run release-chart.yml --ref main -f tag=chart-v0.2.0 -f publish=true`
(run 41242867986) published 0.2.0 from the existing tag; no tag was moved or created.

## Founder-only steps

- Chart: GitHub > Packages > `charts/ouo` > Package settings: choose its visibility. It is
  already linked to `ouo11y/ouo11y` and was created **private** (the images are public since
  2026-10-31).
  The runners' `~/.config` ownership no longer matters to `release-chart`.
- iOS: create `OUO_IOS_DEPLOY_KEY` (`docs/releasing.md` section 8), then re-run run 41201437767
  to push `main` and tag `0.3.0` to `ouo11y/ouo11y-ios`; make `main` the mirror's default branch
  and delete `about`.
- Optional: `RELEASE_PLEASE_TOKEN`, so release PRs run their checks without a push or a reopen;
  `GRAFANA_ACCESS_POLICY_TOKEN` to sign the plugin.

## What the next session must know

Lessons are in `project/kb/release-automation.md` ("Release checkpoint lessons"): manifest
conflicts between release PRs, `ci.yml` has no dispatch, hand edits are wiped when a component's
commit lands, compat rows go in their own release PR, release-please links to missing tags, the
helm login on the runners. New checklist item N80 (chart upload path). In this worktree npm fails
at the repository root ("Exit prior to config file resolving") and works from a workspace folder.

Follow-up (N81): `rum-api 0.6.0` shows as "Latest" on GitHub releases although every publish
workflow passes `--latest=false` (`docs/releasing.md` section 1: no component release is latest).

No env was started; nothing is left running.
