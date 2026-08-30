#!/usr/bin/env bash
# Render the Homebrew formula and/or Chocolatey package from the templates in
# packaging/, stamping in the current version and the SHA256 sums from dist/SHA256SUMS.
#
# Usage: scripts/package-brew-choco.sh [homebrew|chocolatey|all]
#   homebrew    render only packaging/homebrew  (needs dcxv-macos-arm64/x64 in SHA256SUMS)
#   chocolatey  render only packaging/chocolatey (needs dcxv-windows-x64.exe in SHA256SUMS)
#   all         render both (default — what a local `build:all` produces)
#
# Run after `bun run build:all` locally, or after downloading a release's binary assets +
# SHA256SUMS in CI (see .github/workflows/packages.yml — binaries aren't built in CI).
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-all}"
VER=$(bun -e 'console.log(require("./package.json").version)')
SUMS=dist/SHA256SUMS
[ -f "$SUMS" ] || { echo "missing $SUMS — run 'bun run build:all' or download release assets first" >&2; exit 1; }

# Plain bash instead of awk — awk isn't guaranteed present on Windows runners' bash.
sha_of() {
  local target="$1" sum name
  while read -r sum name; do
    [ "$name" = "$target" ] && { echo "$sum"; return; }
  done < "$SUMS"
}
require_sha() {
  local val
  val=$(sha_of "$1")
  [ -n "$val" ] || { echo "could not find checksum for $1 in $SUMS" >&2; exit 1; }
  echo "$val"
}

render() { # <template> <outfile> [-e <sed-script>]...
  local tmpl="$1" out="$2"
  shift 2
  mkdir -p "$(dirname "$out")"
  sed -e "s/__VERSION__/$VER/g" "$@" "$tmpl" > "$out"
}

OUT=dist/packaging

if [ "$TARGET" = homebrew ] || [ "$TARGET" = all ]; then
  SHA_MACOS_ARM64=$(require_sha dcxv-macos-arm64)
  SHA_MACOS_X64=$(require_sha dcxv-macos-x64)
  render packaging/homebrew/dcxv.rb.template "$OUT/homebrew/dcxv.rb" \
    -e "s/__SHA256_MACOS_ARM64__/$SHA_MACOS_ARM64/g" \
    -e "s/__SHA256_MACOS_X64__/$SHA_MACOS_X64/g"
  echo "rendered -> $OUT/homebrew/dcxv.rb"
fi

if [ "$TARGET" = chocolatey ] || [ "$TARGET" = all ]; then
  SHA_WINDOWS_X64=$(require_sha dcxv-windows-x64.exe)
  render packaging/chocolatey/dcxv-cli.nuspec.template "$OUT/chocolatey/dcxv-cli.nuspec"
  render packaging/chocolatey/tools/chocolateyinstall.ps1.template "$OUT/chocolatey/tools/chocolateyinstall.ps1" \
    -e "s/__SHA256_WINDOWS_X64__/$SHA_WINDOWS_X64/g"
  cp packaging/chocolatey/tools/chocolateyuninstall.ps1 "$OUT/chocolatey/tools/chocolateyuninstall.ps1"
  echo "rendered -> $OUT/chocolatey/dcxv-cli.nuspec"
  echo "rendered -> $OUT/chocolatey/tools/chocolateyinstall.ps1"
fi
