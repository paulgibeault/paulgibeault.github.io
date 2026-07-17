/* arcade-pool.js — the bounded LRU iframe pool + game-view lifecycle.
 *
 * Extracted verbatim from index.html's platformController; the behavior
 * contract is tools/acceptance.mjs --pool plus the eviction-flush check in
 * tools/bridge-acceptance.mjs. Owns: mounting sandboxed game frames
 * (ensureIframe), MRU promotion + activation (showGame), LRU eviction with
 * the #41 flush grace (evictLRU + the `retiring` set), the loading-veil /
 * error-card overlay keyed on the arcade:hello handshake, and the #app=
 * fragment mirror.
 *
 * SECURITY ANCHORS (the message router in arcade-router.js builds on these):
 *   - Frames mount sandboxed WITHOUT allow-same-origin, so they run with an
 *     OPAQUE origin and cannot open ANY of this origin's storage (issue #43).
 *   - findPoolEntryForSource is the router's frame-identity test: a window
 *     is routable ONLY if it is the contentWindow of a frame this module
 *     mounted — including, for RETIRE_GRACE_MS after eviction, frames still
 *     in the `retiring` set, so a suspend-time flush lands.
 *
 * initIframePool(host) looks up the launcher's game-view DOM (this module
 * only runs on index.html) and returns the pool API. `host` supplies the
 * launcher-owned glue (see index.html's window.__arcade.poolHost):
 *   devModeOn()          — dev-tracing flag for outbound postMessage logs
 *   readGlobal(key, fb)  — JSON-encoded arcade.v1.global.* reader
 *   clearGameUi(gameId)  — drop UI-bridge state (quit hook) for a dead frame
 *   closeLauncherMenu()  — close the shared launcher menu panel
 * No top-level side effects — all DOM lookups and wiring happen inside init.
 */

