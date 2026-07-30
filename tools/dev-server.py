#!/usr/bin/env python3
# tools/dev-server.py — the one local static server for dev flows.
#
#   python3 tools/dev-server.py <port> <directory>
#
# Used by dev.sh (staged launcher + games) and .claude/launch.json previews
# (repo root, launcher-only). Two headers, both learned the hard way:
#
#   Cache-Control: no-store — a header-less python http.server lets the
#   browser cache heuristically (10% of Last-Modified age), which served a
#   STALE module during live debugging on more than one occasion. no-store
#   keeps every dev load honest. (Entries cached under a header-less server
#   persist until refetched — one fetch(url, {cache:'reload'}) sweep, or a
#   hard reload, replaces them.)
#
#   Access-Control-Allow-Origin: * — game iframes are sandboxed OPAQUE-origin
#   (no allow-same-origin), so their module scripts / fetch()es arrive as
#   CORS requests with Origin: null; GitHub Pages sends this header in
#   production, so dev must match it.
import functools
import http.server
import sys

class NoStore(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('usage: dev-server.py <port> <directory>')
    http.server.ThreadingHTTPServer(
        ('127.0.0.1', int(sys.argv[1])),
        functools.partial(NoStore, directory=sys.argv[2])).serve_forever()
