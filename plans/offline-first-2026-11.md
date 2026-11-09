# Offline-first arcade

Goal: every load comes from cache; a new build arrives only when the player
accepts an update. The whole fleet stays playable in airplane mode.

A passive check may flag an update, provided it never interrupts launch or the
selected game.

## Constraints found

- Launcher game frames are sandboxed without `allow-same-origin`. Chromium
  testing confirmed a service worker never sees their requests, so game
  workers cannot provide in-launcher offline play.
- `sw.js` changes every deploy and a waiting worker activates when its tabs
  close, so worker activation cannot be what "the player's version" means.
- In a sandboxed `srcdoc` frame offline, `data:` ES modules through an import
  map loaded in Chromium and WebKit. Blob URLs failed in WebKit.

## Step 1: pinned launcher (this change)

- `sw.js` serves cache-first from the cache named by a stored pointer.
- `arcade-release.js` checks `release.json` (generated at stage time, with
  per-file SHA-256) and installs a release: stage, verify, move the pointer.
- The automatic update dialog is gone; a menu tag replaces it.

Known interim skew: framed games and their SDK still load live, so they can be
newer than a pinned launcher until step 2. The bridge is caps-negotiated.

## Step 2: game packs

`tools/build-pack.mjs` turns a staged game into one document. `arcade-packs.js`
stores packs and mounts them as sandboxed `srcdoc` frames, injecting the SDK
from the pinned release; a game with no pack loads from the network.

Audit of all 14 games booted offline in Chromium: 8 ran clean (pi-game, si-syn,
hecknsic, sowduku, shuiguo, p2p-chat, grav-well, hive-mind). Remaining: assets
named in JS strings or `fetch()` (moon-lit, cozy-solitaire, mr-pepper, cardstock,
audio-tune) and a `new URL()` against the frame location (sand-art). These need
a small in-frame shim over `fetch` and image loading, backed by the pack.

Still open:

- Publish `arcade-pack.json`: an opt-in `fleet-ci.yml` step after staging.
- Detect game-only deploys. The passive check compares launcher versions only,
  so each game needs a small version file too.

## Step 3: fleet rollout

Background-download every pack on first run, show "Ready for offline: n/14",
fall back to the network for a game with no pack, and explain build mismatches
in multiplayer. Add real-iPhone airplane-mode and storage-eviction tests.
