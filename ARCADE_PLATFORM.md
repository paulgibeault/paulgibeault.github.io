# Paul's Arcade — Platform Plan

A design for turning the launcher into a thin platform that gives every embedded game three superpowers — **shared storage**, **cross-device save files**, and **multiplayer** — without breaking standalone play.

---

## Core principle

Every game lives at `paulgibeault.github.io/<game>/`, same origin as the launcher.
That means:

- `localStorage` is **already shared** across the launcher and every game (per-origin, not per-path).
- The browser fires `storage` events into other same-origin windows automatically — free reactivity for free.
- A game running standalone reads/writes the same keys it would inside the launcher.

So **storage needs no bridge**. The launcher-to-game bridge only exists for things the browser cannot do alone: **multiplayer transport** and **launcher-aware UI hints**.

---

## SDK shape — `window.Arcade`

Hosted at `https://paulgibeault.github.io/arcade-sdk.js` (one source of truth — all games are same-origin and the launcher controls deploys).

```js
Arcade.init({ gameId: 'pi-game' });   // declares identity, runs handshake
await Arcade.ready;                    // resolves on welcome (or immediately standalone)

// STORAGE — sync, identical standalone or framed
Arcade.state.get(key)                 // localStorage 'arcade.v1.<gameId>.<key>'
Arcade.state.set(key, value)
Arcade.state.set(key, value, { exportable: false })  // local-only: excluded from save files
Arcade.state.remove(key)
Arcade.state.getOrInit(key, defaults) // deep-merges defaults under any stored value
Arcade.state.onChange(key, fn)
Arcade.state.migrate(version, fn)     // runs fn exactly once per (gameId, version)
Arcade.state.adopt(legacyKey, newKey?, { json? })  // read → namespaced write → delete original
Arcade.global.get(key)                // localStorage 'arcade.v1.global.<key>'
Arcade.global.set(key, value)         // set() returns true, or false on quota failure
Arcade.onStateReplaced(fn)            // fires after a launcher import — re-read state
Arcade.onStorageError(fn)             // a localStorage write was dropped (quota) — warn the user
Arcade.storage.estimate()             // { usage, quota } (async); persisted(); persist()

// ASYNC STORAGE — large/binary per-app data (IndexedDB KV + OPFS blobs); all
// Promises. Rides the launcher save bundle (schema v2); P2P keys never do.
const kv = Arcade.store.open('notes') // per-app KV DB 'arcade.v1.<gameId>.store.notes'
kv.get(k) / set(k, v) / del(k) / keys() / each(fn) / clear()
Arcade.files.put(name, blob) / get(name) / list() / delete(name)   // blobs (OPFS/IDB)

// HTML — escape peer/user text before it reaches innerHTML (stored-XSS guard)
Arcade.html.escape(str)               // → HTML-escaped string
Arcade.html`<b>${userText}</b>`       // tagged template auto-escapes interpolations

// PLAYER, SCORES, STATS — shared identity + leaderboard/stat helpers
Arcade.player.name() / setName(s)     // sticky display name, arcade.v1.global.playerName
Arcade.scores.add(category, entry, opts)  // top-100 sorted list, stamps name + ts;
                                      // opts.order 'desc' (default) | 'asc' (times);
                                      // entry.key labels an entry for keyed bests
Arcade.scores.list(category, opts) / best(category) / best(category, key) / clear(category)
Arcade.stats.get(category) / getOrInit(category, defaults) / update(category, fn)

// LIFECYCLE — launcher iframe-pool hints when framed, page visibility
// standalone; both sources merge into one deduplicated stream
Arcade.onSuspend(fn)                  // iframe hidden / about to be evicted / page hidden
Arcade.onResume(fn)                   // shown again
Arcade.context.suspended              // current effective state (also mirrored as
                                      // <html data-arcade-suspended="true|false">)
Arcade.session.start(opts)            // wall-clock tracker wired to suspend/resume
Arcade.session.setTimeout(fn, ms)     // freeze while suspended; cancel on stateReplaced
Arcade.session.setInterval(fn, ms)    // both return { cancel() }
Arcade.loop(fn)                       // managed rAF loop: { start, stop, kick, running,
                                      // dispose } — auto-cancels on suspend, resumes only
                                      // if it was running, deltas exclude suspended time

// MULTIPLAYER — async, gracefully no-ops when standalone
Arcade.peer.status()                  // 'unavailable' | 'idle' | 'connecting' | 'connected' | 'interrupted'
                                      // 'interrupted' = live session self-repairing (v1.7):
                                      // sends queue + replay; don't reset game state
Arcade.peer.onStatus(fn)              // aggregate status (all links folded into one value)
Arcade.peer.caps()                    // launcher capability flags (frozen array; [] standalone
                                      // or on an older launcher) — feature-detect additive
                                      // features: 'peer.sendTo', 'peer.roster', 'peer.meta'
Arcade.peer.send(payload)             // broadcast to every connected peer
Arcade.peer.send(payload, { to })     // targeted: only that deviceId receives it; returns
                                      // false (never broadcasts) when the launcher lacks the
                                      // 'peer.sendTo' cap or `to` is malformed. Routing, not
                                      // secrecy: joiner→joiner frames transit the host bridge
Arcade.peer.onMessage(fn)             // fn(payload, fromPeer, meta) — fromPeer is the sending
                                      // device's stable deviceId once identity completes;
                                      // meta = { relayed, to: 'me'|'all' } (cap 'peer.meta')
Arcade.peer.self() / remote()         // stable device identities ({ deviceId, name } | null)
Arcade.peer.peers()                   // full roster [{ deviceId, name, status, direct }] —
                                      // the multi-peer API (cap 'peer.roster'); direct=true
                                      // marks this device's own link (a joiner's host)
Arcade.peer.onPeersChange(fn)         // fn(rosterArray) on any join/leave/rename/status change
Arcade.peer.onReady(fn)               // remote device has THIS game mounted and listening
Arcade.peer.sendBlob(blob, { onProgress }) / onBlob(fn)  // chunked large payloads (broadcast)
Arcade.peer.queue() / onQueue(fn)     // replay-queue { depth, limit, overflowed }

// SETTINGS — launcher pushes its current values, SDK auto-applies CSS vars/attrs
Arcade.settings.fontScale()           // current launcher font scale (1 = default)
Arcade.settings.theme()               // 'light' | 'dark'
Arcade.settings.reducedMotion()       // boolean
Arcade.settings.audioVolume()         // 0..1
Arcade.settings.handedness()          // 'left' | 'right'
Arcade.onSettingsChange(fn)           // fires when launcher updates a setting

// UI — launcher-rendered toast when framed, in-place fallback standalone
Arcade.ui.toast(message, { kind, duration })

// CONTEXT — so games can light up extras when framed
Arcade.context                        // { framed: boolean, version: number, gameId }
```

