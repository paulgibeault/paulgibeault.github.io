// tools/lib/p2p-test-harness.mjs — shared scaffolding for the p2p acceptance
// suites (p2p-acceptance, p2p-multiseat-acceptance, p2p-reconnect-acceptance).
//
// Everything hermetic the three scripts used to copy-paste lives here:
//   - a static server over the repo root (real launcher, real transport)
//   - an in-test dead-drop standing in for the public MQTT broker, injected
//     via window.__arcadeRdvCarrierFactory so no external infrastructure is
//     ever touched. It deliberately REPLAYS full history to new subscribers —
//     harsher than real MQTT — because the protocol must tolerate stale blobs.
//   - FORCE_LOCAL_ICE (empty iceServers: loopback host candidates only)
//   - per-device browser contexts (distinct localStorage/IndexedDB, so
//     deviceIds and DTLS identity certificates genuinely differ)
//   - the signaling ceremony at the transport level (stands in for QR /
//     link tennis — the human-carried exchange; see p2p/PROTOCOL.md §4)
//
// Ports stay per-script (passed in) so suites never collide on TIME_WAIT.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Per-script ✓/✗ recorder. Each suite makes its own so the failure count
// stays script-local: `const { check, failed } = makeCheck();`
export function makeCheck() {
    let failures = 0;
    function check(name, ok, detail) {
        console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
        if (!ok) failures++;
    }
    return { check, failed: () => failures };
}

const FORCE_LOCAL_ICE = `
    const OrigRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OrigRTC {
        constructor(cfg = {}) { super({ ...cfg, iceServers: [] }); }
    };
`;

function httpCarrierScript(dropPort) {
    return `
    // Every carrier this factory mints is registered so a test can sever/restore
    // the whole page's signaling at once (window.__arcadeRdvSever). A severed
    // carrier drops polls (receives nothing) and swallows publishes (QoS-0 loss
    // into a dead socket) — the failure the real MqttCarrier hides behind an
    // internal redial. Restoring fires onSessionUp (the hook rendezvous sets to
    // republish immediately) so the T-4 scenarios can exercise session recovery
    // and the nudgeAll→ensureAlive kick the injected carrier previously lacked.
    window.__arcadeRdvCarriers = window.__arcadeRdvCarriers || new Set();
    window.__arcadeRdvSeveredDefault = window.__arcadeRdvSeveredDefault || false;
    window.__arcadeRdvSever = (on) => {
        window.__arcadeRdvSeveredDefault = !!on;
        for (const c of window.__arcadeRdvCarriers) c._setSevered(!!on);
    };
    // Sum of ensureAlive() calls across live carriers — lets a test assert
    // nudgeAll() actually reached the carrier layer.
    window.__arcadeRdvEnsureAliveCount = () => {
        let n = 0; for (const c of window.__arcadeRdvCarriers) n += c.ensureAliveCount; return n;
    };
    window.__arcadeRdvCarrierFactory = () => {
        const carrier = {
            base: 'http://127.0.0.1:${dropPort}',
            subs: new Map(),
            timer: null,
            severed: window.__arcadeRdvSeveredDefault,
            ensureAliveCount: 0,
            onSessionUp: null,
            _setSevered(on) {
                const was = this.severed;
                this.severed = !!on;
                if (was && !this.severed) {
                    // Session restored: pick up anything published while we were
                    // deaf, then fire the republish hook (set by rendezvous after
                    // its first connect()).
                    this._poll();
                    if (typeof this.onSessionUp === 'function') { try { this.onSessionUp(); } catch (e) {} }
                }
            },
            ensureAlive() {
                this.ensureAliveCount++;
                if (!this.severed) this._poll(); // a kick: poll now, don't wait for the timer
            },
            async connect() { if (!this.timer) this.timer = setInterval(() => this._poll(), 120); },
            async _poll() {
                if (this.severed) return; // dead socket: receives nothing
                for (const [topic, st] of this.subs) {
                    try {
                        const r = await fetch(this.base + '/sub?t=' + topic + '&since=' + st.next);
                        const j = await r.json();
                        st.next = j.next;
                        j.msgs.forEach(m => st.cbs.forEach(cb => { try { cb(m); } catch (e) {} }));
                    } catch (e) {}
                }
            },
            async publish(topic, payload) {
                if (this.severed) return; // QoS-0 into a dead socket: lost
                await fetch(this.base + '/pub?t=' + topic, { method: 'POST', body: payload });
            },
            subscribe(topic, cb) {
                if (!this.subs.has(topic)) this.subs.set(topic, { next: 0, cbs: new Set() });
                const st = this.subs.get(topic);
                st.cbs.add(cb);
                return () => st.cbs.delete(cb);
            },
            close() {
                clearInterval(this.timer); this.timer = null; this.subs.clear();
                window.__arcadeRdvCarriers.delete(carrier);
            }
        };
        window.__arcadeRdvCarriers.add(carrier);
        return carrier;
    };
`;
}

// Node-side bounded-deadline poll for cross-page convergence checks a single
// page's waitForFunction can't express (no long sleeps). Shared home for the
// copies the p2p suites carried individually.
export async function waitFor(fn, timeoutMs = 15000, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await fn()) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

