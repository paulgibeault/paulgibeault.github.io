# Sound packs — environmental audio, offline-auditioned (2026-07)

Status: **PLAN — awaiting review.** Not implemented. Supersedes the approach in
`plans/fleet-audio-retune-2026-07.md` (whose seven draft PRs should be **held,
not merged** — see §7).

## 0. The verdict that triggered this

Ear pass on the re-tuned fleet: *"the sounds are too simple and chip-tune like.
Can we make more complex and environmental events that blend well overlaid."*

That is the correct diagnosis, and it invalidates my previous one.

## 1. What I got wrong, and what the real ceiling is

`plans/fleet-audio-retune-2026-07.md` blamed the **A5 convention**
(sine/triangle = gentle, square/saw = arcade) for the fleet sounding generic.
That was a symptom. The actual cause is the engine.

Here is the SDK's entire audio signal path (`arcade-sdk.js` ~L2860–2940):

```
OscillatorNode | BufferSource(white noise)  →  GainNode (linear attack/release)  →  masterGain  →  destination
```

There is no filter, no reverb, no delay, no modulation, no waveshaping, no
compression, no panning, no per-play variation. Those are not missing features
— that graph **is** a chiptune synthesizer, in the literal historical sense: raw
oscillators with amplitude envelopes is what an NES APU did. No amount of
re-tuning `freq` and `gain` values escapes it, which is exactly why two rounds
of careful re-tuning produced sounds that were better but still unmistakably
chip.

Four specific consequences, each mapping to part of the complaint:

1. **Raw waveforms → "simple."** A real sound's *spectrum changes over its
   duration*. A bare oscillator's doesn't. Without a filter whose cutoff moves,
   every sound is spectrally frozen — the ear reads that instantly as synthetic.
2. **No shared space → "doesn't blend when overlaid."** Every cue is pasted onto
   digital silence. Real sounds that occur in the same place share a room: the
   same early reflections, the same decay tail. That shared reverb is *the*
   mechanism by which overlapping sounds fuse into one scene instead of stacking
   into a pile. We have none, so overlaps can only ever sound like collisions.
3. **Byte-identical repetition → fatigue.** Every play of `match` is the exact
   same samples. Real game audio randomizes pitch, timing, and layer balance per
   play. Mechanical exactness is a hallmark of chip music.
4. **No layering depth → "not environmental."** Environmental sounds are
   transient + body + tail, each with its own spectrum and decay rate. The engine
   gives one envelope shape per voice, so all layers decay in lockstep.

**Conclusion: this cannot be fixed at the cue-values layer, in any game.** It
needs a real synthesis graph. The rest of this plan is how to get one, and how
to hear it before committing to it.

## 2. Tooling: verified, and better than expected

