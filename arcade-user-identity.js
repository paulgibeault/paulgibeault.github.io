/* arcade-user-identity.js — the single owner of the USER-level signing
 * identity (#32): one Ed25519 keypair per user, above the per-device
 * deviceId/DTLS-fingerprint layer.
 *
 * What it buys (see ARCADE_PLATFORM.md "Cross-device user identity"):
 *   - each device signs a small cert over {deviceId, fingerprint, issuedAt};
 *     peers who have pinned the same userPub can then accept a legitimate
 *     ~monthly certificate rotation silently instead of raising the
 *     "device identity changed" alarm (arcade-p2p.js consumes this),
 *   - the key exports as a human-transcribable RECOVERY CODE (Crockford
 *     base32 of the 32-byte seed + checksum), so device loss no longer means
 *     identity loss, and
 *   - revocations of a lost device are signed with the same key, so peers
 *     can verify "the owner really said this" (kind:'revoke' envelopes).
 *
 * Storage:
 *   - the CryptoKey pair lives in the SAME IndexedDB the P2P layer keeps the
 *     RTC certificate in (db 'qrp2p-identity', store 'identity', key
 *     'userSigningKey'). That db name deliberately never matches the save
 *     export's arcade.v1.* enumeration (arcade-storage-core.js), so the
 *     private key is structurally excluded from bundles — the same guarantee
 *     the RTC cert and rendezvous secrets already rely on. The tiny IDB CRUD
 *     is duplicated here rather than imported: p2p/ imports nothing from
 *     outside itself, and we return the courtesy (same-db access is safe —
 *     both sides open version 1 and create the same object store).
 *   - the NON-secret half lives in localStorage arcade.v1._meta.userIdentity
 *     = {userPub, createdAt} so synchronous UI (the Multiplayer dialog's
 *     per-row "is this my own device?" check) needs no async IDB read. It
 *     rides save exports like knownPeers does, and like knownPeers it is
 *     import-PROTECTED (arcade-storage-core.js IMPORT_PROTECTED_KEYS):
 *     visible in a bundle, never overwritten by one.
 *
 * DELIBERATE deviation from the house "always non-extractable" key rule
 * (p2p/rendezvous-crypto.js): this keypair is minted extractable, because
 * exporting the recovery code IS the feature. It never leaves the launcher
 * boundary — games are sandboxed without allow-same-origin (#43) and can
 * reach neither this module's IDB nor localStorage.
 *
 * No top-level side effects, no window/localStorage access at import time —
 * the pure helpers (encode/decode, sign/verify bytes) import cleanly in Node
 * for unit tests (tools/user-identity-unit.mjs, Node 20+ crypto.subtle).
 */

export const USER_IDENTITY_KEY = 'arcade.v1._meta.userIdentity';

const IDENTITY_DB = 'qrp2p-identity';       // shared with p2p/p2p-core.js
const IDENTITY_STORE = 'identity';
const USER_KEY_RECORD = 'userSigningKey';

// Domain separators: no bytes signed for one purpose may verify for another
// (the qrp2p/rdv/v1 info-string convention, rendezvous-crypto.js).
const CERT_CONTEXT = 'arcade/uid/v1/devicecert';
const REVOKE_CONTEXT = 'arcade/uid/v1/revoke';

// RFC 8410 fixed DER header for a bare 32-byte Ed25519 seed (no attributes,
// no embedded public key). WebCrypto cannot import a private JWK without its
// public half, and cannot derive a public key from a raw seed — but a
// PKCS8 import of (this prefix || seed) yields the full private key, whose
// JWK export then carries the derived public `x`. This is what lets the
// recovery code be exactly the 32-byte seed. The unit test asserts these
// bytes against a live exportKey('pkcs8') as a canary: if an engine ever
// changes its bare-key encoding, recovery codes must fail loudly, not mint
// unrestorable ones.
export const ED25519_PKCS8_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20
]);

// ---- small local codecs (house style: base64url on the wire; the few
// lines are duplicated rather than imported for the same reason
// arcade-save.js carries its own — no cross-boundary crypto-module dep) ----

export function bytesToB64url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
    try {
        const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch (e) { return null; }
}

// A userPub on the wire is exactly 32 raw Ed25519 bytes, base64url — 43
// chars, no padding. Anything else is a peer making keys up.
export function isUserPub(v) {
    if (typeof v !== 'string' || v.length !== 43) return false;
    const bytes = b64urlToBytes(v);
    return !!bytes && bytes.length === 32;
}

