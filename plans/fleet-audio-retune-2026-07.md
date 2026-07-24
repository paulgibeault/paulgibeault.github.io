# Fleet audio re-tune — sound design pass (2026-07)

Status: **SPEC rev 2 — awaiting review.** Not yet implemented. Follow-up to
`plans/fleet-records-audio-2026-07.md` (G1–G7, merged 2026-07-21).

Rev 2 (2026-07-24): scope widened after review. Rev 1 graded four games
"LOW mismatch — no rework proposed" and held moon-lit up as the reference
example of on-theme audio. Review verdict: that framing is wrong — **no game
is a reference; every game, moon-lit included, gets a finely crafted sound
identity.** All seven games now have a craft section below.

## 0. Why this exists

Post-merge human ear pass (2026-07-22) verdict: the audio "is good for a tech
demo, but pretty off-theme, consistently." This document diagnoses *why* and
proposes concrete revised cue specs, game by game, for review before another
implementation pass.

## 1. Root cause

Every G1–G7 package followed convention **A5** from the original plan:

> sine/triangle for gentle games, square/sawtooth for arcade-y ones

That convention was written to keep seven concurrent agents from inventing
wildly inconsistent noise, and it worked for *that* goal. But it collapsed
sound design to a two-bucket palette (**gentle** vs **arcade**) applied almost
mechanically, when the fleet actually has seven distinct visual/narrative
identities. The result: a Japanese lantern-temple game, a cabin-cozy card
table, and a piggy mud-pen farm all landed in the same "gentle" bucket and
sound like variations on one soft-chime template, instead of three different
places.

Rev 1 of this spec then repeated a milder version of the same mistake:
grading games against the two-bucket convention and exempting the ones that
matched their bucket well. The bar isn't "does the bucket fit" — it's "does
this game have its *own* sound." By that bar all seven need a pass.

**The fix isn't more gain/duration tuning — it's giving each game a distinct
sonic palette** (waveform combinations, texture, register) tied to its actual
setting, not just its energy level. The recurring techniques:

- **Material transients**: real objects announce contact with a broadband
  tick/thump before any tone. A short `noise` voice (10–40 ms) layered under
  a tone turns a synth blip into an object.
- **Inharmonicity**: bells, plucks, and glass have partials that are *not*
  clean integer multiples. A stack of exact harmonics reads as "organ patch,"
  not as a struck or plucked thing.
- **Register + envelope as identity**: a sonar ping, a marimba tick, and a
  doorbell can share a sine wave — attack/release shape and pitch movement
  are what distinguish them.

### SDK constraint that shapes every spec below

Per-play overrides (`Arcade.audio.play(name, {freq})`) **only merge onto
single-object cue specs — array (multi-voice) cues ignore overrides**
(`arcade-sdk.js` `resolveCue`). So any cue that relies on a per-play pitch
ladder — moon-lit `match` (cluster size), hecknsic `combo` (chain depth),
pi-game `correct` (digit index) — **must stay single-voice**, or the game
must layer at the call site (play a separate transient cue alongside), or
build an inline spec array per play. Each affected section says which option
it takes.

Array sequencing semantics (for the specs below): voice *i* starts
`delay` seconds after the *previous voice's start*; no `delay` means
back-to-back after the previous voice's `dur`; an all-`delay:0` array is a
chord.

## 2. Per-game craft sections

Severity ranks how far each game's current audio is from its theme — it sets
priority order, not whether a game gets worked on (they all do).

### cozy-solitaire — HIGH mismatch
**Theme** (README): "warm, grandma-friendly... warm browns, soft greens,
cream cards, cabin vibes." A physical card table, not a screen.

**Current** (`js/sfx.js`): pure triangle/sine tones for card-place (330 Hz
triangle) and card-flip (494 Hz sine) — reads as generic mobile-game "soft
chime," with zero textural cue that a *card* touched a *table*.

**Direction:** cards are physical objects with friction and weight — lean on
short filtered noise for the material, tone only for the "settle."
- `card-place`: layer a very short noise burst (paper/felt friction, ~30ms)
  under the existing triangle tone, so it reads as an object landing, not a
  synth blip.
