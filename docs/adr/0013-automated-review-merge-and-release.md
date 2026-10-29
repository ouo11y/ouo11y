# ADR-0013 Automated review, merge and release: a PR lands or dies without a human

Status: proposed (2026-10-29, at the founder's request: "fully automated review and release, do not keep a ton of PRs open and stale; every session pushes only what it is proud of")

## Context

The mobile SDK roadmap ([project/kb/mobile-sdk-research/roadmap.md](../../project/kb/mobile-sdk-research/roadmap.md)) is ten work packages across three to five parallel sessions. The founder will not follow each PR and will do a general review only after the last package. Today a PR waits for a human at three points: review, merge, and the tag that publishes a release (`docs/releasing.md` section 5, "the founder pushes every tag"). With nobody waiting at those points, PRs pile up: on 2026-10-29 the repository had twelve open PRs, five of them conflicting and three of them release PRs nobody merged.

Constraints:

- The repository is **private on the free plan**: no branch protection, no rulesets, no required checks, no GitHub auto-merge and no merge queue (the API answers `403 Upgrade to GitHub Pro`). Whatever gates a merge has to be a workflow of ours.
- `GITHUB_TOKEN` pushes and merges trigger no workflows. The chain "merge → release PR → checks → merge → tag → publish" runs only with `RELEASE_PLEASE_TOKEN` (a fine-grained PAT, `docs/releasing.md` section 8).
- The founder's standing rules: one PR at a time, no mass rebases, merge only when every check passed and the check list is not empty ([project/kb/release-automation.md](../../project/kb/release-automation.md)).
- Reviews by a Claude session cost tokens; one review per push is fine, a review loop on every comment is not.

## Decision

1. **A PR is reviewed by Claude on every push** (`.github/workflows/pr-review.yml`, `anthropics/claude-code-action`). The review reads the diff against `AGENTS.md` (the "Before you push" list, the engineering conventions, the definition of done) and the files the PR touches, then posts exactly one pull request review whose first line is `Verdict: approve` or `Verdict: request-changes`, with the findings. A second step turns the verdict into the check `review`: success only when the latest bot review for the head commit is an approval. No `ANTHROPIC_API_KEY` secret means the check fails, never a silent pass. Drafts and release-please PRs are not reviewed (nothing to review in a generated changelog; `release-check` covers them).

2. **A PR merges itself when it is ready and green** (`.github/workflows/merge-ready.yml`). The session that owns a PR adds the label `ready` when it is proud of the work (decision 4). The workflow runs after every `ci`, `pr-review` and `release-check` completion and every 30 minutes, takes the oldest open PR labelled `ready` that is not a draft and has no conflicts, requires every check run on its head commit to be completed and none failed, and requires the named checks `changed paths`, `PR title (conventional commit)` and `review` to be successes. It squash-merges with the PR title as the commit subject (release-please reads it) and deletes the branch. **One PR per run**, in creation order: the next run picks the next one after `ci` on `main` completes, which keeps the founder's one-at-a-time rule without a merge queue. A `ready` PR with conflicts gets one comment, loses `ready` and gains `needs-rebase`; its session (or the stale rule) takes it from there.

3. **Releases are cut by the bot, once a day.** `skip-github-release` is turned off: merging a release PR makes release-please create the tag and the GitHub release, which triggers the publish workflows (`release-npm`, `release-images`, `release-ios`, `release-plugin`, `release-chart`) as a hand-pushed tag did. Release PRs (`autorelease: pending`, title `chore(main): release …`) are merged by `merge-ready` only in its daily 06:00 UTC run (or on dispatch), after `changed paths`, `compatibility matrix` and `e2e scenario` succeeded, so a day's merges become one release per component rather than one release per merge. The founder no longer pushes tags; `docs/releasing.md` section 5 becomes the bot's checklist.

4. **Push only what you are proud of.** `AGENTS.md` gets a "Before you push" list that every session runs before `git push` and again before adding `ready`: tests and vet pass locally with the commands in the tracker, the conformance checks of what the PR touches pass, lychee is clean, the summary and kb entries are written, no test was skipped or weakened, no secret or business material is in the diff, the PR title is a conventional commit, and the author would sign the diff with their name. A session that is not proud does not push: it writes in its summary what is missing and leaves the branch local, or opens a draft without `ready`. A session never ends with a non-draft PR that lacks either `ready` or a closing comment saying why it stays open and until when.

5. **Stale PRs close themselves** (`.github/workflows/stale.yml`): no activity for 4 days → label `stale` and a comment; 7 more days → closed and the branch deleted. `autorelease: pending` and `keep-open` are exempt. Issues are untouched.

6. **Repository settings** stay the founder's: `.github/scripts/repo-settings.sh` sets `delete_branch_on_merge`, creates the labels and reports which secrets are missing; the founder runs it once.

## Consequences

- From "push" to "published" there is no human step. The quality gates are the checks, the Claude review, the benchmark gate on `react-native` releases (`docs/benchmarks.md` section 5, run by `benchmark.yml`), and the self-review in decision 4. The founder's general review after the roadmap is a review of merged work.
- A broken `main` is possible when a review and the checks both miss something. The answer is a fix PR through the same path, which takes minutes, not a human gate.
- Reviews cost one Claude run per push. Sessions should push finished work, not every commit; `concurrency` cancels a review when a newer push arrives.
- Without `RELEASE_PLEASE_TOKEN` (and `ANTHROPIC_API_KEY`), nothing merges and nothing releases; the workflows say so in their logs. Those two secrets are the founder's part.
- Releases become frequent (up to one per component per day). The publish workflows already rehearse on every change to themselves; `release-npm` needs the trusted-publisher setup on npmjs.com first (section 8), otherwise the tag exists and the publish fails, which is visible in Actions and in the missing npm version.
- When the repository goes public (checklist N20) or moves to a paid plan, GitHub branch protection with required checks and auto-merge can replace `merge-ready`; the review and stale workflows stay.
- The founder's earlier decision that every tag is pushed by hand (`docs/releasing.md`, `project/kb/release-automation.md`) is reversed by this ADR.
