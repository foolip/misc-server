#!/bin/bash
# Prints the repositories that deploy to whatwg-sites: whatwg/whatwg.org and
# the repository of every standard in whatwg/sg's db.json (the same list
# spec-factory uses), one per line. Sourced or run by the setup scripts.

set -o errexit -o nounset -o pipefail

echo whatwg/whatwg.org
gh api repos/whatwg/sg/contents/db.json --jq .content | base64 -d \
  | jq -r '.workstreams[].standards[].href' \
  | sed -E 's|^https://([^.]+)\..*$|whatwg/\1|'
