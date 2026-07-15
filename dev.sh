#!/usr/bin/env bash
#
# dev.sh — Stage the launcher with one or more sibling game repos under a
# single same-origin HTTP server, so the postMessage / iframe-pool / shared
# localStorage handshake works end-to-end against your local edits.
#
#   ./dev.sh ../si-syn ../pi-game   build (if needed), stage, serve, open browser
#   ./dev.sh stop                   stop the running server
#
# Each game-dir argument:
#   - if package.json has a scripts.build, runs `npm run build` and stages
#     dist/ (falling back to build/) at /<basename>/
#   - otherwise stages the dir as-is at /<basename>/
#
# The launcher's own service worker is loopback-aware (skips on 127.x /
# localhost / ::1), so dev edits are not masked by stale cache. Absolute
# https://paulgibeault.github.io references in the launcher (launcher-btn
# hrefs, og:url, profile.html) and in any older game's SDK <script src> are
# rewritten to http://127.0.0.1:$PORT in the staged copies.
#
# Env: ARCADE_PORT (default 4791)

set -euo pipefail

LAUNCHER_DIR="$(cd "$(dirname "$0")" && pwd)"
STAGE_DIR="$LAUNCHER_DIR/.dev-stage"
PORT="${ARCADE_PORT:-4791}"
PID_FILE="$STAGE_DIR/.server.pid"
LOG_FILE="$STAGE_DIR/.server.log"

stop_server() {
  if [ -f "$PID_FILE" ]; then
    local p
    p=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      kill "$p" 2>/dev/null || true
      for _ in 1 2 3 4 5; do
        kill -0 "$p" 2>/dev/null || break
        sleep 0.2
      done
      kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
}

# In-place sed wrapper that works on both macOS BSD and GNU sed.
sed_inplace() {
  local pattern="$1" file="$2" tmp
  tmp=$(mktemp)
  sed "$pattern" "$file" > "$tmp"
  mv "$tmp" "$file"
}

# Echo the gameId a game declares via Arcade.init({ gameId: '...' }) in its
# index.html, or nothing if none is found. The checkout's directory name is
# NOT authoritative — a repo cloned as ../sow-duku must still mount at the
# /sowduku/ slug the launcher buttons and acceptance runner use.
detect_game_id() {
  local html="$1/index.html"
  [ -f "$html" ] || return 0
  grep -oE "Arcade[.]init[(][[:space:]]*[{][[:space:]]*gameId[[:space:]]*:[[:space:]]*['\"][A-Za-z0-9_-]+['\"]" "$html" 2>/dev/null \
    | head -1 \
    | sed -E "s/.*['\"]([A-Za-z0-9_-]+)['\"]\$/\1/"
}

# Returns 0 if $1/package.json declares a "build" script.
has_build_script() {
  python3 - "$1" <<'PY' 2>/dev/null
import json, sys
try:
    pkg = json.load(open(sys.argv[1] + '/package.json'))
    sys.exit(0 if pkg.get('scripts', {}).get('build') else 1)
except Exception:
    sys.exit(1)
PY
}

# ─── stop subcommand ───────────────────────────────────────────────────
if [ "${1:-}" = "stop" ]; then
  if [ -d "$STAGE_DIR" ]; then
    stop_server
    echo "dev: server stopped."
  else
    echo "dev: no stage directory; nothing to stop."
  fi
  exit 0
fi

