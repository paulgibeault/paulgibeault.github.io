# Arcade starter app

A minimal, complete Arcade app you can copy to start a new game. It exercises
the whole SDK contract: identity + handshake, namespaced persistence, stats,
player name, launcher settings (font scale / theme), suspend/resume,
save-import re-hydration, and an offline service worker.

## Scaffold a new app

From the launcher repo root:

```sh
./dev.sh new my-app          # creates ../my-app/ from this template
./dev.sh ../my-app           # stage + serve it at http://127.0.0.1:4791/my-app/
```

`dev.sh new` substitutes the `{{APP_ID}}` / `{{APP_TITLE}}` placeholders and
adds a `catalog.json` entry so the app shows up in the launcher grid.

## The contract (see main.js)

- Load the SDK **root-relative**: `<script src="/arcade-sdk.js"></script>`.
- `Arcade.init({ gameId })` — gameId must match the catalog entry, the manifest
  `scope`, and `sw.js`'s `GAME_ID`.
- `await Arcade.ready` before reading state.
- Persist **only** through `Arcade.state` / `Arcade.stats` / `Arcade.store` —
  never raw `localStorage` (the launcher namespaces and exports only
  `arcade.v1.<gameId>.*`).
- Let the SDK apply launcher settings; read `--font-scale` and `[data-theme]`
  from CSS (see style.css) so you respect them with no JS.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Loads the SDK, calls `Arcade.init`, registers the SW. |
| `main.js` | App logic — the SDK contract in ~50 lines. |
| `style.css` | Settings-aware styling (font scale, theme). |
| `manifest.json` | PWA manifest, scoped to `/<gameId>/`. |
| `sw.js` | Offline service worker (see `tools/templates/game-sw.js`). |
| `icon.svg` | Maskable app icon. |

Full API: `GAME_INTEGRATION.md` in the launcher repo.
