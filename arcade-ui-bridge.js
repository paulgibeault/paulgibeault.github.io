/* arcade-ui-bridge.js — the launcher-mediated UI chrome bridge (#35).
 *
 * Games run sandboxed WITHOUT allow-same-origin, and the sandbox no-ops
 * window.confirm/prompt inside the frame — so real modals, the topbar title,
 * quit interception, file-open, and share all have to be rendered/performed
 * by the LAUNCHER on a game's behalf. Games postMessage arcade:ui.op
 * requests; the SDK's generic RPC rail (arcade:bridge.result, shared with
 * the storage bridge) carries the answers back.
 *
 * Trust model, in order:
 *   - The launcher's single 'message' listener owns the frame-identity
 *     boundary and hands each already-authenticated message here as
 *     (gameId, data) — same contract as arcade-storage-bridge.js.
 *   - Shape rules live in arcade-envelope.js (validateUiOp): free text is
 *     length-clipped, openFile's accept is alphabet-gated (it lands in a DOM
 *     attribute), share URLs must parse as http(s).
 *   - Dialog spoofing: every game-initiated dialog is ATTRIBUTED (prefixed
 *     with the app's catalog name) and can never request the password-masked
 *     input the launcher's own passphrase prompts use — validateUiOp has no
 *     inputType field by construction.
 *   - Only the ACTIVE frame may pop dialogs (confirm/prompt/openFile/share).
 *     A background pooled frame gets the cancel answer (value:null) instead
 *     — same shape as the user dismissing, so games need no special path.
 *
 * initUiBridge(host) returns the dispatch handles the launcher's router
 * calls. `host` supplies launcher-owned glue (see index.html's uiHost):
 *   postToIframe(gameId, msg), dialog(opts) [the serialized focus-trap
 *   dialog], showToast(msg, opts), getGameName(gameId),
 *   getActiveGameId(), setGameTitle(gameId, title), validateUiOp.
 */

export function initUiBridge(host) {
    const postToIframe = host.postToIframe;
    const validateUiOp = host.validateUiOp;

    // Games that registered an Arcade.ui.onBeforeQuit handler. The quit
    // button only round-trips (arcade:ui.beforeQuit) for these — an app
    // without a hook quits instantly, and a crashed frame can never trap
    // the user (the round-trip itself is timeboxed launcher-side).
    const quitHooks = new Set();

    function bridgeReply(gameId, id, value) {
        // UI ops never fail; every outcome (including "not active" and
        // "user dismissed") is the cancel value on the ok path.
        postToIframe(gameId, {
            type: 'arcade:bridge.result', id: id, ok: true,
            value: value === undefined ? null : value
        });
    }

    function attributed(gameId, message) {
        const name = host.getGameName(gameId) || gameId;
        return '“' + name + '” asks:\n\n' + message;
    }

    function isActive(gameId) {
        return host.getActiveGameId() === gameId;
    }

    async function opConfirm(gameId, op) {
        if (!isActive(gameId)) return bridgeReply(gameId, op.id, null);
        const r = await host.dialog({
            message: attributed(gameId, op.message),
            okLabel: op.okLabel, cancelLabel: op.cancelLabel
        });
        bridgeReply(gameId, op.id, r === null ? null : true);
    }

    async function opPrompt(gameId, op) {
        if (!isActive(gameId)) return bridgeReply(gameId, op.id, null);
        const r = await host.dialog({
            message: attributed(gameId, op.message),
            input: true, inputValue: op.value
        });
        bridgeReply(gameId, op.id, typeof r === 'string' ? r : null);
    }

    async function opOpenFile(gameId, op) {
        if (!isActive(gameId)) return bridgeReply(gameId, op.id, null);
        const name = host.getGameName(gameId) || gameId;
        const consent = await host.dialog({
            message: '“' + name + '” wants to open a file from this device.',
            okLabel: 'Choose file…'
        });
        if (consent === null) return bridgeReply(gameId, op.id, null);
        // The dialog's OK click is the user gesture the file picker needs;
        // this runs in its microtask, well inside the transient window.
        const input = document.createElement('input');
        input.type = 'file';
        if (op.accept) input.accept = op.accept;
        input.style.display = 'none';
        document.body.appendChild(input);
        let done = false;
        const finish = (file) => {
            if (done) return;
            done = true;
            try { input.remove(); } catch (e) {}
            // File structured-clones through postMessage — the game gets a
            // real File (name/type/arrayBuffer) despite its opaque origin.
            bridgeReply(gameId, op.id, file || null);
        };
        input.addEventListener('change', () => finish(input.files && input.files[0]));
        // 'cancel' fires on picker dismiss in every browser this fleet
        // supports (Chrome 113+/FF/Safari 16.4+); without it the RPC would
        // dangle until the frame retires — annoying, not unsafe.
        input.addEventListener('cancel', () => finish(null));
        input.click();
    }

    async function opShare(gameId, op) {
        if (!isActive(gameId)) return bridgeReply(gameId, op.id, null);
        const name = host.getGameName(gameId) || gameId;
        const preview = [op.title, op.text, op.url].filter(Boolean).join('\n');
        const consent = await host.dialog({
            message: '“' + name + '” wants to share:\n\n' + preview,
            okLabel: 'Share'
        });
        if (consent === null) return bridgeReply(gameId, op.id, null);
        if (navigator.share) {
            try {
                const payload = {};
                if (op.title) payload.title = op.title;
                if (op.text) payload.text = op.text;
                if (op.url) payload.url = op.url;
                await navigator.share(payload);
                return bridgeReply(gameId, op.id, 'shared');
            } catch (e) {
                // AbortError = user closed the OS sheet — that's a cancel,
                // not a reason to surprise them with a clipboard write.
                if (e && e.name === 'AbortError') return bridgeReply(gameId, op.id, null);
                // Anything else (data unsupported, platform quirk) falls
                // through to the clipboard fallback below.
            }
        }
        try {
            await navigator.clipboard.writeText(preview);
            host.showToast('Copied to clipboard');
            bridgeReply(gameId, op.id, 'copied');
        } catch (e) {
            bridgeReply(gameId, op.id, null);
        }
    }

    function dispatch(gameId, data) {
        const op = validateUiOp(data);
        if (!op) return;
        switch (op.op) {
            case 'confirm': opConfirm(gameId, op); break;
            case 'prompt': opPrompt(gameId, op); break;
            case 'openFile': opOpenFile(gameId, op); break;
            case 'share': opShare(gameId, op); break;
            case 'setTitle': host.setGameTitle(gameId, op.title); break;
            case 'quitHook':
                if (op.enabled) quitHooks.add(gameId);
                else quitHooks.delete(gameId);
                break;
        }
    }

    return {
        uiOp: dispatch,
        hasQuitHook: (gameId) => quitHooks.has(gameId),
        // Called when a frame is evicted/reloaded — a fresh mount must
        // re-register its hook (and re-set its title) after the handshake.
        clearGame: (gameId) => { quitHooks.delete(gameId); }
    };
}
