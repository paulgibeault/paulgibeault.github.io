# Plan — HecknSic (`paulgibeault/hecknsic`, gameId `hecknsic`) — ✅ core complete

**All bugs + most cleanup shipped** in PR [#39 `arcade-review-fixes`](https://github.com/paulgibeault/hecknsic/pull/39)
(merged 2026-07-10). Verified in code 2026-07-10.

| # | Item | Where it landed |
| - | ---- | --------------- |
| 1 | SW scope-filtered to `self.registration.scope`; `CACHE_VERSION` bumped to `hecknsic-v1.3.1` | `sw.js:2-3,61-64` (`f526892`) |
| 2 | `migrate('v2')` recovers orphaned `arcade.v1.hecknsic.ls.*` keys, deletes originals | `index.html:28-80,83` (`4fef5d5`) |
| 3 | rAF cancelled on suspend, re-requested on resume | `js/main.js:102,131,136` (`a07947f`) |
| 4 | Canvas text + handedness pill scaled by `fontScale` | `js/renderer.js`, `css/style.css:110` |
| — | Tweens gated on `reducedMotion`; root-relative SDK src; dead `DEFAULT_SETTINGS` fields removed; README theme opt-out | (`d84b49d`, `b5232d4`, `28412b7`) |

> **Item 2 unblocks framework B11** (retire the launcher's ls-proxy path). Wait one release
> after this deploy, then delete `handleLsProxyRequest` — tracked in fleet-hardening Part B.

## Remaining work (one cleanup bullet — issue filed)
- Replace the hand-rolled `showEditorStatus()` fade (`js/puzzle-editor.js:216-223`) with
  `Arcade.ui.toast`, and adopt `Arcade.stats` (games played/won, best combo). Tracked as
  [hecknsic #40](https://github.com/paulgibeault/hecknsic/issues/40).

**Recommendation:** low priority; do it opportunistically under #40. Close the paired
integration issue [hecknsic #38](https://github.com/paulgibeault/hecknsic/issues/38) (PR merged).
