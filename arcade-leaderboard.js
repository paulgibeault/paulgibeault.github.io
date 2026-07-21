/* arcade-leaderboard.js — launcher engine for shared leaderboards (#leaderboards).
 * Replicates each game's arcade.v1.<gameId>.scores.<cat> boards to linked peers
 * and UNION-MERGES inbound boards into the local ones (arcade-leaderboard-core.js
 * owns the merge math + convergence). Distinct from Arcade.sync, which is LWW and
 * would clobber a board wholesale — scores keys are carved out of sync (see
 * arcade-sync.js) and flow here instead.
 *
 * Gating rides the EXISTING per-peer sync opt-in (knownPeers[id].syncEnabled on
 * both sides + identity-bound + not fingerprint-suspect) — no new consent toggle.
 * Transport is a purpose-built kind:'leaderboard' envelope, direct-link only,
 * identity-bound (same guards as kind:'sync').
 *
 * Exchange model: simple full-board push (no digest). Boards are ≤100 entries;
 * the merge is idempotent, so on an inbound merge that CHANGED our board we push
 * ours back (debounced) and the anti-entropy ping-pong terminates when the peer
 * merges to changed:false.
 */
import { KEY_PREFIX } from './arcade-storage-core.js';
import { readKnownPeers } from './arcade-known-peers.js';
import { ArcadeDiag } from './arcade-diag.js';
import {
    isLeaderboardKey, mergeBoards, chunkBoards, validateLeaderboardEnvelope
} from './arcade-leaderboard-core.js';

const CHANGED = 'arcade:state.changed';
const SEND_DEBOUNCE_MS = 1000;         // coalesce a burst of score writes into one push
const IDENTITY_DEDUPE_MS = 30 * 1000;  // matches sync's onPeerIdentity dedupe window
const RESET_KEY = KEY_PREFIX + 'global.lbResetAt';  // { [gameId]: ms } — per-game reset watermark

