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
 * Wire envelope between launchers (invisible to games):
 *   { arcade: 1, gameId, payload }
 * The receiving bridge routes by gameId to the matching mounted iframe.
 *
 * Status vocabulary mapping (transport → SDK):
 *   connected                    → 'connected'   (data channel OPEN — the
 *                                                 transport's v1.5.1 meaning)
 *   finalizing/checking/new/...  → 'connecting'
 *   disconnected/failed/closed   → 'idle'
 */

const SDK_STATUS = {
    connected: 'connected',
    disconnected: 'idle',
    failed: 'idle',
    closed: 'idle'
};

function mapStatus(transportStatus) {
    return SDK_STATUS[transportStatus] || 'connecting';
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
    for (const fn of statusListeners) {
        try { fn(sdkStatus); } catch (e) {}
    }
}

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

        mp.addEventListener('status', (e) => {
            setStatus(mapStatus(e.detail.status));
        });

        // 'data' fires with JSON already parsed when possible.
        mp.addEventListener('data', (e) => {
            const env = e.detail;
            if (!env || typeof env !== 'object' || env.arcade !== 1) return;
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
    /** Current SDK-vocabulary status: 'idle' | 'connecting' | 'connected'. */
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

    /** Open the connection modal (Host / Join ceremony UI). */
    async openUI() {
        (await ensureAddon()).showUI();
    },

    /**
     * Send a game's payload to the remote peer, wrapped in the launcher
     * envelope. Returns false when not connected (mirrors SDK semantics).
     */
    send(gameId, payload) {
        if (!addon || sdkStatus !== 'connected') return false;
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