- `card-flip`: brighter/shorter noise-forward flick — the *turn*, not a bell.
- `invalid-move`: keep as the quietest, lowest cue (already correct instinct).
- `undo`: keep the downward glide, but triangle → warmer sine so it doesn't
  compete tonally with card-place.
- Win jingle: keep the ascending arpeggio shape, but consider a softer
  attack/release (music-box character) over the current fairly percussive
  0.12s notes.

Revised specs (draft, needs ear-check):
```js
'card-place': [
  { type: 'noise', dur: 0.03, gain: 0.10, attack: 0.002, release: 0.025 },
  { type: 'triangle', freq: 330, dur: 0.06, gain: 0.10, attack: 0.006, release: 0.05, delay: 0.01 },
],
'card-flip': [
  { type: 'noise', dur: 0.04, gain: 0.12, attack: 0.002, release: 0.03 },
  { type: 'sine', freq: 494, dur: 0.06, gain: 0.12, attack: 0.006, release: 0.04, delay: 0.015 },
],
```

### sow-duku — MODERATE mismatch
**Theme:** "a field of contented little piggies... quiet logic of giving each
one its own patch of mud... the gentle thud of a piggy flopping down."

**Current** (`index.html` cues): the cue *names* and general instincts are
genuinely good — `snuffle` already uses noise (right call), `chime` is warm.
But `thud` is a pure 150→65 Hz sine sweep — closer to a synth kick drum than
a piggy flopping into mud. It's the one cue most disconnected from its name.

**Direction:** add a soft noise "flop" under the existing sine sweep — the
same layering idea as cozy-solitaire's card-place, because both are "solid
thing meets soft surface" — but noisier/duller (mud, not felt) and pitched
lower.
```js
'thud': [
  { type: 'noise', dur: 0.09, gain: 0.14, attack: 0.004, release: 0.07 },
  { type: 'sine', freq: 150, toFreq: 65, dur: 0.2, gain: 0.24, attack: 0.008, release: 0.19, delay: 0.01 },
],
```
`chime`, `snuffle`, `slip` — closest to on-theme in the fleet; light-touch
ear-check only. `fail` should soften its attack (currently reads as a generic
"game over" scale rather than "a tired sigh").

### moon-lit — MODERATE mismatch
**Theme** (docs/design-concept.md §8): lantern festival by a river — paper,
rope, wood, water, a temple bell, a koto. The design doc imagines *sampled
physical textures*.

**Current** (`js/sfx.js`): follows the doc's cue list faithfully, but renders
every physical texture as a pure tone — the module's own comment admits they
are "gestures in the right register, not the sampled instruments the doc
imagines." The temple-bell win is three *exact harmonic* sines (196/392/587
≈ 1×/2×/3×) with no strike — an organ chord, not a bell. The koto loss is
plain triangle glides with no pluck. The trellis "creak" is a pure triangle
with no wood/rope grain. Right gestures, thin rendering.

**Direction:** keep every gesture; add the physics.
- `win` (temple bell): add a noise strike transient and replace the clean
  harmonic stack with an inharmonic one — real bells have a prominent
  minor-third-ish "tierce" partial, which is most of why a bell sounds like
  a bell.
- `game-over` (koto): koto strings are *plucked* — give each note a tiny
  noise pluck-tick and a near-instant attack.
- `trellis` / `dead-line-warning`: layer low soft noise under the triangle
  glide for wood/rope grain.
- `drop`: a tiny noise "plip" at the top of the falling sine — a droplet has
  a surface-break before the pitch.
- `match`: **stays single-voice** (per-play `freq` ladder via `matchFreq()`;
  arrays ignore overrides). Add the strike as a separate `match-tick` cue
  played at the same call site in `sfx()`'s caller.
- `lantern-launch` (noise "shh") and `menu-click` — already the two most
  physical cues in the fleet; ear-check only.

