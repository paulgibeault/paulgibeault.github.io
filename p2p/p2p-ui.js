import { ConnectionUtils } from './p2p-core.js';

// Shown in the modal header. Users are told to compare this across devices
// when a connection fails, so it must track the transport version
// (see README.md / PROTOCOL.md) — single constant, no other copies.
const UI_VERSION_LABEL = 'v1.11';

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
            this._setStage(1, 'done'); // their reply arrived (link path)
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
        this.ui.workArea.style.display = 'block';
        this.ui.qrContainer.style.display = 'block';
        if (this.ui.qrPlaceholder) this.ui.qrPlaceholder.style.display = 'none';
        this.ui.choice.style.display = 'none';
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
            ? ['Show your code', 'Scan theirs', 'Play!']
            : ['Scan their code', 'Show yours', 'Play!'];
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
        // The first non-done step is "where you are" — highlighted so users
        // always know what to do next.
        const activeIdx = this._stageStates.findIndex(s => s !== 'done');
        this.ui.stages.innerHTML = this._stageLabels.map((label, i) => {
            const state = this._stageStates[i];
            const isActive = i === activeIdx && state !== 'error';
            const icon = state === 'done' ? '✅' : (state === 'error' ? '❌' : `${i + 1}.`);
            const cls = `p2p-stage p2p-stage-${state}${isActive ? ' p2p-stage-active' : ''}`;
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
                this.ui.choice.style.display = 'none';
                this._initStages('joiner');
                this._setStage(0, 'done'); // their invite arrived (via link)

                // Consent gate: answering an offer starts ICE/STUN toward the
                // link author's endpoints and broadcasts our answer — enough
                // to reveal this device's public IP. A crafted link must not
                // trigger that silently just by being opened.
                if (!window.confirm(
                    'Accept this game invite and connect?\n\n' +
                    'Connecting shares your network address with the person who sent the link. ' +
                    'If you weren\'t expecting an invite, choose Cancel.')) {
                    this.logDiag('info', 'Invite declined by user. No connection attempted.');
                    this.hide();
                    return;
                }

                this.logDiag('info', 'Invite link received. Preparing your reply code...');
                const answerData = await this.peerNode.createAnswer(data);

                // QR-first even on the link path: show OUR code for them to
                // scan. Replying by link stays available as the fallback.
                await this.displayQRCode(answerData,
                    "One more step: have the host tap Scan their code and scan this. (Or send a reply link back in the same chat.)");
                this._setStage(1, 'done'); // your code is showing
                this.ui.btnShareSdp.textContent = 'Send a reply link back';

                // BONUS path: try all inter-tab channels silently in parallel
                const encoded = this.rawSDPPayload; // set by displayQRCode
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
                    this.ui.workArea.style.display = 'block';
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

    // ==========================================
    // CONNECTION-STATE RENDERING (single source of truth)
    // Badge text and the Host/Join buttons are derived from the peers map in
    // ONE place, so every entry point (restore, start-over, live status events)
    // agrees. The transport has one global role and one relay loop, so the
    // buttons must respect it: only a host can invite more players, and Join is
    // offered only when no link is live or stashed.
    // ==========================================

    /** Snapshot of the transport's connection inventory (transport owns it). */
    _connectionState() {
        return this.peerNode.statusSummary();
    }

    /** Update the status badge from the aggregate state (role-agnostic). */
    _renderBadge() {
        const s = this._connectionState();
        let text, cls;
        if (s.connected) { text = 'Connected'; cls = 'p2p-status-connected'; }
        else if (s.interrupted) { text = 'Reconnecting…'; cls = 'p2p-status-connecting'; }
        else if (s.finalizing) { text = 'Waiting for them to scan your code…'; cls = 'p2p-status-connecting'; }
        else if (s.pending) { text = 'Connecting…'; cls = 'p2p-status-connecting'; }
        else { text = 'Not connected'; cls = 'p2p-status-disconnected'; }
        this.ui.statusBadge.textContent = text;
        this.ui.statusBadge.className = cls;
    }

    /**
     * Show the Host/Join buttons consistent with the transport's role.
     * No established links → both (fresh start). Host node with links → Host
     * only (invite another player). Joiner with links → neither (a joiner is a
     * leaf of the star and cannot add players itself).
     */
    _renderChoiceButtons() {
        const s = this._connectionState();
        this.ui.choice.style.display = 'block';
        const guide = this.ui.choice.querySelector('.p2p-guide');
        if (!s.established) {
            this.ui.btnHost.style.display = 'block';
            this.ui.btnJoin.style.display = 'block';
            this.ui.btnHost.textContent = 'Host';
            if (guide) guide.textContent = "Scan each other's screens to connect.";
        } else if (s.isHost) {
            this.ui.btnHost.style.display = 'block';
            this.ui.btnHost.textContent = 'Invite another player';
            this.ui.btnJoin.style.display = 'none';
            if (guide) guide.textContent = 'Add another player, or close this to keep playing.';
        } else {
            // A joiner is a leaf of the star — it can't add players itself.
            this.ui.btnHost.style.display = 'none';
            this.ui.btnJoin.style.display = 'none';
            if (guide) guide.textContent = "You're connected. Only the host can add more players.";
        }
    }

    /**
     * Puts the modal into a coherent screen for the CURRENT connection state.
     * Called on every show() — closing the window mid-ceremony must never
     * strand the user in a dead-end (no buttons, stale step bar) on reopen.
     */
    _restoreUIState() {
        // Resume a still-valid pending ceremony FIRST — even while another link
        // is live (a host mid-"invite another") the QR on screen is real work.
        const pending = Array.from(this.peerNode.peers.values())
            .some(p => p.status !== 'connected' && p.status !== 'interrupted');
        if (pending && this.rawSDPPayload) {
            this.ui.choice.style.display = 'none';
            this.ui.workArea.style.display = 'block';
            this.ui.scannerContainer.style.display = 'none';
            this.ui.qrContainer.style.display = 'block';
            if (this.peerNode.isHost) this.ui.btnScanAns.style.display = 'block';
            this._renderBadge();
            return;
        }

        const s = this._connectionState();
        if (s.connected || s.interrupted) {
            this.cleanupUI();
            this._renderChoiceButtons();
            this._renderBadge();
            return;
        }

        this._startOver(false);
    }

    /** Abandon any unfinished attempt and return to the first screen. */
    _startOver(log = true) {
        this._ceremonyPeerId = null;
        this.peerNode.peers.forEach((p, id) => {
            // Abandon unfinished ceremonies only — an 'interrupted' peer is an
            // established session mid-repair, not a failed attempt. Route through
            // the transport so a terminal 'status' event reaches the bridge
            // (a direct peers.delete() would wedge the launcher's status).
            if (p.status !== 'connected' && p.status !== 'interrupted') {
                this.peerNode.disconnectPeer(id);
            }
        });
        this.rawSDPPayload = '';
        this._stageLabels = null;
        this._stageStates = null;
        this.cleanupUI();

        if (this.ui.stages) { this.ui.stages.style.display = 'none'; this.ui.stages.innerHTML = ''; }
        this.ui.qrInstructions.textContent = '';
        this.ui.btnScanAns.style.display = 'none';
        // Restore buttons a relay tab may have hidden
        this.ui.btnShareSdp.style.display = '';
        this.ui.btnCopySdp.style.display = '';

        this._renderChoiceButtons();
        this._renderBadge();

        if (log) this.logDiag('info', 'Starting over — previous attempt discarded.');
    }

    show(options = {}) {
        this._restoreUIState();
        this.ui.overlay.style.display = 'flex';
        if (options.mode === 'host') {
            // One-tap (re)connect entry: skip the choice screen and put a
            // FRESH invite code on screen immediately. Used by "Reconnect"
            // actions — WebRTC signaling is one-time-use by design (fresh ICE
            // credentials every session), so reconnecting means a fresh code,
            // just with zero navigation to reach it.
            this.startHostCeremony();
            return;
        }
        setTimeout(() => {
            const focusable = this.ui.overlay.querySelectorAll('button, input');
            const visible = Array.from(focusable).filter(el => ((el.offsetWidth > 0 || el.offsetHeight > 0) && el.style.display !== 'none'));
            if (visible.length) visible[0].focus();
        }, 50);
    }

    /**
     * Begins the inviter flow: create a fresh offer and show its QR/link.
     * Reused by the Host button and show({mode:'host'}). Each ceremony is a
     * fresh, standalone connection — it never touches existing peers.
     */
    async startHostCeremony() {
        this.logDiag('info', '--- INVITE SEQUENCE ---');
        this.ui.choice.style.display = 'none';
        this._initStages('host');

        try {
            const offerData = await this.peerNode.createOffer();
            // Remember which link THIS ceremony is minting so a status event from
            // an unrelated (already-live) peer can't close this modal on us.
            try { this._ceremonyPeerId = JSON.parse(offerData).peerId; } catch (_) { this._ceremonyPeerId = null; }
            this._setStage(0, 'done'); // your code is ready & showing

            // QR-first: the code IS the invite. Links are the fallback.
            await this.displayQRCode(offerData,
                "Have the other player tap Join and scan this code.");
            this.ui.btnScanAns.style.display = 'block';
            this.ui.btnShareSdp.textContent = 'Send a link instead';
        } catch (e) {
            this._setStage(0, 'error');
            // A role-flip guard rejection (hosting while joined) lands here — tell
            // the user why rather than silently failing.
            this.logDiag('error', e && e.message ? e.message : 'Could not create your invite code.');
            this.ui.statusBadge.textContent = e && e.message ? e.message : 'Could not create your invite code.';
            this.ui.statusBadge.className = 'p2p-status-disconnected';
        }
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
                    <h2 id="p2p-modal-title">Play Together <span style="font-size: 0.5em; color: #888; vertical-align: middle; font-weight: normal; margin-left: 10px;">${UI_VERSION_LABEL}</span></h2>
                    <button id="p2p-btn-close" class="p2p-btn-danger" style="border:none; border-radius:4px; padding:4px 8px; cursor:pointer;" aria-label="Close">X</button>
                </header>
                <div id="p2p-status-badge" class="p2p-status-disconnected">Not connected</div>
                <div id="p2p-stages" style="display:none; flex-wrap:wrap; align-items:center; gap:6px; font-size:12px; color:#aaa; margin:10px 0; padding:8px 10px; background:#181818; border-radius:8px;"></div>
                
                <div id="p2p-choice" class="p2p-panel" style="margin-bottom:15px;">
                    <p class="p2p-guide">Scan each other's screens to connect.</p>
                    <button id="p2p-btn-host" class="p2p-btn p2p-btn-primary p2p-btn-big">Host</button>
                    <button id="p2p-btn-join" class="p2p-btn p2p-btn-primary p2p-btn-big">Join</button>
                </div>

                <div id="p2p-work-area" class="p2p-panel" style="margin-bottom: 15px; display:none;">
                    <div id="p2p-qr-container" style="display:none; text-align:center;">
                        <p id="p2p-qr-instructions" class="p2p-guide"></p>
                        <div id="p2p-qr-canvas" class="p2p-qr-frame"></div>
                        <button id="p2p-btn-scan-ans" class="p2p-btn p2p-btn-primary p2p-btn-big" style="display:none; margin-top:14px;">Scan their code</button>
                        <div class="p2p-secondary-actions">
                            <button id="p2p-btn-share-sdp" class="p2p-btn p2p-text-btn" style="width:auto;">Send a link instead</button>
                            <button id="p2p-btn-copy-sdp" class="p2p-btn p2p-text-btn" style="width:auto;">Copy as text</button>
                            <button id="p2p-btn-restart" class="p2p-btn p2p-text-btn" style="width:auto;">Start over</button>
                        </div>
                        <div id="p2p-share-toast" style="display:none; margin-top:8px; color:#4ade80; font-size:13px;"></div>
                    </div>

                    <div id="p2p-scanner-container" style="display:none;">
                        <p id="p2p-scan-guide" class="p2p-guide">Point your camera at the code on the other player's screen.</p>
                        <div id="p2p-reader" aria-label="Camera view for scanning the other player's code" role="region"></div>
                        <details class="p2p-trouble" style="margin-top:10px;">
                            <summary style="cursor:pointer; color:#888; font-size:13px;">Having trouble scanning?</summary>
                            <div style="margin-top:8px; text-align:left; font-size:13px; color:#aaa;">
                                <p style="margin:4px 0;">• Turn up the other screen's brightness and hold steady about a hand's width away.</p>
                                <p style="margin:4px 0;">• If they sent you a link or a screenshot instead:</p>
                            </div>
                            <div class="p2p-paste-section">
                                <input type="text" id="p2p-paste-input" placeholder="Paste the link here...">
                                <button id="p2p-btn-submit-paste" class="p2p-btn p2p-btn-secondary" style="margin-bottom:0; width:auto;">Go</button>
                            </div>
                            <label class="p2p-btn p2p-btn-secondary" style="display:inline-block; margin-top:10px; width:auto; cursor:pointer;">
                                📁 Use a photo of their code
                                <input type="file" id="p2p-file-scan" accept="image/*" style="display:none;">
                            </label>
                        </details>
                        <button id="p2p-btn-cancel-scan" class="p2p-btn p2p-btn-danger" style="margin-top:10px;">← Back</button>
                    </div>

                    <div id="p2p-qr-placeholder" class="p2p-qr-placeholder" style="display:none;"></div>
                </div>

                <details class="p2p-advanced-settings" style="margin-bottom:15px; border: 1px solid #404040; border-radius: 8px; padding: 12px; background: #1f1f1f;">
                    <summary style="cursor:pointer; font-weight:600; font-size:13px; color:#aaa; user-select:none;">⚙️ Advanced settings (you can ignore this)</summary>
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

                <details class="p2p-panel" style="margin-top:4px;">
                    <summary style="cursor:pointer; font-weight:600; font-size:13px; color:#aaa; user-select:none;">🔧 Troubleshooting log
                        <button id="p2p-btn-copy-transcript" class="p2p-btn p2p-text-btn" style="float:right; width:auto; font-size:11px; padding:2px 8px; margin:0;">📋 Copy</button>
                    </summary>
                    <div id="p2p-diagnostics-out" class="p2p-diagnostics-box" role="log" aria-live="polite" style="margin-top:8px;">
                        <div class="p2p-diag-info">[SYSTEM] Engine initialized.</div>
                    </div>
                </details>
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
            btnCopyTranscript: document.getElementById('p2p-btn-copy-transcript'),
            choice: document.getElementById('p2p-choice'),
            scanGuide: document.getElementById('p2p-scan-guide'),
            workArea: document.getElementById('p2p-work-area'),
            btnRestart: document.getElementById('p2p-btn-restart')
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
        
        this._escListener = (e) => {
            if (e.key === 'Escape' && this.ui.overlay.style.display !== 'none') {
                this.hide();
            }
        };
        document.addEventListener('keydown', this._escListener);

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

            // Badge always reflects the aggregate — one link recovering while
            // another is mid-ceremony no longer shows the wrong state.
            this._renderBadge();

            // Only the ceremony's OWN link completing (or failing) should tear
            // down the ceremony UI. An unrelated live peer flapping
            // interrupted→connected must not destroy an on-screen invite QR.
            const isCeremonyPeer = this._ceremonyPeerId && peerId === this._ceremonyPeerId;
            if (!isCeremonyPeer) return;

            if (status === 'connected') {
                this._setStage(2, 'done');
                this._ceremonyPeerId = null;
                this.cleanupUI();
                this._renderChoiceButtons();
                this.ui.btnScanAns.style.display = 'none';
                setTimeout(() => this.hide(), 1600);
            } else if (status === 'failed' || status === 'disconnected') {
                // This ceremony's link died before completing — surface it on
                // the step tracker instead of a silent close.
                const step = this._stageStates ? this._stageStates.findIndex(st => st !== 'done') : -1;
                if (step >= 0) this._setStage(step, 'error');
                this.logDiag('error', 'This connection attempt failed — start over and rescan.');
                this._ceremonyPeerId = null;
            }
        });

        // ---- HOST: create offer ----
        // ---- INVITER: show code, then scan theirs ----
        this.ui.btnHost.addEventListener('click', () => this.startHostCeremony());

        // ---- INVITER step 2: scan the other player's return code ----
        this.ui.btnScanAns.addEventListener('click', () => {
            this.logDiag('info', 'Opening camera to scan their code...');
            this.ui.scanGuide.textContent =
                'Point your camera at the code now showing on THEIR screen.';
            this.startScanner(async (answerData) => {
                this.logDiag('info', 'Got it! Connecting...');
                this._setStage(1, 'done'); // scanned their code
                await this.peerNode.acceptAnswer(answerData);
            });
        });

        // ---- JOINER: scan their code, then show yours ----
        this.ui.btnJoin.addEventListener('click', () => {
            this.logDiag('info', '--- JOIN SEQUENCE ---');
            this.ui.choice.style.display = 'none';
            this._initStages('joiner');
            this.ui.scanGuide.textContent =
                'Point your camera at the code on the other player’s screen.';

            this.startScanner(async (offerData) => {
                this.logDiag('info', 'Code scanned! Preparing your reply code...');
                this._setStage(0, 'done'); // scanned their code
                try {
                    const answerData = await this.peerNode.createAnswer(offerData);
                    // The answer is keyed by the host's peerId — that's the link
                    // this join ceremony owns.
                    try { this._ceremonyPeerId = JSON.parse(answerData).peerId; } catch (_) { this._ceremonyPeerId = null; }

                    // Their turn to scan: show OUR code big and clear.
                    await this.displayQRCode(answerData,
                        "Now have the host tap Scan their code and scan this.");
                    this._setStage(1, 'done'); // your code is showing
                    this.ui.btnShareSdp.textContent = 'Send a reply link back';

                    // Bonus: same-browser auto-connect channels
                    const encoded = this.rawSDPPayload; // set by displayQRCode
                    const answerObj = JSON.parse(answerData);
                    this._attemptAutoReturn(answerObj, encoded);
                } catch (e) {
                    this._setStage(1, 'error');
                    this.logDiag('error', e && e.message ? e.message : 'Could not prepare your reply code.');
                }
            });
        });

        this.ui.btnCancelScan.addEventListener('click', () => {
            this.cleanupUI();

            const hasPendingOffer = this.peerNode.isHost &&
                Array.from(this.peerNode.peers.values()).some(p => p.status !== 'connected');

            if (hasPendingOffer) {
                // Inviter backing out of "scan theirs" — return to their own
                // code (still valid, still rendered) rather than the start.
                this.ui.workArea.style.display = 'block';
                this.ui.qrContainer.style.display = 'block';
                this.ui.btnScanAns.style.display = 'block';
                return;
            }

            // Otherwise abandon pending attempts and go back to the start.
            this._startOver(false);
        });

        // ---- Start over (escape hatch from any mid-ceremony screen) ----
        this.ui.btnRestart.addEventListener('click', () => this._startOver());

        // ---- Share / Copy buttons ----
        this.ui.btnShareSdp.addEventListener('click', async () => {
            const type = this.peerNode.isHost ? 'offer' : 'answer';
            const instructions = type === 'offer'
                ? 'Open this link to join my game! After joining, tap "Send reply link" and send it back to me here.'
                : 'Tap this link to complete the connection.';
            const shared = await this._shareOrCopy(this.rawSDPPayload, type, instructions);
            if (shared) {
                // A sent link fulfills the same step as a scanned code:
                // inviter step 1 (code delivered) / joiner step 2 (reply sent).
                this._setStage(this.peerNode.isHost ? 0 : 1, 'done');
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
        this.ui.workArea.style.display = 'block';
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
        this.ui.workArea.style.display = 'block';
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
        if (this.ui.workArea) this.ui.workArea.style.display = 'none';
        this.ui.qrContainer.style.display = 'none';
        this.ui.scannerContainer.style.display = 'none';
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
        if (this._escListener) {
            document.removeEventListener('keydown', this._escListener);
            this._escListener = null;
        }
        // Remove injected DOM
        this.ui?.overlay?.remove();
    }
}
