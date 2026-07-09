# Plan — Moon Lit (`paulgibeault/moon-lit`, gameId `moon-lit`)

Source: platform integration review. Moon Lit is a strong integration (SDK-first
storage, real suspend/resume, sleep-when-quiescent rAF, persisted session timer,
scores/stats/toasts via the SDK), with one production-severity issue and two
lifecycle/accounting bugs. Line numbers from the reviewed tree — re-confirm.

## Critical

### 1. Origin-wide SW/cache wipe destroys the launcher's service worker — HIGH
- **Where:** `index.html:16-28` — unregisters *every* SW registration and deletes
  *every* Cache Storage entry for the whole origin, on every load, in production.
- **Problem:** `getRegistrations()`/`caches` in an `allow-same-origin` iframe are
  origin-scoped, so launching Moon Lit silently unregisters the launcher's `/sw.js`
  and deletes `paul-arcade-v19`, killing launcher offline support and sibling
  caches. Violates GAME_INTEGRATION.md §10.
- **Fix:** gate to loopback:
  `if (['localhost','127.0.0.1','::1'].includes(location.hostname) ||
  location.hostname.startsWith('127.'))` — or delete the block entirely (the
  launcher SW already skips loopback and never intercepts game URLs).
- **Accept:** launching Moon Lit in prod leaves the launcher SW + caches intact.

## Bugs

### 2. Suspend containment — browser events resurrect a launcher-suspended game — MED
- **Where:** `onSuspend` sets `suspended=true` (`js/main.js:703-707`), but
  `visibilitychange:visible` (`:721-729`), `pageshow` (`:731-734`), and `focus`
  (`:736-739`) unconditionally clear it and call `forceRequestFrame()`.
- **Problem:** launcher hides Moon Lit → user tab-switches and back → the hidden
  iframe's rAF loop runs again.
- **Fix:** two flags — `launcherSuspended` (only `onSuspend`/`onResume` touch it)
  and `docHidden`; run the loop only when both are false. Browser handlers may
  flush and wake only when `!launcherSuspended`.

### 3. Save-import stats-delta accounting — MED
- **Where:** `onStateReplaced` handler (`js/main.js:743-753`) does not reset
  `lastReportedMs` (`:167`); the SDK timer re-baselines from imported
  `sessionElapsed`.
- **Problem:** next `recordOutcome` computes `playDelta = elapsedMs() -
  lastReportedMs` against a stale baseline → undercount or large spurious
  `totalPlayMs` inflation.
- **Fix:** `lastReportedMs = sessionTimer.elapsedMs()` inside the
  `onStateReplaced` handler.

## Cleanup

### 4. Finish the migration; stop dual-writing snapshots — LOW
- Inline migrations (`js/main.js:102-126`) never delete superseded keys, and
  `saveGameState` dual-writes to both `gameState_<mode>` and legacy `gameState`
  forever (`:76-77`), doubling snapshot bytes in storage and every export.
- **Fix:** move shape migrations into `Arcade.state.migrate('v2', ...)` (currently
  an empty stub at `:99`), delete legacy keys, drop the legacy dual-write.

### 5. Namespace admin-panel state; drop parallel best-score bookkeeping — LOW
- `admin-group-collapsed-*` raw keys (`js/admin-panel.js:451-527`) collide across
  games on the shared origin → `Arcade.state.set('adminCollapsed', {...})`.
- Three sources of truth for best score (`bestScore` key, `stats.campaign.bestScore`,
  `Arcade.scores.best('campaign')`) → drop `BEST_KEY`, keep a one-shot migrate.
- Cap telemetry export weight (`telemetryLog` ships 500 records into every save;
  100–200 is enough).

### 6. Live player-name refresh — LOW
- Subscribe `Arcade.player.onChange` so the win-card name updates when the launcher
  profile changes (currently only boot + stateReplaced).

## Depends on framework
- §1's clean fix is aided by framework B1 (SW hygiene / "don't touch caches outside
  your scope"); §2/§3 motivate framework B2 (unified suspend) and a `takeDelta()`
  session helper — but all game-side fixes above stand alone.

## Priority
1 (critical) → 2 → 3 → 4 → 5 → 6.
