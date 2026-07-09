# Plan — Cozy Solitaire (`paulgibeault/cozy-solitaire`, gameId `cozy-solitaire`)

Source: platform integration review. The closest thing the platform has to a
reference integration — SDK-owned storage, three clean chained migrations,
session-timer persistKey, dirty-rect rAF hygiene, reduced-motion + handedness.
Both real findings expose framework gaps more than game bugs. Line numbers from
the reviewed tree — re-confirm.

## Bugs

### 1. Idle clock freezes between interactions — MED
- **Where:** the rAF loop is dirty-driven and only self-reschedules during
  auto-complete/tweens/win/drag (`js/main.js:404-406`); `UI.updateHeader` runs only
  inside `render()` (`:414`).
- **Problem:** while the player sits thinking, the header time display freezes then
  jumps on the next interaction (elapsed itself stays correct via `Arcade.session`).
- **Fix:** a 1 Hz tick started/cleared in `onResume`/`onSuspend`, gated on
  `updateTimerState`'s `shouldRun`, that calls `markDirty()` or updates the DOM clock.
  (Framework B4's `t.onTick` would replace this once available.)

### 2. Standalone never flushes elapsed on tab close — MED (framework-exposed)
- **Where:** save-on-hide hangs off `Arcade.onSuspend` (`js/main.js:139-142`) +
  the session timer's persistKey write, but suspend is only delivered when framed
  (`arcade-sdk.js:747-751,799-803`). Game state is safe (saved every move), but
  standalone loses accrued time since the last interaction boundary.
- **Fix (interim):** add
  `window.addEventListener('pagehide', () => { if (state)
  saveGameState(serializeState(state)); Arcade.state.set('sessionElapsed',
  _timer.elapsedMs()); })`.
- **Real fix:** framework B2 (SDK fires suspend/resume standalone). Remove the
  interim listener once B2 lands.

## Cleanup

### 3. Delete dead weight — LOW
- `startTime` field still created/serialized/deserialized/reset
  (`js/game.js:39,222,279`; `js/main.js:222`) though the v3 migration moved time to
  `Arcade.session` — nothing reads it. Remove.
- Delete `MIGRATION_session_persistKey.md` (work landed in `c9525b3`).
- Fix the stray extra `</div>` at `index.html:119`.
- Replace `js/main.js?v=4` manual cache-bust with a build/deploy hash convention.

### 4. Document theme opt-out; small UX — LOW
- Add the one-line §5 README note (single mandatory cabin-warm palette).
- Adopt `Arcade.ui.toast` for "Best time!", "Seed applied", "No more passes"
  (currently just a ✕ glyph, `js/main.js:432`).
- Under `Arcade.settings.reducedMotion()`, complete the card-by-card auto-complete
  (`js/main.js:361-384`) instantly.

## Framework-feedback (surfaced here; see framework plan)
- B2 standalone suspend/resume (fixes §2 for every game at once).
- B4 `t.onTick` suspend-aware tick (fixes §1).
- B5 ascending `Arcade.scores` order (a solitaire best-times board wants lower-is-
  better) + keyed bests.
- B9 `Arcade.state.adopt(legacyKey, newKey)` (cozy re-implements `takeRaw`/`takeJSON`
  in its v1 migration, `index.html:22-33`).

## Priority
1 → 2 → 3 → 4.
