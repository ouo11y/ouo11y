# ADR-0013 Session-to-session review: two sessions agree on the PR, the author merges

Status: accepted (founder, 2026-10-29, in the session that wrote it; the request: no PR waits on a human during the mobile SDK roadmap, no pile of stale PRs, every session pushes only what it is proud of; the first draft with review, merge and stale bots was rejected as overly complicated)

## Context

The mobile SDK roadmap ([project/kb/mobile-sdk-research/roadmap.md](../../project/kb/mobile-sdk-research/roadmap.md)) runs several sessions in parallel and the founder will review merged work at checkpoints, not PRs. Today a PR waits for a human review and a human merge, so PRs pile up (twelve open on 2026-10-29, five conflicting). Everything runs locally on the founder's Claude Code subscription: no API key, no GitHub App, no bot. The repository is private on the free plan, so GitHub offers no branch protection or auto-merge anyway.

## Decision

The rules, as every session reads them, are one section of `AGENTS.md`: "Review and merge: two sessions, then the author merges". This ADR records why they are what they are; it does not repeat them.

1. **The author session pushes only what it is proud of and has tested enough** (the "Push only what you are proud of" list in `AGENTS.md`). Not proud: no push, say what is missing in the summary.
2. **A second session reviews**, with the whole picture in view: bugs first, then every place the implementation can be simpler or fit the repository better. The two talk until they agree.
3. **CI is always green**: a red check is the author's to fix before the review continues; a red `main` is fixed forward by the session that broke it.
4. **Two comments on the PR are the record**: `Review: approve` (or `changes needed`) with findings and what was verified, `Author: agreed` with what changed and what was left, with reasons.
5. **The author merges** with `.github/scripts/merge-agreed.sh`, which refuses unless the latest review and author comments are newer than the head commit, every check completed and none failed, and the check list is not empty.
6. **A session leaves no PR behind**: merged or closed with a line in its summary. No stale bot.
7. **Releases happen at checkpoints** (roadmap milestones or when the founder says so) through `docs/releasing.md`: the checkpoint session merges the release PRs the same way; the tag is the founder's, or the checkpoint session's when the founder asks.

## Consequences

- Review is a conversation between two sessions with full context of the repository, not a diff comment from a bot; it can catch design problems, not only bugs.
- Every PR costs a second session's time. That is the price of not waiting for a human; it stays well under the cost of a stale PR that has to be rebased by a third session.
- CI is the only machine gate. A broken `main` is fixed forward by the session that broke it, through the same two-session path.
- The founder's checkpoint review is of merged work: the summaries, the PR comment pairs and the benchmark results, not open PRs.
- When the repository goes public or moves to a paid plan, branch protection can require the two comments and CI before merge; nothing in this ADR changes then.
