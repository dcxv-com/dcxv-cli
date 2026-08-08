#!/usr/bin/env sh
# DCXV CLI installer. Downloads the right prebuilt binary and drops it on your PATH.
#   curl -fsSL https://dcxv.com/cli/install.sh | sh
# Env: DCXV_BASE_URL (default https://dcxv.com/cli), DCXV_INSTALL_DIR (default ~/.local/bin)
set -eu

BASE="${DCXV_BASE_URL:-https://dcxv.com/cli}"
DEST="${DCXV_INSTALL_DIR:-$HOME/.local/bin}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux)  o=linux ;;
  Darwin) o=macos ;;
  *) echo "Unsupported OS: $os (Windows: download $BASE/dcxv-windows-x64.exe manually)"; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64)   a=x64 ;;
  aarch64|arm64)  a=arm64 ;;
  *) echo "Unsupported architecture: $arch"; exit 1 ;;
esac

if [ "$o" = macos ] && [ "$a" = x64 ]; then
  echo "Only macos-arm64 (Apple Silicon) binaries are published. Use Node/Bun on Intel Macs: 'npx dcxv'."
  exit 1
fi

asset="dcxv-$o-$a"
mkdir -p "$DEST"
tmp="$DEST/dcxv.download.$$"

echo "Downloading $BASE/$asset ..."
curl -fsSL "$BASE/$asset" -o "$tmp"

# Best-effort checksum verification.
if command -v sha256sum >/dev/null 2>&1; then
  want=$(curl -fsSL "$BASE/SHA256SUMS" 2>/dev/null | awk -v f="$asset" '$2==f {print $1}')
  have=$(sha256sum "$tmp" | awk '{print $1}')
  if [ -n "$want" ] && [ "$want" != "$have" ]; then
    rm -f "$tmp"
    echo "Checksum mismatch for $asset — aborting."
    exit 1
  fi
fi

chmod +x "$tmp"
mv "$tmp" "$DEST/dcxv"
echo "Installed to $DEST/dcxv"
"$DEST/dcxv" version

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "Note: add $DEST to your PATH  (e.g. export PATH=\"$DEST:\$PATH\")" ;;
esac
