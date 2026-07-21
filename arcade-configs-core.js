/* arcade-configs-core.js — pure, DOM-free validators for the game-config
 * exchange (Arcade.configs / #config-exchange): decode a share code, validate a
 * config payload's TRANSPORT shape, and parse the extended #app deep-link
 * fragment. The launcher never interprets a config's `d` (data) beyond a size
 * cap — semantics are the game's job, and inbound data is HOSTILE.
 *
 * decodeShareCode is a launcher-side mirror of the SDK's shareApi.decode: the
 * SDK is a classic `window.Arcade` script the launcher's ES modules can't
 * import, so the codec is duplicated (same precedent as KEY_PREFIX in
 * arcade-records-core.js) and byte-parity is pinned in tools/configs-unit.mjs.
 */

export const CFG_CODE_MAX = 4096;         // max share-code length (fits shareApi.decode's 8192 with headroom)
export const CFG_DATA_MAX = 8 * 1024;     // max serialized bytes of a config's data
const CONFIG_TYPE_RE = /^[a-z0-9_-]{1,32}$/;
// Anchored, charset-gated: id-only game selection preserved; an optional cfg
// share code may ride. #p2p-offer/#p2p-answer can't match this shape (and are
// handled first at boot), so their precedence is untouched.
const APP_FRAGMENT_RE = /^#app=([A-Za-z0-9_-]+)(?:&cfg=([A-Za-z0-9_-]{1,4096}))?$/;

function isPlainObject(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }

// Parse a launcher deep-link fragment → { app, cfg } or null. cfg is null when
// the fragment is a plain #app=<id>.
export function parseAppFragment(hash) {
    if (typeof hash !== 'string') return null;
    const m = APP_FRAGMENT_RE.exec(hash);
    if (!m) return null;
    let app;
    try { app = decodeURIComponent(m[1]); } catch (e) { return null; }
    return { app, cfg: m[2] || null };
}

// Launcher-side mirror of shareApi.decode. Returns { v, data } or null; never
// throws. Drops __proto__/constructor/prototype keys (prototype-pollution guard).
export function decodeShareCode(code) {
    if (typeof code !== 'string' || !code || code.length > 8192) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
    try {
        let b64 = code.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const env = JSON.parse(new TextDecoder().decode(bytes), (k, v) => {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') return undefined;
            return v;
        });
        if (!isPlainObject(env) || typeof env.v !== 'number' || !('d' in env)) return null;
        return { v: env.v >>> 0, data: env.d };
    } catch (e) { return null; }
}

function inCatalog(id, catalogIds) {
    if (!catalogIds) return false;
    if (typeof catalogIds.has === 'function') return catalogIds.has(id);
    if (Array.isArray(catalogIds)) return catalogIds.indexOf(id) !== -1;
    return false;
}

// Validate a config payload's transport shape. `payload` is { g, t, d } (from a
// decoded code's .data, or a peer envelope's top-level fields); `v` is the
// envelope version. catalogIds is a Set/array of known game ids. Returns a
// normalized { g, t, v, d } or null. Does NOT interpret d beyond a size cap.
export function validateConfigPayload(payload, v, catalogIds) {
    if (!isPlainObject(payload)) return null;
    if (typeof payload.g !== 'string' || !inCatalog(payload.g, catalogIds)) return null;
    if (typeof payload.t !== 'string' || !CONFIG_TYPE_RE.test(payload.t)) return null;
    if (!('d' in payload)) return null;
    let size;
    try { size = JSON.stringify(payload.d).length; } catch (e) { return null; }
    if (size > CFG_DATA_MAX) return null;
    return { g: payload.g, t: payload.t, v: (typeof v === 'number' && isFinite(v)) ? (v >>> 0) : 1, d: payload.d };
}

// Validate a direct kind:'config' peer envelope (C2). The envelope carries g/t/d
// at the top level and NO top-level gameId (legacy launchers drop it). Returns
// the normalized payload or null. Overall envelope must serialize ≤ 16 KB.
export function validateConfigEnvelope(env, catalogIds) {
    if (!isPlainObject(env)) return null;
    let size;
    try { size = JSON.stringify(env).length; } catch (e) { return null; }
    if (size > 16 * 1024) return null;
    return validateConfigPayload({ g: env.g, t: env.t, d: env.d }, env.v, catalogIds);
}
