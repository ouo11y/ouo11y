# ADR-0013 Session-to-session review: two sessions agree on the PR, the author merges

Status: proposed (2026-10-29, at the founder's request: no PR waits on a human during the mobile SDK roadmap, no pile of stale PRs, every session pushes only what it is proud of; the first draft with review, merge and stale bots was rejected as overly complicated)

## Context

The mobile SDK roadmap ([project/kb/mobile-sdk-research/roadmap.md](../../project/kb/mobile-sdk-research/roadmap.md)) runs several sessions in parallel and the founder will review merged work at checkpoints, not PRs. Today a PR waits for a human review and a human merge, so PRs pile up (twelve open on 2026-10-29, five conflicting). Everything runs locally on the founder's Claude Code subscription: no API key, no GitHub App, no bot. The repository is private on the free plan, so GitHub offers no branch protection or auto-merge anyway.

## Decision

1. **The author session pushes only what it is proud of and has tested enough.** The "Before you push" list in `AGENTS.md` is the bar. Not proud: no push, say what is missing in the summary.
2. **A second session reviews.** The author starts it (or the founder does) with a brief: the PR number, what the change is for, what to test. The reviewer reads the diff and the code around it, runs the tests and the relevant checks, and tells the author session directly (session message) about every bug and every place the design can be simpler. The reviewer looks at the whole picture, not only the diff: does the change fit the specs, the ADRs and how the rest of the repository does the same thing, and is there a simpler implementation with fewer concepts, files and options. "Works but could be simpler" is a finding the author answers by simplifying or by writing down why not. The two talk until they agree; the author pushes the fixes.
3. **CI is always green.** A red check on the PR is the author's to fix before the review continues; a red `main` is fixed forward by the session that broke it, while it runs. Nothing merges over a failed check.
4. **Both post one comment on the PR.** The reviewer: `Review: approve` or `Review: changes needed`, then the findings and what was verified and how. The author: `Author: agreed`, what was changed in response and what was left as is, with the reason. The two comments are the record; nothing else is required on the PR.
5. **With both comments present and CI green, the author merges**: squash, PR title as the commit subject (release-please reads it), branch deleted. `.github/scripts/merge-agreed.sh <pr>` does exactly that and refuses when a check failed, when the check list is empty, or when either comment is missing.
6. **A session leaves no PR behind.** Before it ends, its PR is merged or closed with a line in its summary saying why. There is no stale bot; the rule is the session's.
7. **Releases happen at checkpoints**, not per merge: the roadmap's milestones (M1 to M6) or whenever the founder says so. The release path in `docs/releasing.md` is unchanged: release-please opens the release PRs, the checkpoint session reviews and merges them the same way, and the tag is pushed by the founder, or by the checkpoint session when the founder asks for it.

## Consequences

- Review is a conversation between two sessions with full context of the repository, not a diff comment from a bot; it can catch design problems, not only bugs.
- Every PR costs a second session's time. That is the price of not waiting for a human; it stays well under the cost of a stale PR that has to be rebased by a third session.
- CI is the only machine gate. A broken `main` is fixed forward by the session that broke it, through the same two-session path.
- The founder's checkpoint review is of merged work: the summaries, the PR comment pairs and the benchmark results, not open PRs.
- When the repository goes public or moves to a paid plan, branch protection can require the two comments and CI before merge; nothing in this ADR changes then.
