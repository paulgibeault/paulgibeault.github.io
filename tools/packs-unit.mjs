/* packs-unit.mjs — arcade-packs.js offline readiness against fake caches.
 * Run: `node tools/packs-unit.mjs`. Game ids are made up on purpose (Gate C). */
import assert from 'node:assert/strict';
import { readiness, downloadMissing, PACK_CACHE } from '../arcade-packs.js';
import { POINTER_CACHE, PIN_KEY } from '../arcade-release.js';

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
const games = ['alpha', 'beta', 'gamma'].map((id) => ({ id, url: `/${id}/` }));
const pin = { [PIN_KEY]: new Response(JSON.stringify({ version: '1' })) };
const pack = () => new Response(JSON.stringify({ html: '<p>', roots: [], version: 'x' }));
const stored = (...ids) => Object.fromEntries(ids.map((id) => [`__pack/${id}`, pack()]));
const packServer = (fail = []) => async (url) => {
    const id = url.split('/')[1];
    return fail.includes(id) ? new Response('', { status: 404 }) : pack();
};

const tests = {
    async 'counts stored packs against the whole catalog'() {
        const caches = fakeCaches({ [POINTER_CACHE]: pin, [PACK_CACHE]: stored('alpha', 'gamma') });
        assert.deepEqual(await readiness(games, { caches }), { ready: 2, total: 3, missing: ['beta'] });
    },
    async 'nothing is ready without a pinned release to take the SDK from'() {
        const caches = fakeCaches({ [PACK_CACHE]: stored('alpha', 'beta', 'gamma') });
        assert.deepEqual(await readiness(games, { caches }), { ready: 0, total: 3, missing: ['alpha', 'beta', 'gamma'] });
    },
    async 'a cache that throws reads as nothing ready, not an error'() {
        const caches = { open: async () => { throw new Error('quota'); } };
        assert.deepEqual(await readiness(games, { caches }), { ready: 0, total: 3, missing: ['alpha', 'beta', 'gamma'] });
    },
    async 'an empty catalog is 0 of 0'() {
        assert.deepEqual(await readiness([], { caches: fakeCaches({ [POINTER_CACHE]: pin }) }), { ready: 0, total: 0, missing: [] });
    },
    async 'downloadMissing reports each pack as it lands, and the count follows'() {
        const caches = fakeCaches({ [POINTER_CACHE]: pin, [PACK_CACHE]: stored('alpha') });
        const seen = [];
        const got = await downloadMissing(games, { caches, fetch: packServer(['gamma']) }, (id) => seen.push(id));
        assert.equal(got, 1);
        assert.deepEqual(seen, ['beta']);
        assert.deepEqual(await readiness(games, { caches }), { ready: 2, total: 3, missing: ['gamma'] });
    },
    async 'a throwing listener does not stop the downloads'() {
        const caches = fakeCaches({ [POINTER_CACHE]: pin });
        const got = await downloadMissing(games, { caches, fetch: packServer() }, () => { throw new Error('ui gone'); });
        assert.equal(got, 3);
        assert.equal((await readiness(games, { caches })).ready, 3);
    }
};
let failed = 0;
for (const [name, t] of Object.entries(tests)) {
    try { await t(); console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}
process.exit(failed ? 1 : 0);
