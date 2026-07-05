#!/usr/bin/env bash
# Sync the vendored P2P transport from the QRCodeP2P repo (the upstream lab).
# Usage: ./tools/sync-p2p.sh [path-to-QRCodeP2P]   (default: ../QRCodeP2P)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$DIR/../QRCodeP2P}"

if [ ! -f "$SRC/p2p-core.js" ]; then
  echo "error: $SRC does not look like the QRCodeP2P repo" >&2
  exit 1
fi

FILES=(sdp-codec.js p2p-core.js p2p-ui.js p2p-addon.js p2p-addon.css)
for f in "${FILES[@]}"; do
  cp "$SRC/$f" "$DIR/p2p/$f"
done

COMMIT=$(git -C "$SRC" rev-parse --short HEAD)
DATE=$(date +%Y-%m-%d)
sed -i '' "s/^- \*\*Synced from commit:\*\*.*/- **Synced from commit:** \`$COMMIT\` ($DATE)/" "$DIR/p2p/VENDORED.md"

echo "Synced ${FILES[*]} from QRCodeP2P@$COMMIT"
echo "Remember: bump CACHE_NAME in sw.js so installed PWAs pick up the new files."
