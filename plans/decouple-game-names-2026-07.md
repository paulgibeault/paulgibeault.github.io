# One-way dependency: games → framework, never back

> **Status (2026-07-28).** Phases 1, 2, 4 and most of 5–6 are **implemented** on
> `framework/decouple-fleet` (launcher) and `audio/soundpack-toolkit` (the four
> apps with packs). Gate C passes: zero catalog ids outside `catalog.json`.
> What remains is listed under **Not yet done** at the foot of this document —
> all of it either needs a human ear pass or a coordinated deploy, and none of
> it is mechanical.

**Goal.** This repo becomes a *generic arcade framework*: an SDK, a launcher,
and a toolbox of independent, game-agnostic tools that any game can pick and
choose from. Dependency flows in exactly one direction — a game may know about
the framework; the framework knows about **no game**. Not in code, not in
tooling defaults, not in test fixtures, not in shipped assets, and not in docs.

## Principles (the test every change is measured against)

1. **One registry, and it is data.** `catalog.json` is the single place a game's
   identity may appear in this repo. It is configuration the *launcher product*
   renders, not code. Everything else — SDK, tools, tests, docs — must work
   identically if the catalog were empty or listed a hundred unknown games.
2. **Games own their assets and their test material.** Icons, sound packs,
   audition timelines, tuning configs, design archives: if it describes one
   game, it lives in that game's repo. The framework may *consume* it through a
   declared interface; it may never *contain* it.
3. **Tools are libraries with contracts, not scripts with defaults.** A
   framework tool takes its inputs explicitly (flags, config file supplied by
   the caller, a well-known runtime global). A default that names a game is a
   reverse dependency wearing a convenience costume.
4. **No game-specific compatibility code.** If a game needs a shim, the shim is
   an adapter in the game. Framework code paths that exist "because game X does
   Y" are debt with a removal date, not features.