Revised specs (draft, needs ear-check):
```js
'match-tick': { type: 'noise', dur: 0.02, gain: 0.05, attack: 0.001, release: 0.015 },
'match':      { type: 'triangle', freq: 523.25, dur: 0.22, gain: 0.20, attack: 0.003, release: 0.20 },

'win': [
  { type: 'noise', dur: 0.03,  gain: 0.05, attack: 0.001, release: 0.025, delay: 0 },
  { type: 'sine', freq: 196,  dur: 1.5, gain: 0.20, attack: 0.004, release: 1.35, delay: 0 },
  { type: 'sine', freq: 466,  dur: 1.0, gain: 0.07, attack: 0.004, release: 0.90, delay: 0 }, // inharmonic "tierce"
  { type: 'sine', freq: 700,  dur: 0.6, gain: 0.04, attack: 0.004, release: 0.55, delay: 0 },
],

'game-over': [  // pluck-tick + note, three times (delays interleave the pairs)
  { type: 'noise', dur: 0.015, gain: 0.05, attack: 0.001, release: 0.012 },
  { type: 'triangle', freq: 392, toFreq: 370, dur: 0.20, gain: 0.16, attack: 0.002, release: 0.17, delay: 0 },
  { type: 'noise', dur: 0.015, gain: 0.05, attack: 0.001, release: 0.012, delay: 0.20 },
  { type: 'triangle', freq: 330, toFreq: 300, dur: 0.20, gain: 0.16, attack: 0.002, release: 0.17, delay: 0 },
  { type: 'noise', dur: 0.015, gain: 0.05, attack: 0.001, release: 0.012, delay: 0.20 },
  { type: 'triangle', freq: 262, toFreq: 210, dur: 0.40, gain: 0.18, attack: 0.002, release: 0.34, delay: 0 },
],

'trellis': [
  { type: 'noise', dur: 0.16, gain: 0.05, attack: 0.02, release: 0.13, delay: 0 },
  { type: 'triangle', freq: 130, toFreq: 98, dur: 0.18, gain: 0.14, attack: 0.02, release: 0.14, delay: 0 },
],

'drop': [
  { type: 'noise', dur: 0.02, gain: 0.05, attack: 0.001, release: 0.015, delay: 0 },
  { type: 'sine', freq: 880, toFreq: 440, dur: 0.10, gain: 0.13, release: 0.08, delay: 0 },
],
```
(`dead-line-warning` gets the same noise-layer treatment as `trellis`,
slightly higher gain.)

### hecknsic — MODERATE mismatch
**Theme** (README): Hexic HD-inspired — a vibrant board of colored hexagon
*tiles* on a dark-only theme. The visual identity is glassy gems on black,
not an 8-bit cabinet.

**Current** (`js/audio.js`): pure square/sawtooth chiptune — the generic
"arcade bucket." Nothing about it says *glass tiles*; `match` (square 520)
and `rotate` (square 330) are the same voice at different pitches.

**Direction:** crystalline, not chiptune. Matches and specials should ring
like struck glass (sine/triangle with a bright shimmer partial + strike
tick); rotation is a *mechanical* act (tiles physically turning) and should
click/ratchet, not beep. Keep the arcade *energy* — short, snappy, bright —
while changing the material.
- `combo`: **stays single-voice** (per-play `comboFreq()` ladder; arrays
  ignore overrides). Sawtooth → triangle gets it into the glass family; the
  rising ladder already sells escalation.
- `game-over`: the descending three-voice motif is a good shape; sawtooth →
  triangle keeps it in-palette. Lowest priority cue here.

