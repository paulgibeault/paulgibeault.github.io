#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.go.pid"
LOG_FILE="$DIR/.go.log"
PORT=8766

# Kill previous run if pid file exists
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null || true
    # Wait briefly for clean shutdown
    for i in 1 2 3; do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.2
    done
    echo "Stopped previous instance (PID $OLD_PID)"
  fi
  rm -f "$PID_FILE"
fi

# Start new server, capturing stdout and stderr to log file
python3 - "$PORT" "$DIR" > "$LOG_FILE" 2>&1 <<'PYSRV' &
import functools, http.server, sys
# Cache-Control: no-store — Safari's heuristic caching over a header-less
# python http.server served a STALE module during live debugging twice.
class NoStore(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
http.server.ThreadingHTTPServer(('', int(sys.argv[1])),
    functools.partial(NoStore, directory=sys.argv[2])).serve_forever()
PYSRV
NEW_PID=$!

# Verify it started
sleep 0.3
if ! kill -0 "$NEW_PID" 2>/dev/null; then
  echo "Failed to start server. Check $LOG_FILE"
  exit 1
fi

echo "$NEW_PID" > "$PID_FILE"

echo "Server running (PID $NEW_PID)"
echo "  URL: http://localhost:$PORT"
echo "  Log: $LOG_FILE"