The audition requirement ("a single audio file I can play and evaluate before we
wire them into the game") is fully solvable with what's already in this repo.

`playwright` is already a devDependency, which means headless Chromium, which
means a complete WebAudio implementation with `OfflineAudioContext`. **Probed and
confirmed working** on this machine — `createBiquadFilter`, `createConvolver`,
`createDelay`, `createWaveShaper`, `createDynamicsCompressor`,
`createStereoPanner`, `createIIRFilter`, `createPeriodicWave`, `decodeAudioData`
all present; a noise→bandpass render came back correct at 48 kHz stereo.

That gives us something genuinely valuable:

> **The audition renderer and the runtime are the same code.** Sound-pack graphs
> are plain functions `(ctx, when, params) → nodes`. Offline, `ctx` is an
> `OfflineAudioContext` in headless Chromium and we write the result to a WAV.
> Live, `ctx` is the SDK's managed `AudioContext`. What you approve is
> bit-identical to what ships — no "sounded good in the mockup" gap.

It also renders faster than real time, deterministically, with no new
dependencies and no audio hardware involved.

## 3. Architecture: elements → cues → scenes

This is the "chaining in series and combinations" structure.

**Elements** — the atoms. Small parameterized graphs, each a physical gesture,
reusable across cues and games:

| Element | Synthesis technique |
| --- | --- |
| `rustle` | white noise → bandpass with **sweeping cutoff** + Q, slow amplitude swell |
| `strike` | 2–5 ms noise burst → highpass, near-instant decay (the contact click) |
| `pluck` | **Karplus–Strong**: noise burst → delay line with lowpassed feedback (a genuinely plucked string, for almost nothing) |
| `creak` | noise → resonant bandpass, amplitude driven by an irregular **stick-slip** random-walk envelope |
| `droplet` | fast **upward** pitch sweep on a resonant-lowpassed sine (the real physics of a plink), preceded by a splash transient |
| `body` | inharmonic partial stack, **each partial with its own decay rate** and slight detune (produces beating/warble) |
| `thump` | lowpassed pitch-dropping sine + noise, for taiko/impact weight |

**Cues** — molecules. A cue layers and time-offsets elements, and declares
**per-play variation ranges** (pitch ±%, timing jitter, layer-gain jitter,
filter-cutoff jitter) so no two plays are identical.

**Scenes** — timelines of cues firing as they actually would in gameplay,
overlapping. Scenes are how we evaluate blend, which is the thing that's
currently broken.

## 4. Moon-lit sound profile

**The place:** a stone temple courtyard at night, open onto a river. Paper, rope,
wood, water, bronze, silk strings. Everything is heard in that one space.

Three global decisions that do most of the work:

- **One shared room.** A single convolution reverb — impulse response generated
  procedurally (noise burst × exponential decay × spectral tilt, ~1.8 s, dark) —
  fed by a send from every cue. This is the single biggest lever for "blends well
  overlaid," and it costs one `ConvolverNode`.
- **A register plan**, so simultaneous cues occupy different bands instead of
  masking each other: taiko 40–120 Hz · bell 60–1200 · wood/rope 100–800 · water
  800–4k · chimes 1–3k · paper 2–6k. A gentle high-shelf cut above ~6 kHz across
  the whole bus keeps it warm.
- **Nothing static.** Every element has at least one moving parameter over its
  lifetime — cutoff, pitch, or amplitude. This is the direct antidote to
  "simple."

Per cue:

| Cue | Construction |
| --- | --- |
| `lantern-launch` | `rustle` with bandpass sweeping 900→2400 Hz as the lantern lifts, quiet low air layer beneath, long reverb send. Paper leaving the hand. |
| `match` | Struck **fūrin** glass chime: `strike` + `body` (5–6 inharmonic partials, upper partials decaying fastest — the physics). Chain size shifts the fundamental; per-play detune and strike-position variation rebalance the partials so repeats differ. |
| `drop` | `droplet` into the river, plus a second quieter droplet at a randomized offset. Wet tail — highest reverb send in the pack. |
| `trellis` | `creak` — rope and wood under load, irregular stick-slip — terminated by a wooden knock. |
| `dead-line-warning` | Same creak, tighter and higher, plus **two detuned low tones beating at ~3 Hz** for dread, plus a distant `thump`. |
| `menu-click` | **Hyoshigi** wood clapper: 2 ms `strike` → resonant bandpass ~1.2 kHz, Q≈8, 25 ms decay. Tiny reverb send. |
| `win` | **Bonshō temple bell.** Inharmonic partial stack (hum · prime · tierce · quint · nominal · clang) with **independent decay per partial** (hum longest), each partial a detuned pair producing slow warble, bright `strike` transient, tierce blooming slightly *after* the strike, very long tail into the room. Impossible in the current engine at any parameter setting. |
| `game-over` | **Koto.** `pluck` (Karplus–Strong) × 3 descending, with delay-time modulation for the downward bend and overlapping tails. |
| *ambient bed* | River = noise → two slowly-modulated bandpasses + slow amplitude drift. Irregular taiko = sparse randomized `thump`s at 20–60 s intervals. Very low level, ducking slightly under large cues. **This finally delivers `docs/design-concept.md` §8's ambient bed**, which every prior plan marked out-of-scope. |

## 5. The audition file

One WAV (48 kHz stereo, ~4 min) plus a markdown index with timestamps, so
feedback can be precise ("2:14 is too bright") rather than global.

| § | Content | What it tests |
| --- | --- | --- |
| A | Elements solo | Fix a bad ingredient without re-judging whole cues |
| B | Each cue solo — dry, then in-room | Cue identity; what the room contributes |
| C | One cue played 8× | **Fatigue / variation** — the chiptune tell |
| D | `match` across the chain ladder 3/4/5/6 | Parameterization |
| E | Realistic overlapping gameplay: launch → match → 4-drop cascade → trellis creak | **Blend** — the actual complaint |
| F | Landmarks in full: win bell, game-over | The emotional peaks |
| G | Ambient bed alone, then bed + gameplay | Does the bed sit under without crowding |

Deliverable: `tools/soundpack/out/moon-lit-v1.wav` + `INDEX.md`. Generator
committed; the WAV is a build artifact (gitignored) — regenerate with one
command.

## 6. Delivery: the one decision this plan needs

The workbench above is **identical for both paths**, so building it and getting
moon-lit v1 auditioned requires no decision. The fork only matters afterward:

**Path A — render to sample files and ship them.** Unlimited richness (could even
use field recordings). Costs: audio assets per game, service-worker precache and
offline-size implications, a new `Arcade.audio.load()` surface, and it breaks the
platform's "static files, no build step, zero dependencies" ethos.

**Path B — extend the SDK to run these graphs live.** Because the workbench is
real WebAudio, **the graph builders simply become the runtime**. Zero assets,
nothing to precache, stays fully static, and the audition is bit-identical to
what ships. Costs: a real SDK feature — element/graph voice model, a shared
reverb bus, per-play variation, and a sustained/looping voice concept for the
ambient bed. That is an `Arcade.audio` v2 and a genuine SDK minor bump, not a
per-game tweak.

**Recommendation: Path B**, holding A in reserve only for sounds synthesis truly
can't reach.

One related gap worth fixing under B: `Arcade.audio.context()` already exposes the
managed `AudioContext` "for games that need custom node graphs," but `masterGain`
is private, so anything a game builds on that context connects to
`ctx.destination` and **silently bypasses the launcher's volume and mute
contract**. Path B should expose a bus node instead of leaving that trap in place.

## 7. What to do with the seven open draft PRs

**Hold them — don't merge, don't close.** They are a real improvement *within the
old engine's limits*, and they contain findings worth keeping (the unfiltered-noise
gain correction, the missing limiter, the pi-game combo-gain bug). But merging
them ships audio we've already agreed is the wrong ceiling, only to replace it.
They stay open as drafts and get superseded per-game as each sound pack lands.

