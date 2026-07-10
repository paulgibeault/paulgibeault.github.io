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
 *   revives a recent session after a full browser restart — see also the
 *   pageshow{persisted:true} listener in index.html, which redoes that same
 *   check for a page the browser restored from bfcache instead of reloading
 *   (a back-button return from navigating away doesn't always re-run this
 *   module's startup code). The 🔁/🚫 toggle (enableAutoReconnect/
 *   disableAutoReconnect) PAUSES rather than forgets an existing secret —
 *   same primitive as hangUpKnownPeer/callKnownPeer below — so flipping it
 *   off then back on needs no new ceremony to work again; only a device that
 *   has NEVER paired needs a live link to mint one.
 *
 * Call / Hang up / Start over — the launcher's Multiplayer dialog, framed
 * like a phone: a saved connection is either live (Hang Up ends it, keeping
 * the secret for later) or not (Call rings it through the dead-drop):
 *   hangUpKnownPeer() says goodbye over the live channel (the other side
 *   drops to quiet standby instead of burning a repair episode), drops the
 *   link, and tells our rendezvous to stop healing it — secret kept.
 *   callKnownPeer() clears that and rings: it reaches the peer whenever
 *   their arcade is merely OPEN with the pair enabled (active repair,
 *   quiet standby after a timeout, or standby-at-boot — see
 *   resumeRendezvous). startOverKnownPeer() is the harder reset: drops the
 *   link, forgets the stashed session AND the pairing secret, so the next
 *   connection is a fully fresh ceremony — the saved name stays, only
 *   deleteKnownPeer() forgets the device outright.
 */

import { RendezvousManager, RDV_BUILD } from './p2p/rendezvous.js';
import { MqttCarrier, MultiCarrier } from './p2p/rendezvous-carriers.js';
import { readKnownPeers, writeKnownPeers, setKnownPeerPaused } from './arcade-known-peers.js';
import { ArcadeDiag } from './arcade-diag.js';

// Free public MQTT-over-WSS brokers used as the untrusted dead-drop. They
// see only ciphertext on unlinkable rotating topics, and only during repair.
// ALL of them are used at once (publish to every live one, subscribe on
// all): the rendezvous works while ANY single broker is reachable from both
// devices. One broker was the whole story until test.mosquitto.org went
// down for an evening and stranded two perfectly-paired devices
// (2026-07-09 field logs).
const RDV_BROKER_URLS = [
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
];

let rdv = null;
let rdvReconnecting = false; // an episode is actively repairing a dead link