export function initIframePool(host) {
    const iframeHost = document.getElementById('iframe-host');
    const topbarTitle = document.getElementById('game-topbar-title');
    const viewGame = document.getElementById('view-game');

    // ---- iframe pool ----
    // Map insertion order = recency; re-inserting on showGame promotes to MRU.
    // Pool is bounded by readPoolCap(): user-tunable 1..gameCount via the
    // launcher menu (gameCount = launcher buttons; cap=gameCount disables
    // eviction since pool size can't exceed it). Eviction zeroes the iframe
    // (about:blank) and removes it from the DOM, freeing the JS heap, audio
    // context, and WebGL context. Persistent state lives in
    // arcade.v1.<gameId>.* localStorage and survives.
    const pool = new Map(); // gameId -> { iframe, name }
    // Games that completed the arcade:hello handshake — i.e. games whose
    // SDK is actually listening. Presence announcements to the remote
    // launcher are made only for these.
    const helloedGames = new Set();
    let activeGameId = null;
    const POOL_CAP_DEFAULT = 2;

    function readPoolCap() {
        const n = Math.floor(Number(host.readGlobal('poolCap', POOL_CAP_DEFAULT)));
        return isFinite(n) && n >= 1 ? n : POOL_CAP_DEFAULT;
    }

    // Evicted-but-flushing frames: still routable for the grace window.
    const RETIRE_GRACE_MS = 250;
    const retiring = new Set(); // { gameId, entry }

    function evictLRU(opts) {
        const cap = readPoolCap();
        // makingRoom = caller is about to add a new entry, so target size
        // is cap - 1. On a settings change with no insert pending, target
        // is the cap itself.
        const target = (opts && opts.makingRoom) ? cap - 1 : cap;
        // The currently-active game is protected — except when launching
        // a NEW game that is about to take over as active. In that case
        // the caller passes newActiveId so the *outgoing* active is
        // evictable (otherwise cap=1 launches would leak a stale entry).
        const protectedId = (opts && opts.newActiveId) || activeGameId;
        while (pool.size > target) {
            let lruId = null;
            for (const gid of pool.keys()) {
                if (gid !== protectedId) { lruId = gid; break; }
            }
            if (!lruId) return;  // only the protected entry remains — never evict it
            const entry = pool.get(lruId);
            // Flush hint, then a GRACE before the destructive teardown
            // (#41): postMessage is async, so navigating to about:blank
            // in the same tick used to guarantee the suspend hint was
            // never processed. The frame gets RETIRE_GRACE_MS to run its
            // suspend handler and flush through the storage bridge —
            // `retiring` keeps it addressable to the message router
            // (pool membership is the router's trust test) while the
            // pool slot itself frees synchronously, so cap math and an
            // instant same-game relaunch behave exactly as before.
            postToIframe(lruId, { type: 'arcade:lifecycle.suspend' });
            const retiree = { gameId: lruId, entry };
            retiring.add(retiree);
            setTimeout(() => {
                retiring.delete(retiree);
                try { entry.iframe.src = 'about:blank'; } catch (e) {}
                entry.iframe.remove();
            }, RETIRE_GRACE_MS);
            pool.delete(lruId);
            helloedGames.delete(lruId);
            // UI bridge state (quit hook) dies with the frame — a fresh
            // mount re-registers after its handshake.
            host.clearGameUi(lruId);
        }
    }

    function ensureIframe(gameId, src, name) {
        let entry = pool.get(gameId);
        if (entry) return entry;
        evictLRU({ makingRoom: true, newActiveId: gameId });
        const iframe = document.createElement('iframe');
        iframe.src = src;
        iframe.dataset.gameId = gameId;
        // No allow-same-origin: games run with an OPAQUE origin, so they
        // cannot open ANY of this origin's storage — other apps' state,
        // and above all the P2P key stores (qrp2p-identity /
        // qrp2p-rendezvous, non-extractable but usable). This is the
        // first-party trust boundary made real (issue #43); their own
        // persistence rides the storage bridge below instead.
        iframe.setAttribute('sandbox', 'allow-scripts allow-downloads');
        // Opaque origin no longer matches the default 'self' permissions-
        // policy allowlists — grant the game-relevant features explicitly.
        // clipboard-write lets Arcade.ui.copy() work IN-frame (#35): the
        // launcher-side route fails Chrome's document-focus rule, since
        // during a game click it's the iframe that holds focus.
        iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad; screen-wake-lock; clipboard-write');
        iframe.setAttribute('allowfullscreen', '');
        iframe.setAttribute('title', name);
        iframe.hidden = true;
        iframeHost.appendChild(iframe);
        entry = { iframe, name, src };
        pool.set(gameId, entry);
        return entry;
    }

    // Deep links (#36): keep the URL fragment mirroring the active game so
    // a copied/bookmarked URL reopens straight into it. replaceState, not
    // location.hash — no history spam, no hashchange feedback loop. The
    // boot-time parse lives in the catalog module block (it needs the
    // id → url map, and only ids from the catalog are ever honored).
    function setAppFragment(gameId) {
        try {
            const base = location.pathname + location.search;
            history.replaceState(null, '', gameId ? base + '#app=' + encodeURIComponent(gameId) : base);
        } catch (e) {}
    }

    function showGame(gameId, src, name) {
        const entry = ensureIframe(gameId, src, name);
        // Promote to MRU by re-inserting at the end of the Map's order.
        if (pool.has(gameId) && [...pool.keys()].pop() !== gameId) {
            pool.delete(gameId);
            pool.set(gameId, entry);
        }
        const previousGameId = activeGameId;
        for (const [gid, e] of pool) {
            e.iframe.hidden = (gid !== gameId);
        }
        activeGameId = gameId;
        // A pooled frame keeps its Arcade.ui.setTitle title across
        // launcher round-trips; eviction (fresh entry) naturally resets.
        topbarTitle.textContent = entry.customTitle || name || "Paul's Arcade";

        document.body.classList.add('app-in-game');
        viewGame.classList.remove('hidden');
        // Show a loading veil until this game's SDK handshake lands (or a
        // timeout flips to an error card) — a 404 or offline launch is
        // otherwise just a black frame with a quit button.
        beginGameLoad(gameId, name);

        // Lifecycle: suspend prior game (if any) and resume the new one.
        if (previousGameId && previousGameId !== gameId) {
            postToIframe(previousGameId, { type: 'arcade:lifecycle.suspend' });
        }
        postToIframe(gameId, { type: 'arcade:lifecycle.resume' });

        // Defer focus so the iframe receives keyboard input.
        setTimeout(() => { try { entry.iframe.focus(); } catch (e) {} }, 0);
        setAppFragment(gameId);
    }

    function hideGameView() {
        viewGame.classList.add('hidden');
        document.body.classList.remove('app-in-game');
        hideGameOverlays();
        // Iframes stay mounted (hidden) — instant relaunch + state preserved.
        const previousGameId = activeGameId;
        for (const e of pool.values()) e.iframe.hidden = true;
        activeGameId = null;
        if (previousGameId) {
            postToIframe(previousGameId, { type: 'arcade:lifecycle.suspend' });
        }
        setAppFragment(null);
    }

    // ---- game loading / error overlay (G-ux-1) ----
    const gameLoading = document.getElementById('game-loading');
    const gameLoadingMsg = document.getElementById('game-loading-msg');
    const gameError = document.getElementById('game-error');
    const gameErrorMsg = document.getElementById('game-error-msg');
    let gameLoadTimer = null;
    const GAME_LOAD_TIMEOUT_MS = 12000;
    function showGameOverlay(which) {
        gameLoading.classList.toggle('hidden', which !== 'loading');
        gameError.classList.toggle('hidden', which !== 'error');
    }
    function hideGameOverlays() {
        showGameOverlay(null);
        if (gameLoadTimer) { clearTimeout(gameLoadTimer); gameLoadTimer = null; }
    }
    function beginGameLoad(gameId, name) {
        // A warm, already-handshaken pooled frame needs no veil (instant relaunch).
        if (helloedGames.has(gameId)) { hideGameOverlays(); return; }
        gameLoadingMsg.textContent = 'Loading ' + (name || 'game') + '…';
        showGameOverlay('loading');
        if (gameLoadTimer) clearTimeout(gameLoadTimer);
        gameLoadTimer = setTimeout(() => {
            gameLoadTimer = null;
            if (activeGameId === gameId && !helloedGames.has(gameId)) {
                gameErrorMsg.textContent = (name || 'This game') + " didn't load.";
                showGameOverlay('error');
            }
        }, GAME_LOAD_TIMEOUT_MS);
    }
    // Called from the arcade:hello handler once a game's SDK checks in.
    function onGameHelloed(gameId) {
        if (gameId === activeGameId) hideGameOverlays();
    }
    document.getElementById('game-error-retry').addEventListener('click', () => {
        const gid = activeGameId;
        const entry = gid && pool.get(gid);
        if (!entry) return;
        helloedGames.delete(gid);
        // The reloaded document starts from scratch — stale quit hook and
        // custom title must not survive it.
        host.clearGameUi(gid);
        entry.customTitle = '';
        beginGameLoad(gid, entry.name);
        try { entry.iframe.src = entry.src || entry.iframe.src; } catch (e) {}
    });
    document.getElementById('game-error-back').addEventListener('click', () => {
        host.closeLauncherMenu();
        hideGameView();
    });

    // ---- routing primitives ----
    function findPoolEntryForSource(src) {
        for (const [gid, entry] of pool) {
            if (entry.iframe.contentWindow === src) return [gid, entry];
        }
        // Evicted frames stay routable during their retire grace so a
        // suspend-time flush lands (matched by contentWindow identity —
        // a relaunched same-gameId frame is a different window).
        for (const r of retiring) {
            if (r.entry.iframe.contentWindow === src) return [r.gameId, r.entry];
        }
        return [null, null];
    }

    function postToIframe(gameId, msg) {
        const entry = pool.get(gameId);
        if (!entry || !entry.iframe.contentWindow) return;
        if (host.devModeOn()) console.debug('[Arcade launcher → ' + gameId + ']', msg);
        // '*' because an opaque origin can't be named as a targetOrigin.
        // The recipient is a frame WE created and sandboxed; the residual
        // (a frame that self-navigated away receiving game-scoped
        // messages) requires code execution inside the frame — the same
        // capability the bridge already grants that gameId.
        entry.iframe.contentWindow.postMessage(msg, '*');
    }

    function broadcast(msg) {
        for (const [gid] of pool) postToIframe(gid, msg);
    }

    // An app-set topbar title (Arcade.ui.setTitle). Stored on the pool
    // entry so it survives launcher round-trips while the frame is warm;
    // empty string means "back to the catalog name".
    function setGameTitle(gameId, title) {
        const entry = pool.get(gameId);
        if (!entry) return;
        entry.customTitle = title || '';
        if (gameId === activeGameId) {
            topbarTitle.textContent = entry.customTitle || entry.name || "Paul's Arcade";
        }
    }

    return {
        showGame: showGame,
        hideGameView: hideGameView,
        // A no-arg call trims the pool to the stored cap (settings change);
        // internal callers pass { makingRoom, newActiveId }.
        applyPoolCap: evictLRU,
        onGameHelloed: onGameHelloed,
        postToIframe: postToIframe,
        broadcast: broadcast,
        findPoolEntryForSource: findPoolEntryForSource,
        setGameTitle: setGameTitle,
        mountedGameIds: () => [...pool.keys()],
        has: (gameId) => pool.has(gameId),
        isHelloed: (gameId) => helloedGames.has(gameId),
        markHelloed: (gameId) => { helloedGames.add(gameId); },
        getActiveGameId: () => activeGameId,
        getGameName: (gameId) => { const e = pool.get(gameId); return e ? (e.name || '') : ''; },
        // name + src for toast/relaunch affordances — never the entry itself,
        // so nothing outside this module can touch a frame handle.
        getGameInfo: (gameId) => { const e = pool.get(gameId); return e ? { name: e.name, src: e.src } : null; }
    };
}