5. **Docs describe behaviors, not games.** An incident is documented as the
   failure mode it exposed ("a game's service worker cached the SDK and pinned
   every player to a stale version"), with the named specifics living in that
   game's issue tracker — linked, not inlined. The lesson stays; the coupling
   goes.
6. **Enforced, not remembered.** A repo gate fails CI on any catalog-game
   reference outside the sanctioned surface. Without the gate this plan is a
   one-time cleaning, not a property of the codebase.
7. **Generalize, don't shim.** When one game needs something the framework
   doesn't provide, the answer is a *generic capability* any game could use —
   never a game-shaped patch on either side. `Arcade.state.adopt()` is the
   model: hecknsic needed legacy-key migration, and the framework grew a
   migration primitive, not a hecknsic branch. The anti-model is the `ls-proxy`
   handler (a one-game protocol burned into the launcher) and moon-lit's
   dual-path audio fallback (a game contorting around an engine limitation —
   the SDK merging per-play overrides onto single-spec cues but not arrays —
   instead of the engine growing parameterized cues, which graph cues now are).
   Every legacy item retired below gets this test: if the *need* is real,
   meet it generically; then delete the shim on both sides.
8. **Closed fleet — no unknown consumers.** The seven catalog games are the
   *entire* dependency on this framework. There is no third-party game, no
   pinned straggler, no self-hosted deployment we owe compatibility to
   (`SELF_HOSTING.md` gets a line making this explicit: self-hosters vendor a
   copy at their own risk; the living framework tracks only the fleet). The
   consequences run through every phase: compatibility windows exist **only to
   sequence the fleet's own migration**, measured in PRs merged, not releases
   aged. Once the last fleet consumer of a legacy path is migrated and
   verified, the path is deleted the same week — nothing is "frozen forever",
   nothing is deprecated-but-supported, and the shipped code contains exactly
   one way to do each thing: the current one.

---

## Inventory of violations

Grep (repo root, excluding `node_modules/`, `.git/`, `.dev-stage/`):

```bash
grep -rniE 'moon-lit|moonlit|pi-game|si-syn|hecknsic|cozy-solitaire|sow-duku|sowduku|sowdoku|p2p-chat' \
  --include='*.js' --include='*.mjs' --include='*.json' --include='*.sh' \
  --include='*.html' --include='*.css' --include='*.md' .
```

### A. Code and tooling (hard reverse dependencies)

| Location | Violation |
| --- | --- |
| `tools/soundpack/auditions/*.js` (6 files) | Per-game audition timelines living in the framework, each bound to a bespoke per-game global (`global.SowDukuPack`, `global.MoonLitPack`, …) and that game's private cue vocabulary. |
| [`render.mjs:52`](../tools/soundpack/render.mjs), [`analyze.mjs:19`](../tools/soundpack/analyze.mjs) | `packName` defaults to the literal `'moon-lit'`. |
| [`render.mjs:65`](../tools/soundpack/render.mjs) | Guesses the pack source at `../../../<packName>/js/soundpack.js` — encodes a sibling-checkout naming convention *and* a per-game file layout, already wrong for three of seven games. |
| [`render.mjs:66`](../tools/soundpack/render.mjs) | Assumes the framework repo is the home of per-game audition files. |
| `arcade-storage-bridge.js` / `arcade-storage-core.js` / `index.html:1819` — the `ls-proxy` protocol | **Framework code that exists for one game.** The launcher answers a pre-SDK postMessage-localStorage protocol solely so hecknsic doesn't hang. ISSUES.md already tracks retirement ("blocked on hecknsic's `.ls.*` migration", hecknsic [#38](https://github.com/paulgibeault/hecknsic/issues/38) ↔ framework [#17](https://github.com/paulgibeault/paulgibeault.github.io/issues/17) B11). This plan adopts that retirement as a hard deliverable. |
| [`configs-p2p-acceptance.mjs:82–99`](../tools/configs-p2p-acceptance.mjs) | Serves the **production** `catalog.json` and asserts against `'pi-game'` / `'moon-lit'`; `validateConfigPayload` rejects ids not in the catalog, so a framework test breaks when a *game* leaves the fleet. A reverse dependency with a fuse on it. |
| [`configs-unit.mjs:31–76`](../tools/configs-unit.mjs), [`records-unit.mjs:111–123`](../tools/records-unit.mjs), [`leaderboard-acceptance.mjs:94`](../tools/leaderboard-acceptance.mjs), [`acceptance.mjs:6,12,77`](../tools/acceptance.mjs) | Real game ids used as test strings and usage examples. The repo already has the right pattern (`tools/fixtures/*-catalog.json` with `store-test` / `config-test` / `p2p-test-game`); these files predate it. |

### B. Game data and assets parked in the framework repo

| Location | Violation |
| --- | --- |
| `soundpacks/chiptune/*.mjs` (7 files + README) | Frozen per-game sound-design archives. The README itself says nothing loads them. Pure game data. |
| `soundpack-audition/moon-lit-v1.wav` + `.INDEX.md` | 27 MB per-game build artifact committed at repo root, outside the gitignored `tools/soundpack/out/`. |
| `images/{moon-lit,pi-game,si-syn,hecknsic,cozy-solitaire,sowduku,p2p-chat,…}.png` | Game icons shipped from the framework's tree. The catalog *pointing* at an icon is fine; the framework *hosting* it is a per-game asset obligation. |
| `plans/{moon-lit,pi-game,si-syn,hecknsic,cozy-solitaire,sowduku,p2p-chat}.md` | Per-game remediation plans in the framework repo. Each is addressed to a different repo's maintainer. |
| `ISSUES.md` per-game rows | Cross-repo tracking table living here. |

### C. Docs and prose

| Location | Violation |
| --- | --- |
| `GAME_INTEGRATION.md`, `ARCADE_PLATFORM.md` | Game names in two roles: (a) synthetic examples (`gameId: 'hecknsic'`, `arcade.v1.pi-game.highScore`) — trivially genericizable; (b) incident citations (sowduku stored-XSS, hecknsic ls-proxy, sowduku/hecknsic timezone split at `GAME_INTEGRATION.md:805`) — rewrite behaviorally per Principle 5. |
| Framework source comments citing games as rationale (`arcade-storage-bridge.js:43`, `arcade-storage-core.js:60`, `arcade-audio.js` header, `wavdiff.mjs:35`, `audio-graph-acceptance.mjs:210`, `arcade-configs.js:3`, `arcade-sdk.js:31,671`, `arcade-catalog.js:14`) | Same treatment: state the *property* the code defends and link the issue that proved it matters. |
| [`index.html:28`](../index.html) meta description, `README.md:9` | Product copy listing five games by name — silently drifts as the catalog changes. |
| `dev.sh` usage examples (`../si-syn`, `../sow-duku-checkout:sowduku`) | Cosmetic; the *mechanism* is already generic. |

**Not violations:** `catalog.json` (the sanctioned registry, per Principle 1);
`.claude/settings.local.json` (personal, local); `arcade-audio.js:1032`
"cardstock" (a paper metaphor, false positive).

---

## The plan

### Phase 1 — the pack contract: one well-known handle

The per-game globals exist because there is no declared way to say "the sound
pack this page just loaded." Add one to the elements library every pack already
uses:

```js
// arcade-audio.js, alongside global.ArcadeAudioElements
ArcadeAudioElements.registerPack = function (pack) {
  global.ArcadeSoundPack = pack;   // { name, ROOM, SENDS, CUES }
  return pack;
};
```

Game-side, `js/soundpack.js` ends with `S.registerPack({ name, ROOM, SENDS,
CUES })`. The bespoke global (`SowDukuPack` etc.) stays only as long as the
game's own `audio.js` reads it — each game migrates both ends in its own PR, so
no transitional alias needs to live in the framework.

- [ ] `registerPack` in `arcade-audio.js` + `sdk/v3/arcade-audio.js`; bump `sw.js` cache
- [ ] Contract documented in `ARCADE_PLATFORM.md` (audio section) and `GAME_INTEGRATION.md` §5
- [ ] Per game: register via the contract, migrate internal readers, delete the bespoke global

### Phase 2 — the audition toolkit becomes a generic, game-driven tool

The framework keeps what is genuinely reusable — the renderer engine, the
analyzer, the differ, and a library of audition *archetypes* — and loses every
default, path guess, and timeline. **A game configures and renders its own
auditions from its own repo.** The framework never knows which games have sound.

**Toolkit (framework-owned, game-agnostic):**

- `tools/soundpack/render.mjs` — takes `--config <path>` (required, no
  default). All file paths in the config resolve relative to the config file,
  i.e. relative to the *game repo*. Injects the shipped `arcade-audio.js` (its
  one legitimate internal reference — that's the framework's own file) and the
  game-supplied pack + audition sources; consumes `global.ArcadeSoundPack` and
  the audition's `global.PACK`. Errors with usage when invoked bare.
- `tools/soundpack/analyze.mjs`, `wavdiff.mjs` — same treatment: explicit
  inputs, no `'moon-lit'` fallback, no assumption about where output lives.
- `tools/soundpack/lib/audition.js` — **new.** The six existing audition files
  are ~70% the same five archetypes; extract them so game-side files declare
  only what is actually theirs:
  - `everyCueDryWet(pack)` — "each cue dry, then in the room" (already derived
    from `Object.keys(CUES)` today)
  - `repeat(cue, n, spacing)` — fatigue/level-wander sections
  - `contrastPairs(pairs)` — "the grammar — pairs that must not blur"
  - `scene(label, dur, build)` — bespoke real-density scenes
  - `buildAudition({ pack, gap, tail, sections })` — emits the `global.PACK`
    trailer that is byte-identical across all six files today
- `tools/fixtures/soundpack-test/` — **new.** A minimal synthetic pack + audition
  + config so the toolkit self-tests on a bare checkout with zero game repos
  present. This is the only pack the framework repo contains.

**Game-side (each game repo):**

```
audio/soundpack.js            # the pack (already exists in some form)
audio/auditions/full.js       # timeline, built on the framework archetypes
audio/auditions/short.js      # the listening cut
soundpack.config.json         # { pack, auditions: {…}, outDir, sampleRate? }
package.json                  #   "audition": "node ../paulgibeault.github.io/tools/soundpack/render.mjs --config soundpack.config.json --audition short"
```

The game names the framework's location (a sibling checkout, exactly how
`dev.sh` is already consumed); the framework names nothing. Playwright stays a
framework devDependency — the game invokes the tool where it lives and needs no
audio tooling deps of its own. Render output lands in the *game's* gitignored
out-dir, ending the framework-side artifact problem at the source.

