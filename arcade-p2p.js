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
 *     arcade.v1._meta.deviceId, .deviceName, .knownPeers
 */

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
    return 'idle';
}

const META_PREFIX = 'arcade.v1._meta.';
const DEVICE_ID_KEY = META_PREFIX + 'deviceId';
const DEVICE_NAME_KEY = META_PREFIX + 'deviceName';
const KNOWN_PEERS_KEY = META_PREFIX + 'knownPeers';
const DEFAULT_DEVICE_NAME = 'My device';

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

function readKnownPeers() {
    try {
        const raw = localStorage.getItem(KNOWN_PEERS_KEY);
        const obj = raw ? JSON.parse(raw) : null;
        return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
}

function writeKnownPeers(map) {
    try { localStorage.setItem(KNOWN_PEERS_KEY, JSON.stringify(map)); } catch (e) {}
}

const peerIdentityListeners = []; // fn({deviceId, name, remoteName, isNew})

function recordPeerIdentity(deviceId, remoteName) {
    if (typeof deviceId !== 'string' || !deviceId) return;
    const safeRemoteName = (typeof remoteName === 'string' && remoteName.trim())
        ? remoteName.trim().slice(0, 60) : 'Unnamed device';
    const known = readKnownPeers();
    const existing = known[deviceId];
    const now = new Date().toISOString();
    known[deviceId] = existing
        ? { ...existing, remoteName: safeRemoteName, lastConnectedAt: now, timesConnected: (existing.timesConnected || 0) + 1 }
        : { name: safeRemoteName, remoteName: safeRemoteName, firstConnectedAt: now, lastConnectedAt: now, timesConnected: 1 };
    writeKnownPeers(known);
    const detail = { deviceId, name: known[deviceId].name, remoteName: safeRemoteName, isNew: !existing };
    for (const fn of peerIdentityListeners) {
        try { fn(detail); } catch (err) {}
    }
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
            setStatus(aggregateStatus(mp));
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

        // 'data' fires with JSON already parsed when possible.
        mp.addEventListener('data', (e) => {
            const env = e.detail;
            if (!env || typeof env !== 'object' || env.arcade !== 1) return;
            if (env.kind === 'identity') {
                recordPeerIdentity(env.deviceId, env.name);
                return;
            }
            if (typeof env.gameId !== 'string') return;
            for (const fn of messageListeners) {
                try { fn(env.gameId, env.payload); } catch (err) {}
            }
        });

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

    /** Subscribe to inbound game messages: fn(gameId, payload). */
    onMessage(fn) {
        messageListeners.push(fn);
        return () => {
            const i = messageListeners.indexOf(fn);
            if (i >= 0) messageListeners.splice(i, 1);
        };
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

    /** Open the connection modal (Host / Join ceremony UI). */
    async openUI() {
        (await ensureAddon()).showUI();
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

    /** Test hook — the underlying P2PAddon (null until first use). */
    _addon() { return addon; }
};

export default ArcadeP2P;