**Settings auto-apply:** on `Arcade.init()` the SDK injects a low-priority rule `:root { font-size: calc(100% * var(--font-scale, 1)); }` at the start of `<head>` and writes `--font-scale` onto `<html>` whenever the launcher pushes settings. Net effect: any rem/em-sized text in a game scales with the launcher's font setting **without code changes**. Games that explicitly set `:root { font-size: … }` themselves win the cascade and can opt back in via `var(--font-scale)` directly. Range: 0.5× – 3.0× (launcher clamp). The SDK also applies `data-theme`, `--motion-scale`, `--audio-volume`, and `data-handedness` — see GAME_INTEGRATION.md §5 for the full DOM-hook table. Of the five settings, only `fontScale` and the iframe-pool cap have a real launcher-menu control today; `theme`/`reducedMotion` mirror `prefers-color-scheme`/`prefers-reduced-motion`, and `audioVolume`/`handedness` currently ship fixed defaults — there is no in-launcher toggle for them yet.

**Standalone mode:** `framed=false`, `peer.status()` locked at `'unavailable'`. Storage just works because of same-origin localStorage.

**Framed mode:** SDK detects launcher via handshake, surfaces multiplayer, listens for import events.

### Minimum integration per game

```html
<script src="https://paulgibeault.github.io/arcade-sdk.js"></script>
<script>Arcade.init({ gameId: 'pi-game' });</script>
```

Existing `localStorage.setItem('myKey', ...)` calls can be migrated to `Arcade.state.set('myKey', ...)` opportunistically — until then, they still work, they just won't be namespaced into the export bundle.

---

## Wire protocol (postMessage)

All messages namespaced `arcade:` to avoid collision.

### Handshake

```
child → parent:  { type: 'arcade:hello',   gameId, version: 2 }
parent → child:  { type: 'arcade:welcome', version: 2, peerStatus: 'idle',
                   caps: ['peer.sendTo', 'peer.roster', 'peer.meta'],  // capability flags (absent ⇒ [])
                   peers: [{ deviceId, name, status, direct }, ...],   // live remote devices (roster seed)
                   settings: { fontScale, theme, reducedMotion, audioVolume, handedness } }
```

If no `welcome` arrives within ~300ms, SDK locks into standalone mode.

### Multiplayer & lifecycle

```
child  → parent: { type: 'arcade:peer.send',         payload, to? }        // to = target deviceId (targeted send)
parent → child:  { type: 'arcade:peer.message',      payload, fromPeer, meta }  // fromPeer = sender deviceId;
                                                                           // meta = { relayed, to: 'me'|'all' }
parent → child:  { type: 'arcade:peer.status',       status }
parent → child:  { type: 'arcade:peer.roster',       peers }               // full roster on any change
parent → child:  { type: 'arcade:peer.identity',     deviceId, name }      // roster update (legacy single-peer)
parent → child:  { type: 'arcade:peer.ready',        deviceId, name }      // remote same-game listening
parent → child:  { type: 'arcade:peer.queue',        depth, limit, overflowed } // replay-queue visibility
parent → child:  { type: 'arcade:state.replaced' }               // after file import
parent → child:  { type: 'arcade:settings.changed',  settings }  // launcher setting updated
parent → child:  { type: 'arcade:lifecycle.suspend' }             // iframe hidden, or about to be evicted
parent → child:  { type: 'arcade:lifecycle.resume' }              // iframe shown
child  → parent: { type: 'arcade:ui.toast',          message, kind, duration }
```

