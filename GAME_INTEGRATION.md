# Paul's Arcade — Game Integration Template

The minimal contract every game must satisfy to slot cleanly into the launcher.
The SDK is a single ~600-line file at `https://paulgibeault.github.io/arcade-sdk.js`;
the rest is convention. Protocol version: **v2**.

For background see [ARCADE_PLATFORM.md](ARCADE_PLATFORM.md). This file is the
implementer's checklist.

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
<script src="/arcade-sdk.js"></script>
<script>Arcade.init({ gameId: '<your-game-id>' });</script>
```

Use a **root-relative** URL (`/arcade-sdk.js`), not the absolute
`https://paulgibeault.github.io/...` form. Both work in production, but
root-relative also resolves correctly when a local-dev harness stages the
launcher and game side-by-side under `127.0.0.1`, so no rewrite is needed.
The only place root-relative breaks is opening `index.html` directly from
disk via `file://` — which doesn't work for any modern game (modules, fonts,
storage, fetch) anyway, so serve over `http://localhost` for dev.

The SDK is a singleton (`window.Arcade`) and is safe to load standalone — when
not framed it locks `peer.status()` to `'unavailable'` and storage falls back
to plain same-origin `localStorage`.

For games that need to read state during module init, await `Arcade.ready`
once before reading:

```js
Arcade.init({ gameId: 'hecknsic' });
await Arcade.ready;     // resolves on welcome handshake (or immediately when standalone)
const saved = Arcade.state.get('savedGame');
```

Standalone games can skip the `await` — settings hydrate synchronously from
`localStorage` before init returns, so first paint is correct.

---

## 3. Storage — migrate to namespaced keys

The launcher's save/load file only round-trips keys that match
`arcade.v1.<gameId>.<key>` (and `arcade.v1.global.<key>`). Anything else is
silently dropped on import, so old keys won't survive a cross-device save.

- [ ] Replace `localStorage.getItem('foo')` with `Arcade.state.get('foo')`.
- [ ] Replace `localStorage.setItem('foo', JSON.stringify(v))` with `Arcade.state.set('foo', v)` (the SDK handles JSON).
- [ ] Use `Arcade.state.getOrInit('settings', DEFAULTS)` instead of hand-rolling deep-merge-with-defaults.
- [ ] Use `Arcade.global.*` only for things genuinely shared across games (e.g. a theme preference). Default to `Arcade.state.*`.
- [ ] If the launcher imports a save while the game is open, re-read state:

  ```js
  Arcade.onStateReplaced(() => { /* re-hydrate UI from Arcade.state.get(...) */ });
  ```

### One-shot migration of legacy keys

`Arcade.state.migrate(version, fn)` runs `fn` exactly once per `(gameId, version)`
— the SDK records a sentinel at `arcade.v1.<gameId>._migrated.<version>` so
subsequent loads skip. Use it to copy legacy keys into the namespaced layout
and delete the originals:

```js
Arcade.state.migrate('v1', () => {
    // 1. Settings (raw object → namespaced)
    const old = localStorage.getItem('hecknsic_settings');
    if (old) {
        try { Arcade.state.set('settings', JSON.parse(old)); } catch (e) {}
        localStorage.removeItem('hecknsic_settings');
    }

    // 2. Sticky player name → global
    const name = localStorage.getItem('hecknsic_player_name');
    if (name) Arcade.player.setName(name);
    localStorage.removeItem('hecknsic_player_name');

    // 3. Per-mode high scores → leaderboard API
    for (const mode of ['arcade', 'chill', 'puzzle']) {
        const raw = localStorage.getItem(`hecknsic_highscores_${mode}`);
        if (!raw) continue;
        try {
            const list = JSON.parse(raw);
            if (Array.isArray(list)) {
                for (const e of list) Arcade.scores.add(mode, e);
            }
        } catch (e) {}
        localStorage.removeItem(`hecknsic_highscores_${mode}`);
    }
});
```

---

## 4. Player profile, scores, and stats

- [ ] Use `Arcade.player.name()` / `Arcade.player.setName(s)` for the sticky display name. It lives at `arcade.v1.global.playerName` so every game shares it.
- [ ] If your game has a leaderboard, use `Arcade.scores.add(category, { score, name?, meta? })` and `Arcade.scores.list(category, { limit })`. The SDK keeps the top 100 sorted descending and stamps `name` (from `Arcade.player.name()`) and `ts` automatically.
- [ ] If your game tracks counters (games played / won / streak / best time), use `Arcade.stats.update(category, prev => next)` for atomic-style updates and `Arcade.stats.get(category)` to read.

