#!/usr/bin/env sh
# Pack one distributable as an npm tarball into <out-dir>.
#   scripts/pack.sh cli    <out-dir>   the agentic-bundle CLI itself (npx-able)
#   scripts/pack.sh <tool> <out-dir>   one tool's native package, e.g. claude, opencode, pi
set -eu
pkg=$1
out=${2:-artifacts}
mkdir -p "$out"
if [ "$pkg" = cli ]; then
  # The CLI package ships harness/, so it may not be public while the harness is restricted.
  node -e '
    const read = (f) => JSON.parse(require("fs").readFileSync(f, "utf8"));
    const harness = read("harness/bundle.json").npm?.access;
    const cli = read("package.json").publishConfig?.access;
    if (harness === "restricted" && cli !== "restricted") {
      console.error(`harness/bundle.json sets npm.access "restricted", but publishConfig.access in package.json is ${cli === undefined ? "not set" : JSON.stringify(cli)}.`);
      console.error("The CLI package contains harness/: set \"publishConfig\": { \"access\": \"restricted\" } in package.json.");
      process.exit(1);
    }
  '
  npm pack --pack-destination "$out"
else
  node bin/agentic-bundle.js build "$pkg" --npm --out dist
  npm pack "./dist/$pkg" --pack-destination "$out"
fi
