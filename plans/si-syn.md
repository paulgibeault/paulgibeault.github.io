# Plan — Si Syndicate (`paulgibeault/si-syn`, gameId `si-syn`) — ✅ core complete

**All bugs + cleanup shipped** in PR [#18 `arcade-review-fixes`](https://github.com/paulgibeault/si-syn/pull/18)
(merged 2026-07-10). Verified in code 2026-07-10.

| # | Item | Where it landed |
| - | ---- | --------------- |
| 1 | Hidden-timer chains paused on suspend, rescheduled on resume (boot cinematic, guide, tray poll, auto-advance) via a hand-rolled suspend-aware `scheduleTimeout`/`pauseTimeouts` wrapper | `src/main.js:92-112,950-966`, `src/ui/boot.js:47-49`, `src/ui/guide.js:167-174` |
| 2 | `onStateReplaced` falls back to computed start level if restored level is locked | `src/main.js:967-978` |
| 3 | Cinematics finish instantly under `reducedMotion()` | `src/ui/boot.js:55,152-154` |
| 4 | Stale artifacts removed (`ago`, `ARCADE_LAUNCHER_NOTES.md`, `.arcade-stage/`) | (`a303e48`) |
| 5 | Root-relative SDK `<script src="/arcade-sdk.js">` | `index.html:19` |
| 6 | Theme opt-out documented | `README.md:86-90` |

> Note on #1: the game hand-rolled its own suspend-aware timer wrapper rather than adopting
> `Arcade.session.setTimeout` (which now exists in the SDK — B4). Behaviorally correct; a
> future opportunistic migration to the managed helper is tracked under fleet-hardening C3.

## Remaining work (optional enhancements only — no issue filed)
- This is a Zachtronics-style optimizer — adopt `Arcade.stats.update(levelId, …)` (cycles,
  instruction count, attempts) + `Arcade.scores.add(levelId, {score:-cycles})` for a
  "best solution" board (SDK now supports ascending order — B5).
- `Arcade.ui.toast` for "Program cleared" / "Progress restored".

**Recommendation:** low priority. Close the paired integration issue
[si-syn #17](https://github.com/paulgibeault/si-syn/issues/17) (PR merged).
