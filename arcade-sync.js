/* arcade-sync.js — the launcher-side Arcade.sync replication engine (#28).
 *
 * Games never see this module: it lives entirely on the launcher side of the
 * opaque-frame boundary. Two independent producers feed it "a local write
 * happened" via host hooks wired in index.html:
 *   - arcade-storage-bridge.js's handleBridgedStateWrite (a game's
 *     Arcade.state.set reaching localStorage through the bridge)
 *   - arcade-save.js's importSaveFile (a save-file restore)
 * and one producer feeds it inbound replication frames from paired devices:
 *   - arcade-p2p.js's onSyncEnvelope, which already restricts delivery to
 *     DIRECT links with a completed identity binding (relayed/host-forwarded
 *     frames are dropped transport-side, never reach here).
 *
 * Trust posture: a paired device only gains write authority over this
 * device's storage once BOTH sides have opted the pair in
 * (knownPeers[deviceId].syncEnabled === true, toggled per-pair in the
 * Multiplayer dialog) AND its fingerprint isn't suspect this session
 * (ArcadeP2P.isFingerprintSuspect — the same gate pairing itself uses). Even
 * then, every inbound field is validated (validateSyncEnvelope, from
 * arcade-sync-core.js) before it touches storage: a malicious-but-paired
 * peer can only write keys that pass syncEligibleKey (own-namespace app
 * keys only — never `_meta.*`, `global.*`, SDK sidecars, or the `.ls.`
 * subtree), with bounded values, under a validated HLC/hash shape. See
 * arcade-sync-core.js's header and plans/arcade-sync.md for the full design
 * (HLC clock, digest/diff wire protocol, LWW apply rule, conflict
 * detection).
 *
 * Echo-loop safety: applying an inbound diff writes localStorage and the
 * record mirror DIRECTLY — it never calls noteLocalWrite (that would
 * re-stamp the write with THIS device's clock, as if it were a fresh local
 * edit, defeating LWW and bouncing the write back out). noteLocalWrite is
 * only ever invoked by the bridge/save host hooks below, i.e. only for
 * writes that actually originated on this device.
 *
 * Lazy by design: initSyncEngine(host) does no localStorage scan and no
 * IndexedDB open at call time. Every entry point gates on a cheap, scan-free
 * check first (a single localStorage.getItem for a write's own app, or a
 * syncEnabled flag read from knownPeers) and only calls ensureLoaded() —
 * which performs the one-time full scan + IDB load — once sync is actually
 * relevant. A visitor with no `_sync` opt-in list anywhere and no
 * sync-enabled paired device therefore never opens the `arcade-sync` IDB
 * database at all.
 *
 * No top-level side effects: everything below is import statements and
 * function/const declarations. initSyncEngine(host) is the only thing that
 * runs, and only when index.html's module block calls it.
 */

import {
    SYNC_DB,
    SYNC_TOMBSTONE_TTL_MS,
    SYNC_TOMBSTONE_CAP_PER_APP,
    hlcNext,
    hlcRecv,
    sha256Hex,
    chunkEntries,
    planFromDigest,
    applyDecision,
    isConcurrentLoss,
    validateSyncEnvelope
} from './arcade-sync-core.js';
import {
    KEY_PREFIX,
    syncEligibleKey,
    SYNC_LIST_RE,
    SYNC_VALUE_MAX,
    SYNC_FRAME_BUDGET,
    SYNC_MAX_ENTRIES,
    idbOpen,
    idbGet,
    idbPut,
    idbAll,
    idbDel
} from './arcade-storage-core.js';
import { readKnownPeers } from './arcade-known-peers.js';
import { ArcadeDiag } from './arcade-diag.js';

// Mirrors arcade-p2p.js's device-id minting exactly (same key, same shape):
// whichever module runs first mints it, the other just reads it back.
const DEVICE_ID_KEY = KEY_PREFIX + '_meta.deviceId';
const DEVICE_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|dev-[a-z0-9]{6,50})$/i;
function randomDeviceId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// A remote digest exchange must fully reassemble (or time out) within this
// window; a new exchange from the same device resets the buffer.
const DIGEST_REASSEMBLY_TIMEOUT_MS = 30 * 1000;
// Dedupe window for onPeerIdentity-triggered exchange starts — a
// reconnect/roster churn shouldn't fire a fresh full digest exchange every
// beat. kick() (explicit UI toggle-on) bypasses this.
const EXCHANGE_DEDUPE_MS = 30 * 1000;
// Hard structural cap on a single digest's part count (mirrors the
// inbound-validation posture: reject before buffering, never trust size
// fields blindly). SYNC_MAX_ENTRIES/SYNC_FRAME_BUDGET already bound how many
// parts a HONEST peer would ever produce; this is a backstop against a
// malformed/hostile part count.
const MAX_DIGEST_PARTS = 64;

