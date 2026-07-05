import { ConnectionUtils } from './p2p-core.js';

export class P2PUIManager {
    constructor(peerNode) {
        this.peerNode = peerNode;
        this.html5Qrcode = null;
        this.rawSDPPayload = "";
        this.currentScanSuccessCallback = null;
        
        this.createUI();
        this.bindEvents();
        this._setupInterTabComms();
        this._checkURLFragment();
    }

    // ==========================================
    // INTER-TAB COMMUNICATION
    // Three channels are tried in parallel to maximise cross-browser reach:
    //   1. BroadcastChannel  → works within the same browser profile (Chrome→Chrome, Firefox→Firefox)
    //   2. localStorage      → works within the same origin + browser profile (fallback to BC)
    //   3. window.opener     → works when the joiner tab was opened by the host tab (Share API same browser)
    // For cross-browser scenarios (iOS Share → Safari while game is in Chrome), these channels all
    // fail gracefully. In that case the joiner ALWAYS displays an answer QR that the host scans — 
    // this is the universal fallback that works 100% of the time.
    // ==========================================

    _setupInterTabComms() {
        // --- Channel 1: BroadcastChannel ---
        this.bc = new BroadcastChannel('p2p-signaling');
        this.bc.onmessage = (e) => {
            if (e.data.type === 'answer') {
                this._tryApplyAnswer(e.data.payload, 'BroadcastChannel');
            } else if (e.data.type === 'answer-ack') {
                // The host tab confirmed it applied the answer we relayed.
                this._onRelayAck();
            }
        };

        // --- Channel 2: localStorage ---
        // Store ref so we can removeEventListener in destroy()
        this._storageListener = (e) => {
            if (e.key === 'p2p-answer-forward' && e.newValue) {
                try {
                    const data = JSON.parse(e.newValue);
                    localStorage.removeItem('p2p-answer-forward');
                    this._tryApplyAnswer(data, 'localStorage');
                } catch(_) {}
            }
        };
        window.addEventListener('storage', this._storageListener);

        // --- Channel 3: window.postMessage (host receives answer from joiner tab it opened) ---
        // Store ref so we can removeEventListener in destroy()
        this._messageListener = (e) => {
            // Only accept messages from same origin
            if (e.origin !== window.location.origin) return;
            if (e.data && e.data.type === 'p2p-answer') {
                this._tryApplyAnswer(e.data.payload, 'window.postMessage');
            }
        };
        window.addEventListener('message', this._messageListener);
    }

    _tryApplyAnswer(data, source) {
        try {
            ConnectionUtils.validatePayload(data);
        } catch (e) {
            this.logDiag('warn', `Ignoring malformed answer from ${source}: ${e.message}`);
            return;
        }
        if (this.peerNode.peers.has(data.peerId)) {
            this.logDiag('info', `Applying Answer from ${source}.`);
            this._setStage(2, 'done'); // answer received (host)
            this.peerNode.acceptAnswer(data);
            // Ack back so a relay tab (link tennis) can show "delivered".
            try { this.bc.postMessage({ type: 'answer-ack', peerId: data.peerId }); } catch(_) {}
        } else {
            this.logDiag('warn', `Answer received via ${source} but peer not found; ignoring.`);
        }
    }

    // ==========================================
    // LINK TENNIS — relay tab behavior
    // The host tapped the joiner's reply link, which opened THIS tab. Forward
    // the answer to the original host tab and confirm delivery via ack.
    // ==========================================

    _relayAnswerToHostTab(data) {
        this.logDiag('info', 'Acting as relay: forwarding answer to your game tab...');
        this.ui.qrContainer.style.display = 'block';
        if (this.ui.qrPlaceholder) this.ui.qrPlaceholder.style.display = 'none';
        this.ui.btnHost.style.display = 'none';
        this.ui.btnJoin.style.display = 'none';
        this.ui.btnShareSdp.style.display = 'none';
        this.ui.btnCopySdp.style.display = 'none';
        this.ui.qrInstructions.innerHTML =
            '📨 <strong>Reply received!</strong> Delivering it to your game tab...';

        this._awaitingRelayAck = true;

        // Forward over every same-origin channel; the host tab listens on all.
        try { this.bc.postMessage({ type: 'answer', payload: data }); } catch(_) {}
        try { localStorage.setItem('p2p-answer-forward', JSON.stringify(data)); } catch(_) {}
        try {
            if (window.opener && !window.opener.closed) {
                window.opener.postMessage({ type: 'p2p-answer', payload: data }, window.location.origin);
            }
        } catch(_) {}

        this._relayAckTimer = setTimeout(() => {
            if (!this._awaitingRelayAck) return;
            this._awaitingRelayAck = false;
            this.ui.qrInstructions.innerHTML =
                '⚠️ <strong>Could not find your game tab.</strong><br>' +
                'It may be open in a different browser. Go back to the game tab and use ' +
                '<em>Scan Answer QR</em> on the joiner\'s screen instead.';
            this.logDiag('warn', 'No ack from host tab after 5s. Is the game open in a different browser?');
        }, 5000);
    }

