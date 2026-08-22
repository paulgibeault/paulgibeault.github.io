/* arcade-catalog.js — the data-driven game catalog (issue #34).
 *
 * catalog.json is the ONE authoritative game list. This module fetches and
 * validates it, and renders the two surfaces that used to hand-mirror it:
 * the launcher grid (index.html) and the portfolio project cards
 * (profile.html). The service worker derives its game-icon precache from the
 * same file. Adding a game = one JSON entry + one image — no HTML edits.
 *
 * Rendering is DOM-API-only (createElement/textContent, never innerHTML):
 * the catalog is same-origin trusted data, but house style keeps every
 * dynamic string out of the HTML parser (see the toast-spoof note in
 * index.html's maybeMessageToast).
 *
 * Game URLs in catalog.json are root-relative ('/<gameId>/') and resolved
 * against location.origin here — the launcher works unmodified on GitHub
 * Pages, dev.sh staging, and the CI acceptance servers.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Fetch + shape-validate the catalog. Malformed ENTRIES are filtered (one bad
 * entry must not blank the whole arcade); a malformed DOCUMENT throws so the
 * caller can show an error card. Returns the games array.
 */
export async function loadCatalog(url = './catalog.json') {
    const res = await fetch(url);
    if (!res.ok) throw new Error('catalog fetch failed: ' + res.status);
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.games)) throw new Error('catalog: missing games[]');
    const games = doc.games.filter((g) =>
        g && typeof g === 'object'
        && typeof g.id === 'string' && ID_RE.test(g.id)
        && typeof g.name === 'string' && g.name
        && typeof g.url === 'string' && g.url.startsWith('/'));
    if (!games.length) throw new Error('catalog: no valid games');
    return games;
}

/** A game's absolute launch URL on this origin (urls are root-relative). */
export function gameHref(game) {
    return new URL(game.url, location.origin).href;
}

function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
}

/**
 * Diagonal "In Development" ribbon over a game's card image, for entries
 * flagged `inDevelopment` in the catalog. The banner is absolutely positioned
 * against its wrap, so the wrap opts into containment via .in-dev-wrap
 * (see the styles.css block of the same name). Both surfaces call this — a
 * game is in development on the launcher and the portfolio or neither.
 */
function markInDevelopment(wrap) {
    wrap.classList.add('in-dev-wrap');
    wrap.appendChild(el('div', 'in-dev-banner', 'In Development'));
}

/**
 * Launcher grid (index.html #launcher-grid-container). Reproduces the exact
 * markup the static grid used: the CSS entrance stagger rides the inline
 * animation-delay, and the click wiring / pool code read data-game-id,
 * href, and .launcher-btn__name.
 *
 * `opts.stagger: false` renders the same tiles with every delay at 0. That is
 * for the MRU re-sort (arcade-recents.js): a re-render replays the entrance
 * animation, and a 0.1s-per-tile cascade every single time the player quits a
 * game reads as a page load rather than a return. One short uniform fade
 * covers the reorder instead.
 */
export function renderLauncherGrid(container, games, opts) {
    const stagger = !opts || opts.stagger !== false;
    const nodes = games.map((g, i) => {
        const a = el('a', 'launcher-btn' + (g.spotlight ? ' spotlight-card' : ''));
        a.href = gameHref(g);
        a.dataset.gameId = g.id;
        a.style.animationDelay = (stagger ? i * 0.1 : 0).toFixed(1) + 's';
        const wrap = el('div', 'launcher-btn__image-wrap');
        const img = el('img', 'launcher-btn__image');
        img.src = g.icon || 'images/icon-192.png';
        img.alt = g.name;
        wrap.appendChild(img);
        if (g.inDevelopment) markInDevelopment(wrap);
        const body = el('div', 'launcher-btn__body');
        body.appendChild(el('h3', 'launcher-btn__name', g.name));
        body.appendChild(el('p', 'launcher-btn__subtitle', g.subtitle || ''));
        a.appendChild(wrap);
        a.appendChild(body);
        return a;
    });
    container.replaceChildren(...nodes);
    return nodes;
}

/** Error card shown when the catalog can't load; Retry re-runs the boot. */
export function renderCatalogError(container, onRetry) {
    const card = el('div', 'launcher-btn');
    card.style.cursor = 'default';
    const body = el('div', 'launcher-btn__body');
    body.appendChild(el('h3', 'launcher-btn__name', "Couldn't load the game list"));
    body.appendChild(el('p', 'launcher-btn__subtitle', 'Check your connection and try again.'));
    const retry = el('button', 'btn', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => { try { onRetry(); } catch (e) {} });
    body.appendChild(retry);
    card.appendChild(body);
    container.replaceChildren(card);
}

/**
 * Portfolio cards (profile.html #games .card-grid). Only games WITH a
 * profile block render here — that's how CI fixture entries stay off the
 * portfolio. Must keep the .project-card__body wrapper: the zoom modal
 * deep-clones it.
 */
export function renderProfileCards(grid, games) {
    const nodes = games.filter((g) => g.profile && typeof g.profile === 'object').map((g) => {
        const p = g.profile;
        const card = el('article', 'project-card' + (g.spotlight ? ' spotlight-card' : ''));
        card.id = 'card-' + g.id;

        const wrap = el('div', 'project-card__image-wrap');
        const img = el('img', 'project-card__image');
        img.src = g.icon || 'images/icon-192.png';
        img.alt = p.alt || (p.name || g.name);
        img.loading = 'lazy';
        wrap.appendChild(img);
        if (g.inDevelopment) markInDevelopment(wrap);
        card.appendChild(wrap);

        const body = el('div', 'project-card__body');
        body.appendChild(el('h3', 'project-card__name', p.name || g.name));
        body.appendChild(el('p', 'project-card__subtitle', p.subtitle || g.subtitle || ''));
        const desc = el('p', 'project-card__desc');
        if (p.descLead) desc.appendChild(el('strong', null, p.descLead));
        if (p.descBody) desc.appendChild(document.createTextNode((p.descLead ? ' ' : '') + p.descBody));
        body.appendChild(desc);
        if (p.kicker) body.appendChild(el('p', 'project-card__kicker', p.kicker));
        if (Array.isArray(p.tags) && p.tags.length) {
            const tags = el('div', 'tech-tags');
            for (const t of p.tags) {
                if (typeof t === 'string') tags.appendChild(el('span', 'tech-tag', t));
            }
            body.appendChild(tags);
        }
        const actions = el('div', 'card-actions');
        const play = el('a', 'btn btn--play', '▶ Play');
        play.href = gameHref(g);
        play.target = '_blank';
        play.rel = 'noopener';
        play.id = 'btn-play-' + g.id;
        actions.appendChild(play);
        if (typeof p.codeUrl === 'string' && p.codeUrl) {
            const code = el('a', 'btn btn--code', '</> Code');
            code.href = p.codeUrl;
            code.target = '_blank';
            code.rel = 'noopener';
            code.id = 'btn-code-' + g.id;
            actions.appendChild(code);
        }
        body.appendChild(actions);
        card.appendChild(body);
        return card;
    });
    grid.replaceChildren(...nodes);
    return nodes;
}
