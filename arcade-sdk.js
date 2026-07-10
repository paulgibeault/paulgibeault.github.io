/* Paul's Arcade SDK — window.Arcade  (protocol v2)
 *
 * Loaded by games at https://paulgibeault.github.io/arcade-sdk.js.
 * Same-origin with the launcher and every game; storage works without a bridge.
 * The launcher↔game bridge handles multiplayer, lifecycle hints, settings
 * broadcast, launcher-mediated UI (toasts), and post-import notifications.
 *
 * USAGE
 *   <script src="https://paulgibeault.github.io/arcade-sdk.js"></script>
 *   <script>
 *     Arcade.init({ gameId: 'pi-game' });
 *     await Arcade.ready;          // optional — settles after handshake
 *   </script>
 *
 * API
 *   Arcade.init({ gameId })        identity + handshake (sync)
 *   Arcade.ready                   Promise resolved on welcome / standalone
 *   Arcade.context                 { framed, version, gameId, suspended }
 *
 *   // Storage — sync, JSON-encoded under arcade.v1.<gameId>.<key>
 *   Arcade.state.get / set / remove
 *   Arcade.state.set(key, v, { exportable: false })  keep out of save files
 *   Arcade.state.getOrInit(key, defaults)         deep-merge load
 *   Arcade.state.migrate(version, fn)             run-once bootstrap
 *   Arcade.state.adopt(legacyKey, newKey?, opts?) one-line legacy-key move
 *   Arcade.state.onChange(key, fn)                storage events + replace
 *
 *   // Cross-game keys under arcade.v1.global.<key>
 *   Arcade.global.get / set / remove / onChange
 *
 *   // Sticky display name (lives in arcade.v1.global.playerName)
 *   Arcade.player.name() / setName(s) / onChange(fn)
 *
 *   // Lifecycle — launcher iframe pool when framed, page visibility
 *   // standalone; both sources are merged into one deduplicated stream.
 *   Arcade.onSuspend(fn) / onResume(fn) / onStateReplaced(fn)
 *   Arcade.context.suspended                      current effective state
 *   (<html data-arcade-suspended="true|false"> mirrors it for CSS/late code)
 *
 *   // Managed rAF loop — cancels on suspend, resumes if it was running,
 *   // suspended time never appears in a delta
 *   const loop = Arcade.loop((deltaMs, ts) => { ... });
 *   loop.start() / stop() / kick() / running() / dispose()
 *
 *   // Suspend-aware timers — freeze on suspend (remaining time preserved),
 *   // cancel on stateReplaced; both return { cancel() }
 *   Arcade.session.setTimeout(fn, ms) / Arcade.session.setInterval(fn, ms)
 *
 *   // Settings — pushed by launcher; SDK auto-applies CSS hooks
 *   Arcade.settings.fontScale | theme | reducedMotion | audioVolume | handedness
 *   Arcade.settings.snapshot()
 *   Arcade.onSettingsChange(fn)
 *
 *   // Multiplayer (no-ops standalone)
 *   Arcade.peer.status / onStatus / send / onMessage
 *   Arcade.peer.self() / remote()                 stable device identities
 *   Arcade.peer.onReady(fn)                       remote same-game listening
 *   Arcade.peer.sendBlob(blob, { onProgress }) / onBlob(fn)
 *   Arcade.peer.queue() / onQueue(fn)             replay-queue visibility
 *
 *   // Launcher-mediated UI
 *   Arcade.ui.toast(message, { kind, duration })
 *
 *   // Safe rendering — escape peer/user text before it reaches innerHTML
 *   Arcade.html.escape(str)                       → HTML-escaped string
 *   Arcade.html`<b>${userText}</b>`               auto-escapes interpolations
 *
 *   // Storage durability
 *   Arcade.state.set(key, value)                  → true | false (quota)
 *   Arcade.onStorageError(fn)                      fired when a write is dropped
 *   Arcade.storage.estimate() / persisted() / persist()
 *
 *   // Async per-app storage (large data — IndexedDB / OPFS; all Promises)
 *   const kv = Arcade.store.open('notes');        per-app KV store
 *   kv.set(k, v) / get(k) / del(k) / keys() / each(fn) / clear()
 *   Arcade.files.put(name, blob) / get(name) / list() / delete(name)
 *
 *   // Top-N leaderboard per category
 *   Arcade.scores.add(category, { score, name?, key?, meta? }, { order? })
 *                                  order: 'desc' (default) | 'asc' (times)
 *   Arcade.scores.list(category, { limit }?)
 *   Arcade.scores.best(category) / best(category, key)   keyed bests
 *   Arcade.scores.clear(category)
 *
 *   // Mutable per-category counter / blob
 *   Arcade.stats.get(category)
 *   Arcade.stats.getOrInit(category, defaults)    deep-merge load
 *   Arcade.stats.update(category, prev => next)
 *
 *   // Suspended-time-aware game timer
 *   const t = Arcade.session.start();             auto-pauses on onSuspend
 *   const t = Arcade.session.start({ persistKey: 'sessionElapsed' });
 *                                                 elapsed survives reloads
 *   t.elapsedMs() / t.pause() / t.resume() / t.reset() / t.stop()
 *
 * AUTO-APPLIED CSS HOOKS (set on <html> by the SDK):
 *     style="--font-scale: <n>; --motion-scale: 0|1; --audio-volume: 0..1"
 *     data-theme="light|dark"
 *     data-handedness="left|right"
 *
 * The injected base rule `:root { font-size: calc(100% * var(--font-scale, 1)); }`
 * means rem/em-sized text scales for free. Games that set their own
 * `:root { font-size }` win the cascade and can opt back in via the var.
 */