    _onRelayAck() {
        if (!this._awaitingRelayAck) return;
        this._awaitingRelayAck = false;
        clearTimeout(this._relayAckTimer);
        this.logDiag('success', 'Host tab confirmed answer delivery.');
        this.ui.qrInstructions.innerHTML =
            '✅ <strong>Delivered!</strong> The connection is completing in your game tab. You can close this tab.';
    }

    // ==========================================
    // STAGE TRACKER — tiny "connection lab"
    // A visible checklist of the signaling legs so a failed real-world test
    // tells you WHICH leg died. Copy Transcript grabs the full diag log.
    // ==========================================

    _initStages(role) {
        this._stageLabels = role === 'host'
            ? ['Offer created', 'Invite sent', 'Answer received', 'Connected']
            : ['Offer received', 'Answer created', 'Reply sent', 'Connected'];
        this._stageStates = this._stageLabels.map(() => 'pending');
        this._renderStages();
    }

    _setStage(index, state) {
        if (!this._stageStates || index < 0 || index >= this._stageStates.length) return;
        this._stageStates[index] = state;
        this._renderStages();
    }

    _renderStages() {
        if (!this.ui.stages || !this._stageLabels) return;
        this.ui.stages.style.display = 'flex';
        this.ui.stages.innerHTML = this._stageLabels.map((label, i) => {
            const state = this._stageStates[i];
            const icon = state === 'done' ? '✅' : (state === 'error' ? '❌' : '◻️');
            const cls = `p2p-stage p2p-stage-${state}`;
            return `<span class="${cls}">${icon} ${label}</span>`;
        }).join('<span class="p2p-stage-arrow">→</span>');
    }

    // ==========================================
    // URL FRAGMENT INGESTION
    // Called on page load. Detects if this tab was opened via a share link.
    // ==========================================

