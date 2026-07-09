# Plan — Pi Game (`paulgibeault/pi-game`, gameId `pi-game`)

Source: platform integration review. Solid storage/migration/scores, but two
lifecycle bugs and a broken offline claim. Line numbers from the reviewed tree —
re-confirm.

## Bugs

### 1. Resume never restarts the rAF loop — HIGH (user-visible freeze)
- **Where:** `onSuspend` cancels the loop (`index.html:1513`) but `onResume`
  (`:1515-1518`) never calls `ensureAnimationLoop()` (`:1110-1112`).
- **Problem:** active scenes (e.g. `OrbitalVisual.update()` returns true whenever
  bodies exist, `visuals/orbital.js:120-121`) sit frozen after suspend/resume until
  the user types a digit.
- **Fix:** call `ensureAnimationLoop()` inside `Arcade.onResume`. One line.

### 2. Hand-rolled timer accrues while hidden/evicted — HIGH
- **Where:** `state.startTime = Date.now()` epoch + display `setInterval`
  (`index.html:1243-1249,1273`); `onSuspend` stops only the display interval.
- **Problem:** hidden time inflates run time; after eviction/reload or import the
  inflated elapsed carries over.
- **Fix:** adopt `Arcade.session.start({ persistKey: 'elapsedMs' })` — reset in
  `startGame()`, read `t.elapsedMs()` for display and score meta. (Directly
  motivates framework B4.)

### 3. Reduced motion only partially honored — MED
- Particles/shake are gated (`index.html:1115,1121,1282,1296`), but continuous
  canvas visuals (`visuals/*.js update()`) and CSS ambient animations
  (`neural-scanline` `:424-436`, `orbital-twinkle` `:438`, etc.) ignore it.
- **Fix:** early-return/damp `update()` under `Arcade.settings.reducedMotion()`;
  scale CSS keyframes by `calc(Ns * var(--motion-scale,1))`.

### 4. Service worker can't deliver "works offline" — MED
- **Where:** `sw.js:5-10` caches only `./`, `index.html`, `manifest.json`, `icon.svg`
  — not `visuals/*.js`; the non-navigate fetch handler never cache-puts
  (`sw.js:43-45`).
- **Fix:** add `visuals/*.js` (versioned) to `ASSETS` or cache-put successful
  fetches; bump `CACHE_NAME`. (Aligns with framework B1 SW template.)

## Cleanup

### 5. Stop persisting the 1000-digit `piSequence` in the state blob — LOW
- `DEFAULT_STATE` (`index.html:986-987`) rides every keypress save + every export,
  then is overwritten on load (`:1131`). Slim state to
  `{gameState, currentTheme, userSequence, soundEnabled, cameraFollow}` (+ elapsed).

### 6. Drop the runtime blob-URL manifest hack — LOW
- `index.html:962-977` replaces the static `manifest.json` with a `Blob` manifest;
  `start_url`/`scope` resolution against a `blob:` URL is unreliable. Keep the
  static manifest, ship real PNG icons.

### 7. Stale vendored SDK on disk — LOW
- The repo-root `arcade-sdk.js` mirrored by `go.sh:12-20` predates `Arcade.session`,
  `stats.getOrInit`, and current peer-send semantics — local dev can misrepresent
  SDK behavior. Prefer the launcher's `dev.sh` (framework B10); re-copy via `go.sh`
  before testing.

## Enhancements (optional)
- Show `e.name` on the leaderboard (entries already carry it via `Arcade.player`);
  offer a small name prompt writing `Arcade.player.setName`.
- Add `Arcade.stats` (`gamesPlayed`, `totalDigits`, `bestScore`) and
  `Arcade.ui.toast('New personal best!', {kind:'success'})`.
- Map launcher `theme()` to a default aesthetic on first run, or add the one-line
  README opt-out note (§5).

## Priority
1 → 2 → 3 → 4 → 5 → 6 → 7 → enhancements.
