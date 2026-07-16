# Paul's Arcade — Game Integration Template

The minimal contract every game must satisfy to slot cleanly into the launcher.
The SDK is a single file at `https://paulgibeault.github.io/arcade-sdk.js`;
the rest is convention. Protocol version: **v2**.

For background see [ARCADE_PLATFORM.md](ARCADE_PLATFORM.md). This file is the
implementer's checklist.

---

## 1. Identity & hosting

- [ ] Game is hosted at `https://paulgibeault.github.io/<gameId>/` (same-origin with the launcher).
- [ ] `<gameId>` is kebab-case, matches the GitHub repo slug, and matches the game's `id` in the catalog.
- [ ] Entry point is `index.html` at the repo root so the GitHub Pages URL above resolves.

**The authoritative game list is [`catalog.json`](catalog.json).** The launcher
grid, the profile page's game cards, and the service worker's icon precache all
render from it — the old hand-mirrored copies are gone.

**Registering a new game** takes exactly three steps, none of them HTML edits:

1. Add one entry to `catalog.json`: `id`, `name`, `subtitle`, `icon`
   (`images/<gameId>.png`), `url` (root-relative, `/<gameId>/`), plus an
   optional `profile` block (`subtitle`, `alt`, `descLead`, `descBody`,
   `kicker`, `tags[]`, `codeUrl`) if it should appear on the portfolio page.
   Entries without a `profile` block render on the launcher only.
2. Commit the card image at `images/<gameId>.png`.
3. Bump `CACHE_NAME` in `sw.js` so installed launchers refresh their precache.

**Deep links.** `https://paulgibeault.github.io/#app=<gameId>` boots the
launcher straight into that game — ids resolve only through `catalog.json`
(a fragment can never name a URL). The launcher keeps the fragment updated as
games launch and quit, so the address bar is always shareable. `#p2p-*`
fragments (invite/reply links) take precedence over `#app=`.

---

## 2. Load the SDK

Drop two lines into `<head>` of `index.html`, before any game script that touches storage:

```html
<script src="/arcade-sdk.js"></script>
<script>Arcade.init({ gameId: '<your-game-id>' });</script>
```

Use a **root-relative** URL (`/arcade-sdk.js`), not the absolute
`https://paulgibeault.github.io/...` form. Both work in production, but
root-relative also resolves correctly when a local-dev harness stages the
launcher and game side-by-side under `127.0.0.1`, so no rewrite is needed.
The only place root-relative breaks is opening `index.html` directly from
disk via `file://` — which doesn't work for any modern game (modules, fonts,
storage, fetch) anyway, so serve over `http://localhost` for dev.

The SDK is a singleton (`window.Arcade`) and is safe to load standalone — when
not framed it locks `peer.status()` to `'unavailable'` and storage uses plain
same-origin `localStorage` directly.

**When mounted by the launcher, storage is BRIDGED** (`Arcade.context.storage
=== 'bridged'`): the launcher sandboxes game iframes without
`allow-same-origin`, so the frame cannot touch origin storage at all — the SDK
proxies every storage API over postMessage to the launcher instead, and sync
`Arcade.state` reads serve from a cache seeded by the launcher's welcome. The
API surface is IDENTICAL in both modes; the one behavioral contract:

**Await `Arcade.ready` before reading state.** Pre-ready reads in a frame
return empty (the snapshot hasn't arrived) and log a
`read before Arcade.ready` console warning naming the key:

```js
Arcade.init({ gameId: 'hecknsic' });
await Arcade.ready;     // resolves on welcome handshake (or after the standalone timeout)
const saved = Arcade.state.get('savedGame');
```

Standalone pages can skip the `await` — storage is direct there and settings
hydrate synchronously before init returns. But write for the framed contract:
a pre-ready `state.set` whose key turns out to exist in stored state is
DISCARDED in favor of the stored value (so an early `getOrInit` default can
never clobber a real save) — another reason boot code belongs after `ready`.
`Arcade.state.migrate(...)` may be called before `ready` (the SDK defers the
callback until the snapshot arrives when framed).

`Arcade.context.framed` is stable at `ready` for launcher mounts (sandboxed
frames wait a full 2 s for the welcome, and the launcher answers in
milliseconds). The one residual race is a legacy same-origin embed whose
welcome loses the 300 ms standalone timeout — if that happens, `framed` flips
after `ready` and `Arcade.onFramedChange(fn)` fires with the new value, so a
game that branches on `framed` at boot can re-run that branch instead of
missing the flip.

---

## 3. Storage — migrate to namespaced keys

The launcher's save/load file only round-trips keys that match
`arcade.v1.<gameId>.<key>` (and `arcade.v1.global.<key>`). Anything else is
silently dropped on import, so old keys won't survive a cross-device save.

- [ ] Replace `localStorage.getItem('foo')` with `Arcade.state.get('foo')`.
- [ ] Replace `localStorage.setItem('foo', JSON.stringify(v))` with `Arcade.state.set('foo', v)` (the SDK handles JSON).
- [ ] Use `Arcade.state.getOrInit('settings', DEFAULTS)` instead of hand-rolling deep-merge-with-defaults.
- [ ] Use `Arcade.global.*` only for things genuinely shared across games (e.g. a theme preference). Default to `Arcade.state.*`.
- [ ] If the launcher imports a save while the game is open, re-read state:

  ```js
  Arcade.onStateReplaced(() => { /* re-hydrate UI from Arcade.state.get(...) */ });
  ```

  Treat `onStateReplaced` like a fresh boot: recompute your start screen /
  current level / unlocks from storage. Do **not** assume the screen the user
  is on is still valid in the imported save — e.g. an imported file may not
  have the level the player was just on unlocked at all.

- [ ] Bulky local-only data (telemetry, replay buffers, caches) should not
  inflate every save file: write it with
  `Arcade.state.set('telemetry', data, { exportable: false })`. The flag is
  sticky per key until you set `{ exportable: true }`.
- [ ] Keys the player would expect to follow them across their own paired
  devices can opt into multi-device sync: `Arcade.state.set('save1', data,
  { sync: true })` — sticky like `exportable`, see §3b. Sync is opt-in per
  key AND per device pair; nothing replicates unless the user enables it.
- [ ] **Storage can fill up.** `Arcade.state.set(...)` returns `false` only when
  the write was *definitely* dropped (direct-mode quota). Inside the launcher
  (framed mode) the write is proxied to the launcher, so `set()` returns `true`
  = *accepted, pending* — a later launcher-side quota failure arrives
  asynchronously. **`Arcade.onStorageError` is therefore the only reliable
  "dropped" signal**; subscribe once for anything the user would hate to lose:

  ```js
  Arcade.onStorageError(() => Arcade.ui.toast('Storage full — some data was not saved', { kind: 'error' }));
  ```

  `Arcade.storage.estimate()` returns `{ usage, quota }` if you need to show it.
  (The launcher already calls `navigator.storage.persist()` on boot to keep the
  origin's data from being evicted under pressure.)

### One-shot migration of legacy keys

`Arcade.state.migrate(version, fn)` runs `fn` exactly once per `(gameId, version)`
— the SDK records a sentinel at `arcade.v1.<gameId>._migrated.<version>` so
subsequent loads skip.

For the common "move one legacy key into the namespace" case,
`Arcade.state.adopt(legacyKey, newKey?)` is a one-liner: it reads the legacy
key, writes it under `arcade.v1.<gameId>.<newKey>` (JSON-parsing the old raw
string unless you pass `{ json: false }`), and deletes the original — without
clobbering an already-namespaced value:

```js
Arcade.state.migrate('v1', () => {
    Arcade.state.adopt('hecknsic_settings', 'settings');
    Arcade.state.adopt('hecknsic_save', 'savedGame');
});
```

> **Framed caveat (pre-namespace legacy keys).** A legacy, non-namespaced key
> lives in the *real* origin's `localStorage`, which an in-launcher (opaque-
> origin) frame cannot read. `adopt()` detects this and does **not** let the
> migration complete there — the SDK withholds the `_migrated` sentinel so the
> move finishes on the next **standalone** visit to the game's own URL (where the
> legacy data is reachable), instead of marking the migration done and orphaning
> the save. Migrations that only touch already-namespaced `arcade.v1.*` keys work
> identically framed or standalone. Do **not** call raw `localStorage.getItem`
> inside a migration — it throws in a framed game; always go through `adopt()` /
> `Arcade.state.*`.

