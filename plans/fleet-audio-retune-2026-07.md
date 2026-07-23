# Fleet audio re-tune — sound design pass (2026-07)

Status: **SPEC — awaiting review.** Not yet implemented. Follow-up to
`plans/fleet-records-audio-2026-07.md` (G1–G7, merged 2026-07-21).

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

**The fix isn't more gain/duration tuning — it's giving each game a distinct
sonic palette** (waveform combinations, texture, register) tied to its actual
setting, not just its energy level.

## 2. Per-game diagnosis + revised direction

Severity ranks how far each game's current audio is from its theme.

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
`chime`, `snuffle`, `slip` — keep as-is, already on-theme. `fail` could soften
its attack slightly (currently reads a bit like a generic "game over" scale
rather than "a tired sigh") — lower priority, optional.

### si-syn — LOW mismatch
**Theme:** circuit-lab hacker aesthetic, Shenzhen I/O-inspired. Square/
sawtooth already fits a "digital signal" identity.

**Direction (polish, not overhaul):** lean further into "signal," not just
"chiptune" — a `test-fail` that reads as static/noise interference rather
than a smooth descending sawtooth would sell "signal mismatch" harder than a
melodic wrong-note does. Optional: `ui-click` could get a touch of noise
under the square tone (relay-click character) since the game's whole
metaphor is physical circuit components.
```js
'test-fail': [
  { type: 'noise', dur: 0.05, gain: 0.10, attack: 0.001, release: 0.04 },
  { type: 'sawtooth', freq: 220, toFreq: 150, dur: 0.18, gain: 0.22, attack: 0.002, release: 0.16, delay: 0.01 },
],
```

### moon-lit — LOW mismatch (closest to spec)
Already implements docs/design-concept.md §8 closely: noise for paper
"shh," triangle glide for rope creak, chime with a chain-pitch ladder, a
sine-chord temple bell for win, triangle glides for the koto-esque loss.
**No rework proposed** — this is the reference example of what "on-theme"
looks like for this fleet. One structural gap, not a tuning issue: §8 calls
for an ambient bed (river water + irregular taiko) that `Arcade.audio` can't
provide (one-shot voices only, no looping ambient layer) — **out of scope**,
flag as a known SDK limitation rather than something to re-spec.

### hecknsic — LOW mismatch
Square/sawtooth arcade energy fits a vibrant hex-matching puzzle game
reasonably well. **No rework proposed.** If revisited later: the `combo`
cue's per-play pitch stepping is a nice touch already; could add a touch of
triangle warmth to `match` so it doesn't sit tonally identical to `rotate`,
but this is a nice-to-have, not a mismatch.

### pi-game — LOW mismatch
Cues were ported **verbatim** from the game's original hand-tuned synth
(pre-migration), i.e. this is the one game whose sound design was already
human-authored and deliberate, not agent-generated from a generic
convention. **No rework proposed** unless the ear pass specifically flagged
it (it didn't — the pi-game PR notes params were preserved 1:1).

### p2p-chat — LOW mismatch
Notification-chime sine tones are actually the *correct* register for a chat
app — this is what real messaging apps sound like (soft, short, non-
startling). **No rework proposed.**

## 3. Priority order for a re-tune pass

1. **cozy-solitaire** (highest mismatch, most-used cues — card-place/flip
   fire constantly)
2. **sow-duku** (`thud` specifically; other cues fine)
3. **si-syn** (`test-fail`, `ui-click` — optional polish)
4. moon-lit / hecknsic / pi-game / p2p-chat — no action needed

## 4. Process for implementing this spec

Unlike G1–G7, this is tuning existing, already-integrated cue registrations
— no new call sites, no records work, no SW bumps (unless a repo's release
convention requires a version bump for any JS change — check per repo).
Small enough to be single-agent-per-game or even done directly, not a fan-out
requiring the G1–G7 level of coordination scaffolding. Each change is a
values-only edit to an existing `cue()`/`CUES` registration.

**This is still audio nobody has heard** — the specs above are informed
guesses from the same synth-only constraint as the original work. Land as a
draft PR per touched repo (cozy-solitaire, sow-duku, si-syn), get another
ear pass, iterate before merge. Do not skip the ear-check loop just because
this is "smaller."

## Out of scope

- An ambient/looping audio bed for moon-lit (`Arcade.audio` is one-shot-voice
  only; adding loop support would be an SDK-level change, not a per-game fix).
- Sample/file-based audio (still out of scope per the original plan).
- Any new cue *events* — this is re-tuning existing cues, not adding new ones.
