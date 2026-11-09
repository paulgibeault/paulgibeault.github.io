/* release-unit.mjs — arcade-release.js against fake caches and network.
 * Run: `node tools/release-unit.mjs`. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { check, install, pinned, POINTER_CACHE, PIN_KEY, CACHE_PREFIX } from '../arcade-release.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function fakeCaches(seed = {}) {
    const stores = new Map(Object.entries(seed).map(([k, v]) => [k, new Map(Object.entries(v))]));
    return {
        stores,
        async open(n) {
            if (!stores.has(n)) stores.set(n, new Map());
            const m = stores.get(n);
            return { match: async (k) => m.has(k) ? m.get(k).clone() : undefined, put: async (k, r) => { m.set(k, r); } };
        },
        async delete(n) { return stores.delete(n); },
        async keys() { return [...stores.keys()]; }
    };
}
const env = (caches, files) => ({
    caches,
    digest: async (buf) => crypto.createHash('sha256').update(new Uint8Array(buf)).digest(),
    fetch: async (raw) => {
        if (files instanceof Error) throw files;
        const u = raw.split('?')[0];
        return u in files ? new Response(files[u]) : new Response('', { status: 404 });
    }
});
const pin = (v) => ({ [PIN_KEY]: new Response(JSON.stringify({ version: v })) });
const OLD = `${CACHE_PREFIX}v1`, NEW = `${CACHE_PREFIX}v2`;
const seeded = () => fakeCaches({ [POINTER_CACHE]: pin('1'), [OLD]: {}, 'moon-lit-v9': {} });
const manifest = { version: '2', assets: { './a.js': sha('A'), './b.js': sha('B') }, icons: ['./x/icon.png'] };
const good = { './a.js': 'A', './b.js': 'B' };

const tests = {
    async 'check flags a different deployed version and writes nothing'() {
        const c = seeded();
        const r = await check(env(c, { './release.json': JSON.stringify(manifest) }));
        assert.equal(r.available, true);
        assert.deepEqual(await c.keys(), [POINTER_CACHE, OLD, 'moon-lit-v9']);
    },
    async 'check reports the pinned version as current'() {
        const r = await check(env(seeded(), { './release.json': JSON.stringify({ ...manifest, version: '1' }) }));
        assert.equal(r.available, false);
        assert.equal(r.failed, false);
    },
    async 'offline is a failure; a 404 is only nothing to update to'() {
        assert.equal((await check(env(seeded(), new Error('offline')))).failed, true);
        assert.deepEqual(await check(env(seeded(), {})), { available: false, failed: false });
    },
    async 'install moves the pin and removes only the launcher\'s old caches'() {
        const c = seeded();
        await install(manifest, env(c, good));
        assert.equal(await pinned({ caches: c }), '2');
        assert.deepEqual((await c.keys()).sort(), [POINTER_CACHE, NEW, 'moon-lit-v9'].sort());
    },
    async 'a missing icon does not block an update'() {
        const c = seeded();
        await install(manifest, env(c, good));
        assert.equal(c.stores.get(NEW).size, 2);
    },
    async 'a corrupt or missing file aborts with the old release intact'() {
        for (const files of [{ './a.js': 'A', './b.js': 'TAMPERED' }, { './a.js': 'A' }]) {
            const c = seeded();
            await assert.rejects(install(manifest, env(c, files)));
            assert.equal(await pinned({ caches: c }), '1');
            assert.ok(c.stores.has(OLD));
            assert.ok(!c.stores.has(NEW));
        }
    },
    async 'sw.js and this module agree on the pointer'() {
        const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
        assert.ok(sw.includes("const CACHE_PREFIX = 'paul-arcade-';"));
        assert.ok(sw.includes("const POINTER_CACHE = `${CACHE_PREFIX}release`;"));
        assert.ok(sw.includes(`const PIN_KEY = '${PIN_KEY}';`));
        assert.equal(POINTER_CACHE, 'paul-arcade-release');
    }
};
let failed = 0;
for (const [name, t] of Object.entries(tests)) {
    try { await t(); console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}
process.exit(failed ? 1 : 0);
