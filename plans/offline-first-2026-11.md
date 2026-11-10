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

Games reach assets named at runtime through an in-frame shim over `fetch` and
media `src`, backed by the pack. Compiled kernels get their wasm from the
launcher at mount. All 14 real games mounted from packs in airplane mode
through the real launcher in Chromium. audio-tune still requests other games'
sound packs, which stay network-only.

`fleet-ci.yml` publishes a pack for callers that set `offline_pack: true`, with
a small version file so the passive check can flag a game-only deploy.

## Step 3: fleet rollout

Done 2026-11-09: all 14 catalog games set `offline_pack: true` and serve packs
live. audio-tune first needed its Pages source moved from branch builds to
GitHub Actions. Game authors' rules are in GAME_INTEGRATION §10 "Offline packs".

Remaining:

- A "Ready for offline: n/14" indicator, and a notice when paired devices run
  different launcher releases.
- Real-iPhone airplane-mode and storage-eviction tests.
