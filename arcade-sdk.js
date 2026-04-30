/* Paul's Arcade SDK — window.Arcade
 *
 * Loaded by games at https://paulgibeault.github.io/arcade-sdk.js
 * Same-origin with the launcher and every game; storage works without a bridge.
 * The bridge only exists for multiplayer transport and launcher-aware events.
 *
 *   Arcade.init({ gameId })            -> identity + handshake
 *   Arcade.state.get/set(key[, value]) -> 'arcade.v1.<gameId>.<key>'
 *   Arcade.global.get/set(key[, value])-> 'arcade.v1.global.<key>'
 *   Arcade.onStateReplaced(fn)         -> launcher imported a save bundle
 *   Arcade.settings.fontScale()        -> launcher's current font scale
 *   Arcade.onSettingsChange(fn)        -> launcher settings updated
 *   Arcade.peer.status() / .onStatus() / .send() / .onMessage()
 *   Arcade.context                     -> { framed, version }
 *
 * Settings auto-apply: the SDK writes the launcher's font scale to
 * `--font-scale` on the game's <html>, so any rule using
 * `var(--font-scale, 1)` (e.g. `font-size: calc(100% * var(--font-scale))`)
 * scales for free without subscribing.
 */
(function () {
    'use strict';

    var VERSION = 1;
    var HANDSHAKE_TIMEOUT_MS = 300;
    var MSG_PREFIX = 'arcade:';
    var KEY_PREFIX = 'arcade.v1.';
    var GAME_ID_RE = /^[a-z0-9_-]+$/i;

    var gameId = null;
    var initialized = false;
    var framed = false;
    var peerStatus = 'unavailable';
    var peerStatusListeners = [];
    var peerMessageListeners = [];
    var stateReplacedListeners = [];
    var settingsChangeListeners = [];
    var settings = { fontScale: 1 };
    var parentOrigin = null;
    var handshakeTimer = null;

    function inIframe() {
        try { return window.self !== window.top; } catch (e) { return true; }
    }

    function gameKey(key) { return KEY_PREFIX + gameId + '.' + key; }
    function globalKeyName(key) { return KEY_PREFIX + 'global.' + key; }

    function readJSON(k) {
        var raw;
        try { raw = localStorage.getItem(k); } catch (e) { return null; }
        if (raw === null) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    function writeJSON(k, v) {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota etc. */ }
    }

    function setPeerStatus(s) {
        if (s === peerStatus) return;
        peerStatus = s;
        for (var i = 0; i < peerStatusListeners.length; i++) {
            try { peerStatusListeners[i](s); } catch (e) {}
        }
    }

    function applySettings(incoming) {
        if (!incoming || typeof incoming !== 'object') return false;
        var changed = false;
        if (typeof incoming.fontScale === 'number' && isFinite(incoming.fontScale)) {
            if (incoming.fontScale !== settings.fontScale) {
                settings.fontScale = incoming.fontScale;
                changed = true;
            }
            // Always (re)apply the CSS variable — the game's document may
            // have just loaded and not yet picked it up.
            try {
                document.documentElement.style.setProperty('--font-scale', settings.fontScale);
            } catch (e) {}
        }
        return changed;
    }

    // Inject a default root font-size rule so any rem/em-based text in the
    // game scales with the launcher setting. Inserted at the start of <head>
    // so a game's own `:root { font-size: ... }` rules naturally override.
    function injectBaseFontStyle() {
        try {
            if (document.getElementById('arcade-sdk-base-style')) return;
            var head = document.head || document.getElementsByTagName('head')[0];
            if (!head) return;
            var style = document.createElement('style');
            style.id = 'arcade-sdk-base-style';
            style.textContent = ':root{font-size:calc(100% * var(--font-scale, 1));}';
            head.insertBefore(style, head.firstChild);
        } catch (e) {}
    }

    function notifySettingsChange() {
        var snapshot = { fontScale: settings.fontScale };
        for (var i = 0; i < settingsChangeListeners.length; i++) {
            try { settingsChangeListeners[i](snapshot); } catch (e) {}
        }
    }

    function postToParent(msg) {
        if (!framed) return;
        try {
            window.parent.postMessage(msg, parentOrigin || window.location.origin);
        } catch (e) {}
    }

    function onMessage(e) {
        if (e.source !== window.parent) return;
        if (e.origin !== window.location.origin) return;
        var data = e.data;
        if (!data || typeof data !== 'object') return;
        var t = data.type;
        if (typeof t !== 'string' || t.indexOf(MSG_PREFIX) !== 0) return;

        switch (t) {
            case 'arcade:welcome':
                if (handshakeTimer) {
                    clearTimeout(handshakeTimer);
                    handshakeTimer = null;
                }
                framed = true;
                parentOrigin = e.origin;
                setPeerStatus(typeof data.peerStatus === 'string' ? data.peerStatus : 'idle');
                if (applySettings(data.settings)) notifySettingsChange();
                break;
            case 'arcade:peer.message':
                for (var i = 0; i < peerMessageListeners.length; i++) {
                    try { peerMessageListeners[i](data.payload, data.fromPeer); } catch (err) {}
                }
                break;
            case 'arcade:peer.status':
                if (typeof data.status === 'string') setPeerStatus(data.status);
                break;
            case 'arcade:state.replaced':
                for (var j = 0; j < stateReplacedListeners.length; j++) {
                    try { stateReplacedListeners[j](); } catch (err) {}
                }
                break;
            case 'arcade:settings.changed':
                if (applySettings(data.settings)) notifySettingsChange();
                break;
        }
    }

    function init(opts) {
        if (initialized) return;
        initialized = true;

        if (!opts || typeof opts.gameId !== 'string' || !GAME_ID_RE.test(opts.gameId)) {
            throw new Error('Arcade.init: opts.gameId must match /^[a-z0-9_-]+$/');
        }
        gameId = opts.gameId;

        // Set the default rem-scaling rule even when standalone — the
        // CSS var has a `, 1` fallback so 100% renders normally; framed
        // mode replaces the var with the launcher's current scale.
        injectBaseFontStyle();

        if (!inIframe()) {
            framed = false;
            peerStatus = 'unavailable';
            return;
        }

        window.addEventListener('message', onMessage);
        try {
            window.parent.postMessage(
                { type: 'arcade:hello', gameId: gameId, version: VERSION },
                window.location.origin
            );
        } catch (e) {}

        handshakeTimer = setTimeout(function () {
            handshakeTimer = null;
            framed = false;
            peerStatus = 'unavailable';
        }, HANDSHAKE_TIMEOUT_MS);
    }

    function ensureGameId() {
        if (gameId === null) {
            throw new Error('Arcade: call Arcade.init({ gameId }) before using state.*');
        }
    }

    var stateApi = {
        get: function (key) { ensureGameId(); return readJSON(gameKey(key)); },
        set: function (key, value) { ensureGameId(); writeJSON(gameKey(key), value); }
    };

    var globalApi = {
        get: function (key) { return readJSON(globalKeyName(key)); },
        set: function (key, value) { writeJSON(globalKeyName(key), value); }
    };

    var peerApi = {
        status: function () { return peerStatus; },
        onStatus: function (fn) {
            if (typeof fn === 'function') peerStatusListeners.push(fn);
        },
        send: function (payload) {
            if (!framed || peerStatus !== 'connected') return false;
            postToParent({ type: 'arcade:peer.send', payload: payload });
            return true;
        },
        onMessage: function (fn) {
            if (typeof fn === 'function') peerMessageListeners.push(fn);
        }
    };

    function onStateReplaced(fn) {
        if (typeof fn === 'function') stateReplacedListeners.push(fn);
    }

    var settingsApi = {
        fontScale: function () { return settings.fontScale; }
    };

    function onSettingsChange(fn) {
        if (typeof fn === 'function') settingsChangeListeners.push(fn);
    }

    Object.defineProperty(window, 'Arcade', {
        value: Object.freeze({
            init: init,
            state: Object.freeze(stateApi),
            global: Object.freeze(globalApi),
            peer: Object.freeze(peerApi),
            settings: Object.freeze(settingsApi),
            onStateReplaced: onStateReplaced,
            onSettingsChange: onSettingsChange,
            get context() { return { framed: framed, version: VERSION }; }
        }),
        writable: false,
        configurable: false
    });
})();
