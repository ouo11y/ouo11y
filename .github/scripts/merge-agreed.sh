#!/usr/bin/env bash
# Merge a pull request that two sessions agreed on (ADR-0013). Run by the author session.
#
#   .github/scripts/merge-agreed.sh <pr-number>
#
# Refuses unless: a "Review: approve" comment and an "Author: agreed" comment exist, every check
# on the head commit completed and none failed, and the list of checks is not empty (an empty
# list is not green). Squash-merges with the PR title as the commit subject (release-please reads
# it; `gh pr merge --squash` would otherwise use a single commit's own message) and deletes the branch.
set -euo pipefail

pr="${1:?usage: merge-agreed.sh <pr-number>}"
repo="${REPO:-ouo11y/ouo11y}"

json=$(gh pr view "$pr" --repo "$repo" --json title,url,isDraft,mergeable,headRefOid,state,comments)
state=$(jq -r .state <<<"$json"); [ "$state" = OPEN ] || { echo "PR #$pr is $state"; exit 1; }
[ "$(jq -r .isDraft <<<"$json")" = false ] || { echo "PR #$pr is a draft"; exit 1; }
[ "$(jq -r .mergeable <<<"$json")" = MERGEABLE ] || { echo "PR #$pr is not mergeable (conflicts?): rebase first"; exit 1; }
title=$(jq -r .title <<<"$json"); url=$(jq -r .url <<<"$json"); sha=$(jq -r .headRefOid <<<"$json")

bodies=$(jq -r '.comments[].body' <<<"$json")
grep -qE '^Review: approve' <<<"$bodies" || { echo "no 'Review: approve' comment from the reviewer session"; exit 1; }
grep -qE '^Author: agreed' <<<"$bodies" || { echo "no 'Author: agreed' comment from the author session"; exit 1; }

runs=$(gh api --paginate "repos/$repo/commits/$sha/check-runs?per_page=100" \
  --jq '.check_runs | group_by(.name) | map(max_by(.id)) | .[] | [.name, .status, (.conclusion // "")] | @tsv')
[ -n "$runs" ] || { echo "no checks ran on $sha (an empty list is not green); wait for ci"; exit 1; }
if grep -v $'\tcompleted\t' <<<"$runs" | grep -q .; then echo "checks still running:"; grep -v $'\tcompleted\t' <<<"$runs"; exit 1; fi
if grep -E $'\t(failure|cancelled|timed_out|action_required|stale)$' <<<"$runs" | grep -q .; then
  echo "failed checks:"; grep -E $'\t(failure|cancelled|timed_out|action_required|stale)$' <<<"$runs"; exit 1
fi

echo "Merging #$pr: $title ($sha)"
gh pr merge "$pr" --repo "$repo" --squash --delete-branch --match-head-commit "$sha" --subject "$title" --body "$url"
