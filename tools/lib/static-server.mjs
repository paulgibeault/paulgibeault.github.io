// tools/lib/static-server.mjs — shared hermetic static file server for the
// non-P2P Playwright acceptance runners (the P2P family uses
// tools/lib/p2p-test-harness.mjs instead — leave that one alone).
//
// Replaces the identical hand-rolled http.createServer copies each runner
// carried: decode the URL, strip the query, map a trailing '/' to index.html,
// refuse path escapes with a 403, serve bytes with a MIME lookup, 404 on
// anything unreadable.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Union of the per-runner MIME maps this module replaced. Unknown extensions
// fall back to application/octet-stream, exactly as before.
const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};

// serveRepo({ root, port, cors, catalogOverride, mounts })
//   root            absolute directory to serve (required)
//   port            port to bind on 127.0.0.1 (required)
//   cors            when true, adds Access-Control-Allow-Origin: * — opaque-
//                   origin game frames load their ES modules as CORS requests
//                   (Origin: null), so runners that frame games mirror dev.sh
//                   and GitHub Pages here. Runners that never frame a game
//                   historically sent no CORS header; they keep that behavior.
//   catalogOverride repo-relative path served in place of /catalog.json
//   mounts          { gameId: repoRelativeDir } — maps /<gameId>/* onto a
//                   fixture dir (acceptance.mjs --mount)
//
// → { server, port, origin, close() }
export async function serveRepo({ root, port, cors = false, catalogOverride = null, mounts = null }) {
    const server = http.createServer(async (req, res) => {
        try {
            let p = decodeURIComponent(req.url.split('?')[0]);
            if (p.endsWith('/')) p += 'index.html';
            const seg = p.split('/').filter(Boolean);
            let file = (mounts && seg.length && mounts[seg[0]])
                ? path.resolve(root, mounts[seg[0]], ...seg.slice(1))
                : path.join(root, p);
            if (p === '/catalog.json' && catalogOverride) file = path.resolve(root, catalogOverride);
            if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
            const body = await readFile(file);
            const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };
            if (cors) headers['access-control-allow-origin'] = '*';
            res.writeHead(200, headers);
            res.end(body);
        } catch { res.writeHead(404).end('not found'); }
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    return {
        server,
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => server.close(),
    };
}
