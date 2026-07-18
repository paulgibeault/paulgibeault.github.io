/* fake-idb.mjs — minimal in-memory IndexedDB + localStorage shims for Node
 * unit tests that need to run a launcher-side ENGINE (not just its pure
 * core) without a browser. Covers exactly the surface the arcade helpers
 * use (arcade-storage-core.js's idbOpen/idbGet/idbPut/idbAll/idbDel/
 * idbClear + listArcadeDbNames): single 'kv' object store, request objects
 * with onsuccess/onupgradeneeded, transactions whose oncomplete fires on a
 * macrotask after the synchronous request phase.
 *
 * Timing model: requests execute synchronously (mutations apply and results
 * are captured at call time — matching how the helpers issue every request
 * before yielding), onsuccess callbacks fire on a microtask, tx.oncomplete
 * on a double microtask (after every request's onsuccess). That ordering
 * satisfies both waiting styles the helpers use (idbGet awaits
 * request.onsuccess; idbPut/idbAll await tx.oncomplete after capturing
 * request results) while staying fast enough for hundreds of rows.
 */

export function installFakeIndexedDB() {
    const dbs = new Map(); // name -> Map<key, value>

    function makeDb(name) {
        const store = dbs.get(name);
        return {
            objectStoreNames: { contains: () => true },
            createObjectStore() {},
            close() {},
            transaction() {
                const tx = { oncomplete: null, onerror: null, error: null };
                // Microtask, not macrotask: still strictly after the caller's
                // synchronous request phase, but fast enough that engine
                // tests can persist hundreds of rows without minutes of
                // setTimeout(0) churn.
                queueMicrotask(() => queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); }));
                tx.objectStore = () => ({
                    put(value, key) { store.set(key, structuredClone(value)); return {}; },
                    delete(key) { store.delete(key); return {}; },
                    clear() { store.clear(); return {}; },
                    get(key) { return request(store.has(key) ? structuredClone(store.get(key)) : undefined); },
                    getAll() { return request([...store.values()].map((v) => structuredClone(v))); },
                    getAllKeys() { return request([...store.keys()]); }
                });
                return tx;
            }
        };
    }

    function request(result) {
        const req = { result, onsuccess: null, onerror: null, error: null };
        queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); });
        return req;
    }

    globalThis.indexedDB = {
        open(name) {
            const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null, error: null };
            setTimeout(() => {
                const isNew = !dbs.has(name);
                if (isNew) dbs.set(name, new Map());
                req.result = makeDb(name);
                if (isNew && req.onupgradeneeded) req.onupgradeneeded();
                if (req.onsuccess) req.onsuccess();
            }, 0);
            return req;
        },
        databases: async () => [...dbs.keys()].map((name) => ({ name })),
        _dbs: dbs // test-side inspection
    };
    return globalThis.indexedDB;
}

export function installFakeLocalStorage() {
    const m = new Map();
    globalThis.localStorage = {
        get length() { return m.size; },
        key(i) { const keys = [...m.keys()]; return i >= 0 && i < keys.length ? keys[i] : null; },
        getItem(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
        setItem(k, v) { m.set(String(k), String(v)); },
        removeItem(k) { m.delete(String(k)); },
        clear() { m.clear(); }
    };
    return globalThis.localStorage;
}