Fourteen message types total (see GAME_INTEGRATION.md §14 for the full summary table). The launcher routes peer messages by `gameId` so multiple games could in principle multiplex one connection, though the current design assumes one foreground game at a time. Between launchers, presence frames (`{arcade:1, kind:'presence'|'presence-ack', gameId}`) announce that a game is mounted and listening; the receiving launcher surfaces them to the matching game as `arcade:peer.ready`.

**Legacy compatibility shim:** a small number of older games (e.g. hecknsic) shipped their own postMessage-backed `localStorage` override before the SDK existed. The launcher still answers that game's `'ls-proxy-request'`/`'ls-proxy-response'` protocol (namespaced into `arcade.v1.<gameId>.ls.<key>`) purely so those games don't hang — this is launcher-side legacy support, not part of the `arcade:` protocol, and new games should use `Arcade.state.*` directly rather than rolling a shim of their own.

---

## Multiplayer transport — serverless P2P backbone (IMPLEMENTED)

The transport behind `Arcade.peer.*` is [QRCodeP2P](https://github.com/paulgibeault/QRCodeP2P) (v1.5.1+): WebRTC data channels with **no signaling server** — the offer/answer exchange travels through QR codes or chat links. Proven cross-engine (Chrome/Firefox/WebKit) with automated Playwright tests; see its `IMPLEMENTATION_NOTES.md` for the wire format and test matrix.

**Implementation map (this repo):**

| Piece | File | Notes |
| ----- | ---- | ----- |
| Vendored transport | `p2p/` | synced from QRCodeP2P via `tools/sync-p2p.sh`; QR libs vendored under `p2p/vendor/` so runtime never touches a CDN |
| Launcher bridge | `arcade-p2p.js` | lazy ES module: status mapping (transport → SDK vocabulary), `{arcade:1, gameId, payload}` envelope, per-game routing |
| Launcher wiring | `index.html` platformController | Multiplayer menu item, `arcade:peer.send` → bridge, bridge status → `arcade:peer.status` broadcast, `#p2p-offer/answer` fragment boot |
| Game-facing API | `arcade-sdk.js` `Arcade.peer.*` | unchanged — games needed zero edits |
| Proof | `tools/p2p-acceptance.mjs` (`npm run p2p-acceptance`) + `tools/fixtures/p2p-test-game/` | two headless launchers, real RTCPeerConnection, fixture game speaks only SDK |

`arcade-p2p.js` also holds the Screen Wake Lock while a P2P session is `'connected'`/`'interrupted'`, so the screen dimming mid-session doesn't get treated as a connection loss.

### Core facts the design builds on

- **Payloads are tiny.** Binary template packing (`sdp-codec.js`) transmits only the SDP's entropy (ICE credentials, DTLS fingerprint, candidates): **112–153 chars**. QR codes scan instantly; links survive SMS/iMessage.
- **One round trip is irreducible.** DTLS fingerprints must flow both ways and browsers cannot import certificate material, so the ceremony is always: offer out, answer back. All UX work goes into making each leg frictionless.
- **The launcher owns the connection** — games never see any of this. `Arcade.peer.send/onMessage` is the whole game-facing surface, and a game works identically whether the connection came from a QR scan or a chat link.

### Connection ceremony (host's launcher ⇄ joiner's launcher)

1. **Invite (offer out):** host opens the launcher's Multiplayer panel → share sheet sends `https://paulgibeault.github.io/#p2p-offer=<packed>` through any chat app. Desktop fallback: QR code.
2. **Reply (answer back), in order of preference:**
   - **Link tennis** — joiner taps "Send reply link"; the answer returns through the same chat thread. On the host device the tapped link opens a relay tab that forwards the answer to the launcher tab (BroadcastChannel + localStorage + opener) and confirms delivery with an ack.
   - **QR scan** — host scans the joiner's answer QR (same-room path; the camera grant also unlocks Safari host candidates — see below).
   - **Screenshot decode** — joiner texts a screenshot of the answer QR; host decodes it from the image (remote path without link tennis).
3. **Connected** — the launcher flips `peerStatus` and broadcasts `arcade:peer.status` to the foreground game.

### Why the launcher URL matters (app re-entry)

`#p2p-offer=` / `#p2p-answer=` fragments are handled by the **launcher**, giving every game multiplayer through one stable URL. Fragments never reach the server and are stripped after ingestion. Games embedded in iframes are unaffected — the fragment routing lives in the top-level launcher page only.

### Connection modes & platform caveats (from the QRCodeP2P test matrix)

| Mode | External touch | Works |
| ---- | -------------- | ----- |
| **Anywhere** (default) | Public STUN only (reflects your IP; no data or signaling transits it) | Cross-network + LAN, all engines |
| **Same Wi-Fi only** | None whatsoever | LAN only; Chrome/Firefox always, Safari only with a camera grant |

- **Safari withholds ICE candidates** without STUN or a device-capture permission. Consequence: Safari joiners on pure link tennis need "Anywhere" mode; the QR flow is immune because scanning grants the camera. The transport emits a diagnostic when zero candidates are gathered.
- **Safari↔Safari link tennis on one LAN** is srflx↔srflx and depends on router NAT hairpinning. Mitigation (follow-on): one-time "improve connection" camera grant on Safari.

### Diagnostics

The transport's stage tracker (offer created → invite sent → answer received → connected) and copy-transcript button surface in the launcher's Multiplayer panel, so a failed real-world attempt reports exactly which leg died — this is the debugging backbone for all multiplayer support.

### Known peers — naming and reconnect recognition (IMPLEMENTED)

WebRTC can't skip the offer/answer ceremony — DTLS fingerprints must flow both ways every time a new `RTCPeerConnection` is created, so "reconnecting" is still one QR/link exchange. What this feature buys instead: the launcher *recognizes* who you just reconnected to and remembers what you called them.

- Each device holds a persistent, random `deviceId` (`arcade.v1._meta.deviceId`) and a user-editable `deviceName` (`arcade.v1._meta.deviceName`, default "My device"), both generated/read lazily by `arcade-p2p.js`.
- The instant any peer's data channel opens, both sides broadcast `{ arcade: 1, kind: 'identity', deviceId, name }` over the same channel used for game traffic (harmless to older peers — filtered out before game routing either way).
- The receiving bridge upserts `arcade.v1._meta.knownPeers[deviceId]` — `name` is a local, user-editable label seeded from the peer's self-reported `remoteName`, plus `firstConnectedAt` / `lastConnectedAt` / `timesConnected`.
- **First contact with a new device** (`ArcadeP2P.onPeerIdentity`'s `isNew` flag): the launcher prompts "Name this connection", pre-filled with the peer's self-reported name as a suggestion — accept it as-is or type something else. Reconnecting later never re-prompts; the stored `name` is never silently overwritten by later handshakes.
- The **Multiplayer dialog** (`index.html`, opened via the menu's single "Multiplayer" item — device name, "New connection", and the full saved-connections manager all live behind it) is the full-featured saved-connections manager — see below. Names/rename/delete render instantly from localStorage with no P2P module load; the dialog live-refreshes when `arcade-p2p.js` reports a fresh handshake via `ArcadeP2P.onPeerIdentity`.
- Multi-peer safe: a host with several joiners (via "Invite another player") re-announces to each newly-connected peerId individually, so late joiners aren't left without a name exchange.

### One-tap reconnect + identity pinning (IMPLEMENTED, transport v1.8)

- **One-tap reconnect:** the "🔗 New invite code" action on a Multiplayer dialog row opens the connect ceremony modal in `{mode:'host'}` — no Host/Join choice screen, a *fresh* invite code is on screen immediately (show it or send it as a link; link-tennis automates the other device's half). Signaling stays one-time-use by design — that's what keeps a leaked old invite link harmless — so "reconnect" means *fresh code, zero navigation*, not replay.
- **Persistent identity:** the transport now keeps one ECDSA `RTCCertificate` per browser profile (IndexedDB), so a device's DTLS fingerprint is stable across sessions. Each known peer records the fingerprint of its DIRECT link (`knownPeers[deviceId].fingerprint`); identities arriving via the host's relay never bind a fingerprint (the transport stamps relayed frames).
- **Pinning policy is TOFU-with-notice, not hard-fail:** every connection today is a manual in-person ceremony — that exchange IS the authentication — and browsers rotate certificates ~monthly, so a changed fingerprint surfaces a warning toast (`fingerprintChanged` on `onPeerIdentity`) telling the user to re-verify in person if unexpected. Hard cryptographic pair-binding lives in the rendezvous pair secret below.

### Auto-reconnect — rendezvous (IMPLEMENTED, transport v1.10)

The full protocol spec lives in `QRCodeP2P/PROTOCOL.md` (§7). Launcher wiring:

- **Opt-in per pair, both sides:** at first contact (after the naming prompt) the launcher asks whether to reconnect automatically; the flag lives in `knownPeers[deviceId].autoReconnect` and is toggleable per peer in the Multiplayer dialog (🔁/🚫). When both sides opt in, a pairing secret is derived over the live DTLS channel — and **re-derived on every later manual ceremony** (each physical meeting is a fresh trust event).
- **What it does:** if the connection dies completely (grace expired, channel closed, both networks changed, browsers restarted), the transport re-signals through a public MQTT-over-WSS broker (`wss://test.mosquitto.org:8081/mqtt`). Everything published is end-to-end AEAD-sealed with per-pair keys; topics are unlinkable daily HMACs; epochs kill replays; keys ratchet on every successful reconnect. **Content** is therefore safe from the broker: it can only delay or drop, and the worst case is falling back to the one-tap manual re-pair. **Metadata** is not: the broker — and anyone subscribed to the public relay's topic space — learns both devices' IP addresses, the fact that some pair is rendezvousing, and when. If that linkage matters to you, don't opt in to auto-reconnect; manual QR/link pairing never touches a relay.
- **What games see:** `interrupted` for the whole repair (the launcher holds the `idle` transition for a beat so a terminal teardown claimed by rendezvous never flashes `idle`), then `connected` with the SAME session — sends made while the link was dead queue into the stashed session and replay on adoption, exactly-once.
- **Resume-on-launch:** `arcade.v1._meta.lastLiveSession` timestamps live paired sessions; if the launcher opens within 6 h of one, it boots the transport and calls `resumeRendezvous()` — two devices whose browsers were both killed re-establish the session with zero interaction. Outside that window, any non-hung-up auto-reconnect peer still boots the transport into quiet STANDBY (`RendezvousManager.standbyAll`): the device initiates nothing, but a Call from the other side reaches it for as long as the arcade is open.
- **Presence discipline (v1.10 trade-off):** a CONNECTED pair touches no relay. A pair that is enabled but DISCONNECTED holds a standing, pseudonymous subscription (daily-rotating HMAC topics) while the arcade is open — that's what makes Call land on a merely-open device and lets auto-heal survive outages longer than one repair episode. Active publishing still runs only during episodes (10-min active phase, then a slow quiet-phase republish bounded by the 6 h resume window). Pairs the user hung up subscribe to nothing.

### Multiplayer dialog — device name, call/hang up, start over (IMPLEMENTED)

The launcher menu's Network section is a single "Multiplayer" item (`#connections-dialog`, id kept from when this was called the Connections dialog) — it opens one dialog holding the device name field, "New connection", and the full saved-connections manager, so Network never grows past one menu row no matter how many connection-lifecycle controls it gains. Every saved connection gets three lifecycle controls beyond rename/delete/auto-reconnect, framed like a phone call — live means Hang Up ends it (keeping the number to call back later), not-live means Call tries to silently bring it back:

- **☎️ Hang Up** (shown while a peer is live): calls `ArcadeP2P.hangUpKnownPeer(deviceId)`, which first says goodbye over the live control channel (`RendezvousManager.sendBye` — the other side cancels its repair, records `byeAt`, drops the link promptly, and parks in quiet standby instead of burning a 10-minute episode on a link we closed on purpose), then tells our rendezvous layer to stand down (`RendezvousManager.pausePair` — clears the pair's `enabled` flag in IndexedDB and cancels any in-flight episode) *before* tearing the link down (`PeerManager.disconnectPeer`), so the disconnect's own `'disconnected'` status event doesn't immediately re-trigger a repair episode. The pairing secret is kept — this directly answers "does healing suspend on its own, or can I terminate now and reopen later": both are true, and Hang Up is the explicit form of the latter. The receiving launcher surfaces it as a friendly "X hung up" toast (`ArcadeP2P.onRemoteBye`), not a connection error.
- **📞 Call** (shown while hung-up/idle, only for auto-reconnect peers): calls `ArcadeP2P.callKnownPeer(deviceId)`, which re-arms the pair (`RendezvousManager.resumePair` flips `enabled` back on, clears any received bye, and kicks a reconnect episode against the pair's last known peerId). The episode RINGS: the listener role publishes a sealed doorbell that provokes the caller role into arming a fresh offer, so a one-sided Call lands on any peer whose arcade is merely open with the pair enabled — actively repairing, quiet after a timeout, or standing by since boot. It still honestly reports back when there's no pairing secret on record to re-arm (never established, or lost before the last manual reconnect) rather than claiming an attempt that can't happen. A "🔗 New invite code" action is always shown alongside it as the deterministic manual fallback.
- **↺ Start over**: calls `ArcadeP2P.startOverKnownPeer(deviceId)` — drops any live link, forgets the stashed session (`PeerManager.forgetSession`, so the next connection can't try to resume old sequence counters), and forgets the rendezvous pairing secret entirely (`RendezvousManager.disablePair`), flipping auto-reconnect off. The saved name and connection history stay; only **✕ Delete** forgets the device outright. Use this when a connection is stuck in a bad state and Call doesn't help.
- **🔧 Connection log** (dialog footer): opens a dedicated overlay with a read-only, live-tailing view of the session-long connection log (`arcade-diag.js` ring buffer). Every connection-related layer writes into it from the moment the page loads — the launch resume decision (`boot`), bridge status transitions and user actions (`bridge`), transport diagnostics (`p2p`), rendezvous episode lifecycle including publish/receive/decrypt outcomes (`rdv`), and MQTT carrier socket state (`mqtt`). This exists because the only other diagnostics view lives inside the New-connection ceremony, and opening that to *read* the log would itself start a hosting attempt and pollute the record; this view starts nothing. "📋 Copy to clipboard" puts a timestamped transcript (with UA header) on the clipboard (clipboard API → hidden-textarea `execCommand` → prompt fallback chain, for iOS/WebView quirks), and a "📤 Share…" button rides the native share sheet where `navigator.share` exists. Also reachable from any console as `window.__arcadeDiag`.

**Bfcache resume gap:** a page the browser restores from its back-forward cache (e.g. Back after navigating to a different page) doesn't always re-run index.html's startup script — it resumes the frozen JS heap instead. Without a second trigger, a connection killed by that navigation would sit dead until the user reconnects by hand, since the startup-only `resumeRendezvous()` check never got a chance to run again. index.html listens for `pageshow` and re-runs the same freshness check whenever `event.persisted` is true.

### Multiplayer dialog — device name, call/hang up, start over (IMPLEMENTED)

The launcher menu's Network section is a single "Multiplayer" item (`#connections-dialog`, id kept from when this was called the Connections dialog) — it opens one dialog holding the device name field, "New connection", and the full saved-connections manager, so Network never grows past one menu row no matter how many connection-lifecycle controls it gains. Every saved connection gets three lifecycle controls beyond rename/delete/auto-reconnect, framed like a phone call — live means Hang Up ends it (keeping the number to call back later), not-live means Call tries to silently bring it back:

- **☎️ Hang Up** (shown while a peer is live): calls `ArcadeP2P.hangUpKnownPeer(deviceId)`, which drops the link (`PeerManager.disconnectPeer`) and, for an auto-reconnect pair, tells the rendezvous layer to stand down (`RendezvousManager.pausePair` — clears the pair's `enabled` flag in IndexedDB and cancels any in-flight episode) *before* tearing the link down, so the disconnect's own `'disconnected'` status event doesn't immediately re-trigger a repair episode. The pairing secret is kept — this directly answers "does healing suspend on its own, or can I terminate now and reopen later": both are true, and Hang Up is the explicit form of the latter.
- **📞 Call** (shown while hung-up/idle, only for auto-reconnect peers): calls `ArcadeP2P.callKnownPeer(deviceId)`, which re-arms the pair (`RendezvousManager.resumePair` flips `enabled` back on and kicks one reconnect episode against the pair's last known peerId) and attempts a silent reconnect through the dead-drop — best-effort only, since it needs the other device to be reachable there too, and honestly reports back when there's no pairing secret on record to re-arm (never established, or lost before the last manual reconnect) rather than claiming an attempt that can't happen. A "🔗 New invite code" action is always shown alongside it as the deterministic manual fallback.
- **↺ Start over**: calls `ArcadeP2P.startOverKnownPeer(deviceId)` — drops any live link, forgets the stashed session (`PeerManager.forgetSession`, so the next connection can't try to resume old sequence counters), and forgets the rendezvous pairing secret entirely (`RendezvousManager.disablePair`), flipping auto-reconnect off. The saved name and connection history stay; only **✕ Delete** forgets the device outright. Use this when a connection is stuck in a bad state and Call doesn't help.

**Bfcache resume gap:** a page the browser restores from its back-forward cache (e.g. Back after navigating to a different page) doesn't always re-run index.html's startup script — it resumes the frozen JS heap instead. Without a second trigger, a connection killed by that navigation would sit dead until the user reconnects by hand, since the startup-only `resumeRendezvous()` check never got a chance to run again. index.html listens for `pageshow` and re-runs the same freshness check whenever `event.persisted` is true.

---

## Storage convention

| Scope          | Key / DB shape                          | Owner                                       |
| -------------- | --------------------------------------- | ------------------------------------------- |
| Per-game       | `arcade.v1.<gameId>.<key>`              | Game writes; launcher reads only for export |
| Global         | `arcade.v1.global.<key>`                | Any game or launcher                        |
| Launcher meta  | `arcade.v1._meta.<key>`                 | Launcher only                               |
| Per-game KV    | IndexedDB `arcade.v1.<gameId>.store.<name>` | `Arcade.store` — large/structured data  |
| Per-game blobs | OPFS dir `arcade.v1.<gameId>` / IDB `arcade.v1.<gameId>.files` | `Arcade.files` — binary  |

The `arcade.v1.` prefix is the **only** thing the export/import logic trusts. Keys/databases without it are ignored on export and rejected on import (prevents poisoning unrelated storage on the origin). The async stores/blobs ride the save bundle too (schema v2); the P2P key stores (`qrp2p-*`) never match the prefix and are never exported.

---

## Trust model — first-party fleet

The platform's current posture is a **first-party fleet**: every catalog app is authored by the same owner, all apps are same-origin with the launcher, and storage namespacing (`arcade.v1.<gameId>.*`) is a **cooperative convention, not a security sandbox**. A same-origin app *can* technically read another app's storage or reach the launcher — this is acceptable precisely because all apps are trusted first-party code.

Two things remain **untrusted** even under this posture, and keep their hard guards:
- **Imported save files** — treated as hostile input (allowlist, checksum, per-key validation, staged commit; see below).
- **Peer-supplied payloads** — names/ids/messages from a remote device must be escaped before rendering (`Arcade.html.escape`) and validated before use.

True multi-tenant isolation (untrusted third-party apps on a sandboxed sub-origin, a capability/permission model, storage brokered over postMessage) is a deliberate **v2 epic**, deferred so it isn't back-doored into the same-origin model. See the fleet issue tracker.

---

## Iframe pool

A bounded LRU map of recently-played games, all kept mounted, toggled via `hidden`. Lives in the `platformController` IIFE in [index.html](index.html) — see `ensureIframe`, `showGame`, `evictLRU`, and `hideGameView`.

- First launch of a game: full load.
- Every subsequent launch within the cap: instant, with audio context, scroll, WebGL state intact.
- Quit hides the active iframe rather than tearing it down — instant relaunch of the last-played game.
- When launching a new game would exceed the cap, the least-recently-used non-active entry is evicted: an `arcade:lifecycle.suspend` is sent (defensive flush — the entry is already non-active and thus already suspended), then `iframe.src = 'about:blank'` and the iframe is removed from the DOM. This frees the JS heap, audio context, and WebGL context.

**Cap policy:**
- Default cap is **2** — keeps back-and-forth between two games instant (the common case) without unbounded growth as the catalog expands.
- User-tunable via the *Keep in Memory* numeric input in the launcher menu. The user types any positive integer; the launcher clamps to `[1, gameCount]` where `gameCount` is the number of launcher buttons. A value at the cap (e.g. `5` when the catalog has 5 games) effectively disables eviction. Persisted at `arcade.v1.global.poolCap`.
- The active game is **never** evicted, even at cap=1.
- Lowering the cap trims excess entries immediately, not on the next launch.

**What survives eviction:** persistent state is in `arcade.v1.<gameId>.*` localStorage and is untouched. A re-launched game does a fresh load and restores user-visible progress via the SDK's normal init path. Only in-memory state (audio decode buffers, scroll position, ephemeral UI state) is lost.

**Why this matters:** WebGL contexts are a limited resource per page (browsers may drop the oldest if too many are alive); hidden iframes that haven't implemented `onSuspend` correctly keep burning CPU/battery. The cap bounds both costs regardless of catalog size and protects against misbehaving games.

---

## Save / load to file — fault-tolerant by construction

Save and load are the only places where data loss is possible. The plan treats them as a small, paranoid subsystem.

### Export format

```json
{
  "format": "pauls-arcade-save",
  "schemaVersion": 2,
  "exportedAt": "2026-04-28T12:00:00.000Z",
  "appVersion": "1.0.0",
  "checksum": "sha256:<hex>",
  "data": {
    "arcade.v1.pi-game.highScore": "42",
    "arcade.v1.global.theme": "\"dark\"",
    "...": "..."
  },
  "stores": {
    "arcade.v1.sowduku.store.packs": { "pack-1": { "name": "…" } }
  },
  "files": {
    "arcade.v1.notes-app": [ { "name": "photo.jpg", "type": "image/jpeg", "size": 20481, "b64": "…" } ]
  }
}
```

- `format` and `schemaVersion` make the file self-describing and forward-compatible. **Schema 2** adds `stores` (Arcade.store IndexedDB KV) and `files` (Arcade.files blobs, base64). **Schema-1 files still import** (localStorage only).
- `checksum` is sha256 over a canonical (recursively sorted-key) serialization; for v2 it covers `data` + `stores` + `files` together. Detects corruption and partial writes.
- `data` values are raw `localStorage` strings — no double-parsing, no type drift. `stores` values are JSON; `files` blobs are base64 with their MIME type.
- The P2P key stores (`qrp2p-*`) are **never** enumerated — device identity/pairing secrets never leave the device.
- File is pretty-printed so it's human-inspectable in a text editor.

### Save (export) — failure modes handled

1. **Empty bundle** — if no `arcade.v1.*` keys exist, warn the user instead of producing a meaningless file.
2. **Serialization throws** — wrap in try/catch; surface the error to the UI; never write a partial file.
3. **Browser blocks download** — the launcher uses `URL.createObjectURL` + a synthetic `<a>` click; if that fails (rare, but happens in some embedded browsers), fall back to opening the JSON in a new tab so the user can copy/save manually.
4. **No silent overwrites** — filename always includes ISO timestamp: `pauls-arcade-save-2026-04-28T12-00-00.json`.

### Load (import) — defense in depth

The launcher treats imported files as **untrusted input**. Every step has a validation gate.

1. **File picker constraints** — `<input type="file" accept="application/json,.json">` and a size check (`File.size < 64 MB`; localStorage-only saves are kilobytes, but a save with embedded `files` blobs can be larger).
2. **Read with `FileReader`**, wrapped in try/catch with explicit `onerror` handling.
3. **Parse defensively** — `JSON.parse` inside try/catch. Reject on any throw.
4. **Schema validation** — verify:
   - Top-level shape (`format === 'pauls-arcade-save'`, `schemaVersion` in `[1, SAVE_SCHEMA]`, `data` is a plain object).
   - Every key in `data` matches `/^arcade\.v1\.[a-z0-9_-]+(\.[a-zA-Z0-9_.-]+)+$/`. Anything else is dropped with a warning, never written. `stores` DB names and `files` names are validated the same way against their own regexes; dunder segments are rejected.
   - Every `data` value is a string (localStorage's only supported value type).
   - Total localStorage payload fits available quota (best-effort probe write).
5. **Checksum verification** — recompute sha256 over the canonical form: `data` for v1, or `data` + `stores` + `files` for v2; reject if mismatched.
6. **Auto-backup before applying** — the launcher exports the *current* state to a downloaded file *automatically* (`pauls-arcade-autobackup-<timestamp>.json`) before touching anything. This is the single most important fault-tolerance feature: even if the import file is corrupt and the user clicks through every warning, the prior state is on their disk.
7. **Stage, then commit** — build the full set of localStorage write operations in memory; only after every key validates do we begin writing. If any write throws (quota exceeded mid-way), abort and restore from the in-memory snapshot of the prior values. The async `stores`/`files` are written *after* the localStorage commit (IndexedDB/OPFS can't share the synchronous rollback) — best-effort, with the Gate-6 auto-backup as the safety net if one fails.
8. **Confirmation UI** — before applying, show a summary: "This will replace 23 keys (4 games + global). Current state will be auto-saved to your Downloads folder first. Continue?"
9. **Notify games** — after successful commit, broadcast `arcade:state.replaced` to all mounted iframes; the storage event fires automatically too, so listeners catch it via either path.

### Modern safety practices applied

- **No `eval`, no `Function()`, no `innerHTML`** anywhere in the import path. JSON only.
- **Origin allowlist on `postMessage`** — the launcher only accepts arcade-namespaced messages whose `event.source` is a known mounted iframe and whose `event.origin` matches `location.origin`. Same in the SDK: it only listens to messages from `window.parent` with the matching origin.
- **Key allowlist regex** — already covered above; this prevents an imported file from writing `__proto__`, `constructor`, or arbitrary non-arcade keys to the origin's localStorage.
- **Quota probe** — before bulk-writing, try writing a single sentinel key; if it throws `QuotaExceededError`, abort cleanly with a clear error message rather than half-applying.
- **No network calls** — import/export is purely local. No telemetry, no upload.
- **CSP-friendly** — the SDK and launcher avoid inline event handlers in injected content; everything is wired with `addEventListener`.
- **Subresource Integrity (optional, future)** — once `arcade-sdk.js` stabilizes, games can pin a hash via `<script src="..." integrity="sha384-...">` for tamper detection.

### Recovery path

If a user reports lost data:
1. The most recent auto-backup is in their Downloads folder, named with timestamp.
2. The auto-backup uses the exact same format as a normal export — they can re-import it through the same UI.
3. The launcher could optionally keep the last N auto-backups in IndexedDB as a belt-and-suspenders measure, but that's a follow-on; downloaded files are the canonical recovery medium.

---

## Open follow-ons (not in initial scope)

- ~~**IndexedDB migration** for storage if any single game outgrows localStorage's ~5 MB ceiling.~~ **Shipped** — `Arcade.store` (async IndexedDB KV) and `Arcade.files` (OPFS/IDB blobs); both ride the save bundle.
- **Last-N auto-backups in IndexedDB** as a secondary recovery channel.
- **SDK version negotiation** — the handshake already carries `version`; bump and branch when the protocol changes.
- **Certificate-pinned reconnect** — cache an `RTCCertificate` in IndexedDB so a previously-paired device's DTLS fingerprint is verifiable across sessions, as a foundation for shorter reconnect payloads. Named/recognized known peers (see "Known peers" above) already cover the naming half of this; the ceremony itself is still a full offer/answer round trip.
- **PWA manifest + Android `share_target`** — installed launcher receives shared invite links directly; improves the re-entry story on both platforms.
- **Audio-chirp answer leg** — ~140-byte payloads fit in a 2–4 s WebAudio FSK chirp; joiner's phone "sings" the answer to the host's laptop. Best return path for the phone→laptop direction where QR is most awkward.
- **Safari "improve connection" camera grant** — unlocks host candidates for zero-server LAN play on Safari.

---

## Decisions captured

1. **Iframe pool: bounded LRU.** Default cap of 2; user-tunable to any integer in `[1, gameCount]` via the launcher menu. Active game is never evicted. Persistent state survives via `arcade.v1.<gameId>.*` localStorage.
2. **`arcade-sdk.js` hosted at `https://paulgibeault.github.io/arcade-sdk.js`** (this repo's GitHub Pages root). Single source of truth; same-origin with every game.
3. **Multiplayer transport: QRCodeP2P (serverless WebRTC).** The launcher owns the single `PeerManager`; games only ever see `Arcade.peer.*`. Signaling travels via packed QR/chat-link payloads (link tennis primary, QR/screenshot fallbacks). Default ICE mode "Anywhere" (public STUN, required for Safari joiners); "Same Wi-Fi only" available for zero-external-touch play. `#p2p-offer=`/`#p2p-answer=` fragments are launcher-level routes.
4. **Trust posture: first-party fleet.** All catalog apps are trusted same-origin first-party code; storage namespacing is a cooperative convention, not a sandbox. Imported files and peer payloads remain untrusted. Cross-origin multi-tenant isolation + a capability model is a deferred v2 epic, not retrofitted into the same-origin model.
5. **Async app storage: `Arcade.store` / `Arcade.files`.** Large/binary data lives in per-app IndexedDB/OPFS and rides the save bundle (schema v2). P2P key stores are excluded from export by allowlist.
