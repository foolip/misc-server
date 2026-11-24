#!/bin/bash
# Sets up the GitHub settings that deploying to whatwg-sites needs, in each
# given repository, or by default in all of them (whatwg/whatwg.org and every
# standard in whatwg/sg's db.json, see whatwg-repos.sh):
#
#   - main must have a ruleset requiring pull requests (see
#     setup-main-ruleset.sh), or the repository is skipped;
#   - the "production" environment is created or updated so that only the main
#     branch can use it;
#   - its secrets R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ENDPOINT are set.
#
# Usage:
#   cloudflare/tools/setup-repositories.sh [owner/repo...]
#
# The values of the R2 token aren't stored anywhere: the script asks for them
# (the secret key without echo), or takes them from environment variables of
# the same names if all three are set. Each run therefore uses a new token,
# which replaces the old one everywhere, and is also how a new standard gets
# set up: create a new R2 token (Object Read & Write on whatwg-sites), run this
# without arguments, then delete the old token.
#
# Needs `gh` logged in as someone with admin access to the repositories, and jq.
# Exits with status 1 if any repository couldn't be set up.
#
# The environment names main explicitly ("selected branches"), rather than
# using "protected branches only": that option only recognizes classic branch
# protection, not rulesets, and if a repository has no classic protection at
# all it lets every branch deploy. Protecting main itself (with a ruleset) is
# what makes "merged to main" mean "reviewed".

set -o errexit -o nounset -o pipefail

ENV=${ENV:-production}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ $# -gt 0 ]]; then
  repos=("$@")
else
  mapfile -t repos < <("$HERE/whatwg-repos.sh")
fi

if [[ -z "${R2_ACCESS_KEY_ID:-}" || -z "${R2_SECRET_ACCESS_KEY:-}" || -z "${R2_ENDPOINT:-}" ]]; then
  echo "Values of the new R2 API token (Cloudflare shows them when the token is created):"
  read -r -p "  R2_ACCESS_KEY_ID: " R2_ACCESS_KEY_ID
  read -r -s -p "  R2_SECRET_ACCESS_KEY: " R2_SECRET_ACCESS_KEY; echo
  read -r -p "  R2_ENDPOINT: " R2_ENDPOINT
  if [[ -z "$R2_ACCESS_KEY_ID" || -z "$R2_SECRET_ACCESS_KEY" || -z "$R2_ENDPOINT" ]]; then
    echo "error: all three values are needed" >&2
    exit 1
  fi
fi

setup_repo() {
  local repo=$1

  # Rules that apply to main, from rulesets only (classic protection isn't
  # included in this endpoint). REQUIRE_RULESET=0 skips this, e.g. for a fork
  # used for testing.
  if [[ "${REQUIRE_RULESET:-1}" != 0 ]]; then
    local rules
    rules=$(gh api "repos/$repo/rules/branches/main" --jq '.[].type')
    if ! grep -qx pull_request <<<"$rules"; then
      echo "  error: main has no ruleset requiring pull requests; not setting up the $ENV environment" >&2
      return 1
    fi
  fi

  gh api --silent -X PUT "repos/$repo/environments/$ENV" --input - <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON

  # Allow the main branch (type=branch, so a tag named main doesn't match).
  local existing
  existing=$(gh api "repos/$repo/environments/$ENV/deployment-branch-policies" \
    --jq '.branch_policies[] | select(.name == "main" and .type == "branch") | .id')
  if [[ -z "$existing" ]]; then
    gh api --silent -X POST "repos/$repo/environments/$ENV/deployment-branch-policies" \
      -f name=main -f type=branch
  fi

  # Secrets via stdin, so they don't show up in the process list.
  printf '%s' "$R2_ACCESS_KEY_ID"     | gh secret set R2_ACCESS_KEY_ID     --repo "$repo" --env "$ENV"
  printf '%s' "$R2_SECRET_ACCESS_KEY" | gh secret set R2_SECRET_ACCESS_KEY --repo "$repo" --env "$ENV"
  printf '%s' "$R2_ENDPOINT"          | gh secret set R2_ENDPOINT          --repo "$repo" --env "$ENV"

  gh api "repos/$repo/environments/$ENV/deployment-branch-policies" \
    --jq '"  allowed: " + ([.branch_policies[] | .type + " " + .name] | join(", "))'
}

failed=()
for repo in "${repos[@]}"; do
  echo "== $repo"
  # A subshell with errexit, so that one failing repository doesn't stop the
  # others. (errexit is ignored in a function called from a condition.)
  set +o errexit
  (set -o errexit; setup_repo "$repo")
  status=$?
  set -o errexit
  [[ $status -eq 0 ]] || failed+=("$repo")
done

if [[ ${#failed[@]} -gt 0 ]]; then
  echo ""
  echo "Not set up: ${failed[*]}" >&2
  exit 1
fi
