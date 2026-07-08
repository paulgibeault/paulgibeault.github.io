/* arcade-p2p.js — launcher-side multiplayer bridge (ES module, lazy-loaded)
 *
 * Turns the vendored QRCodeP2P transport (p2p/) into the backbone behind
 * Arcade.peer.*. Games never see any of this: they talk to the SDK, the SDK
 * talks arcade:peer.* postMessages to the launcher, and the launcher calls
 * this bridge. One connection per device, owned by the launcher, shared by
 * every game.
 *
 * Loaded on demand via import() from index.html:
 *   - when the user opens the Multiplayer menu item, or
 *   - at startup when the URL carries a #p2p-offer= / #p2p-answer= fragment
 *     (an invite or reply link pointed at the launcher).
 *
 * Wire envelopes between launchers (invisible to games):
 *   { arcade: 1, gameId, payload }        — a game's message, routed by gameId
 *   { arcade: 1, kind: 'identity', deviceId, name } — this device announcing
 *     itself once its data channel opens (see "known peers" below)
 *
 * Status vocabulary mapping (transport → SDK), aggregated across ALL peer
 * links so one wobbling link never flaps the global status:
 *   any link connected           → 'connected'   (data channel OPEN — the
 *                                                 transport's v1.5.1 meaning)
 *   else any link interrupted    → 'interrupted' (v1.7: session alive, the
 *                                                 transport is repairing it —
 *                                                 sends still work, they queue
 *                                                 and replay on recovery)
 *   else any link pending        → 'connecting'
 *   none                         → 'idle'
 *
 * While 'connected' or 'interrupted' the bridge holds a screen Wake Lock —
 * screen dimming is the #1 cause of the long suspends that kill sessions.
 *
 * Known peers — naming/reconnect-recognition (no server, still one ceremony
 * per connection; WebRTC can't skip the offer/answer round trip):
 *   Each device has a persistent `deviceId` (random, generated once) and a
 *   user-editable `deviceName`. The moment ANY peer's data channel opens, we
 *   broadcast our identity; the receiving side upserts `knownPeers[deviceId]`
 *   — `name` is a local editable label (seeded from the peer's self-reported
 *   `remoteName` and offered as a suggestion index.html prompts the user to
 *   accept/edit on first contact — see its onPeerIdentity({isNew}) handler —
 *   then never auto-overwritten by later handshakes), `remoteName` is
 *   whatever the peer most recently reported about itself.
 *   Storage keys (see ARCADE_PLATFORM.md's storage convention):
 *     arcade.v1._meta.deviceId, .deviceName, .knownPeers, .lastLiveSession
 *
 * Auto-reconnect (rendezvous, PROTOCOL.md §7) — OPT-IN PER PEER:
 *   knownPeers[deviceId].autoReconnect gates everything. When both sides
 *   opted in, a pairing secret is (re)established over the live channel on
 *   every manual ceremony; if the connection later dies completely, the
 *   transport re-signals through a public dead-drop relay — everything
 *   published is end-to-end sealed; the relay can only delay or drop. While
 *   an episode runs, games see 'interrupted'. resumeRendezvous() at startup
 *   revives a recent session after a full browser restart.
 */

import { RendezvousManager } from './p2p/rendezvous.js';
import { MqttCarrier } from './p2p/rendezvous-carriers.js';
import { readKnownPeers, writeKnownPeers } from './arcade-known-peers.js';

// Free public MQTT-over-WSS broker used as the untrusted dead-drop. It sees
// only ciphertext on unlinkable rotating topics, and only during repair.
const RDV_BROKER_URL = 'wss://test.mosquitto.org:8081/mqtt';

let rdv = null;
let rdvReconnecting = false; // an episode is actively repairing a dead link

function rdvCarrierFactory() {
    // Test hook: acceptance injects a loopback/dead-drop carrier here.
    if (typeof window !== 'undefined' && window.__arcadeRdvCarrierFactory) {
        return window.__arcadeRdvCarrierFactory();
    }
    return new MqttCarrier({ url: RDV_BROKER_URL });
}