- [ ] Strip defaults from `render.mjs` / `analyze.mjs`; add `--config` resolution
- [ ] Extract `lib/audition.js` archetypes
- [ ] Build `tools/fixtures/soundpack-test/` and wire it into `run-units.mjs`
- [ ] Port `sow-duku` first (smallest surface, most recent ear pass); verify with
      `wavdiff.mjs` against a pre-move render — within run-to-run noise floor
- [ ] Port the remaining games; delete `tools/soundpack/auditions/`
- [ ] Rewrite `tools/soundpack/README.md` — already stale (documents `packs/`
      and `lib/graph.js`, neither exists); document the config contract and the
      archetype library instead

### Phase 3 — legacy retirement, framework and fleet

Everything here is code kept alive "for now" that has a successor already
shipped. Each item gets the Principle-7 test (is there a real need? meet it
generically), a migration step, and a deletion step. Under Principle 8 the
deletion step is never "after a support window" — it is "after the fleet PRs
merge and acceptance passes." The only compat that survives even briefly is
for **player data at rest** (saves, backups, leaderboard entries on devices we
don't control); code-to-code compat between fleet components needs no window
at all, because both ends of every seam ship from these same repos.

#### 3a. Retire the chiptune audio engine — the flagship retirement

**Current state.** The SDK carries two sound engines. The spec-cue engine
(`Arcade.audio.cue()` / `play(spec)`: one oscillator or noise burst into a
linear gain envelope) is the chiptune path that the July sound-design review
concluded cannot be tuned out of sounding synthetic — the graph-cue engine
(`Arcade.audio.graph()` + `arcade-audio.js` elements, one shared convolution
room) is its shipped successor, and `play()` already resolves graph cues before
spec cues by name precisely so games could migrate call-site-free. Fleet
status:

| Game | Sound path today |
| --- | --- |
| moon-lit, hecknsic, cozy-solitaire, sow-duku | Graph pack shipped — **but at least moon-lit still carries the archived chiptune profile as an in-game dual-path fallback** (`js/sfx.js` `graphMode` gate); audit the other three for the same pattern |
| pi-game (`index.html`), si-syn (`src/audio.js`), p2p-chat (`app.js`) | Spec cues only — the chiptune engine is their entire sound |

**Game side — finish the migration (one PR per game):**

- [ ] pi-game, si-syn, p2p-chat: design a graph pack each, developed with the
      Phase-2 game-side audition workflow (pack + audition + config in the game
      repo; render, listen, iterate — the same ear-pass loop that shipped
      sow-duku v5). The chiptune archive files (which Phase 5 moves into these
      repos) are the design record of what each sound *meant*; the design-intent
      comments are the input, not the synthesis method.
- [ ] moon-lit, hecknsic, cozy-solitaire, sow-duku: delete the in-game chiptune
      fallback path where present (moon-lit's `graphMode` split and inline
      archived profile; audit the rest). The fallback's only remaining job —
      sound when `arcade-audio.js` fails to load — is better served by the SDK's
      existing graceful silence than by shipping a second, rejected sound
      design in every game forever.
- [ ] The "selectable retro profile" idea the chiptune archive was saved for
      survives this: if it ever happens, it is a *graph pack that sounds like
      chiptune* (square-wave elements through the shared room), selected by a
      generic profile mechanism — not a reason to keep the spec engine.

**Framework side — remove the engine (SDK major v4, then prune the past):**

- [ ] Once no fleet game registers a spec cue: new major per the CHANGELOG
      procedure — `sdk/v4/` with `cue()` / spec-form `play()` removed, `play()`
      keeps its signature for graph cues (name + params). Delete the spec-voice
      scheduler (`scheduleVoice`, `resolveCue`, `getNoiseBuffer`,
      `AUDIO_SEQ_CAP`) from the v4 line. Evergreen alias moves to v4.
- [ ] Move all seven games to `/sdk/v4/` in the same PR train; run the
      acceptance suite against each.
- [ ] **Then delete `sdk/v3/` entirely.** Per Principle 8 there is no pinned
      unknown to keep serving. The major-pin URL scheme itself stays — it is
      the generic mechanism that lets a breaking SDK land before the fleet
      moves (games on the same origin fetch the SDK live, so without pinning a
      breaking deploy is instantly fleet-wide) — but it holds **only the
      current major**. `sdk/CHANGELOG.md` and `tools/sdk-version-unit.mjs`
      update to gate that shape: exactly one `sdk/v<N>/`, matching `SDK_SEMVER`.
- [ ] `GAME_INTEGRATION.md` audio section teaches graph packs only; the spec
      engine survives solely in the changelog and git history.

#### 3b. Retire the `ls-proxy` protocol

- [ ] Sequence: hecknsic finishes its `.ls.*` → `Arcade.state` migration
      ([#38](https://github.com/paulgibeault/hecknsic/issues/38), already
      scoped); the moment that merges and hecknsic's acceptance passes, delete
      the handler from `arcade-storage-bridge.js` / `arcade-storage-core.js` /
      `index.html` and the protocol note from `ARCADE_PLATFORM.md` — no grace
      period; hecknsic was the protocol's only speaker. Per Principle 7 the
      generic replacement already exists (`Arcade.state` + `adopt()`), so
      nothing moves anywhere — the protocol simply ends on both sides.

#### 3c. Sweep the remaining compat windows

Each of these is generic (no game named), but all are "temporarily forever"
paths whose retirement was never scheduled. Under Principle 8 they split into
two kinds. **Code-to-code compat** (both ends are fleet code): delete as soon
as the fleet-side PR merges — there is no other end. **Player-data compat**
(old bytes on devices and peers we don't control): one active-migration
release that rewrites data forward on contact, then delete the read path —
never an open-ended dual-format reader.

| Legacy path | Kind | Retirement |
| --- | --- | --- |
| `dev.sh` staging rewrite of hard-coded absolute SDK URLs ("older games may still hard-code") | code↔code | Grep all seven repos; fix any straggler to root-relative in its Phase-1 PR; delete the per-game sed **now** |
| `arcade-p2p.js` "hand-rolled legacy links" / party-less fallbacks; `arcade-envelope.js` + `arcade-configs-core.js` legacy-launcher framing accommodations | code↔code | Both ends of every P2P link are fleet code served from this origin — there is no "legacy launcher" to meet. Collapse to a **single wire generation**: delete the fall-throughs and party-less branches once the fleet is on current SDK (`welcome.caps` still negotiates *features*; it stops negotiating *eras*) |
| `arcade-backup.js` legacy plaintext `{json}` generation read path | player data | One release in which backup writes re-seal every generation they touch; then delete the plaintext read branch. A plaintext backup older than that cycle is unreadable by design — acceptable for this fleet, and the diag note already flags it |
| `arcade-leaderboard-core.js` legacy-entry content fingerprint (`'legacy:' + fnv1a32(…)`) | player data | Don't carry it: accept the one-time loss/collapse of unattributed pre-SDK entries and delete the fallback branch in the same PR that documents it. A personal fleet's old leaderboard rows are not worth a permanent second identity scheme |
| Per-game migration snippets in games (`readLegacy('hecknsic_*')`, `adopt()` calls, `migrateOnce` bodies) | player data | Each repo deletes its migration block in its Phase-3a PR. Any player who has opened the game since the SDK adoption is migrated; one who hasn't starts fresh — the owner's accepted cost. `GAME_INTEGRATION.md`'s worked example genericizes per Phase 6 |

- [ ] Audit for game-shaped branching the grep can't see:
      `grep -n "gameId ===" arcade-*.js index.html` and review hits.
- [ ] Record each retirement (what, when, criterion met) in `sdk/CHANGELOG.md`
      so the history lives one place.

### Phase 4 — tests run on fixtures, and a gate keeps it that way

- [ ] `configs-p2p-acceptance.mjs` — serve `tools/fixtures/config-catalog.json`
      (extended to two entries: `config-test`, `config-test-b`) instead of the
      production catalog. Fixes the latent break, not just the naming.
- [ ] `configs-unit.mjs` — `moon-lit`/`sowduku` → `game-a`/`game-b`
- [ ] `records-unit.mjs` — `pi-game`/`pi-game-2` → `game-a`/`game-a-2`
      (the prefix-trap shape is the test; preserve it exactly)
- [ ] `leaderboard-acceptance.mjs` — `GAME = 'test-game'`
- [ ] `acceptance.mjs` — usage text and error message to `/<gameId>/` / `my-app`
- [ ] **Repo gate** in `tools/repo-gates-unit.mjs`: read the ids out of
      `catalog.json`, grep the tree for them, fail on any hit outside the
      allowlist. Allowlist: `catalog.json` itself. Nothing else — not `tools/`,
      not docs, not `index.html`. The gate reading ids from the catalog means a
      newly added game is guarded automatically, and a *removed* game's
      lingering references stop being findable — so run the gate against the
      union of current ids and a small tombstone list of past ids for one
      release after any removal.

### Phase 5 — evict game data and assets

- [ ] `soundpack-audition/` — delete (regenerable; 27 MB at repo root). History
      rewrite not worth it; add the path to `.gitignore` so it can't return.
- [ ] `soundpacks/chiptune/<game>.mjs` — each file moves to its game's repo
      (e.g. `<repo>/audio/chiptune-archive.mjs`), provenance headers intact.
      For pi-game, si-syn and p2p-chat this move is also the design input to
      their Phase-3a graph packs — the intent comments describe what each sound
      means; the new pack re-expresses that in the new engine. The README's
      fleet-wide narrative (why the retune was rejected, the engine-ceiling
      diagnosis) is *framework* history — fold it into
      `plans/soundpack-2026-07.md` where that story already lives, then delete
      the directory.
- [ ] `images/<game>.png` — icons move to their game repos; each catalog entry's
      `icon` becomes `/<gameId>/icon.png` (the starter template already ships
      an `icon.svg`, so the convention exists). `sw.js` already precaches icons
      *from the catalog*, so it needs no change. `images/` retains only the
      launcher's own iconography.
- [ ] `plans/<game>.md` — move each into its game's repo (they are that repo's
      work plans; the GitHub issues already anchor them). `plans/README.md`
      keeps the fleet-review narrative with links out. Fleet-wide plans
      (`framework-*.md`, `soundpack-2026-07.md`, `multi-party-2026-07.md`, …)
      stay — they are about the framework.
- [ ] `ISSUES.md` — per-game rows become links to the game repos' issue
      trackers; the file keeps only framework-repo issues and the cross-repo
      dependency notes (which are legitimately about the *seams*).

### Phase 6 — docs say what the framework guarantees, not who tripped on it

Apply Principle 5 as a single editing pass over `GAME_INTEGRATION.md`,
`ARCADE_PLATFORM.md`, `README.md`, `dev.sh`, and framework source comments:

- [ ] Synthetic examples → the starter vocabulary: `my-app`, `starter-app`,
      `arcade.v1.my-app.highScore`, `./dev.sh ../my-app`,
      `./dev.sh ../my-app-checkout:my-app`
- [ ] Incident citations → behavioral form plus an issue link. Pattern:
      *"a game shipped a service worker that cached the SDK, pinning players to
      a stale version ([hecknsic#38](https://github.com/paulgibeault/hecknsic/issues/38))"*
      becomes the failure-mode sentence with the link carrying the specifics.
      The comment teaches the invariant; the tracker holds the history. Applies
      to: the ls-proxy comments (which Phase 3 deletes wholesale), the
      stored-XSS citations at `GAME_INTEGRATION.md:648` / `ARCADE_PLATFORM.md:549`,
      the timezone note at `GAME_INTEGRATION.md:805`, the moon-lit bed note in
      `audio-graph-acceptance.mjs:210`, and the SDK/config comment examples.
- [ ] `index.html:28` meta description and `README.md:9` lineup — either
      generate from `catalog.json` (a `dev.sh`-adjacent stamp step) or reword to
      not enumerate games ("browser games — no installs, no signups"). Recommend
      the reword: one less build step, and the launcher grid *is* the lineup.

---

## Definition of done

```bash
node tools/run-units.mjs          # includes the repo gate: zero catalog-id hits outside catalog.json
node tools/soundpack/render.mjs   # errors with usage — no game default to fall back to
```

- A game can be added to the fleet by: shipping the SDK contract, hosting its
  own icon, adding **one entry to `catalog.json`**. No other framework file
  changes.
- A game can be *removed* by deleting that entry. Framework tests still pass;
  no tool, fixture, doc, or asset needs touching.
- A game can adopt the audition toolkit with zero framework-side changes, by
  writing its own `soundpack.config.json` against the documented contract.
- The SDK v4 line has **one** sound engine; `grep -c "audio.cue" <each game>`
  is zero fleet-wide; no game ships a chiptune fallback path.
- `sdk/` contains exactly one major directory — the current one — and
  `sdk-version-unit.mjs` enforces it. No frozen lines, no evergreen-vs-pinned
  skew.
- `grep -cniE 'legacy|deprecat' arcade-*.js` trends to zero: the only
  permissible hits are an active player-data migration inside its one-release
  window, named as such in `sdk/CHANGELOG.md` with its deletion PR already
  scoped.
- Every seam in the shipped code has exactly one implementation — the current
  one. A new capability replaces its predecessor in the same PR train that
  migrates the fleet; the two never coexist past it.

## Sequencing

Phase 4's gate goes **first** (with the current games tombstoned into its
allowlist, shrinking as phases land) so progress is monotonic. Then 1 → 2 as one
framework PR plus per-game PRs. Phase 3a rides on Phase 2: the three new graph
packs are designed with the game-side audition workflow, so the toolkit move
must land before the sound design starts (and those three packs are the
toolkit's first real proof on a game with no framework-side history). 3b fires
the moment hecknsic's migration merges. 3c code↔code items delete immediately;
its two player-data items get one active-migration release each, scheduled,
not open-ended. The SDK v4 major is cut after 3a's game-side work is fully
merged, the fleet moves to v4 in one train, and `sdk/v3/` is deleted behind
it — the *last* step of the audio retirement, not a forcing function. 5 and 6
in any order. Each per-game move is one small PR in that repo — `git mv` the
audition/archive/icon in, wire the config, delete the framework copy in the
paired framework PR.

Expected per-game PR train (kept small deliberately): ① adopt `registerPack` +
config + audition move (Phases 1–2), ② new/cleaned graph pack + delete chiptune
fallback (Phase 3a), ③ take ownership of icon + archive + plan doc (Phase 5).

---

## Not yet done — and why

Everything mechanical is merged. What is left needs either a human ear or a
coordinated deploy, so it cannot be finished by the migration itself.

### Blocked on an ear pass

**Graph packs for the three spec-cue apps** (Phase 3a, game side). `pi-game`,
`si-syn` and `p2p-chat` still register spec cues; each needs a pack designed,
rendered, listened to, and iterated — 2–3 rounds each, per the workflow in
`plans/soundpack-2026-07.md`. Their chiptune archives now sit in their own
repos as the design record to work from. The toolkit is ready: write a
`soundpack.config.json`, a pack, an audition, and render.

**Deleting the in-app chiptune fallbacks.** At least `moon-lit`'s `js/sfx.js`
carries the archived profile behind a `graphMode` gate. Removing it changes what
plays when `arcade-audio.js` fails to load (from a second sound design to
silence) — a product call, and worth confirming by ear that nothing else keys
off that path.

**SDK v4 / deleting the spec engine** (Phase 3a, framework side). Strictly
downstream of the above: six of the seven apps load the **evergreen**
`/arcade-sdk.js`, not a pinned major, so removing `cue()` from the evergreen
alias would break the three spec-cue apps the moment it deploys. Sequence is
therefore fixed — all seven apps graph-only first, *then* cut v4 and delete
`sdk/v3/`. (This corrects the plan's earlier assumption that the fleet would be
moved onto a pinned v4 URL; only one app pins today.)

### Blocked on another repo's migration

**Retiring `ls-proxy`** (Phase 3b). One app still speaks the protocol. Its
`.ls.*` → `Arcade.state` migration merges first; the handler is then deleted the
same week. Framework-side comments are already rewritten to describe the
behavior and flag the scheduled removal rather than name the app.

### Blocked on a coordinated deploy

**Icon hosting** (Phase 5). Each app repo now carries `icon.png`, but
`catalog.json` still points at this repo's `images/`. Flipping to
`/<gameId>/icon.png` breaks the launcher grid until every app has deployed, so
it needs one coordinated release. Tracked in ISSUES.md.

### Deliberately not done

**Phase 3c player-data items.** The backup plaintext read path and the
leaderboard legacy fingerprint both discard real player data when removed (old
backups become unreadable; unattributed pre-SDK leaderboard rows collapse). The
plan calls both acceptable for a closed personal fleet, but that is the owner's
call to make explicitly, not a migration's to take. The code↔code items in the
same table (the `dev.sh` per-app URL rewrite) **were** removable and are gone —
all seven apps were verified root-relative first.

## What landed

| Area | Change |
| --- | --- |
| Pack contract | `ArcadeAudioElements.registerPack()` → `window.ArcadeSoundPack` (SDK 3.11.0). All four apps with packs migrated; bespoke `<App>Pack` globals deleted on both sides. |
| Audition toolkit | New `tools/soundpack/lib/audition.js` (archetypes: `everyCueDryWet`, `repeat`, `together`, `contrastPairs`, `scene`, `custom`, `publish` with cue-name validation). `render.mjs` takes `--config` and has no defaults; `analyze.mjs` takes an explicit manifest path. Both exit 2 with usage when bare. |
| Auditions | All six moved into their apps as `audio/audition*.js` with a `soundpack.config.json`. Verified audio-identical: `wavdiff` against a pre-migration render of the same audition on the same element library reports ≤ 2 LSB — within the run-to-run noise floor. |
| Fixture | `tools/fixtures/soundpack-test/` — a synthetic pack + audition + config, the only pack in this repo, so the toolchain is testable on a bare checkout. |
| Tests | New `tools/soundpack-unit.mjs` (33 checks). Fleet ids gone from `configs-unit`, `records-unit`, `leaderboard-acceptance`, `acceptance`. `configs-p2p-acceptance` now reads its two target ids **from the served catalog** — fixing a test that would have failed whenever an app left the fleet. |
| Gate | `repo-gates-unit.mjs` Gate C: derives ids from `catalog.json`, scans the tree, fails on any hit outside the allowlist (`catalog.json`; `plans/` and `sdk/CHANGELOG.md` as append-only record). |
| Evicted | `soundpacks/chiptune/` → the apps (narrative folded into `plans/soundpack-2026-07.md`); `soundpack-audition/` (27 MB) deleted and gitignored; seven per-app plans → each app's `docs/arcade-remediation.md`. |
| Docs | `tools/soundpack/README.md` rewritten (it documented a `packs/` + `lib/graph.js` layout that no longer existed). Incident citations in `ARCADE_PLATFORM.md` / `GAME_INTEGRATION.md` restated behaviorally. `ISSUES.md` is now framework-scoped with a standing no-deprecation policy. |