Version bumps *within* the namespace need no new machinery — use a fresh
migrate sentinel and rewrite in place:

```js
Arcade.state.migrate('v2-board-shape', () => {
    const s = Arcade.state.get('savedGame');
    if (s && !Array.isArray(s.board)) Arcade.state.set('savedGame', upgradeBoard(s));
});
```

For anything more involved (renamed score categories, per-mode splits), use
the full form:

```js
Arcade.state.migrate('v1', () => {
    // Guarded legacy read: raw localStorage THROWS in an opaque (framed) game.
    // Throwing here is deliberate — it aborts the migration WITHOUT burning the
    // _migrated sentinel, so it re-runs and completes on a standalone visit
    // where the legacy keys are actually reachable (see the framed caveat above).
    const readLegacy = (k) => {
        try { return localStorage.getItem(k); }
        catch (e) { throw new Error('legacy storage unreachable in a framed game — will complete standalone'); }
    };
    const dropLegacy = (k) => { try { localStorage.removeItem(k); } catch (e) {} };

    // 1. Settings (raw object → namespaced). adopt() is the plain-move path and
    //    already handles the framed defer itself.
    Arcade.state.adopt('hecknsic_settings', 'settings');

    // 2. Sticky player name → global
    const name = readLegacy('hecknsic_player_name');
    if (name) { Arcade.player.setName(name); dropLegacy('hecknsic_player_name'); }

    // 3. Per-mode high scores → leaderboard API
    for (const mode of ['arcade', 'chill', 'puzzle']) {
        const raw = readLegacy(`hecknsic_highscores_${mode}`);
        if (!raw) continue;
        try {
            const list = JSON.parse(raw);
            if (Array.isArray(list)) {
                for (const e of list) Arcade.scores.add(mode, e);
            }
        } catch (e) {}
        dropLegacy(`hecknsic_highscores_${mode}`);
    }
});
```

---

## 3a. Async storage — for data that outgrows localStorage

`Arcade.state` is synchronous, string-only, and shares the origin's ~5 MB
localStorage budget with every other app. When you need more room or binary
data (a photo, a document, a large pack library), use the async stores. Both are
per-app, both ride the launcher save bundle, and both are Promise-based.

- [ ] **Structured / bulky records** → `Arcade.store.open(name)` — a per-app
  IndexedDB key/value store (distinct `name`s are isolated):

  ```js
  const packs = Arcade.store.open('packs');   // 'arcade.v1.<gameId>.store.packs'
  await packs.set(pack.id, pack);
  const one = await packs.get(pack.id);        // null if absent
  const ids = await packs.keys();              // all keys
  await packs.each((value, key) => { /* ... */ });
  await packs.del(pack.id);
  ```

- [ ] **Binary blobs** (images, audio, files) → `Arcade.files`, backed by OPFS
  where available and IndexedDB otherwise:

  ```js
  await Arcade.files.put('cover.jpg', blob);
  const blob = await Arcade.files.get('cover.jpg');   // a Blob, or null
  const list = await Arcade.files.list();             // [{ name, size }]
  await Arcade.files.delete('cover.jpg');
  ```

Both are included in the launcher's export/import (schema v2) automatically — no
`{ exportable }` bookkeeping needed. Keep small, hot key/value state in
`Arcade.state` (sync, simplest); reach for these when it won't fit.

---

## 3b. Multi-device sync — Arcade.sync

Opted-in `Arcade.state` keys replicate between the user's **own paired
devices** over the existing P2P link — no cloud, no server. Replication is
last-writer-wins per key (hybrid logical clocks; ties broken by deviceId), so
it fits saves, unlocks, and settings-like state. It is NOT a merge/CRDT: two
devices editing the same key while apart converge to the newer write.

```js
Arcade.state.set('save1', data, { sync: true });  // sticky per-key opt-in
Arcade.sync.enable();            // or: sync every current & future own key
Arcade.sync.enable(['save1']);   // or: just these keys
Arcade.sync.disable();           // stop syncing (this device's outbound)
Arcade.sync.list();              // current opt-in list ('*' = everything)
Arcade.sync.onConflict(({ key, mine, theirs }) => {
    // Informational: a concurrent local edit lost LWW and was replaced by
    // `theirs`. State is already updated — refresh UI, or offer an undo
    // using `mine`.
});
```

Ground rules:

- **Both sides must opt in.** Sync only runs for a device pair the user
  enabled on BOTH devices (the 🔄 toggle in the launcher's Multiplayer
  dialog). Your opt-in list only marks which keys are eligible.
- **Own-namespace keys only.** `global.*`, `_meta.*`, SDK sidecars, and the
  legacy `.ls.` subtree never sync. `Arcade.store`/`Arcade.files` data does
  not sync in v1.
