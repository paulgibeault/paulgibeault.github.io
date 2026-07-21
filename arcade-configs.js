/* arcade-configs.js — launcher engine for the game-config exchange
 * (Arcade.configs / #config-exchange). Games export named config payloads
 * (sowduku packs, cardstock variants, …) as share codes / deep links (C1) or a
 * direct peer push (C2); this engine ingests them, PROMPTS the user, and
 * delivers them into the target game frame once it's live.
 *
 * Security posture: the launcher validates TRANSPORT shape only (envelope,
 * sizes, type charset, game-in-catalog) and prompts before anything reaches a
 * game. It never interprets a config's `data` — the game does, and MUST treat
 * it as hostile (see GAME_INTEGRATION §7d).
 */
import { ArcadeDiag } from './arcade-diag.js';
import { validateConfigsOp } from './arcade-envelope.js';
import {
    decodeShareCode, validateConfigPayload, validateConfigEnvelope,
    CFG_CODE_MAX
} from './arcade-configs-core.js';

const ACK_TIMEOUT_MS = 15000;
const STASH_PER_GAME = 4;
const STASH_TOTAL = 8;
const PROMPT_MIN_GAP_MS = 1000; // per-peer receive-prompt rate limit (config-bomb guard)

export function initConfigs(host) {
    const stash = new Map();        // gameId -> [{ t, v, d }] awaiting delivery
    const ackTimers = new Map();    // gameId|t -> timer
    const lastPromptAt = new Map(); // peer key -> ms
    let p2p = null;

    // ---- catalog helpers ----
    function catalog() { const c = host.getCatalog ? host.getCatalog() : null; return Array.isArray(c) ? c : []; }
    function catalogIds() { const s = new Set(); for (const g of catalog()) if (g && typeof g.id === 'string') s.add(g.id); return s; }
    function gameById(id) { return catalog().find((g) => g && g.id === id) || null; }
    function gameName(id) { const g = gameById(id); return g ? (g.name || g.id) : id; }

    // ---- pending stash + delivery ----
    function totalStashed() { let n = 0; for (const a of stash.values()) n += a.length; return n; }
    function enqueue(gameId, entry) {
        let a = stash.get(gameId);
        if (!a) { a = []; stash.set(gameId, a); }
        a.push(entry);
        while (a.length > STASH_PER_GAME) a.shift();
        while (totalStashed() > STASH_TOTAL) {
            for (const [g, arr] of stash) { if (arr.length) { arr.shift(); if (!arr.length) stash.delete(g); break; } }
        }
        if (host.isGameMounted && host.isGameMounted(gameId)) deliver(gameId);
    }
    function deliver(gameId) {
        const a = stash.get(gameId);
        if (!a || !a.length) return;
        const entries = a.slice();
        stash.delete(gameId);
        for (const entry of entries) {
            host.postToIframe(gameId, { type: 'arcade:config', t: entry.t, v: entry.v, d: entry.d });
            // If the game never acks (no registered handler), toast once.
            const key = gameId + '|' + entry.t;
            if (ackTimers.has(key)) clearTimeout(ackTimers.get(key));
            ackTimers.set(key, setTimeout(() => {
                ackTimers.delete(key);
                if (host.showToast) host.showToast(gameName(gameId) + ' may not support this configuration.');
            }, ACK_TIMEOUT_MS));
        }
    }
    // Called on a game's hello (pool.onHelloed) and on its config ack.
    function onHelloed(gameId) { if (stash.has(gameId)) deliver(gameId); }
    function onConfigAck(gameId, type) {
        const key = gameId + '|' + type;
        if (ackTimers.has(key)) { clearTimeout(ackTimers.get(key)); ackTimers.delete(key); }
    }

    // ---- receive flow (deep link + peer): prompt, stash, maybe open ----
    async function receive(payload, opts) {
        const name = gameName(payload.g);
        const from = opts && opts.from;
        const message = from
            ? '“' + from + '” sent a “' + name + '” configuration — load it?'
            : 'Load a “' + name + '” configuration' + (opts && opts.fromLink ? ' from this link?' : '?');
        const cancelLabel = (opts && opts.fromLink) ? 'Ignore' : 'No';
        let ok = false;
        try { ok = (await host.dialog({ message, okLabel: 'Load', cancelLabel })) === true; }
        catch (e) { ok = false; }
        if (!ok) return false;
        enqueue(payload.g, { t: payload.t, v: payload.v, d: payload.d });
        if (!(host.isGameMounted && host.isGameMounted(payload.g))) {
            const game = gameById(payload.g);
            if (game && host.openGame) host.openGame(game);
        }
        return true;
    }

    // Boot deep-link ingestion (from the catalog block's openDeepLink).
    async function ingestLink(app, cfg) {
        const decoded = decodeShareCode(cfg);
        const payload = decoded && validateConfigPayload(decoded.data, decoded.v, catalogIds());
        // The code's game must match the #app id — no cross-game smuggling.
        if (!payload || payload.g !== app) {
            if (host.showToast) host.showToast('That configuration link doesn’t match anything here.');
            return false;
        }
        return receive(payload, { fromLink: true });
    }

    // ---- share op (SDK arcade:configs.op {op:'share', code}) ----
    async function shareOp(gameId, data) {
        const code = (data && typeof data.code === 'string') ? data.code : '';
        if (!code || code.length > CFG_CODE_MAX || !/^[A-Za-z0-9_-]+$/.test(code)) return { ok: false };
        // Re-validate: the code must decode to a config for THIS game (a frame
        // can't share a link naming another game).
        const decoded = decodeShareCode(code);
        const payload = decoded && validateConfigPayload(decoded.data, decoded.v, catalogIds());
        if (!payload || payload.g !== gameId) return { ok: false };
        const base = location.origin + location.pathname;
        const url = base + '#app=' + encodeURIComponent(gameId) + '&cfg=' + code;
        const shared = host.shareLink ? await host.shareLink(url, gameName(gameId)) : null;
        return { ok: true, url, shared };
    }

    // ---- send op (SDK arcade:configs.op {op:'send', t, d}) — C2 ----
    async function sendOp(gameId, data) {
        if (!p2p) return { ok: false, sent: 0 };
        const type = (data && typeof data.t === 'string') ? data.t : '';
        if (!/^[a-z0-9_-]{1,32}$/.test(type)) return { ok: false, sent: 0 };
        // Pick a target from the connected, identity-bound known peers.
        const peers = connectedNamedPeers();
        if (!peers.length) { if (host.showToast) host.showToast('No connected devices to send to.'); return { ok: false, sent: 0 }; }
        let target = peers[0];
        if (peers.length > 1 && host.pickPeer) {
            target = await host.pickPeer(peers);
            if (!target) return { ok: false, sent: 0 };
        }
        const env = { v: 1, g: gameId, t: type, d: data.d };
        // Size-guard via the same validator the receiver uses.
        if (!validateConfigEnvelope({ ...env, arcade: 1, kind: 'config' }, catalogIds())) return { ok: false, sent: 0 };
        const sent = p2p.sendConfigEnvelope(target.deviceId, env) ? 1 : 0;
        if (sent && host.showToast) host.showToast('Sent to ' + target.name + '.');
        return { ok: sent > 0, sent };
    }

    function connectedNamedPeers() {
        const out = [];
        if (!p2p) return out;
        let roster = [];
        try { roster = p2p.connectedPeers ? p2p.connectedPeers() : []; } catch (e) { roster = []; }
        for (const r of roster) if (r && r.deviceId) out.push({ deviceId: r.deviceId, name: r.name || 'a device' });
        return out;
    }

    // ---- inbound peer config (C2): validate, rate-limit, prompt ----
    function handleInbound(fromDeviceId, env) {
        const payload = validateConfigEnvelope(env, catalogIds());
        if (!payload) { ArcadeDiag.log('config', `rejected inbound config from ${fromDeviceId}`); return; }
        const now = nowMs();
        const last = lastPromptAt.get(fromDeviceId);
        if (last !== undefined && now - last < PROMPT_MIN_GAP_MS) return; // config-bomb guard
        lastPromptAt.set(fromDeviceId, now);
        const from = peerName(fromDeviceId);
        receive(payload, { from }).catch((e) => ArcadeDiag.log('config', `receive failed: ${(e && e.message) || e}`));
    }
    function peerName(deviceId) {
        const peers = connectedNamedPeers();
        const p = peers.find((x) => x.deviceId === deviceId);
        return (p && p.name) || 'A linked device';
    }
    function nowMs() { try { return Date.now(); } catch (e) { return 0; } }

    // ---- router entry point for arcade:configs.op ----
    function handleOp(gameId, data) {
        const op = validateConfigsOp(data);
        if (!op) return Promise.resolve({ ok: false });
        if (op.op === 'share') return shareOp(gameId, op).catch(() => ({ ok: false }));
        if (op.op === 'send') return sendOp(gameId, op).catch(() => ({ ok: false, sent: 0 }));
        return Promise.resolve({ ok: false });
    }

    function attachP2P(p2pRef) {
        p2p = p2pRef;
        if (p2p.onConfigEnvelope) {
            p2p.onConfigEnvelope((fromDeviceId, env) => {
                try { handleInbound(fromDeviceId, env); }
                catch (e) { ArcadeDiag.log('config', `inbound crashed: ${(e && e.message) || e}`); }
            });
        }
    }

    return { handleOp, onHelloed, onConfigAck, ingestLink, attachP2P };
}
