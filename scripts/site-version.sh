#!/bin/sh
set -e

# Writes a released version into dcxv-www: the /cli download page and the MCP server card.
# Usage: scripts/site-version.sh 0.8.1 [path/to/dcxv-www]   (deploy.sh calls it after the release)
VER="$1"
WWW="${2:-$(dirname "$0")/../../dcxv-www}"
case "$VER" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "Usage: $0 X.Y.Z [dcxv-www dir]" >&2; exit 1 ;; esac

PAGE="$WWW/src/routes/[[lang]]/cli/+page.svelte"
CARD="$WWW/src/lib/catalog/index.js"
for f in "$PAGE" "$CARD"; do [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }; done

sed -i -E "s/^(  const VERSION = ')[0-9]+\.[0-9]+\.[0-9]+(')/\1$VER\2/" "$PAGE"
sed -i -E "s/^(const DCXV_CLI_VERSION = ')[0-9]+\.[0-9]+\.[0-9]+(')/\1$VER\2/" "$CARD"

# a pattern that stopped matching must not pass silently
grep -q "^  const VERSION = '$VER'" "$PAGE" || { echo "version not written to $PAGE" >&2; exit 1; }
grep -q "^const DCXV_CLI_VERSION = '$VER'" "$CARD" || { echo "version not written to $CARD" >&2; exit 1; }