---

## 5. Settings — respect launcher preferences

The launcher pushes a settings snapshot in the welcome message and again on
every change. The SDK applies the visual ones to the game's `<html>` for free:

| Setting          | Where to read                       | DOM hook applied by SDK                            |
| ---------------- | ----------------------------------- | -------------------------------------------------- |
| `fontScale`      | `Arcade.settings.fontScale()`       | `style="--font-scale: <n>"`                        |
| `theme`          | `Arcade.settings.theme()`           | `data-theme="light"` or `data-theme="dark"`        |
| `reducedMotion`  | `Arcade.settings.reducedMotion()`   | `style="--motion-scale: 0"` (1 otherwise)          |
| `audioVolume`    | `Arcade.settings.audioVolume()`     | `style="--audio-volume: <0..1>"` (read in JS)      |
| `handedness`     | `Arcade.settings.handedness()`      | `data-handedness="left"` or `data-handedness="right"` |

To benefit:

- [ ] Size text in `rem` or `em`, not `px` — the SDK injects `:root { font-size: calc(100% * var(--font-scale, 1)); }` so rem-based text scales for free.
- [ ] If your game has a dark/light theme already, key its CSS off `[data-theme="dark"]` / `[data-theme="light"]` rather than rolling your own toggle.
- [ ] If your game has tween-heavy effects, multiply durations by `getComputedStyle(document.documentElement).getPropertyValue('--motion-scale')` (or skip animations when `Arcade.settings.reducedMotion()` is `true`).
- [ ] If your game has handedness-sensitive UI (e.g. control palette position), key it off `[data-handedness="left"]`.

Subscribe explicitly only when you need to react beyond CSS:

```js
Arcade.onSettingsChange((snap) => { /* relayout canvas, etc. */ });
```

---

## 6. Lifecycle — pause when hidden

The launcher's iframe pool keeps every game mounted; switching away just hides
the iframe (`display:none`). Hidden games still run timers and `requestAnimationFrame`
unless paused, which wastes battery. The SDK delivers explicit hints:

- [ ] Subscribe to `Arcade.onSuspend(fn)` to pause your game loop / mute audio.
- [ ] Subscribe to `Arcade.onResume(fn)` to unpause and reset any `lastTime` accumulators.
- [ ] You no longer need a separate `visibilitychange` handler — the SDK fires `onSuspend` whenever the launcher hides the iframe (which encompasses both quitting to launcher and tab/window hide).

```js
let paused = false;
Arcade.onSuspend(() => { paused = true; audio.suspend(); });
Arcade.onResume(() => { paused = false; lastFrame = performance.now(); audio.resume(); });
```

---

## 7. UI — toasts via the launcher

If you'd otherwise pop a transient banner, prefer the launcher-rendered toast
when framed (so it survives game UI redraws and uses the launcher's a11y
announcer). Standalone, the SDK draws an in-place fallback.

```js
Arcade.ui.toast('Saved!',         { kind: 'success' });
Arcade.ui.toast('Network down',   { kind: 'error', duration: 4000 });
```

`kind` is `'info' | 'success' | 'warning' | 'error'`; `duration` defaults to 2500ms.

---

## 8. Standalone mode must keep working

The launcher is one of two ways to run the game; the GitHub Pages URL is the other.

- [ ] Open `https://paulgibeault.github.io/<gameId>/` directly in a browser tab and confirm the game still works end-to-end with no console errors.
- [ ] `Arcade.context.framed === false` in standalone — do not gate core gameplay on `framed`.
- [ ] Do not assume `peer.status() === 'connected'`; treat multiplayer features as optional.

---

## 9. Iframe sandbox compatibility

The launcher mounts each game in `<iframe sandbox="allow-scripts allow-same-origin" allowfullscreen>`.

- [ ] No top-level navigation (`window.top.location = ...`) — it will be blocked.
- [ ] No `window.open` to internal links; use in-game UI for help/about screens.
- [ ] If the game requests fullscreen, request it on a user gesture only and target the game's own root element.

