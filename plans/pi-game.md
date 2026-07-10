# Plan — Pi Game (`paulgibeault/pi-game`, gameId `pi-game`) — ✅ core complete

**All bugs + cleanup shipped** in PR [#15 `arcade-review-fixes`](https://github.com/paulgibeault/pi-game/pull/15)
(merged 2026-07-10). Verified in code 2026-07-10.

| # | Item | Where it landed |
| - | ---- | --------------- |
| 1 | Resume restarts rAF loop (`ensureAnimationLoop()` in `onResume`) | `index.html:1512` |
| 2 | `Arcade.session.start({persistKey:'elapsedMs'})` replaces `Date.now()` epoch | `index.html:983,1239,1267,1287` |
| 3 | Reduced-motion: CSS keyframes scaled + every canvas visual damped | `index.html:376-441`, `visuals/*.js` |
| 4 | SW caches versioned `visuals/*.js` + cache-puts fetches; `pi-game-v3` | `sw.js:4-13,52-55` |
| 5 | State blob slimmed (no `piSequence`) | `index.html:972-975` |
| 6 | Static `manifest.json` restored (blob hack removed) | `index.html:15,957-959` |
| 7 | `go.sh` re-copies fresh SDK each run | `go.sh:11-18` |

## Remaining work (optional enhancements only — no issue filed)
- Show `e.name` on the leaderboard (entries already carry it) + a small
  `Arcade.player.setName` prompt.
- Adopt `Arcade.stats` (`gamesPlayed`, `totalDigits`, `bestScore`) and
  `Arcade.ui.toast('New personal best!')`.
- Map launcher `theme()` to a default aesthetic, or add a one-line README opt-out note.

**Recommendation:** low priority. Close the paired integration issue
[pi-game #14](https://github.com/paulgibeault/pi-game/issues/14) (PR merged); file a
separate "polish" issue for the enhancements above only if you intend to do them.
