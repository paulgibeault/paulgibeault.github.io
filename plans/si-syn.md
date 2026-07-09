# Plan — Si Syndicate (`paulgibeault/si-syn`, gameId `si-syn`)

Source: platform integration review. A clean integration (proper namespacing, v1
migration, suspend/resume, fontScale + reducedMotion). Main gap: JS timer chains
keep firing while the game is hidden. Line numbers from the reviewed tree —
re-confirm.

## Bugs

### 1. `setTimeout`/interval chains run while hidden — MED (§6c)
- **Where:** `onSuspend` stops the sim rAF (`src/main.js:919-929`), but timer chains
  ignore suspension: boot cinematic (`src/ui/boot.js:141-164,209-227`), guide steps
  (`src/ui/guide.js:144`), 100 ms tray-placement poll (`src/main.js:348-357`),
  auto-advance timeouts (`src/main.js:883,888`).
- **Problem:** a user who launches for the first time and immediately switches to the
  launcher misses the cinematic; battery/CPU burn on hidden iframe.
- **Fix:** on `Arcade.onSuspend`, clear the boot/guide timeout ids and the tray
  poll; on resume, reschedule the remainder (or `skip()` to finished state on
  suspend). Simplest: adopt framework B4's suspend-aware `Arcade.session.setTimeout`
  once available. Replace the tray poll with an `onPlacingEnd` callback from
  `circuit-board.js`.

### 2. `onStateReplaced` can restore into a now-locked level — LOW
- **Where:** `src/main.js:930-934` reloads `currentLevel.id` even if the imported
  save has that level locked.
- **Fix:** after import, if `!isLevelUnlocked(currentLevel.id)`, fall back to the
  computed start level (`src/main.js:949-952`). Treat `onStateReplaced` like a fresh
  boot (framework B9 doc note).

## Cleanup

### 3. Gate cinematics on reducedMotion — LOW
- Boot/guide typewriter animations aren't gated (only tap-to-skip). Under
  `Arcade.settings.reducedMotion()`, call the existing `renderAllLines()` path
  (`src/ui/boot.js:82-90`) to finish instantly.

### 4. Remove stale integration-era artifacts — LOW
- `ago` (own dev harness), `ARCADE_LAUNCHER_NOTES.md` (all asks shipped in the
  launcher: dev.sh, `?dev=1`, acceptance, SW loopback skip), and the
  gitignored `.arcade-stage/` copy of `arcade-sdk.js` are now misleading. Delete;
  use the launcher's `dev.sh` + `npm run acceptance`.

### 5. Switch SDK `<script src>` to root-relative — LOW
- `index.html:19` uses the absolute URL; §2 prescribes `/arcade-sdk.js`.

### 6. Document theme opt-out — LOW
- Fixed dark-terminal aesthetic; add the one-line §5 note to `README.md`.

## Enhancements (optional, high value for this game type)
- This is a Zachtronics-style optimizer — adopt `Arcade.stats.update(levelId, …)`
  (cycles-to-pass, instruction count, attempts) and `Arcade.scores.add(levelId,
  {score: -cycles, meta:{instructions}})` for a "best solution" UI. (Needs framework
  B5 ascending order, or keep negating scores.)
- Use `Arcade.ui.toast` for "Program cleared" / "Progress restored".

## Priority
1 → 2 → 3 → 4 → 5 → 6 → enhancements.
