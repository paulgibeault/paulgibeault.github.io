/* arcade-records-core.js — pure, DOM-free readers & formatters for the
 * launcher's Records sheet (issue #12). No document/localStorage access of its
 * own: every function takes an injected `store` ({ length, key(i), getItem(k) })
 * so the unit suite runs it against a Map-backed fake and the DOM controller
 * passes the real `window.localStorage`.
 *
 * Game frames are opaque-origin and untrusted, so EVERY stored byte read here
 * is treated as hostile: JSON parsed in try/catch, shapes validated, counts
 * capped, strings sliced. Nothing in this file renders — the controller
 * (arcade-records.js) does that, textContent-only. Keeping the reads pure here
 * is what lets the untrusted-data handling be unit-tested exhaustively.
 */

export const KEY_PREFIX = 'arcade.v1.';
export const RENDER_TOP_N = 10;              // leaderboard rows shown per category
export const MAX_CATEGORIES_PER_KIND = 50;   // guard against a game spamming categories
const NAME_MAX = 32;
const LABEL_MAX = 64;

function gamePrefix(gameId) { return KEY_PREFIX + gameId + '.'; }

function isPlainObject(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
function isFiniteNum(n) { return typeof n === 'number' && isFinite(n); }

// Enumerate every full key in the store. Defensive: store.length and
// store.key(i) can each throw or return null on a hostile/edge store.
function eachKey(store, fn) {
    let n = 0;
    try { n = store.length; } catch (e) { return; }
    for (let i = 0; i < n; i++) {
        let k = null;
        try { k = store.key(i); } catch (e) { continue; }
        if (typeof k === 'string') fn(k);
    }
}

function readJSON(store, k) {
    let raw = null;
    try { raw = store.getItem(k); } catch (e) { return undefined; }
    if (raw === null || raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch (e) { return undefined; }
}

// Mirrors the SDK's isValidRecord — a record is trustworthy only with a finite
// value and a known direction. Anything else is skipped, never surfaced.
function isValidRecord(v) {
    return isPlainObject(v)
        && isFiniteNum(v.value)
        && (v.direction === 'higher' || v.direction === 'lower');
}

// The per-category sort order sidecar (arcade.v1.<id>._scoreOrders). Only
// 'asc'/'desc' values are honoured; anything else defaults to 'desc'.
export function readScoreOrders(store, gameId) {
    const v = readJSON(store, KEY_PREFIX + gameId + '._scoreOrders');
    const out = {};
    if (isPlainObject(v)) {
        for (const k of Object.keys(v)) {
            if (v[k] === 'asc' || v[k] === 'desc') out[k] = v[k];
        }
    }
    return out;
}

// Read one game's leaderboards + personal records from the store. Returns
// { scores: [{category, order, entries}], records: [{category, record}] },
// both sorted by category, bounded, and fully sanitized.
export function collectGameData(store, gameId) {
    const prefix = gamePrefix(gameId);
    const scoresPrefix = prefix + 'scores.';
    const recordsPrefix = prefix + 'records.';
    const orders = readScoreOrders(store, gameId);

    const scores = [];
    const records = [];
    eachKey(store, (k) => {
        if (k.indexOf(scoresPrefix) === 0) {
            const category = k.slice(scoresPrefix.length);
            if (!category) return;
            const raw = readJSON(store, k);
            if (!Array.isArray(raw)) return;                  // non-array score blob → skip
            const order = orders[category] === 'asc' ? 'asc' : 'desc';
            const entries = raw
                .filter((e) => isPlainObject(e) && isFiniteNum(e.score))
                .map((e) => ({
                    score: e.score,
                    name: (typeof e.name === 'string' && e.name) ? e.name.slice(0, NAME_MAX) : '',
                    ts: isFiniteNum(e.ts) ? e.ts : null,
                    key: (typeof e.key === 'string') ? e.key.slice(0, LABEL_MAX) : null,
                    // dev (which device set it) drives the "from a linked device"
                    // indicator; sliced, never trusted for anything but display.
                    dev: (typeof e.dev === 'string' && e.dev) ? e.dev.slice(0, 64) : null
                }));
            // Never trust the stored sort — re-sort by the category's declared
            // order, then cut to the top N. (A single mis-ordered add() upstream
            // could otherwise leave the best entries off the visible slice.)
            entries.sort((a, b) => order === 'asc' ? a.score - b.score : b.score - a.score);
            if (entries.length > RENDER_TOP_N) entries.length = RENDER_TOP_N;
            if (entries.length) scores.push({ category, order, entries });
        } else if (k.indexOf(recordsPrefix) === 0) {
            const category = k.slice(recordsPrefix.length);
            if (!category) return;
            const v = readJSON(store, k);
            if (!isValidRecord(v)) return;
            records.push({
                category,
                record: {
                    value: v.value,
                    direction: v.direction,
                    ts: isFiniteNum(v.ts) ? v.ts : null,
                    label: (typeof v.label === 'string') ? v.label.slice(0, LABEL_MAX) : '',
                    format: (typeof v.format === 'string') ? v.format : ''
                }
            });
        }
    });

    const byCategory = (a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0);
    scores.sort(byCategory);
    records.sort(byCategory);
    if (scores.length > MAX_CATEGORIES_PER_KIND) scores.length = MAX_CATEGORIES_PER_KIND;
    if (records.length > MAX_CATEGORIES_PER_KIND) records.length = MAX_CATEGORIES_PER_KIND;
    return { scores, records };
}

// Count of populated categories (drives the tab badge).
export function countPopulated(gameData) {
    if (!gameData) return 0;
    return (gameData.scores ? gameData.scores.length : 0)
        + (gameData.records ? gameData.records.length : 0);
}

// The keys a per-game reset wipes: scores.*, records.*, stats.*, and the
// _scoreOrders sidecar — never state, .ls., _sync, _noExport, _meta, or another
// game. Pure: returns the list; the caller deletes.
export function resetKeysFor(store, gameId) {
    const prefix = gamePrefix(gameId);
    const out = [];
    eachKey(store, (k) => {
        if (k.indexOf(prefix) !== 0) return;
        if (isResettableSegment(k.slice(prefix.length))) out.push(k);
    });
    return out;
}

function isResettableSegment(seg) {
    return seg.indexOf('scores.') === 0 || seg.indexOf('records.') === 0
        || seg.indexOf('stats.') === 0 || seg === '_scoreOrders';
}

// Does a bridged write to (gameId, key) affect what the sheet shows? Drives the
// live-update refresh (and shares the reset predicate so they can't drift).
export function relevantKey(gameId, key) {
    if (typeof key !== 'string') return false;
    const prefix = gamePrefix(gameId);
    if (key.indexOf(prefix) !== 0) return false;
    return isResettableSegment(key.slice(prefix.length));
}

// ---- formatters (all total, never throw) ----

export function formatRecordValue(value, format) {
    if (!isFiniteNum(value)) return '—';
    switch (format) {
        case 'duration-ms': return formatDuration(value);
        case 'integer': return Math.round(value).toLocaleString();
        case 'percentage': {
            const pct = Math.round(value * 10) / 10;
            return (Number.isInteger(pct) ? String(pct) : pct.toFixed(1)) + '%';
        }
        default:
            return groupedNumber(value);
    }
}

// Grouped plain number, at most 2 decimals — used for scores and unknown
// record formats (forward-compat: a future format string still renders).
export function formatScore(score) {
    if (!isFiniteNum(score)) return '—';
    return groupedNumber(score);
}

function groupedNumber(n) {
    const rounded = Math.round(n * 100) / 100;
    try { return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 }); }
    catch (e) { return String(rounded); }
}