// Terminal link statuses have already been removed from the transport's peers
// map by the time their event fires, so aggregation only ever sees live links.
function aggregateStatus(mp) {
    let connected = false, interrupted = false, pending = false;
    mp.peerNode.peers.forEach((p) => {
        if (p.status === 'connected') connected = true;
        else if (p.status === 'interrupted') interrupted = true;
        else pending = true;
    });
    if (connected) return 'connected';
    if (interrupted) return 'interrupted';
    if (pending) return 'connecting';
    // A rendezvous episode means a session is being repaired even though its
    // dead link has left the peers map — games should keep waiting, not reset.
    if (rdvReconnecting) return 'interrupted';
    return 'idle';
}

// Terminal teardown and the rendezvous 'reconnecting' claim race on the same
// event: hold a would-be drop to 'idle' for a beat so games never glimpse a
// spurious 'idle' when an auto-reconnect is about to take over.
let idleHoldTimer = null;
function applyStatus(mp) {
    const next = aggregateStatus(mp);
    if (idleHoldTimer) { clearTimeout(idleHoldTimer); idleHoldTimer = null; }
    if (next === 'idle' && (sdkStatus === 'connected' || sdkStatus === 'interrupted')) {
        idleHoldTimer = setTimeout(() => {
            idleHoldTimer = null;
            setStatus(aggregateStatus(mp));
        }, 1500);
        return;
    }
    setStatus(next);
}

const META_PREFIX = 'arcade.v1._meta.';
const DEVICE_ID_KEY = META_PREFIX + 'deviceId';
const DEVICE_NAME_KEY = META_PREFIX + 'deviceName';
const LAST_LIVE_SESSION_KEY = META_PREFIX + 'lastLiveSession';
const DEFAULT_DEVICE_NAME = 'My device';
const RESUME_WINDOW_MS = 6 * 3600 * 1000; // resumeRendezvous freshness window

function randomDeviceId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
    }
    return 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getMyDeviceId() {
    try {
        let id = localStorage.getItem(DEVICE_ID_KEY);
        if (!id) {
            id = randomDeviceId();
            localStorage.setItem(DEVICE_ID_KEY, id);
        }
        return id;
    } catch (e) {
        return randomDeviceId(); // storage unavailable — ephemeral fallback
    }
}

function getMyDeviceName() {
    try { return localStorage.getItem(DEVICE_NAME_KEY) || DEFAULT_DEVICE_NAME; }
    catch (e) { return DEFAULT_DEVICE_NAME; }
}

const peerIdentityListeners = []; // fn({deviceId, name, remoteName, isNew, fingerprintChanged})
const pairRequestListeners = [];  // fn({deviceId, name}) — peer wants auto-reconnect, user undecided
const presenceListeners = [];     // fn({gameId, deviceId, name, kind}) — remote game mounted/listening
const identityLinks = new Map();  // deviceId → transport peerId of its DIRECT link

function deviceIdForPeerId(peerId) {
    for (const [devId, pid] of identityLinks) {
        if (pid === peerId) return devId;
    }
    return null;
}

// deviceIds whose direct-link fingerprint changed this session. A peer-chosen
// deviceId must never silently capture another device's auto-reconnect slot:
// while a deviceId is suspect, the pairing secret is NOT re-derived and
// stored-flag pair requests fall back to asking the user. Cleared only by an
// explicit user decision (enableAutoReconnect).
const fingerprintSuspects = new Set();

// deviceIds are machine-generated on the honest path: either a UUID
// (crypto.randomUUID) or the 'dev-' fallback. Anything else is a peer making
// ids up — reject before it can touch knownPeers or the reconnect machinery.
const DEVICE_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|dev-[a-z0-9]{6,50})$/i;

function stampLiveSession() {
    try { localStorage.setItem(LAST_LIVE_SESSION_KEY, String(Date.now())); } catch (e) {}
}

/**
 * Upserts a known peer. `fingerprint` is the DTLS fingerprint of the DIRECT
 * link the identity arrived on (null for relayed identities — those name a
 * device but must never bind an identity key). Pinning policy is trust-on-
 * first-use with change NOTICE, not hard-fail: every connection today is a
 * manual in-person ceremony (that exchange IS the authentication), and
 * browsers rotate certificates ~monthly, so a changed fingerprint means
 * "tell the user", never "silently trust" and never "silently block".
 */