Revised specs (draft, needs ear-check):
```js
Arcade.audio.cue('rotate', [  // mechanical ratchet click
  { type: 'noise', dur: 0.018, gain: 0.08, attack: 0.001, release: 0.014, delay: 0 },
  { type: 'square', freq: 330, dur: 0.03, gain: 0.10, attack: 0.001, release: 0.025, delay: 0 },
]);
Arcade.audio.cue('match', [  // struck glass: tick + fundamental + shimmer
  { type: 'noise', dur: 0.015, gain: 0.05, attack: 0.001, release: 0.012, delay: 0 },
  { type: 'triangle', freq: 523, dur: 0.14, gain: 0.22, attack: 0.002, release: 0.12, delay: 0 },
  { type: 'sine', freq: 1568, dur: 0.10, gain: 0.06, attack: 0.002, release: 0.09, delay: 0 },
]);
Arcade.audio.cue('combo', { type: 'triangle', freq: 440, dur: 0.10, gain: 0.26, attack: 0.002, release: 0.08 });
Arcade.audio.cue('special', [  // crystalline arpeggio, longer ring than rev-1
  { type: 'sine', freq: 660,  dur: 0.08, gain: 0.24, attack: 0.002, release: 0.07 },
  { type: 'sine', freq: 990,  dur: 0.08, gain: 0.24, attack: 0.002, release: 0.07, delay: 0.05 },
  { type: 'sine', freq: 1320, dur: 0.14, gain: 0.22, attack: 0.002, release: 0.12, delay: 0.05 },
]);
Arcade.audio.cue('bomb', [  // rumble under the thud
  { type: 'noise', dur: 0.15, gain: 0.10, attack: 0.005, release: 0.13, delay: 0 },
  { type: 'sawtooth', freq: 120, toFreq: 80, dur: 0.18, gain: 0.28, attack: 0.005, release: 0.15, delay: 0 },
]);
```

### p2p-chat — MODERATE mismatch
**Theme:** the whole point of this app is the *direct device-to-device link*
— no server, peers appearing and disappearing off the local radar. That's a
sonar/radio identity, and the app currently ignores it.

**Current** (`app.js`): interchangeable two-note pure-sine chimes — the
default vocabulary of every messaging app ever. Functional, anonymous.

**Direction:** peer-presence events become sonar (a ping with a quiet echo
for arrival, a ping fading below the noise floor for departure); messages
become soft physical "pops" rather than doorbells, with sent quieter/lower
than received (away vs. toward you). `transfer-complete`'s rising triad and
`error`'s low buzz are the right shapes — in-palette polish only.

Revised specs (draft, needs ear-check):
```js
Arcade.audio.cue('peer-joined', [  // sonar ping + quiet echo
  { type: 'sine', freq: 1175, toFreq: 1100, dur: 0.12, gain: 0.25, attack: 0.002, release: 0.11 },
  { type: 'sine', freq: 1175, toFreq: 1100, dur: 0.12, gain: 0.08, attack: 0.002, release: 0.11, delay: 0.22 },
]);
Arcade.audio.cue('peer-left',  // the ping sinking below the floor
  { type: 'sine', freq: 1100, toFreq: 700, dur: 0.25, gain: 0.18, attack: 0.005, release: 0.22 });
Arcade.audio.cue('message-received', [  // soft pop, not a doorbell
  { type: 'noise', dur: 0.015, gain: 0.06, attack: 0.001, release: 0.012, delay: 0 },
  { type: 'sine', freq: 740, dur: 0.09, gain: 0.24, attack: 0.003, release: 0.08, delay: 0 },
]);
Arcade.audio.cue('message-sent',  // quieter, lower sibling (away, not toward)
  { type: 'sine', freq: 587, dur: 0.06, gain: 0.12, attack: 0.003, release: 0.05 });
```

### pi-game — LOW-to-MODERATE mismatch
**Theme** (README): "*One wrong digit and it's over.*" Dark navy + neon red —
a tense, focused, high-stakes recital. Not a friendly quiz.

**Current** (`index.html`): cues were ported **verbatim** from the game's
original hand-rolled synth, so they're deliberate — but they predate any
sound-identity thinking: `correct` is a stock 440 Hz sine beep, `wrong` a
static detuned-saw chord. Generic UI-beep vocabulary.

**Direction:** the recital deserves a metronome/pulse character — `correct`
as a tight, fast-decay tick that stays *under* the player's concentration
(the rising digit-index pitch ladder is the best idea in the file — keep
it), and `wrong` as a genuine alarm hit: keep the detuned-cluster drama but
give it a thump and a downward bend so it lands like a strike, not an organ
chord.
- `correct`: **stays single-voice** (per-play rising `freq`; arrays ignore
  overrides).