    _checkURLFragment() {
        const hash = window.location.hash;
        const offerMatch = hash.match(/[#&]p2p-offer=([^&]+)/);
        const answerMatch = hash.match(/[#&]p2p-answer=([^&]+)/);

        if (offerMatch || answerMatch) {
            this.show();
            const payload = offerMatch ? offerMatch[1] : answerMatch[1];
            const type = offerMatch ? 'offer' : 'answer';
            this._ingestURLPayload(payload, type);
            // Clean the fragment so refreshing doesn't re-trigger
            history.replaceState(null, '', window.location.pathname + window.location.search);
        }
    }

    async _ingestURLPayload(payload, type) {
        try {
            this.logDiag('info', `URL ${type} detected. Ingesting...`);
            const data = await ConnectionUtils.decodePayload(payload);

            if (type === 'offer') {
                // -------------------------------------------------------
                // JOINER PATH: This tab was opened by the host's share link.
                //
                // Strategy for returning the answer:
                //   (A) Display answer as QR code — universal, always works.
                //       The host scans it directly. This is the PRIMARY path.
                //   (B) Simultaneously attempt all inter-tab channels so that
                //       if the same browser is running the host, the connection
                //       completes automatically without any scanning.
                // -------------------------------------------------------
                this.ui.btnHost.style.display = 'none';
                this.ui.btnJoin.style.display = 'none';
                this._initStages('joiner');
                this._setStage(0, 'done'); // offer received

                this.logDiag('info', 'Computing Answer SDP...');
                const answerData = await this.peerNode.createAnswer(data);
                this._setStage(1, 'done'); // answer created

                const encoded = await ConnectionUtils.encodePayload(answerData);
                this.rawSDPPayload = encoded;

                // PRIMARY path: send the reply link back through the same chat
                // thread the invite arrived on ("link tennis"). QR is secondary.
                await this.displayQRCode(answerData,
                    "✅ Answer ready! Tap \"Send reply link\" and send it back in the SAME chat you were invited from. The host taps it — done. (Or the host can scan this QR.)");
                this.ui.btnShareSdp.textContent = '📤 Send reply link';

                // BONUS path: try all inter-tab channels silently in parallel
                const answerObj = JSON.parse(answerData);
                this._attemptAutoReturn(answerObj, encoded);

            } else {
                // -------------------------------------------------------
                // HOST RETURN LEG ("link tennis"): this tab was opened by
                // tapping the joiner's reply link. The live RTCPeerConnection
                // usually lives in ANOTHER tab (the original host tab), so
                // this tab acts as a RELAY: forward the answer over every
                // same-origin channel and wait for the host tab to ack.
                // -------------------------------------------------------
                if (this.peerNode.peers.has(data.peerId)) {
                    // Rare: this very tab holds the pending offer.
                    this._tryApplyAnswer(data, 'URL fragment');
                    this.ui.qrContainer.style.display = 'block';
                    this.ui.qrInstructions.innerHTML =
                        '<strong>Answer received!</strong> Completing connection...';
                } else {
                    this._relayAnswerToHostTab(data);
                }
            }
        } catch (e) {
            this.logDiag('error', `URL payload ingestion failed: ${e.message}`);
            this.logDiag('warn', 'If the link came from a device running a different app version, reload the page on BOTH devices and re-share the link.');
        }
    }

    /**
     * Tries to route the answer back to the host tab automatically using all
     * available inter-tab channels. Falls back gracefully — QR is always shown.
     */
    _attemptAutoReturn(answerObj, compressedAnswer) {
        // Channel 1: BroadcastChannel
        try {
            this.bc.postMessage({ type: 'answer', payload: answerObj });
            this.logDiag('info', 'Answer broadcast via BroadcastChannel.');
        } catch(_) {}

        // Channel 2: localStorage
        try {
            localStorage.setItem('p2p-answer-forward', JSON.stringify(answerObj));
            this.logDiag('info', 'Answer written to localStorage.');
        } catch(_) {}

        // Channel 3: window.opener (if this tab was opened by the host tab)
        try {
            if (window.opener && !window.opener.closed) {
                window.opener.postMessage(
                    { type: 'p2p-answer', payload: answerObj },
                    window.location.origin
                );
                this.logDiag('info', 'Answer sent to opener tab via postMessage.');
            }
        } catch(_) {}

        // Build a shareable answer URL as well (for the Share button on the joiner)
        const fragment = `#p2p-answer=${compressedAnswer}`;
        this._answerShareURL = window.location.href.split('#')[0] + fragment;
    }

    // ==========================================
    // SHARING
    // ==========================================

    async _shareOrCopy(payload, type, instructions) {
        const fragment = `#p2p-${type}=${payload}`;
        const shareURL = window.location.href.split('#')[0] + fragment;

        if (navigator.share) {
            try {
                await navigator.share({
                    title: `P2P ${type === 'offer' ? 'Game Invite' : 'Connection Answer'}`,
                    text: instructions,
                    url: shareURL,
                });
                this.logDiag('success', `Shared ${type} via native share sheet.`);
                return true;
            } catch (e) {
                if (e.name !== 'AbortError') {
                    this.logDiag('warn', `Native share failed (${e.message}), falling back to clipboard.`);
                } else {
                    return false; // User cancelled — don't fall through
                }
            }
        }

        // Fallback: copy URL to clipboard
        try {
            await navigator.clipboard.writeText(shareURL);
            this.logDiag('success', 'Share URL copied to clipboard!');
            this._showShareFeedback('Link copied! Send it to your opponent.');
            return true;
        } catch (e) {
            this.logDiag('warn', 'Clipboard unavailable. Showing manual copy prompt.');
            prompt('Copy this link and send it to your opponent:', shareURL);
            return true;
        }
    }

    _showShareFeedback(msg) {
        if (!this.ui.shareToast) return;
        this.ui.shareToast.textContent = msg;
        this.ui.shareToast.style.display = 'block';
        setTimeout(() => { this.ui.shareToast.style.display = 'none'; }, 3000);
    }

    show() {
        this.ui.overlay.style.display = 'flex';
        setTimeout(() => {
            const focusable = this.ui.overlay.querySelectorAll('button, input');
            const visible = Array.from(focusable).filter(el => ((el.offsetWidth > 0 || el.offsetHeight > 0) && el.style.display !== 'none'));
            if (visible.length) visible[0].focus();
        }, 50);
    }

    hide() {
        this.ui.overlay.style.display = 'none';
        this.cleanupUI();
    }

    createUI() {
        const template = `
        <div id="p2p-modal-overlay" class="p2p-modal-overlay" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="p2p-modal-title">
            <div class="p2p-modal">
                <header class="p2p-header">
                    <h2 id="p2p-modal-title">Multiplayer Connection <span style="font-size: 0.5em; color: #888; vertical-align: middle; font-weight: normal; margin-left: 10px;">v1.5.1</span></h2>
                    <button id="p2p-btn-close" class="p2p-btn-danger" style="border:none; border-radius:4px; padding:4px 8px; cursor:pointer;" aria-label="Close modal">X</button>
                </header>
                <div id="p2p-status-badge" class="p2p-status-disconnected">DISCONNECTED</div>
                <div id="p2p-stages" style="display:none; flex-wrap:wrap; align-items:center; gap:4px; font-size:11px; color:#aaa; margin:8px 0; padding:6px 8px; background:#181818; border-radius:6px;"></div>
                
                <div class="p2p-panels">
                    <div class="p2p-panel">
                        <h3 style="margin-top:0">1. Host Session</h3>
                        <button id="p2p-btn-host" class="p2p-btn p2p-btn-primary">Host (Create Offer)</button>
                        <button id="p2p-btn-add-player" class="p2p-btn p2p-btn-primary" style="display:none;">Add Another Player</button>
                        <button id="p2p-btn-scan-ans" class="p2p-btn p2p-btn-secondary" style="display:none;">📷 Scan Answer QR</button>
                    </div>
                    <div class="p2p-panel">
                        <h3 style="margin-top:0">2. Join Session</h3>
                        <button id="p2p-btn-join" class="p2p-btn p2p-btn-primary">Join (Scan Offer)</button>
                    </div>
                </div>

                <details class="p2p-advanced-settings" style="margin-bottom:15px; border: 1px solid #404040; border-radius: 8px; padding: 12px; background: #1f1f1f;">
                    <summary style="cursor:pointer; font-weight:600; font-size:13px; color:#aaa; user-select:none;">⚙️ Advanced Connection Settings</summary>
                    <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px; font-size:12px; color:#ddd;">
                        <label style="display:flex; align-items:center; gap:10px;">
                            <span>Connection mode:</span>
                            <select id="p2p-opt-icemode" style="background:#111; color:#fff; border:1px solid #404040; padding:3px 6px; border-radius:4px;">
                                <option value="anywhere">Anywhere (uses public STUN)</option>
                                <option value="local">Same Wi-Fi only (zero external servers)</option>
                            </select>
                        </label>
                        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                            <input type="checkbox" id="p2p-opt-local" checked>
                            Allow Local Candidates (mDNS / same-Wi-Fi)
                        </label>
                        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                            <input type="checkbox" id="p2p-opt-ipv6" checked>
                            Allow IPv6 Candidates (cellular networks)
                        </label>
                        <div style="display:flex; align-items:center; gap:10px;">
                            <span>Timeout (minutes):</span>
                            <input type="number" id="p2p-opt-timeout" value="5" min="1" max="30" style="width:50px; background:#111; color:#fff; border:1px solid #404040; padding:2px; border-radius:4px; text-align:center;">
                        </div>
                    </div>
                </details>

                <div class="p2p-panel" style="margin-bottom: 15px;">
                    <div id="p2p-qr-container" style="display:none; text-align:center;">
                        <p id="p2p-qr-instructions"></p>
                        <button id="p2p-btn-share-sdp" class="p2p-btn p2p-btn-primary" style="width:auto; padding: 10px 24px; font-size:15px;">📤 Share Link</button>
                        <div id="p2p-share-toast" style="display:none; margin-top:8px; color:#4ade80; font-size:13px;"></div>
                        <details style="margin-top:12px;">
                            <summary style="cursor:pointer; color:#888; font-size:12px;">Show QR code instead</summary>
                            <div id="p2p-qr-canvas" style="margin-top:8px;"></div>
                        </details>
                        <br>
                        <button id="p2p-btn-copy-sdp" class="p2p-btn p2p-text-btn" style="width:auto;">Copy Raw Data</button>
                    </div>
                    
                    <div id="p2p-scanner-container" style="display:none;">
                        <div id="p2p-reader" aria-label="QR Code Scanner Camera View" role="region"></div>
                        <div class="p2p-paste-section">
                            <input type="text" id="p2p-paste-input" placeholder="Paste raw data or answer link...">
                            <button id="p2p-btn-submit-paste" class="p2p-btn p2p-btn-secondary" style="margin-bottom:0; width:auto;">Submit</button>
                        </div>
                        <label class="p2p-btn p2p-btn-secondary" style="display:inline-block; margin-top:10px; width:auto; cursor:pointer;">
                            📁 Decode QR from image / screenshot
                            <input type="file" id="p2p-file-scan" accept="image/*" style="display:none;">
                        </label>
                        <button id="p2p-btn-cancel-scan" class="p2p-btn p2p-btn-danger" style="margin-top:10px;">Cancel Scan</button>
                    </div>
                    
                    <div id="p2p-qr-placeholder" class="p2p-qr-placeholder">
                        Select Host or Join to begin.
                    </div>
                </div>

                <div class="p2p-panel">
                    <h3 style="margin-top:0; font-size:14px;">Diagnostics
                        <button id="p2p-btn-copy-transcript" class="p2p-btn p2p-text-btn" style="float:right; width:auto; font-size:11px; padding:2px 8px; margin:0;">📋 Copy transcript</button>
                    </h3>
                    <div id="p2p-diagnostics-out" class="p2p-diagnostics-box" role="log" aria-live="polite">
                        <div class="p2p-diag-info">[SYSTEM] Engine initialized.</div>
                    </div>
                </div>
            </div>
        </div>
        `;
        
        const wrapper = document.createElement('div');
        wrapper.innerHTML = template.trim();
        document.body.appendChild(wrapper.firstChild);
        
        this.ui = {
            overlay: document.getElementById('p2p-modal-overlay'),
            btnClose: document.getElementById('p2p-btn-close'),
            btnHost: document.getElementById('p2p-btn-host'),
            btnAddPlayer: document.getElementById('p2p-btn-add-player'),
            btnJoin: document.getElementById('p2p-btn-join'),
            btnScanAns: document.getElementById('p2p-btn-scan-ans'),
            statusBadge: document.getElementById('p2p-status-badge'),
            qrContainer: document.getElementById('p2p-qr-container'),
            qrInstructions: document.getElementById('p2p-qr-instructions'),
            qrCanvas: document.getElementById('p2p-qr-canvas'),
            btnShareSdp: document.getElementById('p2p-btn-share-sdp'),
            shareToast: document.getElementById('p2p-share-toast'),
            btnCopySdp: document.getElementById('p2p-btn-copy-sdp'),
            scannerContainer: document.getElementById('p2p-scanner-container'),
            btnCancelScan: document.getElementById('p2p-btn-cancel-scan'),
            pasteInput: document.getElementById('p2p-paste-input'),
            btnSubmitPaste: document.getElementById('p2p-btn-submit-paste'),
            qrPlaceholder: document.getElementById('p2p-qr-placeholder'),
            diagnosticsOut: document.getElementById('p2p-diagnostics-out'),
            optLocal: document.getElementById('p2p-opt-local'),
            optIPv6: document.getElementById('p2p-opt-ipv6'),
            optTimeout: document.getElementById('p2p-opt-timeout'),
            optIceMode: document.getElementById('p2p-opt-icemode'),
            stages: document.getElementById('p2p-stages'),
            fileScan: document.getElementById('p2p-file-scan'),
            btnCopyTranscript: document.getElementById('p2p-btn-copy-transcript')
        };

        // Initialize UI values from PeerManager options
        this.ui.optLocal.checked = this.peerNode.options.allowLocalCandidates;
        this.ui.optIPv6.checked = this.peerNode.options.allowIPv6Candidates;
        this.ui.optTimeout.value = Math.round(this.peerNode.options.connectionTimeoutMs / 60000);
        this.ui.optIceMode.value = this.peerNode.options.iceMode;
    }

    logDiag(type, msg) {
        const div = document.createElement('div');
        div.className = `p2p-diag-${type}`;
        div.textContent = `[${new Date().toLocaleTimeString().split(' ')[0]}] ${msg}`;
        this.ui.diagnosticsOut.appendChild(div);
        this.ui.diagnosticsOut.scrollTop = this.ui.diagnosticsOut.scrollHeight;
    }

    bindEvents() {
        this.ui.btnClose.addEventListener('click', () => this.hide());
        
        // Configurable options binders
        const updatePeerNodeOptions = () => {
            this.peerNode.options.allowLocalCandidates = this.ui.optLocal.checked;
            this.peerNode.options.allowIPv6Candidates = this.ui.optIPv6.checked;
            this.peerNode.options.connectionTimeoutMs = (parseInt(this.ui.optTimeout.value, 10) || 5) * 60 * 1000;
            this.peerNode.options.iceMode = this.ui.optIceMode.value === 'local' ? 'local' : 'anywhere';
            this.logDiag('info', `Settings updated: Mode=${this.peerNode.options.iceMode}, Local Candidates=${this.peerNode.options.allowLocalCandidates}, IPv6=${this.peerNode.options.allowIPv6Candidates}, Timeout=${this.ui.optTimeout.value}m`);
        };

        this.ui.optLocal.addEventListener('change', updatePeerNodeOptions);
        this.ui.optIPv6.addEventListener('change', updatePeerNodeOptions);
        this.ui.optTimeout.addEventListener('change', updatePeerNodeOptions);
        this.ui.optIceMode.addEventListener('change', updatePeerNodeOptions);

        // ---- Copy full diagnostics transcript (for bug reports / remote debugging) ----
        this.ui.btnCopyTranscript.addEventListener('click', async () => {
            const lines = Array.from(this.ui.diagnosticsOut.children).map(el => el.textContent);
            const transcript = [
                `# P2P transcript ${new Date().toISOString()}`,
                `# UA: ${navigator.userAgent}`,
                `# Mode: ${this.peerNode.options.iceMode}, role: ${this.peerNode.isHost ? 'host' : 'joiner'}`,
                ...lines
            ].join('\n');
            try {
                await navigator.clipboard.writeText(transcript);
                this._showShareFeedback('Transcript copied.');
            } catch (_) {
                prompt('Copy transcript:', transcript);
            }
        });

        // ---- Decode a QR from an image file (e.g. a texted screenshot of the answer QR) ----
        this.ui.fileScan.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            e.target.value = ''; // allow re-selecting the same file
            if (!file || !this.currentScanSuccessCallback) return;

            // The camera scanner and scanFile share the same reader element —
            // stop the camera before decoding the image.
            if (this.html5Qrcode && this.html5Qrcode.isScanning) {
                try { await this.html5Qrcode.stop(); this.html5Qrcode.clear(); } catch(_) {}
            }
            if (!this.html5Qrcode) this.html5Qrcode = new Html5Qrcode('p2p-reader');

            try {
                this.logDiag('info', `Decoding QR from image "${file.name}"...`);
                const decodedText = await this.html5Qrcode.scanFile(file, false);
                const data = await ConnectionUtils.decodePayload(decodedText);
                this.ui.scannerContainer.style.display = 'none';
                this.logDiag('success', 'QR decoded from image!');
                this.currentScanSuccessCallback(data);
            } catch (err) {
                this.logDiag('error', `Image decode failed: ${err.message || err}`);
                alert('Could not find a readable QR code in that image.');
            }
        });
        
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.ui.overlay.style.display !== 'none') {
                this.hide();
            }
        });

