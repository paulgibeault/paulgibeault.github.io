/* arcade-router.js — the launcher's postMessage trust boundary + dispatch.
 *
 * ONE window 'message' listener authenticates every inbound frame message
 * and routes it: storage ops to arcade-storage-bridge.js, UI chrome ops to
 * arcade-ui-bridge.js, and the hello/welcome handshake, peer relay, quit
 * veto, and toast requests handled here. Extracted verbatim from
 * index.html's platformController.
 *
 * The trust test, in full — BOTH must hold before anything is read:
 *   - SOURCE: e.source must be the contentWindow of a frame the pool
 *     mounted (pool.findPoolEntryForSource), including frames inside their
 *     250ms retire grace so a suspend-time flush still lands.
 *   - ORIGIN: e.origin === 'null' — sandboxed-without-allow-same-origin
 *     frames always report the literal string 'null'.
 * The extracted bridge modules never re-derive frame identity — this
 * listener hands them already-authenticated (gameId, data) pairs.
 *
 * initMessageRouter(host) attaches the listener and returns { requestQuit,
 * stateSnapshotFor, replayPendingStorageMessages, replayPendingUiMessages }.
 * `host` supplies (see index.html's window.__arcade.routerHost, plus the
 * pool the POOL+ROUTER module block injects):
 *   pool                 — the arcade-pool.js API (frame identity,
 *                          postToIframe, hello bookkeeping, active-game)
 *   getP2P()/getStorage()/getUi()/getEnvelope() — live module handles;
 *                          null until their module loads (storage/ui
 *                          messages queue, peer/toast messages drop —
 *                          exactly as the inline switch behaved)
 *   currentSettings()    — the launcher's settings snapshot for welcome
 *   showToast(msg, opts) — the launcher toast
 *   devModeOn()          — dev-tracing flag for inbound message logs
 * No top-level side effects — the listener attaches inside init.
 */

import { KEY_PREFIX } from './arcade-storage-core.js';

