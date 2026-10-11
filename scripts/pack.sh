#!/usr/bin/env sh
# Pack one distributable as an npm tarball into <out-dir>.
#   scripts/pack.sh cli    <out-dir>   the agentic-bundle CLI itself (npx-able)
#   scripts/pack.sh <tool> <out-dir>   one tool's native package, e.g. claude, gemini, pi
set -eu
pkg=$1
out=${2:-artifacts}
mkdir -p "$out"
if [ "$pkg" = cli ]; then
  npm pack --pack-destination "$out"
else
  node bin/agentic-bundle.js build "$pkg" --npm --out dist
  npm pack "./dist/$pkg" --pack-destination "$out"
fi
