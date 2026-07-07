# Plan — HecknSic (`paulgibeault/hecknsic`, gameId `hecknsic`)

Source: platform integration review. One of the better-migrated games — the old
ls-proxy shim is fully removed; storage, scores, player name, handedness,
suspend/resume, and legacy migration all go through the SDK. Two real problems: a
service worker that caches launcher assets, and orphaned shim-era data. Line
numbers from the reviewed tree — re-confirm.

## Bugs

### 1. Service worker caches `/arcade-sdk.js` (and everything) — HIGH
- **Where:** `sw.js:54-74` runs cache-first for *every* GET the page makes, no URL
  scoping (the localhost skip at `:56` only helps dev).
- **Problem:** in prod the iframe's SDK request (`index.html:15`) is cached under
  `hecknsic-v1.3.0`, so a stale SDK is served indefinitely and the SDK's
  `checkSWCollision` warning fires. Violates GAME_INTEGRATION.md §10/§13.
- **Fix:** in the fetch handler, bail unless
  `new URL(event.request.url).pathname.startsWith('/hecknsic/')` (or matches
  `self.registration.scope`). Bump `CACHE_VERSION` to purge cached SDKs on deployed
  clients. (Aligns with framework B1 template.)
- **Accept:** SDK request falls through to network; no `[Arcade SDK]` warning.

### 2. Shim-era `.ls.*` data orphaned by migration — MED
- **Where:** framed-era play was stored under `arcade.v1.hecknsic.ls.<rawKey>`
  (launcher `index.html:1104-1105`), but `migrate('v1')` reads only the plain
  `hecknsic_*` keys (`index.html:24-27`).
- **Problem:** a user who played framed during v1.2.13 silently lost
  settings/progress on upgrade, and the `.ls.` keys ride every save as dead weight.
- **Fix:** add `Arcade.state.migrate('v2', …)` that enumerates
  `arcade.v1.hecknsic.ls.*`, re-runs the v1 mapping on the embedded raw keys, and
  deletes the originals. **This is the prerequisite for retiring the launcher's
  ls-proxy path (framework B11).**

### 3. rAF not cancelled on suspend — LOW (§6c)
- **Where:** `gameLoop` early-returns but re-requests rAF every frame while paused
  (`js/main.js:584-587`).
- **Fix:** store the rAF id, `cancelAnimationFrame` in `onSuspend`, re-request in
  `onResume` (already resets `lastTime`). Or adopt framework B4's `Arcade.loop`.

### 4. Canvas text ignores fontScale — LOW (§5)
- **Where:** score popups / bomb timers / labels use fixed px
  (`js/renderer.js:849,1070,1165`); the 10px handedness pill (`css/style.css:110`).
- **Fix:** cache `Arcade.settings.fontScale()`, multiply the three `ctx.font` sites,
  redraw from the existing `onSettingsChange` subscription.

## Cleanup
- Gate canvas tweens on `reducedMotion` (the follow-up comment at `js/main.js:207`
  already promises this) — scale `js/tween.js` durations by
  `reducedMotion() ? 0 : 1`.
- Switch the SDK `<script src>` to root-relative `/arcade-sdk.js` (`index.html:15`).
- Delete vestigial `DEFAULT_SETTINGS.theme`/`soundVolume` (`js/storage.js:12-14`) —
  never read, no audio exists.
- Replace the hand-rolled `showEditorStatus()` fade (`js/puzzle-editor.js:217-223`)
  with `Arcade.ui.toast`; adopt `Arcade.stats` (games played/won, best combo).
- Document the dark-only theme opt-out in README (§5).

## Positive pattern to keep
- The handedness integration (global-key single source of truth + hiding in-game
  controls when framed, `js/main.js:178-205`) is exemplary — proposed as the §5
  handedness reference example in the framework docs.

## Priority
1 → 2 → 3 → 4 → cleanup.
