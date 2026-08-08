# Paul's Arcade — Game Integration Template

The minimal contract every game must satisfy to slot cleanly into the launcher.
The SDK is a single file served from the launcher origin — load the evergreen
alias `/arcade-sdk.js` (§2); the rest is convention. SDK major: **v3**
(semver + release log in [`sdk/CHANGELOG.md`](sdk/CHANGELOG.md)).

For background see [ARCADE_PLATFORM.md](ARCADE_PLATFORM.md). This file is the
implementer's checklist.

---

## 1. Identity & hosting

- [ ] Game is hosted at `https://paulgibeault.github.io/<gameId>/` (same-origin with the launcher).
- [ ] `<gameId>` is kebab-case, matches the GitHub repo slug, and matches the game's `id` in the catalog.
- [ ] Entry point is `index.html` at the repo root so the GitHub Pages URL above resolves.

**The authoritative game list is [`catalog.json`](catalog.json).** The launcher
grid, the profile page's game cards, and the service worker's icon precache all
render from it.

**Registering a new game** takes exactly two steps, no HTML edits:

1. Add one entry to `catalog.json`: `id`, `name`, `subtitle`, `icon`
   (`/<gameId>/icon.png`), `url` (root-relative, `/<gameId>/`), plus an
   optional `profile` block (`subtitle`, `alt`, `descLead`, `descBody`,
   `kicker`, `tags[]`, `codeUrl`) if it should appear on the portfolio page.
   Entries without a `profile` block render on the launcher only.
2. **Serve your own card image at `/<gameId>/icon.png`** — square, 512 px or
   larger. It lives in your repo, not the launcher's; if you have a build step,
   make sure the icon ends up in the published output (a repo-root file that
   never reaches `dist/` is the way this goes wrong). The launcher degrades to
   a text-only tile if it 404s.

Nothing to bump: fleet CI stamps `sw.js`'s `APP_VERSION` on every launcher
deploy, so installed launchers pick up the new catalog automatically.

**Shipping before it's finished.** Set `"inDevelopment": true` on the entry and
both surfaces stamp a diagonal *In Development* ribbon across the card image —
the game is listed and playable, but nobody mistakes a work in progress for a
finished one. It is the honest way to put an app in front of players early.
Drop the flag when the game is done; that is the only edit the promotion takes.

**Deep links.** `https://paulgibeault.github.io/#app=<gameId>` boots the
launcher straight into that game — ids resolve only through `catalog.json`
(a fragment can never name a URL). The launcher keeps the fragment updated as
games launch and quit, so the address bar is always shareable. `#p2p-*`
fragments (invite/reply links) take precedence over `#app=`.

---

## 2. Load the SDK

Starting a fresh app? [`tools/templates/starter-app/`](tools/templates/starter-app/)
is a working skeleton (index.html with the two lines below, manifest, reference
service worker, icon) — copy it and rename.

Drop two lines into `<head>` of `index.html`, before any game script that touches storage:

```html
<script src="/arcade-sdk.js"></script>
<script>Arcade.init({ gameId: '<your-game-id>' });</script>
```

Use the **evergreen** alias (`/arcade-sdk.js`, always the newest major) —
this is the deliberate fleet posture (decided in #120/#108, recorded in
ISSUES.md): the closed fleet moves together at each major cut rather than
pinning per app, so a breaking major ships as one coordinated change that
migrates every app the moment it deploys. The major-pinned form
(`/sdk/v<major>/arcade-sdk.js`) keeps serving its major line even after a
breaking cut and exists as the escape hatch for an app that must sit a major
out — but that is the exception, not the standard. Within a major,
launcher↔SDK feature compatibility is negotiated at runtime by
`welcome.caps`, never by version numbers.

**Cutting a new major, when one is ever needed.** Evergreen has a consequence
worth writing down before it bites: because every app follows the alias, a
breaking cut reaches the whole fleet the moment it deploys. There is no
staggered rollout to hide behind and no per-app canary. What makes that safe is
not a waiting period on the SDK — it is that the SDK is never the only thing
that changed.

Sequence it expand → migrate → contract:

1. **Expand.** Ship the new behavior in the current major, alongside the old
   one. Nothing breaks; both paths work.
2. **Migrate.** Move every app onto the new path and deploy them. Each app is
   compatible with the old and the new SDK at this point, so the order does not
   matter and a straggler is not a broken game.
3. **Wait for cache turnover.** A returning player runs the app shell their
   service worker cached, which can lag the deploy by however long it takes
   them to open the game again. Give it a couple of weeks past the last app
   deploy — the point is not a magic number, it is that the shells in the wild
   have all seen step 2 before the SDK stops serving step 1. There is no
   backend to measure this from; GitHub Pages serves static files and the fleet
   collects nothing, so the criterion is time, deliberately.
4. **Contract.** Cut the major, delete the old path, deploy. Every app follows
   the alias on its next load and every shell already speaks the new path.

An app that genuinely cannot make step 2 in time is what the major-pinned
escape hatch is for. Using it should be a decision someone writes down, not a
default.

Use a **root-relative** URL, not the absolute
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
`Arcade.state` reads serve from a cache seeded by the launcher's welcome.
(`Arcade.context.storage` has a third value, `'memory'`: an opaque-origin
frame that no launcher answered — some non-launcher embed. State then lives
in memory only and is gone on unload; the API keeps working, nothing
persists. You don't design for this mode, but don't crash in it either.)
The API surface is IDENTICAL in all modes; the one behavioral contract:

**Await `Arcade.ready` before reading state.** Pre-ready reads in a frame
return empty (the snapshot hasn't arrived) and log a
`read before Arcade.ready` console warning naming the key:

```js
Arcade.init({ gameId: 'my-app' });
await Arcade.ready;     // resolves on welcome handshake (or after the standalone timeout)
const saved = Arcade.state.get('savedGame');
```

Standalone pages can skip the `await` — storage is direct there and settings
hydrate synchronously before init returns. But write for the framed contract:
a pre-ready `state.set` whose key turns out to exist in stored state is
DISCARDED in favor of the stored value (so an early `getOrInit` default can
never clobber a real save) — another reason boot code belongs after `ready`.

`Arcade.context.framed` is stable at `ready` for launcher mounts (sandboxed
frames wait a full 2 s for the welcome, and the launcher answers in
milliseconds). The one residual race is a same-origin embed whose
welcome loses the 300 ms standalone timeout — if that happens, `framed` flips
after `ready` and `Arcade.onFramedChange(fn)` fires with the new value, so a
game that branches on `framed` at boot can re-run that branch instead of
missing the flip.

---

## 3. Storage — namespaced keys

All game state lives under `arcade.v1.<gameId>.<key>` (and
`arcade.v1.global.<key>` for genuinely shared values) — the save/export
bundle only round-trips keys matching that shape, and anything else is
silently dropped on import. The SDK enforces the namespace for you; never
touch `localStorage` directly.

- [ ] Read with `Arcade.state.get('foo')` — never `localStorage.getItem`.
- [ ] Write with `Arcade.state.set('foo', v)` — the SDK handles JSON encoding.
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
  "dropped" signal.** Since SDK 3.12.0 you get a default for free: with no
  listener registered, the SDK itself toasts "Save failed — device storage is
  full" (throttled to one per 10 s), so a quota failure is never silent.
  Register your own listener only to customize the reaction — doing so
  replaces the default:

  ```js
  Arcade.onStorageError(({ key, error }) => promptPlayerToFreeSpace(key));
  ```

  `Arcade.storage.estimate()` returns `{ usage, quota }` if you need to show
  it; `Arcade.storage.persisted()` / `Arcade.storage.persist()` read/request
  the origin's eviction protection (the launcher already calls `persist()` on
  boot, so games rarely need to).

