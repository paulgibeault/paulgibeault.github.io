// si-syn — chiptune sound profile (frozen archive).
//
// PROVENANCE
//   Source repo:   paulgibeault/si-syn
//   Source file:   src/audio.js
//   Branch:        audio-retune @ 425b810119d7687ba947a80665103c20c7a8e7bf
//   Draft PR:      paulgibeault/si-syn#22
//   Archived:      2026-07-24
//
// Nothing loads this file. It is data, preserved verbatim, awaiting a
// selectable sound-profile system. See ./README.md.
//
// ── SOUND IDENTITY (from the source header, verbatim) ───────────────────────
// Sound identity: a bench of circuit test gear, not a cabinet. The game is about
// routing a signal until it matches a target waveform, so the palette is built
// out of three materials and each one *means* something:
//
//   • square wave  = a valid logic level. Clean, dry, no vibrato, no sweep.
//                    Only the success cues get it.
//   • sawtooth     = a malformed signal. Only `test-fail` gets it, and it sags
//                    downward (220 → 150 Hz) like a rail browning out.
//   • noise        = the physical/analog layer, in two distinct grains:
//                    a ~12 ms TICK is a relay contact closing (`ui-click`);
//                    a ~50 ms BURST is interference on the line (`test-fail`).
//
// The payoff is that pass and fail are not just "up notes vs. down notes" — a
// pass is *noiseless* and a fail is literally static stepping on the signal, so
// the two read apart instantly even at low volume. Envelopes are deliberately
// near-instant-attack and short so everything sounds switched rather than
// played. All cues stay ≤0.25 s per voice and gain ≤0.35.
//
// si-syn has no in-game sound setting — the launcher's mute is the only toggle.

export const CUES = {
  // Board interactions (place / wire / navigate) — a relay contact closing: a
  // sliver of noise for the mechanical snap, with the square tone struck at the
  // same instant (both delay 0) so it lands as one percussive event rather than
  // a tick-then-beep. This fires constantly, so it stays the quietest cue in the
  // file by a wide margin even with the two voices summed.
  'ui-click': [
    { type: 'noise', dur: 0.012, gain: 0.06, attack: 0.001, release: 0.01, delay: 0 },
    { type: 'square', freq: 320, dur: 0.03, gain: 0.1, attack: 0.001, release: 0.025, delay: 0 },
  ],

  // Test run passed (replay of an already-solved level) — two clean square
  // steps, a rising fifth. Kept strictly noiseless: an uncorrupted signal is the
  // whole point of the cue, and it's what makes it the opposite of `test-fail`.
  'test-pass': [
    { type: 'square', freq: 660, dur: 0.07, gain: 0.24, attack: 0.002, release: 0.05 },
    { type: 'square', freq: 990, dur: 0.09, gain: 0.24, attack: 0.002, release: 0.07 },
  ],

  // Test run failed (signal mismatch) — static breaking in over the line, then
  // the signal sagging out from under it. The sawtooth starts 10 ms after the
  // noise burst begins, so the burst blankets its attack and the two are heard
  // as one event: interference first, collapse second.
  'test-fail': [
    { type: 'noise', dur: 0.05, gain: 0.11, attack: 0.001, release: 0.04 },
    {
      type: 'sawtooth', freq: 220, toFreq: 150, dur: 0.18, gain: 0.22,
      attack: 0.002, release: 0.16, delay: 0.01,
    },
  ],

  // Level completed for the first time — the circuit sequencing up: three quick
  // square steps, then the final note held with a fifth stacked on top of it
  // (delay 0 against the previous voice, so they sound together) for a rail-
  // energized ring instead of a flat arcade arpeggio stopping dead.
  'level-complete': [
    { type: 'square', freq: 523, dur: 0.08, gain: 0.22, attack: 0.002, release: 0.06 },
    { type: 'square', freq: 659, dur: 0.08, gain: 0.22, attack: 0.002, release: 0.06 },
    { type: 'square', freq: 784, dur: 0.08, gain: 0.22, attack: 0.002, release: 0.06 },
    { type: 'square', freq: 1047, dur: 0.16, gain: 0.24, attack: 0.002, release: 0.13 },
    { type: 'square', freq: 1568, dur: 0.16, gain: 0.12, attack: 0.004, release: 0.13, delay: 0 },
  ],
};

// ── NOT-STATIC-DATA ────────────────────────────────────────────────────────
// None. si-syn passes no per-play overrides and derives no cue parameters at
// runtime — every cue above is fully reproducible from this table alone.