- **Values are capped at 64 KB** (JSON-encoded). Oversized values simply
  don't replicate (logged in dev mode) — keep synced keys small.
- **Deletes replicate** (`Arcade.state.remove` on one device removes the key
  on the other), and survive restarts via tombstones.
- **Clock skew bias:** "newer wins" is judged by device clocks (monotonic
  per device, but not corrected across devices). A fast clock wins ties it
  shouldn't — acceptable for save-style data, another reason not to sync
  rapidly-contended keys.
- Inbound sync writes arrive as ordinary `arcade:state.changed` events — if
  you already handle `Arcade.state.onChange`, synced updates just work.
- A save-file **import counts as a fresh local edit** of every imported
  synced key: after an import, the imported values win over older remote
  edits at the next sync.

---

## 4. Player profile, scores, and stats

- [ ] Use `Arcade.player.name()` / `Arcade.player.setName(s)` for the sticky display name. It lives at `arcade.v1.global.playerName` so every game shares it.
- [ ] If your game has a leaderboard, use `Arcade.scores.add(category, { score, name?, key?, meta? }, opts?)` and `Arcade.scores.list(category, { limit })`. The SDK keeps the top 100 sorted and stamps `name` (from `Arcade.player.name()`) and `ts` automatically. Higher-is-better is the default; time/move-count games pass `{ order: 'asc' }` on every add so lower scores rank first.
- [ ] For best-per-thing records (best time per board code, best score per level), stamp each entry with `key` and read back with `Arcade.scores.best(category, key)`. If you need a full keyed map rather than a ranked list, `Arcade.stats` is the blessed home — `Arcade.stats.update(category, prev => ({ ...prev, [boardCode]: bestMs }))`.
- [ ] If your game tracks counters (games played / won / streak / best time), use `Arcade.stats.update(category, prev => next)` for atomic-style updates and `Arcade.stats.get(category)` to read. When adding a new field to an existing stats category, use `Arcade.stats.getOrInit(category, DEFAULTS)` instead of `get` — it deep-merges defaults under the stored value so saves from older versions pick up newly-added fields without a migration.

---

## 5. Settings — respect launcher preferences

The launcher pushes a settings snapshot in the welcome message and again on
every change. The SDK applies the visual ones to the game's `<html>` for free:

| Setting          | Where to read                       | DOM hook applied by SDK                            |
| ---------------- | ----------------------------------- | -------------------------------------------------- |
| `fontScale`      | `Arcade.settings.fontScale()`       | `style="--font-scale: <n>"`                        |
| `theme`          | `Arcade.settings.theme()`           | `data-theme="light"` or `data-theme="dark"`        |
| `reducedMotion`  | `Arcade.settings.reducedMotion()`   | `data-reduced-motion="true|false"` + `style="--motion-scale: 0"` (1 otherwise) |
| `audioVolume`    | `Arcade.settings.audioVolume()`     | `style="--audio-volume: <0..1>"` (read in JS)      |
| `handedness`     | `Arcade.settings.handedness()`      | `data-handedness="left"` or `data-handedness="right"` |

**Reduced motion is handled for you by default:** the SDK's injected base
style includes a kill-switch rule — when `data-reduced-motion="true"`, every
CSS animation and transition collapses to a single instant frame
(`animation-duration: .001ms !important`, etc.). No `calc(var(--motion-scale))`
rewrites needed for the common case. A game that wants to manage motion
itself (e.g. keep some animations, slow others) opts out of the kill rule by
setting `data-arcade-keep-motion` on `<html>` and keying its own CSS/JS off
`[data-reduced-motion="true"]` or `--motion-scale`. Canvas/JS-driven motion
still needs the JS checks below either way.

To benefit:

- [ ] Size text in `rem` or `em`, not `px` — the SDK injects `:root { font-size: calc(100% * var(--font-scale, 1)); }` so rem-based text scales for free.
- [ ] If your game has a dark/light theme already, key its CSS off `[data-theme="dark"]` / `[data-theme="light"]` rather than rolling your own toggle.
- [ ] If your game has tween-heavy effects, multiply durations by `getComputedStyle(document.documentElement).getPropertyValue('--motion-scale')` (or skip animations when `Arcade.settings.reducedMotion()` is `true`).
- [ ] If your game has handedness-sensitive UI (e.g. control palette position), key it off `[data-handedness="left"]`.

### Canvas-rendered games

