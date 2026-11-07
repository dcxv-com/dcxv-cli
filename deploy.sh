#!/bin/sh
set -e

# Cuts and publishes a release: bump package.json, regenerate the embedded version,
# build all 5 platform binaries, commit + push, then create a published GitHub Release
# with the binaries attached. Publishing the release is what fires
# .github/workflows/publish.yml (npm publish) and .github/workflows/packages.yml
# (Homebrew tap + Chocolatey push) - none of that can be undone, so make sure the working
# tree is what you want released before running this.
#
# Usage:
#   ./deploy.sh              # minor bump (default)
#   ./deploy.sh major        # explicit bump type: patch | minor | major

BUMP="minor"
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    *) echo "Usage: $0 [patch|minor|major]" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")"

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

# 2) Publish the release with the binaries build.sh produced -> dist/.
gh release create "$VER" \
  dist/dcxv-linux-x64 dist/dcxv-linux-arm64 \
  dist/dcxv-macos-arm64 dist/dcxv-macos-x64 \
  dist/dcxv-windows-x64.exe dist/SHA256SUMS \
  --title "$VER" \
  --generate-notes

echo
echo "Published $VER. npm publish, the Homebrew tap push, and the Chocolatey push are"
echo "now running - see the Actions tab."

# 3) The download page and the MCP server card of dcxv-www name the released version. The binaries
# need no upload: dcxv.com/cli/dcxv-* redirects to the latest GitHub Release. Pushing dcxv-www
# deploys the site (CI), so it is a separate commit with only these two files.
WWW="../dcxv-www"
if [ -d "$WWW/.git" ]; then
  sh scripts/site-version.sh "${VER#v}" "$WWW"
  git -C "$WWW" add "src/routes/[[lang]]/cli/+page.svelte" src/lib/catalog/index.js
  git -C "$WWW" commit -m "cli page and MCP server card: dcxv-cli ${VER#v}"
  git -C "$WWW" pull --rebase --autostash
  git -C "$WWW" push
else
  echo "dcxv-www not found at $WWW: set const VERSION in its src/routes/[[lang]]/cli/+page.svelte and"
  echo "DCXV_CLI_VERSION in src/lib/catalog/index.js to ${VER#v} by hand."
fi
