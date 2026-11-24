#!/bin/bash
# Creates (or updates) the ruleset protecting the default branch in each given
# repository, replacing classic branch protection:
#
#   - no deletion
#   - no force pushes
#   - linear history
#   - changes only through a pull request with 1 approval
#   - status checks "Participation" and "Build" must pass
#   - nobody can bypass these rules
#
# Usage:
#   cloudflare/tools/setup-main-ruleset.sh [owner/repo...]
#
# Without arguments: whatwg/whatwg.org and every standard in whatwg/sg's
# db.json (see whatwg-repos.sh).
#
# Options (environment variables):
#   DELETE_CLASSIC=1  delete the classic branch protection on the default
#                     branch once the ruleset is active
#   FORCE=1           apply even if the default branch's latest commit doesn't
#                     report both required checks (otherwise such a repository
#                     is skipped, because every PR there would be blocked)
#
# Needs `gh` logged in as someone with admin access to the repositories.

set -o errexit -o nounset -o pipefail

NAME=main
REQUIRED_CHECKS=(Participation Build)

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ $# -gt 0 ]]; then
  repos=("$@")
else
  mapfile -t repos < <("$HERE/whatwg-repos.sh")
fi

checks_json=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | jq -R '{context: .}' | jq -s .)

ruleset=$(jq -n --arg name "$NAME" --argjson checks "$checks_json" '{
  name: $name,
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: {ref_name: {include: ["~DEFAULT_BRANCH"], exclude: []}},
  rules: [
    {type: "deletion"},
    {type: "non_fast_forward"},
    {type: "required_linear_history"},
    {type: "pull_request", parameters: {
      required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_review_thread_resolution: false
    }},
    {type: "required_status_checks", parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: $checks
    }}
  ]
}')

failed=0
for repo in "${repos[@]}"; do
  echo "== $repo"
  branch=$(gh api "repos/$repo" --jq .default_branch)

  # Every required check must exist, or no PR could ever be merged.
  reported=$( (gh api "repos/$repo/commits/$branch/check-runs" --paginate --jq '.check_runs[].name'
               gh api "repos/$repo/commits/$branch/status" --jq '.statuses[].context') | sort -u)
  missing=()
  for check in "${REQUIRED_CHECKS[@]}"; do
    grep -qxF "$check" <<<"$reported" || missing+=("$check")
  done
  if [[ ${#missing[@]} -gt 0 && "${FORCE:-0}" != 1 ]]; then
    echo "error: $branch in $repo doesn't report check(s): ${missing[*]}; skipping (FORCE=1 to apply anyway)" >&2
    failed=1
    continue
  fi

  id=$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$NAME\" and .target == \"branch\") | .id")
  if [[ -n "$id" ]]; then
    echo "  updating ruleset $id"
    gh api --silent -X PUT "repos/$repo/rulesets/$id" --input - <<<"$ruleset"
  else
    echo "  creating ruleset"
    gh api --silent -X POST "repos/$repo/rulesets" --input - <<<"$ruleset"
  fi

  # Confirm the rules are in effect on the default branch.
  active=$(gh api "repos/$repo/rules/branches/$branch" --jq '.[].type' | sort -u)
  for type in deletion non_fast_forward required_linear_history pull_request required_status_checks; do
    if ! grep -qx "$type" <<<"$active"; then
      echo "error: rule $type isn't active on $branch in $repo" >&2
      failed=1
      continue 2
    fi
  done
  echo "  active on $branch: $(tr '\n' ' ' <<<"$active")"

  if [[ "${DELETE_CLASSIC:-0}" == 1 ]]; then
    if gh api --silent "repos/$repo/branches/$branch/protection" 2>/dev/null; then
      gh api --silent -X DELETE "repos/$repo/branches/$branch/protection"
      echo "  deleted classic branch protection"
    else
      echo "  no classic branch protection"
    fi
  fi
done

exit "$failed"
