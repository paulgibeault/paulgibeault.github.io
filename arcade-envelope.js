/* arcade-envelope.js — the ONE place wire-envelope shape rules live (#59).
 *
 * Every surface that accepts a frame from another device or another frame
 * validates its shape here instead of hand-rolling checks that drift apart
 * (the same consolidation arcade-storage-core.js did for storage allowlists):
 *   - arcade-p2p.js       — transport envelope classifier (validatePeerEnvelope)
 *                           + deviceId shape (isDeviceId) for identity binding
 *   - arcade-sync.js      — deviceId shape for the persisted device id
 *   - arcade-sync-core.js — HLC_RE composes DEVICE_ID_PATTERN; the sync
 *                           envelope BODY validator (validateSyncEnvelope)
 *                           stays there because it depends on storage-core's
 *                           syncEligibleKey — this module stays zero-dep
 *   - index.html          — arcade:ui.toast normalization (validateToast)
 *
 * NOT consumers, by design:
 *   - arcade-sdk.js is a classic script served standalone to game iframes; it
 *     cannot import ESM and carries a synced copy of DEVICE_ID_RE — grep for
 *     it there when changing the pattern.
 *   - p2p/p2p-core.js keeps its signaling-payload checks (peerId/sessionDesc)
 *     in-tree: the p2p/ directory imports nothing from outside itself, and
 *     those checks share no primitives with this module. They are unit-tested
 *     alongside this module in tools/envelope-unit.mjs.
 *
 * Validators return { ok, ... } and never throw (the validateSyncEnvelope
 * house style). No top-level side effects: imports cleanly in Node for
 * unit-testing (tools/envelope-unit.mjs).
 */

// deviceIds are machine-generated on the honest path: either a UUID
// (crypto.randomUUID) or the 'dev-' fallback both minting sites produce
// (arcade-p2p.js randomDeviceId, arcade-sync.js randomDeviceId). Anything
// else is a peer making ids up. PATTERN is the raw (unanchored) source so
// composers embed it without regex surgery (arcade-sync-core.js HLC_RE);
// RE is the anchored, case-insensitive test form.
export const DEVICE_ID_PATTERN =
    '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|dev-[a-z0-9]{6,50})';
export const DEVICE_ID_RE = new RegExp('^' + DEVICE_ID_PATTERN + '$', 'i');

export function isDeviceId(v) {
    return typeof v === 'string' && v.length <= 64 && DEVICE_ID_RE.test(v);
}

// Prototype-pollution guard for any key a remote party chooses. Storage key
// PATHS have their own segment-level guard (arcade-storage-core.js
// DUNDER_SEGMENTS) — this is the single-key form.
export function isDunderKey(k) {
    return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

export function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isCappedString(v, max) {
    return typeof v === 'string' && v.length <= max;
}

/**
 * Structural classifier for the transport-level arcade envelope — the frames
 * launchers exchange over P2P data channels (see the wire-envelope table in
 * arcade-p2p.js's header). Shape only: routing decisions (relayed gates,
 * `to` targeting, `fromDevice` attribution) stay in the router, and the
 * 'sync' BODY is owned by validateSyncEnvelope (arcade-sync-core.js).
 *
 * Mirrors the router's historical accepts exactly, including the deliberate
 * fall-through: any kind other than presence/presence-ack/sync/backup/
 * identity is a game frame and needs a string gameId.
 *
 * @returns {{ok:true, kind:'presence'|'sync'|'backup'|'identity'|'game'} |
 *           {ok:false, reason:'not-arcade'|'bad-gameId'|'bad-deviceId'}}
 */
export function validatePeerEnvelope(env) {
    if (!isPlainObject(env) || env.arcade !== 1) return { ok: false, reason: 'not-arcade' };
    if (env.kind === 'presence' || env.kind === 'presence-ack') {
        if (typeof env.gameId !== 'string') return { ok: false, reason: 'bad-gameId' };
        return { ok: true, kind: 'presence' };
    }
    if (env.kind === 'sync') return { ok: true, kind: 'sync' };
    if (env.kind === 'backup') return { ok: true, kind: 'backup' }; // body owned by validateBackupEnvelope
    if (env.kind === 'identity') {
        if (!isDeviceId(env.deviceId)) return { ok: false, reason: 'bad-deviceId' };
        return { ok: true, kind: 'identity' };
    }
    if (typeof env.gameId !== 'string') return { ok: false, reason: 'bad-gameId' };
    return { ok: true, kind: 'game' };
}

/**
 * Normalizes a game's arcade:ui.toast request (launcher postMessage router).
 * @returns {{message:string, kind:'info'|'success'|'warning'|'error',
 *            duration:number} | null} null = don't show anything.
 */
const TOAST_KINDS = { info: 1, success: 1, warning: 1, error: 1 };
export function validateToast(data) {
    if (!isPlainObject(data) || typeof data.message !== 'string' || !data.message) return null;
    const kind = TOAST_KINDS[data.kind] ? data.kind : 'info';
    const duration = (typeof data.duration === 'number' && data.duration > 0)
        ? data.duration : 2500;
    return { message: data.message, kind, duration };
}
