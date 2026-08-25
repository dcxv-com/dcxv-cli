#!/bin/sh
set -e

# Cuts a release the same way the last few (v0.3.0-v0.3.2) were cut by hand:
# bump package.json, regenerate the embedded version, build all 5 platform
# binaries, commit + push, then create a DRAFT GitHub Release with the
# binaries attached. The draft is deliberate - publishing it is what fires
# .github/workflows/publish.yml's `npm publish`, which cannot be undone, so
# that step needs a separate explicit run of this script with --publish
# (or `gh release edit vX.Y.Z --draft=false` by hand) once you've reviewed
# the draft on GitHub.
#
# Usage:
#   ./deploy.sh              # patch/minor/major bump (default: minor), draft release only
#   ./deploy.sh major        # explicit bump type
#   ./deploy.sh --publish     # publish the ALREADY-CREATED draft for the current package.json version - no rebuild
#   ./deploy.sh minor --publish  # bump, build, draft, AND publish in one go

BUMP="minor"
DO_PUBLISH=0
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --publish) DO_PUBLISH=1 ;;
    *) echo "Usage: $0 [patch|minor|major] [--publish]" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")"

if [ "$1" = "--publish" ] && [ $# -eq 1 ]; then
  # Publish-only mode: the draft for the CURRENT version already exists, just flip it live.
  VER="v$(node -p "require('./package.json').version")"
  echo "Publishing existing draft release $VER ..."
  gh release edit "$VER" --draft=false
  echo "Published. .github/workflows/publish.yml will now run \`npm publish\`."
  exit 0
fi

# 1) Bump version, regenerate src/version.js + server.json (build.sh does both), commit, push.
npm version "$BUMP" --no-git-tag-version
VER="v$(node -p "require('./package.json').version")"
echo "Bumped to $VER"

bash scripts/build.sh

# server.json belongs here: build.sh rewrites its two version fields, and leaving it
# unstaged is exactly how v0.5.0 shipped a manifest still claiming 0.4.0. It had gone
# unnoticed because server.json was created at 0.4.0, so the first release after it
# happened to match.
git add package.json src/version.js server.json
git commit -m "chore: bump version to ${VER#v}"
git push origin main

# 2) Build binaries already produced by scripts/build.sh above -> dist/.
#    Create the draft release with them attached, same asset set as v0.3.2.
gh release create "$VER" \
  dist/dcxv-linux-x64 dist/dcxv-linux-arm64 \
  dist/dcxv-macos-arm64 dist/dcxv-macos-x64 \
  dist/dcxv-windows-x64.exe dist/SHA256SUMS \
  --draft \
  --title "$VER" \
  --generate-notes

echo
echo "Draft release $VER created: review it on GitHub, then run:"
echo "  ./deploy.sh --publish"
echo "to publish it (triggers npm publish - cannot be undone)."
echo
echo "Reminder: bump DCXV_CLI_VERSION in dcxv-www's src/lib/catalog/index.js"
echo "(the MCP server card at /.well-known/mcp/server-card.json) to ${VER#v} by hand -"
echo "that's a separate repo and cannot be updated from here."

if [ "$DO_PUBLISH" -eq 1 ]; then
  echo
  echo "Publishing immediately (--publish was passed) ..."
  gh release edit "$VER" --draft=false
  echo "Published. .github/workflows/publish.yml will now run \`npm publish\`."
fi