- [ ] **Font scale**: multiply every `ctx.font` size by `Arcade.settings.fontScale()`. Re-render on `Arcade.onSettingsChange(...)`.
- [ ] **Theme**: if you support both, branch palette/style choices on `Arcade.settings.theme()`. If your game has a single mandatory aesthetic (e.g. cozy-solitaire's cabin-warm palette), it's fine to opt out of theme — document this in the game's README.
- [ ] **Reduced motion**: gate canvas tweens, particle systems, and shader animations on `Arcade.settings.reducedMotion()`.
- [ ] **Handedness**: if a game-controlled overlay (e.g. on-screen joystick, action palette) lives on the canvas, switch its anchor side based on `Arcade.settings.handedness()`.

For most canvas games, a single subscription that flips a couple of cached
multipliers and triggers a redraw is enough:

```js
let fontMult = Arcade.settings.fontScale();
Arcade.onSettingsChange((s) => { fontMult = s.fontScale; markDirty(); });
ctx.font = `${14 * fontMult}px Georgia, serif`;
```

Subscribe explicitly only when you need to react beyond CSS:

```js
Arcade.onSettingsChange((snap) => { /* relayout canvas, etc. */ });
```

---

## 6. Lifecycle & resource utilization

The launcher keeps a bounded LRU pool of recently-played iframes. The active
game is visible; recent inactive games stay mounted (hidden) for instant
relaunch; least-recently-used games beyond the cap are evicted entirely
(`iframe.src = 'about:blank'` + DOM removal). The user-facing default cap is
**2** with a numeric input in the launcher menu accepting any integer in
`[1, gameCount]` (where `gameCount` is the number of games in the launcher).

That means a well-behaved game must do two things: **pause cleanly when hidden**,
and **survive eviction without data loss**.

### 6a. Pause when hidden

Hidden games still run timers and `requestAnimationFrame` unless paused, which
wastes battery — and a pool slot occupied by a runaway game pushes other games
out of the cache sooner. The SDK delivers explicit hints:

- [ ] Subscribe to `Arcade.onSuspend(fn)` to pause your game loop / mute audio.
- [ ] Subscribe to `Arcade.onResume(fn)` to unpause and reset any `lastTime` accumulators.
- [ ] You no longer need a separate `visibilitychange` handler — the SDK merges the launcher's iframe-pool hints with the page's own visibility (`visibilitychange`/`pagehide`) into one deduplicated suspend/resume stream. That includes **standalone**: a game opened at its GitHub Pages URL gets the same `onSuspend` when its tab hides, so flush/pause logic in `onSuspend` works identically in both modes (and `Arcade.session.start({ persistKey })` persists standalone too).
- [ ] Code that mounts mid-session (or CSS) can read the current state at any time: `Arcade.context.suspended`, or the `data-arcade-suspended="true|false"` attribute the SDK maintains on `<html>`. A hidden iframe's own `document.visibilityState` stays `"visible"`, so poll-style time trackers must check `Arcade.context.suspended`, not visibility.

```js
let paused = false;
Arcade.onSuspend(() => { paused = true; audio.suspend(); });
Arcade.onResume(() => { paused = false; lastFrame = performance.now(); audio.resume(); });
```

For a canvas render loop, skip the hand-rolled rAF bookkeeping entirely —
`Arcade.loop(fn)` cancels on suspend, re-requests on resume **only if it was
running**, and never lets suspended time leak into a delta (the first frame
after resume gets `delta = 0`):

```js
const loop = Arcade.loop((deltaMs) => { update(deltaMs); draw(); });
loop.start();            // begin
loop.stop();             // in-game pause menu
loop.kick();             // one frame on demand (dirty-flag renderers)
```

For timers, `Arcade.session.setTimeout(fn, ms)` / `Arcade.session.setInterval(fn, ms)`
freeze while suspended (remaining time is preserved and re-armed on resume)
and cancel themselves when a save import replaces state. Both return
`{ cancel() }`.

For wall-time tracking (best-time stats, an elapsed-time UI), use
`Arcade.session.start()` instead of hand-rolling `performance.now()` math —
the returned tracker subscribes to the lifecycle hooks above, so suspended
intervals don't accrue:

```js
const t = Arcade.session.start();
// ...in your render loop / stats write:
display.textContent = formatTime(t.elapsedMs());

// Manual pause for an in-game modal — composes with onSuspend/onResume:
openPauseMenu();   t.pause();
closePauseMenu();  t.resume();

t.reset();   // back to 0, still running (or still paused, if it was paused)
t.stop();    // detach lifecycle listeners when the timer is no longer needed
```

Each `start()` returns a fresh, independent tracker — multiple concurrent
timers (per-round + total session, etc.) are fine.

When the launcher imports a save (`arcade:state.replaced`), every live
tracker auto-resets to 0. The imported state has its own elapsed snapshot,
so re-hydrate game-time UI from `Arcade.state` in your `onStateReplaced`
handler; the wall clock since "now" is a separate concern that resets
naturally with the new session.

To make elapsed survive reloads (and pick up the imported value on
`stateReplaced` instead of resetting), pass a `persistKey`:

```js
const t = Arcade.session.start({ persistKey: 'sessionElapsed' });
```

The tracker reads `Arcade.state.get('sessionElapsed')` on start, writes
`t.elapsedMs()` back on suspend / reset / stop, and on `stateReplaced`
re-reads the freshly imported value as the new baseline.

### 6b. Survive eviction

When a game is evicted from the pool its `window` is destroyed — JS heap, audio
context, WebGL context, and any in-memory game state all go away. A subsequent
launch is a **fresh page load**, identical to opening the standalone URL.

- [ ] Anything worth preserving across launches must be written via `Arcade.state.set(...)` during play (or, at the latest, in your `onSuspend` handler). Raw `localStorage` doesn't work in launcher frames (§9) — the SDK is the persistence path.
- [ ] Do **not** assume your iframe will be alive next time the user launches your game. There is no per-iframe in-memory cache that persists across eviction.
- [ ] In `onSuspend`, flush any debounced/coalesced writes. The launcher delivers the suspend hint and holds teardown for a ~250 ms grace so a synchronous flush in your handler reliably lands — but only a *synchronous* one; don't start async work there and expect it to finish.

### 6c. Be a good iframe citizen — resource hygiene

Even before eviction, while a game sits hidden in the pool it should hold as
little as possible:

- [ ] Pause `requestAnimationFrame` loops in `onSuspend` (don't just skip rendering — cancel the rAF and re-request it in `onResume`).
- [ ] `audio.suspend()` your `AudioContext`. A suspended context still exists but stops the audio thread.
- [ ] Release WebGL contexts you don't need. Browsers cap the number of live WebGL contexts per page; the launcher's pool can have several at once. If your game has multiple canvases, share one context, or call `loseContext()` on transient ones.
- [ ] Clear `setInterval` / `setTimeout` chains on suspend; restart on resume. Forgotten intervals are the #1 source of battery drain in hidden iframes.
- [ ] Avoid retaining decoded asset buffers (large `ArrayBuffer`s from `decodeAudioData`, big textures) that you can re-fetch cheaply on resume — local-cache hits are nearly free.
- [ ] Network: cancel in-flight `fetch` / WebSocket traffic on suspend if it's not user-visible work. The user is no longer looking at your game.
- [ ] Test memory under repeated launch/quit cycles in DevTools → Memory → Heap snapshot. Snapshot before a launch and after returning to the launcher; the heap should not grow monotonically.

The launcher's LRU cap protects users from games that ignore this guidance, but
a cooperative game keeps the user's whole arcade experience snappier — under
the cap, your hidden iframe is competing with up to one other game for memory,
audio, and GPU resources.

---

## 7. UI — launcher-mediated chrome (toasts, dialogs, title, quit, files)

If you'd otherwise pop a transient banner, prefer the launcher-rendered toast
when framed (so it survives game UI redraws and uses the launcher's a11y
announcer). Standalone, the SDK draws an in-place fallback.

```js
Arcade.ui.toast('Saved!',         { kind: 'success' });
Arcade.ui.toast('Network down',   { kind: 'error', duration: 4000 });
```

`kind` is `'info' | 'success' | 'warning' | 'error'`; `duration` defaults to 2500ms.

The sandbox **no-ops `window.confirm`/`prompt`** inside game frames, so the
SDK provides real modals rendered by the launcher (#35). All of these need
the launcher's `ui.bridge` capability (`Arcade.peer.caps()`); against an
older launcher they resolve as if cancelled instead of hanging. Standalone,
each falls back to the native equivalent.

```js
// Modals — launcher-rendered, serialized, focus-trapped. Every dialog is
// attributed with your app's catalog name (“My App” asks: …), and prompt
// input is always plain text — apps can never imitate the launcher's own
// passphrase dialogs.
const sure = await Arcade.ui.confirm('Erase the journal?', { okLabel: 'Erase', cancelLabel: 'Keep' });
const name = await Arcade.ui.prompt('Save as?', 'untitled');   // string | null (cancel)

// Topbar title — '' resets to your catalog name. Kept while your frame
// stays pooled; standalone it drives document.title.
Arcade.ui.setTitle('Journal — draft 3');

// Quit interception — return false (or a Promise of false) to veto the quit
// button, e.g. to flush a mid-edit document first. The launcher timeboxes
// the ask (~1.5s): a slow or hung handler forfeits the veto rather than
// trapping the user. Pass null to unregister.
Arcade.ui.onBeforeQuit(async () => {
  await flushDraft();
  return true;
});

// Open a file from the device — sandboxed frames have no picker of their
// own; the launcher shows a consent dialog, then brokers the File across.
const file = await Arcade.ui.openFile({ accept: '.txt,text/*' });   // File | null

// Share — Web Share behind a launcher consent dialog; where Web Share is
// unavailable the payload lands on the clipboard instead.
const how = await Arcade.ui.share({ text: 'come play', url: 'https://…' });  // 'shared' | 'copied' | null

// Clipboard — stays in-frame (the launcher grants clipboard-write to game
// frames); call it from a click handler so a user gesture is present.
const ok = await Arcade.ui.copy(shareCode);   // boolean
```

Dialog-popping calls (`confirm`/`prompt`/`openFile`/`share`) only work while
your app is the **active** one — a backgrounded frame gets the cancel answer
(`false`/`null`) instead of interrupting whatever the user switched to.

---

## 7b. Safe rendering — escape untrusted text

All apps share the launcher's origin, so a script injected into one app can
read/write **every** app's storage. Any string you didn't author yourself —
a peer's name or message (`Arcade.peer.onMessage`), a pack/level name from an
imported or shared file, an entry from `Arcade.scores` — is **untrusted** and
must be escaped before it touches `innerHTML` or an HTML attribute.

- [ ] Prefer `textContent` / `setAttribute` (they never parse HTML), or use the
  SDK helpers when you must build markup strings:

  ```js
  // escape one value
  el.innerHTML = '<span class="name">' + Arcade.html.escape(peer.name) + '</span>';

  // or a whole fragment — the tagged template escapes every ${…} interpolation
  el.innerHTML = Arcade.html`<li data-id="${msg.id}">${msg.text}</li>`;
  ```

- [ ] Validate ids/codes you use in selectors or attributes against a charset
  (`/^[\w-]+$/`) so a hostile value can't break out of the attribute or the
  `querySelector` string.

This is a real, shipped-then-fixed bug class in this fleet (peer-id XSS in
p2p-chat; shared-pack XSS in sowduku) — treat every off-device string as hostile.

---

## 7a. Multiplayer — Arcade.peer (LIVE)

The launcher owns a serverless WebRTC connection (the in-repo `p2p/`
transport, see `p2p/README.md` and `p2p/PROTOCOL.md`).
Players pair through the launcher's **Multiplayer** menu — QR codes and chat
links, no signaling server. Games never touch any of that; the whole surface is:

```js
Arcade.peer.status();              // 'unavailable' | 'idle' | 'connecting' | 'connected' | 'interrupted'
Arcade.peer.onStatus(s => ...);    // gate multiplayer UI on this (AGGREGATE across all links)
Arcade.peer.caps();                // launcher capability flags: feature-detect additive features
                                   // ('peer.sendTo', 'peer.roster', 'peer.meta'); [] standalone
Arcade.peer.send({ move: 'e4' });  // broadcast; JSON-safe payload; false unless connected/interrupted
Arcade.peer.send(hand, { to });    // targeted: only deviceId `to` receives it (cap 'peer.sendTo')
Arcade.peer.onMessage((payload, fromPeer, meta) => ...);  // fromPeer = sender's stable deviceId;
                                   // meta = { relayed, to: 'me'|'all' } (cap 'peer.meta')

Arcade.peer.self();                // { deviceId, name } for THIS device (null before first pairing)
Arcade.peer.remote();              // DEPRECATED — most recently seen remote device, or null.
                                   //   Single-peer helper; prefer peers() (roster, multi-seat aware).
Arcade.peer.peers();               // [{ deviceId, name, status, direct }] — the multi-peer roster
Arcade.peer.onPeersChange(r => ...);  // full roster on any join/leave/rename/status change
Arcade.peer.onReady(({ deviceId }) => ...);  // remote has THIS game mounted & listening

Arcade.peer.sendBlob(file, { onProgress });  // chunked large payloads; Promise (broadcast only)
Arcade.peer.onBlob((blob, { name, size, fromPeer }) => ...);
Arcade.peer.onBlobError(({ id, name, reason, received, total }) => ...);
// reason: 'timeout' (stalled 60s — e.g. chunks lost to queue overflow),
//         'aborted' (sender gave up mid-transfer),
//         'integrity' (bytes didn't match the sender's SHA-256).
// A failed transfer is dropped whole — never a silently-wrong blob. Ask the
// sender to resend. Transfers are hash-verified end-to-end automatically.

Arcade.peer.queue();               // { depth, limit, overflowed } — replay-queue visibility
Arcade.peer.onQueue(q => ...);     // pushed while 'interrupted'; overflowed ⇒ resync after recovery
```

Rules of the road:

- [ ] **Multiplayer is a bonus, never a requirement** — `status()` is
      `'unavailable'` standalone and `'idle'` framed-but-unpaired. Core
      gameplay must work in both.
- [ ] Payloads must be JSON-serializable (structured clone is NOT used).
      Keep them small and frequent rather than large and rare; chunk anything
      big (the channel is ordered + reliable).
- [ ] Both devices run the same game for a session. Messages are routed by
      `gameId` — a message sent while the other device has a different game
      mounted is dropped silently. You no longer need a hand-rolled
      hello/echo handshake for "is my peer listening yet?": subscribe to
      `Arcade.peer.onReady(...)` — the launchers exchange presence
      announcements whenever a game mounts (and on every reconnect), so it
      fires as soon as the same game is listening on both ends. It may fire
      more than once per session; treat it as an idempotent signal.
- [ ] `'connected'` means the data channel is genuinely open (transport
      v1.5.1 semantics) — safe to send immediately on the transition.
- [ ] **Ride out `'interrupted'`** (transport v1.7): the peer's device blipped
      (notification, app switch, network wobble) and the transport is repairing
      the SAME session — do NOT reset game state or show a "player left"
      screen. Show a lightweight "reconnecting…" indicator instead. `send()`
      still returns `true`: messages queue and replay with exactly-once
      delivery, so turn-based games can simply keep playing. The episode ends
      with either `'connected'` (resume, nothing was lost) or `'idle'` (the
      grace window — minutes — expired; NOW treat the player as gone). With
      auto-reconnect enabled (transport v1.9), even a TOTAL connection loss
      (both devices offline, browsers killed) surfaces as `'interrupted'`
      while the rendezvous layer repairs it — same rule: wait, don't reset.
- [ ] High-rate realtime games (30+ msgs/sec) should pause their send loop
      while `'interrupted'` and resync authoritative state on `'connected'` —
      the replay queue is capped at 1000 messages. The cap is visible:
      `Arcade.peer.queue()` returns `{ depth, limit, overflowed }` (pushed to
      `onQueue` subscribers during an episode), and `overflowed === true`
      means the oldest unacknowledged messages were already dropped, so
      resync rather than trusting replay.
- [ ] Files and other large payloads: don't hand-roll base64 chunking —
      `Arcade.peer.sendBlob(blob, { onProgress })` chunks over the ordered
      channel and the receiver's `Arcade.peer.onBlob` fires with a
      reassembled, **hash-verified** `Blob`. Mind the replay cap when sending
      large files while `'interrupted'` — if chunks are lost to overflow the
      receiver gets `onBlobError` (`'timeout'`) instead of a wedged transfer;
      resend after recovery.
- [ ] Don't cache `status()` at init: a game mounted mid-session receives
      `'connected'` in its welcome, and live transitions arrive via `onStatus`.

Multi-seat rules (host holding several standalone connections):

- [ ] **Feature-detect, don't version-check**: gate targeted sends / roster /
      meta on `Arcade.peer.caps()` at lobby time. A session's host should
      announce the chosen wire mode in its own lobby frame so mixed-cap
      tables degrade to a game-level fallback uniformly. The platform guards
      the worst mixed-version case itself: a joiner's targeted send returns
      `false` when its HOST is on an older launcher (the host announces its
      wire capabilities during the identity handshake), so a private frame
      is never handed to a hub that would blind-relay it to every seat.
- [ ] **Target private state; broadcast shared state.** `send(payload, { to })`
      guarantees a non-addressee joiner never *receives* the frame (real
      routing privacy — no cooperative discard). It never falls back to
      broadcast: the SDK returns `false` when the launcher lacks the
      `peer.sendTo` cap or `to` is malformed, and the launcher *silently
      drops* (never fans out) a frame whose target is unknown, just departed,
      or whose session host is too old to route it. `true` therefore means
      "handed to the launcher", not "delivered" — a game that needs delivery
      guarantees acknowledges at the game layer.
- [ ] **`to` is routing, not secrecy from the host**: joiner→joiner targeted
      frames transit the host's bridge readable (inherent to the star
      topology, and correct for host-authoritative games). End-to-end
      sealing against the host is a game-layer concern.
- [ ] **Per-seat status comes from `peers()`**, not `status()`: the aggregate
      stays `'connected'` while ANY link is up, so a 4-player table must key
      its "reconnecting…" chips on roster entries flipping to
      `'interrupted'`. Roster entries hold `'connected' | 'interrupted'`; a
      seat that's truly gone leaves the roster (that's the leave signal).
      `direct: true` marks the device your link actually terminates at — for
      a joiner, exactly the host, so the host needs no lobby frame to be
      identified.
- [ ] **Spoof check via `meta.relayed`**: a frame claiming host authority
      that arrives with `relayed: true` did NOT come from your direct link
      partner — treat it as another joiner talking, not the host. Targeted
      frames arrive with `meta.to === 'me'`; broadcasts with `'all'`.

Try it: mount `tools/fixtures/p2p-test-game/` on two devices via the launcher
and watch the message log; `node tools/p2p-acceptance.mjs` runs the automated
two-launcher version headlessly, and `node tools/p2p-multiseat-acceptance.mjs`
the host + two joiners version (targeted sends, roster, meta).

---

## 7c. Determinism & sharing helpers

Three games hand-rolled the same mulberry32 PRNG, two disagreed on when a
"daily" puzzle rolls over, and every shareable-code format was reinvented.
The SDK now owns all three primitives — use them instead of copies:

```js
// Seeded PRNG (mulberry32) whose whole state is one u32 — persistable mid-game.
const rng = Arcade.rng('room-42');        // number or string seed (string → FNV-1a)
rng();                                    // float in [0, 1)
rng.int(1, 6); rng.pick(arr); rng.shuffle(deck);   // deck is a copy
const s = rng.getState();                 // save with your game state…
rng.setState(s);                          // …restore: the sequence continues exactly
Arcade.rng.hash('any string');            // FNV-1a → u32 (stable across devices)

// Daily puzzles. THE PLATFORM RULE: "today" is the DEVICE-LOCAL calendar
// date — dailies roll at the player's midnight, not UTC's. Do not hand-roll
// this with toISOString() (that's UTC): hecknsic (UTC) and sowduku (local)
// disagreeing on "today" is the live bug this helper kills.
Arcade.daily.dateStr();                   // 'YYYY-MM-DD', device-local
const daily = Arcade.daily.seed();        // deterministic per game per day
const bonus = Arcade.daily.seed('bonus'); // salts give independent streams
// (seed() folds in your gameId — call it after Arcade.init.)

// Share codes: versioned base64url over JSON. decode() VALIDATES — it
// returns { v, data } or null, never throws, and strips prototype-polluting
// keys, so pasted garbage can't hurt you. Bump v when your payload shape
// changes and reject versions you don't speak.
const code = Arcade.share.encode({ board, moves }, { v: 2 });
const parsed = Arcade.share.decode(userInput);
if (parsed && parsed.v === 2) load(parsed.data);
```

`Arcade.random.seeded(seed)` remains as a legacy alias of the stateless
variant; prefer `Arcade.rng`. Feature-detect on older launcher-served SDKs
with `typeof Arcade.rng === 'function'` — everything here is purely local
(no launcher messages involved).

---

## 8. Standalone mode must keep working

The launcher is one of two ways to run the game; the GitHub Pages URL is the other.

- [ ] Open `https://paulgibeault.github.io/<gameId>/` directly in a browser tab and confirm the game still works end-to-end with no console errors.
- [ ] `Arcade.context.framed === false` in standalone — do not gate core gameplay on `framed`.
- [ ] Do not assume `peer.status() === 'connected'`; treat multiplayer features as optional.

---

## 9. Iframe sandbox compatibility

The launcher mounts each game in
`<iframe sandbox="allow-scripts allow-downloads" allow="autoplay; fullscreen; gamepad; screen-wake-lock" allowfullscreen>`.
Note there is **no `allow-same-origin`**: the frame runs with an opaque origin
so a game can never open the origin's storage (other apps' data, the P2P key
stores) — that's the platform's trust boundary (see ARCADE_PLATFORM.md).
`allow-downloads` exists so a game can trigger `<a download>` (e.g. saving a
file received over `Arcade.peer`) — without it, Chrome silently blocks
anchor-triggered downloads from a sandboxed iframe.