function recordPeerIdentity(deviceId, remoteName, fingerprint) {
    if (typeof deviceId !== 'string' || deviceId.length > 64 || !DEVICE_ID_RE.test(deviceId)) return null;
    const safeRemoteName = (typeof remoteName === 'string' && remoteName.trim())
        ? remoteName.trim().slice(0, 60) : 'Unnamed device';
    const safeFp = (typeof fingerprint === 'string' && /^[0-9A-F]{2}(:[0-9A-F]{2}){19,63}$/.test(fingerprint)) ? fingerprint : null;
    const known = readKnownPeers();
    const existing = known[deviceId];
    const now = new Date().toISOString();
    const prevFp = existing ? existing.fingerprint : null;
    const fingerprintChanged = !!(prevFp && safeFp && prevFp !== safeFp);
    known[deviceId] = existing
        ? { ...existing, remoteName: safeRemoteName, lastConnectedAt: now, timesConnected: (existing.timesConnected || 0) + 1,
            fingerprint: safeFp || prevFp || null,
            ...(fingerprintChanged ? { fingerprintChangedAt: now } : {}) }
        : { name: safeRemoteName, remoteName: safeRemoteName, firstConnectedAt: now, lastConnectedAt: now, timesConnected: 1,
            fingerprint: safeFp };
    writeKnownPeers(known);
    const detail = { deviceId, name: known[deviceId].name, remoteName: safeRemoteName, isNew: !existing, fingerprintChanged };
    for (const fn of peerIdentityListeners) {
        try { fn(detail); } catch (err) {}
    }
    return detail;
}

function loadLocalScript(relPath, checkGlobal) {
    return new Promise((resolve, reject) => {
        if (window[checkGlobal]) return resolve();
        const s = document.createElement('script');
        s.src = new URL(relPath, import.meta.url).href;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`failed to load ${relPath}`));
        document.head.appendChild(s);
    });
}

let addon = null;
let addonPromise = null;
let sdkStatus = 'idle';

const statusListeners = [];
const messageListeners = []; // fn(gameId, payload)

function setStatus(next) {
    if (next === sdkStatus) return;
    sdkStatus = next;
    syncWakeLock();
    for (const fn of statusListeners) {
        try { fn(sdkStatus); } catch (e) {}
    }
}

// ---- screen wake lock -------------------------------------------------
// Held while a session is live ('connected' or 'interrupted'): a dimmed
// screen suspends the tab, and suspends are what break multiplayer. The
// browser auto-releases the lock when the tab hides; we re-request on
// return. Best-effort — denial (e.g. battery saver) is not an error.
let wakeLock = null;

async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
}

function syncWakeLock() {
    const want = sdkStatus === 'connected' || sdkStatus === 'interrupted';
    if (want && !wakeLock && document.visibilityState === 'visible') {
        requestWakeLock();
    } else if (!want && wakeLock) {
        try { wakeLock.release(); } catch (e) {}
        wakeLock = null;
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncWakeLock();
});