export async function startP2PHarness({ port, dropPort }) {
    const BASE = `http://127.0.0.1:${port}`;

    // In-test dead-drop (see header). /pub appends, /sub returns everything
    // past `since` — new subscribers replay full history on purpose.
    const dropTopics = new Map();
    const dropServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const u = new URL(req.url, 'http://x');
        const topic = u.searchParams.get('t') || '';
        if (req.method === 'POST' && u.pathname === '/pub') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                if (!dropTopics.has(topic)) dropTopics.set(topic, []);
                dropTopics.get(topic).push(body);
                res.end('ok');
            });
        } else if (u.pathname === '/sub') {
            const arr = dropTopics.get(topic) || [];
            const since = parseInt(u.searchParams.get('since') || '0', 10);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ msgs: arr.slice(since), next: arr.length }));
        } else res.end('');
    });
    dropServer.listen(dropPort);

    const staticServer = spawn('python3', ['-m', 'http.server', String(port), '--directory', ROOT], {
        stdio: 'ignore'
    });
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`${BASE}/index.html`)).ok) break; } catch (_) {}
        await new Promise(r => setTimeout(r, 100));
    }

    const browser = await chromium.launch({
        channel: 'chrome',
        headless: true,
        args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
    });

    const initScript = FORCE_LOCAL_ICE + httpCarrierScript(dropPort);

    // One context per simulated device: distinct localStorage/IndexedDB, so
    // deviceIds and identity certificates genuinely differ like real devices.
    async function newDeviceContext() {
        const context = await browser.newContext();
        await context.addInitScript(initScript);
        return context;
    }

    async function launcherPage(label, context) {
        const page = await context.newPage();
        page.on('pageerror', err => console.error(`  [${label} pageerror]`, err.message));
        await page.goto(`${BASE}/`);
        await page.waitForFunction('!!window.__arcade && !!window.__arcade.showGame');
        return page;
    }

    // Boot the bridge as a real user would: the single Multiplayer menu item
    // (hub dialog), then "New connection" — that's what actually initializes
    // the transport (ensureAddon()). closeDialog dismisses the UI afterwards
    // for suites that go on to drive the page.
    async function bootBridge(page, { closeDialog = false } = {}) {
        await page.evaluate(() => document.getElementById('menu-multiplayer').click());
        await page.evaluate(() => document.getElementById('connections-dialog-new').click());
        await page.waitForFunction('!!window.__arcade.p2p && !!window.__arcade.p2p._addon()', null, { timeout: 15000 });
        if (closeDialog) {
            await page.evaluate(() => {
                const overlay = document.getElementById('p2p-modal-overlay');
                if (overlay) overlay.style.display = 'none';
                if (window.__arcade.closeConnectionsDialog) window.__arcade.closeConnectionsDialog();
            });
        }
    }

    // Signaling ceremony at the transport level — stands in for QR / link
    // tennis (p2p/PROTOCOL.md §4). Each host-side createOffer() mints a
    // fresh link — the same path as tapping Host again for another
    // standalone connection.
    // Returns the packed payloads so suites can assert their shape.
    // waitHost: false when the host already holds other live links (its
    // aggregate status is not what this ceremony proves).
    async function ceremony(H, J, { waitHost = true } = {}) {
        const packedOffer = await H.evaluate(async () => {
            const { ConnectionUtils } = await import('./p2p/p2p-core.js');
            const addon = window.__arcade.p2p._addon();
            return await ConnectionUtils.encodePayload(await addon.peerNode.createOffer());
        });
        const packedAnswer = await J.evaluate(async (packed) => {
            const { ConnectionUtils } = await import('./p2p/p2p-core.js');
            const addon = window.__arcade.p2p._addon();
            const offer = await ConnectionUtils.decodePayload(packed);
            return await ConnectionUtils.encodePayload(await addon.peerNode.createAnswer(offer));
        }, packedOffer);
        await H.evaluate(async (packed) => {
            const { ConnectionUtils } = await import('./p2p/p2p-core.js');
            await window.__arcade.p2p._addon().peerNode.acceptAnswer(await ConnectionUtils.decodePayload(packed));
        }, packedAnswer);
        if (waitHost) {
            await H.waitForFunction(`window.__arcade.p2p.status() === 'connected'`, null, { timeout: 20000 });
        }
        await J.waitForFunction(`window.__arcade.p2p.status() === 'connected'`, null, { timeout: 20000 });
        return { packedOffer, packedAnswer };
    }

    // Poll for a mounted fixture's frame: attachment and URL assignment lag
    // the showGame() call, and a frames() snapshot taken too early returns
    // undefined on slow CI runners. Skip the main frame — showGame reflects
    // the gameId into the launcher URL as #app=<id> (deep links), so a bare
    // includes() would match the launcher page itself.
    async function fixtureFrame(page, needle) {
        for (let i = 0; i < 100; i++) {
            const f = page.frames().find(fr => fr !== page.mainFrame() && fr.url().includes(needle));
            if (f) return f;
            await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('fixture frame never attached');
    }

    const deviceIdOf = (page) => page.evaluate(() => localStorage.getItem('arcade.v1._meta.deviceId'));

    async function shutdown() {
        await browser.close();
        staticServer.kill();
        dropServer.close();
    }

    return {
        BASE, browser, dropTopics,
        newDeviceContext, launcherPage, bootBridge, ceremony,
        fixtureFrame, deviceIdOf, shutdown
    };
}