- [ ] No top-level navigation (`window.top.location = ...`) — it will be blocked.
- [ ] No `window.open` to internal links; use in-game UI for help/about screens.
- [ ] If the game requests fullscreen, request it on a user gesture only and target the game's own root element.
- [ ] **Never touch `window.localStorage` / `indexedDB` / OPFS / `caches` directly in code that runs framed** — in an opaque-origin frame the property access itself throws `SecurityError`. Go through `Arcade.state/store/files`; wrap any unavoidable legacy probe in try/catch.
- [ ] ES modules and `fetch()`ed assets load fine framed — GitHub Pages (and the dev servers) send `Access-Control-Allow-Origin: *`, which opaque-origin CORS requests need.

You do **not** need a postMessage storage shim — the SDK IS the shim when
framed. If your game has a hand-rolled one (legacy from earlier protocol
versions), delete it as part of the SDK adoption. (One older game, hecknsic,
once shipped such a shim; the launcher still answers the
`ls-proxy-request`/`ls-proxy-response` protocol purely for backward
compatibility — not a pattern to copy.)

---

## 10. PWA / service worker hygiene

Several games already ship a `manifest.json` and `sw.js`. Because every game
and the launcher live on the same origin, sloppy scopes will collide.

> **Framed reality check:** a game's SW only ever controls **standalone**
> visits to `/<gameId>/` — an opaque-origin launcher frame can't be controlled
> by any service worker, so in-launcher play always hits the network/HTTP
> cache. The SDK shims `navigator.serviceWorker` with an inert stub inside
> frames (register() rejects catchably; the real getter would throw
> `SecurityError`). Keep registration fire-and-forget with a `.catch`, never
> `await navigator.serviceWorker.ready` on your boot path, and wrap any SW
> code that runs **before** the SDK loads in try/catch.

