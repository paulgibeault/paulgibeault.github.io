/* arcade-known-peers.js — the single owner of arcade.v1._meta.knownPeers.
 *
 * Both writers import this module: the launcher's Multiplayer dialog
 * (rename / delete, loaded at startup — it's tiny) and the lazily-imported
 * P2P bridge (upsert on every identity handshake). One implementation of the
 * CRUD means one key, one shape, and every mutation is a fresh
 * read-modify-write — ending the duplicated-CRUD / last-write-wins drift the
 * old copies in index.html and arcade-p2p.js had.
 *
 * Entry shape (per deviceId):
 *   { name, remoteName, firstConnectedAt, lastConnectedAt, timesConnected,
 *     fingerprint, fingerprintChangedAt?, pinPendingFingerprint?,
 *     autoReconnect?, paused?, syncEnabled?, backupTarget?,
 *     userPub?, deviceCertIssuedAt?, revoked? }
 *
 * `paused` is a display/intent flag only — it says the user hung up and
 * doesn't want this link auto-healed. The actual teardown and the
 * rendezvous pause live in arcade-p2p.js's hangUpKnownPeer/callKnownPeer.
 *
 * `userPub`/`deviceCertIssuedAt`/`revoked` are the user-identity layer
 * (#32): userPub is the peer's user-level Ed25519 public key, pinned
 * TOFU-style on the first VERIFIED device cert (arcade-p2p.js owns the
 * verification; only it writes these two). `revoked` is a one-way latch —
 * {revokedAt, sig} — set when the peer's OWNER signed a revocation of that
 * device; there is no wire-level un-revoke, only the local clear below.
 */

export const KNOWN_PEERS_KEY = 'arcade.v1._meta.knownPeers';

// Every lookup below goes through an OWN-property check: a bare `map[id]`
// resolves through the prototype chain, so an id like '__proto__' or
// 'constructor' would read (and then write onto) Object.prototype. Wire
// boundaries already reject dunder device ids (DEVICE_ID_RE), but this
// module must not rely on its callers for that.
function ownEntry(map, id) {
    return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
}

export function readKnownPeers() {
    try {
        const raw = localStorage.getItem(KNOWN_PEERS_KEY);
        const obj = raw ? JSON.parse(raw) : null;
        return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
}

export function writeKnownPeers(map) {
    try { localStorage.setItem(KNOWN_PEERS_KEY, JSON.stringify(map)); } catch (e) {}
}

/**
 * Read-modify-write in one place: fn receives the freshly-read map and
 * returns the map to persist (usually the same object, mutated) — or a
 * falsy value to abort without writing. Returns whether a write happened.
 */
export function mutateKnownPeers(fn) {
    const map = readKnownPeers();
    let next;
    try { next = fn(map); } catch (e) { return false; }
    if (!next || typeof next !== 'object') return false;
    writeKnownPeers(next);
    return true;
}

/** Set the local, user-editable label for a known peer. */
export function renameKnownPeer(id, name) {
    const trimmed = String(name || '').trim().slice(0, 60);
    if (!trimmed) return false;
    return mutateKnownPeers((map) => {
        if (!ownEntry(map, id)) return null;
        map[id].name = trimmed;
        return map;
    });
}

/** Set the paused display flag for a known peer. */
export function setKnownPeerPaused(id, paused) {
    return mutateKnownPeers((map) => {
        if (!ownEntry(map, id)) return null;
        map[id].paused = !!paused;
        return map;
    });
}

/** Per-pair opt-in for Arcade.sync state replication. */
export function setKnownPeerSyncEnabled(id, on) {
    return mutateKnownPeers((map) => {
        if (!ownEntry(map, id)) return null;
        map[id].syncEnabled = !!on;
        return map;
    });
}

/**
 * Per-pair opt-in for backup-to-trusted-peer (#31). Symmetric: `true` means
 * this device both OFFERS its save bundle to the peer on connect and ACCEPTS
 * (stores) the peer's bundles. `false` records an explicit decline so an
 * inbound offer never re-prompts; absent means "never asked yet".
 */
export function setKnownPeerBackupTarget(id, on) {
    return mutateKnownPeers((map) => {
        if (!ownEntry(map, id)) return null;
        map[id].backupTarget = !!on;
        return map;
    });
}

/**
 * One-way revocation latch (#32): the peer's owner cryptographically
 * disowned this device. Never overwritten once set — a revocation is a
 * monotonic boolean, so there is no ordering/rollback surface at all
 * (simpler AND safer than merge-by-recency). entry = {revokedAt, sig};
 * the sig was already verified by the caller (arcade-p2p.js) against the
 * userPub on file for this deviceId.
 */
export function markKnownPeerRevoked(id, entry) {
    if (!entry || typeof entry.revokedAt !== 'number' || typeof entry.sig !== 'string') return false;
    return mutateKnownPeers((map) => {
        if (!ownEntry(map, id) || map[id].revoked) return null;
        map[id].revoked = { revokedAt: entry.revokedAt, sig: entry.sig };
        return map;
    });
}

/**
 * Local-only undo for the latch. Deliberately has NO wire form — an
 * un-revoke can never be gossiped or replayed, only decided by this
 * device's user at this device's UI.
 */
export function clearKnownPeerRevoked(id) {
    return mutateKnownPeers((map) => {
        if (!ownEntry(map, id) || !map[id].revoked) return null;
        delete map[id].revoked;
        return map;
    });
}

/** Forget a known peer entirely. */
export function deleteKnownPeer(id) {
    return mutateKnownPeers((map) => {
        if (!ownEntry(map, id)) return null;
        delete map[id];
        return map;
    });
}
