#!/bin/sh
# Publishes cli/ as the public source of hug (github.com/githug-ai/hug) and tags it, so every
# binary on githug.ai has a matching public tag. Called by release-hug.sh; safe to rerun.
#   Usage: sh scripts/publish-hug.sh <version, e.g. 0.4.1>
set -eu
version="${1:?usage: publish-hug.sh <version>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone -q https://github.com/githug-ai/hug.git "$tmp/hug"
cd "$tmp/hug"
# Mirror cli/ exactly (keep the clone's .git).
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$root/cli/." .
git add -A
if ! git diff --cached --quiet; then
  git -c user.name=githug -c user.email=hello@githug.ai commit -q -m "hug $version"
fi
git tag -f "v$version" >/dev/null
git push -q origin HEAD:main
git push -q -f origin "v$version"
echo "published github.com/githug-ai/hug v$version"
