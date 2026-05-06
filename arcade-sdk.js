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
 *   Arcade.context                 { framed, version, gameId }
 *
 *   // Storage — sync, JSON-encoded under arcade.v1.<gameId>.<key>
 *   Arcade.state.get / set / remove
 *   Arcade.state.getOrInit(key, defaults)         deep-merge load
 *   Arcade.state.migrate(version, fn)             run-once bootstrap
 *   Arcade.state.onChange(key, fn)                storage events + replace
 *
 *   // Cross-game keys under arcade.v1.global.<key>
 *   Arcade.global.get / set / remove / onChange
 *
 *   // Sticky display name (lives in arcade.v1.global.playerName)
 *   Arcade.player.name() / setName(s) / onChange(fn)
 *
 *   // Lifecycle (driven by launcher iframe pool)
 *   Arcade.onSuspend(fn) / onResume(fn) / onStateReplaced(fn)
 *
 *   // Settings — pushed by launcher; SDK auto-applies CSS hooks
 *   Arcade.settings.fontScale | theme | reducedMotion | audioVolume | handedness
 *   Arcade.settings.snapshot()
 *   Arcade.onSettingsChange(fn)
 *
 *   // Multiplayer (no-ops standalone)
 *   Arcade.peer.status / onStatus / send / onMessage
 *
 *   // Launcher-mediated UI
 *   Arcade.ui.toast(message, { kind, duration })
 *
 *   // Top-N leaderboard per category
 *   Arcade.scores.add(category, { score, name?, meta? })
 *   Arcade.scores.list(category, { limit }?)
 *   Arcade.scores.best(category)
 *   Arcade.scores.clear(category)
 *
 *   // Mutable per-category counter / blob
 *   Arcade.stats.get(category)
 *   Arcade.stats.getOrInit(category, defaults)    deep-merge load
 *   Arcade.stats.update(category, prev => next)
 *
 *   // Suspended-time-aware game timer
 *   const t = Arcade.session.start();             auto-pauses on onSuspend
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
    var settings = {
        fontScale: 1,
        theme: 'dark',
        reducedMotion: false,
        audioVolume: 1,
        handedness: 'right'
    };

    var listeners = {
        peerStatus: [],
        peerMessage: [],
        stateReplaced: [],
        settingsChange: [],
        suspend: [],
        resume: []
    };
    var keyChangeListeners = new Map(); // fullKey -> [fn, fn, ...]

    var readyResolved = false;
    var readyResolve;
    var readyPromise = new Promise(function (r) { readyResolve = r; });

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
    function writeJSON(k, v) {
        try {
            if (v === undefined) localStorage.removeItem(k);
            else localStorage.setItem(k, JSON.stringify(v));
            return true;
        } catch (e) { return false; }
    }
    function removeKey(k) {
        try { localStorage.removeItem(k); } catch (e) {}
    }

    function isPlainObject(o) {
        return o !== null && typeof o === 'object' && !Array.isArray(o);
    }
    function deepMerge(base, override) {
        if (!isPlainObject(base) || !isPlainObject(override)) return override;
        var out = {};
        for (var k in base) out[k] = base[k];
        for (var k2 in override) {
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
                '--motion-scale:1;--audio-volume:1;}';
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
                if (applySettings(data.settings)) fire(listeners.settingsChange, snapshotSettings());
                resolveReady();
                break;
            case 'arcade:peer.message':
                fire(listeners.peerMessage, data.payload, data.fromPeer);
                break;
            case 'arcade:peer.status':
                if (typeof data.status === 'string') setPeerStatus(data.status);
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
                fire(listeners.suspend);
                break;
            case 'arcade:lifecycle.resume':
                fire(listeners.resume);
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

    // ─── Service-worker collision warning ─────────────────────────
    function checkSWCollision() {
        try {
            if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
            var script = document.currentScript;
            var url = script ? script.src : null;
            if (!url || url.indexOf('arcade-sdk.js') === -1) return;
            var entries = (performance.getEntriesByName ? performance.getEntriesByName(url) : []);
            if (entries && entries.length > 0 && entries[0].workerStart > 0) {
                console.warn(
                    '[Arcade SDK] arcade-sdk.js was served from a service worker. ' +
                    'Games must NOT cache the SDK in their own SW — see GAME_INTEGRATION.md §7.'
                );
            }
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
    var stateApi = {
        get: function (key) { ensureGameId(); return readJSON(gameKey(key)); },
        set: function (key, value) {
            ensureGameId();
            var k = gameKey(key);
            if (writeJSON(k, value)) fireKeyChange(k, value);
        },
        remove: function (key) {
            ensureGameId();
            var k = gameKey(key);
            removeKey(k);
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
            if (writeJSON(k, value)) fireKeyChange(k, value);
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
        send: function (payload) {
            if (!framed || peerStatus !== 'connected') return false;
            postToParent({ type: 'arcade:peer.send', payload: payload });
            return true;
        },
        onMessage: makeSubscriber(listeners.peerMessage)
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
        add: function (category, entry) {
            ensureGameId();
            if (typeof category !== 'string' || !category) {
                throw new Error('Arcade.scores.add: category required');
            }
            if (!entry || typeof entry !== 'object'
                    || typeof entry.score !== 'number' || !isFinite(entry.score)) {
                throw new Error('Arcade.scores.add: entry.score must be a finite number');
            }
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
            if (entry.meta && typeof entry.meta === 'object') {
                record.meta = entry.meta;
            }
            var k = scoresKey(category);
            var list = readJSON(k);
            if (!Array.isArray(list)) list = [];
            list.push(record);
            list.sort(function (a, b) { return b.score - a.score; });
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
        best: function (category) {
            var l = scoresApi.list(category, { limit: 1 });
            return l.length ? l[0] : null;
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
    // Auto-reset on launcher import: when `arcade:state.replaced` fires (the
    // user loaded a save), every live tracker resets to 0. The imported state
    // carries its own elapsed snapshot (if the game serialized one), and the
    // game's onStateReplaced handler is responsible for re-hydrating UI from
    // it — the wall clock since "now" is a separate concern.
    //
    // Persistence is the game's responsibility — if you need elapsed to
    // survive a tab close, write `t.elapsedMs()` into Arcade.state on suspend.
    function createSessionTimer() {
        var startedAt = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        function now() {
            return (typeof performance !== 'undefined' && performance.now)
                ? performance.now() : Date.now();
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
            tracker.reset();
        });

        var tracker = {
            elapsedMs: function () {
                var paused = accumPaused;
                if (pauseStartedAt !== null) paused += now() - pauseStartedAt;
                var ms = now() - startedAt - paused;
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
                pauseStartedAt = isPaused() ? startedAt : null;
            },
            stop: function () {
                if (stopped) return;
                stopped = true;
                unsubSuspend();
                unsubResume();
                unsubReplaced();
            }
        };
        return tracker;
    }
    var sessionApi = {
        start: function () {
            ensureGameId();
            return createSessionTimer();
        }
    };

    // ─── Public surface ───────────────────────────────────────────
    var api = {
        init: init,
        get ready() { return readyPromise; },
        get context() {
            return { framed: framed, version: VERSION, gameId: gameId };
        },
        state: stateApi,
        global: globalApi,
        player: playerApi,
        settings: settingsApi,
        peer: peerApi,
        ui: uiApi,
        scores: scoresApi,
        stats: statsApi,
        session: sessionApi,
        onSuspend: makeSubscriber(listeners.suspend),
        onResume: makeSubscriber(listeners.resume),
        onStateReplaced: makeSubscriber(listeners.stateReplaced),
        onSettingsChange: makeSubscriber(listeners.settingsChange)
    };

    Object.defineProperty(window, 'Arcade', {
        value: api,
        writable: false,
        configurable: false
    });
})();
