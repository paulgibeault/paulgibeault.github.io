/* arcade-records.js — the launcher's Records sheet (issue #12). A modal, tabbed
 * by catalog game, showing every game's leaderboards (Arcade.scores) and
 * personal records (Arcade.records, #9). It reads game data straight from
 * launcher-origin localStorage: games run in opaque-origin frames, so the
 * launcher owns the keyspace and no postMessage round-trip is needed. Zero
 * per-game code — the tabs come from catalog.json and records are
 * self-describing.
 *
 * House init*(host) capability-injection idiom (arcade-catalog.js,
 * arcade-save.js). All rendering is DOM-API-only (createElement/textContent):
 * every value read is untrusted game-written data, so nothing is ever
 * interpolated into innerHTML.
 */
import {
    collectGameData, countPopulated, resetKeysFor, relevantKey, isRemoteEntry,
    formatRecordValue, formatScore, formatDate, prettifyCategory
} from './arcade-records-core.js';

export function initRecords(host) {
    host = host || {};
    const store = host.store || window.localStorage;

    const dialog = document.getElementById('records-dialog');
    const panel = dialog && dialog.querySelector('.records-dialog__panel');
    const tabsEl = document.getElementById('records-dialog-tabs');
    const bodyEl = document.getElementById('records-dialog-body');
    const closeBtn = document.getElementById('records-dialog-close');
    const resetBtn = document.getElementById('records-dialog-reset');
    // Degrade to inert no-ops if the shell markup is missing — never throw at
    // wire time and break the rest of the launcher module block.
    if (!dialog || !tabsEl || !bodyEl) {
        return { open() {}, close() {}, isOpen: () => false, noteStateWritten() {} };
    }

    let games = [];            // catalog snapshot taken at open()
    let activeId = null;       // currently selected game id
    let debounceTimer = null;

    function catalogGames() {
        const c = host.getCatalog ? host.getCatalog() : null;
        return Array.isArray(c) ? c : [];
    }
    function gameById(id) { return games.find((g) => g.id === id) || null; }
    function gameName(game) { return (game && (game.name || game.id)) || ''; }
    function myDeviceId() {
        try { return store.getItem('arcade.v1._meta.deviceId'); } catch (e) { return null; }
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    const MEDALS = ['🥇', '🥈', '🥉'];
    function rankLabel(i) { return MEDALS[i] || ('#' + (i + 1)); }
    function sectionHeading(glyph, text) {
        const h = el('h3', 'records-section__heading');
        h.appendChild(el('span', 'records-section__glyph', glyph));
        h.appendChild(el('span', null, text));
        return h;
    }

    // ---- rendering ----
    function renderTabs() {
        tabsEl.textContent = '';
        for (const game of games) {
            const count = countPopulated(collectGameData(store, game.id));
            const isActive = game.id === activeId;
            const tab = el('button', 'records-tab'
                + (count === 0 ? ' records-tab--empty' : '')
                + (isActive ? ' records-tab--active' : ''));
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
            tab.tabIndex = isActive ? 0 : -1;   // roving tabindex
            tab.dataset.gameId = game.id;
            if (game.icon) {
                const img = el('img', 'records-tab__icon');
                img.src = game.icon;
                img.alt = '';
                img.setAttribute('aria-hidden', 'true');
                tab.appendChild(img);
            }
            tab.appendChild(el('span', 'records-tab__label', gameName(game)));
            if (count > 0) tab.appendChild(el('span', 'records-tab__badge', String(count)));
            tab.addEventListener('click', () => selectTab(game.id));
            tabsEl.appendChild(tab);
        }
    }

    function renderBody() {
        bodyEl.textContent = '';
        const game = gameById(activeId);
        if (!game) {
            bodyEl.appendChild(el('p', 'records-empty', 'No game selected.'));
            resetBtn.hidden = true;
            return;
        }
        const data = collectGameData(store, game.id);
        const populated = countPopulated(data) > 0;
        resetBtn.hidden = !populated;

        if (!populated) {
            const empty = el('div', 'records-empty');
            empty.appendChild(el('div', 'records-empty__glyph', '🏆'));
            empty.appendChild(el('p', 'records-empty__msg', 'No records yet for ' + gameName(game) + '.'));
            empty.appendChild(el('p', 'records-empty__sub', 'Play a round to set your first personal best.'));
            const play = el('button', 'records-empty__play', '▶  Play ' + gameName(game));
            play.type = 'button';
            play.addEventListener('click', () => {
                close();
                if (host.openGame) host.openGame(game);
            });
            empty.appendChild(play);
            bodyEl.appendChild(empty);
            return;
        }

        // Personal records first (the headline trophies), then leaderboards.
        // Stats are intentionally not shown in v1 (blobs aren't self-describing
        // — issue #12 lean).
        if (data.records.length) {
            bodyEl.appendChild(sectionHeading('🏅', 'Personal records'));
            const grid = el('div', 'records-cards');
            for (const r of data.records) {
                const card = el('div', 'records-card');
                const head = el('div', 'records-card__head');
                head.appendChild(el('span', 'records-card__trophy', '🏆'));
                head.appendChild(el('span', 'records-card__label', r.record.label || prettifyCategory(r.category)));
                card.appendChild(head);
                card.appendChild(el('div', 'records-card__value', formatRecordValue(r.record.value, r.record.format)));
                const when = formatDate(r.record.ts);
                if (when) card.appendChild(el('div', 'records-card__date', 'Set ' + when));
                grid.appendChild(card);
            }
            bodyEl.appendChild(grid);
        }
        if (data.scores.length) {
            bodyEl.appendChild(sectionHeading('📊', 'Leaderboards'));
            const myDev = myDeviceId();
            const anyShared = data.scores.some((b) => b.entries.some((e) => isRemoteEntry(e, myDev)));
            if (anyShared) bodyEl.appendChild(el('p', 'records-shared-note', '🔗 Shared across your linked devices'));
            const grid = el('div', 'records-boards');
            for (const board of data.scores) {
                const wrap = el('div', 'records-board');
                wrap.appendChild(el('h4', 'records-board__title', prettifyCategory(board.category)));
                board.entries.forEach((entry, i) => {
                    const remote = isRemoteEntry(entry, myDev);
                    const row = el('div', 'records-board__row' + (i === 0 ? ' records-board__row--top' : '') + (remote ? ' records-board__row--linked' : ''));
                    row.appendChild(el('span', 'records-board__rank', rankLabel(i)));
                    const nameCell = el('span', 'records-board__name');
                    nameCell.appendChild(el('span', 'records-board__name-text', entry.name || '—'));
                    if (remote) {
                        const g = el('span', 'records-board__linked', '🔗');
                        g.title = 'From a linked device';
                        nameCell.appendChild(g);
                    }
                    row.appendChild(nameCell);
                    row.appendChild(el('span', 'records-board__score', formatScore(entry.score)));
                    wrap.appendChild(row);
                });
                grid.appendChild(wrap);
            }
            bodyEl.appendChild(grid);
        }
    }

    function renderAll() { renderTabs(); renderBody(); }

    function selectTab(id) {
        activeId = id;
        renderAll();
    }

    // ---- reset (per active game) ----
    function confirmReset(message) {
        if (host.dialog) {
            return Promise.resolve(host.dialog({ message, okLabel: 'Delete', cancelLabel: 'Cancel' }))
                .then((r) => r === true);
        }
        return Promise.resolve(window.confirm(message));
    }

    async function doReset() {
        const game = gameById(activeId);
        if (!game) return;
        const ok = await confirmReset('Delete all leaderboards and records for “' + gameName(game)
            + '” on this device? This can’t be undone. Linked devices keep their own copies.');
        if (!ok) return;
        const keys = resetKeysFor(store, game.id);
        for (const k of keys) { try { store.removeItem(k); } catch (e) {} }
        // Sync-opted keys must tombstone, or a paired peer resurrects them at
        // the next exchange.
        if (host.onKeysRemoved) host.onKeysRemoved(game.id, keys);
        // A mounted frame caches these in its lsCache — tell it they're gone or
        // its next save rewrites the stale values straight back.
        if (host.isGameMounted && host.isGameMounted(game.id) && host.notifyGameKeyRemoved) {
            for (const k of keys) host.notifyGameKeyRemoved(game.id, k);
        }
        renderAll();
        if (host.showToast) host.showToast('Records cleared for ' + gameName(game) + '.');
    }

    // ---- open / close ----
    function firstPopulatedId() {
        for (const g of games) {
            if (countPopulated(collectGameData(store, g.id)) > 0) return g.id;
        }
        return games.length ? games[0].id : null;
    }

    function open() {
        if (host.closeLauncherMenu) host.closeLauncherMenu();
        games = catalogGames();
        activeId = firstPopulatedId();
        dialog.hidden = false;
        if (!games.length) {
            tabsEl.textContent = '';
            bodyEl.textContent = '';
            bodyEl.appendChild(el('p', 'records-empty', 'No games available.'));
            resetBtn.hidden = true;
        } else {
            renderAll();
        }
        setTimeout(() => { if (closeBtn) closeBtn.focus(); }, 50);
    }

    function close() {
        dialog.hidden = true;
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    }

    function isOpen() { return !dialog.hidden; }

    // Live-update hook (R3 wires storageHost.onStateWritten to call this). A
    // bridged game write to a scores/records/stats key re-renders the open
    // sheet; debounced so a write storm collapses to one repaint. Zero work
    // when the sheet is closed.
    function noteStateWritten(gameId, key) {
        if (!isOpen()) return;
        if (!relevantKey(gameId, key)) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            if (!isOpen()) return;
            renderTabs();                       // the written game's badge may change
            if (gameId === activeId) renderBody();
        }, 150);
    }

    // ---- wiring ----
    closeBtn && closeBtn.addEventListener('click', close);
    resetBtn && resetBtn.addEventListener('click', () => { doReset(); });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });

    if (panel) {
        // Focus trap on Tab (matches the connections dialog).
        panel.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            const focusable = Array.from(panel.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])'))
                .filter((n) => n.offsetWidth > 0 || n.offsetHeight > 0);
            if (!focusable.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        });
    }
    // Left/Right arrow tab navigation across the tab strip.
    tabsEl.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const idx = games.findIndex((g) => g.id === activeId);
        if (idx < 0 || !games.length) return;
        const next = e.key === 'ArrowRight'
            ? (idx + 1) % games.length
            : (idx - 1 + games.length) % games.length;
        selectTab(games[next].id);
        const activeTab = tabsEl.querySelector('.records-tab--active');
        if (activeTab) activeTab.focus();
        e.preventDefault();
    });

    return { open, close, isOpen, noteStateWritten };
}
