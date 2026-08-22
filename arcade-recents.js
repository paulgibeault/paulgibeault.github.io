/* arcade-recents.js — the single owner of arcade.v1._meta.recentGames, the
 * persisted most-recently-used game stack behind the launcher's sort order.
 *
 * The pool already keeps an MRU stack (Map insertion order in
 * arcade-pool.js), but that one dies with the tab and only holds what is
 * still mounted — it answers "what is warm", not "what does this player
 * actually play". The launcher grid wants the second question, across
 * sessions, so the stack is persisted here: ids only, most-recent first,
 * bounded by RECENTS_CAP.
 *
 * The key is _meta.*, NOT global.*: global.* is shared storage that ANY game
 * can read and write through the bridge (see bridgeKeyWritable in
 * arcade-storage-core.js), and a game reordering the launcher's tiles is not
 * a capability worth handing out. _meta.* never reaches a game frame.
 *
 * Recording a play and sorting the grid are deliberately separate calls:
 * every launch records (index.html's pool-change listener), but the grid is
 * only re-sorted when the player is back on the launcher — tiles must never
 * move under a hand that is reaching for one.
 *
 * The stack is a hint, never authority: unknown ids (a game dropped from the
 * catalog, an edited value) sort nothing and are simply ignored, and a
 * missing/corrupt/unreadable key degrades to "no recents" — i.e. plain
 * catalog order, which is exactly what a first-time visitor sees.
 */

export const RECENTS_KEY = 'arcade.v1._meta.recentGames';

/* Deep enough that a returning player's whole rotation survives, small
 * enough that the value stays a few hundred bytes. The catalog is far
 * shorter than this today — the cap is for a stack that outlives entries. */
export const RECENTS_CAP = 32;

// Must match arcade-catalog.js's ID_RE: anything that can't be a catalog id
// can't be a recent game either, so a hand-edited key can't smuggle a value
// of another shape into the sort.
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Read the stack, most-recent first. Unreadable/malformed ⇒ []. */
export function readRecents() {
    let raw = null;
    try { raw = localStorage.getItem(RECENTS_KEY); } catch (e) { return []; }
    if (raw === null) return [];
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return []; }
    if (!Array.isArray(parsed)) return [];
    return dedupe(parsed.filter((id) => typeof id === 'string' && ID_RE.test(id)));
}

/** First occurrence wins — the stack is most-recent-first. */
function dedupe(ids) {
    const seen = new Set();
    const out = [];
    for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        if (out.length >= RECENTS_CAP) break;
    }
    return out;
}

/** Pure stack move: `gameId` to the front, one copy, capped. */
export function promote(recents, gameId) {
    return dedupe([gameId, ...recents]);
}

/**
 * Record a launch (or a switch back to an already-warm game — both are
 * "used"). Returns the new stack. A write failure (quota, private mode) is
 * swallowed: the sort is a nicety, never a reason to break a launch.
 */
export function noteGamePlayed(gameId) {
    if (typeof gameId !== 'string' || !ID_RE.test(gameId)) return readRecents();
    const next = promote(readRecents(), gameId);
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch (e) {}
    return next;
}

/**
 * Games sorted most-recently-played first, with everything never played
 * following in catalog order. Stable and non-mutating: with an empty stack
 * the result is the catalog array's own order, tile for tile — the spotlight
 * entry keeps the lead slot until the player has actually played something.
 */
export function sortByRecents(games, recents) {
    const list = Array.isArray(games) ? games : [];
    const stack = recents === undefined ? readRecents() : recents;
    const rank = new Map();
    stack.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
    return list
        .map((g, i) => ({ g, i, r: rank.has(g && g.id) ? rank.get(g.id) : Infinity }))
        // Infinity - Infinity is NaN, so compare ranks for equality first:
        // two never-played games must fall through to catalog order.
        .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r - b.r))
        .map((x) => x.g);
}
