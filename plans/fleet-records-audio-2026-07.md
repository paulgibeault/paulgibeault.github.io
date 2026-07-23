# Fleet fan-out — Arcade.records + Arcade.audio adoption (2026-07)

Status: **DONE 2026-07-21 — all seven packages merged; fleet adoption complete.**
G1 moon-lit#25, G2 pi-game#19, G3 si-syn#21 (records surveyed → skipped, no
natural single-best), G4 hecknsic#42, G5 cozy-solitaire#11 (closed #6),
G6 sowduku#9 (closed #3), G7 p2p-chat#7. G8 poker-night skipped entirely
(owner call). Post-merge §4 verification 2026-07-22: acceptance 12/12 on six
games; hecknsic 11/12 — the one failure (check 10, offline SW reload) is a
pre-existing loopback dev bypass in its `sw.js` fetch handler (commit 6aa7709,
2026-04-12), not a regression; prod caching unaffected. Ear pass done: audio
functional but consistently off-theme — **per-game sound-design re-tune is the
open follow-up.** Original plan follows for reference.

Planned 2026-07-20. Framework side was already DONE and live — records shipped
in launcher PR #86 (SDK 3.2.0, shared leaderboards in 3.3.0) and Arcade.audio in
PR #87 (SDK 3.5.0, incl. the global mute button). This plan is the *game-repo*
side: seven (plus one optional) fully independent work packages, one branch/PR
per repo, designed so a separate Claude Sonnet agent can execute each package
concurrently with no cross-package coordination.

**Nothing in this plan touches the launcher repo.** Both features are pure
additive API calls against the launcher-served SDK (`/sdk/v3/arcade-sdk.js`,
already at 3.5.0 on `origin/main`). No catalog entries, no capability flags, no
manifest changes, no SDK edits. A game gets a Records tab in the launcher's
Records sheet automatically the moment it writes its first `records.*` /
`scores.*` key.

---

## 0. Required reading for every implementing agent

Before touching a game repo, read (all paths in the launcher repo,
`~/work/paulgibeault.github.io`):

1. **`GAME_INTEGRATION.md` §4** (scores / records / stats — which of the three
   to use) **and §5** (Arcade.audio bullet — the spec format and migration
   rationale). Skim §2 (SDK load + `Arcade.ready` contract), §6 (lifecycle),
   §10 (SW hygiene), §13 (acceptance checklist).
2. **`sdk/CHANGELOG.md`** entries 3.2.0 → 3.5.0.
3. The per-game package below — it is the scope contract. Line numbers cited
   there are from a 2026-07-20 survey; **re-verify them against the working
   tree before editing**.

### API cheat-sheet (verified against `sdk/v3/arcade-sdk.js` @ 3.5.0)

**Records** (`arcade-sdk.js:2515-2658`; storage key
`arcade.v1.<gameId>.records.<category>`):

```js
Arcade.records.best(category, { value, direction, format?, label?, meta?, ts? })
// → { improved: boolean, record }
Arcade.records.set(category, rec)      // unconditional write (rarely needed — prefer best())
Arcade.records.get(category)           // record | null
Arcade.records.list()                  // { [category]: record }
Arcade.records.clear(category)
```

Semantics that matter:
- `value` must be a finite number; `direction` is **required** (`'higher'` for
  scores, `'lower'` for times/move counts) and is judged under the *stored*
  direction once a category exists — a mismatched later direction warns and is
  ignored. First write to a category must therefore be the full object shape.
- `best()` writes on first-ever value or strict improvement. **Ties do NOT
  write** (first-achievement `ts` is preserved).
- `format` ∈ `'duration-ms' | 'integer' | 'percentage'` — always pass it, plus
  a human `label` (≤64 chars), so the launcher Records sheet renders the value
  with zero per-game code. `meta` > 4 KB JSON is silently dropped (warn).
- Which of the three: **`scores`** = ranked top-N leaderboard with names
  (shared across a player's linked devices automatically — the SDK stamps
  hidden `dev`/`eid` fields; never set or rely on those); **`records`** = ONE
  self-describing best-ever value per category; **`stats`** = mutable
  counters/keyed maps you format yourself. Do not bend `scores` for a single
  best (the old `-timeMs` negation trick) — that's exactly what `records`
  replaces.

