# Plan — Cozy Solitaire (`paulgibeault/cozy-solitaire`, gameId `cozy-solitaire`) — ✅ core complete

**All bugs + most cleanup shipped** in PR [#8 `arcade-review-fixes`](https://github.com/paulgibeault/cozy-solitaire/pull/8)
(merged 2026-07-10). Verified in code 2026-07-10.

| # | Item | Where it landed |
| - | ---- | --------------- |
| 1 | 1 Hz idle-clock tick gated on suspend/resume | `js/main.js:76-83,159,164,188` (`350b3f9`) |
| 2 | `pagehide` flush of state + `sessionElapsed` (standalone-safe) | `js/main.js:175-178` (`350b3f9`) |
| 3 | Dead `startTime` field, `MIGRATION_session_persistKey.md`, stray `</div>` removed | (`bda2bb5`) |
| 4 | README single-palette note; reduced-motion instant auto-complete | `README.md:21`, `js/main.js:389-414` |

## Remaining work (two low-priority cleanups)
- **Adopt `Arcade.ui.toast`** for "Best time!" / "Seed applied" / "No more passes"
  (currently a `✕` glyph, `js/main.js:464`). Tracked as
  [cozy-solitaire #9](https://github.com/paulgibeault/cozy-solitaire/issues/9).
- **Replace the manual `?v=N` cache-bust** (`index.html:152`, currently bumped to `v=5`)
  with a build/deploy hash convention. Minor; no issue filed — fold into #9 or skip.

**Recommendation:** low priority. Close the paired integration issue
[cozy-solitaire #7](https://github.com/paulgibeault/cozy-solitaire/issues/7) (PR merged).
