#!/bin/bash
# Creates (or updates) the "production" GitHub Actions environment in each
# given repository, allows only the main branch to use it, and stores the R2
# deploy credentials as environment secrets. Re-run it to rotate the token.
#
# Usage:
#   cloudflare/tools/setup-deploy-environment.sh whatwg/whatwg.org ...
#
# The values of the R2 token aren't stored anywhere: the script asks for them
# (the secret key without echo), or takes them from environment variables of
# the same names if all three are set. Each run therefore uses a new token,
# which replaces the old one everywhere: create a new R2 token, run this for
# whatwg/whatwg.org and spec-factory's factory.py --settings --all for the
# standards, then delete the old token.
#
# Needs `gh` logged in as someone with admin access to the repositories.
#
# The environment names main explicitly ("selected branches"), rather than
# using "protected branches only": that option only recognizes classic branch
# protection, not rulesets, and if a repository has no classic protection at
# all it lets every branch deploy. Protecting main itself (with a ruleset) is
# what makes "merged to main" mean "reviewed"; this script checks that main
# has a ruleset requiring pull requests, and refuses otherwise.

set -o errexit -o nounset -o pipefail

ENV=${ENV:-production}
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

if [[ $# -eq 0 ]]; then
  echo "usage: $0 owner/repo..." >&2
  exit 1
fi

failed=0
for repo in "$@"; do
  echo "== $repo"

  # Rules that apply to main, from rulesets only (classic protection isn't
  # included in this endpoint). REQUIRE_RULESET=0 skips this, e.g. for a fork
  # used for testing.
  if [[ "${REQUIRE_RULESET:-1}" != 0 ]]; then
    rules=$(gh api "repos/$repo/rules/branches/main" --jq '.[].type')
    if ! grep -qx pull_request <<<"$rules"; then
      echo "error: main in $repo has no ruleset requiring pull requests; skipping" >&2
      failed=1
      continue
    fi
  fi

  gh api --silent -X PUT "repos/$repo/environments/$ENV" --input - <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON

  # Allow the main branch (type=branch, so a tag named main doesn't match).
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

  # Show the result.
  gh api "repos/$repo/environments/$ENV/deployment-branch-policies" \
    --jq '"  allowed: " + ([.branch_policies[] | .type + " " + .name] | join(", "))'
done

exit "$failed"