Start from the reference worker at
[`tools/templates/game-sw.js`](tools/templates/game-sw.js) — it encodes every
rule below (scope-filtered fetch handler, version-keyed cache, own-caches-only
cleanup).

- [ ] `manifest.json` `"scope"` and `"start_url"` are scoped to `/<gameId>/`, not `/`.
- [ ] If the game registers a service worker, register it with `{ scope: '/<gameId>/' }` and place `sw.js` inside that path.
- [ ] The service worker only caches assets under `/<gameId>/`. **Never** cache `/arcade-sdk.js` or anything at the launcher root — the SDK inspects the origin's caches at load and reports a `console.error` (plus a visible toast in `?dev=1` mode) when a game cache holds launcher files.
- [ ] The fetch handler must ignore out-of-scope URLs. A controlled page routes **every** request through its SW — including `/arcade-sdk.js` — so the guard is mandatory, not optional:

  ```js
  self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (!url.pathname.startsWith('/<gameId>/')) return;  // ← the load-bearing line
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request))
    );
  });
  ```

- [ ] **Never clean up origin-wide.** `caches.keys()` and
  `navigator.serviceWorker.getRegistrations()` see every game's caches and
  workers *plus the launcher's* — one game shipping
  `caches.keys().then(names => names.map(n => caches.delete(n)))` or a blanket
  `getRegistrations().then(rs => rs.forEach(r => r.unregister()))` wipes the
  whole arcade's offline support. Filter cache deletions to your own
  version-keyed prefix (`<gameId>-*`) and never unregister workers you didn't
  register.

