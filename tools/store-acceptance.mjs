#!/usr/bin/env node
//
// tools/store-acceptance.mjs — exercises Arcade.store (async per-app KV over
// IndexedDB) and Arcade.files (blob store over OPFS / IndexedDB fallback)
// against a real browser. Self-contained: serves the repo on :4796 and loads
// tools/fixtures/store-test/.
//
//   node tools/store-acceptance.mjs
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4796;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p.endsWith('/')) p += 'index.html';
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
    } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail: detail || '' }); };

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    page.on('pageerror', e => check('no page errors', false, e.message));
    await page.goto(`http://127.0.0.1:${PORT}/tools/fixtures/store-test/`, { waitUntil: 'load' });
    await page.evaluate(() => window.Arcade.ready);

    // ── Arcade.store (IndexedDB KV) ──
    const store = await page.evaluate(async () => {
        const kv = Arcade.store.open('notes');
        await kv.clear();
        const setRet = await kv.set('a', { x: 1, s: 'hi' });
        const got = await kv.get('a');
        await kv.set('b', 42);
        const keys = (await kv.keys()).sort();
        const seen = {};
        await kv.each((v, k) => { seen[k] = v; });
        await kv.del('a');
        const afterDel = await kv.get('a');
        const missing = await kv.get('nope');
        // isolation: a different named store must not see 'b'
        const other = Arcade.store.open('other');
        const otherKeys = await other.keys();
        await kv.clear();
        const afterClear = await kv.keys();
        return { setRet, got, keys, seenB: seen.b, afterDel, missing, otherHasB: otherKeys.includes('b'), afterClearLen: afterClear.length };
    });
    check('store.set returns true', store.setRet === true);
    check('store.get round-trips an object', store.got && store.got.x === 1 && store.got.s === 'hi');
    check('store.keys lists all keys', JSON.stringify(store.keys) === JSON.stringify(['a', 'b']));
    check('store.each iterates values', store.seenB === 42);
    check('store.del removes a key', store.afterDel === null);
    check('store.get of a missing key is null', store.missing === null);
    check('named stores are isolated', store.otherHasB === false);
    check('store.clear empties the store', store.afterClearLen === 0);

    // ── Arcade.files (blob store) ──
    const files = await page.evaluate(async () => {
        const backend = (navigator.storage && navigator.storage.getDirectory) ? 'opfs' : 'idb';
        const bytes = new Uint8Array(120 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const putRet = await Arcade.files.put('pic.bin', blob);
        const got = await Arcade.files.get('pic.bin');
        const gotSize = got ? got.size : -1;
        const gotBytes = got ? new Uint8Array(await got.arrayBuffer()) : null;
        const roundTrips = !!gotBytes && gotBytes.length === bytes.length && gotBytes[0] === 0 && gotBytes[255] === 255;
        const list = await Arcade.files.list();
        const listed = list.find(f => f.name === 'pic.bin');
        const delRet = await Arcade.files.delete('pic.bin');
        const afterDel = await Arcade.files.get('pic.bin');
        return { backend, putRet, gotSize, roundTrips, listedSize: listed ? listed.size : -1, delRet, afterDel };
    });
    check(`files backend available (${files.backend})`, files.backend === 'opfs' || files.backend === 'idb');
    check('files.put returns true', files.putRet === true);
    check('files.get returns a Blob of the right size', files.gotSize === 120 * 1024);
    check('files blob bytes round-trip intact', files.roundTrips === true);
    check('files.list reports name + size', files.listedSize === 120 * 1024);
    check('files.delete removes the file', files.delRet === true && files.afterDel === null);

    if (checks.length === 0) check('ran', false, 'no checks executed');
} finally {
    await browser.close();
    server.close();
}

let failed = 0;
for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? '   (' + c.detail + ')' : ''}`);
    if (!c.ok) failed++;
}
console.log('');
if (failed) { console.log(`${failed} check(s) FAILED.`); process.exit(1); }
console.log('All store/files acceptance checks passed.');