// duration-ms → m:ss.cc (or h:mm:ss.cc past an hour). e.g. 102130 → "1:42.13".
// Negative / non-finite → em dash (a garbage stored value never renders as a
// plausible time).
function formatDuration(ms) {
    if (!isFiniteNum(ms) || ms < 0) return '—';
    const p2 = (x) => (x < 10 ? '0' : '') + x;
    const totalCs = Math.round(ms / 10);
    const cs = totalCs % 100;
    const totalSec = Math.floor(totalCs / 100);
    const s = totalSec % 60;
    const totalMin = Math.floor(totalSec / 60);
    const m = totalMin % 60;
    const h = Math.floor(totalMin / 60);
    if (h > 0) return h + ':' + p2(m) + ':' + p2(s) + '.' + p2(cs);
    return m + ':' + p2(s) + '.' + p2(cs);
}

export function formatDate(ts) {
    if (!isFiniteNum(ts)) return '';
    try { return new Date(ts).toLocaleDateString(); } catch (e) { return ''; }
}

// A leaderboard entry set by another of the player's linked devices (used for
// the "shared" affordance). myDeviceId is arcade.v1._meta.deviceId.
export function isRemoteEntry(entry, myDeviceId) {
    return !!(entry && typeof entry.dev === 'string' && entry.dev
        && typeof myDeviceId === 'string' && myDeviceId && entry.dev !== myDeviceId);
}

// Fallback human label for a category slug when no record.label is set:
// "klondike_draw1_unlimited" → "Klondike Draw1 Unlimited".
export function prettifyCategory(slug) {
    if (typeof slug !== 'string' || !slug) return '';
    return slug.split(/[_-]+/).filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}
