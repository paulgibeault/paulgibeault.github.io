// pi-game — chiptune sound profile (frozen archive).
//
// PROVENANCE
//   Source repo:   paulgibeault/pi-game
//   Source file:   index.html (inline <script type="module">, "===== Audio =====")
//   Branch:        audio-retune @ 420d028b696d650c170bd54de53d13f0e1d581bb
//   Draft PR:      paulgibeault/pi-game#21
//   Archived:      2026-07-24
//
// Nothing loads this file. It is data, preserved verbatim, awaiting a
// selectable sound-profile system. See ./README.md.
//
// ── SOUND IDENTITY (from the source header, verbatim) ───────────────────────
// Sound identity: a recital under pressure. 'correct' is a metronome tick that
// keeps time *under* the player's concentration, never a reward chime; 'wrong'
// is an alarm strike that ends the run. Everything else is a sibling of one of
// those two. The game asks for hundreds of keystrokes in a row, so the tick's
// first duty is to stay out of the way — unobtrusive beats interesting.
//
// This game keeps its own in-game mute toggle (state.soundEnabled) as an extra
// gate on top of the launcher-owned volume + global mute.

export const CUES = {
  // Correct digit — the metronome tick. Triangle (a touch more edge than a
  // sine, so it reads as a click rather than a beep), near-instant attack and
  // a 70 ms fall to silence: percussive, and short enough that fast typing
  // never smears one tick into the next. Stays a SINGLE-object spec because
  // playCorrect() overrides `freq` per play for the rising digit-index ladder
  // (Math.min(440 + idx*8, 1200)) and the SDK only merges overrides onto
  // single-object cues — an array would silently drop the ladder. For the
  // same reason there is no `toFreq` bend: a fixed target would mean a
  // different-sized bend at every rung of the ladder.
  'correct': { type: 'triangle', freq: 440, dur: 0.07, gain: 0.14, attack: 0.001, release: 0.065 },

  // Hot-streak accent layered over 'correct' (comboLevel > 3): a clean sine
  // ping a fifth above the tick, decaying the whole way out. Also single-
  // object — playCorrect() overrides both `freq` and `gain` per play, so it
  // scales with the streak. It is an accent on the tick, not a second cue:
  // it must stay quieter than the tick it rides on at every streak level.
  'combo': { type: 'sine', freq: 660, dur: 0.09, gain: 0.05, attack: 0.001, release: 0.085 },

  // Wrong digit / game over — the alarm strike. A noise transient and a
  // pitch-dropping triangle land together as the hit; 20 ms later the detuned
  // sawtooth cluster sags in and holds, all three voices bending downward so
  // the run audibly dies instead of resolving into an organ chord. The only
  // long cue in the game, and it fires exactly once per run.
  'wrong': [
    { type: 'noise', dur: 0.045, gain: 0.10, attack: 0.001, release: 0.044, delay: 0 },
    { type: 'triangle', freq: 200, toFreq: 55, dur: 0.18, gain: 0.16, attack: 0.001, release: 0.16, delay: 0 },
    { type: 'sawtooth', freq: 150, toFreq: 138, dur: 0.5, gain: 0.08, attack: 0.006, release: 0.34, delay: 0.02 },
    { type: 'sawtooth', freq: 157, toFreq: 144, dur: 0.5, gain: 0.08, attack: 0.006, release: 0.34, delay: 0 },
    { type: 'sawtooth', freq: 185, toFreq: 170, dur: 0.5, gain: 0.07, attack: 0.006, release: 0.34, delay: 0 },
  ],

  // Practice mode — the same two sounds with the stakes taken out: a quieter,
  // shorter tick, and a strike reduced to its impact with no alarm tail,
  // because nothing ends here. Both play without overrides, so 'practice-
  // wrong' is free to be an array.
  'practice-correct': { type: 'triangle', freq: 600, dur: 0.055, gain: 0.075, attack: 0.001, release: 0.05 },
  'practice-wrong': [
    { type: 'noise', dur: 0.03, gain: 0.06, attack: 0.001, release: 0.029, delay: 0 },
    { type: 'triangle', freq: 180, toFreq: 90, dur: 0.14, gain: 0.10, attack: 0.001, release: 0.12, delay: 0 },
  ],
};

// ── NOT-STATIC-DATA: behaviour the cue table alone cannot reproduce ─────────

// The tick, pitched by how deep into Pi you are, plus the streak accent above
// it. Both ride per-play overrides (see the single-object cues above). The
// accent's gain grows with the streak but tops out below the tick's own 0.14,
// so a hot streak colours the metronome rather than shouting over it.
//
// Original source (verbatim):
//   function playCorrect(digitIndex) {
//     const freq = Math.min(440 + digitIndex * 8, 1200);
//     sfx('correct', { freq });
//     if (comboLevel > 3) sfx('combo', { freq: freq * 1.5, gain: 0.012 * Math.min(comboLevel, 10) });
//   }

// Rising digit-index ladder for the 'correct' tick: +8 Hz per digit off 440,
// hard-capped at 1200 Hz.
export function correctFreq(digitIndex) {
  return Math.min(440 + digitIndex * 8, 1200);
}

// Streak accent, layered over 'correct' only when comboLevel > 3.
// Pitched a perfect fifth above whatever the tick is currently at, and gained
// at 0.012 per streak level, saturating at level 10 (=> max 0.12, below the
// tick's own 0.14 so the accent never overtakes it).
//
// NOTE the 0.012 coefficient: the pre-retune value here was 0.05, which at
// comboLevel 10 produced gain 0.5 — a shrieking accent far louder than the
// tick it rides on. That 0.05 -> 0.012 change is an ordinary bug fix and is
// independent of the chiptune-vs-richer-engine question.
export const COMBO_GAIN_COEFF = 0.012;
export const COMBO_LEVEL_THRESHOLD = 3; // accent fires when comboLevel > 3
export const COMBO_LEVEL_CAP = 10;

export function comboOverrides(correctHz, comboLevel) {
  return {
    freq: correctHz * 1.5,
    gain: COMBO_GAIN_COEFF * Math.min(comboLevel, COMBO_LEVEL_CAP),
  };
}
