# Paul's Arcade — Game Integration Template

The minimal contract every game must satisfy to slot cleanly into the launcher. Do not pull in any framework or wrapper — the SDK is ~250 lines of plain JS and the rest is convention.

For background and rationale see [ARCADE_PLATFORM.md](ARCADE_PLATFORM.md). This file is the implementer's checklist.

---

## 1. Identity & hosting

- [ ] Game is hosted at `https://paulgibeault.github.io/<gameId>/` (same-origin with the launcher).
- [ ] `<gameId>` is kebab-case, matches the GitHub repo slug, and matches the `data-game-id` attribute the launcher uses for this game.
- [ ] Entry point is `index.html` at the repo root so the GitHub Pages URL above resolves.

| Game           | gameId           | Repo                                           |
| -------------- | ---------------- | ---------------------------------------------- |
| Pi Game        | `pi-game`        | `paulgibeault/pi-game`                         |
| Si Syndicate   | `si-syn`         | `paulgibeault/si-syn`                          |
| HecknSic       | `hecknsic`       | `paulgibeault/hecknsic`                        |
| Cozy Solitaire | `cozy-solitaire` | `paulgibeault/cozy-solitaire`                  |
| Sew What       | `sew-what`       | `paulgibeault/sew-what`                        |

---

## 2. Load the SDK

Drop two lines into `<head>` of `index.html`, before any game script that touches storage:

```html
<script src="https://paulgibeault.github.io/arcade-sdk.js"></script>
<script>Arcade.init({ gameId: '<your-game-id>' });</script>
```

The SDK is a singleton (`window.Arcade`) and is safe to load standalone — when not framed it locks `peer.status()` to `'unavailable'` and storage falls back to plain same-origin `localStorage`.

---

## 3. Storage — migrate to namespaced keys

The launcher's save/load file only round-trips keys that match `arcade.v1.<gameId>.<key>` (and `arcade.v1.global.<key>`). Anything else is silently dropped on import, so old keys won't survive a cross-device save.

- [ ] Replace `localStorage.getItem('foo')` with `Arcade.state.get('foo')`.
- [ ] Replace `localStorage.setItem('foo', JSON.stringify(v))` with `Arcade.state.set('foo', v)` (the SDK handles JSON).
- [ ] One-shot migration: on first run after this change, copy any legacy keys (`'foo'`, `'<gameId>:foo'`, etc.) into the namespaced keys, then delete the legacy key. Migration must be idempotent.
- [ ] Use `Arcade.global.*` only for things genuinely shared across games (e.g. a theme preference). Default to `Arcade.state.*`.
- [ ] If the launcher imports a save while the game is open, re-read state:

  ```js
  Arcade.onStateReplaced(() => { /* re-hydrate UI from Arcade.state.get(...) */ });
  ```

---

## 4. Settings — respect launcher font scale

The SDK injects `:root { font-size: calc(100% * var(--font-scale, 1)); }` and updates `--font-scale` whenever the launcher's font-size setting changes. To benefit:

- [ ] Size text in `rem` or `em`, not `px`. Anything sized in rem will scale automatically.
- [ ] If the game sets its own `:root { font-size: ... }`, opt back in by multiplying with the var: `font-size: calc(16px * var(--font-scale, 1));`.
- [ ] (Optional) Subscribe explicitly only if the game needs to react beyond CSS:

  ```js
  Arcade.onSettingsChange(({ fontScale }) => { /* relayout canvas, etc. */ });
  ```

---

## 5. Standalone mode must keep working

The launcher is one of two ways to run the game; the GitHub Pages URL is the other. After integration:

- [ ] Open `https://paulgibeault.github.io/<gameId>/` directly in a browser tab and confirm the game still works end-to-end with no console errors.
- [ ] `Arcade.context.framed === false` in standalone — do not gate core gameplay on `framed`.
- [ ] Do not assume `peer.status() === 'connected'`; treat multiplayer features as optional.

---

## 6. Iframe sandbox compatibility

The launcher mounts each game in `<iframe sandbox="allow-scripts allow-same-origin" allowfullscreen>`. The game must run inside that sandbox:

- [ ] No top-level navigation (`window.top.location = ...`) — it will be blocked.
- [ ] No `window.open` to internal links; use in-game UI for help/about screens.
- [ ] If the game requests fullscreen, request it on a user gesture only and target the game's own root element.

---

## 7. PWA / service worker hygiene

Several games already ship a `manifest.json` and `sw.js`. Because every game and the launcher live on the same origin, sloppy scopes will collide.

- [ ] `manifest.json` `"scope"` and `"start_url"` are scoped to `/<gameId>/`, not `/`.
- [ ] If the game registers a service worker, register it with `{ scope: '/<gameId>/' }` and place `sw.js` inside that path.
- [ ] The service worker only caches assets under `/<gameId>/`. Never cache `/arcade-sdk.js` or anything at the launcher root.

---

## 8. Launcher card assets

The launcher has both a portfolio card and a launcher button for every game; both pull from `paulgibeault.github.io/images/<gameId>.png`.

- [ ] Provide a square cover image, ≥ 512×512, saved as `images/<gameId>.png` in the launcher repo (PR against `paulgibeault/paulgibeault.github.io`).
- [ ] Update both the `#games` portfolio section and the `#view-launcher` grid in [index.html](index.html) — there's a `SYNC:` comment in the file marking the duplicate.
- [ ] Provide a one-line subtitle (≤ 20 chars) for the launcher button (e.g. "Hex Puzzle", "Memorization").

---

## 9. Acceptance checklist

A game is considered integrated when all of the following pass:

- [ ] Loads inside the launcher iframe with no console errors.
- [ ] `Arcade.context.framed === true` when launched from the launcher; `false` when opened directly.
- [ ] At least one piece of game state writes to a key matching `arcade.v1.<gameId>.*` (verify in DevTools → Application → Local Storage).
- [ ] Launcher Save → exported JSON contains the game's keys; Launcher Load of that file restores them and the game reflects the restored state (after `onStateReplaced` or page reload).
- [ ] Changing the launcher's font scale visibly resizes text in the game without a reload.
- [ ] Standalone URL (`https://paulgibeault.github.io/<gameId>/`) still works exactly as before.
- [ ] Service worker (if any) does not intercept requests for `/arcade-sdk.js` or other launcher assets.

---

## 10. Reference

- Platform design: [ARCADE_PLATFORM.md](ARCADE_PLATFORM.md)
- SDK source: [arcade-sdk.js](arcade-sdk.js)
- Launcher iframe pool & message routing: [index.html](index.html) (search for `PLATFORM CONTROLLER`)
