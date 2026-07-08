import { PeerManager } from './p2p-core.js';
import { P2PUIManager } from './p2p-ui.js';

export class P2PAddon extends EventTarget {
    constructor(options = {}) {
        super();
        this.peerNode = new PeerManager(options);
        this.ui = null;
        this.options = options;
        
        // Proxy events
        this.peerNode.addEventListener('message', (e) => {
            if (e.detail.incoming) {
                // Parse JSON if possible for convenience
                let parsed = e.detail.text;
                try { parsed = JSON.parse(parsed); } catch(err) {}
                this.dispatchEvent(new CustomEvent('data', { detail: parsed }));
            }
            // Emit raw 'message' too
            this.dispatchEvent(new CustomEvent('message', { detail: e.detail }));
        });
        
        this.peerNode.addEventListener('status', (e) => {
            this.dispatchEvent(new CustomEvent('status', { detail: e.detail }));
        });

        this.peerNode.addEventListener('diagnostic', (e) => {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: e.detail }));
        });
    }

    async init() {
        await this.initDependencies();
        this.injectCSS();
        this.ui = new P2PUIManager(this.peerNode);
        return this;
    }

    async initDependencies() {
        const loadScript = (src, checkGlobal) => {
            return new Promise((resolve, reject) => {
                if (window[checkGlobal]) return resolve(); // Already loaded
                const script = document.createElement('script');
                script.src = src;
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        };

        // Vendored copies only (p2p/vendor/) — the launcher must never reach
        // for a CDN at runtime. loadScript still skips any global that a host
        // page pre-loaded itself.
        await Promise.all([
            loadScript(new URL('./vendor/qrcode.min.js', import.meta.url).href, "QRCode"),
            loadScript(new URL('./vendor/html5-qrcode.min.js', import.meta.url).href, "Html5Qrcode")
        ]);
    }

    injectCSS() {
        if (!document.getElementById('p2p-addon-styles')) {
            const link = document.createElement('link');
            link.id = 'p2p-addon-styles';
            link.rel = 'stylesheet';
            const url = new URL('./p2p-addon.css', import.meta.url).href;
            link.href = url;
            document.head.appendChild(link);
        }
    }

    showUI(options) {
        // options.mode === 'host' skips the choice screen and shows a fresh
        // invite code immediately (one-tap reconnect entry).
        if (this.ui) this.ui.show(options);
        else console.error("P2PAddon not initialized. Call init() first.");
    }

    hideUI() {
        if (this.ui) this.ui.hide();
    }

    /**
     * Fully tears down all P2P resources: closes peer connections, BroadcastChannel,
     * window event listeners, QR scanner, and removes the modal DOM. After calling
     * destroy(), call init() again to reinitialize for a new session.
     */
    destroy() {
        this.ui?.destroy();
        this.ui = null;
        this.peerNode?.destroy();
    }

    send(data) {
        if (typeof data !== 'string') {
            data = JSON.stringify(data);
        }
        this.peerNode.send(data);
    }
}

// Make globally available as an alternative to module importing
window.P2PAddon = P2PAddon;
export default P2PAddon;
