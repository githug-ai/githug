#!/bin/sh
# Builds the public githug repository: this repo's tracked files at HEAD as ONE commit
# authored `githug <hello@githug.ai>`, after two gates:
#   1. deny list: no pattern from $EXPORT_DENY_FILE (kept private, default
#      ../githug-ops/export-deny.txt) appears in any file;
#   2. gitleaks finds no secrets (Docker).
#
#   scripts/export-public.sh [--out DIR] [--verify]     # build + check (no network push)
#   scripts/export-public.sh --out DIR --push URL       # also push main to URL (one-way door)
#
# --verify also runs npm ci, typecheck and the tests inside the export.
set -eu
cd "$(dirname "$0")/.."

OUT=""
VERIFY=0
PUSH=""
DENY="${EXPORT_DENY_FILE:-../githug-ops/export-deny.txt}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    --push) PUSH="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
say() { printf '\033[32m▸\033[0m %s\n' "$*"; }
die() { echo "export: $*" >&2; exit 1; }

[ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes; commit first (the export is HEAD)"
[ -f "$DENY" ] || die "deny list not found: $DENY (set EXPORT_DENY_FILE)"
OUT="${OUT:-$(mktemp -d)/githug}"
[ ! -e "$OUT" ] || [ -z "$(ls -A "$OUT" 2>/dev/null)" ] || die "$OUT is not empty"
mkdir -p "$OUT"
SRC_SHA=$(git rev-parse --short HEAD)

say "exporting HEAD ($SRC_SHA) → $OUT"
git archive HEAD | tar -x -C "$OUT"

say "deny-list gate"
PATTERNS=$(grep -vE '^\s*(#|$)' "$DENY" | paste -sd'|' -)
if HITS=$(grep -rniE "$PATTERNS" "$OUT" 2>/dev/null | grep -v '^Binary'); then
  echo "$HITS" | sed "s|$OUT/||" | head -50 >&2
  die "deny-list patterns found (above)"
fi

say "gitleaks gate"
docker run --rm -v "$OUT":/repo:ro zricethezav/gitleaks:v8.21.2 detect --no-git --source /repo --config /repo/.gitleaks.toml --redact >/dev/null 2>&1 \
  || die "gitleaks found something: docker run --rm -v $OUT:/repo zricethezav/gitleaks:v8.21.2 detect --no-git --source /repo --config /repo/.gitleaks.toml"

say "one commit as githug <hello@githug.ai>"
(
  cd "$OUT"
  git init -q -b main
  git add -A
  GIT_AUTHOR_NAME=githug GIT_AUTHOR_EMAIL=hello@githug.ai GIT_COMMITTER_NAME=githug GIT_COMMITTER_EMAIL=hello@githug.ai \
    git -c commit.gpgsign=false commit -q -m "githug: open source release" -m "The githug service under AGPL-3.0. Self-host: docs/SELF_HOSTING.md."
  [ "$(git rev-list --count HEAD)" = 1 ] || exit 1
  [ "$(git log --format='%an <%ae>|%cn <%ce>' | sort -u)" = "githug <hello@githug.ai>|githug <hello@githug.ai>" ] || exit 1
) || die "commit check failed"

if [ "$VERIFY" = 1 ]; then
  say "verify: npm ci, typecheck, tests"
  (cd "$OUT" && npm ci --silent && npm run -s typecheck && npm test 2>&1 | grep -E '^ℹ (pass|fail)')
fi

say "ok: $OUT ($(cd "$OUT" && git ls-files | wc -l | tr -d ' ') files, 1 commit)"
if [ -n "$PUSH" ]; then
  say "pushing to $PUSH"
  (cd "$OUT" && git remote add origin "$PUSH" && git push -u origin main)
fi