# ─── new subcommand — scaffold a starter app ───────────────────────────
if [ "${1:-}" = "new" ]; then
  APP_ID="${2:-}"
  if ! printf '%s' "$APP_ID" | grep -qE '^[a-z][a-z0-9-]*$'; then
    echo "dev: usage: ./dev.sh new <app-id>   (kebab-case: lowercase, digits, dashes)" >&2
    exit 1
  fi
  TEMPLATE_DIR="$LAUNCHER_DIR/tools/templates/starter-app"
  TARGET_DIR="$(cd "$LAUNCHER_DIR/.." && pwd)/$APP_ID"
  [ -d "$TEMPLATE_DIR" ] || { echo "dev: template missing: $TEMPLATE_DIR" >&2; exit 1; }
  [ -e "$TARGET_DIR" ] && { echo "dev: refusing to overwrite existing $TARGET_DIR" >&2; exit 1; }
  # Title-case the id for display: my-app -> My App.
  APP_TITLE=$(printf '%s' "$APP_ID" | tr '-' ' ' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')

  cp -R "$TEMPLATE_DIR" "$TARGET_DIR"
  rm -f "$TARGET_DIR/README.md"   # template usage doc, not part of the new app
  # Substitute placeholders in every staged file.
  find "$TARGET_DIR" -type f | while IFS= read -r f; do
    sed_inplace "s|{{APP_ID}}|$APP_ID|g" "$f"
    sed_inplace "s|{{APP_TITLE}}|$APP_TITLE|g" "$f"
  done

  echo "dev: created $TARGET_DIR (gameId '$APP_ID')."
  echo ""
  echo "Next:"
  echo "  1. Add it to the launcher catalog ($LAUNCHER_DIR/catalog.json):"
  echo "       { \"id\": \"$APP_ID\", \"name\": \"$APP_TITLE\", \"subtitle\": \"...\", \"url\": \"/$APP_ID/\" }"
  echo "  2. Stage + serve:"
  echo "       ./dev.sh ../$APP_ID"
  echo "  3. Verify it passes acceptance:"
  echo "       npm run acceptance -- http://127.0.0.1:$PORT/$APP_ID/"
  exit 0
fi

# ─── usage ─────────────────────────────────────────────────────────────
if [ "$#" -eq 0 ]; then
  cat <<EOF >&2
Usage: ./dev.sh <game-dir>[:<gameId>]... | new <app-id> | stop

Stages the launcher and one or more sibling game repos under a single
same-origin HTTP server so the SDK handshake works end-to-end locally.

Each game mounts at /<gameId>/, where <gameId> is (in priority order) the
explicit :<gameId> suffix, the id declared by Arcade.init({ gameId }) in the
game's index.html, or the directory basename.

Examples:
  ./dev.sh ../si-syn
  ./dev.sh ../si-syn ../pi-game
  ./dev.sh ../sow-duku-checkout:sowduku
  ./dev.sh new my-app          scaffold ../my-app from the starter template
  ./dev.sh stop

Env:
  ARCADE_PORT   override port (default: 4791)
EOF
  exit 1
fi

# ─── preflight ─────────────────────────────────────────────────────────
command -v python3 >/dev/null 2>&1 || { echo "dev: python3 required" >&2; exit 1; }

# Split an argument of the form <dir>[:<gameId>] — override lands in
# ARG_OVERRIDE, directory in ARG_DIR. A ':' only counts as an override
# separator when the whole argument isn't itself a directory (paths with
# colons are legal, if exotic).
split_game_arg() {
  ARG_DIR="$1"
  ARG_OVERRIDE=""
  if [ ! -d "$1" ]; then
    case "$1" in
      *:*)
        ARG_DIR="${1%:*}"
        ARG_OVERRIDE="${1##*:}"
        ;;
    esac
  fi
}

for arg in "$@"; do
  split_game_arg "$arg"
  if [ ! -d "$ARG_DIR" ]; then
    echo "dev: not a directory: $ARG_DIR" >&2
    exit 1
  fi
done

LOCAL_ORIGIN="http://127.0.0.1:$PORT"

# ─── reset stage ───────────────────────────────────────────────────────
stop_server
echo "→ Staging at $STAGE_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# ─── stage launcher ────────────────────────────────────────────────────
# Rewrite https://paulgibeault.github.io → local origin in HTML/JS/JSON.
# Skip sw.js — the launcher itself opts out on loopback, and we don't want
# stale launcher assets cached during dev.
for f in index.html profile.html manifest.json catalog.json arcade-sdk.js styles.css \
         arcade-p2p.js arcade-known-peers.js arcade-diag.js arcade-catalog.js \
         arcade-storage-core.js arcade-storage-bridge.js arcade-save.js; do
  src="$LAUNCHER_DIR/$f"
  if [ -f "$src" ]; then
    sed "s|https://paulgibeault.github.io|$LOCAL_ORIGIN|g" "$src" > "$STAGE_DIR/$f"
  fi