export function initLeaderboards(host) {
    const postToIframe = host.postToIframe;
    let p2p = null;
    const lastSendAt = new Map();      // deviceId -> ms of last push (identity-trigger dedupe)
    const sendTimers = new Map();      // "deviceId|app" -> debounce timer
    const oversizeLogged = new Set();

    // ---- peer eligibility (identical gate to arcade-sync.js) ----
    function peerEnabled(deviceId) {
        const rec = readKnownPeers()[deviceId];
        return !!(rec && rec.syncEnabled === true);
    }
    function peerSuspect(deviceId) {
        return !!(p2p && typeof p2p.isFingerprintSuspect === 'function' && p2p.isFingerprintSuspect(deviceId));
    }
    function eligible(deviceId) {
        return !!p2p && peerEnabled(deviceId) && !peerSuspect(deviceId);
    }

    // ---- storage helpers (launcher owns the origin — direct reads) ----
    function readJSON(k) {
        try { const raw = localStorage.getItem(k); return raw === null ? null : JSON.parse(raw); }
        catch (e) { return null; }
    }
    function appIdOf(fullKey) { return fullKey.slice(KEY_PREFIX.length).split('.')[0]; }
    function categoryOf(fullKey) { return fullKey.slice(KEY_PREFIX.length).split('.').slice(2).join('.'); }

    function resetMap() {
        const v = readJSON(RESET_KEY);
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    }
    function resetAtFor(appId) {
        const t = resetMap()[appId];
        return (typeof t === 'number' && isFinite(t)) ? t : 0;
    }
    function orderFor(appId, category) {
        const orders = readJSON(KEY_PREFIX + appId + '._scoreOrders');
        if (orders && typeof orders === 'object' && (orders[category] === 'asc' || orders[category] === 'desc')) {
            return orders[category];
        }
        return 'desc';
    }

    // Collect all local leaderboard boards (or just one game's).
    function collectBoards(onlyApp) {
        const boards = [];
        let n = 0;
        try { n = localStorage.length; } catch (e) { return boards; }
        for (let i = 0; i < n; i++) {
            let k = null;
            try { k = localStorage.key(i); } catch (e) { continue; }
            if (typeof k !== 'string' || !isLeaderboardKey(k)) continue;
            const app = appIdOf(k);
            if (onlyApp && app !== onlyApp) continue;
            const list = readJSON(k);
            if (!Array.isArray(list) || !list.length) continue;
            boards.push({ k, order: orderFor(app, categoryOf(k)), list });
        }
        return boards;
    }

    // ---- outbound ----
    function sendBoardsTo(deviceId, onlyApp) {
        if (!eligible(deviceId)) return;
        const boards = collectBoards(onlyApp);
        if (!boards.length) return;
        const { frames, skipped } = chunkBoards(boards);
        for (const s of skipped) {
            if (!oversizeLogged.has(s.k)) { oversizeLogged.add(s.k); ArcadeDiag.log('leaderboard', `board too large to share: ${s.k} (${s.reason})`); }
        }
        const nonEmpty = frames.filter((f) => f.length);
        for (let i = 0; i < nonEmpty.length; i++) {
            p2p.sendLeaderboardEnvelope(deviceId, { v: 1, op: 'boards', part: i, parts: nonEmpty.length, entries: nonEmpty[i] });
        }
        lastSendAt.set(deviceId, Date.now());
    }

    function scheduleSend(deviceId, onlyApp) {
        if (!eligible(deviceId)) return;
        const key = deviceId + '|' + (onlyApp || '');
        if (sendTimers.has(key)) clearTimeout(sendTimers.get(key));
        sendTimers.set(key, setTimeout(() => { sendTimers.delete(key); sendBoardsTo(deviceId, onlyApp); }, SEND_DEBOUNCE_MS));
    }

    function connectedEligible() {
        const out = [];
        if (!p2p) return out;
        let roster = [];
        try { roster = p2p.connectedPeers ? p2p.connectedPeers() : []; } catch (e) { roster = []; }
        for (const r of roster) {
            if (r && r.deviceId && eligible(r.deviceId)) out.push(r.deviceId);
        }
        return out;
    }

    // ---- inbound: union-merge one board into local storage ----
    function applyBoard(b) {
        const app = appIdOf(b.k);
        const category = categoryOf(b.k);
        const local = readJSON(b.k);
        // Adopt the sender's order if this category has none established locally,
        // else a later local scores.add() would re-sort a time board descending.
        const ordersKey = KEY_PREFIX + app + '._scoreOrders';
        let orders = readJSON(ordersKey);
        if (!orders || typeof orders !== 'object' || Array.isArray(orders)) orders = {};
        let order = orders[category];
        let orderAdopted = false;
        if (order !== 'asc' && order !== 'desc') {
            order = (b.order === 'asc' || b.order === 'desc') ? b.order : 'desc';
            orders[category] = order;
            orderAdopted = true;
        }
        const { list, changed } = mergeBoards(local, b.list, order, resetAtFor(app));
        if (!changed && !orderAdopted) return false;
        // Direct writes — echo-safe: these bypass the storage bridge, so
        // storageHost.onStateWritten cannot re-fire and re-broadcast our merge
        // as a fresh local edit (same rule as arcade-sync's applyInboundDiffEntry).
        try {
            if (orderAdopted) localStorage.setItem(ordersKey, JSON.stringify(orders));
            if (changed) {
                const raw = JSON.stringify(list);
                localStorage.setItem(b.k, raw);
                postToIframe(app, { type: CHANGED, key: b.k, value: raw });        // live-update a mounted frame's cache
                if (host.notifyRecords) host.notifyRecords(app, b.k, raw);         // refresh an open Records sheet
                if (host.noteJournal) host.noteJournal(b.k, raw);                  // journal (local class) for export provenance
            }
        } catch (e) {
            ArcadeDiag.log('leaderboard', `apply failed for ${b.k}: ${(e && e.message) || e}`);
            return false;
        }
        return changed;
    }

    function handleInbound(fromDeviceId, env) {
        if (!eligible(fromDeviceId)) return;
        const res = validateLeaderboardEnvelope(env);
        if (!res.ok) { ArcadeDiag.log('leaderboard', `rejected inbound from ${fromDeviceId}: ${res.reason}`); return; }
        let anyChanged = false;
        for (const b of env.entries) {
            if (applyBoard(b)) anyChanged = true;
        }
        // Anti-entropy: their push changed our board → we may hold entries they
        // lack; push back (debounced). Idempotent merge ends the ping-pong.
        if (anyChanged) scheduleSend(fromDeviceId);
    }

    function maybeSendOnIdentity(deviceId) {
        if (!eligible(deviceId)) return;
        const last = lastSendAt.get(deviceId);
        if (last !== undefined && Date.now() - last < IDENTITY_DEDUPE_MS) return;
        sendBoardsTo(deviceId);
    }

    // ---- public API / triggers ----
    function attachP2P(p2pRef) {
        p2p = p2pRef;
        p2p.onLeaderboardEnvelope((fromDeviceId, env) => {
            try { handleInbound(fromDeviceId, env); }
            catch (e) { ArcadeDiag.log('leaderboard', `inbound crashed: ${(e && e.message) || e}`); }
        });
        p2p.onPeerIdentity(({ deviceId }) => maybeSendOnIdentity(deviceId));
    }

    // Fan-out target of storageHost.onStateWritten: a local scores write shares
    // that game's boards to every eligible connected peer (debounced).
    function noteStateWritten(gameId, key /*, value */) {
        if (!p2p || typeof key !== 'string' || !isLeaderboardKey(key)) return;
        const app = appIdOf(key);
        for (const deviceId of connectedEligible()) scheduleSend(deviceId, app);
    }

    // Called next to sync.kick when a peer's sync toggle is switched ON.
    function kick(deviceId) { sendBoardsTo(deviceId); }

    // Called from the Records sheet's per-game reset: stamp a watermark so
    // pre-reset entries can't be resurrected here by a peer (peers keep theirs).
    function noteReset(gameId) {
        if (typeof gameId !== 'string' || !gameId) return;
        const m = resetMap();
        m[gameId] = Date.now();
        try { localStorage.setItem(RESET_KEY, JSON.stringify(m)); } catch (e) {}
    }

    return {
        attachP2P, noteStateWritten, kick, noteReset,
        // Test hooks (mirrors arcade-sync's _records/_cursor).
        _boards: () => collectBoards(),
        _lastSendAt: (deviceId) => (lastSendAt.has(deviceId) ? lastSendAt.get(deviceId) : null)
    };
}
