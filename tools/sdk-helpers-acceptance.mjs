#!/usr/bin/env node
//
// tools/sdk-helpers-acceptance.mjs — pins the SDK's determinism & sharing
// helpers (issue #37): Arcade.rng (stateful mulberry32 + FNV-1a hash),
// Arcade.daily (device-LOCAL calendar-date rule), Arcade.share (versioned
// base64url, validate-on-decode). The SDK is a classic IIFE, so these run in
// a real page. Self-contained: serves the repo on :4797 and loads
// tools/fixtures/store-test/ (SDK already inits there).
//
//   node tools/sdk-helpers-acceptance.mjs
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4797;

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

    const r = await page.evaluate(() => {
        const out = {};
        const seq = (rng, n) => Array.from({ length: n }, () => rng());

        // ── Arcade.rng determinism + state save/restore ──
        out.rngIsFn = typeof Arcade.rng === 'function';
        const a = Arcade.rng(1234), b = Arcade.rng(1234), c = Arcade.rng(5678);
        const seqA = seq(a, 10), seqB = seq(b, 10), seqC = seq(c, 10);
        out.sameSeedSame = JSON.stringify(seqA) === JSON.stringify(seqB);
        out.diffSeedDiff = JSON.stringify(seqA) !== JSON.stringify(seqC);
        const s1 = Arcade.rng('room-42'), s2 = Arcade.rng('room-42');
        out.stringSeedsWork = s1() === s2();
        const g = Arcade.rng(999);
        seq(g, 5);
        const mid = g.getState();
        const tail1 = seq(g, 5);
        const h = Arcade.rng(0);
        out.setStateOk = h.setState(mid) === true;
        const tail2 = seq(h, 5);
        out.stateContinues = JSON.stringify(tail1) === JSON.stringify(tail2);
        out.setStateRejectsGarbage = h.setState('nope') === false && h.setState(NaN) === false;
        const helpers = Arcade.rng(7);
        out.helpersExist = typeof helpers.int === 'function' && typeof helpers.pick === 'function' && typeof helpers.shuffle === 'function';
        const deck = helpers.shuffle([1, 2, 3, 4, 5]);
        out.shuffleIsCopy = deck.length === 5 && deck.slice().sort().join() === '1,2,3,4,5';

        // ── Arcade.rng.hash — published FNV-1a vectors ──
        out.hashEmpty = Arcade.rng.hash('');
        out.hashA = Arcade.rng.hash('a');
        out.hashIsU32 = Arcade.rng.hash('anything') >>> 0 === Arcade.rng.hash('anything');

        // ── Arcade.daily — the LOCAL-midnight rule ──
        const now = new Date();
        const p2 = (n) => (n < 10 ? '0' : '') + n;
        const localToday = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
        out.dateStrShape = /^\d{4}-\d{2}-\d{2}$/.test(Arcade.daily.dateStr());
        // Pins the LOCAL rule — this assertion fails if anyone "fixes" dateStr
        // to toISOString (UTC), the exact cross-game divergence #37 kills.
        out.dateStrIsLocal = Arcade.daily.dateStr() === localToday;
        out.dateStrOfDate = Arcade.daily.dateStr(new Date(2026, 0, 5)) === '2026-01-05';
        const d1 = seq(Arcade.daily.seed(), 5), d2 = seq(Arcade.daily.seed(), 5);
        out.dailyDeterministic = JSON.stringify(d1) === JSON.stringify(d2);
        const dsA = seq(Arcade.daily.seed('a'), 5), dsB = seq(Arcade.daily.seed('b'), 5);
        out.dailySaltsDiffer = JSON.stringify(dsA) !== JSON.stringify(dsB);

        // ── Arcade.share — round-trip + validate-on-decode ──
        const payload = { msg: '🌙 déjà-vu', n: [1, 2, 3], nested: { ok: true } };
        const code = Arcade.share.encode(payload, { v: 2 });
        out.codeCharset = /^[A-Za-z0-9_-]+$/.test(code);
        const dec = Arcade.share.decode(code);
        out.roundTrip = !!dec && dec.v === 2 && JSON.stringify(dec.data) === JSON.stringify(payload);
        out.defaultV1 = (Arcade.share.decode(Arcade.share.encode({ x: 1 })) || {}).v === 1;
        out.garbageNull = Arcade.share.decode('%%%') === null;
        out.numberNull = Arcade.share.decode(42) === null;
        out.emptyNull = Arcade.share.decode('') === null;
        out.oversizeNull = Arcade.share.decode('x'.repeat(9000)) === null;
        // Flip one char mid-code → bad JSON or bad envelope, never a throw.
        const tampered = code.slice(0, 5) + (code[5] === 'A' ? 'B' : 'A') + code.slice(6);
        let tval;
        try { tval = Arcade.share.decode(tampered); out.tamperNoThrow = true; } catch (e) { out.tamperNoThrow = false; }
        out.tamperNullOrValid = tval === null || (tval && typeof tval.v === 'number');
        // A code whose envelope carries pollution-shaped keys must not pollute.
        const evil = btoa('{"v":1,"d":{"__proto__":{"polluted":1}}}').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const evilDec = Arcade.share.decode(evil);
        out.noPollution = ({}).polluted === undefined && (!evilDec || !('polluted' in ({})));
        out.protoKeyStripped = !evilDec || !Object.prototype.hasOwnProperty.call(evilDec.data || {}, '__proto__');
        return out;
    });

    check('Arcade.rng is a function', r.rngIsFn);
    check('same seed ⇒ identical sequences', r.sameSeedSame);
    check('different seeds ⇒ different sequences', r.diffSeedDiff);
    check('string seeds are deterministic', r.stringSeedsWork);
    check('setState accepts a saved state', r.setStateOk);
    check('getState/setState continue the exact sequence', r.stateContinues);
    check('setState rejects non-finite/non-number state', r.setStateRejectsGarbage);
    check('int/pick/shuffle helpers exist', r.helpersExist);
    check('shuffle returns a permuted copy', r.shuffleIsCopy);
    check('rng.hash("") matches the FNV-1a offset basis', r.hashEmpty === 2166136261, String(r.hashEmpty));
    check('rng.hash("a") matches the published FNV-1a vector', r.hashA === 3826002220, String(r.hashA));
    check('rng.hash returns a u32', r.hashIsU32);
    check('daily.dateStr() is YYYY-MM-DD', r.dateStrShape);
    check('daily.dateStr() uses the device-LOCAL date (the platform rule)', r.dateStrIsLocal);
    check('daily.dateStr(d) formats a given Date', r.dateStrOfDate);
    check('daily.seed() is deterministic within a day', r.dailyDeterministic);
    check('daily.seed(salt) gives independent streams', r.dailySaltsDiffer);
    check('share code uses the base64url charset only', r.codeCharset);
    check('share round-trips a unicode payload with the version echoed', r.roundTrip);
    check('share.encode defaults to v1', r.defaultV1);
    check('share.decode(garbage charset) → null', r.garbageNull);
    check('share.decode(non-string) → null', r.numberNull);
    check('share.decode(empty) → null', r.emptyNull);
    check('share.decode(oversize) → null', r.oversizeNull);
    check('share.decode(tampered) never throws', r.tamperNoThrow && r.tamperNullOrValid);
    check('share.decode strips prototype-polluting keys', r.noPollution && r.protoKeyStripped);
} catch (e) {
    check('run completed', false, e.message);
} finally {
    await browser.close();
    server.close();
}

let failed = 0;
for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail && !c.ok ? ` — ${c.detail}` : ''}`);
    if (!c.ok) failed++;
}
console.log(failed === 0 ? '\nAll SDK-helpers acceptance checks passed.' : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