**Audio** (`arcade-sdk.js:2851-3009`):

```js
Arcade.audio.cue('blip', { type: 'square', freq: 660, dur: 0.08, gain: 0.3 }); // chainable
Arcade.audio.play('blip');                        // fire-and-forget
Arcade.audio.play('blip', { freq: 880 });          // per-play shallow override
Arcade.audio.play({ type: 'noise', dur: 0.2, gain: 0.15 });                  // inline spec
Arcade.audio.play([{ freq: 523, dur: 0.1 }, { freq: 784, dur: 0.1 }]);       // sequence
Arcade.audio.enabled();                            // WebAudio present AND volume > 0
Arcade.audio.context();                            // managed AudioContext | null (custom graphs only)
```

- spec = `{ type:'sine'|'square'|'sawtooth'|'triangle'|'noise', freq(1..20000,
  ignored for noise), toFreq?, dur(0.001..30 s), gain(0..1 peak), attack?,
  release?, delay?(sequence-only) }`. Sequences: voice *i* starts `delay`
  seconds after the previous voice's *start*, or back-to-back after its
  duration when `delay` is absent; all-`delay:0` = chord. Max 32 voices/play.
- The SDK owns the foot-guns: lazy ctx, first-gesture unlock, master gain wired
  to the launcher `audioVolume` setting (incl. the global mute button),
  `ctx.suspend()`/`resume()` on Arcade suspend/resume, and safe linear-ramp
  envelopes. **A migrating game deletes all of that plumbing** — its own
  AudioContext/webkit fallback, unlock listeners, volume reads
  (`Arcade.settings.audioVolume()` / `--audio-volume`), and
  onSuspend/onResume ctx wiring.
- `play()` when muted is free (short-circuits before ctx creation). There is
  no game-facing volume setter — volume/mute is launcher-owned.
- Sample/file-based audio is out of scope (synth voices only).

---

## 1. Fleet survey snapshot (2026-07-20)

