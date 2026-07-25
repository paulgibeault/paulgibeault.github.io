# `soundpacks/chiptune/` — the chiptune sound profile (frozen archive)

**Nothing loads these files.** There is no profile system yet. This directory is
data on ice: seven `.mjs` modules, each exporting a `CUES` object (plus a few
helpers), waiting for something to consume them. No game imports them, the
launcher does not ship them, and no build step touches them. If you are here
looking for the code that actually makes sound today, it is `Arcade.audio` in
the SDK and each game's own audio module — not this.

## What this is

In July 2026 the whole fleet got a sound-design pass. Seven repos each grew a
re-tuned set of cue definitions on an `audio-retune` branch: material transients
instead of bare tones, inharmonic bell partials, strike ticks under every
attack, per-game palettes with an actual identity behind them
(see `../../plans/fleet-audio-retune-2026-07.md`).

A human ear pass then rejected it — and rejected the **approach**, not the
craft. The verdict was that the result still sounds "too simple and chip-tune
like", and that overlapping cues stack rather than blend.

The diagnosis, corrected in `../../plans/soundpack-2026-07.md`
([launcher PR #92](https://github.com/paulgibeault/paulgibeault.github.io/pull/92)),
is that the ceiling is the engine, not the values. The SDK's entire audio path
is:

```
Oscillator | BufferSource(white noise) → GainNode (linear attack/release) → masterGain → destination
```

No filter. No reverb, delay, modulation, waveshaping, compression, or panning.
No per-play variation. That graph **is** a chiptune synthesizer in the literal
historical sense — raw waveforms are spectrally frozen, there is no shared
reverb space for overlapping cues to fuse into, and byte-identical repetition is
the classic chip tell. No amount of re-tuning cue values escapes it.

## Why keep it, then

Because the work is good *as chiptune*. These cues are a careful, coherent,
finished expression of exactly what this engine can do — which makes them
precisely the right thing to keep for later, once a richer engine exists, as a
**selectable "retro" sound profile** sitting alongside the environmental packs.
The plan owner's call: save the current sound implementations as-is, for later
integration as a chip-tune sound profile.

So this is a preservation copy, not a staging area. The seven draft PRs are on
hold rather than abandoned, but branches are fragile — the design content needed
to live somewhere durable on `main`, which is here.

## Where each file came from

Every module carries its own provenance header (source repo, source file, the
exact `audio-retune` commit SHA, the draft PR, and the archive date).

| File | Source repo | Source file | `audio-retune` SHA | Draft PR | Cues |
| --- | --- | --- | --- | --- | --- |
| `moon-lit.mjs` | `paulgibeault/moon-lit` | `js/sfx.js` | `ee7e62b` | [#27](https://github.com/paulgibeault/moon-lit/pull/27) | 9 |
| `pi-game.mjs` | `paulgibeault/pi-game` | `index.html` | `420d028` | [#21](https://github.com/paulgibeault/pi-game/pull/21) | 5 |
| `si-syn.mjs` | `paulgibeault/si-syn` | `src/audio.js` | `425b810` | [#22](https://github.com/paulgibeault/si-syn/pull/22) | 4 |
| `hecknsic.mjs` | `paulgibeault/hecknsic` | `js/audio.js` | `9169f43` | [#45](https://github.com/paulgibeault/hecknsic/pull/45) | 7 |
| `cozy-solitaire.mjs` | `paulgibeault/cozy-solitaire` | `js/sfx.js` | `f583b35` | [#13](https://github.com/paulgibeault/cozy-solitaire/pull/13) | 5 |
| `sow-duku.mjs` | `paulgibeault/sowduku` | `index.html` | `34c9cdd` | [#11](https://github.com/paulgibeault/sowduku/pull/11) | 5 |
| `p2p-chat.mjs` | `paulgibeault/p2p-chat` | `app.js` | `c97ff87` | [#8](https://github.com/paulgibeault/p2p-chat/pull/8) | 6 |

41 cues, 97 voices in total. `p2p-chat`'s base branch is `master`;
`sow-duku`'s GitHub repo is spelled `sowduku`.

Every numeric value is transcribed verbatim from those commits and was verified
mechanically against them. Nothing was "improved" on the way in — that is the
whole point of an archive. The design-intent comments were carried across with
the numbers, and they are the most valuable thing here: they record *why* each
sound is shaped the way it is, which is the part a future profile has to honour
even when the synthesis method changes completely.

## What is not a static spec

A cue table alone does not reproduce these games. Four of the seven derive cue
parameters at runtime, and those are exported as helpers or recorded as
clearly-marked notes next to the cues they belong to:

- **`moon-lit.mjs`** — `matchFreq(clusterSize)`, the cluster-size pitch ladder
  (3 = base C5, 4 = +major third, 5 = +fifth, 6+ = +octave), and
  `MATCH_PAIRING`: `match-tick` and `match` are two cues fired together on every
  clear, split only because the SDK merges per-play overrides onto single-object
  cues and ignores them on arrays.
- **`pi-game.mjs`** — `correctFreq(digitIndex)` = `Math.min(440 + idx*8, 1200)`,
  the tick's rising digit-index ladder; and `comboOverrides()` with
  `COMBO_GAIN_COEFF = 0.012`, the streak accent's per-play gain (a fifth above
  the tick, gain `0.012 × min(comboLevel, 10)`, firing only above comboLevel 3).
- **`hecknsic.mjs`** — `comboFreq(depth)`, the chain-depth ladder
  (`round(440 · 2^(min(depth,15)/12))`), plus `UI_CLICK_SELECTOR`, the delegated
  capture-phase selector list that decides what counts as a UI click.
- **`cozy-solitaire.mjs`** — the win flourish was never a registered cue at all.
  It lived as a bare `WIN_JINGLE` array handed straight to the play wrapper as
  an inline spec, so it had no string handle in the source. It is keyed here as
  `win-jingle` so a profile system enumerating `CUES` cannot silently lose it.
- **`sow-duku.mjs`** — the only game in the fleet whose sound is **off by
  default**, via its own persisted in-game setting (`IN_GAME_SOUND_SETTING`).
- **`p2p-chat.mjs`** — `PING_PITCH_FAMILY`: `peer-joined`, `peer-left` and
  `transfer-complete` are deliberately pitched against one another on the same
  1100–1175 Hz sonar ping. Retune them independently and the metaphor collapses.

`si-syn.mjs` is fully static — no overrides, no derived values.

## Related

- `../../plans/soundpack-2026-07.md` — the replacement direction: environmental
  sound packs built as reusable graphs, auditioned offline via
  `OfflineAudioContext` before anything is wired up. This is where a future
  "retro" profile selector would live, and where this archive gets used.
- `../../plans/fleet-audio-retune-2026-07.md` — the original re-tune spec that
  produced these cues.

## If you are about to change something in here

Don't, unless you are correcting a transcription error against the SHAs above.
This is a frozen record of what seven games sounded like at a specific moment.
New sound design belongs in a new profile directory, not on top of this one.