export function initMessageRouter(host) {
    const pool = host.pool;

    // Capability flags shipped in arcade:welcome. Games feature-detect
    // via Arcade.peer.caps() instead of version checks — additive
    // launcher features never bump the protocol version. storage.bridge:
    // this launcher hosts the opaque-frame storage bridge (state.write /
    // store.op / files.op / storage.op + welcome.state snapshot).
    // ui.bridge: this launcher services arcade:ui.op (confirm/prompt/
    // setTitle/quitHook/openFile/share — see arcade-ui-bridge.js).
    const ARCADE_PEER_CAPS = ['peer.sendTo', 'peer.roster', 'peer.meta', 'storage.bridge', 'ui.bridge'];

    // The storage bridge (opaque-frame custodian: ls-proxy, state.write,
    // store.op, files.op, storage.op) lives in arcade-storage-bridge.js;
    // the router below delegates authenticated messages to it via
    // host.getStorage(). stateSnapshotFor stays with the router because the
    // arcade:hello → arcade:welcome path needs it synchronously.
    function stateSnapshotFor(gameId) {
        const out = {};
        const own = KEY_PREFIX + gameId + '.';
        const glob = KEY_PREFIX + 'global.';
        // Shared read-only literals: the device identity meta the SDK's
        // peer.self() reports, and the dev-tracing flag.
        const literals = [
            KEY_PREFIX + '_meta.deviceId',
            KEY_PREFIX + '_meta.deviceName',
            KEY_PREFIX + '_meta.dev'
        ];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k) continue;
                if (k.startsWith(own) || k.startsWith(glob) || literals.includes(k)) {
                    const v = localStorage.getItem(k);
                    if (typeof v === 'string') out[k] = v;
                }
            }
        } catch (e) {}
        return out;
    }

    // Storage-bridge delegation. The router owns the trust boundary and
    // hands each already-authenticated storage message to the bridge module
    // (host.getStorage(), wired by the storage module block). A message that
    // arrives before the module loads is queued and replayed on init —
    // dropping one would hang a game whose ls-proxy shim blocks boot on the
    // 'dump' reply. In practice no game auto-mounts at parse time, so the
    // queue is defence-in-depth, not a hot path.
    const pendingStorageMsgs = [];
    function dispatchStorageMessage(gameId, data, source, origin) {
        const S = host.getStorage();
        if (!S) { pendingStorageMsgs.push([gameId, data, source, origin]); return; }
        switch (data.type) {
            case 'ls-proxy-request': S.lsProxy(gameId, data, source, origin); break;
            case 'arcade:state.write': S.stateWrite(gameId, data); break;
            case 'arcade:store.op': S.storeOp(gameId, data); break;
            case 'arcade:files.op': S.filesOp(gameId, data); break;
            case 'arcade:storage.op': S.storageOp(gameId, data); break;
        }
    }
    function replayPendingStorageMessages() {
        while (pendingStorageMsgs.length) dispatchStorageMessage(...pendingStorageMsgs.shift());
    }

    // UI-bridge delegation — same trust-boundary/queue story as storage
    // above: the router authenticates, arcade-ui-bridge.js services. A
    // dropped pre-module message would strand a game's dialog promise
    // (its RPC ids only resolve on reply), hence the replay queue.
    const pendingUiMsgs = [];
    function dispatchUiMessage(gameId, data) {
        const U = host.getUi();
        if (!U) { pendingUiMsgs.push([gameId, data]); return; }
        U.uiOp(gameId, data);
    }
    function replayPendingUiMessages() {
        while (pendingUiMsgs.length) dispatchUiMessage(...pendingUiMsgs.shift());
    }

    // Quit veto round-trip (#35). Only ever asked of the ACTIVE game, and
    // only when its SDK registered a hook — everyone else resolves true
    // synchronously so the quit button stays instant. The timeout is the
    // no-trap guarantee: a hung/crashed frame forfeits its veto.
    const BEFORE_QUIT_TIMEOUT_MS = 1500;
    let beforeQuitSeq = 0;
    let beforeQuitPending = null; // { id, done }
    function requestQuit() {
        const gid = pool.getActiveGameId();
        const ui = host.getUi();
        if (!gid || !ui || !ui.hasQuitHook(gid) || !pool.isHelloed(gid)) {
            return Promise.resolve(true);
        }
        // A second click while a round-trip is in flight is swallowed —
        // the pending one resolves within the timeout either way.
        if (beforeQuitPending) return Promise.resolve(false);
        return new Promise((resolve) => {
            const id = 'q' + (++beforeQuitSeq);
            const timer = setTimeout(() => done(true), BEFORE_QUIT_TIMEOUT_MS);
            function done(allow) {
                if (!beforeQuitPending || beforeQuitPending.id !== id) return;
                beforeQuitPending = null;
                clearTimeout(timer);
                resolve(allow);
            }
            beforeQuitPending = { id: id, done: done };
            pool.postToIframe(gid, { type: 'arcade:ui.beforeQuit', id: id });
        });
    }

    window.addEventListener('message', (e) => {
        // Two guards (launcher-specific postMessage boundary — the WIRE
        // envelope shapes live in arcade-envelope.js, see #59).
        // Source: only iframes we mounted via ensureIframe
        // can match. Origin: sandboxed-without-allow-same-origin frames
        // always report the literal string 'null' — anything else means
        // a non-sandboxed document somehow speaks from a pooled frame
        // (should be impossible; reject on principle). Note 'null' no
        // longer discriminates a frame that navigated ITSELF elsewhere
        // (both are opaque) — that needs code exec inside the frame,
        // which already carries exactly the bridge powers of that
        // gameId, nothing more.
        const [gameId, entry] = pool.findPoolEntryForSource(e.source);
        if (!gameId) return;
        if (e.origin !== 'null') return;
        const data = e.data;
        if (!data || typeof data !== 'object') return;
        const t = data.type;
        if (typeof t !== 'string') return;
        if (host.devModeOn()) console.debug('[Arcade launcher ← ' + gameId + ']', data);

        if (t === 'ls-proxy-request') {
            dispatchStorageMessage(gameId, data, e.source, e.origin);
            return;
        }

        if (t.indexOf('arcade:') !== 0) return;
        switch (t) {
            case 'arcade:hello': {
                // Announce ourselves. peerStatus reflects the live bridge
                // when loaded (a game mounted mid-session must see
                // 'connected' immediately). Settings ride along so the
                // game can apply them before first paint; `peers` seeds
                // the game's roster with already-connected devices.
                pool.markHelloed(gameId);
                // The game's SDK is alive — clear any loading veil/error card.
                pool.onGameHelloed(gameId);
                const p2p = host.getP2P();
                // No version field — neither side ever read one; caps is
                // the launcher↔SDK compat contract (absent cap ⇒ feature
                // not offered, SDK degrades).
                pool.postToIframe(gameId, {
                    type: 'arcade:welcome',
                    caps: ARCADE_PEER_CAPS,
                    peerStatus: p2p ? p2p.status() : 'idle',
                    peers: p2p ? p2p.connectedPeers() : [],
                    settings: host.currentSettings(),
                    // Opaque frames can't read localStorage — this seeds
                    // the SDK's state cache (its keys, global.*, and the
                    // shared _meta identity/dev literals).
                    state: stateSnapshotFor(gameId)
                });
                // If this game is the active one, also send a resume hint
                // (the game's SDK may have missed the showGame() resume if
                // it handshook after the iframe was already visible).
                if (gameId === pool.getActiveGameId()) {
                    pool.postToIframe(gameId, { type: 'arcade:lifecycle.resume' });
                }
                // Presence: tell the remote launcher this game is now
                // listening (no-op unless a session is live).
                if (p2p) p2p.announceGame(gameId);
                break;
            }
            case 'arcade:peer.send': {
                // Wrap in the launcher envelope and ship over the data
                // channel. The SDK already gates on status==='connected',
                // so a null bridge here just means a stray message — drop.
                const p2p = host.getP2P();
                if (p2p) {
                    // A frame that carries a `to` is targeted. If the
                    // value is malformed, refuse outright — coercing to
                    // undefined would silently promote a PRIVATE frame
                    // to a broadcast at the iframe trust boundary (the
                    // SDK validates too, but the launcher cannot assume
                    // the iframe runs our SDK).
                    if ('to' in data && typeof data.to !== 'string') break;
                    p2p.send(gameId, data.payload, data.to);
                    // While a repair episode runs, every queued send comes
                    // back with a fresh queue-depth reading so the game
                    // can see how close it is to the replay cap.
                    if (p2p.status() === 'interrupted') {
                        pool.postToIframe(gameId, { type: 'arcade:peer.queue', ...p2p.queueSnapshot() });
                    }
                }
                break;
            }
            case 'arcade:state.write':
                // Bridged localStorage write-through. The KEY names the
                // whole permission: this frame's own namespace, the
                // shared global.* namespace, or the _meta.dev literal —
                // never another app's namespace, never other _meta.*
                // (device identity stays read-only), and structurally
                // never the qrp2p-* key stores.
                dispatchStorageMessage(gameId, data, e.source, e.origin);
                break;
            case 'arcade:store.op':
                // Async — replies with arcade:bridge.result when done.
                dispatchStorageMessage(gameId, data, e.source, e.origin);
                break;
            case 'arcade:files.op':
                dispatchStorageMessage(gameId, data, e.source, e.origin);
                break;
            case 'arcade:storage.op':
                dispatchStorageMessage(gameId, data, e.source, e.origin);
                break;
            case 'arcade:ui.op':
                // Launcher-mediated UI chrome (#35). Shape rules live in
                // arcade-envelope.js (validateUiOp); the bridge module
                // answers RPC ops via arcade:bridge.result.
                dispatchUiMessage(gameId, data);
                break;
            case 'arcade:ui.beforeQuit.result':
                // Only the active game's in-flight veto counts — a
                // background frame echoing ids must not release (or
                // deny) someone else's quit.
                if (beforeQuitPending && gameId === pool.getActiveGameId()
                        && data.id === beforeQuitPending.id) {
                    beforeQuitPending.done(data.allow !== false);
                }
                break;
            case 'arcade:ui.toast': {
                // Game asked the launcher to display a toast. Shape rules
                // live in arcade-envelope.js (validateToast), published on
                // window.__arcade.envelope by the STORAGE MODULES block.
                const envelope = host.getEnvelope();
                const toast = envelope && envelope.validateToast(data);
                if (toast) {
                    host.showToast(toast.message, {
                        error: toast.kind === 'error',
                        duration: toast.duration
                    });
                }
                break;
            }
        }
    });

    return {
        requestQuit: requestQuit,
        stateSnapshotFor: stateSnapshotFor,
        replayPendingStorageMessages: replayPendingStorageMessages,
        replayPendingUiMessages: replayPendingUiMessages
    };
}