// Ed25519 signatures are exactly 64 bytes — 86 base64url chars.
export function isSigString(v) {
    if (typeof v !== 'string' || v.length !== 86) return false;
    const bytes = b64urlToBytes(v);
    return !!bytes && bytes.length === 64;
}

// ---- recovery code: Crockford base32 of seed(32) || checksum(2) ----------
// Crockford's alphabet drops I, L, O, U so transcription can't confuse
// 1/l/I or 0/O; decode maps those back anyway. 34 bytes → 55 chars,
// displayed in 11 groups of 5. The 2-byte checksum (truncated SHA-256 of
// the seed) rejects typos at decode time, before any key material is
// touched — same fail-closed-before-parse discipline as the AEAD paths.

const B32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function encodeRecoveryBody(bytes) {
    let bits = 0, acc = 0, out = '';
    for (const b of bytes) {
        acc = (acc << 8) | b;
        bits += 8;
        while (bits >= 5) {
            out += B32_ALPHABET[(acc >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32_ALPHABET[(acc << (5 - bits)) & 31];
    return out;
}

export function decodeRecoveryBody(str, byteLen) {
    let bits = 0, acc = 0;
    const out = [];
    for (const ch of str) {
        const v = B32_ALPHABET.indexOf(ch);
        if (v < 0) return null;
        acc = (acc << 5) | v;
        bits += 5;
        if (bits >= 8) {
            out.push((acc >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    if (out.length !== byteLen) return null;
    return new Uint8Array(out);
}

async function seedChecksum(seed) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', seed));
    return digest.slice(0, 2);
}

/** 32-byte seed → the display form: 11 dash-joined groups of 5. */
export async function encodeRecoveryCode(seed) {
    const body = new Uint8Array(34);
    body.set(seed, 0);
    body.set(await seedChecksum(seed), 32);
    const raw = encodeRecoveryBody(body);
    return raw.match(/.{1,5}/g).join('-');
}

/**
 * Display form → 32-byte seed, or null on ANY defect (bad chars, wrong
 * length, checksum mismatch). Forgiving about what humans mangle: case,
 * whitespace, dash placement, and Crockford's o→0 / i,l→1 confusables.
 */
export async function decodeRecoveryCode(code) {
    if (typeof code !== 'string') return null;
    const cleaned = code.toUpperCase().replace(/[\s-]/g, '')
        .replace(/O/g, '0').replace(/[IL]/g, '1');
    if (cleaned.length !== 55) return null;
    const body = decodeRecoveryBody(cleaned, 34);
    if (!body) return null;
    const seed = body.slice(0, 32);
    const expect = await seedChecksum(seed);
    if (body[32] !== expect[0] || body[33] !== expect[1]) return null;
    return seed;
}

// ---- seed ⇄ CryptoKey ----------------------------------------------------

/** Private CryptoKey → the 32-byte seed (via JWK `d`). */
export async function exportSeed(privateKey) {
    const jwk = await crypto.subtle.exportKey('jwk', privateKey);
    return b64urlToBytes(jwk.d);
}

/**
 * 32-byte seed → {privateKey, publicKey, userPub}. The private key is
 * imported extractable (this device must be able to re-show the recovery
 * code); the public key comes back out of the private JWK's derived `x`.
 */
export async function keyPairFromSeed(seed) {
    const pkcs8 = new Uint8Array(48);
    pkcs8.set(ED25519_PKCS8_PREFIX, 0);
    pkcs8.set(seed, 16);
    const privateKey = await crypto.subtle.importKey(
        'pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', privateKey);
    const pubBytes = b64urlToBytes(jwk.x);
    const publicKey = await crypto.subtle.importKey(
        'raw', pubBytes, { name: 'Ed25519' }, true, ['verify']);
    return { privateKey, publicKey, userPub: bytesToB64url(pubBytes) };
}

// ---- canonical signing bytes (fixed layout, not JSON — nothing to
// canonicalize, nothing for a clever serializer to disagree about) --------

const utf8 = (s) => new TextEncoder().encode(s);

export function deviceCertBytes(deviceId, fingerprint, issuedAt) {
    return utf8(CERT_CONTEXT + '\n' + deviceId + '\n' + fingerprint + '\n' + issuedAt);
}

export function revocationBytes(deviceId, revokedAt) {
    return utf8(REVOKE_CONTEXT + '\n' + deviceId + '\n' + revokedAt);
}

// ---- pure sign/verify (unit-testable; no storage) ------------------------

export async function signDeviceCertWith(privateKey, deviceId, fingerprint, issuedAt) {
    const sig = await crypto.subtle.sign('Ed25519', privateKey,
        deviceCertBytes(deviceId, fingerprint, issuedAt));
    return { deviceId, fingerprint, issuedAt, sig: bytesToB64url(new Uint8Array(sig)) };
}

/**
 * Shape + signature check in one gate; false on ANY defect, never throws.
 * Callers must separately compare cert.fingerprint against the LIVE
 * connection's fingerprint — a cert is a claim about a binding, and only
 * the transport knows which binding this session actually negotiated.
 */
export async function verifyDeviceCert(userPubB64, cert) {
    try {
        if (!isUserPub(userPubB64)) return false;
        if (!cert || typeof cert !== 'object') return false;
        if (typeof cert.deviceId !== 'string' || cert.deviceId.length > 64) return false;
        if (typeof cert.fingerprint !== 'string' || cert.fingerprint.length > 256) return false;
        if (typeof cert.issuedAt !== 'number' || !isFinite(cert.issuedAt) || cert.issuedAt <= 0) return false;
        if (!isSigString(cert.sig)) return false;
        const pub = await crypto.subtle.importKey(
            'raw', b64urlToBytes(userPubB64), { name: 'Ed25519' }, false, ['verify']);
        return await crypto.subtle.verify('Ed25519', pub, b64urlToBytes(cert.sig),
            deviceCertBytes(cert.deviceId, cert.fingerprint, cert.issuedAt));
    } catch (e) { return false; }
}

export async function signRevocationWith(privateKey, deviceId, revokedAt) {
    const sig = await crypto.subtle.sign('Ed25519', privateKey,
        revocationBytes(deviceId, revokedAt));
    return { deviceId, revokedAt, sig: bytesToB64url(new Uint8Array(sig)) };
}

/** Same contract as verifyDeviceCert: shape + signature, false on any defect. */
export async function verifyRevocation(userPubB64, entry) {
    try {
        if (!isUserPub(userPubB64)) return false;
        if (!entry || typeof entry !== 'object') return false;
        if (typeof entry.deviceId !== 'string' || entry.deviceId.length > 64) return false;
        if (typeof entry.revokedAt !== 'number' || !isFinite(entry.revokedAt) || entry.revokedAt <= 0) return false;
        if (!isSigString(entry.sig)) return false;
        const pub = await crypto.subtle.importKey(
            'raw', b64urlToBytes(userPubB64), { name: 'Ed25519' }, false, ['verify']);
        return await crypto.subtle.verify('Ed25519', pub, b64urlToBytes(entry.sig),
            revocationBytes(entry.deviceId, entry.revokedAt));
    } catch (e) { return false; }
}

// ---- browser-side persistence (IDB keypair + localStorage meta) ----------
// Everything below touches window/localStorage/indexedDB and is not
// exercised by the Node unit test — keep logic here thin, calling the pure
// helpers above.

function identityDbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDENTITY_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDENTITY_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function identityDbGet(key) {
    const db = await identityDbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const req = db.transaction(IDENTITY_STORE, 'readonly').objectStore(IDENTITY_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } finally { db.close(); }
}

async function identityDbPut(key, value) {
    const db = await identityDbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDENTITY_STORE, 'readwrite');
            tx.objectStore(IDENTITY_STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally { db.close(); }
}

/**
 * Ed25519 in crypto.subtle is newer than the rest of this stack's WebCrypto
 * (Safari 17+/Firefox 2024/Chrome 2025). No support ⇒ the Identity panel is
 * unavailable and NOTHING else changes — the same graceful degradation the
 * persistent RTC certificate applies when IDB is unavailable.
 */
let ed25519Support = null;
export async function userIdentitySupported() {
    if (ed25519Support !== null) return ed25519Support;
    try {
        await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
        ed25519Support = true;
    } catch (e) { ed25519Support = false; }
    return ed25519Support;
}

/** Sync read of the non-secret half: {userPub, createdAt} or null. */
export function readUserIdentityMeta() {
    try {
        const raw = localStorage.getItem(USER_IDENTITY_KEY);
        const obj = raw ? JSON.parse(raw) : null;
        return (obj && typeof obj === 'object' && isUserPub(obj.userPub)) ? obj : null;
    } catch (e) { return null; }
}

function writeUserIdentityMeta(meta) {
    try { localStorage.setItem(USER_IDENTITY_KEY, JSON.stringify(meta)); } catch (e) {}
}

// One in-flight/settled record per page: the keypair is immutable between
// explicit user actions (create / restore), both of which reset this cache.
let recordCache = null;

async function loadRecord() {
    if (recordCache) return recordCache;
    try {
        const rec = await identityDbGet(USER_KEY_RECORD);
        if (rec && rec.privateKey && rec.publicKey && isUserPub(rec.userPub)) {
            recordCache = rec;
            // Heal the localStorage half if it was cleared independently of
            // IDB (per-store clears happen — the pub half is derivable).
            const meta = readUserIdentityMeta();
            if (!meta || meta.userPub !== rec.userPub) {
                writeUserIdentityMeta({ userPub: rec.userPub, createdAt: rec.createdAt });
            }
            return rec;
        }
    } catch (e) {}
    return null;
}

/** The stored identity, or null — never mints. {privateKey, publicKey, userPub}. */
export async function getUserIdentity() {
    return loadRecord();
}

/**
 * Load-or-mint. Returns {userPub, created} or null when the platform lacks
 * Ed25519 / IDB persistence — a persisted identity is the point; an
 * ephemeral one would sign certs that outlive the key that must re-sign
 * them, which is worse than none.
 */
export async function ensureUserIdentity() {
    const existing = await loadRecord();
    if (existing) return { userPub: existing.userPub, created: false };
    if (!(await userIdentitySupported())) return null;
    try {
        const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
        const pubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
        const rec = {
            privateKey: pair.privateKey,
            publicKey: pair.publicKey,
            userPub: bytesToB64url(pubBytes),
            createdAt: new Date().toISOString()
        };
        await identityDbPut(USER_KEY_RECORD, rec);
        recordCache = rec;
        writeUserIdentityMeta({ userPub: rec.userPub, createdAt: rec.createdAt });
        return { userPub: rec.userPub, created: true };
    } catch (e) { return null; }
}

/** The stored seed as a display recovery code, or null when no identity. */
export async function exportRecoveryCode() {
    const rec = await loadRecord();
    if (!rec) return null;
    try {
        const seed = await exportSeed(rec.privateKey);
        if (!seed || seed.length !== 32) return null;
        return await encodeRecoveryCode(seed);
    } catch (e) { return null; }
}

/**
 * Restore an identity from a recovery code, REPLACING any local one (the
 * caller confirms with the user first — this is the explicit recovery
 * action). knownPeers records are untouched: deviceId doesn't change, only
 * whose user key this device speaks for. {ok:true, userPub} or
 * {ok:false, reason:'unsupported'|'bad-code'|'storage'}.
 */
export async function importRecoveryCode(code) {
    if (!(await userIdentitySupported())) return { ok: false, reason: 'unsupported' };
    const seed = await decodeRecoveryCode(code);
    if (!seed) return { ok: false, reason: 'bad-code' };
    try {
        const pair = await keyPairFromSeed(seed);
        const rec = {
            privateKey: pair.privateKey,
            publicKey: pair.publicKey,
            userPub: pair.userPub,
            createdAt: new Date().toISOString()
        };
        await identityDbPut(USER_KEY_RECORD, rec);
        recordCache = rec;
        writeUserIdentityMeta({ userPub: rec.userPub, createdAt: rec.createdAt });
        return { ok: true, userPub: rec.userPub };
    } catch (e) { return { ok: false, reason: 'storage' }; }
}

/** Sign a cert binding one of this user's devices to its current fingerprint. */
export async function signDeviceCert(deviceId, fingerprint) {
    const rec = await loadRecord();
    if (!rec) return null;
    try {
        return await signDeviceCertWith(rec.privateKey, deviceId, fingerprint, Date.now());
    } catch (e) { return null; }
}

/** Sign a revocation of one of this user's devices. */
export async function signRevocation(deviceId) {
    const rec = await loadRecord();
    if (!rec) return null;
    try {
        return await signRevocationWith(rec.privateKey, deviceId, Date.now());
    } catch (e) { return null; }
}
