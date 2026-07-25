# Sound packs

A workbench for designing game audio as real WebAudio graphs, rendering it
offline to a single audition file, and judging it by ear **before** any of it is
wired into a game.

```sh
npm install && npx playwright install chromium   # once
node tools/soundpack/render.mjs moon-lit          # → out/moon-lit-v1.wav + INDEX.md
node tools/soundpack/analyze.mjs moon-lit         # measure what was rendered
```

## Why this exists

The launcher SDK's `Arcade.audio` is an oscillator (or white noise) into a gain
envelope into the master bus. Nothing else — no filter, no reverb, no
modulation, no per-play variation. That is a chiptune synthesizer in the literal
historical sense, and two rounds of careful cue-value re-tuning across the fleet
confirmed you cannot escape it by choosing better numbers. See
`plans/soundpack-2026-07.md`.

Sound packs are the replacement: cues built from *physical gestures* rather than
waveforms, all sharing one acoustic space.

## The trick that makes this work

`playwright` is already a devDependency, so we have headless Chromium, so we have
a full `OfflineAudioContext` — biquad filters, convolution, delay, compression,
the lot. That means:

> **The renderer and the runtime are the same code.** A sound is a function
> `(ctx, dest, t, params)`. Offline, `ctx` is an `OfflineAudioContext` and the
> result becomes a WAV. Live, `ctx` is the SDK's managed `AudioContext`. What you
> approve in the audition is bit-identical to what would ship.

Renders are deterministic (every random stream is seeded) and run much faster
than real time.

## Layout

| Path | What |
| --- | --- |
| `lib/graph.js` | Synthesis elements. Plain script, no imports, so the renderer can inject it verbatim and a browser can later load it with a `<script>` tag. |
| `packs/<name>.js` | One pack: its room, its cues, and the audition timeline. |
| `render.mjs` | Drives headless Chromium, renders each section, writes the WAV, the index, and a manifest. |
| `analyze.mjs` | Measures the render item by item and flags problems. |
| `out/` | Build artifacts — gitignored. Regenerate rather than commit. |

## Elements → cues → scenes

**Elements** are physical gestures, and each models how a real object actually
makes sound:

| Element | Technique |
| --- | --- |
| `strike` | brief high-passed noise — the contact click every physical event begins with |
| `rustle` | noise through a bandpass whose cutoff *sweeps*; a static filter still sounds synthetic |
| `pluck` | Karplus–Strong — a noise burst circulating in a delay line one period long |
| `creak` | stick-slip: an irregular grip-and-release amplitude envelope, which *is* the sound |
| `droplet` | a fast **upward** pitch sweep; the collapsing cavity raises its own resonance |
| `body` | inharmonic partials, each with its own decay rate, each a detuned pair so the stack beats |
| `thump` | low pitch-dropping impact |
| `stream` | sustained filtered noise with a drifting band — water, wind, ambient beds |

**Cues** layer and time-offset elements, and vary pitch, timing and layer balance
per play from a seeded stream. Nothing repeats identically; that is most of the
difference between "a sound" and "a sound effect".

**Scenes** fire cues at real gameplay density so overlap can be judged, which is
the thing that actually breaks when sounds don't share a space.

## Three things that do most of the work

1. **One shared room.** Every cue sends to a single convolution reverb whose
   impulse response is generated procedurally — sparse early reflections, then a
   tail that both decays *and darkens*, because real rooms absorb high
   frequencies first. Sounds that share a space fuse when overlaid; sounds
   pasted onto silence collide. Each cue declares how wet it is, which is really
   a statement about how far away it is.
2. **A register plan.** Cues are deliberately spread across the spectrum so
   simultaneous ones don't mask each other. `analyze.mjs` reports the spread and
   warns if it collapses.
3. **Exponential envelopes.** Natural decay is exponential; the linear ramps the
   old engine used are themselves one of the tells the ear reads as synthetic.

## Gotchas worth knowing

- **A bandpass throws away energy.** It passes only `f/Q` Hz of a noise source's
  full band, so a Q of 7.5 at 250 Hz costs about 29 dB. `bandMakeup()` restores
  it. Without that, "more resonant" silently means "more inaudible" and the
  tuning fights itself.
- **A biquad only rolls off at 6 dB/octave.** Enough high end leaks past a
  bandpass that wood and water read as hiss with a bump in it. Cascade a second
  lowpass stage where a material should be dark.
- **WebAudio feedback loops are clamped to a 128-sample quantum**, which lands
  inside our pitch range — so Karplus–Strong is synthesised into a buffer
  directly rather than built from a node cycle.
- **`analyze.mjs` is not ears.** It catches inaudible, clipping, all-hiss, no-room
  and register-collapse. It cannot tell you whether something sounds *good*.

## Adding a pack

Copy `packs/moon-lit.js`. Define `ROOM` (the acoustic space), `SENDS` (how far
away each cue sits), `CUES`, and `SECTIONS` (the audition timeline). Reuse the
elements in `lib/graph.js`; add new ones there only when a genuinely new physical
gesture is needed, so every pack keeps benefiting.
