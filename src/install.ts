/**
 * githug.ai/install — the `hug` installer (ROADMAP Track B, M1.6). POSIX sh, no sudo:
 * picks the platform binary from githug.ai/dl, checks its SHA-256, installs to
 * $HUG_INSTALL_DIR, else /usr/local/bin if writable, else ~/.local/bin.
 * Agents run it in fresh sandboxes, so it is quiet, idempotent, and says what to put on PATH.
 */
export function installScript(origin: string, instance?: string): string {
  return `#!/bin/sh
# hug installer — ${origin}/install · source: https://github.com/githug-ai/hug (Apache-2.0)
#   curl -fsSL ${origin}/install | sh
# Env: HUG_VERSION (default: latest), HUG_INSTALL_DIR (default: /usr/local/bin if writable, else ~/.local/bin)
set -eu

base="${origin}/dl/hug"
fail() { echo "hug install: $*" >&2; exit 1; }
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"; else fail "need curl or wget"; fi; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS $(uname -s) (macOS and Linux only)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac

version="\${HUG_VERSION:-$(fetch "$base/latest")}"
[ -n "$version" ] || fail "could not find the latest version"
name="hug-$os-$arch"

dir="\${HUG_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
fi
mkdir -p "$dir"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fetch "$base/$version/$name?src=install" > "$tmp/hug" || fail "download failed: $base/$version/$name"
fetch "$base/$version/SHA256SUMS" > "$tmp/SHA256SUMS" || fail "checksum download failed"
want="$(grep " $name\\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/hug" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/hug" | cut -d' ' -f1)"; fi
[ -n "$want" ] && [ "$want" = "$got" ] || fail "checksum mismatch for $name"

chmod 755 "$tmp/hug"
mv "$tmp/hug" "$dir/hug"
echo "hug $version installed to $dir/hug"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add it to PATH: export PATH=\\"$dir:\\$PATH\\"" ;;
esac
echo "Next: hug init --repo owner/repo${instance ? ` --url ${instance}` : ""}"
`;
}