const CHANGED = 'arcade:state.changed';

export function initSyncEngine(host) {
    const postToIframe = host.postToIframe;

    // ---- device id (lazy: only minted once something actually stamps) ----
    let myDeviceId = null;
    function getMyDeviceId() {
        if (myDeviceId) return myDeviceId;
        try {
            let id = localStorage.getItem(DEVICE_ID_KEY);
            if (!id || !DEVICE_ID_RE.test(id)) {
                id = randomDeviceId();
                localStorage.setItem(DEVICE_ID_KEY, id);
            }
            myDeviceId = id;
        } catch (e) {
            myDeviceId = randomDeviceId(); // storage unavailable — ephemeral fallback
        }
        return myDeviceId;
    }

    // ---- lazy-loaded engine state ----
    let loaded = false;
    let loadingPromise = null;
    let db = null;                 // persistent IDB handle to the 'arcade-sync' database
    let clock = null;               // packed HLC string | null — last issued/observed
    const records = new Map();      // fullKey -> { h, x, del, t }
    const cursors = new Map();      // deviceId -> { hlc, at }
    const syncable = new Map();     // appId -> Set(keys) | '*'  (from each app's _sync list)
    let p2p = null;                 // ArcadeP2P, once attachP2P() wires it
    const conflictListeners = [];
    const digestBuffers = new Map();   // deviceId -> { parts, chunks: Map<part, entries[]>, timer }
    const pendingCursors = new Map();  // deviceId -> { hlc, need: Set<fullKey>, timer } — cursor
                                       // value earned by a digest exchange but NOT committed
                                       // until every req'd diff has arrived (see reconcileDigest)
    const inFlightExchange = new Map(); // deviceId -> ms timestamp of last exchange start
    const oversizeLogged = new Set();   // keys already logged as "too big to sync" (log once)
    let tombstoneHashPromise = null;    // cached sha256Hex of the tombstone sentinel

    function tombstoneHash() {
        // A reserved sentinel string, never a value a real write could
        // produce (raw values are always valid JSON text), so a tombstone's
        // content-hash never collides with a live empty-string write.
        if (!tombstoneHashPromise) tombstoneHashPromise = sha256Hex(' arcade-sync-tombstone-sentinel ');
        return tombstoneHashPromise;
    }

    function appIdOf(fullKey) {
        const rest = fullKey.slice(KEY_PREFIX.length);
        const dot = rest.indexOf('.');
        return dot === -1 ? rest : rest.slice(0, dot);
    }

    function refreshSyncableForApp(appId) {
        const listKey = KEY_PREFIX + appId + '._sync';
        let list;
        try { list = JSON.parse(localStorage.getItem(listKey) || 'null'); } catch (e) { list = null; }
        if (!Array.isArray(list)) { syncable.delete(appId); return; }
        const strs = list.filter((x) => typeof x === 'string');
        if (strs.indexOf('*') !== -1) syncable.set(appId, '*');
        else if (strs.length) syncable.set(appId, new Set(strs));
        else syncable.delete(appId);
    }

    function isKeySynced(fullKey) {
        if (!syncEligibleKey(fullKey)) return false;
        const s = syncable.get(appIdOf(fullKey));
        if (!s) return false;
        return s === '*' || s.has(fullKey);
    }

    function scanSyncLists() {
        syncable.clear();
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && SYNC_LIST_RE.test(k)) refreshSyncableForApp(appIdOf(k));
            }
        } catch (e) {}
    }

    async function loadFromIdb() {
        db = await idbOpen(SYNC_DB);
        const c = await idbGet(db, 'clock');
        clock = (typeof c === 'string') ? c : null;
        const rows = await idbAll(db);
        for (const row of rows) {
            if (typeof row.key !== 'string') continue;
            if (row.key.charAt(0) === 'k' && row.key.charAt(1) === '|') records.set(row.key.slice(2), row.value);
            else if (row.key.charAt(0) === 'p' && row.key.charAt(1) === '|') cursors.set(row.key.slice(2), row.value);
        }
    }

    async function gcTombstones() {
        const now = Date.now();
        const byApp = new Map();
        for (const [k, rec] of records) {
            if (!rec || rec.del !== 1) continue;
            const appId = appIdOf(k);
            if (!byApp.has(appId)) byApp.set(appId, []);
            byApp.get(appId).push([k, rec]);
        }
        const toDelete = [];
        for (const list of byApp.values()) {
            const kept = [];
            for (const [k, rec] of list) {
                if (now - (rec.t || 0) > SYNC_TOMBSTONE_TTL_MS) toDelete.push(k);
                else kept.push([k, rec]);
            }
            if (kept.length > SYNC_TOMBSTONE_CAP_PER_APP) {
                kept.sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
                for (let i = 0; i < kept.length - SYNC_TOMBSTONE_CAP_PER_APP; i++) toDelete.push(kept[i][0]);
            }
        }
        for (const k of toDelete) {
            records.delete(k);
            try { await idbDel(db, 'k|' + k); } catch (e) {}
        }
    }

    async function stampAndStore(fullKey, hash, del) {
        const now = Date.now();
        clock = hlcNext(clock, now, getMyDeviceId());
        const rec = { h: clock, x: hash, del: del ? 1 : 0, t: now };
        records.set(fullKey, rec);
        try { await idbPut(db, 'clock', clock); } catch (e) {}
        try { await idbPut(db, 'k|' + fullKey, rec); } catch (e) {}
        return rec;
    }

    // Stamps a fresh HLC for every key in `keys` whose stored value has no
    // record yet, or whose hash no longer matches its record (standalone
    // edits, or data written before this device ever loaded Arcade.sync).
    async function stampMissingOrChanged(keys) {
        for (const k of keys) {
            let raw;
            try { raw = localStorage.getItem(k); } catch (e) { raw = null; }
            if (raw === null) continue;
            const hash = await sha256Hex(raw);
            const rec = records.get(k);
            if (!rec || rec.x !== hash) await stampAndStore(k, hash, 0);
        }
    }

    function ensureLoaded() {
        if (loaded) return Promise.resolve();
        if (loadingPromise) return loadingPromise;
        loadingPromise = (async () => {
            scanSyncLists();
            await loadFromIdb();
            await gcTombstones();
            const toCheck = [];
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && isKeySynced(k)) toCheck.push(k);
                }
            } catch (e) {}
            await stampMissingOrChanged(toCheck);
            loaded = true;
        })();
        return loadingPromise;
    }

    // ---- outbound wire helpers ----
    function buildDiffEntries(keys) {
        const out = [];
        for (const k of keys) {
            const rec = records.get(k);
            if (!rec) continue;
            if (rec.del === 1) { out.push({ k, h: rec.h, del: 1 }); continue; }
            let raw;
            try { raw = localStorage.getItem(k); } catch (e) { raw = null; }
            if (typeof raw !== 'string') continue; // record exists but value is gone locally
            if (raw.length > SYNC_VALUE_MAX) {
                if (!oversizeLogged.has(k)) {
                    oversizeLogged.add(k);
                    ArcadeDiag.log('sync', `key exceeds sync value cap (${raw.length} > ${SYNC_VALUE_MAX}) — not sent: ${k}`);
                }
                continue;
            }
            out.push({ k, h: rec.h, v: raw });
        }
        return out;
    }

    function sendDiffTo(deviceId, keys) {
        if (!p2p || !keys || !keys.length) return;
        const entries = buildDiffEntries(keys);
        if (!entries.length) return;
        for (const chunk of chunkEntries(entries, SYNC_MAX_ENTRIES, SYNC_FRAME_BUDGET)) {
            if (chunk.length) p2p.sendSyncEnvelope(deviceId, { v: 1, op: 'diff', entries: chunk });
        }
    }

    function sendReqTo(deviceId, keys) {
        if (!p2p || !keys || !keys.length) return;
        for (const chunk of chunkEntries(keys, SYNC_MAX_ENTRIES, SYNC_FRAME_BUDGET)) {
            if (chunk.length) p2p.sendSyncEnvelope(deviceId, { v: 1, op: 'req', keys: chunk });
        }
    }

    function sendDigestTo(deviceId) {
        if (!p2p) return;
        const entries = [];
        for (const [k, rec] of records) entries.push([k, rec.h, rec.x]);
        const chunks = chunkEntries(entries, SYNC_MAX_ENTRIES, SYNC_FRAME_BUDGET);
        const parts = chunks.length;
        for (let i = 0; i < chunks.length; i++) {
            p2p.sendSyncEnvelope(deviceId, { v: 1, op: 'digest', part: i, parts, entries: chunks[i] });
        }
    }

    // ---- peer eligibility gate (cheap: no IDB) ----
    function peerSyncEnabled(deviceId) {
        const rec = readKnownPeers()[deviceId];
        return !!(rec && rec.syncEnabled === true);
    }
    function peerSuspect(deviceId) {
        return !!(p2p && typeof p2p.isFingerprintSuspect === 'function' && p2p.isFingerprintSuspect(deviceId));
    }

    async function maybeStartExchange(deviceId, force) {
        if (!p2p || !peerSyncEnabled(deviceId) || peerSuspect(deviceId)) return;
        const now = Date.now();
        if (!force) {
            const last = inFlightExchange.get(deviceId);
            if (last !== undefined && now - last < EXCHANGE_DEDUPE_MS) return;
        }
        inFlightExchange.set(deviceId, now);
        await ensureLoaded();
        sendDigestTo(deviceId);
    }

    // ---- inbound: digest reassembly + reconciliation ----
    async function reconcileDigest(fromDeviceId, remoteEntries) {
        for (const e of remoteEntries) {
            if (Array.isArray(e) && typeof e[1] === 'string') clock = hlcRecv(clock, e[1], Date.now(), getMyDeviceId());
        }
        try { await idbPut(db, 'clock', clock); } catch (e) {}

        const plan = planFromDigest(records, remoteEntries);
        for (const [k, hlc] of plan.adopt) {
            // Same content, HLC bookkeeping only — no data motion, and
            // deliberately never fed into send/diff below (that would be a
            // digest ping-pong: adopt <-> diff <-> digest forever).
            const rec = records.get(k);
            if (!rec) continue;
            const updated = { h: hlc, x: rec.x, del: rec.del, t: rec.t };
            records.set(k, updated);
            try { await idbPut(db, 'k|' + k, updated); } catch (e) {}
        }
        sendReqTo(fromDeviceId, plan.need);
        sendDiffTo(fromDeviceId, plan.send);

        // Cursor discipline (the bug WP5's suite caught): receiving a digest
        // proves what the PEER has — it proves nothing about whether the peer
        // observed OUR records. clock is now advanced past every HLC in the
        // union (each local record was stamped from it; hlcRecv above covered
        // each remote entry), which makes it the right cursor VALUE for "last
        // completed exchange" — but committing it here, before the req'd
        // diffs for contested keys have even arrived, would make
        // isConcurrentLoss() see every such local record as already-observed
        // and silently swallow onConflict on exactly the reconnect-after-
        // split path the feature exists for. So the value is parked as a
        // PENDING cursor and committed only when the exchange completes:
        // every key we req'd has had its diff processed (immediately, when we
        // needed nothing). Until then conflict checks keep reading the
        // previous committed cursor. A pending cursor that never drains
        // (diffs lost in transit) is dropped on timeout, NOT committed — the
        // next exchange re-earns it; erring this way risks a spurious
        // conflict notification, never a swallowed one.
        const prevPending = pendingCursors.get(fromDeviceId);
        if (prevPending && prevPending.timer) clearTimeout(prevPending.timer);
        const pending = { hlc: clock, need: new Set(plan.need), timer: null };
        if (pending.need.size === 0) {
            pendingCursors.delete(fromDeviceId);
            await commitCursor(fromDeviceId, pending.hlc);
        } else {
            pending.timer = setTimeout(() => {
                if (pendingCursors.get(fromDeviceId) === pending) pendingCursors.delete(fromDeviceId);
            }, DIGEST_REASSEMBLY_TIMEOUT_MS);
            pendingCursors.set(fromDeviceId, pending);
        }
    }

    async function commitCursor(deviceId, hlc) {
        const cursor = { hlc, at: Date.now() };
        cursors.set(deviceId, cursor);
        try { await idbPut(db, 'p|' + deviceId, cursor); } catch (e) {}
    }

    // Called after EVERY processed diff entry (applied or skipped — either
    // way the peer's answer for that key arrived): drains the pending
    // exchange's need-set and commits the parked cursor once it empties.
    // Runs AFTER applyInboundDiffEntry so the entry that completes the
    // exchange still had its conflict evaluated against the old cursor.
    async function drainPendingNeed(deviceId, key) {
        const pending = pendingCursors.get(deviceId);
        if (!pending || !pending.need.delete(key)) return;
        if (pending.need.size !== 0) return;
        if (pending.timer) clearTimeout(pending.timer);
        pendingCursors.delete(deviceId);
        await commitCursor(deviceId, pending.hlc);
    }

    async function handleInboundDigest(fromDeviceId, env) {
        const part = env.part, parts = env.parts;
        if (!Number.isInteger(part) || !Number.isInteger(parts) || part < 0 || part >= parts || parts > MAX_DIGEST_PARTS) {
            ArcadeDiag.log('sync', `rejected malformed digest part/parts from ${fromDeviceId}`);
            return;
        }
        let buf = digestBuffers.get(fromDeviceId);
        if (part === 0 || !buf || buf.parts !== parts) {
            if (buf && buf.timer) clearTimeout(buf.timer);
            buf = { parts, chunks: new Map(), timer: null };
            digestBuffers.set(fromDeviceId, buf);
        }
        buf.chunks.set(part, Array.isArray(env.entries) ? env.entries : []);
        if (buf.timer) clearTimeout(buf.timer);
        buf.timer = setTimeout(() => {
            const cur = digestBuffers.get(fromDeviceId);
            if (cur === buf) digestBuffers.delete(fromDeviceId);
        }, DIGEST_REASSEMBLY_TIMEOUT_MS);
        if (buf.chunks.size < buf.parts) return;
        clearTimeout(buf.timer);
        digestBuffers.delete(fromDeviceId);
        const remoteEntries = [];
        for (let i = 0; i < buf.parts; i++) {
            const c = buf.chunks.get(i);
            if (c) remoteEntries.push(...c);
        }
        await reconcileDigest(fromDeviceId, remoteEntries);
    }

    async function handleInboundReq(fromDeviceId, env) {
        const keys = Array.isArray(env.keys) ? env.keys : [];
        sendDiffTo(fromDeviceId, keys.filter((k) => records.has(k)));
    }

    function adoptIntoSyncList(appId, key) {
        const listKey = KEY_PREFIX + appId + '._sync';
        let list;
        try { list = JSON.parse(localStorage.getItem(listKey) || 'null'); } catch (e) { list = null; }
        if (!Array.isArray(list)) list = [];
        if (list.indexOf('*') !== -1 || list.indexOf(key) !== -1) {
            refreshSyncableForApp(appId); // keep the cache honest even if nothing changed
            return;
        }
        list.push(key);
        // Direct write, deliberately bypassing noteLocalWrite/stampAndStore:
        // the _sync list itself is a sidecar (syncEligibleKey rejects it),
        // never a replicated record.
        try { localStorage.setItem(listKey, JSON.stringify(list)); } catch (e) { return; }
        refreshSyncableForApp(appId);
        postToIframe(appId, { type: CHANGED, key: listKey, value: JSON.stringify(list) });
    }

    async function applyInboundDiffEntry(fromDeviceId, e) {
        const key = e.k;
        clock = hlcRecv(clock, e.h, Date.now(), getMyDeviceId());
        try { await idbPut(db, 'clock', clock); } catch (err) {}

        const localRec = records.get(key);
        const isDel = e.del === 1;
        const decision = applyDecision(localRec, { h: e.h });
        if (decision !== 'apply') return; // local wins (or exact-same stamp) — stay silent, no echo

        const newHash = isDel ? await tombstoneHash() : await sha256Hex(e.v);
        const cursor = cursors.get(fromDeviceId);
        const concurrentLoss = !!localRec && localRec.x !== newHash
            && isConcurrentLoss(localRec, cursor ? cursor.hlc : null, getMyDeviceId());

        let mineForConflict = null;
        if (concurrentLoss && localRec.del !== 1) {
            let rawBefore;
            try { rawBefore = localStorage.getItem(key); } catch (err) { rawBefore = null; }
            if (typeof rawBefore === 'string') { try { mineForConflict = JSON.parse(rawBefore); } catch (err) { mineForConflict = null; } }
        }

        // Apply: localStorage write + record update, direct — never through
        // noteLocalWrite (see module header: that would re-stamp this write
        // with OUR clock and bounce it back out as a fresh local edit).
        try {
            if (isDel) localStorage.removeItem(key);
            else localStorage.setItem(key, e.v);
        } catch (err) {
            ArcadeDiag.log('sync', `apply failed for ${key}: ${(err && err.message) || err}`);
            return;
        }
        const rec = { h: e.h, x: newHash, del: isDel ? 1 : 0, t: Date.now() };
        records.set(key, rec);
        try { await idbPut(db, 'k|' + key, rec); } catch (err) {}

        const appId = appIdOf(key);
        postToIframe(appId, { type: CHANGED, key, value: isDel ? null : e.v });
        // Inbound adoption: replication stays bidirectional even before the
        // app ever ran locally on this device. Broadcasts its own
        // state.changed for the _sync list key when it actually mutates.
        adoptIntoSyncList(appId, key);

        if (concurrentLoss) {
            let theirs = null;
            if (!isDel) { try { theirs = JSON.parse(e.v); } catch (err) { theirs = null; } }
            const payload = { key, mine: mineForConflict, theirs };
            for (const fn of conflictListeners) { try { fn(payload); } catch (err) {} }
            const unprefixed = key.slice(KEY_PREFIX.length + appId.length + 1);
            postToIframe(appId, { type: 'arcade:sync.conflict', key: unprefixed, mine: mineForConflict, theirs });
        }
    }

    async function handleInboundDiff(fromDeviceId, env) {
        const entries = Array.isArray(env.entries) ? env.entries : [];
        for (const e of entries) {
            await applyInboundDiffEntry(fromDeviceId, e);
            await drainPendingNeed(fromDeviceId, e.k);
        }
    }

    async function handleInbound(fromDeviceId, env) {
        try {
            if (!peerSyncEnabled(fromDeviceId) || peerSuspect(fromDeviceId)) return;
            const result = validateSyncEnvelope(env, { maxEntries: SYNC_MAX_ENTRIES, valueMax: SYNC_VALUE_MAX });
            if (!result.ok) {
                ArcadeDiag.log('sync', `rejected inbound envelope from ${fromDeviceId}: ${result.reason}`);
                return;
            }
            await ensureLoaded();
            if (result.op === 'digest') await handleInboundDigest(fromDeviceId, env);
            else if (result.op === 'req') await handleInboundReq(fromDeviceId, env);
            else await handleInboundDiff(fromDeviceId, env);
        } catch (e) {
            ArcadeDiag.log('sync', `inbound handling error from ${fromDeviceId}: ${(e && e.message) || e}`);
        }
    }

    // ---- host hooks (local writes) ----
    async function onSyncListWrite(listKey) {
        await ensureLoaded();
        const appId = appIdOf(listKey);
        refreshSyncableForApp(appId);
        const prefix = KEY_PREFIX + appId + '.';
        const toCheck = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf(prefix) === 0 && isKeySynced(k)) toCheck.push(k);
            }
        } catch (e) {}
        await stampMissingOrChanged(toCheck);
    }

    async function onSyncedLocalWrite(key, value) {
        await ensureLoaded();
        if (!isKeySynced(key)) return; // defensive re-check now that the cache is authoritative
        const rec = (value === null)
            ? await stampAndStore(key, await tombstoneHash(), 1)
            : await stampAndStore(key, await sha256Hex(value), 0);
        if (!p2p) return;
        const known = readKnownPeers();
        for (const deviceId of Object.keys(known)) {
            if (known[deviceId].syncEnabled !== true || peerSuspect(deviceId)) continue;
            const state = p2p.connectionState(deviceId);
            if (state !== 'connected' && state !== 'interrupted') continue;
            if (value === null) {
                p2p.sendSyncEnvelope(deviceId, { v: 1, op: 'diff', entries: [{ k: key, h: rec.h, del: 1 }] });
                continue;
            }
            if (value.length > SYNC_VALUE_MAX) {
                if (!oversizeLogged.has(key)) {
                    oversizeLogged.add(key);
                    ArcadeDiag.log('sync', `key exceeds sync value cap (${value.length} > ${SYNC_VALUE_MAX}) — not sent: ${key}`);
                }
                continue;
            }
            p2p.sendSyncEnvelope(deviceId, { v: 1, op: 'diff', entries: [{ k: key, h: rec.h, v: value }] });
        }
    }

    // Called from the storage-bridge host hook for EVERY bridged write
    // (synced or not) — must stay cheap (no IDB, no full scan) for the
    // common non-synced case: a single localStorage.getItem for this key's
    // own app's _sync list, nothing more.
    function noteLocalWrite(key, value) {
        if (typeof key !== 'string') return;
        if (SYNC_LIST_RE.test(key)) {
            onSyncListWrite(key).catch((e) => ArcadeDiag.log('sync', `sync-list refresh failed: ${(e && e.message) || e}`));
            return;
        }
        if (!syncEligibleKey(key)) return;
        let listRaw;
        try { listRaw = localStorage.getItem(KEY_PREFIX + appIdOf(key) + '._sync'); } catch (e) { listRaw = null; }
        if (!listRaw) return; // no opt-in list for this app at all — nothing to do, no IDB touched
        let list;
        try { list = JSON.parse(listRaw); } catch (e) { list = null; }
        if (!Array.isArray(list) || (list.indexOf('*') === -1 && list.indexOf(key) === -1)) return;
        onSyncedLocalWrite(key, value).catch((e) => ArcadeDiag.log('sync', `local-write stamp failed: ${(e && e.message) || e}`));
    }

    // Called from arcade-save.js after a save-file import commits its
    // localStorage keys. An import is a deliberate "now" edit — imported
    // synced keys are unconditionally re-stamped (unlike the passive
    // "only if missing/changed" rule ensureLoaded uses for pre-existing
    // data), so the import wins over older remote edits on the next sync.
    function noteImportCommitted(keys) {
        if (!Array.isArray(keys) || !keys.length) return;
        const relevantApps = new Set();
        for (const k of keys) {
            if (typeof k !== 'string') continue;
            const appId = appIdOf(k);
            if (relevantApps.has(appId)) continue;
            let listRaw;
            try { listRaw = localStorage.getItem(KEY_PREFIX + appId + '._sync'); } catch (e) { listRaw = null; }
            if (listRaw) relevantApps.add(appId);
        }
        if (!relevantApps.size) return; // no app in this import opts into sync — nothing to do
        (async () => {
            await ensureLoaded();
            for (const k of keys) {
                if (typeof k !== 'string' || !isKeySynced(k)) continue;
                let raw;
                try { raw = localStorage.getItem(k); } catch (e) { raw = null; }
                if (raw === null) continue;
                await stampAndStore(k, await sha256Hex(raw), 0);
            }
        })().catch((e) => ArcadeDiag.log('sync', `import re-stamp failed: ${(e && e.message) || e}`));
    }

    function attachP2P(p2pRef) {
        p2p = p2pRef;
        p2p.onSyncEnvelope((fromDeviceId, env) => {
            handleInbound(fromDeviceId, env).catch((e) => ArcadeDiag.log('sync', `inbound crashed: ${(e && e.message) || e}`));
        });
        p2p.onPeerIdentity(({ deviceId }) => {
            maybeStartExchange(deviceId).catch((e) => ArcadeDiag.log('sync', `exchange-start failed for ${deviceId}: ${(e && e.message) || e}`));
        });
    }

    function kick(deviceId) {
        maybeStartExchange(deviceId, true).catch((e) => ArcadeDiag.log('sync', `kick failed for ${deviceId}: ${(e && e.message) || e}`));
    }

    function onConflict(fn) {
        conflictListeners.push(fn);
        return () => {
            const i = conflictListeners.indexOf(fn);
            if (i >= 0) conflictListeners.splice(i, 1);
        };
    }

    return {
        noteLocalWrite,
        noteImportCommitted,
        attachP2P,
        kick,
        onConflict,
        // Test hooks: RAM-mirror snapshot and per-pair cursor. Fine to expose
        // read-only — acceptance suites poll these to assert convergence.
        _records() {
            const out = {};
            for (const [k, v] of records) out[k] = { h: v.h, x: v.x, del: v.del, t: v.t };
            return out;
        },
        _cursor(deviceId) {
            const c = cursors.get(deviceId);
            return c ? { hlc: c.hlc, at: c.at } : null;
        }
    };
}
