/* Paul's Arcade SDK — window.Arcade  (protocol v2, SDK v3)
 *
 * Loaded by games at https://paulgibeault.github.io/arcade-sdk.js.
 * The launcher↔game bridge handles multiplayer, lifecycle hints, settings
 * broadcast, launcher-mediated UI (toasts), post-import notifications — and,
 * for launcher-mounted frames, ALL persistent storage:
 *
 * STORAGE MODES (Arcade.context.storage — chosen automatically at init)
 *   'direct'  — standalone pages (and legacy same-origin embeds): the
 *               document reads/writes localStorage/IndexedDB/OPFS itself.
 *   'bridged' — the launcher mounts games in OPAQUE-ORIGIN iframes (sandbox
 *               without allow-same-origin), so a game cannot open the
 *               origin's storage — most importantly the launcher's P2P
 *               identity/pairing key stores. Every storage API transparently
 *               rides postMessage to the launcher, which persists under the
 *               SAME arcade.v1.<gameId> names direct mode would use. Sync
 *               state reads serve from a cache seeded by the welcome
 *               snapshot — so AWAIT Arcade.ready BEFORE READING STATE when
 *               framed; pre-ready reads return empty and warn.
 *   'memory'  — opaque-origin frame but no launcher answered: state lives in
 *               memory for the session; store/files operations reject/no-op.
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
 *   Arcade.context                 { framed, version, gameId, suspended, storage }
 *
 *   // Storage — sync, JSON-encoded under arcade.v1.<gameId>.<key>
 *   Arcade.state.get / set / remove
 *   Arcade.state.set(key, v, { exportable: false })  keep out of save files
 *   Arcade.state.set(key, v, { sync: true })      opt this key into Arcade.sync
 *   Arcade.state.getOrInit(key, defaults)         deep-merge load
 *   Arcade.state.migrate(version, fn)             run-once bootstrap
 *   Arcade.state.adopt(legacyKey, newKey?, opts?) one-line legacy-key move
 *   Arcade.state.onChange(key, fn)                storage events + replace
 *
 *   // Multi-device state replication over P2P, LWW (#28) — opt-in per key
 *   Arcade.sync.enable(keys?)                     '*' (all) or ['k1','k2']
 *   Arcade.sync.disable(keys?)                    stop syncing (outbound)
 *   Arcade.sync.list()                            current opt-in list
 *   Arcade.sync.onConflict(fn)                    fn({ key, mine, theirs })
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
 *   Arcade.onFramedChange(fn)      framed flipped after ready (late welcome)
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
 *   Arcade.peer.onBlobError(fn)   failed incoming transfer: { id, name,
 *                                 reason: 'timeout'|'aborted'|'integrity', ... }
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

    // Idempotent load: a template copy-paste that includes arcade-sdk.js twice
    // must not throw (window.Arcade is defined non-configurable below).
    if (window.Arcade) { return; }

    var VERSION = 3; // v3: bridged storage mode (opaque-origin frames)
    var HANDSHAKE_TIMEOUT_MS = 300;
    // Opaque-origin (sandboxed, no allow-same-origin) frames have no storage
    // to fall back to, so waiting longer for the launcher costs nothing and
    // makes `context.framed` deterministic at ready in the launcher case.
    var BRIDGED_HANDSHAKE_TIMEOUT_MS = 2000;
    var MSG_PREFIX = 'arcade:';
    var KEY_PREFIX = 'arcade.v1.';
    var GAME_ID_RE = /^[a-z0-9_-]+$/i;
    var SCORES_CAP = 100;
    var SCORES_DEFAULT_LIMIT = 10;

    // ─── Module state ─────────────────────────────────────────────
    var gameId = null;
    var initialized = false;
    var warnedReadyPreInit = false;
    var framed = false;
    var parentOrigin = null;
    var handshakeTimer = null;

    // Storage mode. 'direct' = this document can touch localStorage /
    // IndexedDB / OPFS itself (standalone pages, and legacy launchers that
    // mount games with allow-same-origin). 'bridged' = the document has an
    // OPAQUE origin (the launcher sandboxes game iframes without
    // allow-same-origin so a game can never open the launcher's — or another
    // app's — origin storage, most importantly the P2P identity/pairing key
    // stores). In bridged mode every storage API rides postMessage to the
    // launcher, which persists under the same arcade.v1.<gameId> names the
    // game would have used itself — the data is identical either way.
    var storageMode = 'direct';
    var lsCache = null;          // bridged: Map fullKey -> raw string
    var pendingWrites = null;    // bridged: writes queued until the welcome snapshot
    var PENDING_WRITES_CAP = 500;
    var snapshotSeeded = false;  // bridged: welcome.state applied
    var welcomedOnce = false;    // guards against a duplicate/late second welcome re-seeding the cache
    var migrationBlockedByBridge = false; // set when adopt() can't reach a legacy key in an opaque frame
    var warnedAdoptBridged = false;
    var sdkInternalRead = false; // suppresses the early-read warning for SDK's own reads
    var warnedEarlyReads = {};

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
        peerBlobError: [],
        peerRequest: [],
        stateReplaced: [],
        settingsChange: [],
        suspend: [],
        resume: [],
        framedChange: [],
        syncConflict: []
    };

    // Remote peer roster — seeded from the launcher's welcome, kept fresh by
    // arcade:peer.identity / arcade:peer.ready broadcasts.
    var remotePeers = {}; // deviceId -> { deviceId, name, at }
    function noteRemotePeer(deviceId, name) {
        if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 64) return null;
        if (isDunderKey(deviceId)) return null; // never key the roster object by __proto__/constructor/prototype
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
    // { deviceId, name, status: 'connected'|'interrupted', direct }. A seat
    // that's truly gone leaves the list — removal is the leave signal.
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
                status: p.status === 'interrupted' ? 'interrupted' : 'connected',
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

    // ─── Raw storage layer ────────────────────────────────────────
    // Single chokepoint for every localStorage touch. In bridged mode reads
    // come from the in-memory cache (seeded by the launcher's welcome
    // snapshot) and writes go cache-first with a write-through postMessage.
    function storageAccessible() {
        // In an opaque-origin document merely touching window.localStorage
        // throws SecurityError — that's the whole signal.
        try { void window.localStorage.getItem('arcade.v1._meta.probe'); return true; }
        catch (e) { return false; }
    }
    var warnedWriteOverflow = false;
    function queueStateWrite(key, value) { // value: raw string, or null = remove
        if (pendingWrites) {
            if (pendingWrites.length >= PENDING_WRITES_CAP) {
                pendingWrites.shift();
                // Warn ONCE, not on every subsequent write. In memory-only mode
                // (handshake timed out, no launcher) ready has already resolved
                // and there is nothing left to await — say so instead of telling
                // the game to await Arcade.ready.
                if (!warnedWriteOverflow) {
                    warnedWriteOverflow = true;
                    if (readyResolved && !framed) {
                        console.warn('[Arcade SDK] running in memory-only mode (no launcher answered) — writes are session-local and the oldest are being dropped past ' + PENDING_WRITES_CAP + '.');
                    } else {
                        console.warn('[Arcade SDK] pre-ready write queue overflowed — oldest write dropped. Await Arcade.ready before writing state in framed mode.');
                    }
                }
            }
            pendingWrites.push({ key: key, value: value });
            return;
        }
        postToParent({ type: 'arcade:state.write', key: key, value: value });
    }
    function warnEarlyRead(k) {
        if (storageMode !== 'bridged' || snapshotSeeded || sdkInternalRead) return;
        // Post-timeout with no launcher = memory-only mode, a different
        // (documented) situation — not an early read.
        if (readyResolved && !framed) return;
        if (warnedEarlyReads[k]) return;
        warnedEarlyReads[k] = true;
        console.warn('[Arcade SDK] "' + k + '" read before Arcade.ready in framed mode — '
            + 'stored state has not arrived yet, so this returns empty. Await Arcade.ready.');
    }
    function rawGet(k) {
        if (storageMode === 'bridged') {
            warnEarlyRead(k);
            var v = lsCache.get(k);
            return v === undefined ? null : v;
        }
        try { return localStorage.getItem(k); } catch (e) { return null; }
    }
    function rawSetItem(k, raw) {
        if (storageMode === 'bridged') { lsCache.set(k, raw); queueStateWrite(k, raw); return true; }
        try { localStorage.setItem(k, raw); return true; } catch (e) { return false; }
    }
    function rawRemoveItem(k) {
        if (storageMode === 'bridged') { lsCache['delete'](k); queueStateWrite(k, null); return; }
        try { localStorage.removeItem(k); } catch (e) {}
    }

    var warnedCorruptKeys = {};
    function readJSON(k) {
        var raw = rawGet(k);
        if (raw === null) return null;
        try { return JSON.parse(raw); }
        catch (e) {
            // Corrupt stored JSON reads as "absent" (null), which silently looks
            // like a missing save. Signal it once per key so it's diagnosable.
            if (!warnedCorruptKeys[k]) {
                warnedCorruptKeys[k] = true;
                console.warn('[Arcade SDK] stored value at "' + k + '" is not valid JSON — treated as empty.');
            }
            return null;
        }
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
        if (storageMode === 'bridged') {
            // Cache writes can't fail; a quota failure on the launcher side
            // comes back asynchronously as arcade:state.writeError and fires
            // onStorageError there.
            if (v === undefined) rawRemoveItem(k);
            else rawSetItem(k, JSON.stringify(v));
            return true;
        }
        try {
            if (v === undefined) localStorage.removeItem(k);
            else localStorage.setItem(k, JSON.stringify(v));
            return true;
        } catch (e) { fireStorageError(k, e); return false; }
    }
    function removeKey(k) {
        rawRemoveItem(k);
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
        // Iterate a SNAPSHOT: built-in subscribers (managed timers, loops,
        // session trackers) legitimately unsubscribe from inside their own
        // callback, which splices `arr` mid-loop and would otherwise skip the
        // next sibling — the exact hazard that leaks a timer past a save import.
        var snap = arr.slice();
        for (var i = 0; i < snap.length; i++) {
            try { snap[i].apply(null, args); } catch (e) { logListenerError(e); }
        }
    }
    function fireKeyChange(fullKey, value) {
        var arr = keyChangeListeners.get(fullKey);
        if (!arr) return;
        var snap = arr.slice();
        for (var i = 0; i < snap.length; i++) {
            try { snap[i](value); } catch (e) { logListenerError(e); }
        }
    }
    // Deterministic seeded PRNG (mulberry32) for lockstep/turn-based games —
    // both devices seed from the same value (e.g. a shared game code) and deal
    // the same deck without a desync from Math.random.
    function hashStringToU32(str) {
        var h = 2166136261 >>> 0;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        return h >>> 0;
    }
    function mulberry32(seed) {
        var a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function coerceSeedU32(seed) {
        return (typeof seed === 'number' && isFinite(seed)) ? (seed >>> 0)
            : hashStringToU32(String(seed == null ? '' : seed));
    }
    function attachRngHelpers(next) {
        // Integer in [min, max] inclusive.
        next.int = function (min, max) { return min + Math.floor(next() * (max - min + 1)); };
        next.pick = function (arr) { return arr[Math.floor(next() * arr.length)]; };
        next.shuffle = function (arr) {
            var a = arr.slice();
            for (var i = a.length - 1; i > 0; i--) {
                var j = Math.floor(next() * (i + 1));
                var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
            }
            return a;
        };
        return next;
    }
    function makeSeededRandom(seed) {
        return attachRngHelpers(mulberry32(coerceSeedU32(seed)));
    }
    // Arcade.rng(seed) — mulberry32 whose ENTIRE generator state is one u32,
    // so getState()/setState() make mid-game persistence trivial (save the
    // number with your game state, restore it, and the sequence continues
    // exactly where it left off). Same helpers as random.seeded.
    function makeStatefulRng(seed) {
        var a = coerceSeedU32(seed);
        var next = function () {
            a = (a + 0x6D2B79F5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        attachRngHelpers(next);
        next.getState = function () { return a >>> 0; };
        next.setState = function (s) {
            if (typeof s !== 'number' || !isFinite(s)) return false;
            a = s >>> 0;
            return true;
        };
        return next;
    }
    var rngApi = makeStatefulRng;
    // FNV-1a → u32. Stable across devices — the seed derivation for anything
    // string-shaped (share codes, room names, dates).
    rngApi.hash = hashStringToU32;

    // Arcade.daily — ONE canonical "today" so every game's daily puzzle rolls
    // at the same moment on a given device. The platform rule is the
    // DEVICE-LOCAL calendar date: dailies roll at the player's midnight (the
    // Wordle convention), and no server or global leaderboard needs a single
    // worldwide instant — scores are local/P2P. NEVER use toISOString here
    // (that's UTC — the exact divergence this helper exists to kill).
    var dailyApi = {
        // YYYY-MM-DD for the device-local calendar date (or a given Date).
        dateStr: function (d) {
            d = d instanceof Date ? d : new Date();
            var p = function (n) { return (n < 10 ? '0' : '') + n; };
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
        },
        // Deterministic daily generator — distinct per game (seeded with the
        // gameId, so two games never share a sequence) and per optional salt
        // (multiple independent streams within one game). Before Arcade.init
        // the gameId is empty, so call this after init.
        seed: function (salt) {
            return makeStatefulRng(hashStringToU32(
                String(gameId || '') + '|' + dailyApi.dateStr() + '|' + String(salt == null ? '' : salt)));
        }
    };

    // Arcade.share — versioned share codes (base64url over a {v, d} JSON
    // envelope). encode never produces characters that need URL escaping;
    // decode is VALIDATE-ONLY and returns null on any garbage (wrong type,
    // oversize, bad charset, bad base64, bad JSON, bad envelope) — codes
    // cross devices, so decode must never throw and never let a crafted code
    // smuggle prototype-polluting keys into the parsed object.
    var shareApi = {
        encode: function (obj, opts) {
            var v = (opts && typeof opts.v === 'number' && isFinite(opts.v)) ? (opts.v >>> 0) : 1;
            var json = JSON.stringify({ v: v, d: obj === undefined ? null : obj });
            var bytes = new TextEncoder().encode(json);
            var bin = '';
            for (var i = 0; i < bytes.length; i += 0x8000) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }
            return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        },
        decode: function (code) {
            if (typeof code !== 'string' || !code || code.length > 8192) return null;
            if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
            try {
                var b64 = code.replace(/-/g, '+').replace(/_/g, '/');
                while (b64.length % 4) b64 += '=';
                var bin = atob(b64);
                var bytes = new Uint8Array(bin.length);
                for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                var env = JSON.parse(new TextDecoder().decode(bytes), function (k, v) {
                    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return undefined;
                    return v;
                });
                if (!env || typeof env !== 'object' || Array.isArray(env)
                    || typeof env.v !== 'number' || !('d' in env)) return null;
                return { v: env.v >>> 0, data: env.d };
            } catch (e) { return null; }
        }
    };

    function logListenerError(e) {
        // Keep listener isolation (one bad handler must not break the rest) but
        // stop swallowing the error entirely — a game whose handler throws gets
        // at least a console signal.
        try { console.error('[Arcade SDK] listener threw:', e); } catch (_) {}
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
        if (typeof incoming.fontScale === 'number' && isFinite(incoming.fontScale)) {
            // Clamp to the launcher's own range — a stray 0/negative from a
            // buggy launcher would blank every rem-sized glyph (font-size: 0).
            var fs = Math.max(0.5, Math.min(3, incoming.fontScale));
            if (fs !== settings.fontScale) { settings.fontScale = fs; changed = true; }
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
        // In bridged mode this runs against an empty cache (defaults) and the
        // launcher's welcome re-applies real settings a beat later — suppress
        // the early-read warning, these are the SDK's own reads.
        sdkInternalRead = true;
        try { hydrateSettingsFromStorageInner(); }
        finally { sdkInternalRead = false; }
    }
    function hydrateSettingsFromStorageInner() {
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
    // in production: the flag is opt-in. The value is CACHED (it changed a
    // localStorage read into a per-message hot-path cost) and refreshed on the
    // events that can flip it: boot, a bridged welcome/state.changed/replaced
    // for _meta.dev, and a direct-mode storage event on that key.
    var DEV_KEY = 'arcade.v1._meta.dev';
    var devModeCached = false;
    function refreshDevMode() {
        var prev = sdkInternalRead;
        sdkInternalRead = true;
        try { devModeCached = rawGet(DEV_KEY) === 'true'; }
        catch (e) { devModeCached = false; }
        finally { sdkInternalRead = prev; }
    }
    function devModeOn() { return devModeCached; }
    function honorDevQueryParam() {
        try {
            var p = new URLSearchParams(window.location.search).get('dev');
            if (p === null) return;
            if (p === '0' || p === 'false') {
                rawRemoveItem('arcade.v1._meta.dev');
            } else {
                rawSetItem('arcade.v1._meta.dev', 'true');
            }
        } catch (e) {}
    }

    // ─── Blob transfer (over Arcade.peer.send) ────────────────────
    // Large payloads ride the ordered/reliable data channel as a sequence of
    // base64 chunks wrapped in { __arcadeBlob: {...} } envelopes. Chunk
    // payloads are intercepted before onMessage listeners, so games only see
    // whole blobs via onBlob.
    //
    // FAILURE OBSERVABILITY (#41): a transfer used to be able to wedge
    // silently — chunks dropped by the transport's replay-queue overflow (or
    // a session-stash drop) left blobRx holding an incomplete entry forever.
    // Three guards now make every failure visible via onBlobError:
    //   - integrity: the sender ships the blob's SHA-256 in every chunk;
    //     the assembled blob is hashed and a mismatch is an error, never a
    //     silently-wrong delivery. (Absent on chunks from older SDKs — then
    //     the check is skipped, wire-compatible both ways.)
    //   - abort frames: a sender whose transfer dies mid-loop tells the
    //     receiver ({ __arcadeBlobAbort: { id } }), best-effort.
    //   - receive TTL: an incomplete entry that hasn't seen a chunk for
    //     BLOB_RX_TTL_MS is dropped with a 'timeout' error — the backstop
    //     for everything the sender can't signal.
    var BLOB_CHUNK_BYTES = 48 * 1024;
    var BLOB_MAX_CHUNKS = 2048; // ~96 MB — reject anything claiming more
    var BLOB_RX_TTL_MS = 60 * 1000;
    var BLOB_MAX_CHUNK_DECODED = BLOB_CHUNK_BYTES + 256; // slack for base64/framing
    var BLOB_MAX_TOTAL_BYTES = BLOB_MAX_CHUNKS * BLOB_CHUNK_BYTES;
    var BLOB_DEAD_TTL_MS = 30 * 1000;
    var blobSendCounter = 0;
    // Keyed by fromPeer|id (NOT id alone): in a multi-seat session ids are
    // guessable, so keying by id let any peer poison or abort another seat's
    // transfer. The composite key isolates each sender's transfers.
    var blobRx = {}; // rxKey -> { id, chunks, received, total, bytesTotal, mime, name, sha, lastAt, fromPeer }
    var blobRxDead = {}; // rxKey -> deadAt: briefly reject retransmits of a failed transfer
    var blobRxSweeper = null;
    function rxKey(id, fromPeer) { return (fromPeer || 'peer') + '|' + id; }

    function fireBlobError(id, st, reason, fromPeer) {
        fire(listeners.peerBlobError, {
            id: id,
            name: st ? st.name : '',
            reason: reason, // 'timeout' | 'aborted' | 'integrity' | 'malformed' | 'oversize'
            received: st ? st.received : 0,
            total: st ? st.total : 0,
            fromPeer: fromPeer || (st ? st.fromPeer : undefined)
        });
    }
    function killBlobRx(key, st, reason, fromPeer) {
        delete blobRx[key];
        blobRxDead[key] = Date.now();
        fireBlobError(st ? st.id : key, st, reason, fromPeer);
    }
    function blobRxSweep() {
        var now = Date.now();
        var live = 0;
        for (var key in blobRx) {
            var st = blobRx[key];
            if (now - st.lastAt > BLOB_RX_TTL_MS) {
                delete blobRx[key];
                fireBlobError(st.id, st, 'timeout');
            } else {
                live++;
            }
        }
        for (var dk in blobRxDead) {
            if (now - blobRxDead[dk] > BLOB_DEAD_TTL_MS) delete blobRxDead[dk];
        }
        if (!live && blobRxSweeper) { clearInterval(blobRxSweeper); blobRxSweeper = null; }
    }
    function ensureBlobSweeper() {
        if (!blobRxSweeper) blobRxSweeper = setInterval(blobRxSweep, 15 * 1000);
    }
    function sha256Hex(buf) {
        // Resolves null where SubtleCrypto is unavailable (http:// dev hosts
        // other than localhost) — integrity is then skipped, not failed.
        try {
            return crypto.subtle.digest('SHA-256', buf).then(function (h) {
                var b = new Uint8Array(h);
                var s = '';
                for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
                return s;
            }, function () { return null; });
        } catch (e) { return Promise.resolve(null); }
    }

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
        var key = rxKey(meta.id, fromPeer);
        // A retransmitted chunk of a transfer we already failed must not
        // resurrect a fresh (incompletable) entry.
        if (blobRxDead[key]) return;
        var st = blobRx[key];
        if (!st) {
            st = blobRx[key] = {
                id: meta.id,
                chunks: new Array(meta.total),
                received: 0,
                total: meta.total,
                bytesTotal: 0,
                mime: typeof meta.mime === 'string' ? meta.mime.slice(0, 128) : '',
                name: typeof meta.name === 'string' ? meta.name.slice(0, 128) : '',
                sha: (typeof meta.sha === 'string' && /^[0-9a-f]{64}$/.test(meta.sha)) ? meta.sha : null,
                lastAt: Date.now(),
                fromPeer: fromPeer
            };
            ensureBlobSweeper();
        }
        if (st.total !== meta.total || st.chunks[meta.seq] !== undefined) return;
        var bytes;
        try { bytes = base64ToBytes(String(meta.bytes || '')); }
        catch (e) {
            // Corrupt base64 — surface it instead of silently discarding, and
            // remember the id so later chunks don't build a ghost entry.
            killBlobRx(key, st, 'malformed', fromPeer);
            return;
        }
        // Cap per-chunk and cumulative decoded size: a peer sending 2048 chunks
        // of arbitrarily large base64 could otherwise pin hundreds of MB.
        if (bytes.length > BLOB_MAX_CHUNK_DECODED) { killBlobRx(key, st, 'oversize', fromPeer); return; }
        if (st.bytesTotal + bytes.length > BLOB_MAX_TOTAL_BYTES) { killBlobRx(key, st, 'oversize', fromPeer); return; }
        st.chunks[meta.seq] = bytes;
        st.bytesTotal += bytes.length;
        st.received++;
        st.lastAt = Date.now();
        if (st.received === st.total) {
            delete blobRx[key];
            var blob;
            try { blob = new Blob(st.chunks, { type: st.mime }); } catch (e) { return; }
            var deliver = function () {
                fire(listeners.peerBlob, blob, {
                    name: st.name, size: blob.size, mime: st.mime, fromPeer: fromPeer, id: st.id
                });
            };
            if (!st.sha) { deliver(); return; }
            // Integrity gate: only a hash-verified blob reaches the game.
            blob.arrayBuffer().then(sha256Hex).then(function (got) {
                if (got === null || got === st.sha) deliver();
                else fireBlobError(st.id, st, 'integrity', fromPeer);
            }, function () { deliver(); /* unreadable-buffer edge: don't invent an error */ });
        }
    }
    // ─── Request/response over peer.send ──────────────────────────
    // Every multiplayer game re-invents id+timeout+retry on top of fire-and-
    // forget send(). peer.request()/onRequest() provide it once: __arcadeReq /
    // __arcadeReqReply are reserved payload keys, intercepted before onMessage.
    var reqSendCounter = 0;
    var reqPending = {}; // id -> { resolve, reject, timer }
    function handlePeerRequest(req, fromPeer) {
        if (!req || typeof req.id !== 'string') return;
        var replyTo = function (response, isError) {
            var reply = { __arcadeReqReply: { id: req.id, response: response, error: !!isError } };
            // Reply privately to the requester when we can target it; otherwise
            // broadcast (the id disambiguates on the requester side).
            if (fromPeer && peerCaps.indexOf('peer.sendTo') !== -1) peerApi.send(reply, { to: fromPeer });
            else peerApi.send(reply);
        };
        var handlers = listeners.peerRequest;
        if (!handlers.length) { replyTo('no request handler registered', true); return; }
        // First handler to return a non-undefined value (or a promise) answers.
        var handled = false;
        var snap = handlers.slice();
        for (var i = 0; i < snap.length && !handled; i++) {
            try {
                var out = snap[i](req.payload, fromPeer);
                if (out !== undefined) {
                    handled = true;
                    Promise.resolve(out).then(function (v) { replyTo(v, false); },
                                             function (err) { replyTo(String(err && err.message || err), true); });
                }
            } catch (err) { handled = true; replyTo(String(err && err.message || err), true); logListenerError(err); }
        }
        if (!handled) replyTo(undefined, false); // acknowledged, no payload
    }
    function handlePeerReqReply(reply) {
        if (!reply || typeof reply.id !== 'string') return;
        var pend = reqPending[reply.id];
        if (!pend) return;
        delete reqPending[reply.id];
        clearTimeout(pend.timer);
        if (reply.error) pend.reject(new Error(typeof reply.response === 'string' ? reply.response : 'peer request failed'));
        else pend.resolve(reply.response);
    }

    function handleBlobAbort(meta, fromPeer) {
        if (!meta || typeof meta.id !== 'string' || meta.id.length > 64) return;
        // Keyed by sender: an abort can only ever touch the aborting peer's OWN
        // in-flight transfer, never a victim's between two other seats.
        var key = rxKey(meta.id, fromPeer);
        var st = blobRx[key];
        // Unknown id: either nothing arrived yet or it already completed —
        // record nothing, an abort for a finished transfer must not alarm.
        if (!st) return;
        delete blobRx[key];
        fireBlobError(st.id, st, 'aborted', fromPeer);
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

    // ─── Storage bridge (bridged mode only) ───────────────────────
    // Seed the cache from welcome.state, then reconcile writes made before
    // the snapshot arrived: a key the snapshot covers keeps the STORED value
    // (a pre-ready getOrInit default must never clobber a real save), a key
    // it doesn't cover flushes through to the launcher.
    function seedInitialSnapshot(snap) {
        snap = (snap && typeof snap === 'object') ? snap : {};
        var pend = pendingWrites || [];
        pendingWrites = null;
        var inSnap = {};
        Object.keys(snap).forEach(function (k) {
            if (typeof snap[k] !== 'string') return;
            lsCache.set(k, snap[k]);
            inSnap[k] = true;
        });
        snapshotSeeded = true;
        var superseded = [];
        for (var i = 0; i < pend.length; i++) {
            var w = pend[i];
            if (inSnap[w.key]) {
                if (superseded.indexOf(w.key) === -1) superseded.push(w.key);
                continue;
            }
            postToParent({ type: 'arcade:state.write', key: w.key, value: w.value });
        }
        if (superseded.length) {
            // The cache already holds the snapshot value (seeded above) —
            // tell subscribers their earlier optimistic value was replaced.
            superseded.forEach(function (k) {
                var raw = lsCache.get(k);
                var v = null;
                if (raw !== undefined) { try { v = JSON.parse(raw); } catch (e) { v = null; } }
                fireKeyChange(k, v);
            });
            console.warn('[Arcade SDK] state written before Arcade.ready was superseded by stored data ('
                + superseded.join(', ') + ') — await Arcade.ready before touching state in framed mode.');
        }
    }

    // Request/response over postMessage for the async storage APIs
    // (Arcade.store / Arcade.files / Arcade.storage) in bridged mode. The
    // launcher answers with arcade:bridge.result carrying the same id.
    var rpcSeq = 0;
    var rpcPending = {};
    var RPC_TIMEOUT_MS = 30000;
    function bridgeRpc(msgType, fields) {
        return readyPromise.then(function () {
            if (!framed) {
                throw new Error('Arcade: storage bridge unavailable — no launcher answered this frame');
            }
            return new Promise(function (resolve, reject) {
                var id = 'r' + (++rpcSeq);
                var timer = setTimeout(function () {
                    delete rpcPending[id];
                    reject(new Error('Arcade: launcher did not answer ' + msgType));
                }, RPC_TIMEOUT_MS);
                rpcPending[id] = { resolve: resolve, reject: reject, timer: timer };
                var msg = { type: msgType, id: id };
                for (var k in fields) {
                    if (Object.prototype.hasOwnProperty.call(fields, k)) msg[k] = fields[k];
                }
                postToParent(msg);
            });
        });
    }
    function resolveReady() {
        if (readyResolved) return;
        readyResolved = true;
        readyResolve();
    }
    function onMessage(e) {
        if (e.source !== window.parent) return;
        // Origin rules by mode. Direct mode keeps the same-origin requirement
        // (a hostile page embedding this game must not be able to pose as the
        // launcher and reach the peer bridge). Bridged mode runs in an
        // OPAQUE-origin frame — our own origin is the useless string "null",
        // and whichever parent mounted us sandboxed is by definition our
        // storage custodian (there is no pre-existing data here to leak) —
        // so we pin the first welcome's origin and require it thereafter.
        if (parentOrigin !== null) {
            if (e.origin !== parentOrigin) return;
        } else if (storageMode === 'bridged') {
            if (!(e.data && e.data.type === 'arcade:welcome')) return;
        } else {
            if (e.origin !== window.location.origin) return;
        }
        var data = e.data;
        if (!data || typeof data !== 'object') return;
        var t = data.type;
        if (typeof t !== 'string' || t.indexOf(MSG_PREFIX) !== 0) return;
        if (devModeOn()) console.debug('[Arcade ' + (gameId || '?') + ' ←]', data);

        switch (t) {
            case 'arcade:welcome':
                if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
                // A welcome that lands AFTER the handshake timeout already
                // resolved ready as standalone flips context.framed mid-
                // session (#41). Launcher mounts are deterministic (bridged
                // frames wait 2s and the launcher answers in ms) — this is
                // the legacy same-origin-embed path. Observable via
                // onFramedChange rather than silent.
                var lateWelcome = readyResolved && !framed;
                // A SECOND welcome (launcher bug, or a hostile same-origin parent
                // in direct mode) must not re-seed the cache — that would clobber
                // live local writes with the stale snapshot — nor re-resolve ready.
                var dupWelcome = welcomedOnce;
                if (dupWelcome) {
                    console.warn('[Arcade SDK] duplicate arcade:welcome ignored for storage; refreshing live launcher state only.');
                }
                framed = true;
                parentOrigin = e.origin;
                setPeerStatus(typeof data.peerStatus === 'string' ? data.peerStatus : 'idle');
                if (Array.isArray(data.caps)) {
                    peerCaps = data.caps.filter(function (c) { return typeof c === 'string'; });
                }
                // Bridged: seed the storage cache from the launcher's
                // snapshot BEFORE ready resolves, so post-ready reads see
                // real state. Must precede resolveReady().
                if (storageMode === 'bridged' && !dupWelcome) seedInitialSnapshot(data.state);
                refreshDevMode(); // snapshot may carry _meta.dev
                applyRoster(data.peers);
                if (applySettings(data.settings)) fire(listeners.settingsChange, snapshotSettings());
                if (!dupWelcome) resolveReady();
                welcomedOnce = true;
                if (lateWelcome && !dupWelcome) fire(listeners.framedChange, true);
                break;
            case 'arcade:peer.message': {
                if (data.payload && typeof data.payload === 'object' && data.payload.__arcadeBlob) {
                    handleBlobChunk(data.payload.__arcadeBlob, data.fromPeer);
                    break;
                }
                if (data.payload && typeof data.payload === 'object' && data.payload.__arcadeBlobAbort) {
                    handleBlobAbort(data.payload.__arcadeBlobAbort, data.fromPeer);
                    break;
                }
                if (data.payload && typeof data.payload === 'object' && data.payload.__arcadeReq) {
                    handlePeerRequest(data.payload.__arcadeReq, data.fromPeer);
                    break;
                }
                if (data.payload && typeof data.payload === 'object' && data.payload.__arcadeReqReply) {
                    handlePeerReqReply(data.payload.__arcadeReqReply);
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
                // Bridged: the launcher sends the game's fresh post-import
                // snapshot along — replace the cache wholesale first, so the
                // listener replay below reads the new world.
                if (storageMode === 'bridged' && data.state && typeof data.state === 'object') {
                    lsCache.clear();
                    Object.keys(data.state).forEach(function (k) {
                        if (typeof data.state[k] === 'string') lsCache.set(k, data.state[k]);
                    });
                }
                refreshDevMode(); // the replaced snapshot may flip _meta.dev
                fire(listeners.stateReplaced);
                // Replay key-change subscriptions — storage events also fire,
                // but a launcher-driven event is more reliable across browsers.
                // Route through fireKeyChange for snapshot-safe iteration.
                keyChangeListeners.forEach(function (arr, k) {
                    fireKeyChange(k, readJSON(k));
                });
                break;
            case 'arcade:state.changed':
                // Bridged replacement for cross-document storage events: the
                // launcher pushes shared-key changes (global.*, _meta.dev)
                // made by the launcher or another frame.
                if (storageMode === 'bridged' && typeof data.key === 'string') {
                    var raw = (typeof data.value === 'string') ? data.value : null;
                    if (raw === null) lsCache['delete'](data.key);
                    else lsCache.set(data.key, raw);
                    if (data.key === DEV_KEY) refreshDevMode();
                    var parsed = null;
                    if (raw !== null) { try { parsed = JSON.parse(raw); } catch (err) { parsed = null; } }
                    fireKeyChange(data.key, parsed);
                }
                break;
            case 'arcade:sync.conflict':
                // A concurrent local edit lost LWW to a remote replica write.
                // Informational; state was already updated by the sync engine.
                if (typeof data.key === 'string') {
                    fire(listeners.syncConflict, { key: data.key, mine: data.mine, theirs: data.theirs });
                }
                break;
            case 'arcade:state.writeError':
                // A bridged write failed to persist launcher-side (quota).
                // Mirrors the synchronous false/onStorageError of direct mode.
                if (typeof data.key === 'string') {
                    fireStorageError(data.key, new Error(
                        typeof data.error === 'string' ? data.error : 'launcher-side write failed'));
                }
                break;
            case 'arcade:bridge.result': {
                var pendingOp = rpcPending[data.id];
                if (!pendingOp) break;
                delete rpcPending[data.id];
                clearTimeout(pendingOp.timer);
                if (data.ok) pendingOp.resolve(data.value);
                else pendingOp.reject(new Error(
                    typeof data.error === 'string' ? data.error : 'Arcade: bridge operation failed'));
                break;
            }
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
        if (e.key === DEV_KEY) refreshDevMode(); // direct-mode ?dev toggle mid-session
        if (!keyChangeListeners.has(e.key)) return;
        var v = null;
        if (e.newValue !== null) {
            try { v = JSON.parse(e.newValue); } catch (err) { v = null; }
        }
        fireKeyChange(e.key, v);
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
            // Opaque-origin frames have no CacheStorage access (and no SW) —
            // nothing to inspect, nothing to collide with.
            if (storageMode === 'bridged') return;
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

    // ─── Sandboxed-frame service-worker shim ──────────────────────
    // Game pages register their own service workers for standalone offline
    // support (GAME_INTEGRATION §10). In a sandboxed frame the
    // navigator.serviceWorker GETTER itself throws SecurityError, which
    // detonates boot scripts written before the opaque-frame move. Shadow it
    // with an inert stub: register() rejects (catchable), lookups resolve
    // empty, `ready` never settles (a SW will never control this frame).
    function shimServiceWorkerForSandbox() {
        try {
            var stub = {
                register: function () {
                    return Promise.reject(new Error(
                        'service workers are unavailable in launcher-sandboxed frames; standalone visits still register yours'));
                },
                getRegistration: function () { return Promise.resolve(undefined); },
                getRegistrations: function () { return Promise.resolve([]); },
                startMessages: function () {},
                addEventListener: function () {},
                removeEventListener: function () {},
                dispatchEvent: function () { return false; },
                controller: null,
                oncontrollerchange: null,
                onmessage: null,
                onmessageerror: null,
                ready: new Promise(function () {})
            };
            Object.defineProperty(window.navigator, 'serviceWorker', {
                get: function () { return stub; },
                configurable: true
            });
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

        // Pick the storage mode before anything touches storage. An opaque
        // origin (launcher-sandboxed frame) cannot reach ANY origin storage —
        // all reads/writes go through the launcher bridge instead.
        if (!storageAccessible()) {
            storageMode = 'bridged';
            lsCache = new Map();
            pendingWrites = [];
            shimServiceWorkerForSandbox();
        }

        honorDevQueryParam();
        refreshDevMode();
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
            // Opaque-origin frames can't name themselves as a targetOrigin
            // ('null' is not a valid target) — and the hello carries nothing
            // sensitive (gameId + version), so '*' is fine there. Direct mode
            // keeps the same-origin guarantee.
            window.parent.postMessage(
                { type: 'arcade:hello', gameId: gameId, version: VERSION },
                storageMode === 'bridged' ? '*' : window.location.origin
            );
        } catch (e) {}

        handshakeTimer = setTimeout(function () {
            handshakeTimer = null;
            // No welcome — assume standalone-in-iframe and unblock callers.
            // Bridged frames keep their pending-write queue armed: if a slow
            // launcher's welcome lands late, the queue still reconciles
            // (context.framed flips — the documented late-welcome caveat).
            framed = false;
            peerStatus = 'unavailable';
            resolveReady();
        }, storageMode === 'bridged' ? BRIDGED_HANDSHAKE_TIMEOUT_MS : HANDSHAKE_TIMEOUT_MS);

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
    // Sync opt-in (#28 Arcade.sync): keys written with { sync: true } are
    // listed (by full localStorage key) in arcade.v1.<gameId>._sync; the
    // launcher's sync engine only replicates keys on this list (or a list
    // containing '*' for "sync everything eligible"). Mirrors setKeyExportable
    // above rather than reusing _noExport — sync is opt-in, exportable is
    // opt-out, so they're independent sidecars.
    function syncListKey() { return gameKey('_sync'); }
    function setKeySyncable(fullKey, on) {
        var list = readJSON(syncListKey());
        if (!Array.isArray(list)) list = [];
        var i = list.indexOf(fullKey);
        if (on && i === -1 && list.indexOf('*') === -1) { list.push(fullKey); writeJSON(syncListKey(), list); }
        else if (!on && i !== -1) { list.splice(i, 1); writeJSON(syncListKey(), list.length ? list : undefined); }
    }
    function runMigration(version, fn) {
        var sentinel = migratedSentinelKey(version);
        if (readJSON(sentinel) === true) return false;
        migrationBlockedByBridge = false;
        try { fn(); }
        catch (e) {
            console.error('[Arcade SDK] migration "' + version + '" threw:', e);
            return false;
        }
        if (migrationBlockedByBridge) {
            // A pre-namespace adopt() couldn't reach its legacy key in this
            // opaque frame. Withhold the sentinel so the migration re-runs and
            // completes on a later standalone visit — burning it here would
            // orphan the legacy save permanently (that's the whole bug).
            console.warn('[Arcade SDK] migration "' + version + '" deferred: pre-namespace legacy keys are only reachable on a standalone visit to this game, not inside the launcher frame.');
            return false;
        }
        writeJSON(sentinel, true);
        return true;
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
                if (opts && typeof opts.sync === 'boolean') setKeySyncable(k, opts.sync);
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
                // Store and return independent copies — returning `defaults` by
                // reference lets a caller's later mutation silently rewrite the
                // shared default object it passed in.
                writeJSON(k, defaults);
                fireKeyChange(k, defaults);
                try { return JSON.parse(JSON.stringify(defaults)); } catch (e) { return defaults; }
            }
            if (isPlainObject(defaults) && isPlainObject(current)) {
                var merged = deepMerge(defaults, current);
                // Persist newly-added default fields so a plain state.get(key)
                // afterwards returns the merged shape, not the unmerged stored
                // value (callers otherwise must use getOrInit forever).
                try {
                    if (JSON.stringify(merged) !== JSON.stringify(current)) {
                        writeJSON(k, merged);
                        fireKeyChange(k, merged);
                    }
                } catch (e) {}
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
            // Bridged mode before the snapshot: the sentinel AND the data the
            // callback would read haven't arrived — running now would re-run
            // completed migrations against empty state. Defer to post-welcome;
            // games call migrate() before their own ready.then(boot), so FIFO
            // ordering still runs the migration before boot code.
            if (storageMode === 'bridged' && !snapshotSeeded) {
                readyPromise.then(function () { runMigration(version, fn); });
                return false; // deferred — result unknowable synchronously
            }
            return runMigration(version, fn);
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
            var k = gameKey(targetKey);
            if (storageMode === 'bridged') {
                // The legacy (non-namespaced) key lives in the REAL origin's
                // localStorage, which this opaque-origin frame cannot read. If
                // the namespaced target already holds a value, a prior standalone
                // adopt already moved it — nothing to do. Otherwise we genuinely
                // can't complete here: flag it so the enclosing migrate()
                // withholds its sentinel (see runMigration) rather than marking
                // the migration done and orphaning the legacy save.
                if (readJSON(k) !== null) return true;
                migrationBlockedByBridge = true;
                if (!warnedAdoptBridged) {
                    warnedAdoptBridged = true;
                    console.warn('[Arcade SDK] state.adopt("' + legacyKey + '") cannot reach pre-namespace keys inside the launcher frame; it will complete on a standalone visit to this game.');
                }
                return false;
            }
            var raw;
            try { raw = localStorage.getItem(legacyKey); } catch (e) { return false; }
            if (raw === null) return false;
            var existing;
            try { existing = rawGet(k); } catch (e) { existing = null; }
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
        },
        // True if a value is stored for key (distinguishes absent from a stored
        // null, which state.get() cannot).
        has: function (key) {
            ensureGameId();
            return rawGet(gameKey(key)) !== null;
        },
        // Enumerate this game's own stored keys (unprefixed) — for slot pickers,
        // debug dumps, etc. SDK-internal keys (_migrated, _noExport, _meta) are
        // excluded.
        keys: function () {
            ensureGameId();
            var prefix = gameKey('');
            var out = [];
            var take = function (k) {
                if (k.indexOf(prefix) !== 0) return;
                var sub = k.slice(prefix.length);
                if (sub && sub.charAt(0) !== '_') out.push(sub);
            };
            if (storageMode === 'bridged') {
                lsCache.forEach(function (v, k) { take(k); });
            } else {
                try {
                    for (var i = 0; i < localStorage.length; i++) {
                        var k = localStorage.key(i);
                        if (k) take(k);
                    }
                } catch (e) {}
            }
            return out;
        }
    };

    // ─── Sync (Arcade.sync, #28) ────────────────────────────────────
    // Multi-device state replication over P2P (LWW). The SDK only writes the
    // per-app _sync opt-in list and exposes the conflict listener here — the
    // launcher-side sync engine (not yet present) does the actual replication,
    // so until that lands this is inert: writing the sidecar list has no
    // other effect.
    var syncApi = {
        // enable() → sync every current & future own key ('*'); enable(['k1','k2']) → those keys.
        enable: function (keys) {
            ensureGameId();
            if (keys === undefined) { writeJSON(syncListKey(), ['*']); return; }
            (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { setKeySyncable(gameKey(String(k)), true); });
        },
        disable: function (keys) {
            ensureGameId();
            if (keys === undefined) { writeJSON(syncListKey(), undefined); return; }
            (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { setKeySyncable(gameKey(String(k)), false); });
        },
        list: function () { ensureGameId(); var l = readJSON(syncListKey()); return Array.isArray(l) ? l.slice() : []; },
        // fn({ key, mine, theirs }) — a concurrent local edit lost LWW. Informational; state already updated.
        onConflict: makeSubscriber(listeners.syncConflict)
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
                // NOTE: true means "handed to the launcher", not delivered —
                // an unknown or just-departed target is dropped launcher-
                // side (postMessage is one-way, so its false can't reach
                // us). A game that needs delivery guarantees uses acks.
                if (typeof to !== 'string' || !to) return false;
                if (peerCaps.indexOf('peer.sendTo') === -1) return false;
                postToParent({ type: 'arcade:peer.send', payload: payload, to: to });
                return true;
            }
            postToParent({ type: 'arcade:peer.send', payload: payload });
            return true;
        },
        onMessage: makeSubscriber(listeners.peerMessage),

        // Request/response over the peer channel. request() sends a payload and
        // resolves with the peer's reply (or rejects on timeout/error); the
        // remote game answers by returning a value (or a Promise) from its
        // onRequest handler. opts.to targets one device (needs 'peer.sendTo');
        // opts.timeoutMs defaults to 10s. Correlation and cleanup are handled
        // here so games stop hand-rolling id+timeout+retry on top of send().
        request: function (payload, opts) {
            var to = (opts && typeof opts.to === 'string' && opts.to) ? opts.to : undefined;
            var timeoutMs = (opts && typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : 10000;
            var id = 'r' + (++reqSendCounter) + '-' + Date.now().toString(36);
            var frame = { __arcadeReq: { id: id, payload: payload } };
            var ok = to ? peerApi.send(frame, { to: to }) : peerApi.send(frame);
            if (!ok) return Promise.reject(new Error('Arcade.peer.request: no live connection' + (to ? ' to ' + to : '')));
            return new Promise(function (resolve, reject) {
                var timer = setTimeout(function () {
                    delete reqPending[id];
                    reject(new Error('Arcade.peer.request: timed out after ' + timeoutMs + 'ms'));
                }, timeoutMs);
                reqPending[id] = { resolve: resolve, reject: reject, timer: timer };
            });
        },
        // Register a responder: fn(payload, fromPeer) may return a value or a
        // Promise, which is sent back to the requester. Return undefined to let
        // another registered handler answer (or send a bare ack if none do).
        onRequest: makeSubscriber(listeners.peerRequest),

        // This device's stable identity — the same deviceId the launcher
        // uses for known peers / auto-reconnect. null until the launcher's
        // P2P layer has generated one (i.e. before the first ever pairing).
        self: function () {
            try {
                var id = rawGet(KEY_PREFIX + '_meta.deviceId');
                if (!id) return null;
                var name = rawGet(KEY_PREFIX + '_meta.deviceName');
                return { deviceId: id, name: name || 'My device' };
            } catch (e) { return null; }
        },
        // Most recently seen remote device ({ deviceId, name }) or null.
        // DEPRECATED single-peer convenience — prefer peers() (full roster,
        // multi-seat aware). Kept for older single-peer games; retired once the
        // legacy arcade:peer.identity wire message is dropped (all launchers now
        // send the peer.roster cap, which peers() reads).
        remote: function () {
            var best = null;
            for (var k in remotePeers) {
                if (!best || remotePeers[k].at > best.at) best = remotePeers[k];
            }
            return best ? { deviceId: best.deviceId, name: best.name } : null;
        },
        // Full peer roster: [{ deviceId, name, status, direct }], [] when no
        // session or on a launcher without the 'peer.roster' cap (an old
        // launcher's welcome seed would otherwise linger stale forever —
        // nothing there ever pushes updates). status is 'connected' |
        // 'interrupted'; a seat that's truly gone leaves the list. direct is
        // true when this device holds the direct link (a joiner's host).
        peers: function () {
            return peerCaps.indexOf('peer.roster') === -1 ? [] : rosterCopy();
        },
        // Fires with the full roster array on any join/leave/rename/status
        // change — one coarse event, not fine-grained add/remove.
        onPeersChange: makeSubscriber(listeners.peersChange),
        // Fires when the remote device has THIS game mounted and listening —
        // fn({ deviceId, name }). May fire more than once per session (both
        // sides announce); treat it as an idempotent "peer is ready" signal.
        // Replaces the hand-rolled hello/echo handshake games used to need.
        onReady: makeSubscriber(listeners.peerReady),

        // Send a Blob/File to the peer(s), chunked over the ordered channel.
        // Resolves { id, chunks, size } after the last chunk is handed to
        // the transport; opts.onProgress(fraction, sent, total) per chunk.
        // opts.to = a deviceId sends privately to that seat (needs the
        // 'peer.sendTo' cap); omit to broadcast to every connected peer.
        sendBlob: function (blob, opts) {
            if (!blob || typeof blob.arrayBuffer !== 'function') {
                return Promise.reject(new Error('Arcade.peer.sendBlob: pass a Blob or File'));
            }
            var onProgress = (opts && typeof opts.onProgress === 'function') ? opts.onProgress : null;
            var to = (opts && typeof opts.to === 'string' && opts.to) ? opts.to : null;
            var sendOne = to
                ? function (payload) { return peerApi.send(payload, { to: to }); }
                : function (payload) { return peerApi.send(payload); };
            var name = (opts && typeof opts.name === 'string' && opts.name) ? opts.name
                : (typeof blob.name === 'string' ? blob.name : '');
            return blob.arrayBuffer().then(function (buf) {
                var bytes = new Uint8Array(buf);
                var total = Math.max(1, Math.ceil(bytes.length / BLOB_CHUNK_BYTES));
                if (total > BLOB_MAX_CHUNKS) {
                    throw new Error('Arcade.peer.sendBlob: blob too large ('
                        + bytes.length + ' bytes; max ' + (BLOB_MAX_CHUNKS * BLOB_CHUNK_BYTES) + ')');
                }
                // Whole-blob hash rides every chunk so the receiver can
                // verify the assembled result (and never deliver a blob
                // stitched from a stale duplicate id). null on hosts
                // without SubtleCrypto — receiver skips the check then.
                return sha256Hex(buf).then(function (sha) { return { bytes: bytes, total: total, sha: sha }; });
            }).then(function (prep) {
                var bytes = prep.bytes, total = prep.total;
                var id = 'b' + (++blobSendCounter) + '-' + Date.now().toString(36);
                // Pace the send in small batches, yielding a macrotask between
                // them. Handing 2048 chunks to the transport in one synchronous
                // burst spikes the per-link replay outbox past its cap (forcing
                // a spurious resync) and makes onProgress fire 0→100% in a single
                // frame. Yielding lets the channel drain and progress render.
                var BLOB_SEND_BATCH = 8;
                function sendFrom(seq) {
                    var end = Math.min(seq + BLOB_SEND_BATCH, total);
                    for (var s = seq; s < end; s++) {
                        var chunk = bytes.subarray(s * BLOB_CHUNK_BYTES, (s + 1) * BLOB_CHUNK_BYTES);
                        var chunkMeta = {
                            id: id, seq: s, total: total, size: bytes.length,
                            mime: blob.type || '', name: name.slice(0, 128),
                            bytes: bytesToBase64(chunk)
                        };
                        if (prep.sha) chunkMeta.sha = prep.sha;
                        var ok = sendOne({ __arcadeBlob: chunkMeta });
                        if (!ok) {
                            // Chunks already handed off may still arrive — tell
                            // the receiver the rest never will, so it errors out
                            // instead of wedging. Best-effort: if the link is
                            // fully down this send fails too and the receiver's
                            // TTL is the backstop.
                            if (s > 0) sendOne({ __arcadeBlobAbort: { id: id } });
                            return Promise.reject(new Error('Arcade.peer.sendBlob: no live connection'
                                + (to ? ' to ' + to : '')));
                        }
                        if (onProgress) {
                            try { onProgress((s + 1) / total, s + 1, total); } catch (e) {}
                        }
                    }
                    if (end >= total) return { id: id, chunks: total, size: bytes.length };
                    return new Promise(function (res) { setTimeout(res, 0); }).then(function () { return sendFrom(end); });
                }
                return sendFrom(0);
            });
        },
        // fn(blob, { name, size, mime, fromPeer, id }) once a full blob has
        // been reassembled.
        onBlob: makeSubscriber(listeners.peerBlob),
        // fn({ id, name, reason, received, total, fromPeer }) when an
        // incoming transfer fails instead of completing. reason:
        //   'timeout'   — no chunk for 60s (sender queue overflowed, link
        //                 died without an abort, ...)
        //   'aborted'   — the sender explicitly gave up mid-transfer
        //   'integrity' — assembled bytes did not match the sender's hash
        // A failed transfer is dropped entirely; the sender should resend.
        onBlobError: makeSubscriber(listeners.peerBlobError),

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
            // Order sticks to the CATEGORY, not the call: a single add() that
            // forgets { order: 'asc' } on a time-based category would otherwise
            // resort the whole list descending and the cap would evict the best
            // (lowest) times. First add establishes it; a later mismatch warns.
            var requestedOrder = (opts && (opts.order === 'asc' || opts.order === 'desc')) ? opts.order : null;
            var ordersKey = gameKey('_scoreOrders');
            var orders = readJSON(ordersKey);
            if (!isPlainObject(orders)) orders = {};
            var order = orders[category];
            if (!order) {
                order = requestedOrder || 'desc';
                orders[category] = order;
                writeJSON(ordersKey, orders);
            } else if (requestedOrder && requestedOrder !== order) {
                console.warn('[Arcade SDK] scores.add("' + category + '"): order "' + requestedOrder
                    + '" ignored — this category was established as "' + order + '".');
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
        var startedAt = nowMs();
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
            if (pauseStartedAt === null) pauseStartedAt = nowMs();
        }
        function unfreezePause() {
            if (pauseStartedAt !== null) {
                accumPaused += nowMs() - pauseStartedAt;
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
                startedAt = nowMs();
                accumPaused = 0;
                pauseStartedAt = isPaused() ? startedAt : null;
            } else {
                tracker.reset();
            }
        });

        var tracker = {
            elapsedMs: function () {
                var paused = accumPaused;
                if (pauseStartedAt !== null) paused += nowMs() - pauseStartedAt;
                var ms = baseOffset + (nowMs() - startedAt - paused);
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
                startedAt = nowMs();
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
    // Bridged Arcade.store handle — same surface, ops ride the launcher
    // bridge. The launcher derives the real DB name from the FRAME's mounted
    // gameId (never from anything this side sends), so a store op can only
    // ever touch this app's own arcade.v1.<gameId>.store.* databases.
    function bridgedStoreHandle(name) {
        var n = (name === undefined || name === null) ? 'default' : String(name);
        if (!STORE_NAME_RE.test(n)) throw new Error('Arcade.store.open: name must match /^[a-z0-9_-]{1,64}$/');
        function op(fields) {
            fields.name = n;
            return bridgeRpc('arcade:store.op', fields);
        }
        return {
            get: function (key) {
                return op({ op: 'get', key: String(key) })
                    .then(function (v) { return v === undefined || v === null ? null : v; });
            },
            set: function (key, value) {
                return op({ op: 'set', key: String(key), value: value }).then(function () { return true; });
            },
            del: function (key) {
                return op({ op: 'del', key: String(key) }).then(function () { return true; });
            },
            keys: function () {
                return op({ op: 'keys' }).then(function (ks) { return Array.isArray(ks) ? ks : []; });
            },
            each: function (fn) {
                // Cursor semantics emulated over one entries round-trip —
                // bridged stores are small-to-medium; a paged cursor can come
                // later behind the same signature if that stops being true.
                return op({ op: 'entries' }).then(function (ents) {
                    if (!Array.isArray(ents)) return;
                    for (var i = 0; i < ents.length; i++) {
                        var ent = ents[i];
                        if (!ent) continue;
                        try { fn(ent[1], ent[0]); } catch (e) {}
                    }
                });
            },
            clear: function () {
                return op({ op: 'clear' }).then(function () { return true; });
            }
        };
    }
    var storeApi = {
        // open(name?) → a handle whose get/set/del/keys/each/clear all return
        // promises. Distinct names are fully isolated stores.
        open: function (name) {
            ensureGameId();
            if (storageMode === 'bridged') return bridgedStoreHandle(name);
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
            if (storageMode === 'bridged') {
                return bridgeRpc('arcade:files.op', { op: 'put', name: n, blob: blob })
                    .then(function () { return true; });
            }
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
            if (storageMode === 'bridged') {
                return bridgeRpc('arcade:files.op', { op: 'get', name: n })
                    .then(function (b) { return (b instanceof Blob) ? b : null; })
                    .catch(function () { return null; });
            }
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
            if (storageMode === 'bridged') {
                return bridgeRpc('arcade:files.op', { op: 'list' })
                    .then(function (l) { return Array.isArray(l) ? l : []; })
                    .catch(function () { return []; });
            }
            if (opfsAvailable()) {
                return opfsDir().then(function (dir) {
                    // values() is an async iterator of FileSystemHandles. Drive
                    // it with .then() recursion rather than `for await`, so the
                    // whole SDK stays parseable on engines without async
                    // iteration (the rest of this file is deliberately ES5).
                    var out = [];
                    var it = dir.values();
                    function step() {
                        return it.next().then(function (res) {
                            if (res.done) return out;
                            var h = res.value;
                            if (h && h.kind === 'file') {
                                return h.getFile().then(function (f) {
                                    out.push({ name: h.name, size: f.size });
                                    return step();
                                });
                            }
                            return step();
                        });
                    }
                    return step();
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
            if (storageMode === 'bridged') {
                return bridgeRpc('arcade:files.op', { op: 'delete', name: n })
                    .then(function (r) { return r !== false; })
                    .catch(function () { return false; });
            }
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
        // Bridged mode proxies these to the launcher — storage was always
        // origin-wide, so the launcher's numbers ARE this app's numbers.
        estimate: function () {
            if (storageMode === 'bridged') {
                return bridgeRpc('arcade:storage.op', { op: 'estimate' })
                    .catch(function () { return { usage: undefined, quota: undefined }; });
            }
            if (navigator.storage && navigator.storage.estimate) {
                return navigator.storage.estimate();
            }
            return Promise.resolve({ usage: undefined, quota: undefined });
        },
        persisted: function () {
            if (storageMode === 'bridged') {
                return bridgeRpc('arcade:storage.op', { op: 'persisted' })
                    .then(function (v) { return v === true; })
                    .catch(function () { return false; });
            }
            if (navigator.storage && navigator.storage.persisted) {
                return navigator.storage.persisted();
            }
            return Promise.resolve(false);
        },
        persist: function () {
            if (storageMode === 'bridged') {
                return bridgeRpc('arcade:storage.op', { op: 'persist' })
                    .then(function (v) { return v === true; })
                    .catch(function () { return false; });
            }
            if (navigator.storage && navigator.storage.persist) {
                return navigator.storage.persist();
            }
            return Promise.resolve(false);
        }
    };

    // ─── Public surface ───────────────────────────────────────────
    var api = {
        init: init,
        get ready() {
            // A game that awaits Arcade.ready without ever calling Arcade.init()
            // would hang forever (readyPromise only settles via init's handshake
            // or timeout). Warn once so the missing init() is obvious.
            if (!initialized && !warnedReadyPreInit) {
                warnedReadyPreInit = true;
                console.warn('[Arcade SDK] Arcade.ready accessed before Arcade.init() — it will not resolve until you call Arcade.init({ gameId }).');
            }
            return readyPromise;
        },
        get context() {
            return {
                framed: framed, version: VERSION, gameId: gameId, suspended: suspendedNow,
                // 'direct'  — this document owns its origin storage.
                // 'bridged' — opaque-origin frame, storage rides the launcher.
                // 'memory'  — opaque-origin frame and no launcher answered:
                //             state lives for this session only.
                storage: storageMode === 'direct' ? 'direct' : (framed ? 'bridged' : 'memory')
            };
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
        sync: syncApi,
        // Deterministic seeded RNG for lockstep/turn-based multiplayer. Both
        // devices seed from the same value to produce identical sequences:
        //   const rng = Arcade.random.seeded(gameCode);
        //   rng() → [0,1)   rng.int(1,6)   rng.pick(arr)   rng.shuffle(arr)
        random: { seeded: makeSeededRandom }, // legacy alias — prefer Arcade.rng
        // Determinism & sharing helpers (#37). Feature-detect with
        // `typeof Arcade.rng === 'function'` — all purely local, no caps/wire.
        rng: rngApi,     // stateful mulberry32 (.int/.pick/.shuffle/.getState/.setState); rng.hash = FNV-1a
        daily: dailyApi, // dateStr() = device-LOCAL YYYY-MM-DD (the platform rule); seed(salt) per-game daily rng
        share: shareApi, // versioned base64url codes; decode validates, returns null on any garbage
        loop: function (fn) { ensureGameId(); return createLoop(fn); },
        onSuspend: makeSubscriber(listeners.suspend),
        onResume: makeSubscriber(listeners.resume),
        onStateReplaced: makeSubscriber(listeners.stateReplaced),
        onSettingsChange: makeSubscriber(listeners.settingsChange),
        // Fires (with the new value of context.framed) if framed flips AFTER
        // Arcade.ready — i.e. a launcher welcome that lost the handshake race
        // (legacy same-origin embeds only; launcher-sandboxed frames resolve
        // ready deterministically). Games that branch on context.framed at
        // boot can re-run that branch here instead of missing the flip.
        onFramedChange: makeSubscriber(listeners.framedChange),
        // Fired when a localStorage write fails (typically quota). Returns an
        // unsubscribe fn. Data was NOT saved — warn the user / shed load.
        onStorageError: makeSubscriber(storageErrorListeners)
    };

    Object.defineProperty(window, 'Arcade', {
        value: api,
        writable: false,
        configurable: false
    });
})();