Beyond `get`/`set`/`remove`: `Arcade.state.has(key)` distinguishes "absent"
from a stored `null` (which `get` can't); `Arcade.state.keys()` lists the
game's stored keys (unprefixed); `Arcade.state.onChange(key, fn)` fires on
any change to that key — launcher-side writes, another frame, an inbound
sync, a save import. `Arcade.global.onChange(key, fn)` is the same for
shared `global.*` keys, and `Arcade.player.onChange(fn)` for the display
name.

---

## 3a. Async storage — for data that outgrows localStorage

> **Available, not yet exercised.** No catalog app currently uses
> `Arcade.store` or `Arcade.files` (every shipped save fits `Arcade.state`).
> The surfaces are tested by the launcher's store/bridge acceptance suites,
> but no real game has proven the contract end-to-end the way a shipped
> consumer does — budget a little extra verification time if you're the
> first. (Kept deliberately: #120's adopt-or-annotate pass chose to keep
> them over cutting.)

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
- **Own-namespace keys only.** `global.*`, `_meta.*`, and SDK sidecars never
  sync. `Arcade.store`/`Arcade.files` data does not sync in v1.
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

## 3c. Migrating existing saves — `migrate` and `adopt`

A game onboarding into the fleet (or reshaping its save data) uses two
primitives. Five of the seven catalog apps run them today — this is the
load-bearing path for keeping players' pre-existing saves.

```js
// Run fn exactly ONCE per (gameId, version) — a persisted sentinel skips it
// on every later load. Use for one-shot data reshapes.
Arcade.state.migrate('v2', () => {
  const legacy = Arcade.state.get('oldShape');
  if (legacy) Arcade.state.set('newShape', convert(legacy));
  Arcade.state.remove('oldShape');
});

// Move a PRE-NAMESPACE key (raw localStorage, from before the game joined
// the fleet) into the game's namespace: read → namespaced write → delete
// original. Returns true when a legacy value was found and handled.
Arcade.state.migrate('v1', () => {
  Arcade.state.adopt('myGameSave');                    // same key name, namespaced
  Arcade.state.adopt('hi-scores', 'scores');           // rename while adopting
  Arcade.state.adopt('rawBlob', 'blob', { json: false }); // keep as string, skip JSON.parse
});
```

Semantics worth trusting:

- `adopt` is **error-safe**: the original is deleted only after a successful
  namespaced write, and an existing namespaced value is never clobbered (the
  legacy key is just cleaned up). By default the raw string is `JSON.parse`d
  (kept as-is if that fails); `{ json: false }` stores it as a string.
- In a **bridged frame the migration may run before the welcome snapshot** —
  the SDK defers it to post-`ready` automatically, and FIFO ordering still
  runs it before your own `ready.then(boot)` code. Call `migrate()` at
  script top level, before boot.
- **The bridged-frame caveat — read this if you use `adopt`:** pre-namespace
  keys live in the REAL origin's localStorage, which an opaque-origin
  launcher frame cannot read. When `adopt` hits that wall it flags the
  enclosing `migrate()`, which **withholds its run-once sentinel** instead of
  burning it — so the migration re-runs and completes on a later
  **standalone visit** to the game's own URL (console warnings say exactly
  this). Burning the sentinel in the frame would orphan the legacy save
  permanently; that near-miss is why the machinery works this way. Write the
  migration idempotently (adopt already is) and it needs no special handling.

---

## 4. Player profile, scores, and stats

