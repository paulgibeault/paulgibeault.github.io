# Sound packs

A workbench for designing app audio as real WebAudio graphs, rendering it
offline to a single audition file, and judging it by ear **before** any of it is
wired into a running app.

Everything here is app-agnostic. The pack, the audition timeline and the config
that names them all live in the app that owns them; this directory owns the
engine, the archetypes and the measurement. Nothing in the launcher knows which
apps have sound.

```sh
npm install && npx playwright install chromium     # once

# from the launcher repo, pointed at an app's config
node tools/soundpack/render.mjs  --config ../my-app/soundpack.config.json
node tools/soundpack/analyze.mjs ../my-app/audio/out/my-app-full.manifest.json
```

Both tools require explicit inputs and print usage if invoked bare — there is no
default app to fall back to.

## Why this exists

The SDK's spec cues (`Arcade.audio.cue()`) are one oscillator or noise burst
into a linear gain envelope. Nothing else — no filter, no reverb, no modulation,
no per-play variation. That is a chiptune synthesizer in the literal historical
sense, and two rounds of careful cue-value re-tuning confirmed you cannot escape
it by choosing better numbers. See `plans/soundpack-2026-07.md`.

Graph cues (`Arcade.audio.graph()`) are the replacement: cues built from
*physical gestures* rather than waveforms, all sharing one acoustic space.

## The trick that makes this work

`playwright` is already a devDependency, so we have headless Chromium, so we
have a full `OfflineAudioContext` — biquad filters, convolution, delay,
compression, the lot. That means:

> **The renderer and the runtime are the same code.** A cue is a function
> `(ctx, out, when, params, rnd)`. Offline, `ctx` is an `OfflineAudioContext`
> and the result becomes a WAV. Live, `ctx` is the SDK's managed `AudioContext`.
> The renderer injects the shipped `/arcade-audio.js` itself, so approving an
> audition approves the code that plays.

Renders run much faster than real time and are fully seeded — the same pack
renders the same sound every time, though not literally the same bytes (a few
hundred samples in millions land on the other side of a 16-bit rounding
boundary between runs, max 1 LSB, about −90 dBFS, because the convolver and
compressor accumulate in floating point). Compare renders with `wavdiff.mjs`,
which knows what that noise floor looks like, never with `cmp` or `shasum`.

## Layout

| Path | Owner | What |
| --- | --- | --- |
| `../../arcade-audio.js` | framework | Synthesis elements + `registerPack`. The shipped file, injected verbatim. |
| `lib/audition.js` | framework | Audition archetypes — the reusable half of a timeline. |
| `render.mjs` | framework | Drives headless Chromium; writes the WAV, the index and a manifest. |
| `analyze.mjs` | framework | Measures a finished render item by item and flags problems. |
| `wavdiff.mjs` | framework | Did a change to a shared element alter this pack? Exits non-zero if so. |
| `../fixtures/soundpack-test/` | framework | A synthetic pack + audition + config, so all of the above is testable on a bare checkout. |
| `<app>/js/soundpack.js` | app | The pack: its room, its sends, its cues. |
| `<app>/audio/audition*.js` | app | The timeline(s). Test material — never shipped to players. |
| `<app>/soundpack.config.json` | app | Names the above and where renders land. |

## The app's side

```json
{
  "name": "my-app",
  "pack": "js/soundpack.js",
  "auditions": { "full": "audio/audition.js", "short": "audio/audition-short.js" },
  "out": "audio/out",
  "sampleRate": 48000
}
```

Every path resolves relative to the config file. Add `audio/out/` to the app's
`.gitignore` — renders are regenerable and large.

The pack file ends by publishing itself under the framework's well-known handle:

```js
S.registerPack({ name: 'my-app', ROOM, SENDS, CUES });   // → window.ArcadeSoundPack
```

That one line is what lets every tool here be app-agnostic, and it is the same
object the app's own audio module registers with `Arcade.audio.graph()`, so the
audition and the running app cannot drift apart.

## Writing an audition

An audition declares only what is genuinely its own. The recurring structures —
"every cue dry then in the room", "this cue eight times at play density", "these
two must not blur" — come from `lib/audition.js`:

```js
const A = global.ArcadeAudition;
A.publish({
  gap: 0.55, tail: 1.6,
  sections: [
    A.contrastPairs('A · Grammar', 'These arrive seconds apart in play.',
                    [['yes', 'no'], ['win', 'lose']]),
    A.everyCueDryWet(),                       // generated from the pack
    A.section('C · Density', '', [
      A.repeat('tick', { n: 8, spacing: 0.45 }),
      A.together(['thud', 'yes'], { label: 'a placement — both layers' }),
      A.scene('the finish — last move into the win', 5.0,
              [{ cue: 'place', at: 1.2 }, { cue: 'win', at: 1.2 }]),
      A.custom('anything else', 2.0, (ctx, bus, t, r) => A.fire(ctx, bus, 'tick', t, r)),
    ]),
  ],
});
```

`everyCueDryWet()` is derived from the pack, so a cue added later cannot be
forgotten. `publish()` validates every referenced cue name against the pack — a
typo fails loudly instead of rendering as silence and reading as a design
problem. `tools/fixtures/soundpack-test/audition.js` is a complete worked
example using every builder.

## Elements → cues → scenes

**Elements** are physical gestures, each modelling how a real object makes sound:
`strike` (contact click), `rustle` (noise through a sweeping bandpass), `pluck`
(Karplus–Strong), `creak` (stick-slip), `droplet` (rising cavity resonance),
`body` (inharmonic partials, each detuned so the stack beats), `thump`, `flare`,
`blast`, `chirp`, `stream`, `shatter`, `ratchet`, `drone`, `squelch`, `breath`,
`grunt`, `flex`.

**Cues** layer and time-offset elements, varying pitch, timing and layer balance
per play from a seeded stream. Nothing repeats identically; that is most of the
difference between "a sound" and "a sound effect".

**Scenes** fire cues at real density so overlap can be judged — the thing that
actually breaks when sounds don't share a space.

## Three things that do most of the work

1. **One shared room.** Every cue sends to a single convolution reverb whose
   impulse response is generated procedurally — sparse early reflections, then a
   tail that both decays *and* darkens, because real rooms absorb high
   frequencies first. Sounds that share a space fuse when overlaid; sounds
   pasted onto silence collide. Each cue declares how wet it is, which is really
   a statement about how far away it is.
2. **A register plan.** Cues are deliberately spread across the spectrum so
   simultaneous ones don't mask each other. `analyze.mjs` reports the spread and
   warns if it collapses.
3. **Exponential envelopes.** Natural decay is exponential; the linear ramps the
   spec-cue engine used are themselves one of the tells the ear reads as
   synthetic.

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
- **`analyze.mjs` is not ears.** It catches inaudible, clipping, all-hiss,
  no-room and register-collapse. It cannot tell you whether something sounds
  *good*. Render, listen, quote a timestamp from the INDEX, fix, repeat.
