#!/usr/bin/env bash
#
# Publish the production build to the gh-pages branch.
#
# The build is created in a throwaway worktree of an orphan gh-pages branch, so
# the source tree and its history are never touched: dist/ is not committed, and
# nothing is rewritten. Requires push access to the remote (SSH or a credential
# helper that can push).
#
# Usage:
#   npm run deploy                     # publish to origin
#   DEPLOY_REMOTE=git@github.com:user/repo.git npm run deploy
#   DEPLOY_BRANCH=gh-pages npm run deploy
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${DEPLOY_REMOTE:-$(git -C "$REPO_ROOT" remote get-url origin)}"
BRANCH="${DEPLOY_BRANCH:-gh-pages}"
WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/web-gource-deploy.XXXXXX")"

cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
}
trap cleanup EXIT

echo "==> Building"
cd "$REPO_ROOT"
npm run build

echo "==> Preparing $BRANCH from $REMOTE"
git -C "$REPO_ROOT" fetch --depth=1 "$REMOTE" "$BRANCH" >/dev/null 2>&1 || true
if git -C "$REPO_ROOT" rev-parse --verify --quiet FETCH_HEAD >/dev/null; then
  git -C "$REPO_ROOT" worktree add --force --detach "$WORKTREE" FETCH_HEAD >/dev/null
else
  # First publish: start from an empty branch.
  git -C "$REPO_ROOT" worktree add --force --detach "$WORKTREE" HEAD >/dev/null
  git -C "$WORKTREE" checkout --orphan "$BRANCH" >/dev/null 2>&1
  git -C "$WORKTREE" rm -rq --cached . >/dev/null 2>&1 || true
fi

# Replace the published content with the fresh build (keep the branch history).
find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -R "$REPO_ROOT/dist/." "$WORKTREE/"
# GitHub Pages runs Jekyll by default; this keeps every asset served verbatim.
touch "$WORKTREE/.nojekyll"

cd "$WORKTREE"
git add -A
if git diff --cached --quiet; then
  echo "==> Nothing changed; the published build is already up to date"
  exit 0
fi

VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo '0.0.0')"
git -c user.name="${GIT_AUTHOR_NAME:-$(git -C "$REPO_ROOT" config user.name)}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-$(git -C "$REPO_ROOT" config user.email)}" \
    commit -q -m "Publish web-gource $VERSION to GitHub Pages"

echo "==> Pushing to $BRANCH"
git push --force "$REMOTE" "HEAD:refs/heads/$BRANCH"

echo "==> Done. The site appears at the repository's Pages URL once GitHub finishes building."