async function ensureAddon() {
    if (addon) return addon;
    if (addonPromise) return addonPromise;

    addonPromise = (async () => {
        // Load the vendored QR libs FIRST — P2PAddon.init() skips any global
        // that already exists, so it never reaches for its CDN URLs.
        await loadLocalScript('./p2p/vendor/qrcode.min.js', 'QRCode');
        await loadLocalScript('./p2p/vendor/html5-qrcode.min.js', 'Html5Qrcode');

        const { default: P2PAddon } = await import('./p2p/p2p-addon.js');
        const mp = new P2PAddon();
        await mp.init();

        // Tracks which transport peerIds we've already announced our identity
        // to, so a second peer joining an already-'connected' host (via
        // "Invite another player") still gets our broadcast, without
        // re-announcing on every redundant status event for a peer we've
        // already greeted.
        const announcedTo = new Set();
        mp.addEventListener('status', (e) => {
            const { peerId, status } = e.detail || {};
            applyStatus(mp);
            if (status === 'connected') {
                if (peerId && !announcedTo.has(peerId)) {
                    announcedTo.add(peerId);
                    try {
                        mp.send({ arcade: 1, kind: 'identity', deviceId: getMyDeviceId(), name: getMyDeviceName() });
                    } catch (err) {}
                }
            } else if (peerId && (status === 'disconnected' || status === 'failed' || status === 'closed')) {
                announcedTo.delete(peerId);
            }
        });

        // ALL arcade envelopes are handled at the TRANSPORT level, where the
        // sending link's peerId is available — identity frames need it for
        // the DTLS fingerprint, and game/presence frames need it to name the
        // sending device. Only a direct (non-relayed) identity may bind a
        // fingerprint; a relayed one still records the name.
        mp.peerNode.addEventListener('message', (e) => {
            const d = e.detail || {};
            if (!d.incoming) return;
            let env = null;
            try { env = JSON.parse(d.text); } catch (err) { return; }
            if (!env || env.arcade !== 1) return;
            if (env.kind === 'presence' || env.kind === 'presence-ack') {
                // The remote launcher says a game with this gameId is mounted
                // and listening over there.
                if (typeof env.gameId !== 'string') return;
                const presDeviceId = deviceIdForPeerId(d.peerId);
                const knownNow = readKnownPeers();
                const presName = (presDeviceId && knownNow[presDeviceId] && knownNow[presDeviceId].name)
                    || 'Unnamed device';
                for (const fn of presenceListeners) {
                    try { fn({ gameId: env.gameId, deviceId: presDeviceId, name: presName, kind: env.kind }); }
                    catch (err) {}
                }
                return;
            }
            if (env.kind !== 'identity') {
                // A game's message. Route by gameId, attributing the sending
                // device when its identity handshake has completed.
                if (typeof env.gameId !== 'string') return;
                const fromDeviceId = deviceIdForPeerId(d.peerId);
                for (const fn of messageListeners) {
                    try { fn(env.gameId, env.payload, fromDeviceId); } catch (err) {}
                }
                return;
            }
            const fp = d.relayed ? null : mp.peerNode.getPeerFingerprint(d.peerId);
            const detail = recordPeerIdentity(env.deviceId, env.name, fp);
            if (!detail) return; // malformed deviceId — bind nothing
            if (!d.relayed) {
                identityLinks.set(env.deviceId, d.peerId);
                if (detail.fingerprintChanged) fingerprintSuspects.add(env.deviceId);
                // A manual ceremony with an auto-reconnect peer is a fresh
                // trust event: re-establish the pairing secret every time —
                // UNLESS this link's fingerprint mismatches the pinned one.
                // A changed fingerprint on a known deviceId is exactly what a
                // peer claiming another device's id looks like, so the rebind
                // waits for an explicit user decision (the launcher confirms
                // via onPeerIdentity's fingerprintChanged flag).
                const known = readKnownPeers();
                if (known[env.deviceId] && known[env.deviceId].autoReconnect && rdv
                        && !fingerprintSuspects.has(env.deviceId)) {
                    rdv.enablePair(d.peerId, env.deviceId).catch(() => {});
                    stampLiveSession();
                }
            }
        });

        // Rendezvous (PROTOCOL.md §7): zero-touch reconnection for opted-in
        // pairs. The carrier moves only sealed blobs; episodes surface to
        // games as 'interrupted' so nobody resets a running game.
        rdv = new RendezvousManager(mp.peerNode, { carrierFactory: rdvCarrierFactory });
        rdv.addEventListener('reconnecting', () => {
            rdvReconnecting = true;
            applyStatus(mp);
        });
        for (const done of ['reconnected', 'recovered-inband', 'gave-up']) {
            rdv.addEventListener(done, () => {
                rdvReconnecting = false;
                applyStatus(mp);
                if (done !== 'gave-up') stampLiveSession();
            });
        }
        rdv.addEventListener('pair-established', () => stampLiveSession());
        rdv.addEventListener('pair-request', (e) => {
            // The other device opted in; ours decides based on the stored
            // flag, or asks the user via the launcher's onPairRequest hook.
            const { peerId } = e.detail || {};
            const deviceId = [...identityLinks.entries()].find(([, pid]) => pid === peerId)?.[0];
            if (!deviceId) return;
            const known = readKnownPeers();
            const flag = known[deviceId] && known[deviceId].autoReconnect;
            if (flag === true && !fingerprintSuspects.has(deviceId)) {
                rdv.enablePair(peerId, deviceId).catch(() => {});
            } else if (flag === undefined || (flag === true && fingerprintSuspects.has(deviceId))) {
                // Undecided — or decided, but this link's fingerprint changed
                // since the flag was stored. Either way the user re-confirms.
                for (const fn of pairRequestListeners) {
                    try { fn({ deviceId, name: (known[deviceId] && known[deviceId].name) || 'Unnamed device' }); } catch (err) {}
                }
            } // flag === false → user declined; stay silent
        });

        // Game messages are routed on the transport 'message' listener above
        // (the addon's parsed 'data' event has no peerId, so it can't
        // attribute a sender).

        addon = mp;
        return mp;
    })();

    try {
        return await addonPromise;
    } catch (e) {
        addonPromise = null; // allow retry on transient load failures
        throw e;
    }
}

