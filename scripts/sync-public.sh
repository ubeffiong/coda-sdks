#!/usr/bin/env bash
# Publishes this folder (sdks/ in the private CODA repository) as the root of the public
# repository ubeffiong/coda-sdks, keeping its history. Run from anywhere in the CODA checkout:
#
#   bash sdks/scripts/sync-public.sh            # push main
#   bash sdks/scripts/sync-public.sh v0.1.0     # push main and tag a release (runs release.yml)
#
# Only sdks/ is published; nothing else from the private repository leaves it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

remote="${CODA_SDKS_REMOTE:-https://github.com/ubeffiong/coda-sdks.git}"
tag="${1:-}"

if [[ -n "$(git status --porcelain -- sdks)" ]]; then
  echo "Commit the changes under sdks/ first." >&2
  exit 1
fi

git subtree split --prefix=sdks -b coda-sdks-public >/dev/null
git push "$remote" coda-sdks-public:main

if [[ -n "$tag" ]]; then
  bash sdks/scripts/check-versions.sh "${tag#v}"
  git tag -f "sdks-$tag" coda-sdks-public
  git push "$remote" "coda-sdks-public:refs/tags/$tag"
fi
echo "Published sdks/ to $remote${tag:+ and tagged $tag}."
