#!/bin/sh
# Builds hug for macOS/Linux × amd64/arm64 and uploads it to R2 (githug-releases), then
# points hug/latest at it. Served by the Worker at githug.ai/dl/hug/…; githug.ai/install
# installs the latest; the source is published and tagged at github.com/githug-ai/hug.
# Usage: npm run cli:release -- 0.1.0
set -eu
version="${1:?usage: release-hug.sh <version, e.g. 0.1.0>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

cd "$root/cli"
go vet ./...
go test ./...
for target in darwin/amd64 darwin/arm64 linux/amd64 linux/arm64; do
  os="${target%/*}"; arch="${target#*/}"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$out/hug-$os-$arch" .
done
(cd "$out" && shasum -a 256 hug-* > SHA256SUMS)

cd "$root"
for f in "$out"/hug-* "$out/SHA256SUMS"; do
  npx wrangler r2 object put "githug-releases/hug/$version/$(basename "$f")" --file "$f" --remote \
    --content-type application/octet-stream --cache-control "public, max-age=31536000, immutable" >/dev/null
  echo "uploaded hug/$version/$(basename "$f")"
done
printf '%s' "$version" > "$out/latest"
npx wrangler r2 object put githug-releases/hug/latest --file "$out/latest" --remote --content-type text/plain --cache-control "public, max-age=60" >/dev/null
echo "hug/latest → $version"
# Public source + tag for this exact version (github.com/githug-ai/hug).
sh "$root/scripts/publish-hug.sh" "$version"
