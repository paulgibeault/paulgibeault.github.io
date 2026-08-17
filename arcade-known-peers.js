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
 * `party` is NOT in that shape any more — see the migration note in
 * readKnownPeers.
 *
 * It also owns resumePlan() — the reconnect-on-launch policy. That is not
 * CRUD, but it is a pure function of this map (plus a timestamp the caller
 * passes in), and it has to be read identically by the boot gate in
 * index.html and by the bridge's resumeRendezvous(). Two copies of that rule
 * is precisely the drift this module exists to end.
 *
 * `userPub`/`deviceCertIssuedAt`/`revoked` are the user-identity layer
 * (#32): userPub is the peer's user-level Ed25519 public key, pinned
 * TOFU-style on the first VERIFIED device cert (arcade-p2p.js owns the
 * verification; only it writes these two). `revoked` is a one-way latch —
 * {revokedAt, sig} — set when the peer's OWNER signed a revocation of that
 * device; there is no wire-level un-revoke, only the local clear below.
 */

export const KNOWN_PEERS_KEY = 'arcade.v1._meta.knownPeers';

/**
 * How recent a live session must be for a launch to ACTIVELY resume its
 * pairs (rdv.resumeAll) instead of merely arming standby. Lives here so the
 * boot gate and the bridge cannot disagree about it — they used to hold two
 * copies of the number and, worse, two different rules around it.
 */
export const RESUME_WINDOW_MS = 6 * 3600 * 1000;

/**
 * The ONE resume-on-launch policy, shared by the two gates that decide it.
 *
 * They used to be separate predicates and quietly disagreed: index.html
 * booted the bridge on `recentLive || callable`, while resumeRendezvous()
 * only reached resumeAll() when `fresh` — so a launch with a callable peer
 * and a stale session logged "callable auto-reconnect peer: yes → booting
 * multiplayer bridge", which reads as a promise of a reconnect, and then
 * armed standby. On 2026-08-16 three phones did exactly that at once: every
 * device standby, every device silent, nobody reconnecting (see
 * plans/connection-model-2026-08.md). Standby initiates now — but the two
 * gates must still say the same thing, so both call this.
 *
 * The knownPeers read happens here (single-owner rule); `lastLiveAt` is the
 * caller's — it lives under a different key each caller already reads.
 *
 * @param {number} lastLiveAt - epoch ms of the last live session, 0/NaN if none
 * @param {number} [now]
 * @returns {{mode: 'resume'|'standby'|'cold', recentLive: boolean,
 *            callable: number, ageMs: number|null, why: string}}
 *          `mode` is the branch; `why` is the log-ready reason for it.
 */
export function resumePlan(lastLiveAt, now = Date.now()) {
    const ts = Number(lastLiveAt) || 0;
    const ageMs = ts ? now - ts : null;
    const recentLive = ageMs !== null && ageMs <= RESUME_WINDOW_MS;
    const callable = Object.values(readKnownPeers())
        .filter((p) => p && p.autoReconnect && !p.paused).length;
    const age = ageMs === null ? 'no live session on record'
        : `last live session ${Math.round(ageMs / 60000)}m ago`;
    const peers = `${callable} callable auto-reconnect peer(s)`;
    if (recentLive) {
        return { mode: 'resume', recentLive, callable, ageMs, why: `${age} (inside the ${RESUME_WINDOW_MS / 3600000}h active-resume window)` };
    }
    if (callable) {
        return { mode: 'standby', recentLive, callable, ageMs, why: `${age} (outside the ${RESUME_WINDOW_MS / 3600000}h active-resume window), ${peers}` };
    }
    return { mode: 'cold', recentLive, callable, ageMs, why: `${age}, ${peers}` };
}

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
        if (!obj || typeof obj !== 'object') return {};
        // Migration (2026-08): the v1.13 party model persisted `party:
        // {key, role}` per device so a restart could re-group re-adopted
        // links into their pre-restart party. Parties are gone
        // (plans/tables-2026-08.md) and the field has no successor — open-game
        // scopes are RAM-only and re-negotiated per session — so it is
        // stripped on READ rather than migrated in a one-shot rewrite: every
        // reader gets a clean record even on a device that never writes again,
        // and a downgrade to an older build simply finds it missing and
        // re-derives, which is the same thing that happens to a fresh install.
        // Nothing else in the record is touched: pairings, names, sync/backup
        // flags, revocations and user keys all survive untouched (D6).
        for (const id of Object.keys(obj)) {
            const rec = obj[id];
            if (rec && typeof rec === 'object' && 'party' in rec) delete rec.party;
        }
        return obj;
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
