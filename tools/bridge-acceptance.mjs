#!/usr/bin/env node
//
// tools/bridge-acceptance.mjs — proves the first-party trust boundary
// (issue #43) and exercises the opaque-frame storage bridge end to end.
//
// The launcher mounts games sandboxed WITHOUT allow-same-origin, so a game
// frame must not be able to open ANY origin storage — above all the P2P key
// stores (qrp2p-identity / qrp2p-rendezvous) — while its own state/store/
// files persist through the postMessage bridge under the same arcade.v1.*
// names direct mode uses.
//
//   node tools/bridge-acceptance.mjs
//
// Self-contained: serves the repo on :4797 and drives a fixture app
// (tools/fixtures/bridge-test/) through the real launcher iframe pool.
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4797;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p.endsWith('/')) p += 'index.html';
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        const body = await readFile(file);
        res.writeHead(200, {
            'content-type': MIME[path.extname(file)] || 'application/octet-stream',
            // Opaque-origin frames send Origin: null — mirror GitHub Pages.
            'access-control-allow-origin': '*',
        });
        res.end(body);
    } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const BASE = `http://127.0.0.1:${PORT}`;
const GAME_PATH = '/tools/fixtures/bridge-test/';

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail: detail || '' }); };

async function mountFixture(page) {
    await page.evaluate((src) => window.__arcade.showGame('bridge-test', src, 'Bridge Test'), GAME_PATH);
    // The frame appears once the iframe loads; then wait for the SDK handshake.
    let frame = null;
    for (let i = 0; i < 100 && !frame; i++) {
        frame = page.frames().find(f => f.url().includes(GAME_PATH));
        if (!frame) await page.waitForTimeout(50);
    }
    if (!frame) throw new Error('fixture frame never appeared');
    await frame.evaluate(() => window.Arcade.ready);
    return frame;
}

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    page.on('pageerror', e => check('no launcher page errors', false, e.message));

    await page.goto(BASE + '/', { waitUntil: 'load' });
    // Seed pre-existing "saved game" state + shared meta before mount, so the
    // welcome snapshot path is exercised with real data.
    await page.evaluate(() => {
        localStorage.setItem('arcade.v1.bridge-test.seeded', '"yes"');
        localStorage.setItem('arcade.v1._meta.deviceId', 'dev-123');
        localStorage.setItem('arcade.v1._meta.deviceName', 'Test Device');
    });

    const frame = await mountFixture(page);

    // ── 1. Handshake + mode ──
    const ctx = await frame.evaluate(() => Arcade.context);
    check('frame handshakes with launcher (framed=true)', ctx.framed === true, JSON.stringify(ctx));
    check('frame storage mode is bridged', ctx.storage === 'bridged', ctx.storage);

    // ── 2. THE BOUNDARY: origin storage is unreachable from the frame ──
    const boundary = await frame.evaluate(() => {
        const out = {};
        try { void window.localStorage.getItem('x'); out.localStorage = 'accessible'; }
        catch { out.localStorage = 'blocked'; }
        for (const db of ['qrp2p-identity', 'qrp2p-rendezvous']) {
            try {
                const req = indexedDB.open(db);
                req.onsuccess = () => { try { req.result.close(); } catch {} };
                out[db] = 'accessible';
            } catch { out[db] = 'blocked'; }
        }
        try { void document.cookie; out.cookie = 'accessible'; } catch { out.cookie = 'blocked'; }
        return out;
    });
    check('frame cannot touch localStorage', boundary.localStorage === 'blocked', JSON.stringify(boundary));
    check('frame cannot open qrp2p-identity', boundary['qrp2p-identity'] === 'blocked');
    check('frame cannot open qrp2p-rendezvous', boundary['qrp2p-rendezvous'] === 'blocked');

    // Control for the asymmetry: the LAUNCHER (trusted context) still can.
    const launcherCan = await page.evaluate(() => new Promise((resolve) => {
        try {
            const req = indexedDB.open('qrp2p-identity');
            req.onsuccess = () => { req.result.close(); resolve(true); };
            req.onerror = () => resolve(false);
        } catch { resolve(false); }
    }));
    check('launcher itself can open qrp2p-identity (asymmetry control)', launcherCan === true);

    // ── 3. State bridge: snapshot in, write-through out ──
    const seeded = await frame.evaluate(() => Arcade.state.get('seeded'));
    check('welcome snapshot delivers pre-existing state', seeded === 'yes', JSON.stringify(seeded));

    const self = await frame.evaluate(() => Arcade.peer.self());
    check('peer.self() served from snapshot meta', !!self && self.deviceId === 'dev-123' && self.name === 'Test Device', JSON.stringify(self));

    await frame.evaluate(() => Arcade.state.set('written', { n: 7 }));
    let written = null;
    for (let i = 0; i < 40 && written !== '{"n":7}'; i++) {
        written = await page.evaluate(() => localStorage.getItem('arcade.v1.bridge-test.written'));
        if (written !== '{"n":7}') await page.waitForTimeout(50);
    }
    check('state.set writes through to launcher localStorage', written === '{"n":7}', String(written));

    await frame.evaluate(() => Arcade.global.set('bridgeProbe', 123));
    let probe = null;
    for (let i = 0; i < 40 && probe !== '123'; i++) {
        probe = await page.evaluate(() => localStorage.getItem('arcade.v1.global.bridgeProbe'));
        if (probe !== '123') await page.waitForTimeout(50);
    }
    check('global.set writes through to shared namespace', probe === '123', String(probe));

    // ── 4. Namespace enforcement at the launcher ──
    // Raw postMessage (bypassing the SDK): own-namespace write lands, foreign
    // namespace / _meta identity / non-arcade keys are refused.
    await frame.evaluate(() => {
        const w = (key, value) => window.parent.postMessage({ type: 'arcade:state.write', key, value }, '*');
        w('arcade.v1.bridge-test.rawOk', '"raw"');           // allowed: own namespace
        w('arcade.v1.other-app.hack', '"pwned"');            // denied: another app
        w('arcade.v1._meta.deviceId', '"spoofed"');          // denied: identity meta is read-only
        w('arcade.v1.global.__proto__.x', '"pp"');           // denied: dunder segment
        w('evil-key', '"pwned"');                            // denied: outside arcade.v1
    });
    let rawOk = null;
    for (let i = 0; i < 40 && rawOk !== '"raw"'; i++) {
        rawOk = await page.evaluate(() => localStorage.getItem('arcade.v1.bridge-test.rawOk'));
        if (rawOk !== '"raw"') await page.waitForTimeout(50);
    }
    const denied = await page.evaluate(() => ({
        foreign: localStorage.getItem('arcade.v1.other-app.hack'),
        meta: localStorage.getItem('arcade.v1._meta.deviceId'),
        dunder: localStorage.getItem('arcade.v1.global.__proto__.x'),
        evil: localStorage.getItem('evil-key'),
    }));
    check('own-namespace raw write lands (deny is namespace-based)', rawOk === '"raw"', String(rawOk));
    check('foreign-namespace write refused', denied.foreign === null, String(denied.foreign));
    check('device-identity meta write refused', denied.meta === 'dev-123', String(denied.meta));
    check('dunder-segment key refused', denied.dunder === null, String(denied.dunder));
    check('non-arcade key refused', denied.evil === null, String(denied.evil));

    // ── 5. Arcade.store over the bridge ──
    const store = await frame.evaluate(async () => {
        const kv = Arcade.store.open('notes');
        await kv.clear();
        await kv.set('a', { x: 1, s: 'hi' });
        await kv.set('b', 42);
        const got = await kv.get('a');
        const missing = await kv.get('nope');
        const keys = (await kv.keys()).sort();
        const seen = {};
        await kv.each((v, k) => { seen[k] = v; });
        await kv.del('a');
        const afterDel = await kv.get('a');
        return { got, missing, keys, seen, afterDel };
    });
    check('store: set/get round-trips', store.got && store.got.x === 1 && store.got.s === 'hi', JSON.stringify(store.got));
    check('store: get miss → null', store.missing === null);
    check('store: keys()', JSON.stringify(store.keys) === '["a","b"]', JSON.stringify(store.keys));
    check('store: each() sees entries', store.seen.b === 42 && store.seen.a && store.seen.a.x === 1, JSON.stringify(store.seen));
    check('store: del()', store.afterDel === null);

    // The data must live in the LAUNCHER origin's IDB under the app's name.
    const launcherSees = await page.evaluate(() => new Promise((resolve) => {
        const req = indexedDB.open('arcade.v1.bridge-test.store.notes', 1);
        req.onupgradeneeded = () => resolve('missing-db');
        req.onsuccess = () => {
            const db = req.result;
            try {
                const get = db.transaction('kv', 'readonly').objectStore('kv').get('b');
                get.onsuccess = () => { db.close(); resolve(get.result); };
                get.onerror = () => { db.close(); resolve('get-error'); };
            } catch (e) { db.close(); resolve('tx-error'); }
        };
        req.onerror = () => resolve('open-error');
    }));
    check('store data persisted in launcher-origin IDB', launcherSees === 42, JSON.stringify(launcherSees));

    // ── 6. Arcade.files over the bridge ──
    const files = await frame.evaluate(async () => {
        await Arcade.files.put('note.txt', new Blob(['hello bridge'], { type: 'text/plain' }));
        const blob = await Arcade.files.get('note.txt');
        const text = blob ? await blob.text() : null;
        const list = await Arcade.files.list();
        const del = await Arcade.files.delete('note.txt');
        const afterDel = await Arcade.files.get('note.txt');
        const missing = await Arcade.files.get('never-was.txt');
        return { text, list, del, afterDel: afterDel === null, missing: missing === null };
    });
    check('files: put/get round-trips a Blob', files.text === 'hello bridge', JSON.stringify(files.text));
    check('files: list() names it', Array.isArray(files.list) && files.list.some(f => f.name === 'note.txt'), JSON.stringify(files.list));
    check('files: delete()', files.del === true && files.afterDel === true);
    check('files: get miss → null', files.missing === true);

    // ── 7. Full persistence loop: reload launcher, remount, state survives ──
    await page.reload({ waitUntil: 'load' });
    const frame2 = await mountFixture(page);
    const survived = await frame2.evaluate(() => Arcade.state.get('written'));
    check('state survives launcher reload + remount', survived && survived.n === 7, JSON.stringify(survived));

    // ── 8. Blob failure observability (#41): integrity / abort / old-sender ──
    // Chunks are injected from the launcher page (source === window.parent,
    // pinned origin), exactly the path real peer messages arrive on.
    const frame3 = page.frames().find(f => f.url().includes(GAME_PATH));
    await frame3.evaluate(() => {
        window.__blobs = []; window.__blobErrs = [];
        Arcade.peer.onBlob((blob, meta) => blob.text().then(t => window.__blobs.push({ text: t, name: meta.name, id: meta.id })));
        Arcade.peer.onBlobError((e) => window.__blobErrs.push(e));
    });
    const inject = (payload) => page.evaluate((p) => {
        const entry = [...document.querySelectorAll('iframe')].find(f => f.src.includes('/bridge-test/'));
        entry.contentWindow.postMessage({ type: 'arcade:peer.message', payload: p, fromPeer: 'test-peer' }, '*');
    }, payload);

    // Two-chunk blob with the correct whole-blob hash → delivered.
    const enc = (s) => Buffer.from(s, 'utf8').toString('base64');
    const crypto = await import('node:crypto');
    const okSha = crypto.createHash('sha256').update('helloworld').digest('hex');
    await inject({ __arcadeBlob: { id: 'ok1', seq: 0, total: 2, size: 10, mime: 'text/plain', name: 'ok.txt', bytes: enc('hello'), sha: okSha } });
    await inject({ __arcadeBlob: { id: 'ok1', seq: 1, total: 2, size: 10, mime: 'text/plain', name: 'ok.txt', bytes: enc('world'), sha: okSha } });
    // Wrong hash → integrity error, blob never delivered.
    const badSha = '0'.repeat(64);
    await inject({ __arcadeBlob: { id: 'bad1', seq: 0, total: 1, size: 5, mime: 'text/plain', name: 'bad.txt', bytes: enc('hello'), sha: badSha } });
    // Explicit abort mid-transfer → aborted error.
    await inject({ __arcadeBlob: { id: 'ab1', seq: 0, total: 2, size: 10, mime: 'text/plain', name: 'ab.txt', bytes: enc('hello'), sha: okSha } });
    await inject({ __arcadeBlobAbort: { id: 'ab1' } });
    // Old-sender compat: no sha field → delivered unchecked.
    await inject({ __arcadeBlob: { id: 'old1', seq: 0, total: 1, size: 5, mime: 'text/plain', name: 'old.txt', bytes: enc('plain') } });

    let blobState = null;
    for (let i = 0; i < 40; i++) {
        blobState = await frame3.evaluate(() => ({ blobs: window.__blobs, errs: window.__blobErrs }));
        if (blobState.blobs.length >= 2 && blobState.errs.length >= 2) break;
        await page.waitForTimeout(50);
    }
    const okBlob = blobState.blobs.find(b => b.id === 'ok1');
    const oldBlob = blobState.blobs.find(b => b.id === 'old1');
    const integrityErr = blobState.errs.find(e => e.id === 'bad1');
    const abortErr = blobState.errs.find(e => e.id === 'ab1');
    check('blob: hash-verified transfer delivers', !!okBlob && okBlob.text === 'helloworld', JSON.stringify(blobState.blobs));
    check('blob: integrity mismatch → onBlobError, not delivery', !!integrityErr && integrityErr.reason === 'integrity'
        && !blobState.blobs.some(b => b.id === 'bad1'), JSON.stringify(blobState.errs));
    check('blob: sender abort → onBlobError(aborted)', !!abortErr && abortErr.reason === 'aborted' && abortErr.received === 1 && abortErr.total === 2, JSON.stringify(abortErr));
    check('blob: hashless (old-sender) transfer still delivers', !!oldBlob && oldBlob.text === 'plain');

    // ── 9. Blob receive TTL (#41): stalled transfer errors out ──
    // Fresh page with a fake clock so the 60s TTL elapses instantly.
    {
        const clockPage = await browser.newPage();
        await clockPage.clock.install();
        await clockPage.goto(BASE + '/', { waitUntil: 'load' });
        await clockPage.evaluate((src) => window.__arcade.showGame('bridge-test', src, 'Bridge Test'), GAME_PATH);
        let cf = null;
        for (let i = 0; i < 100 && !cf; i++) {
            cf = clockPage.frames().find(f => f.url().includes(GAME_PATH));
            if (!cf) { await clockPage.clock.runFor(50); await clockPage.waitForTimeout(20); }
        }
        // Drive the fake clock past the SDK's 2s bridged handshake window if
        // the welcome hasn't landed yet, then wait for ready.
        await clockPage.clock.runFor(3000);
        await cf.evaluate(() => window.Arcade.ready);
        await cf.evaluate(() => {
            window.__blobErrs = [];
            Arcade.peer.onBlobError((e) => window.__blobErrs.push(e));
        });
        await clockPage.evaluate((p) => {
            const entry = [...document.querySelectorAll('iframe')].find(f => f.src.includes('/bridge-test/'));
            entry.contentWindow.postMessage({ type: 'arcade:peer.message', payload: p, fromPeer: 'test-peer' }, '*');
        }, { __arcadeBlob: { id: 'stall1', seq: 0, total: 3, size: 15, mime: '', name: 'stall.bin', bytes: enc('hello') } });
        await clockPage.waitForTimeout(100);          // let the chunk land on real time
        await clockPage.clock.runFor(90 * 1000);      // TTL + sweeper interval
        let ttlErrs = [];
        for (let i = 0; i < 40; i++) {
            ttlErrs = await cf.evaluate(() => window.__blobErrs);
            if (ttlErrs.length) break;
            await clockPage.clock.runFor(15 * 1000);
            await clockPage.waitForTimeout(25);
        }
        const ttlErr = ttlErrs.find(e => e.id === 'stall1');
        check('blob: stalled transfer times out via TTL (no silent wedge)', !!ttlErr && ttlErr.reason === 'timeout' && ttlErr.received === 1 && ttlErr.total === 3, JSON.stringify(ttlErrs));
        await clockPage.close();
    }

    // ── 10. Eviction suspend-hint (#41): flush runs before teardown ──
    {
        const evictPage = await browser.newPage();
        await evictPage.goto(BASE + '/', { waitUntil: 'load' });
        // Default pool cap is 2 — mount A, then B, then C evicts A (LRU,
        // non-active). A's suspend handler flushes a write through the
        // bridge; under the old synchronous about:blank it never ran.
        const mount = async (gid) => {
            await evictPage.evaluate(([g, src]) => window.__arcade.showGame(g, src, g), [gid, GAME_PATH + '?gid=' + gid]);
            let f = null;
            for (let i = 0; i < 100 && !f; i++) {
                f = evictPage.frames().find(fr => fr.url().includes('gid=' + gid));
                if (!f) await evictPage.waitForTimeout(50);
            }
            await f.evaluate(() => window.Arcade.ready);
            return f;
        };
        const fa = await mount('evict-a');
        await fa.evaluate(() => {
            Arcade.onSuspend(() => { Arcade.state.set('flushedAtSuspend', Date.now()); });
        });
        await mount('evict-b');
        await mount('evict-c'); // evicts evict-a
        let flushed = null;
        for (let i = 0; i < 40 && !flushed; i++) {
            flushed = await evictPage.evaluate(() => localStorage.getItem('arcade.v1.evict-a.flushedAtSuspend'));
            if (!flushed) await evictPage.waitForTimeout(50);
        }
        check('eviction: suspend-time flush lands before teardown', !!flushed, String(flushed));
        await evictPage.waitForTimeout(500); // > RETIRE_GRACE_MS
        const frameGone = await evictPage.evaluate(() =>
            ![...document.querySelectorAll('iframe')].some(f => f.src.includes('gid=evict-a')));
        check('eviction: frame actually torn down after the grace', frameGone);
        await evictPage.close();
    }

    // ── 11. Direct-mode regression: fixture standalone still owns its storage ──
    const solo = await browser.newPage();
    await solo.goto(BASE + GAME_PATH, { waitUntil: 'load' });
    const soloCtx = await solo.evaluate(async () => {
        await Arcade.ready;
        Arcade.state.set('soloKey', 1);
        return { storage: Arcade.context.storage, framed: Arcade.context.framed, back: Arcade.state.get('soloKey') };
    });
    check('standalone page stays in direct mode', soloCtx.storage === 'direct' && soloCtx.framed === false && soloCtx.back === 1, JSON.stringify(soloCtx));
} catch (e) {
    check('run completed', false, e.stack || String(e));
} finally {
    await browser.close();
    server.close();
}

let pass = 0, fail = 0;
for (const c of checks) {
    // eslint-disable-next-line no-console
    console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '  — ' + c.detail}`);
    c.ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} bridge-acceptance checks passed`);
process.exit(fail ? 1 : 0);