- `practice-correct` / `practice-wrong`: re-derive as quieter, shorter
  siblings of whatever the main pair becomes, preserving the existing
  softer-in-practice relationship.

Revised specs (draft, needs ear-check):
```js
.cue('correct', { type: 'triangle', freq: 440, dur: 0.09, gain: 0.15, attack: 0.002, release: 0.08 })
.cue('wrong', [
  { type: 'noise', dur: 0.10, gain: 0.10, attack: 0.002, release: 0.09, delay: 0 },
  { type: 'sawtooth', freq: 150, toFreq: 140, dur: 0.5, gain: 0.11, delay: 0 },
  { type: 'sawtooth', freq: 157, toFreq: 146, dur: 0.5, gain: 0.11, delay: 0 },
  { type: 'sawtooth', freq: 185, toFreq: 172, dur: 0.5, gain: 0.11, delay: 0 },
])
```

### si-syn — LOW mismatch
**Theme:** circuit-lab hacker aesthetic, Shenzhen I/O-inspired. Square/
sawtooth already fits a "digital signal" identity — the one game whose
bucket accidentally *was* its identity. Still gets a craft pass, aimed at
sharpening that identity rather than replacing it.

**Direction:** lean further into "signal," not just "chiptune" — a
`test-fail` that reads as static/noise interference rather than a smooth
descending sawtooth sells "signal mismatch" harder than a melodic wrong-note
does. `ui-click` gets a touch of noise under the square tone (relay-click
character) since the game's whole metaphor is physical circuit components.

Revised specs (draft, needs ear-check):
```js
'test-fail': [
  { type: 'noise', dur: 0.05, gain: 0.10, attack: 0.001, release: 0.04 },
  { type: 'sawtooth', freq: 220, toFreq: 150, dur: 0.18, gain: 0.22, attack: 0.002, release: 0.16, delay: 0.01 },
],
'ui-click': [
  { type: 'noise', dur: 0.012, gain: 0.06, attack: 0.001, release: 0.01, delay: 0 },
  { type: 'square', freq: 440, dur: 0.03, gain: 0.10, attack: 0.001, release: 0.025, delay: 0 },
],
```

## 3. Priority order for the re-tune pass

All seven games are in scope. Order by mismatch severity × how often the
affected cues fire:

1. **cozy-solitaire** (highest mismatch; card-place/flip fire constantly)
2. **sow-duku** (`thud` + `fail`)
3. **moon-lit** (every cue gets the physics pass; win/game-over are the
   emotional landmarks)
4. **hecknsic** (material change square→glass across most cues)
5. **p2p-chat** (full palette swap to sonar/pop identity)
6. **pi-game** (two main cues + practice siblings)
7. **si-syn** (sharpening, not replacing)

## 4. Process for implementing this spec

Unlike G1–G7, this is tuning existing, already-integrated cue registrations
— no new call sites (one exception: moon-lit's `match-tick` companion cue
adds one play-site next to the existing `match` one), no records work, no SW
bumps (unless a repo's release convention requires a version bump for any JS
change — check per repo). Small enough to be single-agent-per-game or done
directly; no G1–G7-level coordination scaffolding needed.

**This is still audio nobody has heard** — the specs above are informed
guesses from the same synth-only constraint as the original work. Land as a
draft PR per touched repo (now all seven), get another ear pass, iterate
before merge. Do not skip the ear-check loop just because this is "smaller."
Expect a second round of value-nudges after listening; the specs encode
*direction*, the ear encodes *taste*.

## Out of scope

- An ambient/looping audio bed for moon-lit (`Arcade.audio` is one-shot-voice
  only; adding loop support would be an SDK-level change, not a per-game fix).
  Still worth flagging: moon-lit's design doc §8 asks for a river/taiko bed,
  and it remains the biggest gap between the doc and what the SDK can render.
- Sample/file-based audio (still out of scope per the original plan).
- Any new cue *events* — this is re-tuning existing cues, not adding new
  ones. (moon-lit's `match-tick` is a carve-out: a companion voice for an
  existing event, forced by the single-voice override constraint, not a new
  game event.)