        this.ui.overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                const focusableElements = this.ui.overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
                const visibleElements = Array.from(focusableElements).filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
                if (visibleElements.length === 0) return;

                const firstElement = visibleElements[0];
                const lastElement = visibleElements[visibleElements.length - 1];

                if (e.shiftKey) {
                    if (document.activeElement === firstElement) {
                        e.preventDefault();
                        lastElement.focus();
                    }
                } else {
                    if (document.activeElement === lastElement) {
                        e.preventDefault();
                        firstElement.focus();
                    }
                }
            }
        });

        this.peerNode.addEventListener('diagnostic', (e) => this.logDiag(e.detail.type, e.detail.msg));
        
        this.peerNode.addEventListener('status', (e) => {
            const { peerId, status } = e.detail;
            
            if (this.peerNode.isHost) {
                let connectedCount = 0;
                this.peerNode.peers.forEach(p => { if (p.status === 'connected') connectedCount++; });
                
                if (connectedCount > 0) {
                    this.ui.statusBadge.textContent = `HOSTING (${connectedCount} PEERS)`;
                    this.ui.statusBadge.className = 'p2p-status-connected';
                    this._setStage(3, 'done');
                    this.cleanupUI();
                    
                    this.ui.btnHost.style.display = 'none';
                    this.ui.btnJoin.style.display = 'none';
                    this.ui.btnScanAns.style.display = 'none';
                    this.ui.btnAddPlayer.style.display = 'inline-block';
                } else if (status === 'disconnected') {
                    this.ui.statusBadge.textContent = 'DISCONNECTED';
                    this.ui.statusBadge.className = 'p2p-status-disconnected';
                } else {
                    this.ui.statusBadge.textContent = 'CONNECTING...';
                    this.ui.statusBadge.className = 'p2p-status-connecting';
                }
            } else {
                this.ui.statusBadge.textContent = status.toUpperCase();
                this.ui.statusBadge.className = '';
                if (status === 'connected') {
                    this.ui.statusBadge.classList.add('p2p-status-connected');
                    this._setStage(3, 'done');
                    this.cleanupUI();
                    setTimeout(() => this.hide(), 1500);
                }
                else if (status === 'finalizing') {
                    // ICE path is up but the host hasn't applied our answer yet.
                    // Keep the answer QR / reply-link UI fully visible — the
                    // ceremony is NOT done until the data channel opens.
                    this.ui.statusBadge.textContent = 'ALMOST THERE — HOST NEEDS YOUR ANSWER';
                    this.ui.statusBadge.classList.add('p2p-status-connecting');
                }
                else if (status === 'disconnected' || status === 'failed') this.ui.statusBadge.classList.add('p2p-status-disconnected');
                else this.ui.statusBadge.classList.add('p2p-status-connecting');
            }
        });

        // ---- HOST: create offer ----
        this.ui.btnHost.addEventListener('click', async () => {
            this.logDiag('info', '--- HOST SEQUENCE ---');
            this.ui.btnHost.style.display = 'none';
            this.ui.btnJoin.style.display = 'none';
            this.ui.btnScanAns.style.display = 'block';
            this._initStages('host');

            try {
                const offerData = await this.peerNode.createOffer();
                this._setStage(0, 'done'); // offer created

                // Prefer Share API for offer delivery — resilient across devices
                if (navigator.share) {
                    await this.displayQRCode(offerData,
                        "📤 Share this invite link with the joiner. When they send a reply link back, just tap it — or click \"Scan Answer QR\" to scan their screen.");
                    this.logDiag('info', 'Offer ready. Share link generated.');
                } else {
                    // No Share API (desktop) — show QR for joiner to scan
                    await this.displayQRCode(offerData, "Step 1: Have JOINER scan this QR code.");
                }
            } catch (e) {
                this._setStage(0, 'error');
                this.logDiag('error', 'Critical failure generating Host Offer.');
            }
        });

        this.ui.btnAddPlayer.addEventListener('click', async () => {
            this.logDiag('info', '--- ADDING MULTIPLAYER ---');
            this.ui.btnAddPlayer.style.display = 'none';
            this.ui.btnScanAns.style.display = 'block';
            
            try {
                const offerData = await this.peerNode.createOffer();
                this.displayQRCode(offerData, "Step 1: Have NEW JOINER scan this QR code.");
            } catch (e) {
                this.logDiag('error', 'Critical failure generating Additional Offer.');
            }
        });

        // ---- HOST: scan joiner's answer QR ----
        this.ui.btnScanAns.addEventListener('click', () => {
            this.logDiag('info', 'Opening scanner for Answer QR...');
            this.startScanner(async (answerData) => {
                this.logDiag('info', 'Applying Answer...');
                this._setStage(2, 'done'); // answer received
                await this.peerNode.acceptAnswer(answerData);
            });
        });

        // ---- JOINER: scan host's offer QR ----
        this.ui.btnJoin.addEventListener('click', () => {
            this.logDiag('info', '--- JOIN SEQUENCE ---');
            this.ui.btnHost.style.display = 'none';
            this.ui.btnJoin.style.display = 'none';
            this._initStages('joiner');

            this.startScanner(async (offerData) => {
                this.logDiag('info', 'Ingested Offer. Computing Answer SDP...');
                this._setStage(0, 'done'); // offer received
                try {
                    const answerData = await this.peerNode.createAnswer(offerData);
                    this._setStage(1, 'done'); // answer created

                    // Show QR for host to scan — universal and reliable
                    await this.displayQRCode(answerData,
                        "📱 Show this QR to the HOST to scan. Or use Share/Copy to send them the reply link.");

                    // Also attempt auto-forwarding via all inter-tab channels
                    const encoded = this.rawSDPPayload; // set by displayQRCode
                    const answerObj = JSON.parse(answerData);
                    this._attemptAutoReturn(answerObj, encoded);
                } catch (e) {
                    this._setStage(1, 'error');
                    this.logDiag('error', 'Critical failure computing Joiner Answer.');
                }
            });
        });

        this.ui.btnCancelScan.addEventListener('click', () => {
            this.cleanupUI();
            
            if (this.peerNode.isHost && Array.from(this.peerNode.peers.values()).some(p => p.status === 'connected')) {
                this.ui.btnAddPlayer.style.display = 'inline-block';
                this.ui.btnScanAns.style.display = 'none';
            } else {
                this.ui.btnHost.style.display = 'inline-block';
                this.ui.btnJoin.style.display = 'inline-block';
                this.ui.btnScanAns.style.display = 'none';
                if (this.ui.btnAddPlayer) this.ui.btnAddPlayer.style.display = 'none';
            }
            
            // Close any pending connections
            this.peerNode.peers.forEach((p, id) => {
                if (p.status !== 'connected') {
                    p.connection.close();
                    this.peerNode.peers.delete(id);
                }
            });
        });

        // ---- Share / Copy buttons ----
        this.ui.btnShareSdp.addEventListener('click', async () => {
            const type = this.peerNode.isHost ? 'offer' : 'answer';
            const instructions = type === 'offer'
                ? 'Open this link to join my game! After joining, tap "Send reply link" and send it back to me here.'
                : 'Tap this link to complete the connection.';
            const shared = await this._shareOrCopy(this.rawSDPPayload, type, instructions);
            if (shared) {
                // host stage 1 = "Invite sent"; joiner stage 2 = "Reply sent"
                this._setStage(this.peerNode.isHost ? 1 : 2, 'done');
            }
        });

        this.ui.btnCopySdp.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(this.rawSDPPayload);
                this._showShareFeedback('Raw data copied to clipboard.');
            } catch(e) {
                this.logDiag('error', "Clipboard access denied. This requires HTTPS.");
            }
        });

        // ---- Paste / manual entry ----
        this.ui.btnSubmitPaste.addEventListener('click', async () => {
            if (!this.currentScanSuccessCallback) return;
            let text = this.ui.pasteInput.value.trim();
            if (!text) return;
            
            // Extract payload if they pasted a full URL
            const offerMatch = text.match(/[#&]p2p-offer=([^&]+)/);
            const answerMatch = text.match(/[#&]p2p-answer=([^&]+)/);
            if (offerMatch) text = offerMatch[1];
            else if (answerMatch) text = answerMatch[1];
            
            try {
                this.logDiag('info', 'Attempting to unpack pasted string...');
                const parsed = await ConnectionUtils.decodePayload(text);
                this.currentScanSuccessCallback(parsed);
                this.ui.pasteInput.value = '';
                if(this.html5Qrcode && this.html5Qrcode.isScanning) {
                    try { await this.html5Qrcode.stop(); this.html5Qrcode.clear(); } catch(e){}
                }
                this.ui.scannerContainer.style.display = 'none';
            } catch (e) {
                this.logDiag('error', `Paste parsing failed: ${e.message}`);
                this.logDiag('warn', 'If the data came from a device showing a different version in its header, reload the page on BOTH devices and try again.');
            }
        });
    }

    async displayQRCode(dataStr, instructions) {
        this.ui.scannerContainer.style.display = 'none';
        if(this.ui.qrPlaceholder) this.ui.qrPlaceholder.style.display = 'none';
        this.ui.qrContainer.style.display = 'block';
        this.ui.qrInstructions.textContent = instructions;
        
        this.logDiag('info', 'Packing SDP payload...');
        this.rawSDPPayload = await ConnectionUtils.encodePayload(dataStr);
        this.logDiag('success', `Payload packed to ${this.rawSDPPayload.length} chars`);

        try {
            this.ui.qrCanvas.innerHTML = '';
            new QRCode(this.ui.qrCanvas, {
                text: this.rawSDPPayload,
                width: 256,
                height: 256,
                // Packed payloads are tiny (~130-180 chars), so we can afford
                // medium error correction for far more forgiving scans.
                correctLevel: QRCode.CorrectLevel.M
            });
        } catch(e) {
            this.logDiag('error', `QR Canvas err: ${e.message}`);
        }
    }

    startScanner(onSuccess) {
        this.ui.qrContainer.style.display = 'none';
        if(this.ui.qrPlaceholder) this.ui.qrPlaceholder.style.display = 'none';
        this.ui.scannerContainer.style.display = 'block';
        this.currentScanSuccessCallback = onSuccess;
        
        if (this.html5Qrcode && this.html5Qrcode.isScanning) {
            try { 
                this.html5Qrcode.stop().then(() => {
                    try { this.html5Qrcode.clear(); } catch(_) {}
                }).catch(() => {});
            } catch(e){}
        }
        
        this.html5Qrcode = new Html5Qrcode("p2p-reader");
        
        let failureCount = 0;
        
        const config = {
            fps: 10,
            qrbox: { width: 250, height: 250 },
            aspectRatio: 1.0
        };

        const onScanSuccess = async (decodedText, decodedResult) => {
            if (this.html5Qrcode && this.html5Qrcode.isScanning) {
                try { 
                    await this.html5Qrcode.stop(); 
                    this.html5Qrcode.clear(); 
                } catch(e){}
            }
            this.ui.scannerContainer.style.display = 'none';
            this.logDiag('success', 'QR Code parameters identified! Extracting payload...');

            try {
                const data = await ConnectionUtils.decodePayload(decodedText);
                onSuccess(data);
            } catch (e) {
                this.logDiag('error', `Failed payload decode: ${e.message}`);
                this.logDiag('warn', 'If the other device shows a different version in its header, reload the page on BOTH devices and try again.');
                alert("Failed to decode connection data.\n\nMost common cause: the two devices are running different app versions. Reload the page on both devices (check the version number in the header matches), then retry.");
                this.cleanupUI();
                this.startScanner(onSuccess);
            }
        };

        const onScanFailure = (err) => {
            if(err && !err.includes("NotFoundException")) {
                failureCount++;
                if(failureCount % 5 === 0) {
                    this.logDiag('warn', `Scanner active, parsing frame... (Failed decoding x${failureCount})`);
                }
            }
        };

        this.html5Qrcode.start(
            { facingMode: "environment" },
            config,
            onScanSuccess,
            onScanFailure
        ).catch(err => {
            // Environment camera not found or failed (e.g. on laptops/desktops)
            this.logDiag('warn', `Environment camera failed: ${err}. Attempting default webcam fallback...`);
            return this.html5Qrcode.start(
                {}, // empty lets browser select default camera
                config,
                onScanSuccess,
                onScanFailure
            );
        }).catch(err => {
            this.logDiag('error', `Camera start failed: ${err}`);
            alert("Could not start camera. Ensure you have granted permissions and are using HTTPS.");
            this.cleanupUI();
        });
    }

    cleanupUI() {
        this.ui.qrContainer.style.display = 'none';
        this.ui.scannerContainer.style.display = 'none';
        if(this.ui.qrPlaceholder && this.ui.statusBadge.textContent !== 'CONNECTED') {
            this.ui.qrPlaceholder.style.display = 'block';
        }
        if(this.html5Qrcode && this.html5Qrcode.isScanning) { 
            try { 
                this.html5Qrcode.stop().then(() => {
                    try { this.html5Qrcode.clear(); } catch(_) {}
                }).catch(() => {});
            } catch(e){} 
        }
    }

    /**
     * Fully tears down the UI manager: closes BroadcastChannel, removes window
     * event listeners, stops any active QR scanner, and removes the DOM overlay.
     * After calling destroy(), this instance should not be reused.
     */
    destroy() {
        // Stop camera / scanner if active
        if (this.html5Qrcode && this.html5Qrcode.isScanning) {
            try { 
                this.html5Qrcode.stop().then(() => {
                    try { this.html5Qrcode.clear(); } catch(_) {}
                }).catch(() => {});
            } catch(_) {}
            this.html5Qrcode = null;
        }
        // Cancel any pending relay-ack timeout
        clearTimeout(this._relayAckTimer);
        // Close BroadcastChannel
        try { this.bc?.close(); } catch(_) {}
        // Remove window event listeners
        if (this._storageListener) {
            window.removeEventListener('storage', this._storageListener);
            this._storageListener = null;
        }
        if (this._messageListener) {
            window.removeEventListener('message', this._messageListener);
            this._messageListener = null;
        }
        // Remove injected DOM
        this.ui?.overlay?.remove();
    }
}