done

# Symlink images and the vendored P2P transport (large/binary, no rewrite needed).
ln -snf "$LAUNCHER_DIR/images" "$STAGE_DIR/images"
ln -snf "$LAUNCHER_DIR/p2p" "$STAGE_DIR/p2p"

# ─── stage each game ───────────────────────────────────────────────────
STAGED_IDS=""
for arg in "$@"; do
  split_game_arg "$arg"
  game_dir="$(cd "$ARG_DIR" && pwd)"
  dir_name="$(basename "$game_dir")"

  build_root="$game_dir"
  if has_build_script "$game_dir"; then
    if [ ! -d "$game_dir/node_modules" ]; then
      echo "dev: $dir_name has a build script but no node_modules — run 'npm install' there first" >&2
      exit 1
    fi
    echo "→ $dir_name: npm run build"
    (cd "$game_dir" && npm run build > /dev/null)
    if [ -d "$game_dir/dist" ]; then
      build_root="$game_dir/dist"
    elif [ -d "$game_dir/build" ]; then
      build_root="$game_dir/build"
    else
      echo "dev: $dir_name built but no dist/ or build/ output found" >&2
      exit 1
    fi
  fi

  # Mount point: explicit override > Arcade.init gameId > directory basename.
  if [ -n "$ARG_OVERRIDE" ]; then
    game_id="$ARG_OVERRIDE"
  else
    game_id="$(detect_game_id "$build_root")"
    if [ -z "$game_id" ]; then
      game_id="$dir_name"
    elif [ "$game_id" != "$dir_name" ]; then
      echo "  → mounting at /$game_id/ (Arcade.init gameId; dir is '$dir_name')"
    fi
  fi
  echo "→ Game: $game_id  ($game_dir)"

  cp -R "$build_root" "$STAGE_DIR/$game_id"
  # Older games may still hard-code the absolute SDK URL; rewrite for parity
  # with the recommended root-relative form.
  if [ -f "$STAGE_DIR/$game_id/index.html" ]; then
    sed_inplace "s|https://paulgibeault.github.io|$LOCAL_ORIGIN|g" "$STAGE_DIR/$game_id/index.html"
  fi
  STAGED_IDS="$STAGED_IDS $game_id"
done

# ─── start server ──────────────────────────────────────────────────────
python3 - "$PORT" "$STAGE_DIR" > "$LOG_FILE" 2>&1 <<'PYSRV' &
import functools, http.server, sys
# Cache-Control: no-store — Safari's heuristic caching over a header-less
# python http.server served a STALE module during live debugging twice.
# ACAO * — game iframes are sandboxed OPAQUE-origin (no allow-same-origin),
# so their module scripts / fetch()es arrive as CORS requests with
# Origin: null; GitHub Pages sends this header in production, match it here.
class NoStore(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])),
    functools.partial(NoStore, directory=sys.argv[2])).serve_forever()
PYSRV
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 0.4
if ! kill -0 "$NEW_PID" 2>/dev/null; then
  echo "dev: server failed to start. See $LOG_FILE" >&2
  exit 1
fi

echo
echo "  Launcher:  $LOCAL_ORIGIN/"
for game_id in $STAGED_IDS; do
  echo "  Game:      $LOCAL_ORIGIN/$game_id/   (standalone)"
done
echo "  SDK:       $LOCAL_ORIGIN/arcade-sdk.js"
echo
echo "  PID:       $NEW_PID"
echo "  Log:       $LOG_FILE"
echo "  Stop:      $0 stop"
echo
echo "  Re-run ./dev.sh after editing source — it rebuilds + restages atomically."
echo

if command -v open >/dev/null 2>&1; then
  open "$LOCAL_ORIGIN/" >/dev/null 2>&1 || true
fi
