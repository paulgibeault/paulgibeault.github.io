// sow-duku — chiptune sound profile (frozen archive).
//
// PROVENANCE
//   Source repo:   paulgibeault/sowduku      (local checkout: ~/work/sow-duku)
//   Source file:   index.html (inline script, "---- sound ----" section)
//   Branch:        audio-retune @ 34c9cdd14ed64d28dffc57b3d89de78ebf659c5c
//   Draft PR:      paulgibeault/sowduku#11
//   Archived:      2026-07-24
//
// Nothing loads this file. It is data, preserved verbatim, awaiting a
// selectable sound-profile system. See ./README.md.
//
// ── SOUND IDENTITY (from the source header, verbatim) ───────────────────────
// sound: a few quiet, synthesized cues — off by default. Played through the
// SDK's managed WebAudio layer (Arcade.audio): the launcher owns the
// AudioContext, first-gesture unlock, master volume + global mute, and
// suspend/resume, so none of that plumbing is hand-rolled here.
//
// The palette is deliberately *material*, not musical: this is a field of
// mud, straw and small warm animals, so almost every cue leads with a soft
// noise transient (the surface) and lets a low, dull pitched body ring under
// it (the creature). Nothing here is allowed to sound struck, metallic or
// bright — attacks stay slow enough that no cue clicks, and the pitched
// voices sit low and use sine bodies rather than anything with edge.
//
// In an array cue each voice starts `delay` seconds after the *previous
// voice's start*, so a small delay layers voices into one event and a larger
// one strings them into a phrase. Nothing here takes a per-play override,
// which is why every cue is free to be an array.

export const CUES = {
  // a piggy flopping into mud: a short, dull noise splat for the wet surface,
  // with a low sine body dropping 150→65 Hz a hair behind it for the weight
  // of the animal. The noise leads by 10 ms so you hear contact *then* mass —
  // reversed, or without the noise at all, it reads as a synth kick drum.
  'thud': [
    { type: 'noise', dur: 0.09, gain: 0.14, attack: 0.004, release: 0.07 },
    { type: 'sine', freq: 150, toFreq: 65, dur: 0.2, gain: 0.24, attack: 0.008, release: 0.19, delay: 0.01 },
  ],

  // a pen has found its one piggy: three sines rolled in over 30 ms so they
  // bloom rather than strike. Sine + slow attack keeps it a warm swell, not a
  // bell — the only bright thing in the palette, and it stays soft.
  'chime': [
    { type: 'sine', freq: 660,  dur: 0.55, gain: 0.1, attack: 0.02, release: 0.53 },
    { type: 'sine', freq: 880,  dur: 0.55, gain: 0.1, attack: 0.02, release: 0.53, delay: 0.03 },
    { type: 'sine', freq: 1100, dur: 0.55, gain: 0.1, attack: 0.02, release: 0.53, delay: 0.03 },
  ],

  // the whole field settled: three breathy noise puffs. Deliberately uneven —
  // each puff differs in length, level and spacing — because three identical
  // puffs on a fixed pulse read as a machine, and this is meant to read as a
  // creature exhaling. Pure noise, no pitch: it's breath, not a note.
  'snuffle': [
    { type: 'noise', dur: 0.13, gain: 0.17, attack: 0.03, release: 0.10 },
    { type: 'noise', dur: 0.16, gain: 0.19, attack: 0.035, release: 0.13, delay: 0.16 },
    { type: 'noise', dur: 0.12, gain: 0.14, attack: 0.04, release: 0.09, delay: 0.19 },
  ],

  // a slip (illegal or wrong placement): two triangle notes stepping down a
  // minor third. Low, quiet and quickly over — a disappointed grunt, never a
  // buzzer. Triangle gives it just enough edge to be noticed at low level.
  'slip': [
    { type: 'triangle', freq: 220, dur: 0.18, gain: 0.15, attack: 0.012, release: 0.17 },
    { type: 'triangle', freq: 175, dur: 0.18, gain: 0.15, attack: 0.012, release: 0.17, delay: 0.09 },
  ],

  // hearts spent: a tired sigh, not a game-over fanfare. Three low sines with
  // long swelling attacks (no note is ever struck), each sagging a little in
  // pitch as it sounds, stepping down in small tired intervals rather than
  // arpeggiating a triad — then a very quiet noise breath under the last note
  // to land it as an exhale from the same animal as the snuffle.
  'fail': [
    { type: 'sine', freq: 262, toFreq: 247, dur: 0.5, gain: 0.12, attack: 0.09, release: 0.4 },
    { type: 'sine', freq: 233, toFreq: 220, dur: 0.5, gain: 0.11, attack: 0.09, release: 0.4, delay: 0.22 },
    { type: 'sine', freq: 196, toFreq: 175, dur: 0.7, gain: 0.1, attack: 0.12, release: 0.55, delay: 0.24 },
    { type: 'noise', dur: 0.22, gain: 0.07, attack: 0.09, release: 0.13, delay: 0.18 },
  ],
};

// ── NOT-STATIC-DATA ────────────────────────────────────────────────────────
// No runtime-derived cue parameters: no call site passes a per-play override,
// which is why every cue above is free to be an array.
//
// One behavioural fact that is not a cue value: sow-duku is the only game in
// the fleet whose sound is OFF BY DEFAULT. It keeps its own persisted in-game
// setting ("sound", modes ["off","on"], defaulting to "off") and gates every
// play on it in addition to the launcher-owned volume + global mute.
export const IN_GAME_SOUND_SETTING = {
  key: 'sound',
  modes: ['off', 'on'],
  default: 'off',
};
