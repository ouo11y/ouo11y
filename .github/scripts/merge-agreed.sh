#!/usr/bin/env bash
# Merge a pull request that two sessions agreed on (ADR-0013). Run by the author session.
#
#   .github/scripts/merge-agreed.sh <pr-number>
#
# Refuses unless: the latest comment whose first line starts with "Review:" says "Review: approve"
# and the latest "Author:" comment says "Author: agreed", both posted after the head commit (so a
# push after the approval is not merged unreviewed); every check on the head commit completed and
# none failed; the list of checks is not empty (an empty list is not green). Squash-merges with
# the PR title as the commit subject (release-please reads it; `gh pr merge --squash` would
# otherwise use a single commit's own message) and deletes the branch.
set -euo pipefail

pr="${1:?usage: merge-agreed.sh <pr-number>}"
repo="${REPO:-ouo11y/ouo11y}"

json=$(gh pr view "$pr" --repo "$repo" --json title,url,isDraft,mergeable,headRefOid,state,comments)
state=$(jq -r .state <<<"$json"); [ "$state" = OPEN ] || { echo "PR #$pr is $state"; exit 1; }
[ "$(jq -r .isDraft <<<"$json")" = false ] || { echo "PR #$pr is a draft"; exit 1; }
mergeable=$(jq -r .mergeable <<<"$json")
case "$mergeable" in
  MERGEABLE) ;;
  UNKNOWN) echo "GitHub has not computed mergeability for #$pr yet (just pushed?); retry in a minute"; exit 1;;
  *) echo "PR #$pr is $mergeable: rebase on origin/main first"; exit 1;;
esac
title=$(jq -r .title <<<"$json"); url=$(jq -r .url <<<"$json"); sha=$(jq -r .headRefOid <<<"$json")
head_at=$(gh api "repos/$repo/commits/$sha" --jq '.commit.committer.date')

# Latest comment of each kind, by creation time; its first line is the verdict.
latest() { # $1 = prefix
  jq -r --arg p "$1" --arg t "$head_at" '
    [.comments[] | select(.body | startswith($p))] | sort_by(.createdAt) | last
    | if . == null then "none" elif .createdAt <= $t then "stale: " + (.body | split("\n")[0]) else (.body | split("\n")[0]) end' <<<"$json"
}
review=$(latest "Review:"); author=$(latest "Author:")
[ "$review" = "Review: approve" ] || { echo "latest reviewer comment is not 'Review: approve' after the head commit: $review"; exit 1; }
[ "$author" = "Author: agreed" ] || { echo "latest author comment is not 'Author: agreed' after the head commit: $author"; exit 1; }

runs=$(gh api --paginate "repos/$repo/commits/$sha/check-runs?per_page=100" \
  --jq '.check_runs | group_by(.name) | map(max_by(.id)) | .[] | [.name, .status, (.conclusion // "")] | @tsv')
[ -n "$runs" ] || { echo "no checks ran on $sha (an empty list is not green); wait for ci"; exit 1; }
pending=$(awk -F'\t' '$2 != "completed"' <<<"$runs")
[ -z "$pending" ] || { printf 'checks still running:\n%s\n' "$pending"; exit 1; }
failed=$(awk -F'\t' '$3 ~ /^(failure|cancelled|timed_out|action_required|stale)$/' <<<"$runs")
[ -z "$failed" ] || { printf 'failed checks:\n%s\n' "$failed"; exit 1; }

echo "Merging #$pr: $title ($sha)"
gh pr merge "$pr" --repo "$repo" --squash --delete-branch --match-head-commit "$sha" --subject "$title" --body "$url"
