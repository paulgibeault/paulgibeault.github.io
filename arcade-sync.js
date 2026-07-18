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
 * which performs the one-time full scan + IDB load — once sync or the
 * durability journal is actually relevant. Since the two-tier journal
 * (durability design §3), EVERY bridged write is journaled — synced keys as
 * replicated `sync` records, everything else as never-replicated `local`
 * records — so a device where a game writes state opens the `arcade-sync`
 * DB on the first coalesced journal flush. The no-P2P visitor who never
 * launches a game still never opens it.
 *
 * No top-level side effects: everything below is import statements and
 * function/const declarations. initSyncEngine(host) is the only thing that
 * runs, and only when index.html's module block calls it.
 */

import {
    SYNC_DB,
    SYNC_TOMBSTONE_CAP_PER_APP,
    appIdOfKey,
    planTombstoneGc,
    hlcNext,
    hlcRecv,
    hlcCompare,
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
import { DEVICE_ID_RE } from './arcade-envelope.js';

// Mirrors arcade-p2p.js's device-id minting exactly (same key, same shape):
// whichever module runs first mints it, the other just reads it back.
const DEVICE_ID_KEY = KEY_PREFIX + '_meta.deviceId';
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
    const records = new Map();      // fullKey -> { h, x, del, t } — sync class, replicated
    const localRecords = new Map(); // fullKey -> { h, x, del, t } — local class, NEVER replicated.
                                    // Separate map + separate IDB prefix ('j|' vs 'k|') is a
                                    // security invariant, not a style choice: every wire path
                                    // (sendDigestTo, buildDiffEntries, handleInboundReq) reads
                                    // `records` only, so a malicious-but-paired peer req'ing a
                                    // journaled non-synced key gets nothing — it cannot leak
                                    // even by bug, because the wire never sees this map.
    const watermarks = new Map();   // appId -> { t, h } — max tombstone ever GC-evicted ('w|'
                                    // rows). A delta base older than this cannot express the
                                    // evicted deletion (durability design §6) — offers must
                                    // fall back to a full transfer.
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
    const digestOverflowLogged = new Set(); // deviceIds already warned about over-cap digests (log once)
    let tombstoneHashPromise = null;    // cached sha256Hex of the tombstone sentinel

    function tombstoneHash() {
        // A reserved sentinel string, never a value a real write could
        // produce (raw values are always valid JSON text), so a tombstone's
        // content-hash never collides with a live empty-string write.
        if (!tombstoneHashPromise) tombstoneHashPromise = sha256Hex(' arcade-sync-tombstone-sentinel ');
        return tombstoneHashPromise;
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
        const s = syncable.get(appIdOfKey(fullKey));
        if (!s) return false;
        return s === '*' || s.has(fullKey);
    }

    function scanSyncLists() {
        syncable.clear();
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && SYNC_LIST_RE.test(k)) refreshSyncableForApp(appIdOfKey(k));
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
            else if (row.key.charAt(0) === 'j' && row.key.charAt(1) === '|') localRecords.set(row.key.slice(2), row.value);
            else if (row.key.charAt(0) === 'p' && row.key.charAt(1) === '|') cursors.set(row.key.slice(2), row.value);
            else if (row.key.charAt(0) === 'w' && row.key.charAt(1) === '|') watermarks.set(row.key.slice(2), row.value);
        }
    }

    // Cap-only GC — deliberately no TTL. A time-based GC re-opens the
    // deletion-resurrection hole: a device offline past the TTL still holds
    // the pre-deletion value, and with the tombstone gone planFromDigest
    // treats the stale key as brand-new and pulls it back. Tombstone records
    // are ~150 bytes; the per-app cap is the memory bound, and eviction
    // beyond it (oldest first) is the documented residual window (see
    // arcade-sync-core.js).
    async function gcTombstones() {
        // Both record classes feed one per-app cap: the cap bounds tombstone
        // memory for the app, not per class. The class rides along in each
        // entry so eviction hits the right map/prefix.
        const entries = [];
        for (const [k, rec] of records) entries.push([k, rec, 'sync']);
        for (const [k, rec] of localRecords) {
            if (!records.has(k)) entries.push([k, rec, 'local']);
        }
        const plan = planTombstoneGc(entries, SYNC_TOMBSTONE_CAP_PER_APP);
        for (const [k, , cls] of plan.evict) {
            if (cls === 'sync') {
                records.delete(k);
                try { await idbDel(db, 'k|' + k); } catch (e) {}
            } else {
                localRecords.delete(k);
                try { await idbDel(db, 'j|' + k); } catch (e) {}
            }
        }
        // Persist the running-max eviction watermark per app. Only ever
        // ratchets forward — it must survive every future GC round, because
        // "base older than ANY evicted tombstone" is the delta-refusal rule.
        for (const [appId, wm] of plan.watermarks) {
            const prev = watermarks.get(appId);
            const merged = prev ? {
                t: Math.max(prev.t || 0, wm.t || 0),
                h: hlcCompare(prev.h || '', wm.h || '') >= 0 ? (prev.h || '') : wm.h
            } : wm;
            watermarks.set(appId, merged);
            try { await idbPut(db, 'w|' + appId, merged); } catch (e) {}
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
        if (parts > MAX_DIGEST_PARTS) {
            // The receiver would reject every part of an over-cap digest, so
            // sending it is a silent total sync failure. Refuse loudly
            // instead: this state has outgrown the digest protocol
            // (> ~MAX_DIGEST_PARTS × SYNC_MAX_ENTRIES synced keys) and needs
            // a bucketed/Merkle digest, not a bigger cap.
            if (!digestOverflowLogged.has(deviceId)) {
                digestOverflowLogged.add(deviceId);
                ArcadeDiag.log('sync', `digest too large for ${deviceId}: ${parts} parts > ${MAX_DIGEST_PARTS} cap (${entries.length} records) — sync exchange skipped`);
                try { console.warn(`[arcade-sync] synced state too large to exchange (${entries.length} records) — sync is inactive until the synced key count shrinks`); } catch (e) {}
            }
            return;
        }
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
            // Over-cap parts means the PEER's synced state has outgrown the
            // digest protocol — name that plainly (once per device) instead
            // of spamming an opaque "malformed" line per rejected part.
            if (Number.isInteger(parts) && parts > MAX_DIGEST_PARTS) {
                if (!digestOverflowLogged.has(fromDeviceId)) {
                    digestOverflowLogged.add(fromDeviceId);
                    ArcadeDiag.log('sync', `digest from ${fromDeviceId} exceeds the ${MAX_DIGEST_PARTS}-part cap (${parts} parts) — its synced state is too large; exchange rejected`);
                }
            } else {
                ArcadeDiag.log('sync', `rejected malformed digest part/parts from ${fromDeviceId}`);
            }
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

        const appId = appIdOfKey(key);
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
        const appId = appIdOfKey(listKey);
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

    // ---- tier-1 journal: non-synced bridged writes (durability design §3) ----
    // Every syncEligibleKey-passing write that is NOT `_sync`-opted-in gets a
    // `local`-class record, so bundles/deltas know what changed and when, and
    // deletions of non-synced keys leave tombstones a bundle can carry.
    // Cost discipline: noteLocalWrite only does a Map.set here; hashing and
    // the IDB put happen on a coalesced microtask flush — a game hammering
    // state.set in a loop journals the final value once per key per flush.
    const journalQueue = new Map();  // fullKey -> latest raw value | null (coalesced)
    let journalFlushPromise = null;

    function isNoExportListed(fullKey) {
        // A _noExport-listed key never enters a bundle, so its provenance
        // buys nothing — skip it entirely (list shape mirrors
        // arcade-save.js's collectArcadeKeys: full keys).
        let list;
        try { list = JSON.parse(localStorage.getItem(KEY_PREFIX + appIdOfKey(fullKey) + '._noExport') || 'null'); } catch (e) { list = null; }
        return Array.isArray(list) && list.indexOf(fullKey) !== -1;
    }

    function scheduleJournalFlush() {
        if (journalFlushPromise) return;
        journalFlushPromise = (async () => {
            try {
                await ensureLoaded();
                while (journalQueue.size) {
                    const batch = [...journalQueue.entries()];
                    journalQueue.clear();
                    const toSync = [];
                    const stamped = [];
                    for (const [key, value] of batch) {
                        // The syncable cache is authoritative now that
                        // ensureLoaded ran — a key adopted into a _sync list
                        // since enqueue routes to the sync tier instead.
                        if (isKeySynced(key)) { toSync.push([key, value]); continue; }
                        if (isNoExportListed(key)) continue;
                        const hash = (value === null) ? await tombstoneHash() : await sha256Hex(value);
                        const del = (value === null) ? 1 : 0;
                        const prev = localRecords.get(key);
                        if (prev && prev.x === hash && prev.del === del) continue; // same content — no re-stamp churn
                        const now = Date.now();
                        clock = hlcNext(clock, now, getMyDeviceId());
                        const rec = { h: clock, x: hash, del: del, t: now };
                        localRecords.set(key, rec);
                        stamped.push([key, rec]);
                    }
                    if (stamped.length) {
                        // Clock is persisted first (and once per batch, not
                        // per key): the persisted clock must stay >= every
                        // persisted record's stamp, or a crash could reload
                        // a regressed clock that re-issues stamps sorting
                        // before existing records.
                        try { await idbPut(db, 'clock', clock); } catch (e) {}
                        for (const [key, rec] of stamped) {
                            try { await idbPut(db, 'j|' + key, rec); } catch (e) {}
                        }
                    }
                    for (const [key, value] of toSync) await onSyncedLocalWrite(key, value);
                }
            } catch (e) {
                ArcadeDiag.log('sync', `journal flush failed: ${(e && e.message) || e}`);
            } finally {
                journalFlushPromise = null;
                if (journalQueue.size) scheduleJournalFlush(); // writes raced in during the last await
            }
        })();
    }

    // Called from the storage-bridge host hook for EVERY bridged write
    // (synced or not) — must stay cheap (no IDB, no full scan) for the
    // common non-synced case: a single localStorage.getItem for this key's
    // own app's _sync list plus a Map.set, nothing more.
    function noteLocalWrite(key, value) {
        if (typeof key !== 'string') return;
        if (SYNC_LIST_RE.test(key)) {
            onSyncListWrite(key).catch((e) => ArcadeDiag.log('sync', `sync-list refresh failed: ${(e && e.message) || e}`));
            return;
        }
        if (!syncEligibleKey(key)) return;
        let listRaw;
        try { listRaw = localStorage.getItem(KEY_PREFIX + appIdOfKey(key) + '._sync'); } catch (e) { listRaw = null; }
        let list = null;
        if (listRaw) { try { list = JSON.parse(listRaw); } catch (e) { list = null; } }
        if (!Array.isArray(list) || (list.indexOf('*') === -1 && list.indexOf(key) === -1)) {
            journalQueue.set(key, (value === undefined) ? null : value);
            scheduleJournalFlush();
            return;
        }
        onSyncedLocalWrite(key, value).catch((e) => ArcadeDiag.log('sync', `local-write stamp failed: ${(e && e.message) || e}`));
    }

    // T3 §5.2 — bundle tombstones are adopted at their ORIGINAL HLC, never
    // re-stamped: a re-stamped tombstone would beat edits made AFTER the
    // bundle was taken and delete live remote data; at original HLC it loses
    // to any newer write — plain LWW. This is what closes the fresh-device
    // resurrection hole: the restored device now KNOWS about pre-bundle
    // deletions and refuses to pull them back from (and propagates the
    // deletion to) a peer that held the key live.
    async function adoptImportTombstones(importedKeys, journalRecords) {
        const imported = new Set(importedKeys);
        for (const k of Object.keys(journalRecords)) {
            const rec = journalRecords[k];
            if (!rec || rec.del !== 1) continue;
            if (imported.has(k)) continue; // key present in data — its imported value is the newer truth
            if (!syncEligibleKey(k)) continue; // verified section guarantees this; defensive
            const existingSync = records.get(k);
            const existing = existingSync || localRecords.get(k);
            if (existing && hlcCompare(existing.h, rec.h) >= 0) continue; // local knowledge is newer — LWW
            let raw;
            try { raw = localStorage.getItem(k); } catch (e) { raw = null; }
            // A live local value with NO record predates the journal — LWW
            // cannot order it, and the import confirm promised "data not in
            // the file is kept as-is". Never delete what we cannot order.
            if (raw !== null && !existing) continue;
            const tomb = { h: rec.h, x: await tombstoneHash(), del: 1, t: (typeof rec.t === 'number' ? rec.t : Date.now()) };
            if (raw !== null) {
                // The tombstone beats a stamped live value — apply the
                // deletion the way a wire apply would.
                try { localStorage.removeItem(k); } catch (e) { continue; }
                postToIframe(appIdOfKey(k), { type: CHANGED, key: k, value: null });
            }
            const cls = existingSync ? 'sync'
                : localRecords.has(k) ? 'local'
                : (isKeySynced(k) ? 'sync' : 'local');
            if (cls === 'sync') {
                records.set(k, tomb);
                localRecords.delete(k);
                try { await idbPut(db, 'k|' + k, tomb); } catch (e) {}
                try { await idbDel(db, 'j|' + k); } catch (e) {}
            } else {
                localRecords.set(k, tomb);
                try { await idbPut(db, 'j|' + k, tomb); } catch (e) {}
            }
        }
    }

    // Called from arcade-save.js after a save-file import commits its
    // localStorage keys. An import is a deliberate "now" edit — imported
    // synced keys are unconditionally re-stamped (unlike the passive
    // "only if missing/changed" rule ensureLoaded uses for pre-existing
    // data), so the import wins over older remote edits on the next sync.
    // `journal` is the bundle's VERIFIED journal section ({clock, records})
    // or null; when present it adds the two T3 restore mechanics (§5):
    // clock seeding before the re-stamp, tombstone adoption after it.
    function noteImportCommitted(keys, journal) {
        if (!Array.isArray(keys)) keys = [];
        const j = (journal && typeof journal === 'object'
            && journal.records && typeof journal.records === 'object') ? journal : null;
        const relevantApps = new Set();
        for (const k of keys) {
            if (typeof k !== 'string') continue;
            const appId = appIdOfKey(k);
            if (relevantApps.has(appId)) continue;
            let listRaw;
            try { listRaw = localStorage.getItem(KEY_PREFIX + appId + '._sync'); } catch (e) { listRaw = null; }
            if (listRaw) relevantApps.add(appId);
        }
        if (!relevantApps.size && !j) return; // nothing synced, no journal — nothing to do
        (async () => {
            await ensureLoaded();
            // The import may have COMMITTED an app's _sync list itself (a
            // restore onto a fresh device). If the engine loaded before the
            // commit, its syncable cache predates the restored lists —
            // refresh every app this import touches so re-stamping and
            // tombstone class placement see the restored opt-ins.
            const apps = new Set();
            for (const k of keys) if (typeof k === 'string' && syncEligibleKey(k)) apps.add(appIdOfKey(k));
            if (j) for (const k of Object.keys(j.records)) if (syncEligibleKey(k)) apps.add(appIdOfKey(k));
            for (const appId of apps) refreshSyncableForApp(appId);
            // T3 §5.1 — clock seeding, BEFORE any re-stamp: a restored
            // device with a skewed-behind wall clock could otherwise mint
            // "fresh" stamps that lose LWW to edits the ORIGINAL device made
            // after the bundle was taken — silently violating restore-wins.
            if (j && typeof j.clock === 'string') {
                clock = hlcRecv(clock, j.clock, Date.now(), getMyDeviceId());
                try { await idbPut(db, 'clock', clock); } catch (e) {}
            }
            for (const k of keys) {
                if (typeof k !== 'string' || !isKeySynced(k)) continue;
                let raw;
                try { raw = localStorage.getItem(k); } catch (e) { raw = null; }
                if (raw === null) continue;
                await stampAndStore(k, await sha256Hex(raw), 0);
            }
            if (j) await adoptImportTombstones(keys, j.records);
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

    // Journal snapshot for bundle building (arcade-save.js via the
    // host.getJournalSnapshot hook): both record classes merged — class is a
    // device-local property, not a bundle property (durability design §4).
    // Sync-class wins on overlap (it is authoritative for synced keys). The
    // pending journal queue is drained first so a just-written key is
    // included in the export that prompted the snapshot.
    async function exportJournal() {
        if (journalFlushPromise) { try { await journalFlushPromise; } catch (e) {} }
        await ensureLoaded();
        const out = {};
        for (const [k, v] of localRecords) out[k] = { h: v.h, x: v.x, del: v.del, t: v.t };
        for (const [k, v] of records) out[k] = { h: v.h, x: v.x, del: v.del, t: v.t };
        return { clock: clock, records: out };
    }

    return {
        noteLocalWrite,
        noteImportCommitted,
        exportJournal,
        attachP2P,
        kick,
        onConflict,
        // Test hooks: RAM-mirror snapshots, per-pair cursor, per-app GC
        // watermark. Fine to expose read-only — acceptance suites poll these
        // to assert convergence.
        _records() {
            const out = {};
            for (const [k, v] of records) out[k] = { h: v.h, x: v.x, del: v.del, t: v.t };
            return out;
        },
        _localRecords() {
            const out = {};
            for (const [k, v] of localRecords) out[k] = { h: v.h, x: v.x, del: v.del, t: v.t };
            return out;
        },
        _watermark(appId) {
            const wm = watermarks.get(appId);
            return wm ? { t: wm.t, h: wm.h } : null;
        },
        _cursor(deviceId) {
            const c = cursors.get(deviceId);
            return c ? { hlc: c.hlc, at: c.at } : null;
        }
    };
}
