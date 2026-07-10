# Paul's Arcade

A launcher for a small catalog of browser games, all served from
`paulgibeault.github.io`, that turns plain static-HTML games into a platform
with **shared storage**, **cross-device save files**, and **serverless P2P
multiplayer** — without breaking anyone's ability to open a game standalone.

Live: [paulgibeault.github.io](https://paulgibeault.github.io) ·
Current lineup: Moon Lit, Pi Game, Silicon Syndicate, HecknSic, Cozy Solitaire.

---

## How it fits together

```
┌─────────────────────────────────────────────────────────────┐
│ index.html — the launcher                                   │
│  • iframe pool (bounded LRU, instant relaunch)               │
│  • save/load to file, settings menu, Multiplayer panel       │
│  • routes postMessage between games and the P2P bridge       │
├─────────────────────────────────────────────────────────────┤
│ arcade-sdk.js — window.Arcade, loaded by every game          │
│  • storage, player/scores/stats, lifecycle hooks, settings   │
│  • Arcade.peer.* — the entire multiplayer surface a game sees│
├─────────────────────────────────────────────────────────────┤
│ arcade-p2p.js + p2p/ — the launcher's WebRTC bridge           │
│  • in-repo transport, no signaling server                     │
│  • known peers, identity pinning, auto-reconnect (rendezvous) │
└─────────────────────────────────────────────────────────────┘
```

Because every game is hosted at `paulgibeault.github.io/<game>/`,
same-origin as the launcher, `localStorage` is already shared and the
browser's `storage` event gives free reactivity across windows. The
launcher-to-game bridge (`arcade-sdk.js` + a 10-message postMessage
protocol) exists only for what the browser can't do alone: multiplayer
transport and launcher-aware settings/lifecycle hints.

## Documentation

- **[ARCADE_PLATFORM.md](ARCADE_PLATFORM.md)** — the architecture doc. Covers
  the full `window.Arcade` SDK surface, the postMessage wire protocol, the
  serverless P2P multiplayer transport (known peers, identity pinning,
  auto-reconnect via a public rendezvous relay), the bounded iframe pool, and
  the fault-tolerant save/load-to-file design (checksums, auto-backup,
  staged commits). Read this to understand *why* the platform is shaped the
  way it is.

- **[GAME_INTEGRATION.md](GAME_INTEGRATION.md)** — the implementer's
  checklist for slotting a new game into the launcher: loading the SDK,
  migrating to namespaced storage keys, respecting launcher settings
  (font scale, theme, reduced motion, handedness), pausing cleanly when
  hidden/evicted, using `Arcade.peer.*` for multiplayer, iframe sandbox
  constraints, PWA/service-worker scoping, and the automated acceptance
  runner (`tools/acceptance.mjs`). Read this when integrating a game.

- **[p2p/PROTOCOL.md](p2p/PROTOCOL.md)**
  — the wire-format spec for the multiplayer transport, maintained in-repo
  beside its implementation in `p2p/` (see `p2p/README.md` for provenance —
  it originated in the now-archived QRCodeP2P repo). Summary:
  - Two browsers connect over WebRTC with **no signaling server** — the one
    unavoidable round trip (offer out, answer back) travels through a QR
    scan or a chat link, packed down to ~110–180 characters of pure SDP
    entropy.
  - A **link** (one `RTCPeerConnection`) and a **session** (sequence
    counters, exactly-once delivery, "who I'm playing with") are decoupled
    — a session can span many links over time.
  - **Resilience (v1.7):** heartbeats + a wake probe detect trouble fast;
    an `interrupted` state rides out app switches and notifications via
    in-band ICE restarts and a queued/replayed outbox, without ever
    resetting game state.
  - **Identity (v1.8):** a persistent per-browser ECDSA certificate gives
    each device a stable DTLS fingerprint; changes are surfaced as a
    trust-on-first-use notice, never hard-failed.
  - **Rendezvous (v1.9):** pairs that opt in can recover from a *total*
    connection loss (both devices offline, browsers killed) by
    re-signaling through a public MQTT dead-drop — everything published is
    AEAD-sealed with per-pair ratcheting keys, topics are unlinkable daily
    HMACs, and the relay can only delay or drop, never impersonate.

## Local development

```sh
./dev.sh ../<your-game-repo>            # stage launcher + one game, same origin
./dev.sh ../si-syn ../pi-game           # multiple games side-by-side
./dev.sh stop                           # kill the dev server
```

Serves everything on `127.0.0.1:4791` (override with `ARCADE_PORT`) so the
postMessage handshake, shared `localStorage`, and iframe `allow-same-origin`
all work exactly as they do in production. See GAME_INTEGRATION.md §12 for
dev-mode postMessage tracing (`?dev=1`).

## Automated checks

```sh
npm install && npx playwright install chromium
npm run acceptance -- http://127.0.0.1:4791/<gameId>/   # per-game integration checklist
npm run p2p-acceptance                                   # two headless launchers, real WebRTC
```

## Repo layout

| Path | What |
| --- | --- |
| `index.html` | The launcher: iframe pool, settings, save/load, Multiplayer panel |
| `arcade-sdk.js` | `window.Arcade` — the SDK every game loads |
| `arcade-p2p.js` | Launcher-side bridge to the vendored P2P transport |
| `p2p/` | The P2P transport + its protocol spec (maintained here; formerly vendored from the archived QRCodeP2P repo) |
| `profile.html` | Portfolio page — mirrors the game list shown in the launcher |
| `dev.sh` | Local same-origin dev harness for launcher + games |
| `tools/` | Playwright-based acceptance runners for games and P2P |