(function () {
    'use strict';

    var VERSION = 2;
    var HANDSHAKE_TIMEOUT_MS = 300;
    var MSG_PREFIX = 'arcade:';
    var KEY_PREFIX = 'arcade.v1.';
    var GAME_ID_RE = /^[a-z0-9_-]+$/i;
    var SCORES_CAP = 100;
    var SCORES_DEFAULT_LIMIT = 10;

    // ─── Module state ─────────────────────────────────────────────
    var gameId = null;
    var initialized = false;
    var framed = false;
    var parentOrigin = null;
    var handshakeTimer = null;

    var peerStatus = 'unavailable';
    // Launcher capability flags (welcome.caps) — additive feature detection
    // so a game never hard-depends on a launcher feature mid-rollout.
    // Empty when standalone or on an older launcher.
    var peerCaps = [];
    var settings = {
        fontScale: 1,
        theme: 'dark',
        reducedMotion: false,
        audioVolume: 1,
        handedness: 'right'
    };

    var listeners = {
        peerStatus: [],
        peersChange: [],
        peerMessage: [],
        peerReady: [],
        peerQueue: [],
        peerBlob: [],
        stateReplaced: [],
        settingsChange: [],
        suspend: [],
        resume: []
    };

    // Remote peer roster — seeded from the launcher's welcome, kept fresh by
    // arcade:peer.identity / arcade:peer.ready broadcasts.
    var remotePeers = {}; // deviceId -> { deviceId, name, at }
    function noteRemotePeer(deviceId, name) {
        if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 64) return null;
        var prev = remotePeers[deviceId];
        var rec = {
            deviceId: deviceId,
            name: (typeof name === 'string' && name) ? name.slice(0, 60)
                : (prev ? prev.name : 'Unnamed device'),
            at: Date.now()
        };
        remotePeers[deviceId] = rec;
        return rec;
    }
    // Per-peer roster (multi-peer API) — the launcher pushes the full list on
    // any join/leave/rename/status change; welcome.peers seeds it. Entries:
    // { deviceId, name, status: 'connected'|'interrupted'|'idle', direct }.
    var peerRoster = [];
    function applyRoster(arr) {
        if (!Array.isArray(arr)) return false;
        var next = [];
        for (var i = 0; i < arr.length; i++) {
            var p = arr[i];
            if (!p || typeof p !== 'object') continue;
            var rec = noteRemotePeer(p.deviceId, p.name); // validates deviceId, keeps remote() coherent
            if (!rec) continue;
            next.push({
                deviceId: rec.deviceId,
                name: rec.name,
                status: (p.status === 'interrupted' || p.status === 'idle') ? p.status : 'connected',
                direct: p.direct !== false
            });
        }
        peerRoster = next;
        return true;
    }
    function rosterCopy() {
        return peerRoster.map(function (p) {
            return { deviceId: p.deviceId, name: p.name, status: p.status, direct: p.direct };
        });
    }
    // Last-known transport replay-queue snapshot (pushed by the launcher —
    // meaningful during 'interrupted' episodes).
    var peerQueueSnapshot = { depth: 0, limit: 0, overflowed: false };
    var keyChangeListeners = new Map(); // fullKey -> [fn, fn, ...]

    var readyResolved = false;
    var readyResolve;
    var readyPromise = new Promise(function (r) { readyResolve = r; });

    // ─── Suspend state ────────────────────────────────────────────
    // Two independent suspend sources, OR'd into one effective state:
    //   - launcherSuspended: the launcher hid/evicted this iframe
    //     (arcade:lifecycle.* messages — framed only)
    //   - pageSuspended: this document itself is hidden (visibilitychange /
    //     pagehide — the only signal that exists standalone, and the one the
    //     launcher does NOT deliver for tab/window hide)
    // Games see a single deduplicated suspend/resume stream; the current
    // state is readable at any time via Arcade.context.suspended and the
    // data-arcade-suspended attribute on <html> (a hidden iframe's own
    // document.visibilityState stays 'visible', so code mounted mid-session
    // has no other way to know).
    var launcherSuspended = false;
    var pageSuspended = false;
    var suspendedNow = false;

    function applySuspendedToDOM() {
        try {
            document.documentElement.setAttribute(
                'data-arcade-suspended', suspendedNow ? 'true' : 'false');
        } catch (e) {}
    }
    function recomputeSuspended() {
        var next = launcherSuspended || pageSuspended;
        if (next === suspendedNow) return;
        suspendedNow = next;
        applySuspendedToDOM();
        fire(next ? listeners.suspend : listeners.resume);
    }
    function installPageLifecycle() {
        try {
            document.addEventListener('visibilitychange', function () {
                pageSuspended = document.visibilityState === 'hidden';
                recomputeSuspended();
            });
            window.addEventListener('pagehide', function () {
                pageSuspended = true;
                recomputeSuspended();
            });
            window.addEventListener('pageshow', function () {
                pageSuspended = document.visibilityState === 'hidden';
                recomputeSuspended();
            });
        } catch (e) {}
    }

    // ─── Helpers ──────────────────────────────────────────────────
    function inIframe() {
        try { return window.self !== window.top; } catch (e) { return true; }
    }
    function gameKey(key) { return KEY_PREFIX + gameId + '.' + key; }
    function globalKeyName(key) { return KEY_PREFIX + 'global.' + key; }
    function migratedSentinelKey(version) { return KEY_PREFIX + gameId + '._migrated.' + version; }

    function readJSON(k) {
        var raw;
        try { raw = localStorage.getItem(k); } catch (e) { return null; }
        if (raw === null) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }
    // Storage-error hook: a quota-denied (or otherwise failed) write fires these
    // so an app can warn the user instead of losing data silently. Declared
    // before writeJSON because writeJSON references it.
    var storageErrorListeners = [];
    function fireStorageError(key, err) {
        for (var i = 0; i < storageErrorListeners.length; i++) {
            // A listener throwing must not mask the underlying write failure.
            try { storageErrorListeners[i]({ key: key, error: err }); } catch (e) {}
        }
    }
    function writeJSON(k, v) {
        try {
            if (v === undefined) localStorage.removeItem(k);
            else localStorage.setItem(k, JSON.stringify(v));
            return true;
        } catch (e) { fireStorageError(k, e); return false; }
    }
    function removeKey(k) {
        try { localStorage.removeItem(k); } catch (e) {}
    }

    // HTML-escape helper + auto-escaping tagged template. Any peer- or
    // user-authored text interpolated into innerHTML must pass through one of
    // these: Arcade.html.escape(str), or Arcade.html`<b>${userText}</b>`.
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            switch (c) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                default:  return '&#39;';
            }
        });
    }
    function htmlTemplate(strings) {
        var out = String(strings[0]);
        for (var i = 1; i < arguments.length; i++) {
            out += escapeHtml(arguments[i]) + String(strings[i]);
        }
        return out;
    }
    htmlTemplate.escape = escapeHtml;

    function isPlainObject(o) {
        return o !== null && typeof o === 'object' && !Array.isArray(o);
    }
    // Merge helper hardened against prototype pollution: stored values come
    // from JSON.parse, which creates '__proto__' as an own enumerable key —
    // naive `out[k] = v` on that key fires the prototype setter. Own keys
    // only, dunder keys skipped.
    function isDunderKey(k) {
        return k === '__proto__' || k === 'constructor' || k === 'prototype';
    }
    function deepMerge(base, override) {
        if (!isPlainObject(base) || !isPlainObject(override)) return override;
        var out = {};
        var baseKeys = Object.keys(base);
        for (var i = 0; i < baseKeys.length; i++) {
            var k = baseKeys[i];
            if (isDunderKey(k)) continue;
            out[k] = base[k];
        }
        var overrideKeys = Object.keys(override);
        for (var j = 0; j < overrideKeys.length; j++) {
            var k2 = overrideKeys[j];
            if (isDunderKey(k2)) continue;
            var ov = override[k2], bv = base[k2];
            out[k2] = (isPlainObject(bv) && isPlainObject(ov)) ? deepMerge(bv, ov) : ov;
        }
        return out;
    }

    function fire(arr /*, ...args */) {
        var args = Array.prototype.slice.call(arguments, 1);
        for (var i = 0; i < arr.length; i++) {
            try { arr[i].apply(null, args); } catch (e) {}
        }
    }
    function fireKeyChange(fullKey, value) {
        var arr = keyChangeListeners.get(fullKey);
        if (!arr) return;
        for (var i = 0; i < arr.length; i++) {
            try { arr[i](value); } catch (e) {}
        }
    }
    function makeSubscriber(arr) {
        return function (fn) {
            if (typeof fn !== 'function') return function () {};
            arr.push(fn);
            return function () {
                var i = arr.indexOf(fn);
                if (i >= 0) arr.splice(i, 1);
            };
        };
    }
    function makeKeyChangeSubscriber(fullKey) {
        return function (fn) {
            if (typeof fn !== 'function') return function () {};
            var arr = keyChangeListeners.get(fullKey);
            if (!arr) { arr = []; keyChangeListeners.set(fullKey, arr); }
            arr.push(fn);
            return function () {
                var i = arr.indexOf(fn);
                if (i >= 0) arr.splice(i, 1);
            };
        };
    }
    function ensureGameId() {
        if (gameId === null) {
            throw new Error('Arcade: call Arcade.init({ gameId }) first');
        }
    }

    // ─── Settings ─────────────────────────────────────────────────
    function snapshotSettings() {
        return {
            fontScale: settings.fontScale,
            theme: settings.theme,
            reducedMotion: settings.reducedMotion,
            audioVolume: settings.audioVolume,
            handedness: settings.handedness
        };
    }
    function applySettings(incoming) {
        if (!incoming || typeof incoming !== 'object') return false;
        var changed = false;
        if (typeof incoming.fontScale === 'number' && isFinite(incoming.fontScale)
                && incoming.fontScale !== settings.fontScale) {
            settings.fontScale = incoming.fontScale; changed = true;
        }
        if ((incoming.theme === 'light' || incoming.theme === 'dark')
                && incoming.theme !== settings.theme) {
            settings.theme = incoming.theme; changed = true;
        }
        if (typeof incoming.reducedMotion === 'boolean'
                && incoming.reducedMotion !== settings.reducedMotion) {
            settings.reducedMotion = incoming.reducedMotion; changed = true;
        }
        if (typeof incoming.audioVolume === 'number' && isFinite(incoming.audioVolume)) {
            var v = Math.max(0, Math.min(1, incoming.audioVolume));
            if (v !== settings.audioVolume) { settings.audioVolume = v; changed = true; }
        }
        if ((incoming.handedness === 'left' || incoming.handedness === 'right')
                && incoming.handedness !== settings.handedness) {
            settings.handedness = incoming.handedness; changed = true;
        }
        applySettingsToDOM();
        return changed;
    }
    function applySettingsToDOM() {
        try {
            var d = document.documentElement;
            d.style.setProperty('--font-scale', settings.fontScale);
            d.style.setProperty('--motion-scale', settings.reducedMotion ? 0 : 1);
            d.style.setProperty('--audio-volume', settings.audioVolume);
            d.setAttribute('data-theme', settings.theme);
            d.setAttribute('data-handedness', settings.handedness);
            d.setAttribute('data-reduced-motion', settings.reducedMotion ? 'true' : 'false');
        } catch (e) {}
    }
    // Inject a default rem-scaling rule before any game CSS so games that don't
    // touch :root{font-size} scale for free. Inserted at the start of <head>
    // so a game's own rules naturally override.
    function injectBaseStyle() {
        try {
            if (document.getElementById('arcade-sdk-base-style')) return;
            var head = document.head || document.getElementsByTagName('head')[0];
            if (!head) return;
            var style = document.createElement('style');
            style.id = 'arcade-sdk-base-style';
            style.textContent =
                ':root{font-size:calc(100% * var(--font-scale, 1));' +
                '--motion-scale:1;--audio-volume:1;}\n' +
                // Reduced-motion kill switch: when the launcher (or OS)
                // requests reduced motion, CSS animations/transitions
                // collapse to a single instant frame — no per-game calc()
                // rewrites needed. A game that manages motion itself opts
                // out by setting data-arcade-keep-motion on <html>.
                ':root[data-reduced-motion="true"]:not([data-arcade-keep-motion]) *,' +
                ':root[data-reduced-motion="true"]:not([data-arcade-keep-motion]) *::before,' +
                ':root[data-reduced-motion="true"]:not([data-arcade-keep-motion]) *::after{' +
                'animation-duration:.001ms!important;' +
                'animation-iteration-count:1!important;' +
                'transition-duration:.001ms!important;' +
                'scroll-behavior:auto!important;}';
            head.insertBefore(style, head.firstChild);
        } catch (e) {}
    }
    // Pre-paint hydration: read latest known settings synchronously so first
    // paint is correct without waiting for the launcher's welcome message.
    // Mirrors fields the launcher writes to arcade.v1.global.*.
    function hydrateSettingsFromStorage() {
        var fs = readJSON(globalKeyName('fontScale'));
        if (typeof fs === 'number' && isFinite(fs)) settings.fontScale = fs;
        var th = readJSON(globalKeyName('theme'));
        if (th === 'light' || th === 'dark') settings.theme = th;
        var rm = readJSON(globalKeyName('reducedMotion'));
        if (typeof rm === 'boolean') settings.reducedMotion = rm;
        else {
            try {
                if (window.matchMedia &&
                    window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                    settings.reducedMotion = true;
                }
            } catch (e) {}
        }
        var av = readJSON(globalKeyName('audioVolume'));
        if (typeof av === 'number' && isFinite(av)) {
            settings.audioVolume = Math.max(0, Math.min(1, av));
        }
        var hd = readJSON(globalKeyName('handedness'));
        if (hd === 'left' || hd === 'right') settings.handedness = hd;
        applySettingsToDOM();
    }

    // ─── Dev-mode tracing ─────────────────────────────────────────
    // When arcade.v1._meta.dev === 'true' (set by ?dev=1 on either launcher
    // or game), every postMessage in/out is logged with console.debug. Safe
    // in production: the flag is opt-in and the cost is one localStorage
    // read per message.
    function devModeOn() {
        try { return localStorage.getItem('arcade.v1._meta.dev') === 'true'; }
        catch (e) { return false; }
    }
    function honorDevQueryParam() {
        try {
            var p = new URLSearchParams(window.location.search).get('dev');
            if (p === null) return;
            if (p === '0' || p === 'false') {
                localStorage.removeItem('arcade.v1._meta.dev');
            } else {
                localStorage.setItem('arcade.v1._meta.dev', 'true');
            }
        } catch (e) {}
    }

    // ─── Blob transfer (over Arcade.peer.send) ────────────────────
    // Large payloads ride the ordered/reliable data channel as a sequence of
    // base64 chunks wrapped in { __arcadeBlob: {...} } envelopes. Chunk
    // payloads are intercepted before onMessage listeners, so games only see
    // whole blobs via onBlob.
    var BLOB_CHUNK_BYTES = 48 * 1024;
    var BLOB_MAX_CHUNKS = 2048; // ~96 MB — reject anything claiming more
    var blobSendCounter = 0;
    var blobRx = {}; // id -> { chunks, received, total, mime, name }

    function bytesToBase64(bytes) {
        var bin = '';
        for (var i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    }
    function base64ToBytes(b64) {
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function handleBlobChunk(meta, fromPeer) {
        if (!meta || typeof meta.id !== 'string' || meta.id.length > 64) return;
        if (typeof meta.seq !== 'number' || typeof meta.total !== 'number') return;
        if (meta.total < 1 || meta.total > BLOB_MAX_CHUNKS
                || meta.seq < 0 || meta.seq >= meta.total || meta.seq !== Math.floor(meta.seq)) return;
        var st = blobRx[meta.id];
        if (!st) {
            st = blobRx[meta.id] = {
                chunks: new Array(meta.total),
                received: 0,
                total: meta.total,
                mime: typeof meta.mime === 'string' ? meta.mime.slice(0, 128) : '',
                name: typeof meta.name === 'string' ? meta.name.slice(0, 128) : ''
            };
        }
        if (st.total !== meta.total || st.chunks[meta.seq] !== undefined) return;
        var bytes;
        try { bytes = base64ToBytes(String(meta.bytes || '')); }
        catch (e) { delete blobRx[meta.id]; return; }
        st.chunks[meta.seq] = bytes;
        st.received++;
        if (st.received === st.total) {
            delete blobRx[meta.id];
            var blob;
            try { blob = new Blob(st.chunks, { type: st.mime }); } catch (e) { return; }
            fire(listeners.peerBlob, blob, {
                name: st.name, size: blob.size, mime: st.mime, fromPeer: fromPeer, id: meta.id
            });
        }
    }

    // ─── postMessage protocol ─────────────────────────────────────
    function postToParent(msg) {
        if (!framed) return;
        if (devModeOn()) console.debug('[Arcade ' + (gameId || '?') + ' →]', msg);
        try { window.parent.postMessage(msg, parentOrigin || window.location.origin); }
        catch (e) {}
    }
    function setPeerStatus(s) {
        if (s === peerStatus) return;
        peerStatus = s;
        fire(listeners.peerStatus, s);
    }
    function resolveReady() {
        if (readyResolved) return;
        readyResolved = true;
        readyResolve();
    }
    function onMessage(e) {
        if (e.source !== window.parent) return;
        if (e.origin !== window.location.origin) return;
        var data = e.data;
        if (!data || typeof data !== 'object') return;
        var t = data.type;
        if (typeof t !== 'string' || t.indexOf(MSG_PREFIX) !== 0) return;
        if (devModeOn()) console.debug('[Arcade ' + (gameId || '?') + ' ←]', data);

        switch (t) {
            case 'arcade:welcome':
                if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
                framed = true;
                parentOrigin = e.origin;
                setPeerStatus(typeof data.peerStatus === 'string' ? data.peerStatus : 'idle');
                if (Array.isArray(data.caps)) {
                    peerCaps = data.caps.filter(function (c) { return typeof c === 'string'; });
                }
                applyRoster(data.peers);
                if (applySettings(data.settings)) fire(listeners.settingsChange, snapshotSettings());
                resolveReady();
                break;
            case 'arcade:peer.message': {
                if (data.payload && typeof data.payload === 'object' && data.payload.__arcadeBlob) {
                    handleBlobChunk(data.payload.__arcadeBlob, data.fromPeer);
                    break;
                }
                // meta = { relayed, to }: relayed=true means the frame did
                // NOT come from this device's direct link partner (host
                // relay or host-bridge forward) — a cheap spoof check for
                // frames that claim host authority. to distinguishes
                // targeted ('me') from broadcast ('all') delivery. Old
                // launchers send no meta — defaults are the broadcast shape.
                var m = (data.meta && typeof data.meta === 'object') ? data.meta : {};
                fire(listeners.peerMessage, data.payload, data.fromPeer, {
                    relayed: m.relayed === true,
                    to: m.to === 'me' ? 'me' : 'all'
                });
                break;
            }
            case 'arcade:peer.status':
                if (typeof data.status === 'string') setPeerStatus(data.status);
                break;
            case 'arcade:peer.roster':
                if (applyRoster(data.peers)) fire(listeners.peersChange, rosterCopy());
                break;
            case 'arcade:peer.identity':
                noteRemotePeer(data.deviceId, data.name);
                break;
            case 'arcade:peer.ready': {
                var readyRec = noteRemotePeer(data.deviceId, data.name);
                fire(listeners.peerReady,
                    readyRec ? { deviceId: readyRec.deviceId, name: readyRec.name } : {});
                break;
            }
            case 'arcade:peer.queue':
                if (typeof data.depth === 'number' && data.depth >= 0) {
                    peerQueueSnapshot = {
                        depth: data.depth,
                        limit: typeof data.limit === 'number' ? data.limit : 0,
                        overflowed: data.overflowed === true
                    };
                    fire(listeners.peerQueue, peerApi.queue());
                }
                break;
            case 'arcade:state.replaced':
                fire(listeners.stateReplaced);
                // Replay key-change subscriptions — storage events also fire,
                // but a launcher-driven event is more reliable across browsers.
                keyChangeListeners.forEach(function (arr, k) {
                    var v = readJSON(k);
                    for (var i = 0; i < arr.length; i++) {
                        try { arr[i](v); } catch (err) {}
                    }
                });
                break;
            case 'arcade:settings.changed':
                if (applySettings(data.settings)) fire(listeners.settingsChange, snapshotSettings());
                break;
            case 'arcade:lifecycle.suspend':
                launcherSuspended = true;
                recomputeSuspended();
                break;
            case 'arcade:lifecycle.resume':
                launcherSuspended = false;
                recomputeSuspended();
                break;
        }
    }
    function onStorage(e) {
        if (!e.key) return;
        var arr = keyChangeListeners.get(e.key);
        if (!arr) return;
        var v = null;
        if (e.newValue !== null) {
            try { v = JSON.parse(e.newValue); } catch (err) { v = null; }
        }
        for (var i = 0; i < arr.length; i++) {
            try { arr[i](v); } catch (err) {}
        }
    }

    // ─── Service-worker collision check ───────────────────────────
    // Inspects the origin's shared CacheStorage for launcher-root assets
    // sitting in a NON-launcher cache — the definitive symptom of a game SW
    // caching files outside its own /<gameId>/ scope. (A workerStart-based
    // probe can't tell a scope-filtered pass-through from actual caching:
    // every request from a controlled page routes through the SW.)
    // The launcher's own cache names start with 'paul-arcade-'.
    var LAUNCHER_CACHE_PREFIX = 'paul-arcade-';
    var LAUNCHER_ROOT_ASSETS = ['/', '/index.html', '/arcade-sdk.js', '/arcade-p2p.js', '/styles.css'];
    function checkSWCollision() {
        try {
            if (typeof caches === 'undefined' || !caches.keys) return;
            caches.keys().then(function (names) {
                var offenders = [];
                var work = [];
                names.forEach(function (name) {
                    if (name.indexOf(LAUNCHER_CACHE_PREFIX) === 0) return;
                    work.push(caches.open(name).then(function (cache) {
                        return Promise.all(LAUNCHER_ROOT_ASSETS.map(function (path) {
                            return cache.match(path).then(function (hit) {
                                if (hit) offenders.push('"' + name + '" caches ' + path);
                            }, function () {});
                        }));
                    }, function () {}));
                });
                return Promise.all(work).then(function () {
                    if (!offenders.length) return;
                    var msg = '[Arcade SDK] A game service worker cached launcher-root assets: '
                        + offenders.join('; ')
                        + '. Scope your SW to /<gameId>/ and never cache the SDK or other '
                        + 'launcher files — see GAME_INTEGRATION.md §10.';
                    console.error(msg);
                    if (devModeOn()) {
                        showFallbackToast('SW scope violation — this game\'s service worker caches launcher files (see console)', 'error', 8000);
                    }
                });
            }).catch(function () {});
        } catch (e) {}
    }

    // ─── init ─────────────────────────────────────────────────────
    function init(opts) {
        if (initialized) return api;
        initialized = true;

        if (!opts || typeof opts.gameId !== 'string' || !GAME_ID_RE.test(opts.gameId)) {
            throw new Error('Arcade.init: opts.gameId must match /^[a-z0-9_-]+$/');
        }
        gameId = opts.gameId;

        honorDevQueryParam();
        injectBaseStyle();
        hydrateSettingsFromStorage();
        applySuspendedToDOM();
        installPageLifecycle();
        try { window.addEventListener('storage', onStorage); } catch (e) {}
        // Keep the cached settings + DOM hooks in sync when global keys change
        // in another iframe (same-origin storage events fire automatically).
        var SETTING_KEYS = ['fontScale', 'theme', 'reducedMotion', 'audioVolume', 'handedness'];
        SETTING_KEYS.forEach(function (k) {
            makeKeyChangeSubscriber(globalKeyName(k))(function (v) {
                var patch = {}; patch[k] = v;
                if (applySettings(patch)) fire(listeners.settingsChange, snapshotSettings());
            });
        });
        checkSWCollision();

        if (!inIframe()) {
            framed = false;
            peerStatus = 'unavailable';
            resolveReady();
            return api;
        }

        try { window.addEventListener('message', onMessage); } catch (e) {}
        try {
            window.parent.postMessage(
                { type: 'arcade:hello', gameId: gameId, version: VERSION },
                window.location.origin
            );
        } catch (e) {}

        handshakeTimer = setTimeout(function () {
            handshakeTimer = null;
            // No welcome — assume standalone-in-iframe and unblock callers.
            framed = false;
            peerStatus = 'unavailable';
            resolveReady();
        }, HANDSHAKE_TIMEOUT_MS);

        return api;
    }

    // ─── State (per-game) ─────────────────────────────────────────
    // Save-export governance: keys written with { exportable: false } are
    // listed (by full localStorage key) in arcade.v1.<gameId>._noExport; the
    // launcher's export skips them. For bulky local-only data (telemetry,
    // caches) that should never inflate every save file.
    function noExportListKey() { return gameKey('_noExport'); }
    function setKeyExportable(fullKey, exportable) {
        var list = readJSON(noExportListKey());
        if (!Array.isArray(list)) list = [];
        var i = list.indexOf(fullKey);
        if (!exportable && i === -1) {
            list.push(fullKey);
            writeJSON(noExportListKey(), list);
        } else if (exportable && i !== -1) {
            list.splice(i, 1);
            writeJSON(noExportListKey(), list.length ? list : undefined);
        }
    }
    var stateApi = {
        get: function (key) { ensureGameId(); return readJSON(gameKey(key)); },
        // opts.exportable (boolean, sticky): false excludes this key from
        // launcher save files until a later set passes { exportable: true }.
        set: function (key, value, opts) {
            ensureGameId();
            var k = gameKey(key);
            var ok = writeJSON(k, value);
            if (ok) {
                if (opts && typeof opts.exportable === 'boolean') {
                    setKeyExportable(k, opts.exportable);
                }
                fireKeyChange(k, value);
            }
            return ok; // false on quota failure (Arcade.onStorageError also fires)
        },
        remove: function (key) {
            ensureGameId();
            var k = gameKey(key);
            removeKey(k);
            setKeyExportable(k, true); // drop any stale no-export entry
            fireKeyChange(k, null);
        },
        // Read with defaults. If nothing is stored, write defaults. If a value
        // is stored and both are plain objects, deep-merge defaults under the
        // stored value (so newly-added fields get their defaults). Otherwise
        // return the stored value as-is.
        getOrInit: function (key, defaults) {
            ensureGameId();
            var k = gameKey(key);
            var current = readJSON(k);
            if (current === null) {
                writeJSON(k, defaults);
                return defaults;
            }
            if (isPlainObject(defaults) && isPlainObject(current)) {
                var merged = deepMerge(defaults, current);
                return merged;
            }
            return current;
        },
        // Run `fn` exactly once per (gameId, version). Sentinel persists in
        // localStorage so subsequent loads skip. Use for one-shot data shape
        // changes — copy legacy keys into namespaced keys, etc.
        migrate: function (version, fn) {
            ensureGameId();
            if (typeof version !== 'string' || !version) {
                throw new Error('Arcade.state.migrate: version must be a non-empty string');
            }
            if (typeof fn !== 'function') {
                throw new Error('Arcade.state.migrate: fn must be a function');
            }
            var sentinel = migratedSentinelKey(version);
            if (readJSON(sentinel) === true) return false;
            try { fn(); }
            catch (e) {
                console.error('[Arcade SDK] migration "' + version + '" threw:', e);
                return false;
            }
            writeJSON(sentinel, true);
            return true;
        },
        // Adopt a legacy (non-namespaced) localStorage key into the game's
        // namespace: read → namespaced write → delete original. Error-safe:
        // the original is only deleted after a successful write, and an
        // existing namespaced value is never clobbered (the legacy key is
        // just cleaned up). With { json: false } the raw string is stored
        // as a string value instead of being JSON.parsed first.
        // Returns true if a legacy value was found and handled.
        adopt: function (legacyKey, newKey, opts) {
            ensureGameId();
            if (typeof legacyKey !== 'string' || !legacyKey) {
                throw new Error('Arcade.state.adopt: legacyKey must be a non-empty string');
            }
            var targetKey = (typeof newKey === 'string' && newKey) ? newKey : legacyKey;
            var raw;
            try { raw = localStorage.getItem(legacyKey); } catch (e) { return false; }
            if (raw === null) return false;
            var k = gameKey(targetKey);
            var existing;
            try { existing = localStorage.getItem(k); } catch (e) { existing = null; }
            if (existing === null) {
                var value = raw;
                if (!opts || opts.json !== false) {
                    try { value = JSON.parse(raw); } catch (e) { /* keep raw string */ }
                }
                if (!writeJSON(k, value)) return false; // quota — keep the original
                fireKeyChange(k, value);
            }
            removeKey(legacyKey);
            return true;
        },
        onChange: function (key, fn) {
            ensureGameId();
            return makeKeyChangeSubscriber(gameKey(key))(fn);
        }
    };

    // ─── Global (cross-game) ──────────────────────────────────────
    var globalApi = {
        get: function (key) { return readJSON(globalKeyName(key)); },
        set: function (key, value) {
            var k = globalKeyName(key);
            var ok = writeJSON(k, value);
            if (ok) fireKeyChange(k, value);
            return ok;
        },
        remove: function (key) {
            var k = globalKeyName(key);
            removeKey(k);
            fireKeyChange(k, null);
        },
        onChange: function (key, fn) {
            return makeKeyChangeSubscriber(globalKeyName(key))(fn);
        }
    };

    // ─── Player ───────────────────────────────────────────────────
    var playerApi = {
        name: function () {
            var n = readJSON(globalKeyName('playerName'));
            return typeof n === 'string' ? n : '';
        },
        setName: function (name) {
            if (typeof name !== 'string') return;
            globalApi.set('playerName', name.trim().slice(0, 32));
        },
        onChange: function (fn) { return globalApi.onChange('playerName', fn); }
    };

    // ─── Settings ─────────────────────────────────────────────────
    var settingsApi = {
        fontScale: function () { return settings.fontScale; },
        theme: function () { return settings.theme; },
        reducedMotion: function () { return settings.reducedMotion; },
        audioVolume: function () { return settings.audioVolume; },
        handedness: function () { return settings.handedness; },
        snapshot: snapshotSettings
    };

    // ─── Peer ─────────────────────────────────────────────────────
    var peerApi = {
        status: function () { return peerStatus; },
        onStatus: makeSubscriber(listeners.peerStatus),
        caps: function () { return Object.freeze(peerCaps.slice()); },
        send: function (payload, opts) {
            // 'interrupted' = live session being repaired by the transport —
            // sends are queued and replayed on recovery (exactly-once), so
            // games can keep playing straight through a connection blip.
            if (!framed || (peerStatus !== 'connected' && peerStatus !== 'interrupted')) return false;
            var to = opts && opts.to;
            if (to !== undefined) {
                // Targeted send — routing, not secrecy: joiner→joiner frames
                // transit the host bridge readable. What it guarantees is
                // that a non-addressee joiner never RECEIVES the frame.
                // Refuse rather than broadcast when the launcher can't
                // target (missing cap) or the payload names a bad target —
                // a private frame must never silently fan out.
                if (typeof to !== 'string' || !to) return false;
                if (peerCaps.indexOf('peer.sendTo') === -1) return false;
                postToParent({ type: 'arcade:peer.send', payload: payload, to: to });
                return true;
            }
            postToParent({ type: 'arcade:peer.send', payload: payload });
            return true;
        },
        onMessage: makeSubscriber(listeners.peerMessage),

        // This device's stable identity — the same deviceId the launcher
        // uses for known peers / auto-reconnect. null until the launcher's
        // P2P layer has generated one (i.e. before the first ever pairing).
        self: function () {
            try {
                var id = localStorage.getItem(KEY_PREFIX + '_meta.deviceId');
                if (!id) return null;
                var name = localStorage.getItem(KEY_PREFIX + '_meta.deviceName');
                return { deviceId: id, name: name || 'My device' };
            } catch (e) { return null; }
        },
        // Most recently seen remote device ({ deviceId, name }) or null.
        // Single-peer convenience — multi-peer games should use peers().
        remote: function () {
            var best = null;
            for (var k in remotePeers) {
                if (!best || remotePeers[k].at > best.at) best = remotePeers[k];
            }
            return best ? { deviceId: best.deviceId, name: best.name } : null;
        },
        // Full peer roster: [{ deviceId, name, status, direct }], [] when no
        // session (or on a launcher without the 'peer.roster' cap). status is
        // 'connected' | 'interrupted' | 'idle'; direct is true when this
        // device holds the direct link (for a joiner: exactly the host).
        peers: function () { return rosterCopy(); },
        // Fires with the full roster array on any join/leave/rename/status
        // change — one coarse event, not fine-grained add/remove.
        onPeersChange: makeSubscriber(listeners.peersChange),
        // Fires when the remote device has THIS game mounted and listening —
        // fn({ deviceId, name }). May fire more than once per session (both
        // sides announce); treat it as an idempotent "peer is ready" signal.
        // Replaces the hand-rolled hello/echo handshake games used to need.
        onReady: makeSubscriber(listeners.peerReady),

        // Send a Blob/File to the peer, chunked over the ordered channel.
        // Resolves { id, chunks, size } after the last chunk is handed to
        // the transport; opts.onProgress(fraction, sent, total) per chunk.
        sendBlob: function (blob, opts) {
            if (!blob || typeof blob.arrayBuffer !== 'function') {
                return Promise.reject(new Error('Arcade.peer.sendBlob: pass a Blob or File'));
            }
            var onProgress = (opts && typeof opts.onProgress === 'function') ? opts.onProgress : null;
            var name = (opts && typeof opts.name === 'string' && opts.name) ? opts.name
                : (typeof blob.name === 'string' ? blob.name : '');
            return blob.arrayBuffer().then(function (buf) {
                var bytes = new Uint8Array(buf);
                var total = Math.max(1, Math.ceil(bytes.length / BLOB_CHUNK_BYTES));
                if (total > BLOB_MAX_CHUNKS) {
                    throw new Error('Arcade.peer.sendBlob: blob too large ('
                        + bytes.length + ' bytes; max ' + (BLOB_MAX_CHUNKS * BLOB_CHUNK_BYTES) + ')');
                }
                var id = 'b' + (++blobSendCounter) + '-' + Date.now().toString(36);
                for (var seq = 0; seq < total; seq++) {
                    var chunk = bytes.subarray(seq * BLOB_CHUNK_BYTES, (seq + 1) * BLOB_CHUNK_BYTES);
                    var ok = peerApi.send({
                        __arcadeBlob: {
                            id: id, seq: seq, total: total, size: bytes.length,
                            mime: blob.type || '', name: name.slice(0, 128),
                            bytes: bytesToBase64(chunk)
                        }
                    });
                    if (!ok) throw new Error('Arcade.peer.sendBlob: no live connection');
                    if (onProgress) {
                        try { onProgress((seq + 1) / total, seq + 1, total); } catch (e) {}
                    }
                }
                return { id: id, chunks: total, size: bytes.length };
            });
        },
        // fn(blob, { name, size, mime, fromPeer, id }) once a full blob has
        // been reassembled.
        onBlob: makeSubscriber(listeners.peerBlob),

        // Transport replay-queue visibility: { depth, limit, overflowed }.
        // depth grows while 'interrupted' (sends queue for replay); when
        // overflowed is true the oldest unacknowledged messages were dropped
        // and the game should resync authoritative state after recovery.
        queue: function () {
            return {
                depth: peerQueueSnapshot.depth,
                limit: peerQueueSnapshot.limit,
                overflowed: peerQueueSnapshot.overflowed
            };
        },
        onQueue: makeSubscriber(listeners.peerQueue)
    };

    // ─── UI ───────────────────────────────────────────────────────
    function showFallbackToast(message, kind, duration) {
        try {
            var el = document.createElement('div');
            el.textContent = message;
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            var border = kind === 'error' ? '#c45050'
                       : kind === 'warning' ? '#d4a843'
                       : kind === 'success' ? '#5cb85c'
                       : '#5577aa';
            el.style.cssText =
                'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);' +
                'padding:10px 18px;border-radius:8px;font:14px system-ui,sans-serif;' +
                'background:rgba(20,20,28,0.95);color:#fff;z-index:99999;' +
                'box-shadow:0 4px 12px rgba(0,0,0,0.3);' +
                'border:1px solid ' + border + ';' +
                'opacity:0;transition:opacity 200ms;pointer-events:none;';
            document.body.appendChild(el);
            requestAnimationFrame(function () { el.style.opacity = '1'; });
            setTimeout(function () {
                el.style.opacity = '0';
                setTimeout(function () { try { el.remove(); } catch (e) {} }, 220);
            }, duration);
        } catch (e) {}
    }
    var KIND_SET = { info: 1, success: 1, warning: 1, error: 1 };
    var uiApi = {
        toast: function (message, opts) {
            if (typeof message !== 'string' || !message) return;
            opts = opts || {};
            var kind = KIND_SET[opts.kind] ? opts.kind : 'info';
            var duration = (typeof opts.duration === 'number' && opts.duration > 0)
                ? opts.duration : 2500;
            if (framed) {
                postToParent({
                    type: 'arcade:ui.toast',
                    message: message, kind: kind, duration: duration
                });
            } else {
                showFallbackToast(message, kind, duration);
            }
        }
    };

    // ─── Scores (per category) ────────────────────────────────────
    function scoresKey(category) { return gameKey('scores.' + category); }
    var scoresApi = {
        // opts.order: 'desc' (default — higher is better) or 'asc' (lower is
        // better: times, move counts). Pass the same order on every add for a
        // category; the whole list is re-sorted with the order given here.
        // entry.key (optional string): a label for keyed bests — e.g. a board
        // code — queried via scores.best(category, key).
        add: function (category, entry, opts) {
            ensureGameId();
            if (typeof category !== 'string' || !category) {
                throw new Error('Arcade.scores.add: category required');
            }
            if (!entry || typeof entry !== 'object'
                    || typeof entry.score !== 'number' || !isFinite(entry.score)) {
                throw new Error('Arcade.scores.add: entry.score must be a finite number');
            }
            var order = (opts && opts.order === 'asc') ? 'asc' : 'desc';
            var record = {
                score: entry.score,
                ts: typeof entry.ts === 'number' ? entry.ts : Date.now()
            };
            if (typeof entry.name === 'string' && entry.name) {
                record.name = entry.name.slice(0, 32);
            } else {
                var pn = playerApi.name();
                if (pn) record.name = pn;
            }
            if (typeof entry.key === 'string' && entry.key) {
                record.key = entry.key.slice(0, 64);
            }
            if (entry.meta && typeof entry.meta === 'object') {
                record.meta = entry.meta;
            }
            var k = scoresKey(category);
            var list = readJSON(k);
            if (!Array.isArray(list)) list = [];
            list.push(record);
            list.sort(function (a, b) {
                return order === 'asc' ? a.score - b.score : b.score - a.score;
            });
            if (list.length > SCORES_CAP) list.length = SCORES_CAP;
            writeJSON(k, list);
            fireKeyChange(k, list);
            return record;
        },
        list: function (category, opts) {
            ensureGameId();
            var k = scoresKey(category);
            var list = readJSON(k);
            if (!Array.isArray(list)) return [];
            var limit = (opts && typeof opts.limit === 'number') ? opts.limit : SCORES_DEFAULT_LIMIT;
            return list.slice(0, Math.max(0, limit));
        },
        // best(category) → top entry. best(category, key) → best entry whose
        // record.key matches (the list is stored best-first, so the first
        // match wins under either sort order).
        best: function (category, key) {
            if (key === undefined) {
                var l = scoresApi.list(category, { limit: 1 });
                return l.length ? l[0] : null;
            }
            ensureGameId();
            var list = readJSON(scoresKey(category));
            if (!Array.isArray(list)) return null;
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].key === key) return list[i];
            }
            return null;
        },
        clear: function (category) {
            ensureGameId();
            var k = scoresKey(category);
            removeKey(k);
            fireKeyChange(k, null);
        }
    };

    // ─── Stats (per category) ─────────────────────────────────────
    function statsKey(category) { return gameKey('stats.' + category); }
    var statsApi = {
        get: function (category) {
            ensureGameId();
            var v = readJSON(statsKey(category));
            return isPlainObject(v) ? v : {};
        },
        // Read with defaults — mirrors Arcade.state.getOrInit. If nothing is
        // stored, write defaults. If a value is stored and both are plain
        // objects, deep-merge defaults under the stored value (so newly-added
        // stat fields get their defaults). Otherwise return stored as-is.
        getOrInit: function (category, defaults) {
            ensureGameId();
            var k = statsKey(category);
            var current = readJSON(k);
            if (current === null) {
                writeJSON(k, defaults);
                return defaults;
            }
            if (isPlainObject(defaults) && isPlainObject(current)) {
                return deepMerge(defaults, current);
            }
            return current;
        },
        update: function (category, updater) {
            ensureGameId();
            if (typeof updater !== 'function') {
                throw new Error('Arcade.stats.update: updater must be a function');
            }
            var k = statsKey(category);
            var prev = readJSON(k);
            if (!isPlainObject(prev)) prev = {};
            var next;
            try { next = updater(prev); }
            catch (e) { console.error('[Arcade SDK] stats updater threw:', e); return prev; }
            if (!isPlainObject(next)) next = prev;
            writeJSON(k, next);
            fireKeyChange(k, next);
            return next;
        }
    };

    // ─── Session timer ────────────────────────────────────────────
    // Wall-time tracker that auto-pauses while the game is suspended (iframe
    // hidden). Each `start()` returns an independent tracker — multiple
    // concurrent timers (round + total session, etc.) are fine.
    //
    // Optional `persistKey` (string): when set, the tracker reads its initial
    // elapsed from Arcade.state[persistKey] on start, writes elapsedMs() back
    // on suspend / reset / stop, and on stateReplaced re-reads the freshly
    // imported value as the new baseline (instead of resetting to 0). Stored
    // as a JSON number under arcade.v1.<gameId>.<persistKey>.
    //
    // With no persistKey, stateReplaced resets the tracker to 0 and the game
    // owns hydration.
    function createSessionTimer(opts) {
        var persistKey = (opts && typeof opts.persistKey === 'string' && opts.persistKey)
            ? opts.persistKey : null;
        function now() {
            return (typeof performance !== 'undefined' && performance.now)
                ? performance.now() : Date.now();
        }
        var startedAt = now();
        var baseOffset = 0;
        if (persistKey) {
            var stored = stateApi.get(persistKey);
            if (typeof stored === 'number' && stored >= 0) baseOffset = stored;
        }
        var accumPaused = 0;          // total ms spent paused, subtracted from elapsed
        var pauseStartedAt = null;    // non-null iff currently in a paused interval
        var manualPaused = false;
        var lifecyclePaused = false;
        var stopped = false;

        function isPaused() { return manualPaused || lifecyclePaused; }
        function freezePause() {
            if (pauseStartedAt === null) pauseStartedAt = now();
        }
        function unfreezePause() {
            if (pauseStartedAt !== null) {
                accumPaused += now() - pauseStartedAt;
                pauseStartedAt = null;
            }
        }

        function onSuspendHandler() {
            if (stopped) return;
            if (!isPaused()) freezePause();
            lifecyclePaused = true;
            if (persistKey) stateApi.set(persistKey, tracker.elapsedMs());
        }
        function onResumeHandler() {
            if (stopped) return;
            lifecyclePaused = false;
            if (!isPaused()) unfreezePause();
        }

        var unsubSuspend = makeSubscriber(listeners.suspend)(onSuspendHandler);
        var unsubResume = makeSubscriber(listeners.resume)(onResumeHandler);
        var unsubReplaced = makeSubscriber(listeners.stateReplaced)(function () {
            if (stopped) return;
            if (persistKey) {
                var s = stateApi.get(persistKey);
                baseOffset = (typeof s === 'number' && s >= 0) ? s : 0;
                startedAt = now();
                accumPaused = 0;
                pauseStartedAt = isPaused() ? startedAt : null;
            } else {
                tracker.reset();
            }
        });

        var tracker = {
            elapsedMs: function () {
                var paused = accumPaused;
                if (pauseStartedAt !== null) paused += now() - pauseStartedAt;
                var ms = baseOffset + (now() - startedAt - paused);
                return ms < 0 ? 0 : ms;
            },
            pause: function () {
                if (stopped || manualPaused) return;
                if (!isPaused()) freezePause();
                manualPaused = true;
            },
            resume: function () {
                if (stopped || !manualPaused) return;
                manualPaused = false;
                if (!isPaused()) unfreezePause();
            },
            // Reset elapsed to 0. If the timer is currently paused (manual or
            // lifecycle), it stays paused — elapsed will stay at 0 until resume.
            reset: function () {
                if (stopped) return;
                startedAt = now();
                accumPaused = 0;
                baseOffset = 0;
                pauseStartedAt = isPaused() ? startedAt : null;
                if (persistKey) stateApi.set(persistKey, 0);
            },
            stop: function () {
                if (stopped) return;
                if (persistKey) stateApi.set(persistKey, tracker.elapsedMs());
                stopped = true;
                unsubSuspend();
                unsubResume();
                unsubReplaced();
            }
        };
        return tracker;
    }
    // ─── Suspend-aware scheduling ─────────────────────────────────
    // setTimeout/setInterval variants that freeze while the game is
    // suspended (remaining time is preserved and re-armed on resume) and
    // cancel themselves when the launcher imports a save (stateReplaced) —
    // a callback armed against pre-import state must not fire against
    // post-import state.
    function nowMs() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
    }
    function createManagedTimer(fn, ms, repeat) {
        if (typeof fn !== 'function') {
            throw new Error('Arcade.session.' + (repeat ? 'setInterval' : 'setTimeout') + ': fn must be a function');
        }
        var interval = Math.max(0, Number(ms) || 0);
        var remaining = interval;
        var id = null;
        var armedAt = null;
        var done = false;

        function arm() {
            armedAt = nowMs();
            id = setTimeout(fireIt, remaining);
        }
        function disarm() {
            if (id === null) return;
            clearTimeout(id);
            id = null;
            remaining = Math.max(0, remaining - (nowMs() - armedAt));
        }
        function fireIt() {
            id = null;
            if (repeat) {
                remaining = interval;
                try { fn(); } catch (e) {}
                if (!done && !suspendedNow) arm();
            } else {
                done = true;
                detach();
                try { fn(); } catch (e) {}
            }
        }
        function detach() {
            unsubSuspend();
            unsubResume();
            unsubReplaced();
        }
        var unsubSuspend = makeSubscriber(listeners.suspend)(function () {
            if (!done) disarm();
        });
        var unsubResume = makeSubscriber(listeners.resume)(function () {
            if (!done && id === null) arm();
        });
        var unsubReplaced = makeSubscriber(listeners.stateReplaced)(function () {
            if (done) return;
            done = true;
            if (id !== null) { clearTimeout(id); id = null; }
            detach();
        });

        if (!suspendedNow) arm(); // created while suspended → starts frozen

        return {
            cancel: function () {
                if (done) return;
                done = true;
                if (id !== null) { clearTimeout(id); id = null; }
                detach();
            }
        };
    }

    var sessionApi = {
        start: function (options) {
            ensureGameId();
            return createSessionTimer(options);
        },
        setTimeout: function (fn, ms) {
            ensureGameId();
            return createManagedTimer(fn, ms, false);
        },
        setInterval: function (fn, ms) {
            ensureGameId();
            return createManagedTimer(fn, ms, true);
        }
    };

    // ─── Managed rAF loop ─────────────────────────────────────────
    // Every canvas game re-implements "cancel rAF on suspend, re-request on
    // resume" and someone always gets one leg wrong. Arcade.loop(fn) owns
    // that: fn(deltaMs, ts) runs once per animation frame while started and
    // not suspended; suspended time never appears in a delta (the first
    // frame after resume gets delta 0).
    function createLoop(fn) {
        if (typeof fn !== 'function') {
            throw new Error('Arcade.loop: fn must be a function');
        }
        var rafId = null;
        var running = false;   // caller intent — survives suspend/resume
        var lastTs = null;

        function schedule() {
            if (rafId === null && running && !suspendedNow) {
                rafId = requestAnimationFrame(frame);
            }
        }
        function frame(ts) {
            rafId = null;
            if (!running || suspendedNow) return;
            var delta = lastTs === null ? 0 : ts - lastTs;
            lastTs = ts;
            schedule(); // before fn, so a throwing frame doesn't kill the loop
            fn(delta, ts);
        }
        var unsubSuspend = makeSubscriber(listeners.suspend)(function () {
            if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
            lastTs = null;
        });
        var unsubResume = makeSubscriber(listeners.resume)(function () {
            lastTs = null;
            schedule(); // no-op unless start() was called and stop() wasn't
        });

        var loop = {
            start: function () { running = true; lastTs = null; schedule(); return loop; },
            stop: function () {
                running = false;
                lastTs = null;
                if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
                return loop;
            },
            // One frame on demand — for dirty-flag renderers that are
            // normally stopped. If the loop is started, this is just an
            // immediate extra scheduling opportunity.
            kick: function () {
                if (rafId !== null || suspendedNow) return loop;
                rafId = requestAnimationFrame(function (ts) {
                    rafId = null;
                    if (suspendedNow) return;
                    if (running) { frame(ts); return; }
                    fn(0, ts);
                });
                return loop;
            },
            running: function () { return running; },
            dispose: function () {
                loop.stop();
                unsubSuspend();
                unsubResume();
                return null;
            }
        };
        return loop;
    }

    // ─── Async per-app storage (Arcade.store) ─────────────────────
    // localStorage is synchronous, string-only, and shares one small (~5 MB)
    // origin budget across the launcher and every app — fine for game state,
    // useless for a notes/photo/document app. Arcade.store is a promise-based
    // key/value store backed by a per-app IndexedDB database, so it holds far
    // more and never blocks the main thread. Each named store is its own
    // database (arcade.v1.<gameId>.store.<name>) with a single 'kv' object
    // store, which avoids dynamic object-store creation entirely.
    function idbRequest(req) {
        return new Promise(function (resolve, reject) {
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }
    function openKvDb(dbName) {
        return new Promise(function (resolve, reject) {
            if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            var req = indexedDB.open(dbName, 1);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }
    function kvTx(dbName, mode, fn) {
        return openKvDb(dbName).then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('kv', mode);
                var store = tx.objectStore('kv');
                var result;
                Promise.resolve(fn(store)).then(function (r) { result = r; }, reject);
                tx.oncomplete = function () { db.close(); resolve(result); };
                tx.onerror = function () { db.close(); reject(tx.error); };
                tx.onabort = function () { db.close(); reject(tx.error); };
            });
        });
    }
    var STORE_NAME_RE = /^[a-z0-9_-]{1,64}$/i;
    function storeDbName(name) {
        var n = (name === undefined || name === null) ? 'default' : String(name);
        if (!STORE_NAME_RE.test(n)) throw new Error('Arcade.store.open: name must match /^[a-z0-9_-]{1,64}$/');
        return KEY_PREFIX + gameId + '.store.' + n;
    }
    var storeApi = {
        // open(name?) → a handle whose get/set/del/keys/each/clear all return
        // promises. Distinct names are fully isolated stores.
        open: function (name) {
            ensureGameId();
            var dbName = storeDbName(name);
            return {
                get: function (key) {
                    return kvTx(dbName, 'readonly', function (s) { return idbRequest(s.get(String(key))); })
                        .then(function (v) { return v === undefined ? null : v; });
                },
                set: function (key, value) {
                    return kvTx(dbName, 'readwrite', function (s) { return idbRequest(s.put(value, String(key))); })
                        .then(function () { return true; });
                },
                del: function (key) {
                    return kvTx(dbName, 'readwrite', function (s) { return idbRequest(s['delete'](String(key))); })
                        .then(function () { return true; });
                },
                keys: function () {
                    return kvTx(dbName, 'readonly', function (s) { return idbRequest(s.getAllKeys()); });
                },
                each: function (fn) {
                    return kvTx(dbName, 'readonly', function (s) {
                        return new Promise(function (resolve, reject) {
                            var req = s.openCursor();
                            req.onsuccess = function () {
                                var cur = req.result;
                                if (!cur) { resolve(); return; }
                                try { fn(cur.value, cur.key); } catch (e) {}
                                cur['continue']();
                            };
                            req.onerror = function () { reject(req.error); };
                        });
                    });
                },
                clear: function () {
                    return kvTx(dbName, 'readwrite', function (s) { return idbRequest(s.clear()); })
                        .then(function () { return true; });
                }
            };
        }
    };

    // ─── Async per-app blob storage (Arcade.files) ────────────────
    // For binary/large content (images, documents). Prefers OPFS (a real
    // per-origin file system) under a per-app directory; falls back to storing
    // Blobs in a per-app IndexedDB when OPFS is unavailable. Same promise API
    // either way.
    var FILE_NAME_RE = /^[a-z0-9._-]{1,128}$/i;
    function fileDirName() { return KEY_PREFIX + gameId; }
    function opfsAvailable() {
        return !!(navigator.storage && navigator.storage.getDirectory);
    }
    function opfsDir() {
        return navigator.storage.getDirectory().then(function (root) {
            return root.getDirectoryHandle(fileDirName(), { create: true });
        });
    }
    function filesDbName() { return KEY_PREFIX + gameId + '.files'; }
    var filesApi = {
        put: function (name, blob) {
            ensureGameId();
            var n = String(name);
            if (!FILE_NAME_RE.test(n)) return Promise.reject(new Error('Arcade.files: name must match /^[a-z0-9._-]{1,128}$/'));
            if (!(blob instanceof Blob)) blob = new Blob([blob]);
            if (opfsAvailable()) {
                return opfsDir().then(function (dir) {
                    return dir.getFileHandle(n, { create: true }).then(function (fh) {
                        return fh.createWritable().then(function (w) {
                            return w.write(blob).then(function () { return w.close(); });
                        });
                    });
                }).then(function () { return true; });
            }
            return kvTx(filesDbName(), 'readwrite', function (s) {
                return idbRequest(s.put({ blob: blob, size: blob.size, type: blob.type }, n));
            }).then(function () { return true; });
        },
        get: function (name) {
            ensureGameId();
            var n = String(name);
            if (opfsAvailable()) {
                return opfsDir().then(function (dir) {
                    return dir.getFileHandle(n, { create: false }).then(function (fh) { return fh.getFile(); });
                }).catch(function () { return null; });
            }
            return kvTx(filesDbName(), 'readonly', function (s) { return idbRequest(s.get(n)); })
                .then(function (rec) { return rec ? rec.blob : null; })
                .catch(function () { return null; });
        },
        list: function () {
            ensureGameId();
            if (opfsAvailable()) {
                return opfsDir().then(function (dir) {
                    var out = [];
                    // values() is an async iterator of FileSystemHandles.
                    return (async function () {
                        for await (var h of dir.values()) {
                            if (h.kind === 'file') {
                                var f = await h.getFile();
                                out.push({ name: h.name, size: f.size });
                            }
                        }
                        return out;
                    })();
                }).catch(function () { return []; });
            }
            return kvTx(filesDbName(), 'readonly', function (s) {
                return Promise.all([idbRequest(s.getAllKeys()), idbRequest(s.getAll())]).then(function (r) {
                    return r[0].map(function (k, i) { return { name: k, size: (r[1][i] && r[1][i].size) || 0 }; });
                });
            }).catch(function () { return []; });
        },
        'delete': function (name) {
            ensureGameId();
            var n = String(name);
            if (opfsAvailable()) {
                return opfsDir().then(function (dir) { return dir.removeEntry(n); })
                    .then(function () { return true; }).catch(function () { return false; });
            }
            return kvTx(filesDbName(), 'readwrite', function (s) { return idbRequest(s['delete'](n)); })
                .then(function () { return true; }).catch(function () { return false; });
        }
    };

    // ─── Storage introspection & durability ───────────────────────
    // Thin promise wrappers over the StorageManager API (absent on some
    // browsers → resolve to safe defaults). persist() asks the browser not to
    // evict this origin's data under storage pressure — the launcher calls it
    // on boot; apps may call it too.
    var storageApi = {
        estimate: function () {
            if (navigator.storage && navigator.storage.estimate) {
                return navigator.storage.estimate();
            }
            return Promise.resolve({ usage: undefined, quota: undefined });
        },
        persisted: function () {
            if (navigator.storage && navigator.storage.persisted) {
                return navigator.storage.persisted();
            }
            return Promise.resolve(false);
        },
        persist: function () {
            if (navigator.storage && navigator.storage.persist) {
                return navigator.storage.persist();
            }
            return Promise.resolve(false);
        }
    };

    // ─── Public surface ───────────────────────────────────────────
    var api = {
        init: init,
        get ready() { return readyPromise; },
        get context() {
            return { framed: framed, version: VERSION, gameId: gameId, suspended: suspendedNow };
        },
        state: stateApi,
        global: globalApi,
        player: playerApi,
        settings: settingsApi,
        peer: peerApi,
        ui: uiApi,
        html: htmlTemplate,
        scores: scoresApi,
        stats: statsApi,
        session: sessionApi,
        store: storeApi,
        files: filesApi,
        storage: storageApi,
        loop: function (fn) { ensureGameId(); return createLoop(fn); },
        onSuspend: makeSubscriber(listeners.suspend),
        onResume: makeSubscriber(listeners.resume),
        onStateReplaced: makeSubscriber(listeners.stateReplaced),
        onSettingsChange: makeSubscriber(listeners.settingsChange),
        // Fired when a localStorage write fails (typically quota). Returns an
        // unsubscribe fn. Data was NOT saved — warn the user / shed load.
        onStorageError: function (fn) {
            if (typeof fn !== 'function') return function () {};
            storageErrorListeners.push(fn);
            return function () {
                var i = storageErrorListeners.indexOf(fn);
                if (i >= 0) storageErrorListeners.splice(i, 1);
            };
        }
    };

    Object.defineProperty(window, 'Arcade', {
        value: api,
        writable: false,
        configurable: false
    });
})();
