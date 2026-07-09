# Plan — P2P Chat (`paulgibeault/p2p-chat`, gameId `p2p-chat`)

Source: platform integration review. p2p-chat is the flagship `Arcade.peer.*`
consumer and its multiplayer handling is exemplary (spec-correct `interrupted`
handling, hello protocol, standalone degrade). It also carries the most serious
security bug in the fleet. Line numbers from the reviewed tree — re-confirm.
Default branch is `master`.

## Critical

### 1. Stored XSS via unescaped peer-controlled `id` fields — HIGH
- **Where:** text/names are escaped via `escapeHtml` (`app.js:16-20`), but *ids*
  interpolated into HTML attributes are not, and three come off the wire:
  - hello: `incomingId` (`app.js:448`) → `data-peer-id="…"` (`app.js:291`)
  - text: `id: payload.id || uid()` (`app.js:475`) → `data-id="…"` (`app.js:223,227`)
  - files: `payload.id` (`app.js:489`) → `data-file-id`/`data-remove` (`app.js:195,267`)
    and a `querySelector` selector-injection (`app.js:245`)
- **Problem:** a peer sending `id: '"><img src=x onerror=…>'` gets script execution
  in the same-origin iframe → read/write **all** `arcade.v1.*` storage for every
  game and the launcher. Stored: histories persist (`app.js:153-172`) and re-render.
- **Fix:** escape every peer-supplied id at each interpolation site, or validate on
  receipt against `/^[\w-]+$/`. Also escape `name` fed to `openMedia`'s `alt="…"`
  (`app.js:630`).
- **Accept:** a peer message with markup in `id`/`name` renders inertly; no attribute
  breakout; `querySelector` never throws on hostile ids.

## Bugs / spec gaps

### 2. File-send loop keeps sending during `interrupted` → replay-cap overrun — MED
- **Where:** chunk loop (`app.js:591-595`); replay queue caps at 1000
  (GAME_INTEGRATION.md:321). Two chained max-size files (`app.js:694`) ≈ 1168
  messages → silent loss with sender believing `state:'done'`.
- **Fix:** pause `sendChunk` while `currentStatus === 'interrupted'`, resume on
  `'connected'` (or refuse to start a new file send while interrupted).

### 3. Reduced-motion broken by a CSS variable-name mismatch — MED
- **Where:** styles define `--motion:1` and divide by `var(--motion,1)`
  (`styles.css:19,82-83,171,266`), but the SDK sets `--motion-scale`
  (`arcade-sdk.js:233`) with multiply-by-0 semantics.
- **Fix:** consume `--motion-scale` correctly (multiply, not divide — dividing by 0
  breaks), or gate on the forthcoming `data-reduced-motion` hook (framework B8).

### 4. Player-name changes don't propagate — LOW
- `myName` read once (`app.js:752`), no `Arcade.player.onChange`. Renaming mid-session
  leaves the peer seeing the old name. **Fix:** subscribe and re-hello.

### 5. Missing migration sentinel — LOW
- No `Arcade.state.migrate('v1', …)`, so the acceptance sentinel never exists
  (GAME_INTEGRATION.md:430). No legacy keys exist, so a no-op `migrate('v1',
  function(){})` in `init()` satisfies the check honestly.

### 6. Bound `payload.chunks` allocation — LOW
- `new Array(payload.chunks)` (`app.js:485`) trusts a peer-supplied count; clamp it.

## Launcher-side coordination
### 7. Finish or remove the catalog entry
- p2p-chat is in `#view-launcher` (launcher `index.html:387`, marked TEMP) and has
  `images/p2p-chat.png`, but is **absent from `#games` in profile.html**
  (GAME_INTEGRATION.md:375). Decide: promote to a real release (add the profile
  mirror, drop the TEMP note) or remove the launcher button. Tracked also in the
  framework plan A7.

## Framework-feedback (surfaced by this app; see framework plan)
- B6 peer identity/roster + presence-ready event (kills the hand-rolled `myId` +
  retry/echo hello dance, `app.js:434-463`).
- B7 `Arcade.peer.sendBlob`/`onBlob` + replay-queue depth visibility (removes the
  60+ lines of base64 chunking and makes §2 observable).
- Delivery/ack surface so the app can show real delivery vs merely-queued
  (`app.js:546-548` currently fabricates this from `send()`'s boolean).

## Priority
1 (critical) → 2 → 3 → 7 → 4 → 5 → 6.
