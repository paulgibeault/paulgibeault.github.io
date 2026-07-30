# Arcade SDK changelog

The SDK publishes at two launcher-origin URLs:

- **`/sdk/v<major>/arcade-sdk.js`** — major-pinned. This URL keeps serving its
  major line even after a breaking major ships, so a pinned game can never be
  bricked by a launcher deploy. **Games should pin this URL.**
- **`/arcade-sdk.js`** — evergreen alias, always the newest major. Kept for
  the existing fleet and for casual standalone use.

`/arcade-sdk.js` (repo root) is the canonical source file; `sdk/v<major>/` is
a byte-identical checked-in copy while that major is current.
`tools/sdk-version-unit.mjs` gates the whole scheme in CI: copy in sync,
`SDK_SEMVER` major == `VERSION` == newest changelog entry's major, no
directory for an unshipped major.

**Release procedure** (any behavior-visible SDK change):

1. Edit `/arcade-sdk.js`; bump `SDK_SEMVER` (patch = fix, minor = additive
   feature, major = breaking — see below).
2. `cp arcade-sdk.js sdk/v3/arcade-sdk.js` (current major's directory).
3. Add an entry at the top of this file.
4. Bump `CACHE_NAME` in `sw.js` (both SDK paths are precached).

**Breaking change (new major N)**: the old directory `sdk/v<N-1>/` is frozen
as-is (its last release keeps serving forever), `VERSION`/`SDK_SEMVER` bump to
`N.0.0`, a new `sdk/v<N>/` directory is created, and the evergreen alias moves
with it. Compatibility is still negotiated at runtime by `welcome.caps` —
semver is for humans and URLs, never checked on the wire.

---

## 3.12.0

Fleet-alignment release ([#120](https://github.com/paulgibeault/paulgibeault.github.io/issues/120)
buckets 2–3 decisions).

- **New importable companion `/arcade-rng.js`** — the rng/daily/share block as
  a plain ES module (`makeRng`, `hashU32`, `dailyDateStr`, `dailySeed`,
  `shareEncode`, `shareDecode`), so game logic can run the real algorithm
  under `node --test`, where `window.Arcade` does not exist. Games vendor a
  byte-identical copy (a relative import is the only specifier that resolves
  in both the browser and node); `tools/sdk-helpers-acceptance.mjs` pins the
  companion and the SDK's inline copy to identical streams and codecs.
- **`Arcade.onStorageError` gains a default handler**: with no listener
  registered, a dropped write now toasts ("Save failed — device storage is
  full", throttled to one per 10 s). Registering any listener replaces the
  default. Before this, a quota failure was silent in every fleet game.
- **Removed `Arcade.peer.remote()`** (deprecated single-peer convenience —
  `peers()` roster is the API) and **`Arcade.ui.prompt`** (plus its bridge op
  and envelope shape). Both had zero consumers across the seven catalog apps;
  under the closed-fleet no-unconsumed-paths policy these removals ship in a
  minor because no shipped page's observable behavior changes — noted here
  explicitly since classic semver would call an API removal a major.
- Launcher-side (not SDK surface, recorded for the same release): the legacy
  `ls-proxy-request` protocol handler is deleted — its last consumer's
  `.ls.*` migration shipped. The `.ls.` key namespace remains accepted by
  backup import/restore forever (data at rest).

## 3.11.0

Companion element library (`arcade-audio.js`) gains **`registerPack(pack)`** —
the one well-known handle for "the sound pack this page loaded".

```js
ArcadeAudioElements.registerPack({ name: 'my-app', ROOM, SENDS, CUES });
// → window.ArcadeSoundPack
```

Before this, each app published its pack under a name only that app knew
(`window.<AppName>Pack`), so every piece of tooling that wanted to reach a pack
— the offline renderer, the analyzer, an audition timeline — had to be written
per app. That is a framework depending on its consumers, backwards. The handle
is now fixed and the tooling is app-agnostic; see `tools/soundpack/README.md`.

Additive and unenforced: apps still holding their own global keep working. The
soundpack toolchain reads `ArcadeSoundPack` only.

---

## 3.10.0

Companion element library (`arcade-audio.js`) gains one gesture and one
fix, both driven by cozy-solitaire — a game entirely about thin cards on
felt, which the library had no way to voice at all.

- `flex` (+ `flexBuffer`) — a thin springy sheet bent and released: paper,
  cardstock, a ticket, a flag. Nothing existing fit — `rustle` is friction
  with no release in it, `creak` grips under load in wood/rope registers,
  `strike` is contact with no body after it. The signature is a broadband
  snap followed by a short train of decaying micro-oscillations whose rate
  ACCELERATES as amplitude falls (a bending sheet's restoring force rises
  as its amplitude drops, so the gaps close as the gesture dies — a
  constant rate reads as a mechanism, not a sheet). `stiffness` is the
  material knob, the same role `body`'s partial tables play for struck
  objects; `count`/`rate`/`end` repeat the gesture for a riffle or a fan,
  spacing curved exactly as `ratchet`'s detents are.
- **Fix: a ~27 dB level outlier in any cue run not scheduled on a
  128-sample grid.** A fresh `GainNode`'s value is `1.0` until its first
  automation event lands, and Chromium applies automation on 128-sample
  render-quantum boundaries — so when a cue's start time falls
  mid-quantum, the samples between that boundary and the actual start were
  being multiplied by the stale `1.0` while the source was already
  running. Silent at low density (each cue alone still measured correctly)
  and only visible once enough cues fired close together to land on the
  wrong side of a quantum boundary — which is exactly the repetition runs
  hardest to audition by ear. `env()` primes the gain param before
  scheduling; `pluck`, `stream` and `drone`, which build their own
  envelopes, get the same treatment via a new `primed()` helper. Measured
  across thirteen `strike`s 100 ms apart: peak spread 26.6 dB → 4.6 dB.
  This changes the rendered output of every existing pack — nothing gets
  quieter than intended, only spurious peaks disappear — most visibly in
  hecknsic's `rotate`/`match`/`ui-click` repetition sections.

## 3.9.0

Companion element library (`arcade-audio.js`) gains three gestures, on the
same terms as 3.8.0: no SDK surface change — `Arcade.audio` is untouched — but
the elements ship on the same version line, so the pinned copy and the
changelog move together. Driven by sow-duku, whose world is mud, straw and
small warm animals; the previous library could make a room full of glass and
a pond at night, but had no way to voice anything alive.

- `squelch` — wet granular collapse: mud, silt, a soft body meeting a
  yielding surface. Not one splat but a population of tiny cavity pops, each
  sweeping *upward* as its channel closes (droplet physics, miniaturised —
  sweeping down is the intuitive choice and sounds nothing like wet), dense at
  contact and thinning as the surface settles, under a dark downward smear.
  `skew` shapes the population like `shatter`'s does, and inverting it (`< 1`)
  reverses the gesture into a suck: mud releasing rather than receiving, which
  is a lift-out, not a landing. Buffer-synthesised per call for the same
  reason as `shatter` — a placement cue fires it on every input.
- `breath` — respiration through a soft passage: a snout, a nostril, a
  sleeping animal. Superficially `rustle`, but the gesture is cyclic rather
  than frictional: the passage opens and relaxes, so the band moves in ONE
  ARC, and the flow is turbulent, so the level flutters irregularly a few
  times a second. A monotonic sweep under a smooth envelope reads as cloth or
  wind and never as something alive — the flutter is the whole difference.
  `dir: 'in'` mirrors the envelope for a sniff.
- `grunt` — a voiced animal call: a pig, a dove, anything with a larynx. A
  glottal pulse train in which no two periods are identical (pitch jitter and
  amplitude shimmer on every cycle, which is what separates a creature from an
  oscillator), through a pair of broad formant resonances. The formants are
  the SPECIES and stay put while the pitch moves underneath — that fixed
  formant / moving pitch split is how the ear tells a voice from a filter
  sweep. `formants` is a parameter, so another game can re-voice the animal.

## 3.8.1

Comment only, no behavior change. The note above `rng()` in `arcade-audio.js`
claimed "every render must be reproducible", which overstated what actually
holds: the *scheduling* is reproducible (seeded, no entropy in the render
path), but Chromium's `OfflineAudioContext` is not bit-exact between runs once
enough sources sum concurrently. Corrected, and pointed at the detail in
`tools/soundpack/render.mjs`. Ships as a patch because the pinned copy has to
stay byte-identical to the canonical file.

## 3.8.0

Companion element library (`arcade-audio.js`) gains three gestures. No SDK
surface change — `Arcade.audio` is untouched — but the elements ship on the
same version line, so the pinned copy and the changelog move together.

- `shatter` — brittle fracture: glass, ice, ceramic. A break is not one sound
  but a population of shards, and the population's DENSITY is the gesture:
  thickest at the fracture, thinning as the fragments scatter. `skew` shapes
  that distribution, and inverting it (`< 1`) reverses the gesture into a
  converging crescendo — glass assembling rather than breaking, which is a
  formation sound, not a destruction. Synthesised into one buffer per call,
  like `pluck` and `creak`: a match-3 fires this on every clear, and a
  60-shard cloud as live oscillator pairs would be hundreds of nodes per
  cascade step.
- `ratchet` — a pawl riding over gear teeth, the mechanism sound stick-slip
  cannot make. `creak` is irregular grip-and-release; a ratchet is the
  opposite: discrete, near-regular detents, each a contact click plus the
  short ring of the pawl. `end` (last interval / first) carries the gesture —
  `> 1` decelerates like a hand settling a dial, `< 1` accelerates like a
  wheel let go.
- `drone` — sustained tonal pressure, the tonal sibling of `stream`, which is
  noise-only. Two oscillators split symmetrically around `f` beat against each
  other and the beat RATE is the character: under 1 Hz reads as breathing,
  2-4 Hz as unease. Takes an explicit `dur` and is `collect`-aware, like
  `stream`, so beds built on it get a real teardown.

## 3.7.0

Additive: **adaptive beds** — a sustained cue's handle gains
`retune(params, fadeSeconds)`.

A sustained cue schedules its whole timeline when it starts, so there is nothing
to adjust in place; the only honest way to change one is to start a second
instance and fade the first out under it. Every game that wants a bed to respond
to play was about to hand-roll that, keeping two handles and getting the
identity question wrong. `retune()` does it inside the SDK: the handle stays the
same object, `stop()` still stops whatever is audible, and the old layer's
sources are torn down at the end of its fade. Quantise the parameter and give it
hysteresis before calling — it is cheap, but it is not free.

Companion element library (`arcade-audio.js`) gains three gestures and two
options:

- `flare` — combustion. No contact click, a swelling onset, and a band that
  sweeps downward as the ball of hot air expands. `weight` sets how much low
  pressure pulse sits under it, and that pulse swells with the flame rather
  than punching in front of it (`wAttack`).
- `blast` — explosion. The front, a boom and a sub under it, and a long
  lowpassed noise rumble rolling away. `size` scales duration and depth
  together. No tonal layer by default: an explosion has no pitch, and partials
  ringing inside the bang are heard as a tone sitting in it. `tone` adds them
  back for something that should ring — a boiler, a hull, a struck bell.
  `crack` (default 1) is the snap at the front, and it is the whole difference
  between a detonation and a fireball: `crack: 0` with a raised `attack` gives
  a whump that arrives as swelling low air instead of an edge.
- `thump` gains `attack`: left at its 4 ms default it punches, which is right
  for an impact and wrong for anything that grows.
- `chirp` — insect stridulation. A train of very short pulses, because the
  pulse rate is what the ear reads as "insect"; one note at the same pitch is a
  whistle.
- `rustle` gains `lp`, the same cascaded two-stage lowpass `creak` and `stream`
  already had, for soft low-register gestures that otherwise leak enough top
  end to read as hiss.
- `creak` gains `rate1`, sweeping the stick-slip rate across the gesture, so a
  mechanism can start turning and settle instead of grinding at one speed.
- `teardown(collect)` builds the standard teardown a sustained cue returns.

## 3.6.0

Additive: **graph cues** — `Arcade.audio.graph(name, fn, opts)`, `start()` for
sustained beds, `room(cfg)` for the shared acoustic space, `bus()` and `el()`.

A spec cue (`cue()`) is one oscillator with an envelope; that palette is a
chiptune synthesizer by construction and cannot produce environmental sound at
any parameter setting. A graph cue is an arbitrary node graph built from
physical-gesture elements — swept-bandpass friction, stick-slip creak,
Karplus-Strong pluck, inharmonic struck bodies — with every cue in a game
feeding one shared convolution room, which is what lets overlapping sounds fuse
into a scene instead of stacking into a pile.

Elements live in a new optional companion file, `/sdk/v<major>/arcade-audio.js`,
loaded after the SDK. Games that only need simple cues skip it and pay nothing.
`tools/soundpack/render.mjs` injects that exact file to render audition WAVs
offline, so the audition and the game run the same code.

`cue()`/`play()` are unchanged and still work; a graph cue simply takes
precedence over a spec cue of the same name, so a game can upgrade one sound at
a time without touching call sites.

Also fixes a long-standing trap: `context()` handed games the managed
AudioContext for custom graphs, but the master gain was private, so anything
built on it connected to `ctx.destination` and silently bypassed the launcher's
volume and mute. `bus()` is now the documented destination.

## 3.5.0 — 2026-07-20

Managed WebAudio SFX (`Arcade.audio`, #38). Lifts the highest-bug-density audio
plumbing games kept re-hand-rolling — lazy AudioContext, first-gesture unlock,
master gain wired to `Arcade.settings.audioVolume()`, suspend on hide / resume
on return, and the exponentialRamp-from-zero crash (enveloped with linear ramps
instead). Purely local; no cap/wire.

- `Arcade.audio.cue(name, spec)` — register a named cue (a spec object, or an
  array played as a timed sequence: each voice `delay` seconds after the
  previous start, or back-to-back by duration; an all-`delay:0` array is a chord).
- `Arcade.audio.play(nameOrSpec, overrides?)` — play a cue (with optional
  overrides) or an inline spec/array. Fire-and-forget; silent + cheap when muted.
  spec: `{ type:'sine'|'square'|'sawtooth'|'triangle'|'noise', freq, toFreq?,
  dur, gain, attack?, release? }`.
- `Arcade.audio.enabled()` — WebAudio present and volume > 0.
- `Arcade.audio.context()` — the managed AudioContext (advanced; null before
  first play).

## 3.4.0 — 2026-07-20

Game-config exchange (`Arcade.configs`, #config-exchange). Games can share and
load a named configuration — a sowduku pack, a cardstock variant, a puzzle seed
— over any channel or straight to a linked device. New `configs.bridge` welcome
cap; feature-detect via `Arcade.peer.caps()` (standalone/older launchers fall
back to returning the code):

- `Arcade.configs.register(type, ({type,v,data}) => {…})` — register a handler.
  Inbound `data` is HOSTILE cross-device input; the game must semantic-validate
  and render via textContent/`Arcade.html.escape`, never innerHTML. A config
  that arrives before register() is queued (capped) and drained on register.
- `Arcade.configs.share(type, data)` → `{ ok, code, url? }` — export as a share
  code; framed, the launcher builds a `#app=<id>&cfg=<code>` deep link and opens
  the share sheet.
- `Arcade.configs.send(type, data)` → `{ ok, sent }` — push directly to a linked
  device the user picks (the receiver is prompted before your handler runs).

The launcher validates transport shape only (type charset, ≤4 KB code / ≤8 KB
data, game-in-catalog) and always prompts before delivery; it never interprets
`data`. `Arcade.share.encode/decode` is unchanged; its internals are now shared
with `Arcade.configs`.

## 3.3.0 — 2026-07-20

Score entry attribution for shared leaderboards (#leaderboards). `Arcade.scores.add`
now stamps two internal fields on each entry so peer boards can be union-merged
across linked devices without dropping distinct plays or double-counting:

- `dev` — the device id that set the score (read from the paired-device
  identity; omitted on a standalone page that never paired). Never minted here.
- `eid` — a random per-entry id (8 base64url chars), so two entries in the same
  millisecond stay distinct.

Games don't set these and don't need to change: `scores.add(category, { score, … })`
is unchanged, and `scores.list/best` ignore the extra fields. The launcher's new
shared-leaderboard engine merges boards from peers (with the per-peer sync opt-in
on both sides) into the real `scores.*` keys — so a game just keeps reading its
own leaderboard and sees everyone's entries. Scores are carved out of `Arcade.sync`
(which is last-writer-wins and would clobber a board wholesale).

## 3.2.0 — 2026-07-20

Personal records API (`Arcade.records`, issue #9). A self-describing per-category
personal best, distinct from `Arcade.scores` (a sorted top-N leaderboard): one
record per category, each carrying its own `direction` so "best" is meaningful
without out-of-band knowledge. This replaces the brittle
`scores.add(cat, { score: -timeMs })`-then-re-negate workaround for
lower-is-better metrics. Purely local storage convention (no new welcome cap):

- `Arcade.records.set(category, { value, direction: 'higher'|'lower', label?, format?, meta? })`
  — `format` ∈ `'duration-ms' | 'integer' | 'percentage'` (unknown values stored
  as-is for forward-compat); oversized (>4 KB) or non-object `meta` is dropped
  with a warning, never thrown.
- `Arcade.records.best(category, rec)` — writes only if `rec.value` beats the
  stored record under the stored direction; ties do not write (the first-set
  timestamp is preserved). Returns `{ improved, record }`.
- `Arcade.records.get(category)` → record | null (a fresh object each call).
- `Arcade.records.list()` → `{ [category]: record }`, malformed entries skipped.
- `Arcade.records.clear(category)`.

Stored one key per category at `arcade.v1.<gameId>.records.<category>`, so records
ride save-export and (when the game opts into `Arcade.sync`) replication with no
special handling. The launcher's Records sheet reads these generically.

## 3.1.0 — 2026-07-18

Multi-party star selection (`plans/multi-party-2026-07.md` Phase 2). A device
can now hold several concurrent parties (independent connection stars); a
running game is attached to exactly one, and its whole `Arcade.peer.*`
surface reflects only that party. Additive API, gated by the new
`peer.party` welcome cap:

- `Arcade.peer.party()` — the attached party (`{id, role, leaderName,
  status, peers}`) or null.
- `Arcade.peer.parties()` — every party this game could attach to.
- `Arcade.peer.attach(partyId)` — request re-attachment; resolves to the
  resulting party or null if refused.

With a single party the launcher auto-attaches and existing games keep
working unchanged — these calls are only for games that want to choose.
Roster entries now also carry a session-scoped `partyId` field (additive).

## 3.0.0 — 2026-07-17

First versioned release. Establishes the `/sdk/v3/` pinned path, the evergreen
alias contract, and this changelog. Adds `Arcade.context.sdkVersion` (the
semver string). No behavior changes otherwise: v3 is the SDK generation that
introduced bridged storage mode (opaque-origin frames), already fleet-wide.
