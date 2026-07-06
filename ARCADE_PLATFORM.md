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

// STORAGE — sync, identical standalone or framed
Arcade.state.get(key)                 // localStorage 'arcade.v1.<gameId>.<key>'
Arcade.state.set(key, value)
Arcade.global.get(key)                // localStorage 'arcade.v1.global.<key>'
Arcade.global.set(key, value)
Arcade.onStateReplaced(fn)            // fires after a launcher import — re-read state

// MULTIPLAYER — async, gracefully no-ops when standalone
Arcade.peer.status()                  // 'unavailable' | 'idle' | 'connecting' | 'connected' | 'interrupted'
                                      // 'interrupted' = live session self-repairing (v1.7):
                                      // sends queue + replay; don't reset game state
Arcade.peer.onStatus(fn)
Arcade.peer.send(payload)
Arcade.peer.onMessage(fn)

// SETTINGS — launcher pushes its current values, SDK auto-applies CSS vars
Arcade.settings.fontScale()           // current launcher font scale (1 = default)
Arcade.onSettingsChange(fn)           // fires when launcher updates a setting

// CONTEXT — so games can light up extras when framed
Arcade.context                        // { framed: boolean, version: number }
```

**Settings auto-apply:** on `Arcade.init()` the SDK injects a low-priority rule `:root { font-size: calc(100% * var(--font-scale, 1)); }` at the start of `<head>` and writes `--font-scale` onto `<html>` whenever the launcher pushes settings. Net effect: any rem/em-sized text in a game scales with the launcher's font setting **without code changes**. Games that explicitly set `:root { font-size: … }` themselves win the cascade and can opt back in via `var(--font-scale)` directly. Range: 0.5× – 3.0× (launcher clamp).

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
child → parent:  { type: 'arcade:hello',   gameId, version: 1 }
parent → child:  { type: 'arcade:welcome', version: 1, peerStatus: 'idle',
                   settings: { fontScale } }
```

If no `welcome` arrives within ~300ms, SDK locks into standalone mode.

### Multiplayer & lifecycle

```
child  → parent: { type: 'arcade:peer.send',        payload }
parent → child:  { type: 'arcade:peer.message',     payload, fromPeer }
parent → child:  { type: 'arcade:peer.status',      status }
parent → child:  { type: 'arcade:state.replaced' }              // after file import
parent → child:  { type: 'arcade:settings.changed', settings }  // launcher setting updated
```

Seven message types total. The launcher routes peer messages by `gameId` so multiple games could in principle multiplex one connection, though the current design assumes one foreground game at a time.

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
| Proof | `tools/p2p-acceptance.mjs` + `tools/fixtures/p2p-test-game/` | two headless launchers, real RTCPeerConnection, fixture game speaks only SDK |

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
- The launcher menu's **Known Peers** panel (`index.html`, pure localStorage CRUD, no P2P module load required just to view/rename/delete) lets you rename or forget any entry, and live-refreshes when `arcade-p2p.js` reports a fresh handshake via `ArcadeP2P.onPeerIdentity`.
- Multi-peer safe: a host with several joiners (via "Invite another player") re-announces to each newly-connected peerId individually, so late joiners aren't left without a name exchange.

This is the lighter-weight sibling of the RTCCertificate idea below — it makes reconnecting *legible* (you know who you're pairing with) without changing the transport itself.

---

## Storage convention

| Scope         | Key shape                          | Owner                                       |
| ------------- | ---------------------------------- | ------------------------------------------- |
| Per-game      | `arcade.v1.<gameId>.<key>`         | Game writes; launcher reads only for export |
| Global        | `arcade.v1.global.<key>`           | Any game or launcher                        |
| Launcher meta | `arcade.v1._meta.<key>`            | Launcher only                               |

The `arcade.v1.` prefix is the **only** thing the export/import logic trusts. Keys without it are ignored on export and rejected on import (prevents poisoning unrelated localStorage entries on the origin).

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
  "schemaVersion": 1,
  "exportedAt": "2026-04-28T12:00:00.000Z",
  "appVersion": "1.0.0",
  "checksum": "sha256:<hex>",
  "data": {
    "arcade.v1.pi-game.highScore": "42",
    "arcade.v1.global.theme": "\"dark\"",
    "...": "..."
  }
}
```

- `format` and `schemaVersion` make the file self-describing and forward-compatible.
- `checksum` is computed over a canonical (sorted-key) serialization of `data` using SubtleCrypto's `sha256`. Detects corruption and partial writes.
- Values are stored as their raw `localStorage` string form — no double-parsing, no type drift.
- File is pretty-printed so it's human-inspectable in a text editor.

### Save (export) — failure modes handled

1. **Empty bundle** — if no `arcade.v1.*` keys exist, warn the user instead of producing a meaningless file.
2. **Serialization throws** — wrap in try/catch; surface the error to the UI; never write a partial file.
3. **Browser blocks download** — the launcher uses `URL.createObjectURL` + a synthetic `<a>` click; if that fails (rare, but happens in some embedded browsers), fall back to opening the JSON in a new tab so the user can copy/save manually.
4. **No silent overwrites** — filename always includes ISO timestamp: `pauls-arcade-save-2026-04-28T12-00-00.json`.

### Load (import) — defense in depth

The launcher treats imported files as **untrusted input**. Every step has a validation gate.

1. **File picker constraints** — `<input type="file" accept="application/json,.json">` and a server-side-of-the-client check that `File.size < 5 MB` (a real save is kilobytes; anything larger is suspicious).
2. **Read with `FileReader`**, wrapped in try/catch with explicit `onerror` handling.
3. **Parse defensively** — `JSON.parse` inside try/catch. Reject on any throw.
4. **Schema validation** — verify:
   - Top-level shape (`format === 'pauls-arcade-save'`, `schemaVersion === 1`, `data` is a plain object).
   - Every key in `data` matches `/^arcade\.v1\.[a-z0-9_-]+(\.[a-zA-Z0-9_.-]+)+$/`. Anything else is dropped with a warning, never written.
   - Every value is a string (localStorage's only supported value type).
   - Total payload size after re-serialization fits in available `localStorage` quota (best-effort estimate — try a probe write).
5. **Checksum verification** — recompute sha256 over the canonical form of `data`; reject if mismatched.
6. **Auto-backup before applying** — the launcher exports the *current* state to a downloaded file *automatically* (`pauls-arcade-autobackup-<timestamp>.json`) before touching anything. This is the single most important fault-tolerance feature: even if the import file is corrupt and the user clicks through every warning, the prior state is on their disk.
7. **Stage, then commit** — build the full set of write operations in memory; only after every key validates do we begin writing. If any write throws (quota exceeded mid-way), abort and restore from the in-memory snapshot of the prior values.
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

- **IndexedDB migration** for storage if any single game outgrows localStorage's ~5 MB ceiling.
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