> The launcher's own service worker lives at `/sw.js` (root scope), caches only launcher-owned files (`index.html`, `arcade-sdk.js`, `styles.css`, `p2p/`, launcher images), and its fetch handler path-filters to those same trees — requests for `/<gameId>/...` fall through untouched. The launcher SW is also skipped on loopback hosts (`localhost`, `127.x`, `::1`) so local-dev edits to launcher or SDK are never masked by stale cache.

---

## 11. Launcher card assets

The launcher has both a portfolio card and a launcher button for every game;
both pull from `paulgibeault.github.io/images/<gameId>.png`.

- [ ] Provide a square cover image, ≥ 512×512, saved as `images/<gameId>.png` in the launcher repo (PR against `paulgibeault/paulgibeault.github.io`).
- [ ] Update both the `#games` portfolio section in [profile.html](profile.html) and the `#view-launcher` grid in [index.html](index.html) — a comment above `#view-launcher` in `index.html` ("Game list is mirrored in profile.html...") marks the duplicate.
- [ ] Provide a one-line subtitle (≤ 20 chars) for the launcher button (e.g. "Hex Puzzle", "Memorization").

---

## 12. Local development

The launcher and games are served from **one origin** in production (the
game frames themselves run opaque-origin — their storage rides the launcher
bridge, and the SDK loads root-relative from the launcher). Reproduce that
locally with [`dev.sh`](dev.sh), which stages everything under one server
(with the `Access-Control-Allow-Origin: *` header opaque-frame module loads
need):

```sh
# from the launcher repo
./dev.sh ../<your-game-repo>            # one game
./dev.sh ../si-syn ../pi-game           # multiple, served side-by-side
./dev.sh stop                           # kill the dev server
```

`dev.sh` builds each game (`npm run build` if `package.json` declares a build
script; otherwise serves the dir as-is), copies the launcher next to the
game(s), rewrites absolute `https://paulgibeault.github.io` URLs to the local
origin, and serves the result on `127.0.0.1:4791` (override with
`ARCADE_PORT`). The launcher's own service worker auto-skips on loopback
hosts, so edits aren't masked by stale cache.

Re-run `./dev.sh` after editing source — it rebuilds and restages atomically.
Only the games you pass on the command line are mounted; clicking a launcher
button for a game that wasn't staged will 404.

### Dev-mode tracing

To watch the launcher↔game postMessage handshake, append `?dev=1` to either
the launcher or the game URL once. The flag persists in
`arcade.v1._meta.dev` (cleared with `?dev=0`), and both the launcher and the
SDK log every message they send or receive via `console.debug`:

```
[Arcade launcher → si-syn] {type: "arcade:welcome", version: 2, ...}
[Arcade si-syn ←]          {type: "arcade:welcome", version: 2, ...}
[Arcade si-syn →]          {type: "arcade:hello", gameId: "si-syn", ...}
```