| Game (repo) | Audio today | Best-value tracking today | Package shape |
| --- | --- | --- | --- |
| moon-lit | **none** (designed in `docs/design-concept.md`, never built) | `Arcade.scores` + `Arcade.stats` (heavy) | ADD audio + records |
| pi-game | hand-rolled WebAudio synth (`index.html` ~989-1040) | `Arcade.scores('classic')` | MIGRATE audio + records |
| si-syn | none | none | ADD audio (+ records survey) |
| hecknsic | none | `Arcade.scores` per mode + `Arcade.stats` + dailies | ADD audio + records |
| cozy-solitaire | none | `Arcade.stats` bests (issue cozy-solitaire#6) | ADD audio + records |
| sow-duku (gameId `sowduku`) | hand-rolled synth (`index.html` ~964-1074, off by default) | `Arcade.stats` lifetime blob (issue sowduku#3) | MIGRATE audio + records |
| p2p-chat | none (only `<audio>` media playback — out of scope) | n/a | ADD audio only |
| poker-night (OPTIONAL — not in catalog.json) | hand-rolled synth module `js/audio.js` | none | MIGRATE audio only |

Zero `Arcade.records` / `Arcade.audio` call sites exist anywhere in the fleet —
every package is greenfield. moon-lit and pi-game carry vendored dev copies of
`arcade-sdk.js`; both are already byte-identical to 3.5.0, **no re-sync
needed** (production always loads the launcher-served copy anyway).

---

## 2. Fleet-wide conventions (binding for all packages)

These exist so seven concurrently-written PRs come out consistent.

### Records
- **R1 — Category slugs** are lowercase `[a-z0-9_-]`, short, and *stable
  forever* (they are storage schema): e.g. `best_streak`,
  `best_time_klondike`, `best_time_6x6`. Always pass `direction` + `format` +
  `label` on every `best()` call.
- **R2 — Use `best()`, never `set()`, in gameplay paths** — it is idempotent,
  never regresses, and returns `improved` for free. Use `improved === true` to
  trigger an optional "New personal best!" flourish (an `Arcade.ui.toast(...,
  { kind: 'success' })` and/or a cue) — nice-to-have, not required.
- **R3 — Seed from legacy bests** with a one-shot migration so long-time
  players don't lose history. Pattern (also idempotent thanks to `best()`):

  ```js
  Arcade.state.migrate('records-v1', () => {
      const s = Arcade.stats.get('lifetime');
      if (s && Number.isFinite(s.bestTimeMs)) {
          Arcade.records.best('best_time', {
              value: s.bestTimeMs, direction: 'lower',
              format: 'duration-ms', label: 'Best time',
          });
      }
  });
  ```

  Leave the source stats field in place (stats remain the game-formatted view;
  records are the launcher-formatted view). Migrations run after
  `Arcade.ready` per the game's existing boot flow.
- **R4 — Don't duplicate leaderboards.** Where `Arcade.scores` already holds a
  ranked board (pi-game `classic`, hecknsic modes, moon-lit), keep it — add a
  `records` category *alongside* only for the single-best framing. Keyed
  best-per-thing maps (best per board code / per level) stay in
  `Arcade.stats` / `Arcade.scores.best(cat, key)` — records is one value per
  category, and category-per-key explosion is capped at 50 in the launcher
  sheet.
- **R5 — Feature-detect** with `if (Arcade.records) ...` (or
  `typeof Arcade.records !== 'undefined'`) at the call-site wrapper. Same for
  audio. Both are present on the live launcher SDK, but the guard keeps
  standalone-against-stale-cache and future-proofing free.
- **R6 — Don't cache record values for in-game display** across
  launcher-driven resets/imports: if the game shows a best on screen, re-read
  in the existing `Arcade.onStateReplaced` handler (and on
  `Arcade.state.onChange` if the game already subscribes).

### Audio
- **A1 — One registration site.** Register all cues once at boot, right after
  `Arcade.init` (no `await Arcade.ready` needed — audio is purely local).
  Multi-file games put cues + a tiny wrapper in a dedicated module
  (`js/sfx.js` / `src/audio.js`); single-file games put them in one clearly
  marked block.
- **A2 — Standard wrapper.** All play-sites go through one guard so
  feature-detection and any game-level toggle live in one place:

  ```js
  const sfx = (name, opts) => {
      if (window.Arcade && Arcade.audio && soundOn) Arcade.audio.play(name, opts);
  };
  ```

  (`soundOn` only where the game already has an in-game sound setting — see A3.)
- **A3 — Toggles: keep existing, add none.** The launcher owns volume + global
  mute; games must NOT grow new volume sliders or mute buttons. Games that
  already ship an in-game sound on/off setting (sow-duku — off by default,
  pi-game — mute toggle) keep it as a gate in the wrapper; its stored key and
  default do not change.
- **A4 — Cue naming** is lowercase-kebab and event-shaped (`match`, `chain`,
  `game-over`, `ui-click`), not instrument-shaped.
- **A5 — Conservative sound design.** Implementing agents cannot listen to the
  result. Migrating games (pi-game, sow-duku, poker-night) port their existing
  synth parameters (type/freq/duration/gain) faithfully into cue specs — the
  sound should be recognisably the same. Games gaining audio from scratch use
  short (≤0.25 s), low-gain (≤0.35) cues; sine/triangle for gentle games,
  square/sawtooth for arcade-y ones; sequences for jingles (win/game-over).
  4–8 cues per game is the right size. Flag in the PR description that sound
  aesthetics need a human ear pass.
- **A6 — Delete, don't wrap.** Migration means removing the game's own
  AudioContext creation, webkit fallback, gesture-unlock listeners,
  volume-setting reads, envelope code, and audio-specific
  onSuspend/onResume wiring. The PR diff for a migration should be net
  negative in the audio area. Do not keep a parallel ctx "just in case", and
  do not build custom graphs on `Arcade.audio.context()` — no fleet game
  needs one.
- **A7 — Frequency of fire.** Cues on discrete player-meaningful events only.
  For rapid repeated events (per-digit, per-tile), per-event `play()` is fine
  (voices are cheap), but avoid cues on continuous processes (per-frame,
  per-tick).

### Repo/process
- **P1 — One branch + one PR per repo**, branch name `arcade-records-audio`
  (audio-only packages may use `arcade-audio`). PR description links this plan
  and closes the repo's referenced issues (`Closes #N`).
- **P2 — Release bumps** ship in the same PR: pi-game `sw.js` `CACHE_NAME`,
  hecknsic `sw.js` `APP_VERSION` (+ add any new JS file to `STATIC_ASSETS`),
  sow-duku `sw.js` `CACHE`. Never touch SDK/launcher paths in any game SW.
- **P3 — No scope creep** beyond the package (exception: the two hygiene items
  explicitly listed in G5). No launcher-repo edits from any package.
- **P4 — Tests must pass** where they exist (`npm test`), and si-syn must also
  `npm run build` clean.

---

## 3. Work packages

Each package is self-contained: scope, files, steps, verify. All eight are
mutually independent — run any subset concurrently.

### G1 — moon-lit · ADD audio + records
Repo `~/work/moon-lit`. Heaviest SDK user; module structure (`js/main.js`,
`js/renderer/hud.js`, `js/renderer/menu.js`); `npm test` = `node --test`.

- **Audio (additive — the design already exists):** read the audio section of
  `docs/design-concept.md` and implement it as `js/sfx.js` (cue registrations
  + the A2 wrapper), wired at event sites in `js/main.js`: lantern
  launch, match/clear, chain-drop, trellis advance, dead-line warning,
  game-over, and menu click. Where the design doc names sounds the synth can't
  make (samples), approximate with short synth cues per A5 and note the
  approximation in the PR.
- **Records:** enumerate the game's existing `Arcade.stats` / score writes in
  `js/main.js` and promote each genuine single-best (e.g. best score, best
  chain, highest trellis level survived — whatever the code actually tracks)
  to a `records.best()` call at the moment the value is finalised
  (game-over/win), with R1 naming + R3 seeding from the current stats/scores
  values. Keep the existing `Arcade.scores` leaderboard as-is (R4).
- **Verify:** `npm test`; acceptance run (§4); Records sheet shows moon-lit
  categories with labels/formats; launcher mute silences cues.

### G2 — pi-game · MIGRATE audio + records
Repo `~/work/pi-game`. Single-file game (`index.html`); no tests; `sw.js`
`CACHE_NAME = 'pi-game-v3'`.

- **Audio (migration):** replace the hand-rolled synth (survey: ~lines
  989-1040 — lazy `AudioContext`, `playCorrectSound`/`playWrongSound`, own
  volume handling) with cues `correct` and `wrong` whose specs port the
  existing oscillator parameters (A5). The rising-pitch-per-streak behaviour
  ports as a per-play override: `sfx('correct', { freq: <computed> })`. Keep
  the existing in-game mute toggle as the wrapper gate (A3); delete ctx/
  unlock/volume plumbing (A6) — including the game's own
  `Arcade.settings.audioVolume()` reads for SFX.
- **Records:** at game-over, `Arcade.records.best('best_streak', { value:
  digits, direction: 'higher', format: 'integer', label: 'Best streak' })`.
  Seed via `migrate('records-v1')` from the top entry of the existing
  `Arcade.scores('classic')` board (guard for an empty board). Keep the
  `classic` leaderboard (R4). Optional flourish on `improved` (R2).
- **Release:** bump `sw.js` `CACHE_NAME`.
- **Verify:** acceptance run; manual play — correct/wrong cues sound the same
  by construction (parameters ported); Records sheet shows Best streak.

### G3 — si-syn · ADD audio (+ records survey)
Repo `~/work/si-syn`. Vite project (`src/` → build); `npm test` = `vitest run`.

- **Audio (additive):** new `src/audio.js` module (cues + A2 wrapper), wired
  in `src/main.js` / UI modules: test-pass, test-fail, level-complete, and a
  soft ui-click for board interactions. Circuit-lab aesthetic → square/
  sawtooth blips per A5. No in-game toggle (A3).
- **Records (survey-first, small):** the game currently persists no
  performance metrics. If the code already computes a natural single-best at
  solve time (e.g. fastest solve, fewest cycles for the campaign), add ONE
  `records.best()` category for it; if nothing is computed, **skip records
  entirely** rather than inventing new metric plumbing — note the decision in
  the PR.
- **Verify:** `vitest run` + `npm run build`; acceptance run against the
  built game via `dev.sh`.

### G4 — hecknsic · ADD audio + records
Repo `~/work/hecknsic`. `js/` modules (`js/storage.js`, `js/puzzle-mode.js`);
`npm test` = `node --test`; `sw.js` `APP_VERSION = '1.3.1'`.

- **Audio (additive):** new `js/audio.js` (cues + A2 wrapper): rotate, match,
  combo (pitch stepping up with chain depth via per-play `freq` override),
  special triggers (star/flower/bomb — one cue each or one shared), game-over,
  ui-click. Arcade-y square/saw palette per A5. No in-game toggle (A3).
- **Records:** per-mode best score — `records.best('best_score_<mode>',
  { value, direction: 'higher', format: 'integer', label: 'Best score —
  <Mode>' })` written where each mode's score is finalised (mode list per
  `js/storage.js` / `js/puzzle-mode.js`); plus best daily streak if stats
  already track it. Seed from the existing per-mode `Arcade.scores` boards /
  stats via `migrate('records-v1')`. Keep the scores boards (R4).
- **Release:** bump `APP_VERSION`; add `js/audio.js` to `STATIC_ASSETS`.
- **Verify:** `npm test`; acceptance run; Records sheet shows per-mode bests.

### G5 — cozy-solitaire · ADD records (primary) + gentle audio · closes cozy-solitaire#6
Repo `~/work/cozy-solitaire`. `js/storage.js` wraps the SDK; tests exist but
**no package.json**.

- **Records (this IS cozy-solitaire#6):** from the existing `Arcade.stats`
  bests in `js/storage.js`, write per-variant records at win time: best time
  (`best_time_<variant>`, `'lower'`, `'duration-ms'`), fewest moves
  (`fewest_moves_<variant>`, `'lower'`, `'integer'`), and longest win streak
  (`best_streak_<variant>`, `'higher'`, `'integer'`) — for each of klondike /
  freecell / spider, matching whatever the stats code actually tracks (don't
  invent metrics it doesn't). Seed all categories from current stats via
  `migrate('records-v1')` (R3).
- **Audio (additive, gentle):** `js/sfx.js` with a soft sine/triangle palette
  (A5, gains ≤0.25): card-place, card-flip, invalid-move (very soft), undo,
  win jingle (short ascending sequence). Wire in `js/main.js` /
  `js/renderer.js` event sites. No toggle (A3).
- **Hygiene (explicitly in scope):** add a minimal `package.json` with
  `"test": "node --test tests/*.test.js"` so P4 is checkable.
- **Verify:** `npm test` (now runnable); acceptance run; Records sheet shows
  per-variant cards with `duration-ms` formatting; win → `improved` toast ok.

### G6 — sow-duku · MIGRATE audio + records · closes sowduku#3
Repo `~/work/sow-duku`, **gameId `sowduku`**. Single-file (`index.html` +
`sowdoku.js`); no tests; `sw.js` `CACHE = "sowdoku-shell-v4"`.

- **Audio (migration):** replace the hand-rolled synth (survey: ~lines
  964-1074 — oscillators + noise buffer for "thud, chime, snuffle") with cues
  whose specs port the existing parameters (`type:'noise'` covers the noise
  buffer). **Keep the existing off-by-default in-game sound setting** and its
  SDK-backed storage key exactly as-is, gating the A2 wrapper (A3). Delete
  ctx/unlock/volume plumbing (A6).
- **Records (this IS sowduku#3):** best solve time per board size —
  `records.best('best_time_<N>x<N>', { value: ms, direction: 'lower',
  format: 'duration-ms', label: 'Best time — <N>×<N>' })` at puzzle
  completion, for the sizes the game ships (6×6…9×9). Seed from any existing
  per-size bests in the `stats.lifetime` blob via `migrate('records-v1')`
  (skip seeding if none are stored). Keyed per-board-code bests, if present,
  stay in stats (R4).
- **Release:** bump `sw.js` `CACHE`.
- **Verify:** acceptance run; with the in-game sound setting ON, cues play and
  launcher mute still silences them; Records sheet shows per-size times.

### G7 — p2p-chat · ADD audio only
Repo `~/work/p2p-chat`. `app.js` single module; no tests; no SW. Not a scoring
game — **no records work**.

- **Audio (additive):** cues in `app.js` (A1 block + A2 wrapper):
  message-received (only for messages from peers, never own sends echoing
  back), message-sent (very soft, optional), peer-joined, peer-left,
  transfer-complete, error. Soft, notification-like sine blips (A5).
- **Care:** this repo was the fleet's XSS case study — the change must not add
  any new rendering of untrusted strings (audio-only touchpoints).
- **Verify:** acceptance run; two-device smoke via `dev.sh` + the launcher
  Multiplayer pairing (or standalone dual-tab): received-message blip fires on
  the receiving side only; launcher mute silences.

### G8 — poker-night · MIGRATE audio (OPTIONAL — not in catalog.json)
Repo `~/work/poker-night`. `npm test` = `node --test`. Not launcher-listed, so
it has no Records surface — **audio only**; run this package only if capacity
allows.

- **Audio (migration):** rewrite `js/audio.js` internals as a thin layer over
  `Arcade.audio` — keep the module's public API so call-sites don't change;
  port the chime parameters (A5); delete ctx/unlock/`--audio-volume`/
  suspend-resume plumbing (A6).
- **Dev-stub caveat:** the repo's local `arcade-sdk.js` is a localStorage-
  backed dev stub, not the real SDK — add a no-op `audio` shim to it
  (`cue()`/`play()` no-ops, `enabled: () => false`, `context: () => null`) so
  local dev keeps working; guard via the A2 wrapper regardless.
- **Verify:** `npm test`; game runs standalone with no console errors, cues
  fire against the real SDK (stage via launcher `dev.sh` even though
  unlisted, or a local static serve with the real SDK copied in).

---

## 4. Verification (per package)

1. **Repo tests:** `npm test` where present (G1, G3, G4, G5, G8); G3 also
   `npm run build`.
2. **Acceptance harness** (from the launcher repo):
   ```sh
   ./dev.sh ../<game-repo>
   npm run acceptance -- http://127.0.0.1:4791/<gameId>/
   ```
   Must stay green — these packages must not regress any §13 checklist item.
3. **Manual, in the staged launcher:**
   - Cues fire at the wired events; launcher menu **mute silences instantly**
     and unmute restores; switching to the launcher (suspend) stops audio.
   - Launcher menu → **Records**: the game's tab shows every new category with
     the intended label and formatted value; per-game reset clears them; a
     Save export → import round-trips them.
   - Beat a best → `improved` path fires (toast/cue where implemented); tie a
     best → no write (by design).
   - Standalone URL still works: first user gesture unlocks audio, no console
     errors, records still write.
4. **Human ear pass** (plan owner, post-merge or on the PR preview): sound
   aesthetics per game — agents cannot evaluate this (A5).

---

## 5. Orchestration — running the fan-out with Sonnet agents

- **Concurrency:** all packages are independent (different repos, zero shared
  files). Launch one agent per package, all at once. Suggested priority if
  staggering: G2/G6 (migrations — delete-heavy, port-faithful, lowest design
  risk) → G5/G4/G1 (records value is highest) → G3/G7 → G8 (optional).
- **Per-agent prompt must contain:** (a) the single package section verbatim,
  (b) §0 required-reading paths + the §0 API cheat-sheet, (c) §2 conventions
  verbatim, (d) §4 verification steps, (e) the instruction that survey line
  numbers are approximate and must be re-verified, and (f) P1 branch/PR
  conventions. Nothing about other packages.
- **Agent ground rules:** work only inside the assigned game repo; never edit
  the launcher repo; if the package's assumptions don't match the code (e.g. a
  stats field the plan names doesn't exist), implement against reality,
  following R4/G3's "don't invent metrics" principle, and record the deviation
  in the PR description.
- **Review gate:** each PR gets the §4 acceptance run + human ear pass before
  merge. Merges are independent — no ordering constraints, no launcher release
  train (games pick up nothing; they already run SDK 3.5.0).
- **Close-out:** merging G5 closes cozy-solitaire#6; merging G6 closes
  sowduku#3. When all of G1–G7 are merged, note fleet adoption complete in
  `plans/framework-evolution.md` Workstream D and this file's Status line.

## Out of scope

- Launcher/SDK changes of any kind (both features shipped; launcher
  release-versioning remains its own pending track).
- Background music, sample/file-based audio, custom `Arcade.audio.context()`
  node graphs.
- New leaderboard/scores work beyond what exists (shared leaderboards already
  work fleet-wide with zero game code).
- card-game (Cardstock — no SDK integration yet; separate E0–E3 track),
  pop-em (empty), and non-fleet repos.
