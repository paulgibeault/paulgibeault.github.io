# Plan — Sowdoku (`paulgibeault/sowduku`, gameId `sowduku`) — ⚠️ security work OUTSTANDING

Local checkout dir is `sow-duku`; GitHub repo/slug is `sowduku`.
The first review PR ([#2 `arcade-review-fixes`](https://github.com/paulgibeault/sowduku/pull/2),
merged 2026-07-10) fixed **only SW caching + suspend handling**. A stored-XSS bug of the
same class as p2p-chat's critical finding was never touched and **remains exploitable.**
Verified in code 2026-07-10.

## ✅ Shipped (removed from this plan)
- **SW caches `/arcade-sdk.js`** — fixed: scope-filtered to `/sowduku/`, `CACHE="sowdoku-shell-v4"` (`sw.js:5,54`, `634a539`).
- **No suspend handling / `playMs` inflation** — fixed: `onSuspend` flushes, sets `suspended`, `audioCtx.suspend()`, `clearInterval` (`index.html:1660-1671`, `2b0d8ba`). The C2 persist-churn leak is moot now that the tick interval is cleared on suspend.
- **`sget`/`sset` fallback shim** removed (`6a714a6`).
- **`audioVolume` honored** (`index.html:958`, `a5ae44a`); **Pages artifact trimmed** (`c23590b`).

---

## Remaining work

### 1. Stored XSS — HIGH, CRITICAL CLASS (top priority) — NOT DONE
- **Where:** field name `(f.name||f.code)` and `f.code` → `innerHTML` (`index.html:2789-2792`);
  pack name `p.name` (`:2813`, `:2970`); `rec.code` (`:3078`). No `escapeHtml` helper exists;
  the only escaping is an ad-hoc quote-replace on an input **value** (`:3069`) that covers none
  of these four sinks.
- **Why it matters:** pack/field names round-trip through save export→import and the UI invites
  sharing packs ("paste into campaigns.js"). A shared malicious pack executes script in the
  same-origin iframe → full `arcade.v1.*` read/write for every game + the launcher. Identical
  class to p2p-chat's already-fixed critical bug.
- **Fix:** add an `escapeHtml` helper (copy p2p-chat's `app.js:16-20`) and escape every dynamic
  name/code at each `innerHTML` sink, **or** render via `textContent` (as hecknsic/pi-game do).
- **Accept:** a pack whose name is `"><img src=x onerror=alert(1)>` renders inertly.

### 2. Missing migration sentinel — LOW — NOT DONE
- No `Arcade.state.migrate(...)` anywhere; this is the acceptance probe the other 6 games have.
  Add a no-op `Arcade.state.migrate('v1', () => {})` in `init()`.

### 3. Reduced-motion — LOW (verify first) — NOT DONE
- Honors only OS `@media (prefers-reduced-motion)` (`index.html:456`), never reads
  `Arcade.settings.reducedMotion()`. The SDK's injected `data-reduced-motion` kill-switch (B8)
  **likely already neutralizes the CSS animations** — confirm; if covered, downgrade to a
  one-line README note. Residual is only JS/transform-driven motion + standalone.

### 4. Launcher art not square — MED (launcher-repo work) — NOT DONE
- `images/sowduku.png` (launcher repo) must be square ≥512×512; local `game.png` is 1520×2000.
  Tracked as launcher issue [#26](https://github.com/paulgibeault/paulgibeault.github.io/issues/26).

### 5. Checkout dir vs slug — MED (local dev) — NOT DONE
- Local dir is still `sow-duku`; `dev.sh` mounts by basename → `/sow-duku/` while the launcher
  button points at `/sowduku/`. Rename the checkout to `sowduku` (framework B10 also detects
  gameId from `index.html` now, which mitigates this at the harness level).

### 6. Migrate hand-rolled stats to `Arcade.stats` — LOW — NOT DONE
- `getStats()` blob (`index.html:1472`) maps 1:1 onto `Arcade.stats.getOrInit/update`. Tracked
  as [sowduku #3](https://github.com/paulgibeault/sowduku/issues/3). (Keyed `hiScores`-by-board-code
  can stay; SDK B5 keyed bests now exist if you want to move it too.)

---

## Actions
- **File a new sowduku issue (#4)** led by the **stored XSS** (§1) + the migration sentinel (§2);
  ship as a follow-up PR. This is the single highest-value remaining game-side item in the fleet.
- Close the paired integration issue [sowduku #1](https://github.com/paulgibeault/sowduku/issues/1)
  (its PR merged) — but **only after** noting the XSS was out of its scope and is now tracked in #4.

## Priority
1 (XSS) → 2 (sentinel) → 4 (square art) → 5 (dir) → 3 (reduced-motion, verify) → 6 (stats).