export const ArcadeP2P = {
    /** Current SDK-vocabulary status: 'idle' | 'connecting' | 'connected' | 'interrupted'. */
    status() { return sdkStatus; },

    /** Subscribe to status changes (SDK vocabulary). Returns unsubscribe. */
    onStatus(fn) {
        statusListeners.push(fn);
        return () => {
            const i = statusListeners.indexOf(fn);
            if (i >= 0) statusListeners.splice(i, 1);
        };
    },

    /**
     * Subscribe to inbound game messages: fn(gameId, payload, fromDeviceId).
     * fromDeviceId is the sending device's stable id (null until its identity
     * handshake completes — a beat after 'connected').
     */
    onMessage(fn) {
        messageListeners.push(fn);
        return () => {
            const i = messageListeners.indexOf(fn);
            if (i >= 0) messageListeners.splice(i, 1);
        };
    },

    /**
     * Presence: fires when the remote launcher announces that a game with a
     * given gameId is mounted and listening — fn({gameId, deviceId, name,
     * kind}). kind 'presence' expects an ack (announceGame(gameId, true))
     * when we have the same game mounted; 'presence-ack' is the echo.
     */
    onPresence(fn) {
        presenceListeners.push(fn);
        return () => {
            const i = presenceListeners.indexOf(fn);
            if (i >= 0) presenceListeners.splice(i, 1);
        };
    },

    /**
     * Tell the remote launcher a game with this gameId is mounted and
     * listening here. isAck answers a received 'presence' (no further reply,
     * so the two-frame exchange terminates).
     */
    announceGame(gameId, isAck) {
        if (!addon || (sdkStatus !== 'connected' && sdkStatus !== 'interrupted')) return false;
        if (typeof gameId !== 'string' || !gameId) return false;
        addon.send({ arcade: 1, kind: isAck ? 'presence-ack' : 'presence', gameId });
        return true;
    },

    /**
     * Live remote devices whose identity handshake completed:
     * [{deviceId, name}]. Used to seed a freshly-mounted game's roster.
     */
    connectedPeers() {
        if (!addon) return [];
        const known = readKnownPeers();
        const out = [];
        for (const [deviceId, peerId] of identityLinks) {
            const p = addon.peerNode.peers.get(peerId);
            if (p && (p.status === 'connected' || p.status === 'interrupted')) {
                out.push({ deviceId, name: (known[deviceId] && known[deviceId].name) || 'Unnamed device' });
            }
        }
        return out;
    },

    /**
     * Replay-queue visibility: { depth, limit, overflowed }. depth is the
     * deepest per-link outbox (live links and rendezvous-stashed sessions);
     * overflowed means the transport already dropped the oldest unacked
     * messages and games should resync state after recovery.
     */
    queueSnapshot() {
        if (!addon) return { depth: 0, limit: 0, overflowed: false };
        let depth = 0, overflowed = false;
        addon.peerNode.peers.forEach((p) => {
            depth = Math.max(depth, (p.outbox || []).length);
            if (p.outboxOverflowed) overflowed = true;
        });
        if (addon.peerNode.sessionStash) {
            addon.peerNode.sessionStash.forEach((s) => {
                depth = Math.max(depth, (s.outbox || []).length);
                if (s.outboxOverflowed) overflowed = true;
            });
        }
        return { depth, limit: (addon.peerNode.options && addon.peerNode.options.outboxLimit) || 1000, overflowed };
    },

    /**
     * Subscribe to peer identity handshakes — fires once per newly-connected
     * transport peer once its self-reported identity arrives (a beat after
     * its status goes 'connected'): fn({deviceId, name, remoteName, isNew}).
     * `name` is the locally-stored label (see index.html's Known Peers menu
     * panel for rename/delete); `isNew` marks a device seen for the first time.
     */
    onPeerIdentity(fn) {
        peerIdentityListeners.push(fn);
        return () => {
            const i = peerIdentityListeners.indexOf(fn);
            if (i >= 0) peerIdentityListeners.splice(i, 1);
        };
    },

    /**
     * Open the connection modal. Default: the Host / Join choice screen.
     * {mode:'host'} skips straight to a FRESH invite code — the one-tap
     * "Reconnect" entry for known peers (signaling is one-time-use by design,
     * so reconnecting means a fresh code with zero navigation to reach it).
     */
    async openUI(options) {
        (await ensureAddon()).showUI(options);
    },

    /**
     * Send a game's payload to the remote peer, wrapped in the launcher
     * envelope. Returns false when there is no live session. During an
     * 'interrupted' session the transport queues the message and replays it
     * on recovery (exactly-once), so games can keep sending through a blip.
     */
    send(gameId, payload) {
        if (!addon || (sdkStatus !== 'connected' && sdkStatus !== 'interrupted')) return false;
        addon.send({ arcade: 1, gameId, payload });
        return true;
    },

    /**
     * Call at startup: if the URL fragment carries an offer/answer (invite or
     * reply link aimed at the launcher), boot the transport now so its
     * fragment ingestion + relay/ack logic runs. No-op otherwise.
     */
    async ingestFragmentIfPresent() {
        if (!/[#&]p2p-(offer|answer)=/.test(window.location.hash)) return false;
        await ensureAddon(); // P2PUIManager ingests the fragment on construction
        return true;
    },

    /**
     * Turns auto-reconnect ON for a known peer and, if its direct link is
     * live, (re)establishes the pairing secret right now. Requires the other
     * device to opt in too — pairing completes when both randoms cross.
     */
    async enableAutoReconnect(deviceId) {
        const known = readKnownPeers();
        if (!known[deviceId]) return false;
        known[deviceId].autoReconnect = true;
        writeKnownPeers(known);
        // Explicit user decision — re-trust this device even if its
        // fingerprint changed this session.
        fingerprintSuspects.delete(deviceId);
        const peerId = identityLinks.get(deviceId);
        if (rdv && peerId) {
            await rdv.enablePair(peerId, deviceId).catch(() => {});
            stampLiveSession();
        }
        return true;
    },

    /** Turns auto-reconnect OFF and deletes the pairing secret. */
    async disableAutoReconnect(deviceId) {
        const known = readKnownPeers();
        if (known[deviceId]) {
            known[deviceId].autoReconnect = false;
            writeKnownPeers(known);
        }
        if (rdv) await rdv.disablePair(deviceId).catch(() => {});
    },

    /** true | false | undefined (never asked). */
    autoReconnectState(deviceId) {
        const rec = readKnownPeers()[deviceId];
        return rec ? rec.autoReconnect : undefined;
    },

    /**
     * Fires when a peer requests auto-reconnect pairing and this device has
     * no stored decision: fn({deviceId, name}). Answer by calling
     * enableAutoReconnect / disableAutoReconnect.
     */
    onPairRequest(fn) {
        pairRequestListeners.push(fn);
        return () => {
            const i = pairRequestListeners.indexOf(fn);
            if (i >= 0) pairRequestListeners.splice(i, 1);
        };
    },

    /**
     * Call at launcher startup: if a paired session was live recently, boot
     * the transport and let the rendezvous layer reconnect it — this is what
     * resumes a game after the browser was killed on both ends.
     */
    async resumeRendezvous() {
        let ts = 0;
        try { ts = parseInt(localStorage.getItem(LAST_LIVE_SESSION_KEY) || '0', 10); } catch (e) {}
        if (!ts || Date.now() - ts > RESUME_WINDOW_MS) return false;
        await ensureAddon();
        await rdv.resumeAll();
        return true;
    },

    /** Test hook — the underlying P2PAddon (null until first use). */
    _addon() { return addon; },

    /** Test hook — the RendezvousManager (null until first use). */
    _rdv() { return rdv; },

    /** Test hook — identity/pinning policy, exercised directly by acceptance. */
    _recordPeerIdentity: recordPeerIdentity
};

export default ArcadeP2P;