`allow-same-origin` means **same-origin `localStorage` works directly inside the iframe** — you do **not** need a postMessage shim. If your game has one (legacy from earlier protocol versions), delete it as part of the SDK adoption.

---

## 10. PWA / service worker hygiene

Several games already ship a `manifest.json` and `sw.js`. Because every game
and the launcher live on the same origin, sloppy scopes will collide.

- [ ] `manifest.json` `"scope"` and `"start_url"` are scoped to `/<gameId>/`, not `/`.
- [ ] If the game registers a service worker, register it with `{ scope: '/<gameId>/' }` and place `sw.js` inside that path.
- [ ] The service worker only caches assets under `/<gameId>/`. **Never** cache `/arcade-sdk.js` or anything at the launcher root — the SDK will `console.warn` if it detects this at load.

> The launcher's own service worker lives at `/sw.js` (root scope) and intentionally caches only launcher-owned files (`index.html`, `arcade-sdk.js`, `styles.css`, launcher images). It does not intercept game URLs. The launcher SW is also skipped on loopback hosts (`localhost`, `127.x`, `::1`) so local-dev edits to launcher or SDK are never masked by stale cache.

---

## 11. Launcher card assets

The launcher has both a portfolio card and a launcher button for every game;
both pull from `paulgibeault.github.io/images/<gameId>.png`.

- [ ] Provide a square cover image, ≥ 512×512, saved as `images/<gameId>.png` in the launcher repo (PR against `paulgibeault/paulgibeault.github.io`).
- [ ] Update both the `#games` portfolio section and the `#view-launcher` grid in [index.html](index.html) — there's a `SYNC:` comment in the file marking the duplicate.
- [ ] Provide a one-line subtitle (≤ 20 chars) for the launcher button (e.g. "Hex Puzzle", "Memorization").

---

## 12. Acceptance checklist

A game is considered integrated when all of the following pass:

- [ ] Loads inside the launcher iframe with no console errors.
- [ ] `Arcade.context.framed === true` when launched from the launcher; `false` when opened directly.
- [ ] At least one piece of game state writes to a key matching `arcade.v1.<gameId>.*` (verify in DevTools → Application → Local Storage).
- [ ] No legacy non-namespaced keys remain after first load (your `Arcade.state.migrate('v1', ...)` ran successfully — check the `arcade.v1.<gameId>._migrated.v1` sentinel).
- [ ] Launcher Save → exported JSON contains the game's keys; Launcher Load of that file restores them and the game reflects the restored state (after `onStateReplaced` or page reload).
- [ ] Changing the launcher's font scale visibly resizes text in the game without a reload.
- [ ] Switching to launcher view and back fires `onSuspend` then `onResume`; the game pauses while hidden and resumes cleanly.
- [ ] Standalone URL (`https://paulgibeault.github.io/<gameId>/`) still works exactly as before.
- [ ] Service worker (if any) does not intercept requests for `/arcade-sdk.js` or other launcher assets (no `[Arcade SDK]` warning in console).

---

## 13. Reference

- Platform design: [ARCADE_PLATFORM.md](ARCADE_PLATFORM.md)
- SDK source: [arcade-sdk.js](arcade-sdk.js)
- Launcher iframe pool & message routing: [index.html](index.html) (search for `PLATFORM CONTROLLER`)

### Wire protocol summary (v2)

All messages namespaced `arcade:`. Origin guard: SDK only listens to messages
from `window.parent` whose `origin === window.location.origin`. Launcher only
acts on messages from iframes it mounted via the pool.

```
child  → parent: arcade:hello              { gameId, version }
parent → child:  arcade:welcome            { version, peerStatus, settings }
parent → child:  arcade:settings.changed   { settings }
parent → child:  arcade:state.replaced     { }                      // after file import
parent → child:  arcade:lifecycle.suspend  { }                      // iframe hidden
parent → child:  arcade:lifecycle.resume   { }                      // iframe shown
parent → child:  arcade:peer.status        { status }
parent → child:  arcade:peer.message       { payload, fromPeer }
child  → parent: arcade:peer.send          { payload }
child  → parent: arcade:ui.toast           { message, kind, duration }
```

Settings shape:
```js
{ fontScale: number, theme: 'light'|'dark', reducedMotion: boolean,
  audioVolume: 0..1, handedness: 'left'|'right' }
```
