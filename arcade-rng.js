/* arcade-rng.js — deterministic helpers (companion to arcade-sdk.js)
 *
 * The importable form of Arcade.rng / Arcade.daily / Arcade.share. The SDK
 * carries the same implementations on `window.Arcade` for games that load it
 * as a classic script — but game LOGIC (board generation, shuffles, daily
 * derivation) also runs under `node --test`, where `window.Arcade` does not
 * exist. This file is why those suites can exercise the real algorithm: it is
 * a plain ES module with no dependency on `Arcade`, the DOM, or the launcher.
 *
 *   import { makeRng, hashU32, dailySeed, shareEncode, shareDecode }
 *     from './arcade-rng.js';
 *
 * IDENTICAL IN EVERY FLEET REPO. Games vendor a byte-identical copy next to
 * their modules (a relative specifier is the only one that resolves in both
 * the browser and node). Do not edit a vendored copy: change the canonical
 * file (launcher root /arcade-rng.js) and re-copy it. Parity with the SDK's
 * inline copy is pinned by tools/sdk-helpers-acceptance.mjs; each consuming
 * game pins the algorithm with known-answer tests, so an accidental local
 * edit fails fast instead of silently forking a game's seed streams.
 */

// FNV-1a → u32. Stable across devices — the seed derivation for anything
// string-shaped (share codes, room names, dates).
export function hashU32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

function coerceSeedU32(seed) {
    return (typeof seed === 'number' && isFinite(seed)) ? (seed >>> 0)
        : hashU32(String(seed == null ? '' : seed));
}

// makeRng(seed) — mulberry32 whose ENTIRE generator state is one u32, so
// getState()/setState() make mid-game persistence trivial (save the number
// with your game state, restore it, and the sequence continues exactly where
// it left off). Accepts a number or any string (hashed via FNV-1a).
export function makeRng(seed) {
    let a = coerceSeedU32(seed);
    const next = function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Integer in [min, max] inclusive.
    next.int = function (min, max) { return min + Math.floor(next() * (max - min + 1)); };
    next.pick = function (arr) { return arr[Math.floor(next() * arr.length)]; };
    next.shuffle = function (arr) {
        const a2 = arr.slice();
        for (let i = a2.length - 1; i > 0; i--) {
            const j = Math.floor(next() * (i + 1));
            const tmp = a2[i]; a2[i] = a2[j]; a2[j] = tmp;
        }
        return a2;
    };
    next.getState = function () { return a >>> 0; };
    next.setState = function (s) {
        if (typeof s !== 'number' || !isFinite(s)) return false;
        a = s >>> 0;
        return true;
    };
    return next;
}

// Device-LOCAL calendar date as YYYY-MM-DD (or of a given Date). The platform
// rule: dailies roll at the player's midnight (the Wordle convention). NEVER
// use toISOString for this — that's UTC, the exact divergence this helper
// exists to kill.
export function dailyDateStr(d) {
    d = d instanceof Date ? d : new Date();
    const p = (n) => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// Deterministic daily generator — distinct per game (seed with your gameId so
// two games never share a sequence) and per optional salt (multiple
// independent streams within one game). Same derivation as Arcade.daily.seed.
export function dailySeed(gameId, salt) {
    return makeRng(hashU32(
        String(gameId || '') + '|' + dailyDateStr() + '|' + String(salt == null ? '' : salt)));
}

// Versioned share codes (base64url over a {v, d} JSON envelope). encode never
// produces characters that need URL escaping; decode is VALIDATE-ONLY and
// returns null on any garbage (wrong type, oversize, bad charset, bad base64,
// bad JSON, bad envelope) — codes cross devices, so decode must never throw
// and never let a crafted code smuggle prototype-polluting keys into the
// parsed object.
export function shareEncode(obj, opts) {
    const v = (opts && typeof opts.v === 'number' && isFinite(opts.v)) ? (opts.v >>> 0) : 1;
    const json = JSON.stringify({ v: v, d: obj === undefined ? null : obj });
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function shareDecode(code) {
    if (typeof code !== 'string' || !code || code.length > 8192) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
    try {
        let b64 = code.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const env = JSON.parse(new TextDecoder().decode(bytes), function (k, v) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') return undefined;
            return v;
        });
        if (!env || typeof env !== 'object' || Array.isArray(env)
            || typeof env.v !== 'number' || !('d' in env)) return null;
        return { v: env.v >>> 0, data: env.d };
    } catch (e) { return null; }
}