- [ ] Use `Arcade.player.name()` / `Arcade.player.setName(s)` for the sticky display name. It lives at `arcade.v1.global.playerName` so every game shares it.
- [ ] If your game has a leaderboard, use `Arcade.scores.add(category, { score, name?, key?, meta? }, opts?)` and `Arcade.scores.list(category, { limit })`. The SDK keeps the top 100 sorted and stamps `name` (from `Arcade.player.name()`) and `ts` automatically. Higher-is-better is the default; time/move-count games pass `{ order: 'asc' }` on every add so lower scores rank first.
  - **Leaderboards are shared across a player's linked devices.** When two devices are paired and have per-peer sync turned on (Multiplayer → 🔄), the launcher union-merges each device's board into the other's — so `Arcade.scores.list` transparently returns everyone's entries, deduped and re-sorted, capped at 100. Your game does nothing extra: keep calling `add`/`list` as normal. (The SDK stamps a hidden `dev`/`eid` on each entry so merges never drop or double-count a play; don't rely on those fields.)
- [ ] For a **single personal best per category** (best time for a mode, fewest moves, high percentage) — one value, not a ranked list — use `Arcade.records` rather than bending `scores`. `Arcade.records.best(category, { value, direction, format?, label? })` writes only when the value improves; `direction` is `'higher'` (scores) or `'lower'` (times, move counts), so the record is self-describing and the launcher's **Records** sheet can render it with no per-game code. This is the first-class replacement for the `scores.add(cat, { score: -timeMs })`-then-re-negate trick. `format` is `'duration-ms' | 'integer' | 'percentage'`. Read back with `Arcade.records.get(category)` / `Arcade.records.list()`. `Arcade.records.set(category, {...})` writes unconditionally (use it when the game, not the record, decides what counts — e.g. a migration); `Arcade.scores.clear(category)` / `Arcade.records.clear(category)` exist for reset-progress flows.
  - **Which of the three?** `scores` = a sorted leaderboard with many entrants (top-N, names). `records` = one best-ever value per category, self-describing. `stats` = mutable counters/blobs (games played, streaks) that you own the formatting of.
- [ ] For best-per-thing records (best time per board code, best score per level), stamp each entry with `key` and read back with `Arcade.scores.best(category, key)`. If you need a full keyed map rather than a ranked list, `Arcade.stats` is the blessed home — `Arcade.stats.update(category, prev => ({ ...prev, [boardCode]: bestMs }))`.
- [ ] If your game tracks counters (games played / won / streak / best time), use `Arcade.stats.update(category, prev => next)` for atomic-style updates and `Arcade.stats.get(category)` to read. When adding a new field to an existing stats category, use `Arcade.stats.getOrInit(category, DEFAULTS)` instead of `get` — it deep-merges defaults under the stored value so existing saves pick up newly-added fields automatically.

---

## 5. Settings — respect launcher preferences

The launcher pushes a settings snapshot in the welcome message and again on
every change. The SDK applies the visual ones to the game's `<html>` for free:

| Setting          | Where to read                       | DOM hook applied by SDK                            |
| ---------------- | ----------------------------------- | -------------------------------------------------- |
| `fontScale`      | `Arcade.settings.fontScale()`       | `style="--font-scale: <n>"`                        |
| `theme`          | `Arcade.settings.theme()`           | `data-theme="light"` or `data-theme="dark"`        |
| `reducedMotion`  | `Arcade.settings.reducedMotion()`   | `data-reduced-motion="true|false"` + `style="--motion-scale: 0"` (1 otherwise) |
| `audioVolume`    | `Arcade.settings.audioVolume()`     | `style="--audio-volume: <0..1>"` (read in JS) — or just use `Arcade.audio` (below), which honours it for you |
| `handedness`     | `Arcade.settings.handedness()`      | `data-handedness="left"` or `data-handedness="right"` |
| `powerSaver` (SDK 3.13.0+) | `Arcade.settings.powerSaver()`      | `data-power-saver="true|false"` + `--arcade-pulse-count: 3` normally, `1` under power saver, `0` under reduced motion (what the game observes under reduced motion is `1`, not `0` — see the bullet below) |

- [ ] **Sound effects → `Arcade.audio`.** Don't hand-roll an AudioContext — the SDK owns the foot-guns (lazy ctx, first-gesture unlock, master gain wired to `audioVolume`, suspend-on-hide/resume-on-return, and the exponentialRamp-from-zero crash). Register cues and play them:
  ```js
  Arcade.audio.cue('blip', { type: 'square', freq: 660, dur: 0.08, gain: 0.3 });
  Arcade.audio.play('blip');                 // or play('blip', { freq: 880 }) to override
  Arcade.audio.play({ type: 'noise', dur: 0.2, gain: 0.15 });          // inline spec
  Arcade.audio.play([{ freq: 523, dur: 0.1 }, { freq: 784, dur: 0.1 }]); // timed sequence
  ```
  spec = `{ type:'sine'|'square'|'sawtooth'|'triangle'|'noise', freq, toFreq?, dur, gain, attack?, release? }`. Fire-and-forget; silent + cheap when the user has muted (`audioVolume` 0).

- [ ] **Environmental sound → graph cues (SDK 3.6.0+).** A spec cue is one
  oscillator with an envelope. That palette is a chiptune synthesizer by
  construction — no choice of `freq`/`gain` produces a sound with material or
  space, and two fleet-wide re-tunes confirmed it the hard way. When a game wants
  audio that sounds like a *place*, load the optional element library and build
  cues as node graphs:

  ```html
  <script src="/arcade-sdk.js"></script>
  <script src="/arcade-audio.js"></script>   <!-- optional; skip it and you pay nothing -->
  ```
  ```js
  Arcade.audio.room({ decay: 0.62 });               // the shared acoustic space
  Arcade.audio.graph('place-card', (ctx, out, when, params, rnd) => {
    const E = Arcade.audio.el();
    E.strike(ctx, out, when, { dur: 0.005, hp: 4200, gain: 0.16 });
    E.body(ctx, out, when, { f0: 330 * E.cents(rnd, 15), gain: 0.2,
                             partials: [{ ratio: 1, gain: 1, decay: 0.4 }] });
  }, { send: 0.3 });
  Arcade.audio.play('place-card');                  // unchanged call site
  ```

  Elements are physical gestures rather than waveforms — `strike`, `rustle`,
  `pluck` (Karplus–Strong), `creak` (stick-slip), `droplet`, `body` (inharmonic
  partials with independent decay), `thump`, `flare` (combustion), `blast`
  (explosion), `chirp` (insect stridulation), `stream`, plus the later
  additions the fleet drove in: `shatter` (granular breakage), `ratchet`
  (decelerating detents), `drone` (sustained tone bed) — 3.8.0; `squelch`
  (wet contact), `breath`, `grunt` (animal air and voice) — 3.9.0; and `flex`
  (a thin springy sheet bent and released: paper, cardstock, a flag) —
  3.10.0. If your game needs a
  gesture that isn't there, add it to the library rather than hand-rolling it in
  the pack: a game's pack is its *design* — which gestures, how loud, how far
  away — and the synthesis belongs where every pack can reach it. Every cue
  feeds one shared
  convolution room, which is what makes overlapping sounds fuse into a scene
  instead of stacking into a pile, and each cue's `send` is really a statement
  about how far away it is. `rnd` is a seeded stream — vary pitch and balance per
  play, because byte-identical repetition is itself a chiptune tell.

  **Ship the pack as a well-known handle (3.11.0+):** keep the room, sends
  and cue functions in one `js/soundpack.js` and register it via
  `ArcadeAudioElements.registerPack({ name, ROOM, SENDS, CUES })`, which
  publishes it at `window.ArcadeSoundPack`. That one handle is what lets the
  launcher's offline audition renderer (`tools/soundpack/`) load the exact
  file the game ships — the audition and the game play the same code.

  Sustained beds use `const h = Arcade.audio.start('ambient')` / `h.stop(1.5)`;
  register those with `{ sustained: true }` and have the cue return a teardown
  function — `E.teardown(collect)` builds the standard one from the `collect`
  array the elements filled in.

  **A bed that responds to play (3.7.0+):** `h.retune(params, fade)`. A
  sustained cue schedules its whole timeline up front, so nothing can be
  adjusted in place — `retune` starts a second instance and fades the first out
  under it, keeping the same handle. Quantise the parameter and give it
  hysteresis first; do not call it every frame.

  ```js
  const bed = Arcade.audio.start('night', { heat: 0 });
  // …later, when the game gets tense (a handful of times per level, not per frame)
  bed.retune({ heat: 1 }, 3.0);
  ```

  A graph cue **takes precedence over a spec cue of the same name**, so you
  can upgrade one sound at a time. Don't keep spec cues registered as a
  "fallback" for a pack-based game, though — the fleet retired that pattern:
  when the element library is unavailable (a stale cached page, a standalone
  embed), a pack-based game gates and plays **silence by design**, because
  the pack *is* the sound and an approximation of it is worse than nothing.
  Spec cues are for games whose chiptune palette is the deliberate aesthetic,
  not a degradation tier.

- [ ] **Building a custom node graph? Connect to `Arcade.audio.bus()`, not
  `ctx.destination`.** `Arcade.audio.context()` hands you the managed
  AudioContext, but its master gain is private — anything wired straight to
  `ctx.destination` **silently bypasses the launcher's volume slider and global
  mute**. `bus()` is the correct destination and obeys both.

  Design and audition sound packs offline with `tools/soundpack/` — it renders
  your pack to a single WAV in headless Chromium using the same shipped
  `arcade-audio.js` the game loads, so you judge the real thing before wiring it
  in. See `tools/soundpack/README.md`.

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
- [ ] **Attention pulses → `--arcade-pulse-count` (SDK 3.13.0+).** Any looping emphasis effect (turn indicator, "ready" ring, hint shimmer) should declare `animation-iteration-count: var(--arcade-pulse-count, 3)` and end on a static resting treatment that still says the same thing (a colour, a border, a static glow). Never `infinite` — see §6d. The SDK owns the token ladder: `3` normally, `1` under power saver, `0` under reduced motion.

  **Under reduced motion the count a game actually observes is `1`, not `0`.**
  The token does go to `0`, but the kill-switch rule above sets
  `animation-iteration-count: 1 !important` on `*`, and `!important` beats a
  custom property. So a game without `data-arcade-keep-motion` gets one
  iteration at `.001ms` — a single instantaneous frame. The rendered result is
  what you want either way, but `animationstart` (and `animationend`) still
  fire, so don't hang logic on the assumption that a `0` in the token means the
  animation never ran. A game that has opted out with `data-arcade-keep-motion`
  is outside the kill rule, so there the `0` lands literally: zero iterations,
  no animation events at all.

  The ladder is deliberately not gated on `data-arcade-keep-motion`, because the
  token is opt-in per effect — a game consumes it by writing
  `animation-iteration-count: var(--arcade-pulse-count, 3)` on that specific
  effect. Unlike the blanket `*` kill switch, it needs no escape hatch: a game
  that wants one particular effect to keep looping simply doesn't consume the
  token there. The corollary is the case above — a keep-motion game that *does*
  consume the token gets a literal `0` under reduced motion.
- [ ] Gate optional ambient effects (particles, background loops, decorative video) off entirely when `Arcade.settings.powerSaver()` is `true` (SDK 3.13.0+), and re-check on `Arcade.onSettingsChange`. **Guard the read if your repo vendors its own copy of the SDK:** on anything older than 3.13.0 `Arcade.settings.powerSaver` is `undefined`, and calling it throws `TypeError: Arcade.settings.powerSaver is not a function` — inside an `onSettingsChange` handler that is a throw on every launcher settings write, not just at startup. Read it as `const saving = Arcade.settings.powerSaver ? Arcade.settings.powerSaver() : false;` and an older SDK degrades to "not saving". The CSS half needs no such guard: `var(--arcade-pulse-count, 3)` carries its own fallback, so an SDK that never defines the token just leaves the effect at 3 pulses.

### Canvas-rendered games

- [ ] **Font scale**: multiply every `ctx.font` size by `Arcade.settings.fontScale()`. Re-render on `Arcade.onSettingsChange(...)`.
- [ ] **Theme**: if you support both, branch palette/style choices on `Arcade.settings.theme()`. If your game has a single mandatory aesthetic (a fixed period palette, say), it's fine to opt out of theme — document this in the game's README.
- [ ] **Reduced motion**: gate canvas tweens, particle systems, and shader animations on `Arcade.settings.reducedMotion()`.
- [ ] **Power saver (SDK 3.13.0+)**: when `Arcade.settings.powerSaver()` is `true` — read it defensively as `Arcade.settings.powerSaver ? Arcade.settings.powerSaver() : false` if your repo vendors an SDK older than 3.13.0, where the method doesn't exist and the call throws — drop ambient/decorative rendering (idle particle systems, background shaders, frame-rate luxuries) and prefer dirty-flag redraws (`Arcade.loop(...).kick()`) over continuous frames. Gameplay-essential motion stays.
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
loop.running();          // is it currently scheduled?
loop.dispose();          // detach lifecycle listeners when done for good
```

`kick()` is the whole dirty-flag story: a renderer that is normally parked
calls it to draw one frame after state changes, and `start()`/`stop()` switch
it to continuous only while something is actually animating. There is no
separate idle mode to reach for.

> **This is the fleet standard, not an option.** Every catalog game with a
> frame loop runs on `Arcade.loop`. Two things it buys that a hand-rolled loop
> repeatedly failed to: `start()` is idempotent, so a wake-up path cannot stack
> a second concurrent loop and orphan the first (that bug shipped, and doubled
> one game's frame rate permanently after any restart); and one place owns the
> suspend/resume legs, which is where the divergence lived — the fleet had a
> game cancelling on `visibilitychange`, a game relying only on `onSuspend`,
> and a game that never cancelled at all.

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

- [ ] Use `Arcade.loop` (§6a) rather than pausing a hand-rolled `requestAnimationFrame` loop in `onSuspend`. If you do hand-roll one, cancelling the rAF is the requirement — skipping the render inside a still-scheduled frame keeps holding an animation slot.
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

### 6d. Let the screen rest — the visible-but-idle state

Everything in 6a–6c is scoped to the *hidden* case. There is a third state the
lifecycle stream cannot see: **visible but idle** — the user is looking at your
game and nothing is happening. A turn-based game spends most of its life here,
and it is where battery quietly goes: any running animation, however cheap,
forces the compositor to keep producing frames, so the display pipeline never
reaches 0 fps. An infinite CSS pulse is a rAF loop that never stops, expressed
declaratively.

The contract:

- [ ] **No infinite animations.** Emphasis effects pulse finitely via
  `animation-iteration-count: var(--arcade-pulse-count, 3)` (§5, SDK 3.13.0+) and settle to
  a static resting treatment. Motion earns its cost at the moment state
  changes; after that, a static indicator says the same thing for free.
- [ ] **Animate only compositable properties** (`opacity`, `transform`) while
  a pulse runs. Animating `box-shadow`, `text-shadow`, `filter`, or layout
  properties repaints on the main thread every frame — put the effect on a
  pseudo-element with a static shadow and fade its opacity instead.
- [ ] **Continuous rendering must be state-gated.** A canvas loop runs only
  while something is actually moving (`Arcade.loop` + `kick()` for dirty-flag
  redraws); when the board is settled, no frames.
- [ ] **Verify it:** with your game visible and waiting for input, a DevTools
  Performance trace should show a flat main thread and the frame rate at 0
  between state changes. If it doesn't, something above was missed.

The `powerSaver` setting (§5, SDK 3.13.0+) is the user's explicit lever on top of this
baseline: pulses drop from 3 to 1, ambient effects go out entirely, and the
launcher pins its pool to the active game. A game that meets this section
already needs no extra work for power saver beyond honouring the token and
the ambient-effects gate.

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
the launcher's `ui.bridge` capability (`Arcade.peer.caps()`); when the cap
is absent they resolve as if cancelled instead of hanging. Standalone,
each falls back to the native equivalent. (There is deliberately no
`Arcade.ui.prompt` — it was removed in 3.12.0 with zero consumers, and its
absence is also what makes it structurally impossible for a game to imitate
the launcher's own passphrase input dialogs.)

```js
// Modals — launcher-rendered, serialized, focus-trapped. Every dialog is
// attributed with your app's catalog name (“My App” asks: …).
const sure = await Arcade.ui.confirm('Erase the journal?', { okLabel: 'Erase', cancelLabel: 'Keep' });

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
// (Available, not yet exercised by any catalog game — same caveat as §3a.)
const file = await Arcade.ui.openFile({ accept: '.txt,text/*' });   // File | null

// Share — Web Share behind a launcher consent dialog; where Web Share is
// unavailable the payload lands on the clipboard instead.
const how = await Arcade.ui.share({ text: 'come play', url: 'https://…' });  // 'shared' | 'copied' | null

// Clipboard — stays in-frame (the launcher grants clipboard-write to game
// frames); call it from a click handler so a user gesture is present.
const ok = await Arcade.ui.copy(shareCode);   // boolean
```

Dialog-popping calls (`confirm`/`openFile`/`share`) only work while
your app is the **active** one — a backgrounded frame gets the cancel answer
(`false`/`null`) instead of interrupting whatever the user switched to.

One non-UI helper worth knowing here: `Arcade.audio.enabled()` returns
whether sound can be heard at all (WebAudio exists and `audioVolume` > 0) —
useful for skipping expensive sound prep when the player has muted.

---

## 7a. Multiplayer — Arcade.peer (LIVE)

The launcher owns a serverless WebRTC connection (the in-repo `p2p/`
transport, see `p2p/README.md` and `p2p/PROTOCOL.md`).
Players pair through the launcher's **Multiplayer** menu — QR codes and chat
links, no signaling server. Games never touch any of that; the whole surface is:

```js
Arcade.peer.status();              // 'unavailable' | 'idle' | 'connecting' | 'connected' | 'interrupted'
Arcade.peer.onStatus(s => ...);    // gate multiplayer UI on this (your game's ATTACHED PARTY — see below)
Arcade.peer.caps();                // launcher capability flags: feature-detect additive features
                                   // ('peer.sendTo', 'peer.roster', 'peer.meta', 'peer.party',
                                   // 'storage.bridge', 'ui.bridge', 'configs.bridge'); [] standalone
Arcade.peer.send({ move: 'e4' });  // broadcast; JSON-safe payload; false unless connected/interrupted
Arcade.peer.send(hand, { to });    // targeted: only deviceId `to` receives it (cap 'peer.sendTo')
Arcade.peer.onMessage((payload, fromPeer, meta) => ...);  // fromPeer = sender's stable deviceId;
                                   // meta = { relayed, to: 'me'|'all' } (cap 'peer.meta')

Arcade.peer.self();                // { deviceId, name } for THIS device (null before first pairing)
Arcade.peer.peers();               // [{ deviceId, name, status, direct }] — the multi-peer roster
Arcade.peer.onPeersChange(r => ...);  // full roster on any join/leave/rename/status change
Arcade.peer.onReady(({ deviceId }) => ...);  // remote has THIS game mounted & listening

Arcade.peer.sendBlob(file, { onProgress });  // chunked large payloads; Promise (broadcast only)
Arcade.peer.onBlob((blob, { name, size, fromPeer }) => ...);
Arcade.peer.onBlobError(({ id, name, reason, received, total }) => ...);
// reason: 'timeout'   (stalled 60s — e.g. chunks lost to queue overflow),
//         'aborted'   (sender gave up mid-transfer),
//         'integrity' (bytes didn't match the sender's SHA-256),
//         'malformed' (a chunk carried undecodable bytes),
//         'oversize'  (a chunk or the transfer exceeded its byte caps),
//         'too-many'  (too many concurrent inbound transfers; capacity frees
//                      as transfers complete — retry, sendBlob mints a fresh id).
// A failed transfer is dropped whole — never a silently-wrong blob. Ask the
// sender to resend. Transfers are hash-verified end-to-end automatically.

Arcade.peer.queue();               // { depth, limit, overflowed } — replay-queue visibility
Arcade.peer.onQueue(q => ...);     // pushed while 'interrupted'; overflowed ⇒ resync after recovery

// Parties (cap 'peer.party') — a device can hold several concurrent
// connection stars ("parties"); your game is attached to exactly ONE, and
// every peer API above reflects only that party. With a single party the
// launcher auto-attaches — you never need these. All resolve async.
Arcade.peer.party();               // attached party { id, role: 'leader'|'member', leaderName,
                                   //   status, peers } or null. id is session-scoped — never persist it.
Arcade.peer.parties();             // parties this game could attach to (possibly [])
Arcade.peer.attach(partyId);       // request re-attachment → resulting party, or null if refused
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

This is a real, shipped-then-fixed bug class in this fleet — twice: once via a
peer-supplied display name rendered into the DOM, once via a shared config pack.
Treat every off-device string as hostile.

---

## 7c. Determinism & sharing helpers

Four games hand-rolled the same mulberry32 PRNG, two disagreed on when a
"daily" puzzle rolls over, and every shareable-code format was reinvented.
The platform owns all three primitives now — in two forms, because the
consumers live in two worlds:

**The importable companion — `/arcade-rng.js` — is the primary form.** Game
LOGIC (board generation, shuffles, daily derivation) also runs under
`node --test`, where `window.Arcade` does not exist — which is exactly why
the fleet's games never adopted the `Arcade.*` form below. The companion is
a plain ES module with no dependency on the SDK or the DOM. **Vendor a
byte-identical copy next to your modules** (e.g. `js/arcade-rng.js`) and
import it relatively — the only specifier that resolves in both the browser
and node. Same canonical-file rule as `verify-artifact.mjs` (§13a): never
edit the copy; change the launcher-root canonical and re-copy. Pin the
algorithm in your tests with known-answer vectors (`makeRng(42)` →
`0.6011037519201636, 0.44829055899754167, 0.8524657934904099`) so an
accidental local edit fails fast instead of silently forking your seeds.

```js
import { makeRng, hashU32, dailyDateStr, dailySeed,
         shareEncode, shareDecode } from './arcade-rng.js';

const rng = makeRng(seed);          // same generator as Arcade.rng below
const daily = dailySeed('<gameId>', 'bonus');  // gameId is explicit here
```

**The `Arcade.*` form** carries the identical implementations on the SDK
singleton (`tools/sdk-helpers-acceptance.mjs` pins the two to identical
streams and codecs) — fine for browser-only code that never runs under node:

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
// this with toISOString() (that's UTC): two games disagreeing on "today"
// because one used UTC and one used local is the live bug this helper kills.
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

Everything here is purely local — no launcher messages involved.

---

## 7d. Config exchange — `Arcade.configs` (share game configs, packs, variants)

Let players share and load a **named game configuration** — a puzzle pack, a
card-game variant, a level seed — over any channel (a link/code) or
straight to a linked device. The launcher handles transport and consent; your
game defines the config's shape.

```js
// Receive: register a handler per config type. `data` is HOSTILE cross-device
// input — semantic-validate every field and render only via textContent /
// Arcade.html.escape, never innerHTML. (Feature-detect: typeof Arcade.configs.)
Arcade.configs.register('pack', ({ type, v, data }) => {
    if (!isValidPack(data)) return;           // YOUR validation — never trust it
    installPack(data);
});

// Share as a code + deep link (framed: opens the OS share sheet / copies a
// link; standalone: resolves { ok, code } so you can show/copy it yourself).
const { ok, url, code } = await Arcade.configs.share('pack', myPack);

// Or push directly to a linked device (the user picks the peer + the receiver
// is prompted before your handler ever runs).
const { ok, sent } = await Arcade.configs.send('pack', myPack);
```

- **Types** match `^[a-z0-9_-]{1,32}$`. The payload's `data` must serialize to
  ≤ 8 KB (a share code caps at ~4 KB); for anything larger use `Arcade.store` +
  save export.
- **The launcher validates transport shape only** (code charset/size, type,
  that the game id is in the catalog) and always prompts the user before
  delivery. It never interprets `data`. **Security is on you:** treat inbound
  `data` as an attacker's input — the exact stored-XSS class that bit hand-rolled
  "paste this pack" sharing. Validate types/lengths, and escape before render.
- **Delivery timing:** a config can arrive before your `register()` runs (e.g. a
  cold-launch from a link) — the SDK queues a few and drains them on register,
  so registering early at startup is enough.

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
- [ ] **Never touch `window.localStorage` / `indexedDB` / OPFS / `caches` directly in code that runs framed** — in an opaque-origin frame the property access itself throws `SecurityError`. Go through `Arcade.state/store/files`; wrap any unavoidable direct probe in try/catch.
- [ ] ES modules and `fetch()`ed assets load fine framed — GitHub Pages (and the dev servers) send `Access-Control-Allow-Origin: *`, which opaque-origin CORS requests need.

You do **not** need a postMessage storage shim — the SDK IS the shim when
framed.

---

## 10. PWA / service worker hygiene

**The fleet posture: a manifest implies a worker.** A `manifest.json` claims
installability, and an installed app that dies without network is a broken
promise — so any app that ships a manifest also ships a service worker (six
of the seven catalog apps do; the seventh ships neither). Because every game
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
rule below (scope-filtered fetch handler, CI-owned cache version, own-caches-only
cleanup, and the wait-then-be-told-to-activate contract).

- [ ] `manifest.json` `"scope"` and `"start_url"` are scoped to `/<gameId>/`, not `/`.
- [ ] If the game registers a service worker, register it with `{ scope: '/<gameId>/' }` and place `sw.js` inside that path.
- [ ] The service worker only caches assets under `/<gameId>/`. **Never** cache the SDK (`/sdk/v3/arcade-sdk.js` or `/arcade-sdk.js`) or anything else at the launcher root — the SDK inspects the origin's caches at load and reports a `console.error` (plus a visible toast in `?dev=1` mode) when a game cache holds launcher files.
- [ ] The fetch handler must ignore out-of-scope URLs. A controlled page routes **every** request through its SW — including the SDK script — so the guard is mandatory, not optional:

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

  This is not a hypothetical. Four of the five workers on the origin shipped
  the bare `key !== CACHE_NAME` filter, so every deploy of any one of them
  silently wiped every other app's offline support — mutual destruction, with
  nothing logged anywhere. It is also why going cache-first raises the stakes
  rather than lowering them: more offline reliance means more damage each time
  a sibling wipes you.

- [ ] **Let CI own the cache version.** Declare it exactly as
  `const APP_VERSION = '0.0.0';` — start of line, single quotes — and derive
  the cache name from it, then set `version_bump: true` (and `contents: write`)
  in your thin caller workflow. A hand-bumped counter drifts, and when it
  drifts the origin serves a fix that no returning player ever executes: a
  green deploy that reaches nobody. That has happened twice. If the line stops
  matching, CI's `sed` silently stops firing, so assert its *shape* in a test —
  not `APP_VERSION === package.json version`, which false-fails on any PR left
  open across a deploy.

- [ ] **Don't hand-maintain the precache list — generate it.** Give `sw.js` a
  generated region and let `tools/stage.mjs` fill it from the artifact it just
  staged:

  ```js
  // arcade:precache-begin
  const ASSETS = [
    './',
    './index.html',
  ];
  // arcade:precache-end
  ```

  `tools/inject-precache.mjs` (identical fleet-wide) rewrites what is between
  the markers; call it as the last step of `stage()`. What is checked in is a
  placeholder — service workers are off on loopback, so a dev checkout never
  reads it.

  This is what makes a **bundled** app ordinary. A module graph deployed under
  content-hashed names has nothing stable to hand-list, and the old workaround
  — precache the shell, let runtime fill catch the rest — meant a player's
  first visit had to be online. The generator already knows the hashed names,
  because it reads the finished artifact. Keep `sw.js` at the **repo root**
  (CI's version rewrite only touches `./sw.js`) and ship it into the artifact
  root from your build config; nothing else differs.

  To publish a file without caching it, export `PRECACHE_EXCLUDE` from
  `tools/stage.mjs` — exact paths, `dir/` prefixes, or `*.ext` suffixes.
  Diagnostics, provenance archives and licence text are the usual entries.
  `verify-artifact.mjs` fails the build on any published file that is neither
  precached nor named there, so an omission is a decision you write down rather
  than one nobody notices.

- [ ] **Precache with per-asset `add()`, not `addAll()`.** `addAll()` rejects
  the entire install if any single entry 404s, so one missing file costs every
  returning player their whole offline shell — silently. Catch per asset and
  log; a gap should cost one file.

- [ ] **Match the cache with `ignoreSearch`.** The generated list holds
  filenames, which carry no query string. If your markup asks for a file with a
  cache-busting `?v=` suffix, a strict match misses every time and falls
  through to the network — an app that looks fully precached and is entirely
  offline-broken. (Those suffixes are also redundant once CI owns
  `APP_VERSION`: it keys the whole cache per deploy.)

- [ ] **Don't `skipWaiting()` on install.** Let the new worker wait, and handle
  the `arcade:sw.skipWaiting` message instead:

  ```js
  self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'arcade:sw.skipWaiting') self.skipWaiting();
  });
  ```

  The launcher's update control ("Check for Updates", and the automatic
  prompt) enumerates every registration on the origin, offers the player a
  reload, and sends that message once they accept. Your game cannot do this
  for itself — inside a launcher-sandboxed frame the SDK hands you an inert
  `navigator.serviceWorker` stub whose `getRegistrations()` resolves empty and
  whose `ready` never settles, so a per-game update button is dead code
  everywhere but a standalone visit. **Omit the message handler and your
  worker installs and then waits forever**, which is indistinguishable from
  having no update at all.

> The launcher's own service worker lives at `/sw.js` (root scope), caches only launcher-owned files (`index.html`, `arcade-sdk.js`, the `sdk/` pinned copies, `styles.css`, `p2p/`, launcher images), and its fetch handler path-filters to those same trees — requests for `/<gameId>/...` fall through untouched. The launcher SW is also skipped on loopback hosts (`localhost`, `127.x`, `::1`) so local-dev edits to launcher or SDK are never masked by stale cache.

---

## 11. Launcher presence — catalog entry + card art

Everything the launcher and portfolio page show for your game renders from
your `catalog.json` entry (§1) — there are no launcher-side HTML edits and
no per-game files in the launcher repo. The checklist is short:

- [ ] Card art is **your repo's** `/<gameId>/icon.png` — square, ≥ 512×512,
  present in the published output (§1's registration steps).
- [ ] The catalog `subtitle` reads well on a small tile (aim ≤ 20 chars,
  e.g. "Hex Puzzle", "Memorization").
- [ ] Optional `profile` block if the game should appear on the portfolio
  page; entries without one render on the launcher only.

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
./dev.sh ../my-app ../my-other-app      # multiple, served side-by-side
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
[Arcade launcher → my-app] {type: "arcade:welcome", caps: [...], ...}
[Arcade my-app ←]          {type: "arcade:welcome", caps: [...], ...}
[Arcade my-app →]          {type: "arcade:hello", gameId: "my-app"}
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
- [ ] Nothing lands outside the namespace: after first load, every localStorage key the game wrote matches `arcade.v1.<gameId>.*`.
- [ ] Launcher Save → exported JSON contains the game's keys; Launcher Load of that file restores them and the game reflects the restored state (after `onStateReplaced` or page reload).
- [ ] Changing the launcher's font scale visibly resizes text in the game without a reload.
- [ ] Switching to launcher view and back fires `onSuspend` then `onResume`; the game pauses while hidden and resumes cleanly.
- [ ] Setting *Open Games* to `1` in the launcher menu, launching another game, then re-launching this game does a fresh load and restores user-visible progress (high score, current level, etc.) from `arcade.v1.<gameId>.*` localStorage.
- [ ] Any off-device / imported / shared string the game renders (peer names & messages, imported pack/level names, score entries) is escaped via `Arcade.html.escape` / `textContent` — a value like `"><img src=x onerror=alert(1)>` renders inertly.
- [ ] If the game uses `Arcade.store` / `Arcade.files`, a Launcher Save → Load round-trip restores that data too (it rides the schema-v2 bundle).
- [ ] Standalone URL (`https://paulgibeault.github.io/<gameId>/`) still works exactly as before.
- [ ] Service worker (if any) does not intercept requests for the SDK (`/sdk/v3/arcade-sdk.js` / `/arcade-sdk.js`) or other launcher assets (no `[Arcade SDK]` warning in console).
- [ ] `Arcade.peer.caps()` inside the launcher frame reports the full documented capability list (§14) — the caps contract arrived intact.
- [ ] The game keeps working when a cap is absent: gate every capability-backed feature on `Arcade.peer.caps()`, never assume the full list.

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

This checklist covers *your game's* integration. Testing the *platform
itself* (launcher, save/backup/sync engines, P2P) is a separate, larger
surface — see [TESTING.md](TESTING.md) in the launcher repo for the full CI
gate and every local configuration.

---

## 13a. CI/CD — the fleet standard

Every app deploys through one shared pipeline,
[`.github/workflows/fleet-ci.yml`](.github/workflows/fleet-ci.yml) in this
repo: a `test` job gates a `deploy` job, pull requests run the gate but never
deploy, and pushes to `main` deploy to GitHub Pages only after the gate
passes. An app repo carries nothing but this thin caller at
`.github/workflows/pages.yml`:

```yaml
# Thin caller for the fleet CI/CD standard. The pipeline lives in the
# launcher repo (fleet-ci.yml); change it there and every app follows.
name: CI & Deploy Pages

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: write # version_bump pushes the bump commit back to main
  pages: write
  id-token: write

# Per-ref, so a PR run never cancels main's deploy.
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  fleet:
    uses: paulgibeault/paulgibeault.github.io/.github/workflows/fleet-ci.yml@main
    with:
      # The fleet norm for any app with a service worker: CI owns the cache
      # version (§10). Drop this (and relax contents: to read) only for an
      # app with no sw.js.
      version_bump: true
```

This repo calls the same pipeline, with `uses: ./.github/workflows/fleet-ci.yml`
— a workflow in the same repository is referenced by relative path, not by
`owner/repo@ref`. It is the identical pipeline either way.

Requirements every app meets (the pipeline detects them; the repo provides them):

- **Node 24** everywhere; `package.json` declares `"engines": { "node": ">=24" }`.
- **Tests exist, live in `tests/`, and are the gate.** `package.json` has a
  working `test` script — the fleet default is `node --test 'tests/*.test.js'`,
  zero-dep. (Apps that need more run vitest or their own browser-suite
  runner; the requirement is that suites live in `tests/` and gate the
  deploy, not that every app share one framework.)
- **Every app proves its deploy artifact, using the same two files:**
  - `tools/verify-artifact.mjs` — **byte-identical in every repo, no
    exceptions.** Stages into a temp dir and asserts what came out: every
    literal `index.html` reference and every `manifest.json` icon is
    published, every published file is precached unless the app names it in
    `PRECACHE_EXCLUDE`, and dev files are not published. It is a plain script
    rather than a test-framework file because the fleet runs three different
    runners and all of them can call a script. Never edit one copy — change
    the canonical file and re-copy it.
  - `tools/inject-precache.mjs` — **byte-identical in every repo**, called at
    the end of `stage()`. Writes the worker's precache list from the staged
    artifact, so the list cannot drift from what deploys.
  - `tools/stage.mjs` — **the only per-app part**, and the reason one
    verifier fits every repo. It exports `stage(outDir)` and `ROOT`, and
    the deploy job runs exactly this module; nothing re-implements staging
    in workflow YAML. Copying tracked files, invoking a bundler, and
    delegating to a curated file list all satisfy the same contract.

  The one rule that flips by repo — a game must not precache the launcher's
  SDK, while the launcher must — is detected, not configured: the verifier
  checks whether the artifact ships `arcade-sdk.js` itself. That keeps the
  file identical rather than adding a per-repo flag.

  Check the artifact, never the checkout. A repo-level existence check
  cannot catch a staging rule that drops a needed file — every file is
  obviously present in a checkout. This shape was proved out in the fleet
  after a live site shipped with no sound and a service worker whose
  `install()` rejected; three lists have to agree (index.html's tags, the
  precache list, and what the deploy publishes) and none of them check
  each other.

  `tests/repo-gates.test.js` complements it at the source level (every
  tracked JS and JSON file parses) and is the floor an app with no
  game-logic suite still meets.

  There are no exemptions. An app that owns its build points `stage()` at
  that build and runs the same verifier against its output; this repo, which
  is the platform rather than a game, does the same.
- **The deploy artifact is always `dist/`.** An app with a `build` script
  must produce it. Every other app gets the standard staging: tracked files
  minus the dev set — `.github/`, `.claude/`, `tests/`, `test/`, `docs/`,
  `scratch/`, `tools/`, `scripts/`, `node_modules/`, package files,
  `.gitignore`, `go.sh`/`ago`, root `test_*` files, and any `.md`/`.py`/
  `.pid` — so dev files never ship to the public site.
- **The artifact is verified before deploy**: every local `src`/`href` in
  `index.html` must exist in `dist/`, and every file `dist/` publishes must be
  precached or explicitly excluded — or the deploy fails instead of shipping a
  broken install, or one that works online and breaks offline.
- **GitHub Pages source must be "GitHub Actions"** (Settings → Pages), not
  "deploy from branch" — otherwise GitHub's default Jekyll build races this one.

Opt-in inputs for apps that need more (pass under `with:` in the caller):
`launcher: true` checks the launcher out inside the workspace (exported as
`ARCADE_LAUNCHER`) and runs `npm run acceptance` after the app's tests;
`browsers: "chromium webkit"` installs Playwright browsers for the test
tier; `version_bump: true` auto-bumps the patch version on each deploy
(requires `contents: write` in the caller's permissions).

---

## 14. Reference

- Platform design: [ARCADE_PLATFORM.md](ARCADE_PLATFORM.md)
- SDK source: [arcade-sdk.js](arcade-sdk.js)
- Launcher iframe pool & message routing: [index.html](index.html) (search for `PLATFORM CONTROLLER`)

### Wire protocol summary

There is deliberately no protocol version number on the wire. The
launcher↔SDK compatibility contract is `welcome.caps`: the launcher
announces every optional capability it offers, and the SDK degrades
gracefully when a cap is absent. New features add a cap; they never
change the meaning of an existing message.

All messages namespaced `arcade:`. Origin guard: launcher frames are
opaque-origin, so the SDK pins the origin of the first `welcome` from
`window.parent` and requires it on every later message (standalone/
same-origin embeds keep the `origin === window.location.origin` rule). The
launcher only acts on messages from iframes it mounted via the pool, and
requires their origin to be the sandboxed literal `'null'`.

```
child  → parent: arcade:hello              { gameId }
parent → child:  arcade:welcome            { caps, peerStatus, peers, settings, state }
                                           // caps: capability flags (absent ⇒ []); peers
                                           // entries: { deviceId, name, status, direct };
                                           // state: storage-bridge snapshot (own keys +
                                           // global.* + _meta identity/dev, raw strings)
parent → child:  arcade:settings.changed   { settings }
parent → child:  arcade:state.replaced     { state }                // after file import (fresh snapshot)
parent → child:  arcade:lifecycle.suspend  { }                      // iframe hidden, or about to be evicted
parent → child:  arcade:lifecycle.resume   { }                      // iframe shown
parent → child:  arcade:peer.status        { status }               // this game's attached party
parent → child:  arcade:peer.message       { payload, fromPeer, meta }  // fromPeer = sender deviceId;
                                           // meta = { relayed, to: 'me'|'all' }
parent → child:  arcade:peer.roster        { peers }                // attached party's roster on any change
parent → child:  arcade:peer.identity      { deviceId, name }       // single-entry roster update (peer.roster carries the full set)
parent → child:  arcade:peer.ready         { deviceId, name }       // remote same-game listening
parent → child:  arcade:peer.queue         { depth, limit, overflowed }
child  → parent: arcade:peer.send          { payload, to? }         // to = target deviceId (targeted)
child  → parent: arcade:peer.party.op      { op: 'get'|'list'|'attach', id, partyId? }
                                           // cap 'peer.party'; answered via arcade:bridge.result
                                           // (value: party entry | entry list | null)
child  → parent: arcade:ui.toast           { message, kind, duration }

— config exchange (§7d; cap 'configs.bridge'; the SDK speaks this for you) —
child  → parent: arcade:configs.op         { op: 'share', id, code } | { op: 'send', id, t, d }
                                           // RPC; answered via arcade:bridge.result
                                           // (value: { ok, url?, shared? } | { ok, sent })
parent → child:  arcade:config             { t, v, d }               // a config the launcher accepted +
                                                                    // prompted the user about — data is HOSTILE
child  → parent: arcade:config.ack         { t, ok }                 // your handler accepted it (cancels a toast)

— ui chrome bridge (§7; the SDK speaks this for you) —
child  → parent: arcade:ui.op              { op: 'confirm'|'openFile'|'share', id, ... }
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
