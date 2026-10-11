#!/usr/bin/env sh
# List files changed on the current branch relative to the default branch.
set -eu
base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
git diff --name-only "$(git merge-base HEAD "$base" 2>/dev/null || echo HEAD)"
