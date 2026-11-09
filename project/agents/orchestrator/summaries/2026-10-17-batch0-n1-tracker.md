# 2026-10-17 Batch 0, step 3: N1 tracker cleanup and founder decisions

## Done

- **Checklist** (`project/tracker/checklist.md`): #23 ticked as merged; N1 ticked with what was fixed; N2, N3, B6, B3, N6, N14, B8 rewritten with the founder's 2026-10-17 decisions; new N17 (Sentry vs ouo platform list, one SDK spec with a conformance suite); "Founder decisions" section (a) to (g); open-decision list cut to what is still open (B4 publishing, B8 hosted demo, F4 verdict, old stack volumes).
- **Roadmap**: 8a phase row names PR #14 and what is still open; the Phase 12 bridge line points at the bridge section instead of repeating S1 to S4; bridge section lists #16, #17, #23 as merged and ADR-0008 accepted; the 8a publish line records the 0.2.0 tags; B3 platforms prefer the real iPhone; F4 verdict pending; a dated block with the founder's decisions under the backlog.
- **ADR-0008 accepted** (status line, `docs/adr-archive/README.md`, `docs/index.md`, spec `docs/specs/sentry-bridge.md` now normative).
- **Release**: `project/agents/release/summaries/2026-10-16-image-releases.md` has a dated update (the founder pushed `rum-api-v0.2.0`, `collector-v0.2.0`, `grafana-v0.2.0`; `release-images` green; GitHub releases exist); `collector/CHANGELOG.md` and `deploy/images/grafana/CHANGELOG.md` 0.2.0 dated; root `CHANGELOG.md` plugin 0.6.0 and the three image versions; release tracker row.
- **Agent trackers**: stale "blocked: Xcode", "pending Xcode", "review" and "live run owed" rows in ios-replay, sdk-react-native, qa, grafana-plugin, sdk-browser and platform-infra resolved with the PR that merged them and the verification that happened later (Phase 7 native run, 8a rev 2 QA run).

## Verified (how)

- PR numbers, merge dates and tags from `gh pr list --state all`, `git tag`, `gh run list --workflow release-images.yml` (three green tag runs) and `gh release list`; the grafana image's plugin version from its release notes (0.6.0); the plugin version from `plugins/ouo-rum-app/package.json`.
- lychee offline: 0 broken links.

## Left

- Decisions still open are listed at the end of the checklist. `services/rum-api/CHANGELOG.md` does not exist although rum-api 0.2.0 is tagged (B4 scope).
