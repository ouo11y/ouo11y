#!/usr/bin/env bash
# Repository settings for the automated merge and release path (ADR-0013). The founder runs it
# once with an account that administers ouo11y/ouo11y; agents do not change repository settings.
#
#   .github/scripts/repo-settings.sh            # apply settings, create labels, report secrets
#   .github/scripts/repo-settings.sh --check    # report only
set -euo pipefail

repo="${REPO:-ouo11y/ouo11y}"
check=false
[ "${1:-}" = "--check" ] && check=true

echo "== $repo"
if [ "$check" = false ]; then
  # Branches of merged PRs go away on their own (merge-ready passes --delete-branch too).
  gh api -X PATCH "repos/$repo" -F delete_branch_on_merge=true --silent
  # Labels the workflows use.
  gh label create ready        --repo "$repo" --color 0e8a16 --description "the owning session is proud of it: merge when green (ADR-0013)" --force
  gh label create needs-rebase --repo "$repo" --color d93f0b --description "ready but conflicts with main" --force
  gh label create stale        --repo "$repo" --color ededed --description "no activity for 4 days; closes after 7 more" --force
  gh label create keep-open    --repo "$repo" --color 1d76db --description "exempt from the stale rule, with a reason in a comment" --force
fi

gh api "repos/$repo" --jq '"delete_branch_on_merge: \(.delete_branch_on_merge)  allow_squash_merge: \(.allow_squash_merge)  visibility: \(.visibility)"'
gh api "repos/$repo/actions/permissions/workflow" --jq '"actions can approve PRs: \(.can_approve_pull_request_reviews)  default workflow permissions: \(.default_workflow_permissions)"'

echo "== secrets the automation needs (Settings > Secrets and variables > Actions)"
have=$(gh secret list --repo "$repo" --json name --jq '.[].name' 2>/dev/null || true)
for s in ANTHROPIC_API_KEY RELEASE_PLEASE_TOKEN; do
  if grep -qx "$s" <<<"$have"; then echo "  ok       $s"; else echo "  MISSING  $s"; fi
done
cat <<'EOF'
  ANTHROPIC_API_KEY     pr-review.yml (Claude reviews every push; no key = the "review" check fails = no merge)
  RELEASE_PLEASE_TOKEN  merge-ready.yml and release-please.yml: a merge or tag made with GITHUB_TOKEN
                        triggers no workflow, so without it the chain stops after the first merge.
                        Fine-grained PAT, this repository only: Contents, Pull requests, Issues read/write.
EOF
echo "== open PRs by state"
gh pr list --repo "$repo" --state open --limit 100 --json number,isDraft,mergeStateStatus,labels,title \
  --jq '.[] | "  #\(.number)\t\(if .isDraft then "draft" else "open" end)\t\(.mergeStateStatus)\t\([.labels[].name] | join(","))\t\(.title)"'