Useful when "did the welcome arrive yet?" is a real question — e.g. when a
game's UI takes a moment to render and you can't tell whether it's blocked
on the handshake or just slow.

---

## 13. Acceptance checklist

A game is considered integrated when all of the following pass:

- [ ] Loads inside the launcher iframe with no console errors.
- [ ] `Arcade.context.framed === true` when launched from the launcher; `false` when opened directly.
- [ ] At least one piece of game state writes to a key matching `arcade.v1.<gameId>.*` (verify in DevTools → Application → Local Storage).
- [ ] No legacy non-namespaced keys remain after first load (your `Arcade.state.migrate('v1', ...)` ran successfully — check the `arcade.v1.<gameId>._migrated.v1` sentinel).
- [ ] Launcher Save → exported JSON contains the game's keys; Launcher Load of that file restores them and the game reflects the restored state (after `onStateReplaced` or page reload).
- [ ] Changing the launcher's font scale visibly resizes text in the game without a reload.
- [ ] Switching to launcher view and back fires `onSuspend` then `onResume`; the game pauses while hidden and resumes cleanly.
- [ ] Setting *Keep in Memory* to `1` in the launcher menu, launching another game, then re-launching this game does a fresh load and restores user-visible progress (high score, current level, etc.) from `arcade.v1.<gameId>.*` localStorage.
- [ ] Any off-device / imported / shared string the game renders (peer names & messages, imported pack/level names, score entries) is escaped via `Arcade.html.escape` / `textContent` — a value like `"><img src=x onerror=alert(1)>` renders inertly.
- [ ] If the game uses `Arcade.store` / `Arcade.files`, a Launcher Save → Load round-trip restores that data too (it rides the schema-v2 bundle).
- [ ] Standalone URL (`https://paulgibeault.github.io/<gameId>/`) still works exactly as before.
- [ ] Service worker (if any) does not intercept requests for `/arcade-sdk.js` or other launcher assets (no `[Arcade SDK]` warning in console).

### Automated check

The launcher repo ships [`tools/acceptance.mjs`](tools/acceptance.mjs), a
Playwright-driven runner that verifies every item above against a staged
launcher. From the launcher repo:

```sh
# one-time setup
npm install
npx playwright install chromium

# in one shell: stage launcher + game
./dev.sh ../<your-game-repo>

# in another shell: run the checklist
npm run acceptance -- http://127.0.0.1:4791/<gameId>/
```

Output is one line per check (✓/✗) with a brief detail when something
fails. Exit code is non-zero if any check fails — wire it into a per-game
pre-deploy script if you want regression coverage.

---

## 14. Reference

- Platform design: [ARCADE_PLATFORM.md](ARCADE_PLATFORM.md)
- SDK source: [arcade-sdk.js](arcade-sdk.js)
- Launcher iframe pool & message routing: [index.html](index.html) (search for `PLATFORM CONTROLLER`)

### Wire protocol summary (v2)

All messages namespaced `arcade:`. Origin guard: launcher frames are
opaque-origin, so the SDK pins the origin of the first `welcome` from
`window.parent` and requires it on every later message (standalone/legacy
same-origin embeds keep the `origin === window.location.origin` rule). The
launcher only acts on messages from iframes it mounted via the pool, and
requires their origin to be the sandboxed literal `'null'`.

```
child  → parent: arcade:hello              { gameId, version }
parent → child:  arcade:welcome            { version, caps, peerStatus, peers, settings, state }
                                           // caps: capability flags (absent ⇒ []); peers
                                           // entries: { deviceId, name, status, direct };
                                           // state: storage-bridge snapshot (own keys +
                                           // global.* + _meta identity/dev, raw strings)
parent → child:  arcade:settings.changed   { settings }
parent → child:  arcade:state.replaced     { state }                // after file import (fresh snapshot)
parent → child:  arcade:lifecycle.suspend  { }                      // iframe hidden, or about to be evicted
parent → child:  arcade:lifecycle.resume   { }                      // iframe shown
parent → child:  arcade:peer.status        { status }               // aggregate across links
parent → child:  arcade:peer.message       { payload, fromPeer, meta }  // fromPeer = sender deviceId;
                                           // meta = { relayed, to: 'me'|'all' }
parent → child:  arcade:peer.roster        { peers }                // full roster on any change
parent → child:  arcade:peer.identity      { deviceId, name }       // roster update (legacy single-peer)
parent → child:  arcade:peer.ready         { deviceId, name }       // remote same-game listening
parent → child:  arcade:peer.queue         { depth, limit, overflowed }
child  → parent: arcade:peer.send          { payload, to? }         // to = target deviceId (targeted)
child  → parent: arcade:ui.toast           { message, kind, duration }

— ui chrome bridge (§7; the SDK speaks this for you) —
child  → parent: arcade:ui.op              { op: 'confirm'|'prompt'|'openFile'|'share', id, ... }
                                           // RPC ops; answered via arcade:bridge.result
                                           // (value: true/string/File/'shared'/'copied', null = cancel)
child  → parent: arcade:ui.op              { op: 'setTitle', title } | { op: 'quitHook', enabled }
parent → child:  arcade:ui.beforeQuit      { id }                   // only sent when quitHook enabled
child  → parent: arcade:ui.beforeQuit.result { id, allow }          // allow=false vetoes; launcher
                                                                    // timeboxes the ask (~1.5s)

— storage bridge (framed storage; see §3/§9; the SDK speaks this for you) —
child  → parent: arcade:state.write        { key, value }           // raw string, null = remove; launcher
                                                                    // allows own namespace, global.*, _meta.dev
parent → child:  arcade:state.writeError   { key, error }           // launcher-side quota → Arcade.onStorageError
parent → child:  arcade:state.changed      { key, value }           // shared key changed by launcher/other frame
                                                                    // (incl. writes applied by Arcade.sync)
parent → child:  arcade:sync.conflict      { key, mine, theirs }    // a concurrent local edit lost LWW (§3b);
                                                                    // key unprefixed, values JSON-parsed
child  → parent: arcade:store.op           { id, name, op, key?, value? }  // get|set|del|keys|entries|clear
child  → parent: arcade:files.op           { id, op, name?, blob? }        // put|get|list|delete
child  → parent: arcade:storage.op         { id, op }                      // estimate|persisted|persist
parent → child:  arcade:bridge.result      { id, ok, value?, error? }      // reply channel for the three op types
```

Settings shape:
```js
{ fontScale: number, theme: 'light'|'dark', reducedMotion: boolean,
  audioVolume: 0..1, handedness: 'left'|'right' }
```
