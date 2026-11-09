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

`tools/stage.mjs` emits one self-contained pack per game; the launcher mounts
it as a sandboxed `srcdoc` frame, opaque origin preserved. Audit first what
each game loads (images, CSS `url()`, audio, `fetch()`, wasm, workers). Prove on
Hive Mind and Si Syndicate, on real phones.

## Step 3: fleet rollout

Background-download every pack on first run, show "Ready for offline: n/14",
fall back to the network for a game with no pack, and explain build mismatches
in multiplayer. Add real-iPhone airplane-mode and storage-eviction tests.
