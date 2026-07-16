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
 *   - arcade-ui-bridge.js — arcade:ui.op normalization (validateUiOp)
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

/**
 * Normalizes a game's arcade:ui.op request (launcher postMessage router →
 * arcade-ui-bridge.js). Two families:
 *   RPC ops (need a reply, so `id` is required): confirm, prompt, openFile,
 *     share — the bridge answers with arcade:bridge.result {id, ok, value}.
 *   Fire-and-forget ops (no id): setTitle, quitHook.
 * Every free-text field is length-capped by TRUNCATION, not rejection — a
 * game that overflows a label still gets its dialog, just clipped. The one
 * hard security rule lives at the CALLER's shape: there is no inputType
 * field at all, so a game can never request the password-masked input the
 * launcher's own passphrase prompts use (dialog spoofing, see #29/#35).
 * @returns {{op:string, id?:string, ...} | null} null = drop the message.
 */
const UI_RPC_OPS = { confirm: 1, prompt: 1, openFile: 1, share: 1 };
const UI_FF_OPS = { setTitle: 1, quitHook: 1 };
const clip = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
export function validateUiOp(data) {
    if (!isPlainObject(data) || typeof data.op !== 'string') return null;
    const op = data.op;
    if (UI_RPC_OPS[op]) {
        // ids are SDK-minted ('r' + seq); cap defensively, never trust length.
        if (typeof data.id !== 'string' || !data.id || data.id.length > 64) return null;
    } else if (!UI_FF_OPS[op]) {
        return null;
    }
    switch (op) {
        case 'confirm': {
            const message = clip(data.message, 500);
            if (!message) return null;
            return {
                op, id: data.id, message,
                okLabel: clip(data.okLabel, 24) || 'OK',
                cancelLabel: clip(data.cancelLabel, 24) || 'Cancel'
            };
        }
        case 'prompt': {
            const message = clip(data.message, 500);
            if (!message) return null;
            return { op, id: data.id, message, value: clip(data.value, 500) || '' };
        }
        case 'openFile':
            // accept mirrors <input accept>: extensions and MIME patterns.
            // Anything outside that alphabet is dropped (not clipped) — it
            // lands in a DOM attribute.
            return {
                op, id: data.id,
                accept: (typeof data.accept === 'string' && data.accept.length <= 200
                    && /^[a-z0-9./*+,\- ]+$/i.test(data.accept)) ? data.accept : ''
            };
        case 'share': {
            const text = clip(data.text, 2000) || '';
            const title = clip(data.title, 120) || '';
            let url = '';
            if (typeof data.url === 'string' && data.url.length <= 500) {
                try {
                    const u = new URL(data.url);
                    if (u.protocol === 'http:' || u.protocol === 'https:') url = u.href;
                } catch (e) { /* not a URL — drop the field, keep the share */ }
            }
            if (!text && !title && !url) return null;
            return { op, id: data.id, title, text, url };
        }
        case 'setTitle':
            // Empty/absent title is a valid op: "reset to catalog name".
            return { op, title: clip(data.title, 80) || '' };
        case 'quitHook':
            return { op, enabled: data.enabled === true };
    }
    return null;
}