function rdvCarrierFactory() {
    // Test hook: acceptance injects a loopback/dead-drop carrier here.
    if (typeof window !== 'undefined' && window.__arcadeRdvCarrierFactory) {
        return window.__arcadeRdvCarrierFactory();
    }
    return new MultiCarrier(RDV_BROKER_URLS.map((url) => {
        const label = new URL(url).hostname.split('.').slice(-2)[0]; // mosquitto / emqx / hivemq
        return new MqttCarrier({ url, onLog: (msg) => ArcadeDiag.log('mqtt', `[${label}] ${msg}`) });
    }));
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
const remoteByeListeners = [];    // fn({deviceId, name}) — peer hung up on purpose
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

// A deviceId is suspect if its fingerprint changed this session (RAM flag) OR a
// prior change left a still-unconfirmed pending pin on the stored record. The
// stored `pinPendingFingerprint` survives a reload — the RAM set does not — so
// an imposter can't wait out a page refresh to have its declined fingerprint
// silently become the trusted pin.
function isFingerprintSuspect(deviceId, known) {
    if (fingerprintSuspects.has(deviceId)) return true;
    const rec = (known || readKnownPeers())[deviceId];
    return !!(rec && rec.pinPendingFingerprint);
}

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
            // On a fingerprint change, KEEP the trusted pin and stash the new
            // fingerprint as pending until the user explicitly re-trusts
            // (enableAutoReconnect). Persisting it here — not only in the RAM
            // fingerprintSuspects set — is what stops a reload from laundering an
            // imposter's declined fingerprint into the pin.
            fingerprint: fingerprintChanged ? prevFp : (safeFp || prevFp || null),
            ...(fingerprintChanged ? { fingerprintChangedAt: now, pinPendingFingerprint: safeFp } : {}) }
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
    ArcadeDiag.log('bridge', `status ${sdkStatus} → ${next}`);
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
    if (document.visibilityState === 'visible') {
        syncWakeLock();
        if (rdv && rdv.episodes.size) {
            ArcadeDiag.log('bridge', 'page visible again — nudging rendezvous');
            rdv.nudgeAll('foreground');
        }
    } else if (rdv && rdv.episodes.size) {
        // Evidence line: a wake lock only stops dimming while VISIBLE. Once
        // hidden, the browser may freeze this page's event loop outright —
        // the log must show where such a gap could have started.
        ArcadeDiag.log('bridge', 'page hidden — the browser may suspend timers and sockets until it returns');
    }
});
window.addEventListener('online', () => {
    if (rdv && rdv.episodes.size) {
        ArcadeDiag.log('bridge', 'network back online — nudging rendezvous');
        rdv.nudgeAll('online');
    }
});
window.addEventListener('pageshow', (e) => {
    if (e.persisted && rdv && rdv.episodes.size) {
        ArcadeDiag.log('bridge', 'page restored from bfcache — nudging rendezvous');
        rdv.nudgeAll('bfcache');
    }
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
        ArcadeDiag.log('bridge', 'transport booted');
        // Transport-level diagnostics (interruptions, in-band repair, ICE)
        // feed the same connection log the Multiplayer dialog shows.
        mp.peerNode.addEventListener('diagnostic', (e) => {
            const d = e.detail || {};
            ArcadeDiag.log('p2p', (d.type && d.type !== 'info' ? d.type.toUpperCase() + ': ' : '') + d.msg);
        });

        // Tracks which transport peerIds we've already announced our identity
        // to, so a second peer joining an already-'connected' host (via
        // "Invite another player") still gets our broadcast, without
        // re-announcing on every redundant status event for a peer we've
        // already greeted.
        const announcedTo = new Set();
        // peerIds whose identity envelope already triggered a pairing mint.
        // Identity frames ride the replayable app-message path (outbox +
        // replay on reconnect), so the SAME announcement can be delivered
        // twice — and a second enablePair() mints a second random, which is
        // how a pair used to end up committed to two different keys on the
        // two devices (permanently deaf rendezvous). One mint per link.
        const autoPairMintedFor = new Set();
        mp.addEventListener('status', (e) => {
            const { peerId, status } = e.detail || {};
            applyStatus(mp);
            if (status === 'connected') {
                // A link coming up (fresh or rendezvous-resumed) means it's
                // no longer paused from the user's point of view, regardless
                // of how it got here.
                const devId = deviceIdForPeerId(peerId);
                if (devId) setKnownPeerPaused(devId, false);
                if (peerId && !announcedTo.has(peerId)) {
                    announcedTo.add(peerId);
                    try {
                        mp.send({ arcade: 1, kind: 'identity', deviceId: getMyDeviceId(), name: getMyDeviceName() });
                    } catch (err) {}
                }
            } else if (peerId && (status === 'disconnected' || status === 'failed' || status === 'closed')) {
                announcedTo.delete(peerId);
                autoPairMintedFor.delete(peerId);
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
                // A completed handshake means this connection is live on
                // purpose — clear any leftover hang-up flag. (The status
                // handler's clear above misses FRESH ceremonies, because at
                // 'connected' time this identityLinks binding didn't exist.)
                setKnownPeerPaused(env.deviceId, false);
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
                        && !isFingerprintSuspect(env.deviceId, known)
                        && !autoPairMintedFor.has(d.peerId)) {
                    autoPairMintedFor.add(d.peerId);
                    rdv.enablePair(d.peerId, env.deviceId).catch(() => {});
                    stampLiveSession();
                }
            }
        });

        // Rendezvous (PROTOCOL.md §7): zero-touch reconnection for opted-in
        // pairs. The carrier moves only sealed blobs; episodes surface to
        // games as 'interrupted' so nobody resets a running game. 'gave-up'
        // (v1.10) means the episode went QUIET — games release the session,
        // but the pair stays subscribed and reachable, so a much later
        // 'reconnected' with no fresh 'reconnecting' in between is normal.
        rdv = new RendezvousManager(mp.peerNode, { carrierFactory: rdvCarrierFactory });
        // Which build produced this log? Answer it up front: stale-cache
        // sessions are indistinguishable from real bugs without this line.
        ArcadeDiag.log('rdv', `build ${RDV_BUILD}`);
        rdv.addEventListener('diagnostic', (e) => {
            const d = e.detail || {};
            ArcadeDiag.log('rdv', (d.type && d.type !== 'info' ? d.type.toUpperCase() + ': ' : '') + d.msg);
        });
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
        rdv.addEventListener('remote-bye', (e) => {
            // The peer hung up on purpose. Drop the link NOW instead of
            // letting it linger 'interrupted' through the repair grace
            // period — games should see the session end promptly. The
            // rendezvous layer already recorded the bye, so the teardown
            // below starts a quiet standby (callable), not a repair episode.
            const { peerId } = e.detail || {};
            if (peerId && mp.peerNode.peers.has(peerId)) {
                mp.peerNode.disconnectPeer(peerId);
            }
            const devId = peerId ? deviceIdForPeerId(peerId) : null;
            if (devId) {
                const known = readKnownPeers();
                for (const fn of remoteByeListeners) {
                    try { fn({ deviceId: devId, name: (known[devId] && known[devId].name) || 'Unnamed device' }); }
                    catch (err) {}
                }
            }
        });
        rdv.addEventListener('pair-request', (e) => {
            // The other device opted in; ours decides based on the stored
            // flag, or asks the user via the launcher's onPairRequest hook.
            const { peerId } = e.detail || {};
            const deviceId = [...identityLinks.entries()].find(([, pid]) => pid === peerId)?.[0];
            if (!deviceId) return;
            const known = readKnownPeers();
            const flag = known[deviceId] && known[deviceId].autoReconnect;
            if (flag === true && !isFingerprintSuspect(deviceId, known)) {
                rdv.enablePair(peerId, deviceId).catch(() => {});
            } else if (flag === undefined || (flag === true && isFingerprintSuspect(deviceId, known))) {
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

        // Suspend detector. Browsers freeze a page's event loop entirely
        // (iOS Safari within seconds of backgrounding or the screen locking;
        // wake locks only prevent dimming while visible), and a frozen page
        // neither publishes to nor hears the dead-drop — field logs showed a
        // Call arming its offer and then 90+ silent seconds. The heartbeat
        // makes any freeze VISIBLE in the connection log (with its measured
        // length, so "did the phone sleep?" is answerable from a bug report)
        // and kicks the rendezvous the moment the page thaws —
        // visibilitychange alone is not delivered on every iOS resume path.
        let lastBeat = Date.now();
        setInterval(() => {
            const gap = Date.now() - lastBeat - 5000;
            lastBeat = Date.now();
            if (gap > 4000) {
                ArcadeDiag.log('bridge', `suspend detected: event loop was paused ~${Math.round(gap / 1000)}s — nudging rendezvous`);
                if (rdv) rdv.nudgeAll('suspend-recovery');
            }
        }, 5000);

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
     * Per-connection status for one known peer — distinct from status()
     * above, which aggregates every live link into one SDK-facing value.
     * Returns 'connected' | 'interrupted' | 'connecting' | 'paused' | 'idle'.
     * 'paused' means the user hung up on purpose (hangUpKnownPeer) and it
     * hasn't come back up since; 'idle' covers everything else not
     * currently live (never connected this session, or dropped on its own).
     */
    connectionState(deviceId) {
        const peerId = identityLinks.get(deviceId);
        if (addon && peerId) {
            const p = addon.peerNode.peers.get(peerId);
            if (p) {
                if (p.status === 'connected') return 'connected';
                if (p.status === 'interrupted') return 'interrupted';
                return 'connecting';
            }
        }
        const known = readKnownPeers()[deviceId];
        return (known && known.paused) ? 'paused' : 'idle';
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
     * Turns auto-reconnect ON for a known peer. If a pairing secret already
     * exists (this peer was paired before and later toggled off), re-arms it
     * in place via resumePair() — no live channel needed, since nothing was
     * forgotten. Only when NO secret exists yet does this fall back to
     * minting a fresh one over the direct link, which requires that link to
     * be live right now; the other device must opt in too (pairing
     * completes when both randoms cross). With neither an existing secret
     * nor a live link, the flag is simply set for next time you connect —
     * returns false in that case so callers don't claim a reconnect attempt
     * that never actually happened.
     */
    async enableAutoReconnect(deviceId) {
        ArcadeDiag.log('bridge', `user action: enable auto-reconnect for ${deviceId}`);
        const known = readKnownPeers();
        if (!known[deviceId]) return false;
        known[deviceId].autoReconnect = true;
        // Explicit user decision — re-trust this device even if its fingerprint
        // changed. Promote any pending fingerprint to the trusted pin so future
        // sessions accept it without re-prompting.
        if (known[deviceId].pinPendingFingerprint) {
            known[deviceId].fingerprint = known[deviceId].pinPendingFingerprint;
            delete known[deviceId].pinPendingFingerprint;
            delete known[deviceId].fingerprintChangedAt;
        }
        writeKnownPeers(known);
        fingerprintSuspects.delete(deviceId);
        await ensureAddon(); // rdv is only populated once the addon has loaded
        const peerId = identityLinks.get(deviceId);
        const livePeer = peerId ? addon.peerNode.peers.get(peerId) : null;
        if (livePeer && livePeer.status === 'connected') {
            // The link is live: enabling here is a fresh trust event, so mint
            // (or refresh) the pairing secret over the channel — this also
            // consumes a pending pair-request random from the other side.
            // Resuming the OLD secret instead (the previous behavior) left
            // that random dangling and re-armed a stale-key episode against
            // a connected peer (seen in field logs).
            await rdv.enablePair(peerId, deviceId).catch(() => {});
            // Re-enable a paused stored record too; with the live link bound
            // it sees 'already connected' and rings nothing.
            await rdv.resumePair(deviceId).catch(() => false);
            stampLiveSession();
            return true;
        }
        if (await rdv.resumePair(deviceId).catch(() => false)) {
            stampLiveSession();
            return true;
        }
        if (peerId && addon.peerNode.peers.has(peerId)) {
            // Link exists but isn't fully up (mid-ceremony/interrupted) — a
            // best-effort mint; completion needs the channel to open.
            await rdv.enablePair(peerId, deviceId).catch(() => {});
            stampLiveSession();
            return true;
        }
        return false;
    },

    /**
     * Turns auto-reconnect OFF. Unlike startOverKnownPeer(), this SUSPENDS
     * the pairing (rdv.pausePair — same primitive hangUpKnownPeer uses)
     * rather than forgetting the secret: it's a lightweight preference
     * toggle, so re-enabling later needs no new ceremony to work again.
     */
    async disableAutoReconnect(deviceId) {
        ArcadeDiag.log('bridge', `user action: disable auto-reconnect for ${deviceId}`);
        const known = readKnownPeers();
        if (known[deviceId]) {
            known[deviceId].autoReconnect = false;
            writeKnownPeers(known);
        }
        await ensureAddon(); // rdv is only populated once the addon has loaded
        await rdv.pausePair(deviceId).catch(() => {});
    },

    /** true | false | undefined (never asked). */
    autoReconnectState(deviceId) {
        const rec = readKnownPeers()[deviceId];
        return rec ? rec.autoReconnect : undefined;
    },

    /**
     * Hangs up on this peer: says goodbye over the live channel (so the
     * other side doesn't burn a repair episode on a link we closed on
     * purpose — it drops to quiet standby instead, still callable), then
     * drops the link and tells our rendezvous layer to stop healing it.
     * Unlike disableAutoReconnect(), the pairing secret is kept, so
     * callKnownPeer() needs no new ceremony to bring it back.
     */
    async hangUpKnownPeer(deviceId) {
        ArcadeDiag.log('bridge', `user action: Hang Up ${deviceId}`);
        setKnownPeerPaused(deviceId, true);
        await ensureAddon(); // rdv/addon are only populated once the addon has loaded
        // Pause OUR side before the bye goes out: the peer reacts to a bye by
        // dropping the link immediately, and if our pair were still enabled
        // when that close lands, our own rendezvous would fire a repair
        // episode for the very link we're hanging up (and litter the
        // dead-drop with an offer nobody should answer).
        await rdv.pausePair(deviceId).catch(() => {});
        const peerId = identityLinks.get(deviceId);
        if (peerId && addon.peerNode.peers.has(peerId)) {
            const byeSent = rdv.sendBye(peerId);
            if (!byeSent) {
                // The channel wasn't open (link interrupted/mid-repair): the
                // peer will see a plain link death, burn a repair episode,
                // and keep ringing a paused pair. Not fatal, but the log
                // must say so — "they hung up but I kept calling" reports
                // start exactly here.
                ArcadeDiag.log('bridge', `Hang Up ${deviceId}: bye could NOT be sent (channel not open) — the peer will treat this as a connection failure`);
            }
            // Give the bye frame a beat to flush before the pc closes under it.
            await new Promise((r) => setTimeout(r, 250));
        }
        if (peerId && addon.peerNode.peers.has(peerId)) {
            addon.peerNode.disconnectPeer(peerId);
        }
        return true;
    },

    /**
     * Calls this peer back: clears the paused flag and, for an auto-reconnect
     * peer, rings it through the dead-drop right now. The ring lands whenever
     * the other device has the arcade open with the pair enabled — it does
     * NOT require the other user to act, only to not have hung up themselves.
     * Returns false when there's no pairing secret on record to ring with,
     * so callers should keep a manual "get a new invite code" action
     * available alongside this either way.
     */
    async callKnownPeer(deviceId) {
        ArcadeDiag.log('bridge', `user action: Call ${deviceId}`);
        setKnownPeerPaused(deviceId, false);
        const known = readKnownPeers()[deviceId];
        if (known && known.autoReconnect) {
            await ensureAddon(); // rdv is only populated once the addon has loaded
            // Honest signal: resumePair() returns false when there's no
            // pairing secret on record to re-arm (e.g. it was never
            // established, or was forgotten before this peer's last manual
            // reconnect) — that must NOT be reported as "trying" when
            // nothing was actually attempted.
            const tried = await rdv.resumePair(deviceId).catch((e) => {
                ArcadeDiag.log('bridge', `Call ${deviceId} failed: ${e && e.message}`);
                return false;
            });
            if (!tried) ArcadeDiag.log('bridge', `Call ${deviceId}: no pairing secret on record — nothing rung`);
            return tried;
        }
        ArcadeDiag.log('bridge', `Call ${deviceId}: auto-reconnect is off for this peer — nothing rung`);
        return false;
    },

    /**
     * Wipes this connection back to a blank slate: drops any live link,
     * forgets its stashed session (no resume-in-place on the next
     * reconnect), and forgets the rendezvous pairing secret (auto-reconnect
     * flips off — there's nothing left for it to resume). The saved
     * name/history stay; only deleteKnownPeer() forgets those too.
     */
    async startOverKnownPeer(deviceId) {
        ArcadeDiag.log('bridge', `user action: Start Over ${deviceId} (forgetting session + pairing secret)`);
        await ensureAddon(); // rdv/addon are only populated once the addon has loaded
        const peerId = identityLinks.get(deviceId);
        if (peerId) {
            addon.peerNode.disconnectPeer(peerId);
            addon.peerNode.forgetSession(peerId);
        }
        await rdv.disablePair(deviceId).catch(() => {});
        identityLinks.delete(deviceId);
        const known = readKnownPeers();
        if (known[deviceId]) {
            known[deviceId].autoReconnect = false;
            known[deviceId].paused = false;
            writeKnownPeers(known);
        }
        return true;
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
     * Fires when a peer hangs up on purpose (its user tapped Hang Up):
     * fn({deviceId, name}). The link is already being dropped; this is for
     * UI feedback — distinguish "they hung up" from a connection failure.
     */
    onRemoteBye(fn) {
        remoteByeListeners.push(fn);
        return () => {
            const i = remoteByeListeners.indexOf(fn);
            if (i >= 0) remoteByeListeners.splice(i, 1);
        };
    },

    /**
     * Call at launcher startup: if a paired session was live recently, boot
     * the transport and let the rendezvous layer actively reconnect it —
     * this is what resumes a game after the browser was killed on both
     * ends. Outside that window, any auto-reconnect peer still gets a quiet
     * STANDBY (subscribe-only): this device initiates nothing, but a Call
     * from the other side reaches it for as long as the arcade is open.
     */
    async resumeRendezvous() {
        let ts = 0;
        try { ts = parseInt(localStorage.getItem(LAST_LIVE_SESSION_KEY) || '0', 10); } catch (e) {}
        const fresh = ts && Date.now() - ts <= RESUME_WINDOW_MS;
        if (!fresh) {
            const known = readKnownPeers();
            if (!Object.values(known).some((p) => p && p.autoReconnect && !p.paused)) {
                ArcadeDiag.log('bridge', 'resume-on-launch: no recent session and no callable auto-reconnect peer — staying cold');
                return false;
            }
            ArcadeDiag.log('bridge', `resume-on-launch: last live session ${ts ? Math.round((Date.now() - ts) / 60000) + 'm ago' : 'never'} (outside ${RESUME_WINDOW_MS / 3600000}h window) — arming quiet standby only`);
            await ensureAddon();
            await rdv.standbyAll();
            return true;
        }
        ArcadeDiag.log('bridge', `resume-on-launch: last live session ${Math.round((Date.now() - ts) / 60000)}m ago — actively resuming paired sessions`);
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
