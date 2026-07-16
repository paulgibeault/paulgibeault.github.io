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
 *     fingerprint, fingerprintChangedAt?, autoReconnect?, paused?,
 *     syncEnabled?, backupTarget? }
 *
 * `paused` is a display/intent flag only — it says the user hung up and
 * doesn't want this link auto-healed. The actual teardown and the
 * rendezvous pause live in arcade-p2p.js's hangUpKnownPeer/callKnownPeer.
 */

export const KNOWN_PEERS_KEY = 'arcade.v1._meta.knownPeers';

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
        if (!map[id]) return null;
        map[id].name = trimmed;
        return map;
    });
}

/** Set the paused display flag for a known peer. */
export function setKnownPeerPaused(id, paused) {
    return mutateKnownPeers((map) => {
        if (!map[id]) return null;
        map[id].paused = !!paused;
        return map;
    });
}

/** Per-pair opt-in for Arcade.sync state replication. */
export function setKnownPeerSyncEnabled(id, on) {
    return mutateKnownPeers((map) => {
        if (!map[id]) return null;
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
        if (!map[id]) return null;
        map[id].backupTarget = !!on;
        return map;
    });
}

/** Forget a known peer entirely. */
export function deleteKnownPeer(id) {
    return mutateKnownPeers((map) => {
        if (!map[id]) return null;
        delete map[id];
        return map;
    });
}
