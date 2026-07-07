# Plan — Sowdoku (`paulgibeault/sowduku`, gameId `sowduku`)

Source: platform integration review. Newly added to the catalog
(`add-sowduku-catalog` / PR #14). gameId, repo slug, launcher URL, and image name
all agree on `sowduku` — but integration is incomplete: the service worker caches
the SDK, nothing pauses when hidden, and launcher art isn't square. Line numbers
from the reviewed tree — re-confirm. NOTE: the local checkout dir is `sow-duku`;
the GitHub repo/slug is `sowduku`.

## Bugs

### 1. Service worker caches `/arcade-sdk.js` — HIGH
- **Where:** `sw.js:52` bypasses only *cross-origin* requests, but the SDK is loaded
  root-relative same-origin (`index.html:25`); the cache-first branch
  (`sw.js:55-63`) caches `/arcade-sdk.js` and serves it stale forever.
- **Problem:** freezes the platform SDK for every installed user; second load fires
  the SDK's `[Arcade SDK]` warning. Violates GAME_INTEGRATION.md §10/§13.
- **Fix:** `if (url.pathname === '/arcade-sdk.js' ||
  !url.pathname.startsWith('/sowduku/')) return;` (the scope-prefix form also
  future-proofs and stays correct in the dev harness). Bump `CACHE` to purge
  poisoned installs. (Aligns with framework B1.)

### 2. No suspend handling → `playMs` inflates while hidden — HIGH
- **Where:** no `onSuspend`/`onResume` anywhere; the 1 Hz `setInterval`
  (`index.html:1654`) runs forever, and `flushTick` gates on
  `document.visibilityState === 'visible'` (`:1650`) — which stays `'visible'` when
  the launcher merely hides the iframe.
- **Problem:** play-time keeps accruing in the launcher or another game, corrupting
  the history metrics the game features.
- **Fix:** on `onSuspend` — `flushTick()`, set a `suspended` flag checked in
  `flushTick`, `persist()`, `audioCtx.suspend()`, clear the interval; on `onResume`
  — `lastTick = Date.now()`, restart. Or delete the tick machinery and use
  `Arcade.session.start({ persistKey })`, reading `elapsedMs()` into `metrics.playMs`.
  (Motivates framework B2/B3.)

### 3. Launcher art is not square — MED (§11)
- `images/sowduku.png` is 1023×746; §11 requires square ≥512×512. Reconcile the
  unmerged `add-sowduku-catalog` logo commits (`1bfe692`, `527dd74`) and ship a
  square image (launcher-repo PR).

### 4. Local checkout dir vs slug breaks dev/acceptance — MED
- `dev.sh` mounts by directory basename, so `./dev.sh ../sow-duku` stages at
  `/sow-duku/` while the launcher button points at `/sowduku/` → local launch 404s
  and `acceptance.mjs` can't run against the documented URL.
- **Fix (game side):** rename the local checkout `sow-duku` → `sowduku`, then run
  `./dev.sh ../sowduku` + `npm run acceptance -- http://127.0.0.1:4791/sowduku/`.
  (Framework B10 fixes this at the harness level.)

## Cleanup

### 5. Delete the storage fallback shim; use `Arcade.state` directly — LOW
- `sget`/`sset` (`index.html:756-768`) duplicate the `arcade.v1.sowduku.` prefix as a
  string for a `file://` case §2 declares unsupported. Two sources of truth + divergent
  parse behavior. Remove; the SDK guarantees standalone operation.

### 6. Migrate hand-rolled stats to `Arcade.stats` — LOW
- `stats` blob (`index.html:1472,1616`) maps 1:1 onto `Arcade.stats.getOrInit/update`.
  (The keyed `hiScores`-by-board-code store is a fair reason to wait for framework B5.)

### 7. Honor reducedMotion + audioVolume; add sentinel; misc — LOW
- CSS animations disabled only via `@media (prefers-reduced-motion)` (`index.html:456`);
  also key off the SDK's motion hook (framework B8) or `Arcade.settings.reducedMotion()`.
- Multiply WebAudio gain peaks by `Arcade.settings.audioVolume()` (`:975-1007`).
- Add a no-op `Arcade.state.migrate('v1', () => {})` if acceptance checks the sentinel.
- Document the fixed light-palette theme opt-out in README (§5).
- Subscribe `onSuspend` to `audioCtx.suspend()`.
- Trim the Pages artifact (exclude `PLAN.md`, mockups, `scripts/`).

## Priority
1 → 2 → 3 → 4 → 5 → 6 → 7.