The pi-game combo-gain fix is an unrelated genuine bug and can be cherry-picked
out separately if we want it sooner.

## 8. Phasing — deliberately not a fan-out

1. **Build the workbench + moon-lit pack v1; render the audition WAV.** No
   decision needed to start.
2. **Iterate on the WAV against ears.** Expect 2–3 rounds. This is the whole
   point; budget for it rather than treating round 1 as the deliverable.
3. Once moon-lit is signed off, commit to Path A or B and build the runtime.
4. Wire moon-lit, acceptance-test, ear-check, merge.
5. **Then the other six packs, one at a time**, each with its own audition file,
   reusing the element library moon-lit establishes.

The previous two rounds both fanned out to seven concurrent agents, and both
produced results that were internally consistent and generically similar. That is
what parallelism optimizes for. Sound design converges by iterating against ears,
not by running wider — so this one goes deep on a single game first, and the
element library it produces is what makes games 2–7 fast.

## Out of scope

- Music/soundtrack. Cues and an ambient bed only.
- Voice.
- Changing any game's cue *events* or call sites — this is about what the existing
  events sound like.
- The other six games, until moon-lit is signed off (§8).

---

## Archive disposition (2026-07-28)

The `soundpacks/chiptune/` directory — seven modules preserving each app's
pre-overhaul cue tables, transcribed verbatim from the rejected `audio-retune`
branches — has been **moved out of this repo**. Each module now lives in the app
that owns it, as `audio/chiptune-archive.mjs`, provenance header intact.

Why it moved: the launcher is a framework, and per-app design data sitting in it
is a dependency pointing the wrong way (see
[decouple-game-names-2026-07.md](decouple-game-names-2026-07.md)). Nothing
loaded these files, so the move carries no runtime risk.

What the archive is *for*, restated so it does not get lost with the directory:
the cue values are a finished, coherent expression of what the old
single-oscillator engine could do, and the design-intent comments record **why
each sound is shaped the way it is**. That intent is the input to each app's
graph pack — it survives the change of synthesis method, and it is the reason
the files were kept rather than deleted. Three apps (`pi-game`, `si-syn`,
`p2p-chat`) had not yet been given graph packs when the archive moved; theirs is
the design record to work from.

The "selectable retro profile" this archive was saved for, if it ever happens,
is a graph pack that *sounds* like chiptune — square-wave elements through the
shared room — not a reason to keep the spec-cue engine alive.
